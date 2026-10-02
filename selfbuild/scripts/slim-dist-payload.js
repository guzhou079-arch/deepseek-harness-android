#!/usr/bin/env node
/**
 * slim-dist-payload.js —— 发行 payload 瘦身：把 runtime/lib 下的**重复副本**换成 LINKS.txt 声明
 * ============================================================================
 * 为什么需要（2026-10-02 实测）：
 *   本机自建链的 payload 里，同一份 .so 会以**多个真文件**存在：
 *     runtime/lib/libicudata.so / libicudata.so.78 / libicudata.so.78.3  ← 三份各 33MB！
 *   实测本地包 payload 比 v1.29 发行包多 **90MB 原始 / ≈37MB 落盘**，几乎全是这类副本。
 *   而 App 早就会按 payload/runtime/lib/LINKS.txt 在解压后自己建硬链接/软链接
 *   （MainActivity.applyLinks：Os.link → symlink → copyFile 三级兜底）。
 *   → 发行包里**只需要一份真文件 + LINKS.txt 一行声明**。
 *
 * 已发布 v1.29 就是这个形状（LINKS.txt 815B / 26 条，无副本），所以本步是"回到已验证的发行形状"。
 *
 * 规则（保守，只做字节相同的整份副本）：
 *   1. 只看 runtime/lib/ 下的条目；
 *   2. 内容**逐字节相同**的分到一组；组内 **取名字最长的那份当真身**（.78.3 比 .78 比 .so 长）；
 *   3. 其余条目删除，并在 LINKS.txt 里写 `<别名>\t<真身>`；
 *   4. LINKS.txt 重新生成：保留仍然有效的旧行 + 新行，按别名排序；目标文件必须真实存在。
 *
 * 用法：
 *   node slim-dist-payload.js <payload.zip>              # 就地瘦身，打印省了多少
 *   node slim-dist-payload.js <payload.zip> --check-only # 只报告（有副本就 exit 1）
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readZip, writeZip } = require(path.join(__dirname, '..', 'lib', 'ziptool.js'));

const zipPath = process.argv[2];
const checkOnly = process.argv.includes('--check-only');
if (!zipPath) { console.error('用法：node slim-dist-payload.js <payload.zip> [--check-only]'); process.exit(1); }

const LIB = 'runtime/lib/';
const LINKS = LIB + 'LINKS.txt';
const raw = (e) => (e.method === 0 ? e.raw : require('zlib').inflateRawSync(e.raw));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

const es = readZip(zipPath);
const libEntries = es.filter((e) => e.name.startsWith(LIB) && !e.name.endsWith('/') && e.name !== LINKS);

// 按内容分组
const groups = new Map();
for (const e of libEntries) {
  const h = md5(raw(e));
  if (!groups.has(h)) groups.set(h, []);
  groups.get(h).push(e);
}

const drop = new Map();   // 别名（不含目录） → 真身（不含目录）
let saved = 0;
for (const [, g] of groups) {
  if (g.length < 2) continue;
  const names = g.map((e) => e.name.slice(LIB.length));
  const target = names.slice().sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
  for (const e of g) {
    const n = e.name.slice(LIB.length);
    if (n === target) continue;
    drop.set(n, target);
    saved += e.usize ?? e.raw.length;
  }
}

if (!drop.size) { console.log('  ✓ payload 没有可瘦身的重复副本（runtime/lib 已是声明式）'); process.exit(0); }

if (checkOnly) {
  console.log(`  ❌ runtime/lib 下有 ${drop.size} 份重复副本（共 ${(saved / 1048576).toFixed(1)}MB）：`);
  for (const [a, t] of drop) console.log(`     - ${a}  ==  ${t}`);
  process.exit(1);
}

// 重新生成 LINKS.txt：旧行（目标仍在）+ 新行，按别名排序
const keep = new Set(es.map((e) => e.name));
const finalNames = new Set([...keep].filter((n) => !(n.startsWith(LIB) && drop.has(n.slice(LIB.length)))));

// ⚠️ 链条解析（防连锁断链）：
//   旧 LINKS.txt 里可能有 `A → B`，而这一轮 B 又被判定成 C 的副本（B 被删）。
//   若只按「目标不存在就丢行」处理，A 这条声明会被扔掉 → **A 也失去链接**（连锁断链）。
//   正确做法：跟着 drop 表把目标一路追到最终真身，写成 `A → C`。
const resolve = (t) => {
  const seen = new Set();
  while (drop.has(t) && !seen.has(t)) { seen.add(t); t = drop.get(t); }
  return t;
};

const links = new Map();
if (keep.has(LINKS)) {
  for (const line of raw(es.find((e) => e.name === LINKS)).toString('utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const [a, t] = s.split(/\t+/);
    if (a && t) links.set(a.trim(), t.trim());
  }
}
for (const [a, t] of drop) links.set(a, t);
const rewritten = [];
for (const [a, t0] of [...links]) {
  const t = resolve(t0);
  if (t !== t0) rewritten.push(`${a}: ${t0} → ${t}`);
  links.set(a, t);
}
// 目标必须真实存在、且不能自指（否则那行是坏链接，别写进包里）
for (const [a, t] of [...links]) {
  if (a === t) { links.delete(a); continue; }
  if (!finalNames.has(LIB + t)) { links.delete(a); console.log(`     ⚠ LINKS.txt 丢弃无效行：${a} → ${t}（目标不在包里）`); }
}
// 头部注释（App 的 applyLinks 会跳过 # 行）：把「谁是真身」的规则写在包的原地
const HEADER = '# 真身选取规则：同字节组内取名字最长者；删掉「名字长」的那个会断链。\n';
const linksText = HEADER + [...links.entries()].sort((x, y) => x[0].localeCompare(y[0]))
  .map(([a, t]) => `${a}\t${t}`).join('\n') + '\n';
if (rewritten.length) { console.log(`     ↻ 链条重写 ${rewritten.length} 条（避免连锁断链）：`); for (const r of rewritten) console.log('        ' + r); }

// 写回：删副本 + 换 LINKS.txt
const out = [];
let wroteLinks = false;
for (const e of es) {
  const n = e.name;
  if (n === LINKS) { out.push({ name: LINKS, data: Buffer.from(linksText, 'utf8') }); wroteLinks = true; continue; }
  if (n.startsWith(LIB) && drop.has(n.slice(LIB.length))) continue;
  out.push(e);
}
if (!wroteLinks) out.push({ name: LINKS, data: Buffer.from(linksText, 'utf8') });

const tmp = zipPath + '.slim-tmp';
writeZip(out, tmp);
const before = fs.statSync(zipPath).size;
fs.renameSync(tmp, zipPath);

console.log(`  ✓ 发行 payload 瘦身：${es.length} → ${out.length} 条目，删掉 ${drop.size} 份重复副本`);
console.log(`     原始数据省 ${(saved / 1048576).toFixed(1)}MB；payload 落盘 ${(before / 1048576).toFixed(1)}MB → ${(fs.statSync(zipPath).size / 1048576).toFixed(1)}MB`);
console.log(`     LINKS.txt：${links.size} 条声明（App 解压后会自己建链接）`);
