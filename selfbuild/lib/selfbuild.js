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
 *   apk-marks       <in.apk> <out.apk> [--kernel V] [--revision T]   # 写 dshroot 标记（原样搬运，不动对齐）
 *   check           <dir|zip> <manifest>                  # path|md5|keyword 行式校验
 *   inspect         <apk>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { readZip, writeZip } = require('./ziptool.js');

const ASSET = 'assets/payload.zip';
const KERNEL_PKG = 'dshroot/lib/node_modules/@deepseek-ai/dsh/package.json';
const MARK_KERNEL = 'assets/dshroot_kernel_version.txt';
const MARK_REVISION = 'assets/dshroot_revision.txt';

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const pad2 = (n) => String(n).padStart(2, '0');
/** 本地时间 yyyyMMddHHmmss（与旧 set-apk-markers.py 的 strftime 格式一致）。 */
const stamp = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
  + `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
const die = (m) => { console.error('✗ ' + m); process.exit(1); };
const log = (m) => console.log(m);

/** zip 条目取原始数据（method 0=store，8=deflate） */
function data(e) {
  if (e.method === 0) return e.raw;
  return zlib.inflateRawSync(e.raw);
}

/** 按偏移读一段原始字节（流式搬运 zip 条目用，不 inflate）。 */
function readRawAt(fd, len, off) {
  const buf = Buffer.alloc(len);
  let n = 0;
  while (n < len) n += fs.readSync(fd, buf, n, len - n, off + n);
  return buf;
}

/** 按需读一个条目的**解压后**内容。只用于小文件；大条目用 copyRange。 */
function readEntryData(file, entry) {
  const fd = fs.openSync(file, 'r');
  let raw;
  try { raw = readRawAt(fd, entry.csize, entry.dataOffset); } finally { fs.closeSync(fd); }
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

/** 分块算一个文件的 crc32 与大小（给 writeZip 的 rawFile 模式用，不整读进堆）。 */
function fileCrc32(file) {
  const fd = fs.openSync(file, 'r');
  const CH = 4 << 20;
  let crc = 0, size = 0;
  try {
    for (;;) {
      const buf = Buffer.allocUnsafe(CH);
      const n = fs.readSync(fd, buf, 0, CH, size);
      if (n === 0) break;
      crc = zlib.crc32(n === CH ? buf : buf.subarray(0, n), crc);
      size += n;
    }
  } finally { fs.closeSync(fd); }
  return { crc, size };
}

/** 把一个条目的原始字节分块复制到另一个文件（STORE 大条目用，不整读进堆）。 */
function copyRange(srcFile, entry, dstFile) {
  const fdIn = fs.openSync(srcFile, 'r'), fdOut = fs.openSync(dstFile, 'w');
  const CH = 4 << 20;
  try {
    let off = entry.dataOffset, left = entry.csize;
    while (left > 0) {
      const n = Math.min(CH, left);
      fs.writeSync(fdOut, readRawAt(fdIn, n, off));
      off += n; left -= n;
    }
  } finally { fs.closeSync(fdIn); fs.closeSync(fdOut); }
}

function walk(dir, rel, map) {
  for (const n of fs.readdirSync(dir)) {
    const f = path.join(dir, n);
    const r = rel ? rel + '/' + n : n;
    const st = fs.statSync(f);
    if (st.isDirectory()) walk(f, r, map);
    // 2026-10-18：`.bak-before-<事项>-<时间戳>` 这类备份过去能漏进 payload（只挡了 .bak 结尾）。
    // overlay 里每加一次备份就多一个垃圾文件进包，直接按前缀挡掉。
    else if (!/(\.(md5|sha256|bak)$)|(\.bak-)/.test(n)) map.set(r, fs.readFileSync(f));
  }
  return map;
}

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'payload-extract') {
  const [apk, out] = args;
  // 2026-10-19：改成按偏移分块复制。readZip(apk) 默认 load=true 会把整个 APK（156MB）
  // 的所有条目读进堆，再 writeFileSync 一份 payload（155MB）—— 手机上 free 只有
  // 200~450MB，这一步就能把 App 自己 OOM 掉。payload.zip 在 APK 里是 STORE，分块搬即可。
  const es = readZip(apk, { load: false });
  const p = es.find((e) => e.name === ASSET);
  if (!p) die('APK 里没有 ' + ASSET);
  if (p.method === 0) {
    const fdIn = fs.openSync(apk, 'r'), fdOut = fs.openSync(out, 'w');
    const CH = 4 << 20;
    try {
      let off = p.dataOffset, left = p.csize;
      while (left > 0) {
        const n = Math.min(CH, left);
        fs.writeSync(fdOut, readRawAt(fdIn, n, off));
        off += n; left -= n;
      }
    } finally { fs.closeSync(fdIn); fs.closeSync(fdOut); }
  } else {
    const fd = fs.openSync(apk, 'r');
    let raw;
    try { raw = readRawAt(fd, p.csize, p.dataOffset); } finally { fs.closeSync(fd); }
    fs.writeFileSync(out, zlib.inflateRawSync(raw));
  }
  log(`✓ 导出 ${ASSET} → ${out}（${fs.statSync(out).size} 字节，原 method=${p.method}）`);
}

else if (cmd === 'payload-patch') {
  const [zipIn, zipOut, overlay] = args;
  if (!overlay) die('用法: payload-patch <in.zip> <out.zip> <overlayDir>');
  const map = walk(overlay, '', new Map());
  log(`overlay 文件数: ${map.size}`);
  // 2026-10-19：改成**流式**。原来 readZip(zipIn) 默认 load=true 会把 155MB 的 payload
  // 整份读进堆，writeZip 再攒一份输出 —— 手机上 free 只有 200~300MB 时直接 OOM 或被
  // LMK 杀（被杀的就是 com.deepseek.harness 自己，Shizuku 也跟着没）。
  // 现在只读中央目录，条目按需从源 zip 读**原始压缩字节**（不 inflate）原样搬运；
  // writeZip 见到 raw 就不重压缩、不重算 crc，所以输出与输入逐条等价。
  const es = readZip(zipIn, { load: false });
  let rep = 0, add = 0;
  const missing = [];
  const pending = new Map(map);
  const fd = fs.openSync(zipIn, 'r');
  function* entries() {
    try {
      for (const e of es) {
        if (pending.has(e.name)) {
          const buf = pending.get(e.name);
          log(`  替换 ${e.name}（${buf.length} 字节）→ ${md5(buf)}`);
          pending.delete(e.name); rep++;
          yield { name: e.name, data: buf };
        } else {
          yield { ...e, raw: readRawAt(fd, e.csize, e.dataOffset) };
        }
      }
      for (const [name, buf] of pending) {
        add++;
        log(`  新增 ${name}（${buf.length} 字节）`);
        yield { name, data: buf, store: false };
      }
    } finally { fs.closeSync(fd); }
  }
  // 保险：overlay 里形如 <pkg>/lib/index.js 但 payload 里不存在同名条目 → 必须报出来（打错路径会静默无效）
  if (missing.length) die('overlay 路径在 payload 中不存在: ' + missing.join(', '));
  writeZip(entries(), zipOut);
  log(`✓ 写出 ${zipOut}（替换 ${rep}，新增 ${add}，总条目 ${es.length + add}，${fs.statSync(zipOut).size} 字节）`);
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
  // 2026-10-19：payload 不再 readFileSync（155MB 进堆），改成 rawFile + 分块 crc。
  const pInfo = (!payload || payload === '-') ? null : fileCrc32(payload);
  const dbuf = dexPath ? fs.readFileSync(dexPath) : null;
  if (!pInfo && !dbuf && !assetSpecs.length) die('payload / --dex / --asset 至少要换一样');
  let hitP = 0, hitD = 0;
  const hitA = new Set();
  // 2026-10-19：骨架也改流式。readZip(base) 默认 load=true 会把整个 APK（156MB）
  // 连同 155MB 的新 payload 一起塞进堆 —— 手机上 free 250MB 左右必 OOM。
  const es = readZip(base, { load: false });
  let total = 0;
  function* entries() {
    const bfd = fs.openSync(base, 'r');
    try {
      for (const e of es) {
        const as = assetSpecs.find(([, name]) => name === e.name);
        if (as) {
          const buf = fs.readFileSync(as[0]);
          hitA.add(e.name);
          log(`  替换 ${e.name}: ${e.csize} → ${buf.length} 字节（来自 ${as[0]}）`);
          total++; yield { name: e.name, data: buf };
          continue;
        }
        if (e.name === ASSET && pInfo) {
          hitP++;
          log(`  替换 ${ASSET}: ${e.csize} → ${pInfo.size} 字节（STORE，分块写）`);
          total++; yield { name: e.name, rawFile: payload, crc: pInfo.crc, usize: pInfo.size };
          continue;
        }
        if (e.name === 'classes.dex' && dbuf) {
          hitD++;
          log(`  替换 classes.dex: ${e.csize} → ${dbuf.length} 字节（DEFLATE，原 usize=${e.usize}）`);
          total++; yield { name: e.name, data: dbuf };
          continue;
        }
        total++; yield { ...e, raw: readRawAt(bfd, e.csize, e.dataOffset) };
      }
      // 2026-10-17：允许新增骨架里没有的 asset（原实现直接 die）。
      // 用于随包发「overlay 强制覆盖清单」assets/dshroot_forced.txt —— 没有它，
      // 同内核升级时 fast 同步不会重写被 overlay 改过的内核文件（LAN 补丁就是这么漏的）。
      for (const [src, name] of assetSpecs) {
        if (hitA.has(name)) continue;
        const buf = fs.readFileSync(src);
        log(`  新增 ${name}: ${buf.length} 字节（来自 ${src}）`);
        total++; yield { name, data: buf };
      }
    } finally { fs.closeSync(bfd); }
  }
  writeZip(entries(), out);
  if (pInfo && !hitP) die('骨架里没有 ' + ASSET);
  if (dbuf && !hitD) die('骨架里没有 classes.dex');
  log(`✓ 写出未签名 APK ${out}（${fs.statSync(out).size} 字节，条目 ${total}）`);
}

else if (cmd === 'apk-marks') {
  // 写 App 侧的两个 dshroot 标记（内核版本 + revision），走 ziptool 的「原样搬运」写包。
  //
  // 为什么不再用 Python zipfile 整体重写（旧 set-apk-markers.py，2026-10-10 查实长期静默失败）：
  //   ① 骨架 APK 的 resources.arsc 的 CRC 与中央目录不符（线上包也如此，Android 安装不校验），
  //      而 Python zipfile 读条目时**强校验 CRC** → BadZipFile → 标记一个都没写、退出 1；
  //   ② 整体重写会解压/重压全部条目，**丢掉 zipalign 对齐**。
  // 本实现只替换这两个条目的字节，其余条目 raw 原样搬运；写完**回读**再报成功。
  const [apk, out] = args;
  const ki = args.indexOf('--kernel');
  const ri = args.indexOf('--revision');
  let kernel = ki >= 0 ? args[ki + 1] : null;
  const revision = ri >= 0 ? args[ri + 1] : stamp(new Date());
  // 2026-10-19：流式。原来 readZip 整读 APK，再 writeFileSync(data(p)) 复制一份 155MB payload。
  const es = readZip(apk, { load: false });
  if (!kernel) {
    const p = es.find((e) => e.name === ASSET);
    if (!p) die('APK 里没有 ' + ASSET + '，无法读出内核版本（可用 --kernel 指定）');
    if (p.method !== 0) die('内层 payload 不是 STORE，暂不支持（method=' + p.method + '）');
    // ziptool 只吃路径 → 内层 payload 分块落一次临时文件（用完即删），不整读进堆
    const tmp = path.join(process.env.DSH_WORK || path.dirname(out), '.marks-inner-payload.zip');
    copyRange(apk, p, tmp);
    const pkg = readZip(tmp, { load: false }).find((e) => e.name === KERNEL_PKG);
    if (!pkg) { fs.unlinkSync(tmp); die('payload 里没有 ' + KERNEL_PKG); }
    kernel = JSON.parse(readEntryData(tmp, pkg).toString('utf8')).version;
    fs.unlinkSync(tmp);
  }
  if (!kernel) die('读不出内核版本，请用 --kernel 指定');
  let written = 0;
  function* marked() {
    const afd = fs.openSync(apk, 'r');
    try {
      for (const e of es) {
        if (e.name === MARK_KERNEL) { written++; yield { name: e.name, data: Buffer.from(kernel + '\n') }; continue; }
        if (e.name === MARK_REVISION) { written++; yield { name: e.name, data: Buffer.from(revision + '\n') }; continue; }
        yield { ...e, raw: readRawAt(afd, e.csize, e.dataOffset) };
      }
    } finally { fs.closeSync(afd); }
  }
  writeZip(marked(), out);
  if (written !== 2) die(`期望替换 2 项标记，实际 ${written} —— 包结构可能不对`);
  // 回读校验（按字节，别信"脚本没报错"）
  const back = readZip(out, { load: false });
  const gk = readEntryData(out, back.find((e) => e.name === MARK_KERNEL)).toString('utf8').trim();
  const gr = readEntryData(out, back.find((e) => e.name === MARK_REVISION)).toString('utf8').trim();
  if (gk !== kernel || gr !== revision) die(`回读不一致：kernel=${gk} revision=${gr}`);
  log(`✓ 标记已写入并回读验证：kernel=${gk}  revision=${gr}`);
}

else if (cmd === 'dex-extract') {
  const [apk, out] = args;
  const e = readZip(apk, { load: false }).find((x) => x.name === 'classes.dex');
  if (!e) die('APK 里没有 classes.dex');
  const buf = readEntryData(apk, e);
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
    // 2026-10-19：流式。原来 readZip(target) 会把 155MB 的 payload-check.zip 整份读进堆。
    for (const e of readZip(target, { load: false })) map.set(e.name, () => readEntryData(target, e));
  }
  const lines = fs.readFileSync(manifestPath, 'utf8').split('\n');
  let pass = 0, fail = 0, skip = 0;
  const fails = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [rel, wantMd5, keyword, policy = 'all'] = line.split('|').map((s) => (s || '').trim());
    if (!['all', 'local'].includes(policy)) die('未知清单策略: ' + policy);
    if (args.includes('--dist') && policy === 'local') { skip++; continue; }
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
