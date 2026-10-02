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
  [/(^|\/)AGENTS\.md$/i, '全局指令'],
  [/(^|\/)\.credentials/i, '登录凭据'],
  [/sessions\/session-|session\.v4\.jsonl/i, '会话数据'],
  // 会审配置（监控站地址 / 默认通道）属个人数据，
  // 它住在 dshhome 根下 —— 别指望"它不在 overlay 里"这种运气。
  [/(^|\/)review\.json(\..*)?$/i, '本机会审配置'],
  [/(^|\/)skills-local\//i, '本机私有技能'],
];

const es = readZip(zip);
const hits = es.filter((e) => BAD.some(([re]) => re.test(e.name)));

if (!hits.length) { console.log('  ✓ payload 干净（没有个人内容条目）'); process.exit(0); }

if (checkOnly) {
  console.log(`  ❌ payload 里有 ${hits.length} 个不该分发的条目：`);
  for (const e of hits) console.log('     - ' + e.name);
  process.exit(1);
}

const keep = es.filter((e) => !BAD.some(([re]) => re.test(e.name)));
const tmp = zip + '.strip-tmp';
writeZip(keep, tmp);
fs.renameSync(tmp, zip);

console.log(`  ✓ 已从发行 payload 剔除 ${hits.length} 个条目（${es.length} → ${keep.length}）：`);
for (const e of hits) {
  const why = (BAD.find(([re]) => re.test(e.name)) || [])[1] || '';
  console.log(`     - ${e.name}   [${why}]`);
}
