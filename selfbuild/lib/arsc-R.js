#!/usr/bin/env node
/*
 * arsc-R.js —— 零依赖解析 APK 内 resources.arsc，导出「资源名 -> 资源 id(0x7fTTEEEE)」，
 * 并可据此生成可编译的 R.java。
 *
 * 为什么要自己写：本机（安卓内嵌 DSH）没有 aapt/aapt2，但 App 侧 Java 源码引用了
 * R.drawable.* / R.color.* / R.dimen.* / R.style.*，必须造出一个与**装机 APK 的
 * resources.arsc 完全一致**的 R.java（id 必须相同，否则运行期会取错资源）。
 *
 * 覆盖的 chunk 类型（ResChunk_header: u16 type, u16 headerSize, u32 size）：
 *   0x0002 ResTable_header        —— 文件头 + packageCount
 *   0x0001 RES_STRING_POOL_TYPE   —— 全局字符串池 / 每个 package 的 typeStrings、keyStrings
 *   0x0200 RES_TABLE_PACKAGE_TYPE —— package 头（id、name、typeStrings/keyStrings 偏移）
 *   0x0202 RES_TABLE_TYPE_SPEC_TYPE —— typeSpec（只用于统计，不产出名字）
 *   0x0201 RES_TABLE_TYPE_TYPE    —— 一种 type 在一种 config 下的 entry 集合
 *   0x0203 RES_TABLE_LIBRARY_TYPE —— 动态引用库（跳过）
 *
 * 用法：
 *   node arsc-R.js <apk> --dump                 # 打印 chunk 树（证据）
 *   node arsc-R.js <apk> --out R.java [--package com.deepseek.harness] [--json out.json]
 *
 * 导出（module.exports）：
 *   parseApk(apkPath)  -> {packages, entries, stats}
 *   parseArsc(buf, {verbose}) -> 同上
 *   renderRJava(parsed, {packageName}) -> string
 *   entriesToMap(parsed) -> Map<"type/name", id>
 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { readZip } = require('./ziptool.js');

/* ------------------------------------------------------------------ 常量 */
const RES_NULL_TYPE = 0x0000;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_TABLE_TYPE = 0x0002;
const RES_XML_TYPE = 0x0003;
const RES_TABLE_PACKAGE_TYPE = 0x0200;
const RES_TABLE_TYPE_TYPE = 0x0201;
const RES_TABLE_TYPE_SPEC_TYPE = 0x0202;
const RES_TABLE_LIBRARY_TYPE = 0x0203;

const TYPE_NAMES = {
  0x0000: 'NULL', 0x0001: 'STRING_POOL', 0x0002: 'TABLE', 0x0003: 'XML',
  0x0200: 'TABLE_PACKAGE', 0x0201: 'TABLE_TYPE', 0x0202: 'TABLE_TYPE_SPEC',
  0x0203: 'TABLE_LIBRARY',
};

/* Res_value.dataType */
const VALUE_TYPE_NAMES = {
  0x00: 'NULL', 0x01: 'REFERENCE', 0x02: 'ATTRIBUTE', 0x03: 'STRING',
  0x04: 'FLOAT', 0x05: 'DIMENSION', 0x06: 'FRACTION', 0x07: 'DYNAMIC_REFERENCE',
  0x08: 'DYNAMIC_ATTRIBUTE', 0x10: 'INT_DEC', 0x11: 'INT_HEX', 0x12: 'INT_BOOLEAN',
  0x1c: 'INT_COLOR_ARGB8', 0x1d: 'INT_COLOR_RGB8', 0x1e: 'INT_COLOR_ARGB4',
  0x1f: 'INT_COLOR_RGB4',
};

/* ResTable_entry.flags */
const FLAG_COMPLEX = 0x0001;
const FLAG_PUBLIC = 0x0002;
const FLAG_WEAK = 0x0004;
const FLAG_COMPACT = 0x0008;
/* ResTable_type.flags */
const FLAG_SPARSE = 0x01;
const NO_ENTRY = 0xffffffff;

/* ------------------------------------------------------------------ 字符串池 */
/**
 * 解析 ResStringPool（UTF-8 或 UTF-16）。返回 {strings, isUtf8, ...}
 * 安卓字符串池两种编码的"长度前缀"规则不同：
 *  - UTF-16：u16 长度，最高位为 1 表示后面再跟一个 u16（长串）
 *  - UTF-8 ：两个长度（字符数、字节数），每个都是 1 或 2 字节（高位置 1 → 双字节）
 */
function readStringPool(buf, off, verbose) {
  const type = buf.readUInt16LE(off);
  const headerSize = buf.readUInt16LE(off + 2);
  const size = buf.readUInt32LE(off + 4);
  if (type !== RES_STRING_POOL_TYPE) throw new Error('不是字符串池 @0x' + off.toString(16));
  const stringCount = buf.readUInt32LE(off + 8);
  const styleCount = buf.readUInt32LE(off + 12);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = buf.readUInt32LE(off + 20);
  const stylesStart = buf.readUInt32LE(off + 24);
  const isUtf8 = !!(flags & (1 << 8)); /* UTF8_FLAG */
  const offsetsOff = off + headerSize;
  const dataOff = off + stringsStart;
  const strings = [];
  for (let i = 0; i < stringCount; i++) {
    let p = dataOff + buf.readUInt32LE(offsetsOff + i * 4);
    if (isUtf8) {
      /* 字符长度 */
      let n1 = buf[p++];
      if (n1 & 0x80) n1 = ((n1 & 0x7f) << 8) | buf[p++];
      /* 字节长度 */
      let n2 = buf[p++];
      if (n2 & 0x80) n2 = ((n2 & 0x7f) << 8) | buf[p++];
      strings.push(buf.slice(p, p + n2).toString('utf8'));
    } else {
      let n = buf.readUInt16LE(p); p += 2;
      if (n & 0x8000) { n = ((n & 0x7fff) << 16) | buf.readUInt16LE(p); p += 2; }
      strings.push(buf.slice(p, p + n * 2).toString('utf16le'));
    }
  }
  if (verbose) console.error(`  [pool] off=0x${off.toString(16)} hdr=${headerSize} size=${size} count=${stringCount} styles=${styleCount} utf8=${isUtf8}`);
  return { strings, isUtf8, stringCount, styleCount, flags, size, headerSize, stylesStart };
}

/* ------------------------------------------------------------------ 资源名合法化 */
/** aapt 的 R.java 字段名规则：非 [A-Za-z0-9_] 一律换成 '_'（风格名 AppTheme.Light -> AppTheme_Light） */
function makeFieldName(name) {
  let s = String(name).replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(s)) s = '_' + s;              /* 不能以数字开头 */
  if (s === '') s = '_';
  return s;
}
/** type 名（drawable/color/...）同样处理，另加 java 关键字保护 */
const JAVA_KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum ' +
  'extends final finally float for goto if implements import instanceof int interface long native new package private protected ' +
  'public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null').split(' '));
function makeTypeName(name) {
  let s = makeFieldName(name);
  if (JAVA_KEYWORDS.has(s)) s = s + '_';
  return s;
}
function hex8(v) { return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0'); }

/* ------------------------------------------------------------------ 主解析 */
/**
 * 解析 resources.arsc 的字节流。
 * 返回 {
 *   packages: [{id, name, typeIdOffset, types: {typeName: {typeId, entries:[{index,name,id,flags}]}}}],
 *   entries:  [{pkg, pkgId, type, typeId, index, name, id, field, flags}],
 *   stats:    {...}
 * }
 */
function parseArsc(buf, opts) {
  opts = opts || {};
  const verbose = opts.verbose;
  const log = verbose ? (m) => console.error(m) : () => {};
  const size = buf.length;
  const rootType = buf.readUInt16LE(0);
  if (rootType !== RES_TABLE_TYPE) throw new Error('根 chunk 不是 RES_TABLE_TYPE(0x0002)，实际 0x' + rootType.toString(16));
  const rootHeaderSize = buf.readUInt16LE(2);
  const rootSize = buf.readUInt32LE(4);
  const packageCount = buf.readUInt32LE(8);
  log(`[table] headerSize=${rootHeaderSize} size=${rootSize} (file=${size}) packageCount=${packageCount}`);

  const chunks = [];       /* 顶层 chunk 树（证据用） */
  const packages = [];
  let globalPool = null;

  /* 文件头之后依次是：全局字符串池、若干 package chunk */
  let p = rootHeaderSize;
  while (p + 8 <= rootSize) {
    const type = buf.readUInt16LE(p);
    const headerSize = buf.readUInt16LE(p + 2);
    const csize = buf.readUInt32LE(p + 4);
    log(`[chunk] @0x${p.toString(16)} type=0x${type.toString(16)}(${TYPE_NAMES[type] || '?'}) headerSize=${headerSize} size=${csize}`);
    if (csize < 8 || p + csize > size) { log('  !! size 越界，停止'); break; }
    chunks.push({ type, headerSize, size: csize, off: p });

    if (type === RES_STRING_POOL_TYPE) {
      globalPool = readStringPool(buf, p, verbose);
      log(`  -> 全局字符串池 ${globalPool.stringCount} 条`);
    } else if (type === RES_TABLE_PACKAGE_TYPE) {
      packages.push(parsePackage(buf, p, csize, verbose));
    } else {
      log('  -> 跳过（未处理的顶层 chunk）');
    }
    p += csize;
  }

  /* 展开成扁平 entry 列表 */
  const entries = [];
  for (const pkg of packages) {
    for (const tname of Object.keys(pkg.types)) {
      const t = pkg.types[tname];
      for (const e of t.entries) {
        entries.push({
          pkg: pkg.name, pkgId: pkg.id, type: tname, typeId: t.typeId,
          index: e.index, name: e.name, id: e.id, field: makeFieldName(e.name),
          flags: e.flags, compact: !!e.compact, complex: !!(e.flags & FLAG_COMPLEX),
          dataType: e.dataType, dataTypeName: e.dataTypeName, data: e.data,
        });
      }
    }
  }
  entries.sort((a, b) => (a.id >>> 0) - (b.id >>> 0));

  const stats = {
    fileSize: size, packageCount, globalStringCount: globalPool ? globalPool.stringCount : 0,
    packages: packages.map((pk) => ({
      id: pk.id, name: pk.name, typeIdOffset: pk.typeIdOffset,
      typeCount: Object.keys(pk.types).length,
      entryCount: Object.keys(pk.types).reduce((n, k) => n + pk.types[k].entries.length, 0),
      typeNames: Object.keys(pk.types),
      /* typeName -> {typeId, entries}，用于核对「type 数没漏」 */
      typeIdCounts: Object.fromEntries(Object.keys(pk.types).map((k) => [k, { typeId: pk.types[k].typeId, entries: pk.types[k].entries.length }])),
      specCount: pk.specCount, typeChunks: pk.typeChunks, sparseTypeChunks: pk.sparseTypeChunks,
      keyStringCount: pk.keyStringCount,
    })),
    totalTypes: packages.reduce((n, pk) => n + Object.keys(pk.types).length, 0),
    totalEntries: entries.length,
  };
  return { packages, entries, chunks, globalPool, stats };
}

/** 解析一个 RES_TABLE_PACKAGE_TYPE chunk */
function parsePackage(buf, off, csize, verbose) {
  const log = verbose ? (m) => console.error(m) : () => {};
  const headerSize = buf.readUInt16LE(off + 2);
  const id = buf.readUInt32LE(off + 8);
  /* 名称是 128 个 UTF-16 字符 */
  let nameEnd = off + 12;
  while (nameEnd < off + 12 + 256 && buf.readUInt16LE(nameEnd) !== 0) nameEnd += 2;
  const name = buf.slice(off + 12, nameEnd).toString('utf16le');
  const typeStrings = buf.readUInt32LE(off + 12 + 256);
  const lastPublicType = buf.readUInt32LE(off + 12 + 256 + 4);
  const keyStrings = buf.readUInt32LE(off + 12 + 256 + 8);
  const lastPublicKey = buf.readUInt32LE(off + 12 + 256 + 12);
  /* headerSize >= 0x120 时多一个 typeIdOffset */
  const typeIdOffset = headerSize >= 0x120 ? buf.readUInt32LE(off + 12 + 256 + 16) : 0;
  log(`[package] id=0x${id.toString(16)} name="${name}" headerSize=${headerSize} typeIdOffset=${typeIdOffset}`);
  log(`  typeStrings@+0x${typeStrings.toString(16)} keyStrings@+0x${keyStrings.toString(16)} lastPublicType=${lastPublicType} lastPublicKey=${lastPublicKey}`);

  const typePool = readStringPool(buf, off + typeStrings, verbose);
  const keyPool = readStringPool(buf, off + keyStrings, verbose);
  log(`  typeStrings=${typePool.stringCount} keyStrings=${keyPool.stringCount}`);

  const types = {};       /* typeName -> {typeId, entries:[], specFlags} */
  let specCount = 0, typeChunks = 0, sparseTypeChunks = 0;

  /* package 内部子 chunk 从 off+headerSize 开始，到 off+csize 结束 */
  let p = off + headerSize;
  const end = off + csize;
  while (p + 8 <= end) {
    const type = buf.readUInt16LE(p);
    const chdr = buf.readUInt16LE(p + 2);
    const chsize = buf.readUInt32LE(p + 4);
    if (chsize < 8 || p + chsize > end) { log(`  !! package 内 chunk 越界 @0x${p.toString(16)}`); break; }
    if (type === RES_TABLE_TYPE_SPEC_TYPE) {
      specCount++;
      const id2 = buf[p + 8];
      const entryCount = buf.readUInt32LE(p + 12);
      const tname = makeTypeName(typePool.strings[id2 - 1] || ('type' + id2));
      log(`  [typeSpec] id=${id2}(${tname}) headerSize=${chdr} entryCount=${entryCount}`);
      if (!types[tname]) types[tname] = { typeId: id2 + typeIdOffset, typeIdRaw: id2, entries: [], specFlags: new Array(entryCount).fill(0) };
      types[tname].specEntryCount = entryCount;
      /* flags 数组在 header 之后，每个 uint32；只做统计用，这里不逐条存 */
    } else if (type === RES_TABLE_TYPE_TYPE) {
      typeChunks++;
      /* ResTable_type.flags 在 chunk+9；aapt2 的 FLAG_SPARSE=0x01 表示偏移表是 u16 对 */
      if (buf[p + 9] & FLAG_SPARSE) sparseTypeChunks++;
      parseType(buf, p, chsize, off, id, typeIdOffset, typePool, keyPool, types, verbose);
    } else if (type === RES_TABLE_LIBRARY_TYPE) {
      log(`  [library] @0x${p.toString(16)} size=${chsize}（跳过）`);
    } else {
      log(`  [package-child] @0x${p.toString(16)} type=0x${type.toString(16)} size=${chsize}（跳过）`);
    }
    p += chsize;
  }

  return { id, name, typeIdOffset, types, specCount, typeChunks, sparseTypeChunks, keyStringCount: keyPool.stringCount };
}

/**
 * 解析一个 RES_TABLE_TYPE_TYPE chunk：把该 config 下的 entry 名与 index 收进 types[typeName]。
 * ResTable_type 布局：
 *   0..7  ResChunk_header
 *   8     u8  id            （1 基，对应资源 id 的 type 位）
 *   9     u8  flags         （aapt2: FLAG_SPARSE=0x01）
 *   10    u16 reserved
 *   12    u32 entryCount
 *   16    u32 entriesStart  （相对本 chunk 起点）
 *   20..  ResTable_config
 *   headerSize.. : entryCount 个 u32 偏移（或 sparse 时 u16 idx + u16 offset/4）
 */
function parseType(buf, off, csize, pkgOff, pkgId, typeIdOffset, typePool, keyPool, types, verbose) {
  const log = verbose ? (m) => console.error(m) : () => {};
  const headerSize = buf.readUInt16LE(off + 2);
  const typeIdRaw = buf[off + 8];
  const flags = buf[off + 9];
  const entryCount = buf.readUInt32LE(off + 12);
  const entriesStart = buf.readUInt32LE(off + 16);
  const sparse = !!(flags & FLAG_SPARSE);
  const typeName = makeTypeName(typePool.strings[typeIdRaw - 1] || ('type' + typeIdRaw));
  const typeId = typeIdRaw + typeIdOffset;
  log(`  [type] id=${typeIdRaw}(${typeName}) dense=${sparse ? 'SPARSE' : 'u32'} entryCount=${entryCount} entriesStart=0x${entriesStart.toString(16)} headerSize=${headerSize} configSize=${headerSize - 20}`);

  if (!types[typeName]) types[typeName] = { typeId, typeIdRaw, entries: [], specFlags: [] };
  const bucket = types[typeName];
  bucket.typeId = typeId;
  const before = bucket.entries.length;
  const seen = new Set(bucket.entries.map((e) => e.index));

  const idxOff = off + headerSize;
  const dataBase = off + entriesStart;
  /* sparse 时偏移表是 entryCount 个 u16 对，占 [headerSize, entriesStart)；
   * 用 entriesStart 而不是 csize 兜底，否则 entryCount 撒谎时会读进 entry 数据区（合成测试实证）。 */
  const n = sparse
    ? Math.min(entryCount, Math.max(0, Math.floor((entriesStart - headerSize) / 4)))
    : entryCount;

  for (let i = 0; i < n; i++) {
    let entryIndex, entryOff;
    if (sparse) {
      entryIndex = buf.readUInt16LE(idxOff + i * 4);
      entryOff = buf.readUInt16LE(idxOff + i * 4 + 2) * 4;   /* sparse 偏移以 4 字节为单位 */
    } else {
      const v = buf.readUInt32LE(idxOff + i * 4);
      if (v === NO_ENTRY) continue;
      entryIndex = i;
      entryOff = v;
    }
    const eOff = dataBase + entryOff;
    if (eOff + 8 > off + csize) { log(`    !! entry ${entryIndex} 越界，跳过`); continue; }
    const eSize = buf.readUInt16LE(eOff);
    const eFlags = buf.readUInt16LE(eOff + 2);
    let keyIndex, dataType = -1, data = 0, compact = false;
    if (eFlags & FLAG_COMPACT) {
      /* ResTable_entry_compact: size 字段位置存 key index；flags 高 8 位是 dataType，+4 是 data */
      compact = true;
      keyIndex = eSize;
      dataType = (eFlags >> 8) & 0xff;
      data = buf.readUInt32LE(eOff + 4);
    } else {
      keyIndex = buf.readUInt32LE(eOff + 4);
      if (!(eFlags & FLAG_COMPLEX)) {
        /* 普通 entry：紧随 Res_value{u16 size,u8 res0,u8 dataType,u32 data} */
        if (eOff + 8 + 8 <= off + csize) {
          dataType = buf.readUInt32LE(eOff + 8) === 0 ? -1 : 0; /* 占位，下面按字节读 */
          dataType = buf[eOff + 8 + 3];
          data = buf.readUInt32LE(eOff + 8 + 4);
        }
      }
    }
    const name = keyPool.strings[keyIndex] !== undefined ? keyPool.strings[keyIndex] : null;
    if (name === null) { log(`    !! keyIndex=${keyIndex} 无对应 keyString，跳过`); continue; }
    if (seen.has(entryIndex)) continue;   /* 同一 entry 的其它 config，只记一次 */
    seen.add(entryIndex);
    const resId = ((pkgId & 0xff) << 24) | ((typeId & 0xff) << 16) | (entryIndex & 0xffff);
    bucket.entries.push({
      index: entryIndex, name, id: resId >>> 0, flags: eFlags, compact,
      dataType, data: data >>> 0,
      dataTypeName: VALUE_TYPE_NAMES[dataType] || (dataType < 0 ? '' : '?'),
    });
  }
  const pub = bucket.entries.filter((e) => e.flags & FLAG_PUBLIC).length;
  log(`     -> 累计 ${bucket.entries.length} 条 entry（本 chunk 新增 ${bucket.entries.length - before} / public=${pub}）`);
}

/* ------------------------------------------------------------------ 从 APK 取 arsc */
function extractArsc(apkPath) {
  const entries = readZip(apkPath);
  const e = entries.find((x) => x.name === 'resources.arsc');
  if (!e) throw new Error('APK 内找不到 resources.arsc');
  let data = e.raw;
  if (e.method === 8) data = zlib.inflateRawSync(data);
  else if (e.method !== 0) throw new Error('未知压缩方式 ' + e.method);
  if (e.usize && data.length !== e.usize) throw new Error(`解压后长度不符：${data.length} != ${e.usize}`);
  return { buf: data, entry: e, zipEntries: entries };
}

function parseApk(apkPath, opts) {
  const { buf, entry, zipEntries } = extractArsc(apkPath);
  const r = parseArsc(buf, opts);
  r.arscEntry = { name: entry.name, method: entry.method, csize: entry.csize, usize: entry.usize, crc: entry.crc, inflatedSize: buf.length };
  r.zipEntryCount = zipEntries.length;
  return r;
}

/* ------------------------------------------------------------------ 生成 R.java */
/**
 * 生成 R.java。只输出「可编译」的最小形态：
 *   package com.deepseek.harness;
 *   public final class R {
 *     public static final class drawable { public static final int ic_launcher = 0x7F020000; ... }
 *   }
 * 注意：不能带 private 构造器之外的任何依赖（不用 androidx、不用注解），否则 javac -bootclasspath android.jar 会挂。
 */
function renderRJava(parsed, opts) {
  opts = opts || {};
  const pkg = opts.packageName || 'com.deepseek.harness';
  const className = opts.className || 'R';
  const onlyPackages = opts.onlyPackages || null;      /* 例如 [0x7f] */
  const apps = parsed.packages.filter((p) => !onlyPackages || onlyPackages.includes(p.id));
  if (!apps.length) throw new Error('没有可输出的 package');

  /* 合并（正常情况下只有一个 0x7f 应用包）：typeName -> fieldName -> id */
  const merged = new Map();
  for (const p of apps) {
    for (const tname of Object.keys(p.types)) {
      const t = p.types[tname];
      if (!merged.has(tname)) merged.set(tname, { typeId: t.typeId, fields: new Map() });
      const m = merged.get(tname);
      for (const e of t.entries) {
        const f = makeFieldName(e.name);
        if (m.fields.has(f) && m.fields.get(f) !== e.id) {
          throw new Error(`字段冲突：${tname}.${f} = ${hex8(m.fields.get(f))} vs ${hex8(e.id)}`);
        }
        m.fields.set(f, e.id);
      }
    }
  }

  const typeNames = [...merged.keys()].sort((a, b) => {
    const ta = merged.get(a).typeId, tb = merged.get(b).typeId;
    return ta !== tb ? ta - tb : (a < b ? -1 : a > b ? 1 : 0);
  });

  const L = [];
  L.push('/* AUTO-GENERATED by selfbuild/lib/arsc-R.js —— 请勿手改。');
  L.push(' * 来源：selfbuild/work/base-v1.20.apk!/resources.arsc（与装机 APK 逐字节一致）。');
  L.push(' * 生成命令：node selfbuild/lib/arsc-R.js selfbuild/work/base-v1.20.apk --out selfbuild/work/gen/com/deepseek/harness/R.java');
  L.push(` * type 数：${typeNames.length}，entry 数：${typeNames.reduce((n, t) => n + merged.get(t).fields.size, 0)}`);
  L.push(' */');
  L.push(`package ${pkg};`);
  L.push('');
  L.push(`public final class ${className} {`);
  L.push(`    private ${className}() {}`);
  let nTypes = 0, nEntries = 0;
  for (const tname of typeNames) {
    const m = merged.get(tname);
    const fields = [...m.fields.keys()].sort();
    L.push('');
    L.push(`    public static final class ${tname} {`);
    L.push(`        private ${tname}() {}`);
    for (const f of fields) {
      L.push(`        public static final int ${f} = ${hex8(m.fields.get(f))};`);
      nEntries++;
    }
    L.push('    }');
    nTypes++;
  }
  L.push('}');
  L.push('');
  return { text: L.join('\n'), nTypes, nEntries, typeNames };
}

/** "type/name" -> id 的 Map（核对用） */
function entriesToMap(parsed) {
  const m = new Map();
  for (const e of parsed.entries) m.set(e.type + '/' + e.name, e.id);
  return m;
}
/** "type.name" -> id 的 Map（按 R.java 字段名，核对源码引用用） */
function entriesToFieldMap(parsed) {
  const m = new Map();
  for (const e of parsed.entries) m.set(e.type + '.' + e.field, e.id);
  return m;
}

/* ------------------------------------------------------------------ CLI */
function main(argv) {
  const apk = argv[2];
  if (!apk) { console.error('用法: node arsc-R.js <apk> [--dump] [--out R.java] [--package p] [--json f]'); process.exit(2); }
  const getFlag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const dump = argv.includes('--dump');
  const verbose = dump || argv.includes('--verbose');
  const parsed = parseApk(apk, { verbose });
  console.log(JSON.stringify(parsed.stats, null, 2));

  if (dump) {
    for (const e of parsed.entries) {
      console.log(`${e.type}/${e.name}`.padEnd(40) + ' ' + hex8(e.id) + `  typeId=${e.typeId} index=${e.index} flags=0x${e.flags.toString(16)}`);
    }
    console.log('# 文件名重写为字段名后的对照（仅列出与原名不同的）：');
    for (const e of parsed.entries) if (e.field !== e.name) console.log(`  ${e.type}/${e.name} -> R.${e.type}.${e.field}`);
  }
  const jsonOut = getFlag('--json');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ stats: parsed.stats, entries: parsed.entries }, null, 2));
  const out = getFlag('--out');
  if (out) {
    const onlyPkgs = argv.includes('--app-only') ? [0x7f] : null;
    const r = renderRJava(parsed, { packageName: getFlag('--package') || 'com.deepseek.harness', onlyPackages: onlyPkgs });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, r.text);
    console.log(`\n生成 ${out}: type=${r.nTypes} entry=${r.nEntries}`);
  }
}

if (require.main === module) main(process.argv);

module.exports = {
  parseArsc, parseApk, extractArsc, renderRJava, entriesToMap, entriesToFieldMap,
  readStringPool, makeFieldName, makeTypeName, hex8,
};
