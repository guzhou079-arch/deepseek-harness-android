#!/usr/bin/env node
/**
 * patch-bring-to-front.js —— 登录成功后把 App 自动拉回前台
 * ============================================================================
 * 问题：账户登录走外部浏览器。授权完成后浏览器停在平台的「登录成功 / 打开应用」
 *       页面，而那个「打开应用」按钮用的是本机没有注册的 scheme —— **点了没反应**
 *       （2026-09-30 用户实测）。用户必须手动切回 App。
 *
 * 修法：`dsh-deepseek-account-platform` 在 authorization 成功那一刻，直接调 App
 *       的内嵌特权桥（`POST http://127.0.0.1:<APP_NOTIFY_PORT>/shell`）执行
 *       `am start -n <包名>/.MainActivity`，把 App 自己拉回前台。
 *
 * 为什么这条路成立（全部实测）：
 *   · 桥以 **shell(uid 2000)** 身份经 Shizuku 执行 —— `am start` 权限足够
 *   · ActivityManager 记账确认：`launchedFromUid=2000
 *     launchedFromPackage=com.android.shell`，`topResumedActivity=...MainActivity`
 *   · 端口/令牌/包名都由 App 经 env 交给引擎（MainActivity.java:4437-4444），
 *     不需要读 shared_prefs、不硬编码
 *
 * 不打补丁也能跑：env 缺失（比如在非安卓环境）时整段静默跳过。
 * 失败不影响登录本身 —— fetch 是 fire-and-forget，不 await。
 *
 * 用法：
 *   node patch-bring-to-front.js [--check] [--revert]
 *   node patch-bring-to-front.js --from <其它内核>/.../dsh-deepseek-account-platform/lib/index.js
 * ============================================================================
 */
const fs = require('node:fs');
const path = require('node:path');

const MARK = 'dsh-android-patch v4 (bring-to-front)';
const REL = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-deepseek-account-platform/lib/index.js';
const DEFAULT_ROOT = '/data/user/0/com.deepseek.harness/files/payload';

// 插入点锚：authorization 成功后更新 phase 的那一行（全文件唯一）
const ANCHOR = '\t\t\tthis.update(attempt, { phase: outcome.status === "authorized" ? "succeeded" : "cancelled" });';

const SNIPPET = `
\t\t\t//#region ${MARK}
\t\t\t// 登录已在浏览器里完成 → 把 App 拉回前台，免去用户手动切换。
\t\t\t// 「打开应用」那个按钮用的是本机未注册的 scheme，点了没反应（实测），所以自己来。
\t\t\t// 桥：App 内嵌特权通道，以 shell(uid 2000) 执行 am start；端口/令牌由 env 交来。
\t\t\tif (outcome.status === "authorized") try {
\t\t\t\tconst __env = process.env;
\t\t\t\tconst __port = Number.parseInt(__env.APP_NOTIFY_PORT ?? "", 10);
\t\t\t\tconst __token = __env.APP_LOCAL_TOKEN;
\t\t\t\tif (Number.isInteger(__port) && __port > 0 && typeof __token === "string" && __token !== "") {
\t\t\t\t\tfetch(\`http://127.0.0.1:\${__port}/shell\`, {
\t\t\t\t\t\tmethod: "POST",
\t\t\t\t\t\theaders: { "content-type": "application/json" },
\t\t\t\t\t\tbody: JSON.stringify({
\t\t\t\t\t\t\tcommand: \`am start -n \${__env.SHIZUKU_APP_ID || "com.deepseek.harness"}/.MainActivity\`,
\t\t\t\t\t\t\ttimeout_ms: 15000,
\t\t\t\t\t\t\ttoken: __token
\t\t\t\t\t\t})
\t\t\t\t\t}).catch(() => void 0);
\t\t\t\t}
\t\t\t} catch {}
\t\t\t//#endregion
`;

function findTarget(explicit) {
  const roots = [explicit, DEFAULT_ROOT, '/data/data/com.deepseek.harness/files/payload'].filter(Boolean);
  for (const r of roots) {
    const p = path.isAbsolute(r) && r.endsWith('.js') ? r : path.join(r, REL);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const argv = process.argv.slice(2);
const mode = argv.includes('--check') ? 'check' : argv.includes('--revert') ? 'revert' : 'apply';
const fromIdx = argv.indexOf('--from');
const target = findTarget(fromIdx >= 0 ? argv[fromIdx + 1] : undefined);

if (!target) { console.error('✗ 找不到 dsh-deepseek-account-platform/lib/index.js'); process.exit(1); }
console.log('目标:', target);

let src = fs.readFileSync(target, 'utf8');
const has = src.includes(MARK);

if (mode === 'check') {
  console.log('  补丁:', has ? '在' : '缺');
  const n = src.split(ANCHOR).length - 1;
  console.log('  锚点命中:', n, n === 1 ? '(唯一 ✓)' : '(异常!)');
  process.exit(has ? 0 : 2);
}

if (mode === 'revert') {
  if (!has) { console.log('  本来就没有，跳过'); process.exit(0); }
  const re = new RegExp('\\n\\t\\t\\t//#region ' + MARK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?//#endregion\\n', 'g');
  const out = src.replace(re, '');
  if (out.includes(MARK)) { console.error('✗ 未能完整移除'); process.exit(1); }
  fs.writeFileSync(target + '.pre-revert', src);
  fs.writeFileSync(target, out);
  console.log('  ✓ 已还原（原件存 .pre-revert）');
  process.exit(0);
}

if (has) { console.log('  ✓ 已打过补丁，跳过（幂等）'); process.exit(0); }

const n = src.split(ANCHOR).length - 1;
if (n !== 1) { console.error(`✗ 锚点命中 ${n} 次，预期 1（内核结构变了？）`); process.exit(1); }

fs.writeFileSync(target + '.bak-before-v4', src);
src = src.replace(ANCHOR, ANCHOR + '\n' + SNIPPET);
fs.writeFileSync(target, src);
console.log('  ✓ 已插入 bring-to-front（原始件存 .bak-before-v4）');
