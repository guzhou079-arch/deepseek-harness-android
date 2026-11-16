// v1.15 变换脚本：交付文件「打开」的 android 分支
//
// 为什么要有这个脚本：原来是**整文件覆盖** dsh-native-command 的 index.js。
// 内核升级会把那份副本整片盖回上游（静默）。改成定点变换后不携带上游代码，
// 锚点找不到会**显式失败**，不会产出半成品。
//
// 背景：Android 上要「打开文件」必须由 App 进程发 Intent —— 从 app uid 直接
// `am start` 会被平台拒（"package=com.android.shell does not belong to uid=..."）。
// App 暴露了一个本地 HTTP 桥（无障碍服务，默认 3181），本补丁让 platform === "android"
// 时走后端桥而不是抛 "native path opener is unsupported"。
//
// 用法：
//   node patch-native-command-android.js                    # 从装机副本取源，写 overlay
//   node patch-native-command-android.js --from <原版文件>   # 从原版变换，并与装机副本比对
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const N = process.env.DSH_KERNEL_DIR || '/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const R = process.env.DSH_PROJECT || path.join(__dirname, '../..')
const SB = path.join(R, 'selfbuild')
const OVL = path.join(R, 'v118/dsh-patches/overlay')
const REL = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const REL2 = 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const PKG = 'dsh-native-command'
const FILE = 'lib/index.js'
const MARKER = 'androidBridgeOpen'
const LIVE = `${N}/${PKG}/${FILE}`

const ANDROID_FUNCS = [
  '/** POST one path to the App bridge; the App builds the content:// URI and views it.',
  '* Uses `node:http` rather than `fetch` on purpose: undici stamps `sec-fetch-mode: cors`',
  '* on every request, and the App\'s loopback fence rejects a request that carries a',
  '* `sec-fetch-*` header while sending no Origin/Referer. The call is then refused before',
  '* the bridge dispatches it, which surfaces to the caller as a broken opener.',
  '* The accessibility bridge client uses the same transport for the same reason. */',
  'function androidBridgeOpen(path, signal) {',
  '\tconst port = androidBridgePort();',
  '\tconst body = JSON.stringify({ path });',
  '\treturn new Promise((resolve, reject) => {',
  '\t\tlet request;',
  '\t\tconst onAbort = () => {',
  '\t\t\tif (request !== void 0) request.destroy(new Error("aborted"));',
  '\t\t};',
  '\t\tconst settle = (error) => {',
  '\t\t\tif (signal !== void 0) signal.removeEventListener("abort", onAbort);',
  '\t\t\tif (error === void 0) resolve();',
  '\t\t\telse reject(error);',
  '\t\t};',
  '\t\tif (signal !== void 0 && signal.aborted) {',
  '\t\t\tsettle(new Error("android open aborted before the bridge was reached"));',
  '\t\t\treturn;',
  '\t\t}',
  '\t\trequest = process.getBuiltinModule("node:http").request({',
  '\t\t\thost: "127.0.0.1",',
  '\t\t\tport,',
  '\t\t\tpath: "/open-file",',
  '\t\t\tmethod: "POST",',
  '\t\t\theaders: {',
  '\t\t\t\t"content-type": "application/json",',
  '\t\t\t\t"content-length": Buffer.byteLength(body),',
  '\t\t\t\t// 3181 桥校验共享密钥（App 经 env 注入；同机其他应用拿不到）',
  '\t\t\t\t"x-dsh-token": String(process.env.APP_LOCAL_TOKEN || "").trim()',
  '\t\t\t}',
  '\t\t}, (response) => {',
  '\t\t\tlet text = "";',
  '\t\t\tresponse.setEncoding("utf8");',
  '\t\t\tresponse.on("data", (chunk) => {',
  '\t\t\t\ttext += chunk;',
  '\t\t\t});',
  '\t\t\tresponse.on("end", () => {',
  '\t\t\t\tlet data = null;',
  '\t\t\t\ttry {',
  '\t\t\t\t\tdata = JSON.parse(text);',
  '\t\t\t\t} catch (ignored) {}',
  '\t\t\t\tif (response.statusCode === 200 && data !== null && data.ok === true) settle();',
  '\t\t\t\telse settle(new Error(`android open failed: ${data && data.error ? data.error : `HTTP ${response.statusCode}`}`));',
  '\t\t\t});',
  '\t\t});',
  '\t\trequest.on("error", (error) => settle(new Error(`android open bridge unreachable on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`)));',
  '\t\tif (signal !== void 0) signal.addEventListener("abort", onAbort, { once: true });',
  '\t\trequest.end(body);',
  '\t});',
  '}'
].join('\n')

const HUNKS = [
  {
    name: '插入 android 桥两个函数',
    from: '/** Dispatch one shell-free platform command for the requested open intent. */',
    to: ANDROID_FUNCS + '\n/** Dispatch one shell-free platform command for the requested open intent. */',
  },
  {
    name: '插入 android 分支',
    from: [
      '\t\tawait run("xdg-open", [path], signal, "hidden");',
      '\t\treturn;',
      '\t}',
      '\tthrow new Error(`native path opener is unsupported on ${platform}`);',
    ].join('\n'),
    to: [
      '\t\tawait run("xdg-open", [path], signal, "hidden");',
      '\t\treturn;',
      '\t}',
      '\tif (platform === "android") {',
      '\t\tawait androidBridgeOpen(path, signal);',
      '\t\treturn;',
      '\t}',
      '\tthrow new Error(`native path opener is unsupported on ${platform}`);',
    ].join('\n'),
  },
  {
    name: 'canOpenNativePath 支持 android',
    from: [
      '\tif (platform === "darwin" || platform === "win32") return true;',
      '\tif (platform !== "linux") return false;',
    ].join('\n'),
    to: [
      '\tif (platform === "darwin" || platform === "win32") return true;',
      '\tif (platform === "android") return true;',
      '\tif (platform !== "linux") return false;',
    ].join('\n'),
  },
  {
    name: 'nativeFileManager 支持 android',
    from: [
      '\tif (platform === "darwin") return "finder";',
      '\tif (platform === "win32" || platform === "linux" && isWsl(internals)) return "explorer";',
    ].join('\n'),
    to: [
      '\tif (platform === "darwin") return "finder";',
      '\tif (platform === "android") return "directory";',
      '\tif (platform === "win32" || platform === "linux" && isWsl(internals)) return "explorer";',
    ].join('\n'),
  },
  {
    name: 'directory 管理器走 android 桥',
    from: [
      '\tif (manager === "directory") {',
      '\t\tawait run("xdg-open", [dirname(path)], signal, "hidden");',
    ].join('\n'),
    to: [
      '\tif (manager === "directory") {',
      '\t\tif (platform === "android") {',
      '\t\t\tawait androidBridgeOpen(dirname(path), signal);',
      '\t\t\treturn;',
      '\t\t}',
      '\t\tawait run("xdg-open", [dirname(path)], signal, "hidden");',
    ].join('\n'),
  },
]

function syntaxCheck(src) {
  const tmp = path.join(SB, 'work', `${PKG}-android-check.mjs`)
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
