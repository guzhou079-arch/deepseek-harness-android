#!/usr/bin/env node
/**
 * check-bg-injection.js —— 门禁：payload 里的"背景图注入"必须在
 * ============================================================================
 * 为什么需要它（2026-10-01 真实事故）：
 *
 *   `dsh-bg.css`（背景图 + 遮罩）**只有靠一段注入才会被加载** —— 那段注入写在
 *   `@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js` 的 factory 顶部：
 *
 *       var link = document.createElement("link");
 *       link.href = "/dsh-bg.css?rev=" + Date.now();
 *
 *   这个文件**同时也在 build-overlay 里**。而 overlay 里那份是从"上游干净版"来的，
 *   **不含这段注入** → 出包时它把好的版本覆盖掉 → 打出来的包里注入没了
 *   → 装上去背景图彻底不显示（不是被遮罩盖住，是加载代码没了）。
 *
 *   后果：
 *     · 我自己重装几次后，手机上的壁纸消失（用户："壁纸什么时候还我"）
 *     · **已发布的 v1.27 也带着这个缺陷**（实测：v1.26 有注入、v1.27 = 0）
 *       → 线上用户的背景图同样没了，而且那版"修屏幕太黑"的改动**根本没生效**
 *       （CSS 没被加载，改它等于没改）
 *
 * 所以：**出包前必须验**。这条门禁挂在 `selfbuild.sh patch` 里，
 * overlay 一应用完就检查——缺了直接让出包失败，别再让它溜进发布。
 *
 * ── 为什么还要 `--zip` 模式（2026-11-07）──────────────────────────────
 * 门禁只查 overlay 那个路径会出假红：overlay 里那份"上游干净版"已经从 overlay 里
 * 清掉了（留着才是危险——它会盖掉骨架 APK 里带注入的那份），于是 overlay 根本没有
 * 这个文件，而**骨架解出来的 payload 里那份一直是带注入的，打出来的包是好的**。
 * 门禁应该验**结果**：真正的判据是「随包发出去的那条 payload 条目里有没有注入」。
 * 同时保留 overlay 那份的检查（若它还在）：那种情况下 overlay 会在 patch 阶段
 * 覆盖掉好版本，正是 v1.27 事故的形状，必须一起拦。
 *
 * 用法：
 *   node check-bg-injection.js <client.js 路径> [--fix]
 *   node check-bg-injection.js --zip <payload.zip> --entry <zip 内条目名>
 *   --fix 会用 selfbuild/scripts/bg-injection-snippet.js 里的片段补回去（仅文件模式）
 * 退出码：0 = 注入在；1 = 注入丢失 / 条目不存在 / 用法错误
 */
const fs = require('fs');
const path = require('path');

const ENTRY_DEFAULT = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/'
  + '@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js';

const argv = process.argv.slice(2);
const FIX = argv.includes('--fix');
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** 判定一份 client.js 文本里注入在不在。返回 true = 在。 */
function judge(t, label) {
  if (!t.includes('dsh-bg.css')) {
    console.error('  ✗ 背景图注入不见了！');
    console.error('     ' + label);
    console.error('     这会导致：装上去背景图完全不显示（CSS 根本不会被加载）。');
    return false;
  }
  console.log('  ✅ 背景图注入在（dsh-bg.css 引用）— ' + label);
  // 顺带确认注入是"活的"：href 里得有 cache-bust，否则换图不生效
  if (!/dsh-bg\.css\?rev=/.test(t)) {
    console.log('  ⚠️ 有 dsh-bg.css 引用但没有 ?rev= 缓存版本号，换图可能不生效');
  }
  return true;
}

// ── zip 模式：查随包发出去的那条 payload 条目
const zipFile = opt('--zip');
if (zipFile) {
  const entry = opt('--entry') || ENTRY_DEFAULT;
  if (!fs.existsSync(zipFile)) {
    console.error('✗ payload 不存在：' + zipFile);
    process.exit(1);
  }
  const { readZip, readEntry } = require(path.join(__dirname, '..', 'lib', 'ziptool.js'));
  const es = readZip(zipFile, { load: false });
  const hit = es.find((e) => e.name === entry);
  if (!hit) {
    console.error('  ✗ payload 里没有这条：' + entry);
    console.error('     这不是"覆盖出问题"，是这条文件整体没进包。');
    process.exit(1);
  }
  // readZip 只给元信息（raw = 压缩字节），文本要用 readEntry 解压 —— 直接读 e.data 会拿到空内容，
  // 于是"注入丢了"变成假红（实测过一次，差点据此改坏 overlay）。
  const text = readEntry(zipFile, hit).toString('utf8');
  if (!judge(text, zipFile.split('/').pop() + ' → ' + entry)) {
    console.error('     修：从带注入的骨架 APK 里把这条捞回来；');
    console.error('         或确认 overlay 里没有"上游干净版"在覆盖它。');
    process.exit(1);
  }
  process.exit(0);
}

// ── 文件模式
const file = argv.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('用法：node check-bg-injection.js <client.js> [--fix]');
  console.error('      node check-bg-injection.js --zip <payload.zip> [--entry <条目名>]');
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error('✗ 文件不存在：' + file); process.exit(1); }

let t = fs.readFileSync(file, 'utf8');
if (judge(t, path.basename(file))) process.exit(0);

if (!FIX) {
  console.error('     修：node check-bg-injection.js "' + file + '" --fix');
  console.error('     （或从旧 APK 里把这份 client.js 捞回来）');
  process.exit(1);
}

// ── --fix：插入注入片段
const snippetFile = path.join(__dirname, 'bg-injection-snippet.js');
if (!fs.existsSync(snippetFile)) { console.error('✗ 缺少片段文件：' + snippetFile); process.exit(1); }
const snippet = fs.readFileSync(snippetFile, 'utf8');

// 找 `factory: (require) => {`（实际文件里是 tab 缩进的）
const anchor = /\n(\t*)factory: \(require\) => \{\n/;
if (!anchor.test(t)) {
  console.error('✗ 找不到插入锚点 factory: (require) => {');
  process.exit(1);
}
t = t.replace(anchor, (m, indent) => {
  const body = snippet.split('\n').map((l) => (l.length ? indent + l : l)).join('\n');
  return '\n' + indent + 'factory: (require) => {\n' + body;
});
fs.writeFileSync(file, t);
console.log('  ✅ 已补回背景图注入（原文件已改，建议 git diff 看一眼）');
