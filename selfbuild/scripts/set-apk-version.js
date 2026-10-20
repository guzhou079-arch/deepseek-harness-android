#!/usr/bin/env node
'use strict';
// Patch only binary AndroidManifest.xml; keep all other ZIP entries raw.
const fs = require('node:fs');
const path = require('node:path');
const { readZip, readEntry, writeZip } = require('../lib/ziptool.js');
const { patchManifest, describeManifest } = require('../lib/android-manifest.js');
// 自建包沿用旧骨架 APK 的清单，骨架里没有 RECORD_AUDIO（源码清单里其实早就声明了），
// 于是装机版永远拿不到麦克风：checkSelfPermission 恒为拒绝，requestPermissions 静默不弹窗，
// 听写永远停在「等待麦克风权限」。每次出包补上，别再让它漏。
const BASELINE_PERMISSIONS = ['android.permission.RECORD_AUDIO'];
function main(args) {
  const input = args[0];
  const get = key => { const i = args.indexOf(key); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) throw new Error('Missing value: ' + key); return v; };
  if (!input || input.startsWith('--')) throw new Error('Usage: set-apk-version.js in.apk out.apk --name 1.38 --code 70 --share-target com.deepseek.harness.MainActivity | in.apk --dump [--json]');
  const dump = args.includes('--dump');
  const entries = readZip(input, { load: !dump });
  const manifest = entries.filter(e => e.name === 'AndroidManifest.xml');
  if (manifest.length !== 1) throw new Error('APK needs exactly one AndroidManifest.xml');
  const original = readEntry(input, manifest[0]);
  if (dump) { const summary = describeManifest(original); console.log(args.includes('--json') ? JSON.stringify(summary, null, 2) : JSON.stringify(summary, null, 2)); return; }
  const output = args[1];
  if (!output || output.startsWith('--') || path.resolve(output) === path.resolve(input)) throw new Error('Use a separate output APK');
  const name = get('--name'), code = get('--code');
  const share = args.indexOf('--share-target');
  const target = share < 0 ? undefined : args[share + 1] && !args[share + 1].startsWith('--') ? args[share + 1] : 'com.deepseek.harness.MainActivity';
  if (name === undefined && code === undefined && !target) throw new Error('No patch requested');
  if (code !== undefined && !/^[1-9][0-9]*$/.test(code)) throw new Error('Invalid --code');
  const changed = patchManifest(original, { versionName: name, versionCode: code === undefined ? undefined : Number(code), shareTarget: target, permissions: BASELINE_PERMISSIONS });
  writeZip(entries.map(e => e === manifest[0] ? { name: e.name, data: changed, store: true } : e), output);
  const back = readZip(output, { load: false });
  const written = readEntry(output, back.find(e => e.name === 'AndroidManifest.xml'));
  if (!written.equals(changed)) throw new Error('Manifest ZIP readback mismatch');
  console.log(JSON.stringify(describeManifest(written), null, 2));
  console.log('Verified manifest:', output, fs.statSync(output).size, 'bytes');
}
if (require.main === module) { try { main(process.argv.slice(2)); } catch (e) { console.error('✗ ' + e.message); process.exitCode = 1; } }
module.exports = { main };
