#!/usr/bin/env node
// 版本号闸门：版本名只有一处真相（selfbuild/VERSION 第一行），versionCode 由本机出过的包推算。
// 出包前跑 --check；人手传的号只要倒退、重号，立刻停。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const sb = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readZip, readEntry } = require('../lib/ziptool.js');
const { describeManifest } = require('../lib/android-manifest.js');
const VERSION_FILE = path.join(sb, 'VERSION');
const OUT = path.join(sb, 'out');
const LEDGER = path.join(OUT, 'EMITTED-CODES.txt');

function readApkVersion(apk) {
  const entries = readZip(apk);
  const entry = entries.find(x => x.name === 'AndroidManifest.xml');
  if (!entry) return null;
  const d = describeManifest(readEntry(apk, entry));
  return { name: d.versionName, code: Number(d.versionCode) };
}
export function scanOut(dir = OUT) {
  const rows = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.apk')) continue;
    try {
      const v = readApkVersion(path.join(dir, f));
      if (v && v.code) rows.push({ file: f, ...v });
    } catch { /* 半截包/非本项目的包跳过，不因为没有清单就拦路 */ }
  }
  return rows;
}
export function readDeclared() {
  const lines = fs.readFileSync(VERSION_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
  const name = lines[0];
  if (!/^[0-9]+(\.[0-9]+)*$/.test(name || '')) throw new Error('VERSION 第一行必须是 X.Y[.Z]：' + JSON.stringify(name));
  return { name };
}
export function compareVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}
// ── 已发货台账 ────────────────────────────────────────────────────────────────
// 为什么不能只靠 out/ 推号：297 是手工 repack 的，从没进过 out/，脚本看不见它；
// 295 进过 out/ 又作废，留着就会被当成「本机最大号」。所以发过的号单独记在
// out/EMITTED-CODES.txt，下界只按「已发」算，未发/作废的号占位但不动下界。
const STATUSES = new Set(['已发', '未发', '作废']);
export function readLedger(file = LEDGER) {
  const rows = [];
  if (!fs.existsSync(file)) return { rows, maxShipped: 0, file };
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [codeS, name, status, ...rest] = line.split(/\s+/);
    const code = Number(codeS);
    if (!Number.isInteger(code) || code <= 0) throw new Error(`EMITTED-CODES 行首必须是 versionCode：${line}`);
    if (!/^[0-9]+(\.[0-9]+)*$/.test(name || '')) throw new Error(`EMITTED-CODES 第二列必须是版本名：${line}`);
    if (!STATUSES.has(status)) throw new Error(`EMITTED-CODES 第三列只能是 已发/未发/作废，实际是「${status}」：${line}`);
    rows.push({ code, name, status, note: rest.join(' ') });
  }
  const shipped = rows.filter(r => r.status === '已发');
  return { rows, maxShipped: shipped.reduce((m, r) => Math.max(m, r.code), 0), file };
}
// dist 出包成功后由 make-dist-apk.sh 调用：把这一版记成「已发」。
// 台账里已经有同号同名且还是「未发」的就地升级，不重复加行。
// file 参数只为自测能指向临时台账 —— 上次测试就是漏了它，直接写脏了真台账。
export function appendShipped(name, code, note, file = LEDGER) {
  const led = readLedger(file);
  const { rows, maxShipped } = led;
  const hit = rows.find(r => r.code === code && r.name === name);
  if (hit && hit.status === '已发') return { file: led.file, action: 'already', row: hit };
  // 记一笔之前先复核：作废号不许升级成已发，低于下界的号不许被记成发过。
  // 这两道不是重复 version-check，是防止绕过闸门的路径把台账写脏 —— 台账一旦脏，下界就废了。
  if (hit && hit.status === '作废') {
    throw new Error(`versionCode ${code}（${name}）台账里标着「作废」（${hit.note}），不能记成已发`);
  }
  // 要记的号必须严格大于已发货的最大号 —— 等于也不行（那要么是撞号，要么是同一版重发，
  // 同一版重发在上面 already 那行就返回了）。少了这一条，296 这种「未发」行会被就地升成「已发」，
  // 下界当场被拉低，台账就废了（这条是自测里真抓到的）。
  if (code <= maxShipped) {
    const top = rows.filter(r => r.status === '已发').sort((a, b) => b.code - a.code)[0];
    throw new Error(`要记的 ${code}（${name}）不大于已发货下界 ${maxShipped}（${top.code} = ${top.name}）—— 撞号或太低，这个号不可能真发出去，别写进台账`);
  }
  if (hit) {
    hit.status = '已发';
    if (note) hit.note = note;
  } else {
    rows.push({ code, name, status: '已发', note: note || '' });
  }
  rows.sort((a, b) => b.code - a.code);
  const comments = fs.readFileSync(led.file, 'utf8').split('\n').filter(l => l.trim().startsWith('#'));
  fs.writeFileSync(led.file, [...comments, ...rows.map(r => `${r.code} ${r.name} ${r.status} ${r.note}`.trimEnd())].join('\n') + '\n');
  return { file: led.file, action: hit ? 'upgraded' : 'added', row: rows.find(r => r.code === code && r.name === name) };
}
// 号的两个下界：本机出过（out/），和真发出去过（台账）。两个都要过。
export function gateShippedFloor(code, name, file = LEDGER) {
  const { rows, maxShipped } = readLedger(file);
  if (!rows.length) return;
  const rec = rows.find(r => r.code === code && r.name === name);
  if (rec && rec.status === '作废') {
    throw new Error(`versionCode ${code}（${name}）在台账里标着「作废」：${rec.note}。作废号不得重用，换一个号`);
  }
  if (code > maxShipped) return;
  if (rec && rec.status === '已发' && code === maxShipped) return; // 同一版重发，允许
  const top = rows.filter(r => r.status === '已发').sort((a, b) => b.code - a.code)[0];
  throw new Error(
    `versionCode ${code} 不大于已发货的下界 ${maxShipped}（${top.code} = ${top.name}：${top.note}）。` +
    `装了 ${top.code} 的用户装不上比你号小的包 —— 对外号必须 > ${maxShipped}`);
}
function main(argv) {
  const arg = k => { const i = argv.indexOf('--' + k); return i < 0 ? undefined : argv[i + 1]; };
  const rows = scanOut();
  const maxCode = rows.reduce((m, r) => Math.max(m, r.code), 0);
  const declared = readDeclared();
  // 发行包用 --current：它发的是「已经自用装过的那一版」，号取这个版本名已出的最大值，
  // 不再往上加 —— 自用即对外，同一个号。没出过这个版本才退化成 max+1（首包）。
  const ledger = readLedger();
  // 出包前先记一笔：本版本名已经发过的号不上抬，但作废号不许沿用、也不许低于已发货下界
  if (argv.includes('--emit-shipped')) {
    const name = arg('name') || declared.name;
    const code = Number(arg('code') ?? rows.filter(r => r.name === name).reduce((m, r) => Math.max(m, r.code), 0));
    if (!Number.isInteger(code) || code <= 0) throw new Error('--emit-shipped 需要 --code <号>（或本版本名已出过包）');
    const r = appendShipped(name, code, arg('note'));
    console.log(`✓ 已记入台账：${name}(${code}) → ${r.action}  ${r.file}`);
    return;
  }
  if (argv.includes('--current')) {
    const banned = new Set(ledger.rows.filter(r => r.status === '作废').map(r => r.code));
    const cand = rows.filter(r => r.name === declared.name).map(r => r.code).filter(c => !banned.has(c));
    const preferred = cand.length ? Math.max(...cand) : 0;
    // 沿用本版本的号（自用即对外）；作废号或低于已发货下界的号一律重造，免得发出装不上的包
    const code = preferred && preferred >= ledger.maxShipped ? preferred : Math.max(ledger.maxShipped, maxCode) + 1;
    console.log(`name=${declared.name}\ncode=${code}`);
    return;
  }
  // 发行包用 --dist：dist 不是新版本，它发的是「已经自用装过的那一版」，
  // 名字必须跟 VERSION 一致、code 必须复用那个已出的号，不许自己再编一个。
  if (argv.includes('--dist')) {
    const same = rows.filter(r => r.name === declared.name).map(r => r.code);
    const name0 = arg('name') || declared.name;
    if (compareVersion(name0, declared.name) !== 0) {
      throw new Error(`发行包版本名 ${name0} 与 selfbuild/VERSION 的 ${declared.name} 不一致`);
    }
    if (!same.length) throw new Error(`本机还没出过 ${declared.name} 的包；dist 只能发已出自用包的那一版`);
    const code0 = Math.max(...same);
    if (arg('code') !== undefined && Number(arg('code')) !== code0) {
      throw new Error(`发行包必须复用 ${declared.name} 已出的 versionCode ${code0}，你给的是 ${arg('code')}`);
    }
    gateShippedFloor(code0, name0);
    console.log(`✓ 发行包版本一致：${name0}(${code0})`);
    return;
  }
  const sameCodes = rows.filter(r => r.name === declared.name).map(r => r.code);
  // 一个版本名只对应一个 versionCode：这个号已经出过包就沿用，不往上加。
  // 想涨 code 只有一条路 —— 先改 selfbuild/VERSION 的版本名。
  const autoCode = sameCodes.length ? Math.max(...sameCodes) : maxCode + 1;
  const code = Number(arg('code') || autoCode);
  const name = arg('name') || declared.name;
  if (!Number.isInteger(code) || code <= 0) throw new Error('versionCode 必须是正整数');
  if (compareVersion(name, declared.name) !== 0) {
    throw new Error(`版本名 ${name} 与 selfbuild/VERSION 的 ${declared.name} 不一致；改号先改那个文件`);
  }
  if (!sameCodes.includes(code) && code <= maxCode) {
    const worst = rows.filter(r => r.code >= code).sort((a, b) => b.code - a.code).slice(0, 3)
      .map(r => `${r.name}(${r.code})`).join(', ');
    throw new Error(`versionCode ${code} 不大于本机已出的最大 ${maxCode}；撞号或倒退：${worst}`);
  }
  gateShippedFloor(code, name);
  // --plan 给出「这次要写进包里的 name/code」，调用方（selfbuild.sh / release.sh）照抄；
  // 不带 --plan 只当闸门用，打一行人看的结论。
  if (argv.includes('--plan')) console.log(`name=${name}\ncode=${code}`);
  else if (sameCodes.includes(code)) console.log(`✓ 版本闸门通过：${name}(${code})，这个版本已出过包，沿用同一个号`);
  else console.log(`✓ 版本闸门通过：${name}(${code}) > 本机最大 ${maxCode}`);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (e) { console.error('✗ ' + e.message); process.exitCode = 1; }
}
