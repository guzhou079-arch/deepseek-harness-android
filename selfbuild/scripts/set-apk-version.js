const path = require('path');
// set-apk-version.js —— 改 APK 内 AndroidManifest.xml 的 versionName / versionCode
//
// 为什么需要：selfbuild.sh 的设计是「复用骨架 APK，资源/清单原样搬运」（不需要 aapt2），
// 所以每出一个新包 versionName 都还是骨架的值 → App 的 checkForUpdate（MainActivity:924，
// 比对 GitHub release tag 与本机 versionName）永远认为「已是最新」→ 别人收不到更新提示。
//
// 做法：直接改 APK 里那份**二进制** AndroidManifest.xml。
//   · 字符串池若已含同长度串 → 原地覆盖（最稳）
//   · 长度不同 → 重建字符串池并修正其后所有 chunk 的相对布局
//   · versionCode 是 attribute 里的 int32 → 原地改
// 全程不碰 res/ 与 resources.arsc。
//
// 用法：
//   node set-apk-version.js <in.apk> <out.apk> --name 1.21 [--code 52]
//   node set-apk-version.js <in.apk> --dump          # 只读，打印当前 versionName/Code

const fs = require('node:fs');
const zlib = require('node:zlib');
const { readZip, writeZip, crc32 } = require(path.join(__dirname, '../lib/ziptool.js'));

const MANIFEST = 'AndroidManifest.xml';
const RES_XML_TYPE = 0x0003, RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
const UTF8_FLAG = 1 << 8;

// ---- 读一个 zip 条目为 Buffer（store 或 deflate）----
function readEntry(e) {
  if (e.method === 0) return e.raw;
  if (e.method === 8) return zlib.inflateRawSync(e.raw);
  throw new Error('不支持的压缩方法 ' + e.method);
}

// ---- 解析字符串池 ----
function parsePool(b, off) {
  const type = b.readUInt16LE(off), headerSize = b.readUInt16LE(off + 2);
  const size = b.readUInt32LE(off + 4);
  const stringCount = b.readUInt32LE(off + 8);
  const styleCount = b.readUInt32LE(off + 12);
  const flags = b.readUInt32LE(off + 16);
  const stringsStart = b.readUInt32LE(off + 20);
  const stylesStart = b.readUInt32LE(off + 24);
  if (type !== RES_STRING_POOL_TYPE) throw new Error('不是字符串池 @' + off);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const offsets = [];
  for (let i = 0; i < stringCount; i++) offsets.push(b.readUInt32LE(off + headerSize + i * 4));
  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    const p = off + stringsStart + offsets[i];
    let s;
    if (utf8) {
      let q = p;
      let n = b[q++]; if (n & 0x80) n = ((n & 0x7f) << 8) | b[q++];
      let n2 = b[q++]; if (n2 & 0x80) n2 = ((n2 & 0x7f) << 8) | b[q++];
      s = b.slice(q, q + n2).toString('utf8');
    } else {
      let q = p;
      let n = b.readUInt16LE(q); q += 2; if (n & 0x8000) { n = ((n & 0x7fff) << 16) | b.readUInt16LE(q); q += 2; }
      s = b.slice(q, q + n * 2).toString('utf16le');
    }
    strings.push(s);
  }
  return { off, size, stringCount, styleCount, flags, utf8, offsets, strings, end: off + size };
}

// ---- 重建字符串池（可改长度）----
function buildPool(pool, replace) {
  const strings = pool.strings.map((s, i) => (replace.has(i) ? replace.get(i) : s));
  const utf8 = pool.utf8;
  const datas = [];
  const offsets = [];
  let cur = 0;
  for (const s of strings) {
    offsets.push(cur);
    let buf;
    if (utf8) {
      const bytes = Buffer.from(s, 'utf8');
      const u16len = Buffer.from(s, 'utf16le').length / 2;
      const lenBytes = u16len < 0x80 ? Buffer.from([u16len]) : Buffer.from([(u16len >> 8) | 0x80, u16len & 0xff]);
      const nBytes = bytes.length < 0x80 ? Buffer.from([bytes.length]) : Buffer.from([(bytes.length >> 8) | 0x80, bytes.length & 0xff]);
      buf = Buffer.concat([lenBytes, nBytes, bytes, Buffer.from([0])]);
    } else {
      const bytes = Buffer.from(s, 'utf16le');
      const n = bytes.length / 2;
      const lenBytes = n < 0x8000 ? Buffer.from([n & 0xff, (n >> 8) & 0xff])
                                  : Buffer.from([((n >> 16) | 0x80) & 0xff, (n >> 8) & 0xff, n & 0xff, 0]);
      buf = Buffer.concat([lenBytes, bytes, Buffer.from([0, 0])]);
    }
    datas.push(buf);
    cur += buf.length;
  }
  const headerSize = 28;
  const offTableLen = pool.stringCount * 4;
  const styleTableLen = pool.styleCount * 4;
  const stringsStart = headerSize + offTableLen + styleTableLen;
  const pad = (4 - ((stringsStart + cur) % 4)) % 4;
  const total = stringsStart + cur + pad;
  const out = Buffer.alloc(total);
  out.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
  out.writeUInt16LE(headerSize, 2);
  out.writeUInt32LE(total, 4);
  out.writeUInt32LE(pool.stringCount, 8);
  out.writeUInt32LE(pool.styleCount, 12);
  out.writeUInt32LE(pool.flags, 16);
  out.writeUInt32LE(stringsStart, 20);
  out.writeUInt32LE(pool.styleCount ? stringsStart + cur : 0, 24);
  for (let i = 0; i < offsets.length; i++) out.writeUInt32LE(offsets[i], headerSize + i * 4);
  let p = stringsStart;
  for (const d of datas) { d.copy(out, p); p += d.length; }
  return out;
}

// ---- 遍历 XML chunk，找 <manifest> 的 versionName/versionCode ----
function findManifestAttrs(b, pool) {
  let p = pool.end;
  const found = {};
  const elems = [];
  while (p + 8 <= b.length) {
    const type = b.readUInt16LE(p), size = b.readUInt32LE(p + 4);
    if (size <= 0 || p + size > b.length) break;
    if (type === RES_XML_START_ELEMENT_TYPE) {
      const attrStart = b.readUInt16LE(p + 2 + 2 + 4 + 4 + 4); // headerSize 后：line,comment,ns,name,attrStart,attrSize,attrCount...
      // ResXMLTree_node: header(8) line(4) comment(4) → headerSize 通常 16
      // 其后是 ResXMLTree_attrExt: ns(4) name(4) attributeStart(2) attributeSize(2)
      //                            attributeCount(2) idIndex(2) classIndex(2) styleIndex(2)
      const hdr = b.readUInt16LE(p + 2);
      const nameIdx = b.readUInt32LE(p + hdr + 4);
      if (pool.strings[nameIdx] === 'manifest') {
        const aStart = b.readUInt16LE(p + hdr + 8);
        const aSize = b.readUInt16LE(p + hdr + 10);
        const aCount = b.readUInt16LE(p + hdr + 12);
        for (let i = 0; i < aCount; i++) {
          const ao = p + hdr + aStart + i * aSize;
          const aName = pool.strings[b.readUInt32LE(ao + 4)];
          const aType = b[ao + 15];
          const rawIdx = b.readUInt32LE(ao + 8);
          const dataVal = b.readUInt32LE(ao + 16);
          if (aName === 'versionName') found.versionName = { strIdx: rawIdx, abs: ao + 16, str: pool.strings[rawIdx] };
          if (aName === 'versionCode') found.versionCode = { abs: ao + 16, val: dataVal, type: aType };
        }
      }
    }
    p += size;
  }
  return found;
}

// ---- 主流程 ----
const argv = process.argv.slice(2);
const inApk = argv[0];
const dump = argv.includes('--dump');
const outApk = dump ? null : argv[1];
const nameIdx = argv.indexOf('--name'), codeIdx = argv.indexOf('--code');
const newName = nameIdx >= 0 ? argv[nameIdx + 1] : null;
const newCode = codeIdx >= 0 ? parseInt(argv[codeIdx + 1], 10) : null;

const entries = readZip(inApk);
const me = entries.find(e => e.name === MANIFEST);
if (!me) { console.error('✗ APK 里没有 ' + MANIFEST); process.exit(1); }
const b = readEntry(me);
if (b.readUInt16LE(0) !== RES_XML_TYPE) { console.error('✗ 不是二进制 XML'); process.exit(1); }

let p = b.readUInt16LE(2);
const pool = parsePool(b, p);
const attrs = findManifestAttrs(b, pool);

console.log('当前 versionName =', attrs.versionName ? attrs.versionName.str : '(没找到)');
console.log('当前 versionCode =', attrs.versionCode ? attrs.versionCode.val : '(没找到)');
if (dump) process.exit(0);

if (!newName) { console.error('✗ 需要 --name <版本号>'); process.exit(1); }
if (!attrs.versionName) { console.error('✗ 清单里没有 versionName 属性'); process.exit(1); }

// 1) 字符串池
const sameLen = Buffer.from(newName, 'utf16le').length === Buffer.from(attrs.versionName.str, 'utf16le').length;
const replace = new Map([[attrs.versionName.strIdx, newName]]);
const np = buildPool(pool, replace);
console.log(`字符串池: ${pool.size} → ${np.length} B（${sameLen ? '同长度' : '长度已变，重建并修正布局'}）`);

// 2) 拼接：顶层 XML 头(8B) + 新池 + 其余原样（元素里的 rawIdx 不变，池内顺序不变）
const xmlHeader = b.slice(0, b.readUInt16LE(2));
let body = b.slice(pool.end);
// 2b) versionCode 原地改（在 body 里，绝对偏移 - pool.end）
if (newCode !== null && attrs.versionCode) {
  const rel = attrs.versionCode.abs - pool.end;
  body.writeUInt32LE(newCode >>> 0, rel);
  console.log('versionCode:', attrs.versionCode.val, '→', newCode);
}
const nb = Buffer.concat([xmlHeader, np, body]);
nb.writeUInt32LE(nb.length, 4); // 顶层 XML chunk 的 size

// 3) 校验：重新解析一遍，确认读回来是对的
const pool2 = parsePool(nb, nb.readUInt16LE(2));
const attrs2 = findManifestAttrs(nb, pool2);
console.log('回读 versionName =', attrs2.versionName ? attrs2.versionName.str : '(没找到)');
console.log('回读 versionCode =', attrs2.versionCode ? attrs2.versionCode.val : '(没找到)');
if (!attrs2.versionName || attrs2.versionName.str !== newName) { console.error('✗ 回读不一致，放弃'); process.exit(1); }

// 4) 写回 zip（manifest 按 store 放回，与原样一致）
const out = entries.map(e => (e.name === MANIFEST ? { name: MANIFEST, data: nb, store: true } : e));
writeZip(out, outApk);
console.log('✓ 写出', outApk, fs.statSync(outApk).size, 'B');
