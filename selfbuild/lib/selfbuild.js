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
const { isSkipped } = require('./overlay-skip.js');
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
    // 2026-11-07：跳过集含 .md5/.sha256/.orig/.rej/.DS_Store/~，与 selfbuild.sh 的 ovl_find
    // **同源**（lib/overlay-skip.js）。以前各写一份，find 挡的 walk 不挡、walk 挡的 find 不挡，
    // 会出现「文件进了包，但 dshroot_forced.txt 里没有」的清单漂移。
    else if (!isSkipped(n)) map.set(r, fs.readFileSync(f));
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
  const added = [];       // overlay 里 payload 原本没有的路径：必须出声，不许静默追加
  const rewritten = [];   // 本轮真的被改写的条目：写进 .patched.txt，供事后核对「补丁到底跑没跑」
  const suspicious = [];  // 可疑追加（塞进已存在的包 / 开发备份名 / 整棵目录不存在）
  const pending = new Map(map);
  const fd = fs.openSync(zipIn, 'r');
  function* entries() {
    try {
      for (const e of es) {
        if (pending.has(e.name)) {
          const buf = pending.get(e.name);
          log(`  替换 ${e.name}（${buf.length} 字节）→ ${md5(buf)}`);
          pending.delete(e.name); rep++; rewritten.push(e.name);
          yield { name: e.name, data: buf };
        } else {
          yield { ...e, raw: readRawAt(fd, e.csize, e.dataOffset) };
        }
      }
      for (const [name, buf] of pending) {
        add++; added.push(name);
        log(`  新增 ${name}（${buf.length} 字节）`);
        yield { name, data: buf, store: false };
      }
    } finally { fs.closeSync(fd); }
  }
  writeZip(entries(), zipOut);
  log(`✓ 写出 ${zipOut}（替换 ${rep}，新增 ${add}，总条目 ${es.length + add}，${fs.statSync(zipOut).size} 字节）`);
  // 2026-11-07：补丁痕迹必须可核对，光看产物不行。
  // 背景：14 个真补丁早就烘进 295 出货包，于是「patch 阶段没跑」和「跑了但结果与底包相同」
  // 在产物上完全看不出区别；哪次漏跑，谁都不会发现。所以两样东西必须留下：
  //   ① 一行计数：overlay 多少文件 → 实际改写多少条 / 新增多少条；
  //   ② 一份 .patched.txt：被改写的条目名，事后能逐条核对。
  // 另外和 forced 清单对一遍：forced 清单（assets/dshroot_forced.txt）决定设备端开机强刷哪些文件，
  // 改写过的条目**必须**在里面，否则包内是新的、设备上还是旧的，症状是「改了没生效」。
  const patchedSide = zipOut + '.patched.txt';
  fs.writeFileSync(patchedSide, rewritten.length ? rewritten.join('\n') + '\n' : '');
  const norm = (n) => n.replace(/^dshroot\//, '');
  // forced 清单只管**内核树**。`assets/dshroot_forced.txt` 是设备端「开机强制覆盖哪些文件」的白名单，
  // 而真正发出去的两份（1.48/295 共 119 条、1.48.1/297 共 123 条）里一条 dshhome 都没有 ——
  // dshhome/（DSH_HOME 种子：技能、profiles、员工名册）和 pet/（电子宠物）属**用户空间**，
  // 设备侧另有 DSHHOME_CONFIG_PATHS（官方配置，随包覆盖）与 DSHHOME_USER_PATHS（用户数据，永不覆盖）
  // 两张白名单在管；把它们塞进 forced 会连用户数据一起盖掉。
  // 所以这里只对内核树要求「入清单」，用户空间按前缀豁免 —— 且是**列名**，不是「非内核即豁免」：
  // 将来 payload 里出现新的顶层段，默认仍然要求入清单（会红），要豁免就显式加一行。
  const NON_FORCED_SCOPE = ['dshhome/', 'pet/'];
  let forcedNote = '（未提供 forced 清单，跳过对账）';
  const forcedList = process.env.DSH_FORCED_LIST;
  if (forcedList && fs.existsSync(forcedList)) {
    const forced = new Set(fs.readFileSync(forcedList, 'utf8').split('\n').map((x) => norm(x.trim())).filter(Boolean));
    const touched = [...rewritten, ...added];            // 新增条目同样要进 forced 清单，否则设备端不会强刷
    const inKernelScope = (n) => !NON_FORCED_SCOPE.some((p) => n.startsWith(p));
    const notForced = touched.map(norm).filter((n) => inKernelScope(n) && !forced.has(n));
    const userSpace = touched.map(norm).filter((n) => !inKernelScope(n));
    forcedNote = notForced.length
      ? `⚠ forced 清单 ${forced.size} 条，但本轮动过的 ${notForced.length} 条内核文件不在其中（设备端开机不会强刷，改了等于没改）：${notForced.slice(0, 5).join(', ')}`
      : `✓ 本轮动过的内核文件（改写 ${rewritten.length} + 新增 ${added.length} 共 ${touched.length} 条里的 ${touched.length - userSpace.length} 条）全在 forced 清单里（清单共 ${forced.size} 条）；另有 ${userSpace.length} 条用户空间种子（${NON_FORCED_SCOPE.join(' ')}）按设备侧白名单处理，不进 forced`;
    if (notForced.length) process.exitCode = 1;
  }
  log(`✓ patch 痕迹：overlay ${map.size} 个文件 → 改写 ${rep} 条 / 新增 ${add} 条（清单 ${patchedSide}）`);
  log(`  ${forcedNote}`);
  // 2026-11-07 修死代码：原来这里是
  //     if (missing.length) die('overlay 路径在 payload 中不存在: ...')
  // 但 `missing` 声明后从来没人 push，而这一行还在 entries() 生成器**之前**求值 ——
  // 等于"overlay 多出来的路径静默追加进 payload"完全没人管。.bak / 打错路径能混进包，
  // 走的就是这条通道（payload-patch 只按路径整文件覆盖，不做世代校验）。
  //
  // 追加本身是合法能力（新插件、新技能、locale 靠它），所以分三档：
  //   默认     ：整棵目录在 payload 里都不存在的路径 → 直接 die（打错路径的典型形态）；
  //              塞进已存在的包、开发备份名 → 只警告（版本升级会合法地多出文件）；
  //   STRICT=1 ：任何追加都 die（发行构建用，宁可停也别猜）；
  //   STRICT=0 ：连默认那一档也降级成警告（开发调试用）。
  // 为什么默认要挡「整棵目录不存在」：296 那次的 .bak 之所以能进包，就是因为追加路径
  // 没人管；而 `dshroot/nonexistent-dir/x.js` 这种形状没有任何合法版本升级会长出来。
  if (added.length) {
    const side = zipOut + '.added.txt';
    fs.writeFileSync(side, added.join('\n') + '\n');
    log(`⚠ overlay 里有 ${added.length} 条路径 payload 本来没有，已作为新文件追加（清单：${side}）`);
    const allNames = new Set(es.map((e) => e.name));
    // payload 里已存在的目录集合：用来判断「这棵目录树本来在不在」
    const knownDirs = new Set();
    for (const n of allNames) {
      let d = n;
      while (true) {
        const k = d.lastIndexOf('/');
        if (k < 0) break;
        d = d.slice(0, k);
        knownDirs.add(d);
      }
    }
    // 这些容器下长出全新子树是正常的（新包/新技能/新 profile 文件）
    const NEW_SUBTREE_OK = [/\/node_modules\//, /^dshhome\/skills\//, /^dshhome\/profiles\//];
    const mode = process.env.DSH_PATCH_STRICT; // '1' 全严格 / '0' 全警告 / 其它=默认
    const fatal = [];
    for (const n of added) {
      const tag = [];
      if (/(^|\/)(\.[^/]*\.)?[^/]*\.(bak|orig|old|rej|swp|tmp)(-|$)/.test(n) || /~$/.test(n)) tag.push('开发备份名');
      let wholeNewTree = false;
      const parent = n.slice(0, n.lastIndexOf('/'));
      if (parent && !knownDirs.has(parent) && !NEW_SUBTREE_OK.some((rx) => rx.test(n))) {
        tag.push('整棵目录在 payload 里不存在');
        wholeNewTree = true;
      }
      // 找最近的、payload 里已有 package.json 的祖先目录 = 已存在的包 → 往老包里塞新文件多半是路径打错。
      // 走到 node_modules 边界就停：那是"新包安放在该在的位置"，不是打错路径；版本升级也会合法多出文件。
      let d = parent;
      for (let i = 0; i < 6 && d && d.includes('/'); i++) {
        if (d.slice(d.lastIndexOf('/') + 1) === 'node_modules') break;
        if (allNames.has(d + '/package.json')) { tag.push(`塞进已存在的包 ${d.slice(d.lastIndexOf('/') + 1)}`); break; }
        d = d.slice(0, d.lastIndexOf('/'));
      }
      if (tag.length) {
        log(`    ⚠ ${n}  ← ${tag.join(' / ')}`);
        suspicious.push(`    ${n}  ← ${tag.join(' / ')}`);
      }
      if (mode === '1' || (wholeNewTree && mode !== '0')) fatal.push(`${n}（${tag.join(' / ')}）`);
    }
    if (suspicious.length) {
      log(`⚠ 其中 ${suspicious.length} 条可疑（塞进已存在的包 / 开发备份名，默认只警告）`);
    }
    if (fatal.length) {
      fs.rmSync(zipOut, { force: true });
      die(`overlay 追加了 ${fatal.length} 条不该存在的路径，已删除输出、不打下去了：\n    ${fatal.join('\n    ')}\n` +
          `  判据：整棵目录在 payload 里不存在（多半是打错路径），或 DSH_PATCH_STRICT=1。\n` +
          `  真要新增这棵目录：确认路径无误后加 DSH_PATCH_STRICT=0 重跑，并在构建日志里留一句为什么。`);
    }
  }
}

else if (cmd === 'apk-pack') {
  const [base, payload, out] = args;
  const di = args.indexOf('--dex');
  const dexPath = di >= 0 ? args[di + 1] : null;
  // --asset <本地文件>:<APK 内条目名>（可重复）—— 替换 payload.zip / classes.dex 之外的 asset。
  // 为什么需要：pack 原本只换这两样，于是「虚拟屏核心 assets/vscreen_shizuku.jar」这类
  // 独立 asset，光改 Java 源码再 pack 也进不去包（2026-10-03 踩到，v143 差点白装）。
  const assetSpecs = [];
  const assetNames = new Set();
  const ai = args.indexOf('--asset-receipt');
  const assetReceipt = ai >= 0 ? args[ai + 1] : null;
  if (ai >= 0 && !assetReceipt) die('--asset-receipt 需要输出路径');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--asset') {
      const v = args[i + 1] || '';
      const k = v.lastIndexOf(':');
      if (k <= 0) die('--asset 用法: <本地文件>:<APK 内条目名>');
      const src = v.slice(0, k), name = v.slice(k + 1);
      if (!name.startsWith('assets/') || name.split('/').includes('..') || name === ASSET) die('非法 --asset 条目: ' + name);
      if (assetNames.has(name)) die('--asset 条目重复: ' + name);
      assetNames.add(name);
      assetSpecs.push([src, name]);
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
  if (assetReceipt) {
    const assets = assetSpecs.map(([src, name]) => {
      const buf = fs.readFileSync(src);
      return { name, source: path.resolve(src), size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    });
    const tmp = assetReceipt + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ schema: 1, kind: 'packed-assets', assets }, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(tmp, assetReceipt);
  }
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
  // revision 的期望值是 **payload 里那份 dshroot/REVISION**，不是「写标记这一刻的时钟」。
  // 为什么（2026-11-11 查实）：patch 阶段先把本次构建号写进 build-overlay/dshroot/REVISION
  // 再套进 payload；mark 阶段若各自取一次 new Date()，两个戳会差几秒到几分钟（实测差 16s）。
  // App 侧 dshrootRevisionChanged() 比的是「APK 里 dshroot_revision.txt」与「设备上 dshroot/REVISION」——
  // 两者本该相等，各戳一次的时刻永远不等 ⇒ 每次冷启动都判「revision 变了」而多跑一轮同步。
  // 留空 → 从 payload 读；读不到直接报错，不退回墙上时钟（那正是这个 bug 的成因）。
  let revision = ri >= 0 ? args[ri + 1] : null;
  // 2026-10-19：流式。原来 readZip 整读 APK，再 writeFileSync(data(p)) 复制一份 155MB payload。
  const es = readZip(apk, { load: false });
  if (!kernel || !revision) {
    const pe = es.find((e) => e.name === ASSET);
    if (!pe) die('APK 里没有 ' + ASSET + '，无法读出内核版本与 revision（可用 --kernel/--revision 指定）');
    if (pe.method !== 0) die('内层 payload 不是 STORE，暂不支持（method=' + pe.method + '）');
    // ziptool 只吃路径 → 内层 payload 分块落一次临时文件（用完即删），不整读进堆
    const tmp = path.join(process.env.DSH_WORK || path.dirname(out), '.marks-inner-payload.zip');
    copyRange(apk, pe, tmp);
    const inner = readZip(tmp, { load: false });
    let fail = null;
    try {
      if (!kernel) {
        const pkg = inner.find((e) => e.name === KERNEL_PKG);
        if (!pkg) fail = 'payload 里没有 ' + KERNEL_PKG;
        else kernel = JSON.parse(readEntryData(tmp, pkg).toString('utf8')).version;
      }
      if (!fail && !revision) {
        const rev = inner.find((e) => e.name === 'dshroot/REVISION');
        const v = rev ? readEntryData(tmp, rev).toString('utf8').trim() : '';
        if (!v) fail = 'payload 里没有 dshroot/REVISION —— 先跑 patch（构建号由它写），或用 --revision 指定';
        else revision = v;
      }
    } finally { fs.unlinkSync(tmp); }
    if (fail) die(fail);
  }
  if (!kernel) die('读不出内核版本，请用 --kernel 指定');
  if (!/^[0-9]{14}$/.test(String(revision))) die('revision 形态不对（期望 14 位 yyyyMMddHHmmss）：' + revision);
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
    const [rel, wantMd5, keyword, policy = 'all', why = '', kwmin] = line.split('|').map((s) => (s || '').trim());
    if (!['all', 'local'].includes(policy)) die('未知清单策略: ' + policy);
    if (!keyword) die(`清单条目缺关键字列（路径后面第二根竖线是空的）: ${rel}`);
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
    // 关键字门槛：老清单只有「命中 ≥1」，新清单第 6 列写死最低次数。
    // 只查 >0 挡不住「补丁被削掉一半但这个词还在」的退化。
    const kwMin = keyword === '-' ? 0 : (kwmin === undefined || kwmin === '' ? 1 : parseInt(kwmin, 10));
    if (Number.isNaN(kwMin)) die(`清单条目第 6 列（最低命中次数）不是数字: ${rel}`);
    let okKw = true, kwCount = 0;
    if (keyword && keyword !== '-') {
      kwCount = (buf.toString('utf8').split(keyword).length - 1);
      okKw = kwCount >= kwMin;
    }
    if (okMd5 && okKw) { pass++; }
    else {
      fail++;
      const p = [];
      if (!okMd5) p.push(`md5 ${got} ≠ 期望 ${wantMd5}`);
      if (!okKw) p.push(`关键字「${keyword}」命中 ${kwCount} 次，要求 ≥${kwMin} 次`);
      if (!okKw && why) p.push(`这个词代表: ${why}`);
      fails.push(`${rel}\n    ✗ ${p.join('；')}`);
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
