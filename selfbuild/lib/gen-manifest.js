#!/usr/bin/env node
'use strict';
/**
 * 重建 checks.manifest 的 md5（保留原有文件清单与关键字）。
 * 用于「故意升级了某个补丁文件 / 换了内核基线」之后刷新基线。
 *
 * 用法: node gen-manifest.js <payloadDir> <manifestPath>
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [dir, manifestPath] = process.argv.slice(2);
if (!dir || !manifestPath) { console.error('用法: gen-manifest.js <payloadDir> <manifestPath>'); process.exit(2); }

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const old = fs.readFileSync(manifestPath, 'utf8').split('\n');
const out = [];
let changed = 0, missing = 0;

for (const raw of old) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) { out.push(raw); continue; }
  const [rel, prevMd5, keyword] = line.split('|').map((s) => (s || '').trim());
  const f = path.join(dir, rel);
  if (!fs.existsSync(f)) { missing++; console.log(`  ⚠ 缺失，原样保留: ${rel}`); out.push(raw); continue; }
  const buf = fs.readFileSync(f);
  const now = md5(buf);
  const kwHit = keyword && keyword !== '-' ? buf.toString('utf8').split(keyword).length - 1 : -1;
  if (now !== prevMd5) { changed++; console.log(`  ↻ ${rel}\n      ${prevMd5} → ${now}`); }
  if (kwHit === 0) console.log(`  ⚠ ${rel}: 关键字「${keyword}」在目标文件里为 0 次，仍记录 md5`);
  out.push(`${rel}|${now}|${keyword}`);
}

fs.writeFileSync(manifestPath, out.join('\n'));
console.log(`✓ 已更新 ${manifestPath}（变更 ${changed}，缺失 ${missing}）`);
