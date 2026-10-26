#!/usr/bin/env node
/**
 * strip-dist-payload.js —— 从**发行** payload 里剔除不该分发的东西
 * ============================================================================
 * 为什么必须有这一步：`selfbuild.sh payload` 是从**骨架 APK** 里解出 payload 的。
 * 如果骨架是你自己那台的快照，payload 里就带着个人内容 —— 2026-09-30 实测：
 *
 *   · dsh-bg-user.png（个人壁纸，1.4MB）           ← 隐私扫描抓到的
 *   · dshhome/profiles/web/package.json 里的
 *     link:/sdcard/Download/<私人目录>/...       ← 指向开发者私人路径
 *
 * 出包脚本只把壁纸从 **overlay** 挪走，管不到**从骨架解出来的那份**。
 * 所以这里直接对 payload.zip 动手：删条目 —— 而不是"指望上游没带进来"。
 *
 * 用法：
 *   node strip-dist-payload.js <payload.zip>              # 就地剔除
 *   node strip-dist-payload.js <payload.zip> --check-only # 只报告，不改
 * 退出码：0 = 干净（或已修好）；1 = --check-only 且发现不该有的
 */
const fs = require('fs');
const path = require('path');
const { readZip, writeZip } = require(path.join(__dirname, '..', 'lib', 'ziptool.js'));

const zip = process.argv[2];
const checkOnly = process.argv.includes('--check-only');
if (!zip) { console.error('用法：node strip-dist-payload.js <payload.zip> [--check-only]'); process.exit(1); }

// 发行包里绝不该出现的东西
const BAD = [
  [/dsh-web-frontend\/dist\/dsh-bg-user\.(png|jpe?g|webp)$/i, '个人壁纸'],
  [/whale-shota\/(assets|preview)\//i, '桌宠源图/预览'],
  [/archive-2\.5d\/layers\//i, '派生美术'],
  [/MainActivity\.java\.(bak|pre-lan)/i, '源码备份'],
  [/\.(keystore|p12|pfx)$/i, '签名钥匙'],
  // 开发备份不属于运行内容；overlay 里出现 .bak-* / *.bak / *.orig 时也不能带进发行包。
  [/(?:\.bak(?:[.-]|$)|\.orig$)/i, '开发备份'],
  [/(^|\/)AGENTS\.md$/i, '全局指令'],
  [/(^|\/)\.credentials/i, '登录凭据'],
  [/sessions\/session-|session\.v4\.jsonl/i, '会话数据'],
  // 会审配置（监控站地址 / 默认通道）属个人数据，
  // 它住在 dshhome 根下 —— 别指望"它不在 overlay 里"这种运气。
  [/(^|\/)review\.json(\..*)?$/i, '本机会审配置'],
  [/(^|\/)skills-local\//i, '本机私有技能'],
  // 2026-10-15：dshhome 下**只允许**「可分发的种子」——与 scan-dist-privacy.py 的白名单
  // （skills / cordis.patch.yml / profiles）保持一致。骨架解出来的那份 settings.yaml 是
  // 开发机自己的状态（ui-conversation / ui-onboarding），发给新用户会让对方**跳过首次引导**，
  // 而且它属于「用户文件」（App 只在缺失时写入），本来就不该随包。
  [/(^|\/)dshhome\/settings\.yaml$/i, '个人设置（非可分发种子）'],
  // 白名单要约束底包，不只是 overlay：model-roles.json 等后增个人配置同样不能随包。
  [/^dshhome\/(?!(?:skills|cordis\.patch\.yml|profiles)(?:\/|$))[^/]+(?:\/|$)/i, '非可分发 dshhome 种子'],
  // 2026-10-15：第三方 changelog 是纯死重量（30 份 ≈ 830KB），
  // 更是隐私扫描**假阳性**的来源：上游 changelog 里 40 位 commit SHA 会命中
  // 11 位手机号正则，dependabot 的 @users.noreply.github.com 会命中邮箱正则。
  // 要留下的只有我们自己的那两份应用内更新日志（见下面 KEEP）。
  [/(^|\/)node_modules\/.*CHANGELOG\.md$/i, '第三方 changelog'],
];

// 例外白名单：这两份 CHANGELOG 是**我们自己的**应用内更新日志，必须随包分发，
// 而且用户界面里能直接打开 /CHANGELOG.md（见 MainActivity 的 FORCE_OVERWRITE_PREFIXES）。
// 它们都住在 node_modules 下 → 会被上面那条第三方 changelog 规则命中，所以先放行。
const KEEP = new Set([
  'dshroot/CHANGELOG.md',
  'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/CHANGELOG.md',
]);
const matchBad = (name) => (KEEP.has(name) ? null : BAD.find(([re]) => re.test(name)) || null);

const es = readZip(zip);
const hits = es.filter((e) => matchBad(e.name));

if (!hits.length) { console.log('  ✓ payload 干净（没有个人内容条目）'); process.exit(0); }

if (checkOnly) {
  console.log(`  ❌ payload 里有 ${hits.length} 个不该分发的条目：`);
  for (const e of hits) console.log('     - ' + e.name);
  process.exit(1);
}

const keep = es.filter((e) => !matchBad(e.name));
const tmp = zip + '.strip-tmp';
writeZip(keep, tmp);
fs.renameSync(tmp, zip);

console.log(`  ✓ 已从发行 payload 剔除 ${hits.length} 个条目（${es.length} → ${keep.length}）：`);
for (const e of hits) {
  const why = (matchBad(e.name) || [])[1] || '';
  console.log(`     - ${e.name}   [${why}]`);
}
