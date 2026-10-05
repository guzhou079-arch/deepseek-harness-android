#!/usr/bin/env node
'use strict';
/**
 * DSH Android 自构建工具 —— 不需要 aapt2 / zipalign。
 *
 * 原理：复用「已装机 APK」的骨架（AndroidManifest.xml / resources.arsc / res/ / classes.dex），
 * 只替换 assets/payload.zip（引擎侧，STORE 存储）与可选的 classes.dex（App 侧 Java）。
 * 资源不动 → 不需要 aapt2；签名用 apksigner（见 selfbuild.sh）。
 *
 * 子命令：
 *   payload-extract <apk> <out.zip>
 *   payload-patch   <in.zip> <out.zip> <overlayDir>       # overlay 目录按 payload 相对路径覆盖
 *   apk-pack        <base.apk> <payload.zip> <out.apk> [--dex <classes.dex>] [--asset <本地文件>:<APK内条目>]
 *   check           <dir|zip> <manifest>                  # path|md5|keyword 行式校验
 *   inspect         <apk>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { readZip, writeZip } = require('./ziptool.js');

const ASSET = 'assets/payload.zip';

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const die = (m) => { console.error('✗ ' + m); process.exit(1); };
const log = (m) => console.log(m);

/** zip 条目取原始数据（method 0=store，8=deflate） */
function data(e) {
  if (e.method === 0) return e.raw;
  return zlib.inflateRawSync(e.raw);
}

function walk(dir, rel, map) {
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    const r = rel ? rel + '/' + n : n;
    const st = fs.statSync(f);
    if (st.isDirectory()) walk(f, r, map);
    else if (!/\.(md5|sha256|bak)$/.test(n)) map.set(r, fs.readFileSync(f));
  }
  return map;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'payload-extract') {
  const [apk, out] = args;
  const es = readZip(apk);
  const p = es.find((e) => e.name === ASSET);
  if (!p) die('APK 里没有 ' + ASSET);
  fs.writeFileSync(out, data(p));
  log(`✓ 导出 ${ASSET} → ${out}（${data(p).length} 字节，原 method=${p.method}）`);
}

else if (cmd === 'payload-patch') {
  const [zipIn, zipOut, overlay] = args;
  if (!overlay) die('用法: payload-patch <in.zip> <out.zip> <overlayDir>');
  const map = walk(overlay, '', new Map());
  log(`overlay 文件数: ${map.size}`);
  const es = readZip(zipIn);
  const names = new Set(es.map((e) => e.name));
  let rep = 0, add = 0;
  const missing = [];
  const out = es.map((e) => {
    if (map.has(e.name)) {
      const before = md5(data(e));
      const buf = map.get(e.name);
      log(`  替换 ${e.name}\n        ${before} → ${md5(buf)}（${buf.length} 字节）`);
      map.delete(e.name); rep++;
      return { name: e.name, data: buf };
    }
    return e;
  });
  for (const [name, buf] of map) {
    out.push({ name, data: buf, store: false }); add++;
    log(`  新增 ${name}`);
  }
  // 保险：overlay 里形如 <pkg>/lib/index.js 但 payload 里不存在同名条目 → 必须报出来（打错路径会静默无效）
  if (missing.length) die('overlay 路径在 payload 中不存在: ' + missing.join(', '));
  writeZip(out, zipOut);
  log(`✓ 写出 ${zipOut}（替换 ${rep}，新增 ${add}，总条目 ${out.length}，${fs.statSync(zipOut).size} 字节）`);
}

else if (cmd === 'apk-pack') {
  const [base, payload, out] = args;
  const di = args.indexOf('--dex');
  const dexPath = di >= 0 ? args[di + 1] : null;
  // --asset <本地文件>:<APK 内条目名>（可重复）—— 替换 payload.zip / classes.dex 之外的 asset。
  // 为什么需要：pack 原本只换这两样，于是「虚拟屏核心 assets/vscreen_shizuku.jar」这类
  // 独立 asset，光改 Java 源码再 pack 也进不去包（2026-10-03 踩到，v143 差点白装）。
  const assetSpecs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--asset') {
      const v = args[i + 1] || '';
      const k = v.lastIndexOf(':');
      if (k <= 0) die('--asset 用法: <本地文件>:<APK 内条目名>');
      assetSpecs.push([v.slice(0, k), v.slice(k + 1)]);
    }
  }
  const pbuf = (!payload || payload === '-') ? null : fs.readFileSync(payload);
  const dbuf = dexPath ? fs.readFileSync(dexPath) : null;
  if (!pbuf && !dbuf && !assetSpecs.length) die('payload / --dex / --asset 至少要换一样');
  let hitP = 0, hitD = 0;
  const hitA = new Set();
  const es = readZip(base).map((e) => {
    const as = assetSpecs.find(([, name]) => name === e.name);
    if (as) {
      const buf = fs.readFileSync(as[0]);
      hitA.add(e.name);
      log(`  替换 ${e.name}: ${e.csize} → ${buf.length} 字节（来自 ${as[0]}）`);
      return { name: e.name, data: buf };
    }
    if (e.name === ASSET && pbuf) {
      hitP++;
      log(`  替换 ${ASSET}: ${e.csize} → ${pbuf.length} 字节（STORE）`);
      return { name: e.name, data: pbuf, store: true };
    }
    if (e.name === 'classes.dex' && dbuf) {
      hitD++;
      log(`  替换 classes.dex: ${e.csize} → ${dbuf.length} 字节（DEFLATE，原 usize=${e.usize}）`);
      return { name: e.name, data: dbuf };
    }
    return e;
  });
  if (pbuf && !hitP) die('骨架里没有 ' + ASSET);
  if (dbuf && !hitD) die('骨架里没有 classes.dex');
  for (const [src, name] of assetSpecs) if (!hitA.has(name)) die(`骨架里没有 ${name}（--asset ${src}）`);
  writeZip(es, out);
  log(`✓ 写出未签名 APK ${out}（${fs.statSync(out).size} 字节，条目 ${es.length}）`);
}

else if (cmd === 'dex-extract') {
  const [apk, out] = args;
  const e = readZip(apk).find((x) => x.name === 'classes.dex');
  if (!e) die('APK 里没有 classes.dex');
  const buf = data(e);
  fs.writeFileSync(out, buf);
  log(`✓ 导出 classes.dex → ${out}（${buf.length} 字节）`);
}

else if (cmd === 'check') {
  const [target, manifestPath] = args;
  if (!manifestPath) die('用法: check <dir|zip> <manifest>');
  const isZip = /\.zip$/i.test(target);
  let map = null;
  if (!isZip) {
    if (!fs.statSync(target).isDirectory()) die('目标既不是目录也不是 .zip: ' + target);
  } else {
    map = new Map();
    for (const e of readZip(target)) map.set(e.name, () => data(e));
  }
  const lines = fs.readFileSync(manifestPath, 'utf8').split('\n');
  let pass = 0, fail = 0, skip = 0;
  const fails = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [rel, wantMd5, keyword] = line.split('|').map((s) => (s || '').trim());
    let buf = null;
    if (isZip) {
      const hit = map.get(rel) || map.get(rel.replace(/^dshroot\//, 'dshroot/'));
      if (hit) buf = hit();
    } else {
      const f = path.join(target, rel);
      if (fs.existsSync(f)) buf = fs.readFileSync(f);
    }
    if (!buf) { fail++; fails.push(`${rel}\n    ✗ 文件不存在`); continue; }
    const got = md5(buf);
    const okMd5 = wantMd5 === '-' || !wantMd5 || got === wantMd5;
    let okKw = true, kwCount = 0;
    if (keyword && keyword !== '-') {
      kwCount = (buf.toString('utf8').split(keyword).length - 1);
      okKw = kwCount > 0;
    }
    if (okMd5 && okKw) { pass++; }
    else {
      fail++;
      const why = [];
      if (!okMd5) why.push(`md5 ${got} ≠ 期望 ${wantMd5}`);
      if (!okKw) why.push(`关键字「${keyword}」命中 0 次`);
      fails.push(`${rel}\n    ✗ ${why.join('；')}`);
    }
  }
  log(`检查 ${isZip ? 'zip' : '目录'}: ${target}`);
  for (const f of fails) log('  ' + f);
  log(`结果: ✅ ${pass} 通过  ❌ ${fail} 失败  (共 ${pass + fail})`);
  process.exit(fail ? 1 : 0);
}

else if (cmd === 'inspect') {
  const [apk] = args;
  const es = readZip(apk);
  log(`条目 ${es.length}：`);
  for (const e of es) {
    if (/dex|payload|arsc|Manifest/.test(e.name))
      log(`  ${e.name.padEnd(28)} method=${e.method} csize=${e.csize} usize=${e.usize}`);
  }
}

else {
  log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(cmd ? 2 : 0);
}
