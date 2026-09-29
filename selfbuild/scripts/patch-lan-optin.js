// v1.32 补丁：给「局域网绑定」开一个**显式开关**，默认仍然拒绝。
//
// 背景（实测，两道闸）：
//   ① dsh-web-app/lib/startup.js:40 对 `--host 0.0.0.0` 直接 program.error（上游安全设计）
//   ② dsh-host-webserver 的 config schema 只接受 "127.0.0.1" | "0.0.0.0"
//      → 想绕开①用 `--host ::` 会被②拒（ValidationError: `$.host expected "127.0.0.1" | "0.0.0.0"`）
//   所以唯一可行路径就是①放行 0.0.0.0 —— 而 0.0.0.0 同时包含回环，App 自己的 WebView（127.0.0.1）不受影响。
//
// 安全设计：**不是删掉上游的拒绝**，而是让它只在环境变量 DSH_ALLOW_LAN=1 时才放行。
//   App 侧只有用户在 /lan 显式开启后才会注入该环境变量 → 任何"误传 --host 0.0.0.0"仍然报错退出。
//
// 前置条件（均已具备）：三处无鉴权读面在 v1.24~v1.31 全部关闭（无 cookie 一律 401/403）。
// 残留风险：令牌走明文 HTTP，同网段可嗅探 → 只在可信网络使用。
const fs = require('fs'), path = require('path'), cp = require('child_process');
const N = process.env.DSH_KERNEL_DIR || '/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const SB = '/storage/emulated/0/Download/Operit/dsh_own_app/selfbuild';
const OVL = '/storage/emulated/0/Download/Operit/dsh_own_app/v118/dsh-patches/overlay';
const REL = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const REL2 = 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const PKG = 'dsh-web-app', FILE = 'lib/startup.js';

const from = '\t\tif (options.host === "0.0.0.0") program.error("error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead");';
const to = [
  '\t\t// v1.32：默认仍拒绝 0.0.0.0（保持上游安全语义）；只有 App 在用户显式开启局域网访问时',
  '\t\t// 注入 DSH_ALLOW_LAN=1 才放行。0.0.0.0 含回环，WebView(127.0.0.1) 不受影响。',
  '\t\tif (options.host === "0.0.0.0" && process.env.DSH_ALLOW_LAN !== "1") program.error("error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose remote code execution to the network; use 127.0.0.1 instead (or set DSH_ALLOW_LAN=1 to opt in explicitly)");'
].join('\n');

const src = `${N}/${PKG}/${FILE}`;
let s = fs.readFileSync(src, 'utf8');
if (s.includes('DSH_ALLOW_LAN')) {
  console.log('  ✓ 已是打过补丁的状态 → 直通同步（幂等）');
} else {
  const n = s.split(from).length - 1;
  if (n !== 1) { console.error(`✗ 期望 1 处锚点，实际 ${n} 处 → 中止`); process.exit(1); }
  s = s.replace(from, to);
  // 真解析校验（node --check 在这种文件上会给假通过）
  const tmp = path.join(SB, 'work', `${PKG}-lan-check.mjs`);
  fs.writeFileSync(tmp, s);
  const r = cp.spawnSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify('file://' + tmp)}).catch(e => { if (e instanceof SyntaxError) { console.error('SYNTAX:' + e.message); process.exit(7); } })`],
    { encoding: 'utf8', timeout: 30000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (out.includes('SYNTAX:')) { console.error('✗ 语法错误: ' + out.split('SYNTAX:')[1].split('\n')[0]); process.exit(1); }
  console.log('  ✓ dsh-web-app/lib/startup.js: 0.0.0.0 改为需 DSH_ALLOW_LAN=1（真解析校验通过）');
}
for (const dst of [`${SB}/build-overlay/${REL}/${PKG}/${FILE}`, `${OVL}/${REL2}/${PKG}/${FILE}`]) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, s);
}
console.log('  → 写出 build-overlay + overlay 两份');
