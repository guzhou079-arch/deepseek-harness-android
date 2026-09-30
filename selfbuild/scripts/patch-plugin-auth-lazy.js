// v1.30 补丁（**安全变体**）：给 /plugins/<id>/client.js 与 /plugins/events 加鉴权。
//
// 两条铁律（都是 v1.28 事故换来的）：
//   ① **绝不改这两个 required 插件的 inject** —— 那会让插件激活失败、引擎起不来；
//   ② 插入的代码必须是**函数体内的语句**，绝不能把箭头函数提前闭合
//      （v1.28 我写成 `handler: (req,res) => { ...guard... } return this.serveBundle(...)`
//       → `return` 落到函数外 → 模块 import 失败 → required 插件挂 → 引擎起不来）。
//
// 做法：handler 里**懒取** connection（ctx.get("connection")），拿得到才门禁；
// 拿不到就放行并打 error（fail-open，保证 GUI 不会因为我而挂）。
// 生成后**真解析校验**（不是 node --check —— 它对这种文件会给假通过）。
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const N = process.env.DSH_KERNEL_DIR || '/data/user/0/com.deepseek.harness/files/payload/dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const R = process.env.DSH_PROJECT || path.join(__dirname, '../..')
const SB = path.join(R, 'selfbuild');
const OVL = path.join(R, 'v118/dsh-patches/overlay');
const REL = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';
const REL2 = 'lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

// 只是语句，不含包裹花括号、也不闭合外层函数
const stmts = (ctxName, tag) => [
  `\t\t\t\t\t// v1.30：懒取 connection（不改 inject，避免激活失败）`,
  `\t\t\t\t\tconst __conn = typeof ${ctxName}.get === "function" ? ${ctxName}.get("connection") : void 0;`,
  '\t\t\t\t\tif (__conn !== void 0 && __conn !== null && typeof __conn.admit === "function") {',
  '\t\t\t\t\t\tconst __verdict = __conn.admit(req);',
  '\t\t\t\t\t\tif (__verdict.rejection !== void 0) {',
  '\t\t\t\t\t\t\tres.writeHead(__verdict.rejection, __verdict.rejection === 401 ? {',
  '\t\t\t\t\t\t\t\t"cache-control": "no-store",',
  '\t\t\t\t\t\t\t\t"content-type": "text/plain; charset=utf-8"',
  '\t\t\t\t\t\t\t} : void 0);',
  '\t\t\t\t\t\t\tres.end(__verdict.rejection === 401 ? "dsh web authentication required; reopen the URL printed by dsh web.\\n" : void 0);',
  '\t\t\t\t\t\t\treturn;',
  '\t\t\t\t\t\t}',
  `\t\t\t\t\t} else { console.error("${tag}: connection service unavailable; request NOT gated"); }`
].join('\n');

// 真解析校验：动态 import 会先解析再解析依赖 —— SyntaxError 说明生成坏了，
// 其它错误（如 ERR_MODULE_NOT_FOUND）说明语法没问题。
function syntaxOk(file) {
  const r = cp.spawnSync(process.execPath, ['--input-type=module', '-e',
    `import(${JSON.stringify('file://' + file)}).catch(e => { if (e instanceof SyntaxError) { console.error('SYNTAX:' + e.message); process.exit(7); } })`],
    { encoding: 'utf8', timeout: 30000 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (out.includes('SYNTAX:')) return out.split('SYNTAX:')[1].split('\n')[0];
  return null;
}

function patch(pkg, transforms) {
  const src = `${N}/${pkg}/lib/index.js`;
  let s = fs.readFileSync(src, 'utf8');
  // 幂等：运行树里已经打过本补丁 → 直接把当前文件当成品同步出去（不重复打）
  if (s.includes('__verdict.rejection')) {
    for (const dst of [`${SB}/build-overlay/${REL}/${pkg}/lib/index.js`, `${OVL}/${REL2}/${pkg}/lib/index.js`]) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.writeFileSync(dst, s);
    }
    console.log(`  ✓ ${pkg}: 已是打过补丁的状态 → 直通同步（幂等）`);
    return;
  }
  for (const [from, to, label] of transforms) {
    const n = s.split(from).length - 1;
    if (n !== 1) { console.error(`✗ ${pkg}: 期望 1 处「${label}」，实际 ${n} 处 → 中止`); process.exit(1); }
    s = s.replace(from, to);
    console.log(`  ✓ ${pkg}: ${label}`);
  }
  const tmp = path.join(SB, 'work', `${pkg}.v130-check.mjs`);
  fs.writeFileSync(tmp, s);
  const err = syntaxOk(tmp);
  if (err) { console.error(`✗ ${pkg}: 生成结果语法错误 → ${err}\n  （大概率是把外层函数提前闭合了）`); process.exit(1); }
  console.log(`  ✓ ${pkg}: 真解析校验通过`);
  for (const dst of [`${SB}/build-overlay/${REL}/${pkg}/lib/index.js`, `${OVL}/${REL2}/${pkg}/lib/index.js`]) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, s);
  }
  console.log('  → 写出 build-overlay + overlay 两份');
}

patch('dsh-client-modules', [
  ['\t\t\t\thandler: this.serveBundle\n',
   `\t\t\t\thandler: (req, res) => {\n${stmts('webCtx', 'client-modules')}\n\t\t\t\t\treturn this.serveBundle(req, res);\n\t\t\t\t}\n`,
   'bundle 路由加懒门禁'],
]);

patch('dsh-client-hmr', [
  ['\t\t\thandler: (req, res) => {\n\t\t\t\tif (req.method !== "GET" && req.method !== "HEAD") {\n',
   `\t\t\thandler: (req, res) => {\n${stmts('ctx', 'client-hmr')}\n\t\t\t\tif (req.method !== "GET" && req.method !== "HEAD") {\n`,
   'events SSE 加懒门禁'],
]);

// v1.31：这个只读路由无 cookie 也能拿到内核/远端版本号（无凭据，但仍是未鉴权面）
patch('dsh-update-check', [
  ['          handler: async (req, res) => {\n            try {\n',
   `          handler: async (req, res) => {\n${stmts('webCtx', 'update-check')}\n            try {\n`,
   'update-check 状态路由加懒门禁'],
]);
console.log('ALL OK —— 下一步：跑 preflight（必须确认没有 "connection service unavailable"）');
