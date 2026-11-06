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
function main(argv) {
  const arg = k => { const i = argv.indexOf('--' + k); return i < 0 ? undefined : argv[i + 1]; };
  const rows = scanOut();
  const maxCode = rows.reduce((m, r) => Math.max(m, r.code), 0);
  const declared = readDeclared();
  // 发行包用 --current：它发的是「已经自用装过的那一版」，号取这个版本名已出的最大值，
  // 不再往上加 —— 自用即对外，同一个号。没出过这个版本才退化成 max+1（首包）。
  if (argv.includes('--current')) {
    const same = rows.filter(r => r.name === declared.name).map(r => r.code);
    console.log(`name=${declared.name}\ncode=${same.length ? Math.max(...same) : maxCode + 1}`);
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
  // --plan 给出「这次要写进包里的 name/code」，调用方（selfbuild.sh / release.sh）照抄；
  // 不带 --plan 只当闸门用，打一行人看的结论。
  if (argv.includes('--plan')) console.log(`name=${name}\ncode=${code}`);
  else if (sameCodes.includes(code)) console.log(`✓ 版本闸门通过：${name}(${code})，这个版本已出过包，沿用同一个号`);
  else console.log(`✓ 版本闸门通过：${name}(${code}) > 本机最大 ${maxCode}`);
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try { main(process.argv.slice(2)); } catch (e) { console.error('✗ ' + e.message); process.exitCode = 1; }
}
