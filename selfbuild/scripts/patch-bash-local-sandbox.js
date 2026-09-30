// rc.2 补丁：给 @deepseek-ai/dsh-bash-local 的 LocalBashExecutor 补 sandboxMode
//
// 病灶（rc.2 升级时暴露的阻断级问题，2026-09-29 事故复盘「问题 3」）：
//   Android 没有原生沙箱 → profile 层用 bash-local 替代 bash-sandbox 提供 ctx.shell。
//   rc.1 的装机副本里，这个 getter 是**基础包 payload 自带**的（不在我们 overlay 里），
//   所以 rc.2 内核层一覆盖，getter 就没了 → 于是：
//     · dsh-permission-presets 构造函数：
//         if (ctx.shell.sandboxMode === void 0) throw new Error(
//           "permission: the mounted bash executor does not confine (no sandboxMode) …")
//       → permission 服务不激活（启动日志 "1 entry did not activate"）
//     · dsh-api-session-controller 的消息准入依赖 permission → 任何会话发消息都被拒：
//         prompt rejected (session/agent-busy)
//   ⇒ 表现就是「重启后页面不对、消息发不出去」。这是 rc.2 上机失败的直接原因。
//
// 修法：把 rc.1 时期的同名补丁**搬进我们的 overlay**（这样它才不会被内核层顶掉），
//   取值 workspace-write —— 与 rc.1 补丁逐字一致，也与默认 ask 审批预设相符。
//
// 用法：
//   node patch-bash-local-sandbox.js                                   # 从装机副本取源
//   DSH_KERNEL_DIR=<内核@deepseek-ai目录> node patch-bash-local-sandbox.js    # 对新内核重打
//   node patch-bash-local-sandbox.js --from <某份 lib/index.js>          # 指定源（不出包时用）
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const N = process.env.DSH_KERNEL_DIR || '/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const R = process.env.DSH_PROJECT || path.join(__dirname, '../..')
const SB = path.join(R, 'selfbuild')
const OVL = path.join(R, 'v118/dsh-patches/overlay')
const REL = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const REL2 = 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const PKG = 'dsh-bash-local'
const FILE = 'lib/index.js'
const MARKER = 'dsh-android-patch (bash-local sandboxMode)'
const LIVE = `${N}/${PKG}/${FILE}`

const GETTER = [
  '\t// dsh-android-patch (bash-local sandboxMode)：Android 没有原生沙箱（bash-sandbox 已停用，',
  '\t// 由本插件提供 ctx.shell），必须**显式**报告 sandboxMode，否则 dsh-permission-presets',
  '\t// 构造时抛 "the mounted bash executor does not confine (no sandboxMode)" → permission 不激活',
  '\t// → 所有会话 prompt 被拒（session/agent-busy / prompt rejected）。取值与 rc.1 时期的补丁一致。',
  '\tget sandboxMode() {',
  '\t\treturn "workspace-write";',
  '\t}',
].join('\n') + '\n'

const HUNKS = [
  {
    name: 'LocalBashExecutor.sandboxMode',
    from: 'var LocalBashExecutor = class LocalBashExecutor extends ShellExecutor {\n\tconfig;',
    to: 'var LocalBashExecutor = class LocalBashExecutor extends ShellExecutor {\n' + GETTER + '\tconfig;',
  },
]

/** 真解析校验：ESM 语法错会抛 SyntaxError（比 node --check 更贴近引擎的实际加载方式）。 */
function syntaxCheck(src) {
  const tmp = '/data/user/0/com.deepseek.harness/files/tmp/dsh-patch-syntax-check.mjs'
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  fs.writeFileSync(tmp, src)
  const r = cp.spawnSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify('file://' + tmp)}).catch(e => { if (e instanceof SyntaxError) { console.error('SYNTAX:' + e.message); process.exit(7) } })`],
    { encoding: 'utf8', timeout: 30000 })
  const out = (r.stdout || '') + (r.stderr || '')
  return out.includes('SYNTAX:') ? out.split('SYNTAX:')[1].split('\n')[0] : null
}

const argv = process.argv.slice(2)
const fi = argv.indexOf('--from')
const srcPath = fi >= 0 ? argv[fi + 1] : LIVE

let s = fs.readFileSync(srcPath, 'utf8')
const liveSrc = fs.existsSync(LIVE) ? fs.readFileSync(LIVE, 'utf8') : null
const liveAlreadyPatched = liveSrc !== null && liveSrc.includes(MARKER)

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

// 语义校验：getter 必须落在 LocalBashExecutor 类体内（不是别处）
const classAt = s.indexOf('var LocalBashExecutor = class')
const getterAt = s.indexOf('get sandboxMode()')
if (classAt < 0 || getterAt < 0 || getterAt < classAt || getterAt - classAt > 1200) {
  console.error('  ✗ 语义校验失败：getter 不在 LocalBashExecutor 类体内')
  process.exit(2)
}
console.log('  ✓ 语义校验：getter 位于 LocalBashExecutor 类体，返回 "workspace-write"')

for (const dst of [`${SB}/build-overlay/${REL}/${PKG}/${FILE}`, `${OVL}/${REL2}/${PKG}/${FILE}`]) {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  fs.writeFileSync(dst, s)
}
console.log('  → 写出 build-overlay + overlay 两份')
