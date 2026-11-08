#!/usr/bin/env node
'use strict';
/**
 * 重建 checks.manifest 的 md5 —— 只允许动 md5，别的列一个字都不许丢。
 *
 * 用法:
 *   node gen-manifest.js <payloadDir> <manifestPath>            # 刷新 md5（默认，会写文件）
 *   node gen-manifest.js --check <payloadDir> <manifestPath>    # 只体检不写：清单本身是否自洽
 *
 * 清单行格式（升级版，向后兼容老的三列）：
 *     <payload 相对路径>|<md5>|<关键字>|<policy all|local>|<丢了这个词等于什么功能没了>|<最低命中次数>
 *
 * 为什么不能再「只更新 md5」就完事：
 *   1. 老版本 regen 只写回 `路径|md5|关键字` 三列 —— 会把 `local` 策略列**静默吃掉**，
 *      于是一份该被发行包剔除的私人文件，regen 一次就变成必须存在，发行出包直接假失败。
 *   2. md5 自己比自己是最危险的：文件被换成一整代旧包（296 那次白屏）时，regen 会把
 *      错误文件的 md5 恭恭敬敬记成新基线，从此这道门禁专门替坏文件作证。
 *   3. 所以现在把「关键字必须命中几次」也记进清单（第 6 列），regen 只准刷新 md5：
 *      关键字命中次数**下降或归零 → 直接报错退出、一个字节都不写**。
 *      次数上升不拦（同一个词合法地多出现一次），但会打一行提示，让人自己决定要不要抬门槛。
 *
 * 退出码: 0 正常 / 2 用法或体检不通过 / 3 拒绝写入（关键字退化）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const countOf = (buf, kw) => (kw && kw !== '-' ? buf.toString('utf8').split(kw).length - 1 : 0);

const argv = process.argv.slice(2);
const checkOnly = argv[0] === '--check';
const [dir, manifestPath] = checkOnly ? argv.slice(1) : argv;
if (!dir || !manifestPath) {
  console.error('用法: gen-manifest.js [--check] <payloadDir> <manifestPath>');
  process.exit(2);
}

const oldText = fs.readFileSync(manifestPath, 'utf8');
const out = [];
let changed = 0, missing = 0, bootstrapped = 0, raised = 0, bad = [], refused = [];

for (const raw of oldText.split('\n')) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) { out.push(raw); continue; }
  const cols = line.split('|').map((s) => (s || '').trim());
  const rel = cols[0];
  const prevMd5 = cols[1] || '-';
  const keyword = cols[2] || '';
  const policy = cols[3] || 'all';
  const why = cols[4] || '';
  const kwMinRaw = cols[5];
  if (cols.length > 6) bad.push(`${rel}: 列数 ${cols.length} > 6，多出来的字段没人认（是不是路径里写了 | ？）`);
  if (!['all', 'local'].includes(policy)) bad.push(`${rel}: policy「${policy}」不认识（只能是 all / local）`);
  if (!keyword) bad.push(`${rel}: 关键字那列是空的 —— 要么写一个能证明语义还在的词，要么写 - 并在说明列写清为什么不需要`);
  if (keyword === '-' && !why) bad.push(`${rel}: 关键字是 -（不做语义校验），说明列必须写清为什么不校验`);

  const f = path.join(dir, rel);
  const exists = fs.existsSync(f);
  if (!exists) {
    missing++;
    if (!checkOnly) console.log(`  ⚠ 缺失，原样保留: ${rel}`);
    out.push([rel, prevMd5, keyword, policy, why, kwMinRaw || ''].join('|').replace(/\|+$/, ''));
    continue;
  }
  const buf = fs.readFileSync(f);
  const now = md5(buf);
  const kwCount = countOf(buf, keyword);
  // 第 6 列是最低命中次数。老清单没有这一列 → 用当前实测值打底（只记账，不算退化）。
  let kwMin = kwMinRaw === undefined || kwMinRaw === '' ? null : parseInt(kwMinRaw, 10);
  if (kwMin === null) {
    kwMin = kwCount;
    bootstrapped++;
    console.log(`  + ${rel}: 首次登记关键字下限 = ${kwMin}（「${keyword}」）`);
  }
  if (keyword !== '-' && kwCount < kwMin) {
    refused.push(`${rel}\n      关键字「${keyword}」现在只命中 ${kwCount} 次，清单要求 ≥${kwMin} 次${policy === 'local' ? '（policy=local）' : ''}`);
  }
  if (kwCount > kwMin && keyword !== '-') {
    raised++;
    console.log(`  ↑ ${rel}: 关键字「${keyword}」命中 ${kwCount} 次 > 门槛 ${kwMin}，门槛不动（想抬自己改第 6 列）`);
  }
  if (now !== prevMd5 && !checkOnly) { changed++; console.log(`  ↻ ${rel}\n      ${prevMd5} → ${now}`); }
  out.push(`${rel}|${now}|${keyword}|${policy}|${why}|${kwMin}`);
}

if (bad.length) {
  console.error(`✗ 清单自身不合法（${bad.length} 处）：\n    ${bad.join('\n    ')}`);
  process.exit(2);
}
if (refused.length) {
  console.error(`✗ 拒绝刷新 md5：${refused.length} 个文件的关键字退化，说明补丁语义已经不在了。一个字节都没写。\n    ${refused.join('\n    ')}\n` +
    `  这不是「清单过期」——是那个词在目标文件里真的没了。先查清为什么，别降门槛绕过。\n` +
    `  确实要作废某个补丁：把该行的关键字改成 - 并在说明列写清理由（这一步必须有人签字）。`);
  process.exit(3);
}
if (checkOnly) {
  console.log(`✓ 清单体检通过（${out.filter((l) => l && !l.startsWith('#')).length} 条）`);
  process.exit(0);
}
const next = out.join('\n');
// 定身点自检：拿刚落盘的内容再算一遍，md5 必须和刚写进去的一致（否则下一次 regen 会无端抖动）
let flaky = [];
for (const raw of next.split('\n')) {
  const s = raw.trim();
  if (!s || s.startsWith('#')) continue;
  const [rel, want] = s.split('|');
  const f = path.join(dir, rel);
  if (!fs.existsSync(f)) continue;
  if (md5(fs.readFileSync(f)) !== (want || '').trim()) flaky.push(rel);
}
if (flaky.length) {
  console.error(`✗ 写完后复核 md5 不一致（${flaky.length} 条），没落盘：\n    ${flaky.join('\n    ')}`);
  process.exit(3);
}
fs.writeFileSync(manifestPath, next);
console.log(`✓ 已更新 ${manifestPath}（md5 变更 ${changed}，缺失 ${missing}，新登记下限 ${bootstrapped}，命中多于门槛 ${raised}）`);
