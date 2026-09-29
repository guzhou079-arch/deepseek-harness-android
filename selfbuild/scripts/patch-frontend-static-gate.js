// v1.24 变换脚本：静态资源门禁（非 index 资产也要过鉴权）
//
// 为什么要有这个脚本：原来是**整文件覆盖** dsh-host-frontend-static 的 index.js。
// 内核一升级，那份副本会把上游的新代码整片盖回去（静默）。改成定点变换后：
//   · 不携带上游代码 → 升级不会回退上游改动
//   · 锚点唯一性断言 + 真解析校验 + 幂等 → 上游改了锚点会**显式失败**，不会产出半成品
//
// 用法：
//   node patch-frontend-static-gate.js                      # 从装机副本取源，改了就把结果写进 overlay
//   node patch-frontend-static-gate.js --from <原版文件>     # 从指定（原版）文件变换，并与装机副本比对
//
// 语义：上游 "Non-index assets stay public" → 实测 dist 里**任何**文件都能无鉴权读，
//       包括本机补丁引入的用户个人资产 /dsh-bg-user.png。改成每个非 index 请求也过
//       ctx.connection.admit(req)（Host/Origin 围栏 + 签名 cookie）。
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const N = process.env.DSH_KERNEL_DIR || '/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const SB = '/storage/emulated/0/Download/Operit/dsh_own_app/selfbuild'
const OVL = '/storage/emulated/0/Download/Operit/dsh_own_app/v118/dsh-patches/overlay'
const REL = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const REL2 = 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const PKG = 'dsh-host-frontend-static'
const FILE = 'lib/index.js'

const MARKER = 'v1.24 patch（本机改动，非上游）'
const LIVE = `${N}/${PKG}/${FILE}`

// ---- 4 处定点替换（锚点均要求唯一命中）-------------------------------------
const HUNKS = [
  {
    name: '文件头说明',
    from: [
      '* Non-index assets stay public. The dist location is workspace knowledge of',
      '* the composing application, so `distIndex` is typically supplied through a',
      '* `!!js` expression, never hardcoded by a deployment.',
    ].join('\n'),
    to: [
      '*',
      '* ⚠ v1.24 patch（本机改动，非上游）：**非 index 静态资源不再 public**。',
      '* 上游实现是 "Non-index assets stay public"，实测后果是 dist 里**任何**文件都能被无鉴权读取 ——',
      '* 包括本机补丁引入的用户个人资产 `/dsh-bg-user.png`，以及 `/plugins/*` 之类的相邻面。',
      '* 这里改成：非 index 的每个请求也过 `ctx.connection.admit(req)`（Host/Origin 围栏 + 签名 cookie），',
      '* 未通过就按 401/403 拒绝。浏览器在拿到 index（带 ?token= 兑换出 cookie）之后，',
      '* 后续同源静态请求天然带 cookie，所以正常浏览/WebView 不受影响。',
      '*',
      '* 回滚：把本文件换回 `selfbuild/work/frontend-static.pristine.js`（md5 86fe4eac…）并重建。',
    ].join('\n'),
  },
  {
    name: 'JSDoc + serveStatic 签名',
    from: [
      '* rendering) for the dist root and configured index path.',
      '*/',
      'async function serveStatic(pathname, res, distRoot, distIndex, authorizeIndex, renderIndex) {',
    ].join('\n'),
    to: [
      '* rendering) for the dist root and configured index path.',
      '* @param guardAsset - v1.24: admission check for non-index assets; returns',
      '* undefined to allow, or an HTTP status code (401/403) to reject.',
      '*/',
      'async function serveStatic(pathname, res, distRoot, distIndex, authorizeIndex, renderIndex, guardAsset) {',
    ].join('\n'),
  },
  {
    name: '非 index 资产门禁块',
    from: ['\t\t} else {', '\t\t\tbody = await readFile(target);'].join('\n'),
    to: [
      '\t\t} else {',
      '\t\t\t// ⚠ v1.24：非 index 资产也要过门禁（见文件头说明）。',
      '\t\t\tconst rejection = guardAsset === void 0 ? void 0 : guardAsset();',
      '\t\t\tif (rejection !== void 0) {',
      '\t\t\t\tres.writeHead(rejection, rejection === 401 ? {',
      '\t\t\t\t\t"cache-control": "no-store",',
      '\t\t\t\t\t"content-type": "text/plain; charset=utf-8"',
      '\t\t\t\t} : void 0);',
      '\t\t\t\tres.end(rejection === 401 ? "dsh web authentication required; reopen the URL printed by dsh web.\\n" : void 0);',
      '\t\t\t\treturn;',
      '\t\t\t}',
      '\t\t\tbody = await readFile(target);',
    ].join('\n'),
  },
  {
    name: 'caller 传入 guardAsset',
    from: '\t\tawait serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, () => ctx.connection.authorizeIndex(req, res), renderIndex);',
    to: [
      '\t\t// v1.24：admit() = Host/Origin 围栏 + 浏览器签名 cookie 鉴权（与 /api 同一套判定）。',
      '\t\tconst guardAsset = () => {',
      '\t\t\tconst verdict = ctx.connection.admit(req);',
      '\t\t\treturn verdict.rejection === void 0 ? void 0 : verdict.rejection;',
      '\t\t};',
      '\t\tawait serveStatic(decodeURIComponent(rawPath), res, distRoot, distIndex, () => ctx.connection.authorizeIndex(req, res), renderIndex, guardAsset);',
    ].join('\n'),
  },
]

/** 真解析校验：这些文件是 ESM，node --check 会给假通过，必须真 import 一次看有没有 SyntaxError。 */
function syntaxCheck(src) {
  const tmp = path.join(SB, 'work', `${PKG}-gate-check.mjs`)
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, src)
  const r = cp.spawnSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify('file://' + tmp)}).catch(e => { if (e instanceof SyntaxError) { console.error('SYNTAX:' + e.message); process.exit(7) } })`],
    { encoding: 'utf8', timeout: 30000 })
  const out = (r.stdout || '') + (r.stderr || '')
  if (out.includes('SYNTAX:')) return out.split('SYNTAX:')[1].split('\n')[0]
  return null
}

const argv = process.argv.slice(2)
const fi = argv.indexOf('--from')
const srcPath = fi >= 0 ? argv[fi + 1] : LIVE

let s = fs.readFileSync(srcPath, 'utf8')
const liveSrc = fs.existsSync(LIVE) ? fs.readFileSync(LIVE, 'utf8') : null

if (s.includes(MARKER)) {
  console.log('  ✓ 源已是打过补丁的状态（幂等直通）')
} else {
  for (const h of HUNKS) {
    const n = s.split(h.from).length - 1
    if (n !== 1) {
      console.error(`  ✗ [${h.name}] 期望 1 处锚点，实际 ${n} 处 → 中止（上游可能变了，需人工看 diff）`)
      process.exit(1)
    }
    s = s.replace(h.from, h.to)
  }
  const err = syntaxCheck(s)
  if (err) { console.error('  ✗ 语法错误: ' + err); process.exit(1) }
  console.log(`  ✓ ${PKG}/${FILE}: ${HUNKS.length} 处 hunk 已套用（真解析校验通过）`)
}

if (liveSrc !== null && srcPath !== LIVE) {
  const same = liveSrc === s
  console.log(same
    ? '  ✅ 变换结果与装机副本**逐字节一致**'
    : `  ⚠ 与装机副本不一致（本机 ${liveSrc.length} 字节 / 变换 ${s.length} 字节）`)
  if (!same) {
    console.error('  ✗ 不一致 → **拒绝写出 overlay**（避免用错误的变换覆盖掉正确副本）')
    process.exit(2)
  }
}

for (const dst of [`${SB}/build-overlay/${REL}/${PKG}/${FILE}`, `${OVL}/${REL2}/${PKG}/${FILE}`]) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, s)
}
console.log('  → 写出 build-overlay + overlay 两份')
