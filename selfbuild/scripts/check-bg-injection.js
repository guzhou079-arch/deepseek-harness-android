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
 * ── 为什么 `--zip` 要拒收 APK（2026-11-21，真踩过）────────────────────
 * `--zip` 收的是 **payload.zip**。有人把整个 APK 传进来时，`readEntry()` 解出的
 * 是「嵌套 zip 的原始字节」，而那个二进制里恰好有一串 `dsh-bg.css`（它是 payload
 * 内部的一个**文件名条目**）—— 旧判据 `includes('dsh-bg.css')` 于是打 ✓。
 * 命中的是文件名，不是注入代码；同一份字节里搜 `/dsh-bg.css?rev=` 是 false。
 * 所以：
 *   · 判据收紧到 `/dsh-bg.css?rev=`（有引用但没 cache-bust 属于真违规，不再是 ⚠️ 放过）
 *   · 找不到 entry 却找得到 `assets/payload.zip`（或 entry 名字像 APK 内路径）→ exit 2，
 *     点名「你把 APK 当成 payload.zip 传了」
 *
 * 用法：
 *   node check-bg-injection.js <client.js 路径> [--fix]
 *   node check-bg-injection.js --zip <payload.zip> --entry <zip 内条目名>
 *   --fix 会用 selfbuild/scripts/bg-injection-snippet.js 里的片段补回去（仅文件模式）
 *
 * 退出码（三态，跟工程其它闸一致）：
 *   0 = 注入在
 *   1 = 违规：注入丢了 / 只有 dsh-bg.css 没有 ?rev= / 条目整体没进包
 *   2 = 无法判定：zip 或文件读不到、条目解出来是空的、用法错误、传错层级（APK 当 payload.zip）
 */
const fs = require('fs');
const path = require('path');

const ENTRY_DEFAULT = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/'
  + '@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js';

const CANNOT = 2;
const argv = process.argv.slice(2);
const FIX = argv.includes('--fix');
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** 判定一份 client.js 文本里注入在不在。返回 true = 在（可配 exit 0）。 */
function judge(t, label) {
  // 硬判据：注入是「有 cache-bust 的那条引用」，不是「文本里出现过 dsh-bg.css」。
  // 前者是注入代码，后者连「payload 内部文件名出现在二进制里」都能撞上。
  if (!t.includes('/dsh-bg.css?rev=')) {
    if (t.includes('dsh-bg.css')) {
      console.error('  ✗ 有 dsh-bg.css 引用，但没有 /dsh-bg.css?rev= 缓存版本号');
      console.error('     ' + label);
      console.error('     这属于注入不完整：CSS 会被加载，但换图后浏览器仍用旧缓存，改了看不到。');
    } else {
      console.error('  ✗ 背景图注入不见了！');
      console.error('     ' + label);
      console.error('     这会导致：装上去背景图完全不显示（CSS 根本不会被加载）。');
    }
    return false;
  }
  console.log('  ✅ 背景图注入在（/dsh-bg.css?rev= 引用）— ' + label);
  // 顺带确认注入是"活的"：rev 得来自时间戳，否则每次加载还是同一个 URL。
  // 这条不升级为红（历史包可能用别的写法），只提示。
  if (!/\/dsh-bg\.css\?rev="?\s*\+\s*Date\.now\(\)/.test(t)) {
    console.log('  ⚠️ ?rev= 的取值不像 + Date.now()，换图可能不生效');
  }
  return true;
}

// ── zip 模式：查随包发出去的那条 payload 条目
const zipFile = opt('--zip');
if (zipFile) {
  const entry = opt('--entry') || ENTRY_DEFAULT;
  if (!fs.existsSync(zipFile)) {
    console.error('✗ 无法判定：payload 不存在：' + zipFile);
    console.error('  读不到判据对象，不能当成「注入丢了」。');
    process.exit(CANNOT);
  }
  const { readZip, readEntry } = require(path.join(__dirname, '..', 'lib', 'ziptool.js'));
  let es;
  try {
    es = readZip(zipFile, { load: false });
  } catch (e) {
    console.error('✗ 无法判定：读不了 zip ' + zipFile + '：' + e.message);
    console.error('  这不是「注入丢了」，是传进来的东西不是 payload.zip。');
    process.exit(CANNOT);
  }
  // 传错层级：APK 里有 assets/payload.zip，payload.zip 里没有。
  // 注意要在「找 entry」之前判：把 APK 传进来时 --entry 常常正好写成 assets/payload.zip，
  // 那个条目在 APK 里是真存在的，先按名字找就会"找到"，然后拿嵌套 zip 的字节去判 —— 又绕回假绿。
  const looksLikeApk = es.some((e) => e.name === 'assets/payload.zip');
  const entryLooksApkPath = /^assets\//.test(entry) || /\.zip$/.test(entry);
  if (looksLikeApk) {
    console.error('  ✗ 无法判定：你把 APK 当成 payload.zip 传了');
    console.error('     这个 zip 里有 assets/payload.zip，说明它本身是 APK；payload.zip 才是 --zip 该收的东西。');
    console.error('     先抽出 assets/payload.zip 再传：unzip -p <APK> assets/payload.zip > /tmp/payload.zip');
    console.error('     （不抽出来直接判，二进制里撞到 "dsh-bg.css" 会假绿 —— 命中的是文件名，不是注入代码）');
    process.exit(CANNOT);
  }
  const hit = es.find((e) => e.name === entry);
  if (!hit) {
    if (entryLooksApkPath) {
      console.error('  ✗ 无法判定：--entry 写的是 APK 内路径（' + entry + '），不是 payload.zip 里的条目');
      console.error('     --zip 要收 payload.zip；APK 先抽出 assets/payload.zip 再传。');
      process.exit(CANNOT);
    }
    console.error('  ✗ payload 里没有这条：' + entry);
    console.error('     这不是"覆盖出问题"，是这条文件整体没进包。');
    process.exit(1);
  }
  // readZip 只给元信息（raw = 压缩字节），文本要用 readEntry 解压 —— 直接读 e.data 会拿到空内容，
  // 于是"注入丢了"变成假红（实测过一次，差点据此改坏 overlay）。
  let text;
  try {
    text = readEntry(zipFile, hit).toString('utf8');
  } catch (e) {
    console.error('✗ 无法判定：条目解不开（' + entry + '）：' + e.message);
    process.exit(CANNOT);
  }
  if (!text.trim()) {
    console.error('  ✗ 无法判定：条目解出来是空的（' + entry + '）');
    console.error('     判据对象为空 → 一次都没问到「注入在不在」，不是违规。');
    console.error('     多半是打进了空壳文件，或 zip 写入时数据没跟上。');
    process.exit(CANNOT);
  }
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
  console.error('      （--zip 收的是 payload.zip，不是 APK；APK 要先抽 assets/payload.zip）');
  process.exit(CANNOT);
}
if (!fs.existsSync(file)) {
  console.error('✗ 无法判定：文件不存在：' + file);
  process.exit(CANNOT);
}

let t = fs.readFileSync(file, 'utf8');
if (!t.trim()) {
  console.error('✗ 无法判定：文件是空的：' + file);
  process.exit(CANNOT);
}
if (judge(t, path.basename(file))) process.exit(0);

if (!FIX) {
  console.error('     修：node check-bg-injection.js "' + file + '" --fix');
  console.error('     （或从旧 APK 里把这份 client.js 捞回来）');
  process.exit(1);
}

// ── --fix：插入注入片段
const snippetFile = path.join(__dirname, 'bg-injection-snippet.js');
if (!fs.existsSync(snippetFile)) { console.error('✗ 缺少片段文件：' + snippetFile); process.exit(CANNOT); }
const snippet = fs.readFileSync(snippetFile, 'utf8');

// 片段本身必须满足收紧后的判据，否则 --fix 会把文件"修"成红（自测里有一条专门盯这个）。
if (!snippet.includes('/dsh-bg.css?rev=')) {
  console.error('✗ 片段与判据不一致：bg-injection-snippet.js 里没有 /dsh-bg.css?rev=');
  console.error('  --fix 修完还会是红。先修片段，别修文件。');
  process.exit(CANNOT);
}

// 找 `factory: (require) => {`（实际文件里是 tab 缩进的）
const anchor = /\n(\t*)factory: \(require\) => \{\n/;
if (!anchor.test(t)) {
  console.error('✗ 找不到插入锚点 factory: (require) => {');
  process.exit(CANNOT);
}
t = t.replace(anchor, (m, indent) => {
  const body = snippet.split('\n').map((l) => (l.length ? indent + l : l)).join('\n');
  return '\n' + indent + 'factory: (require) => {\n' + body;
});
fs.writeFileSync(file, t);
console.log('  ✅ 已补回背景图注入（原文件已改，建议 git diff 看一眼）');
