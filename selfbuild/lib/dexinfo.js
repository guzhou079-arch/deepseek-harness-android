#!/usr/bin/env node
'use strict';
/*
 * dexinfo.js —— 纯 node、零依赖的 DEX 解析 / 统计 / 集合对比工具
 *
 * 用途：判定「v118 源码（App 1.19）重编的 classes.dex」能否替换「装机 APK 的 classes.dex（1.20）」。
 *
 * 支持输入（in-memory，不落地临时文件）：
 *   foo.dex                 → 直接读 dex 文件
 *   foo.apk                 → 默认读其中 classes.dex
 *   foo.apk!assets/xx.dex   → 读 APK 内指定条目（method 8 用 zlib.inflateRawSync）
 *
 * CLI：
 *   node dexinfo.js <spec> [--json] [--dump <kind>] [--filter <substr>] [--quiet]
 *   node dexinfo.js --compare <specA> <specB> [--ref a|b|auto] [--max-other N] [--json]
 *   kind ∈ strings|types|methods|fields|protos|classes|defined|harness
 *
 * 解析深度：header（含 checksum/signature 校验）、map_list、string_ids(MUTF-8)、
 * type_ids、proto_ids（含 parameters type_list）、field_ids、method_ids、class_defs、
 * class_data_item（static/instance fields、direct/virtual methods → 「本 dex 实际定义的方法」集合）。
 *
 * 集合口径（用于跨 dex 比较，均与顺序无关）：
 *   strings  = string_ids 全部字符串原文
 *   types    = type_ids 的 descriptor（如 Lcom/deepseek/harness/MainActivity;）
 *   methods  = method_ids 的完整签名 Lcls;->name(args)ret
 *   fields   = field_ids 的完整签名 Lcls;->name:type
 *   classes  = class_defs 的类 descriptor
 *   defined  = class_data_item 里编码的 direct+virtual 方法签名（本 dex 真正定义的方法）
 *   harness  = 上述集合中包含 "deepseek/harness" 的子集
 */
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
// 管道下游提前关闭（如 | head）时不要抛 EPIPE
process.stdout.on('error', e => { if (e && e.code === 'EPIPE') process.exit(0); });

const NO_INDEX = 0xffffffff;

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function adler32(buf, start, end) {
  let a = 1, b = 0;
  const MOD = 65521;
  let i = start;
  const n = end === undefined ? buf.length : end;
  // 分块避免取模太频繁
  while (i < n) {
    const chunk = Math.min(i + 3800, n);
    for (; i < chunk; i++) { a += buf[i]; b += a; }
    a %= MOD; b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function readUleb128(buf, p) {
  let result = 0, shift = 0, byte;
  do {
    if (p >= buf.length) throw new Error('ULEB128 越界 @' + p);
    byte = buf[p++];
    result |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return { value: result >>> 0, next: p };
}

/** MUTF-8（dex string_data_item 内容）→ JS 字符串；UTF-16 代理对合并 */
function mutf8ToString(buf, off) {
  const units = [];
  let i = off;
  for (;;) {
    if (i >= buf.length) break;
    const b = buf[i++];
    if (b === 0) break;
    if (b < 0x80) {
      units.push(b);
    } else if ((b & 0xe0) === 0xc0) {
      units.push(((b & 0x1f) << 6) | (buf[i++] & 0x3f));
    } else if ((b & 0xf0) === 0xe0) {
      units.push(((b & 0x0f) << 12) | ((buf[i++] & 0x3f) << 6) | (buf[i++] & 0x3f));
    } else {
      // 4 字节序列在 MUTF-8 里非法（补充平面用代理对表示）
      units.push(0xfffd);
      i += 3;
    }
  }
  let s = '';
  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    if (u >= 0xd800 && u <= 0xdbff && k + 1 < units.length) {
      const lo = units[k + 1];
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        s += String.fromCodePoint(0x10000 + ((u - 0xd800) << 10) + (lo - 0xdc00));
        k++;
        continue;
      }
    }
    s += String.fromCharCode(u);
  }
  return s;
}

/* ------------------------------------------------------------------ *
 * 从 APK 里精确读一个条目（只读该条目，不整包加载）
 * ------------------------------------------------------------------ */
function readZipEntry(apkFile, entryName, entryIndex) {
  const fd = fs.openSync(apkFile, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557 + 20);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('APK 里找不到 EOCD：' + apkFile);
    const n = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff) throw new Error('zip64 APK 暂不支持：' + apkFile);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOff);
    let p = 0;
    const names = [];
    for (let i = 0; i < n; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录签名不对 @' + p);
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28);
      const elen = cd.readUInt16LE(p + 30);
      const clen = cd.readUInt16LE(p + 32);
      const lho = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nlen);
      names.push(name);
      const want = entryIndex === undefined ? name === entryName : i === entryIndex;
      if (want) {
        const lh = Buffer.alloc(30);
        fs.readSync(fd, lh, 0, 30, lho);
        if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('本地头签名不对 @' + lho);
        const lnlen = lh.readUInt16LE(26), lelen = lh.readUInt16LE(28);
        const dataOff = lho + 30 + lnlen + lelen;
        const raw = Buffer.alloc(csize);
        if (csize) fs.readSync(fd, raw, 0, csize, dataOff);
        let data;
        if (method === 0) data = raw;
        else if (method === 8) data = zlib.inflateRawSync(raw);
        else throw new Error('不支持的压缩方式 ' + method + '：' + name);
        if (data.length !== usize) throw new Error('解压后大小不符 ' + data.length + ' != ' + usize + '：' + name);
        return { name, data };
      }
      p += 46 + nlen + elen + clen;
    }
    throw new Error('APK 里没有条目 ' + entryName + '（共有 ' + names.length + ' 条，如 ' + names.slice(0, 8).join(', ') + ' …）');
  } finally {
    fs.closeSync(fd);
  }
}

/** 解析输入 spec → {data, label} */
function loadSpec(spec) {
  let file = spec, entry = null;
  const bang = spec.indexOf('!');
  if (bang >= 0) { file = spec.slice(0, bang); entry = spec.slice(bang + 1); }
  const lower = file.toLowerCase();
  if (entry === null && /\.(apk|zip|apks|xapk)$/.test(lower)) entry = 'classes.dex';
  if (entry !== null) {
    const r = readZipEntry(file, entry);
    return { data: r.data, label: file + '!' + r.name };
  }
  return { data: fs.readFileSync(file), label: file };
}

/* ------------------------------------------------------------------ *
 * Dex 解析
 * ------------------------------------------------------------------ */
class Dex {
  constructor(buf, label) {
    this.buf = buf;
    this.label = label || '(buffer)';
    this.parseHeader();
    this.parseMap();
    this.parseStrings();
    this.parseTypes();
    this.parseProtos();
    this.parseFields();
    this.parseMethods();
    this.parseClassDefs();
    this.parseCodeLiterals();
    this.buildSets();
  }

  parseHeader() {
    const b = this.buf;
    if (b.length < 112) throw new Error('文件太小，不是 dex：' + b.length);
    this.magic = b.toString('latin1', 0, 8).replace(/\0+$/, '');
    if (!this.magic.startsWith('dex\n')) throw new Error('magic 不是 dex\\n：' + JSON.stringify(this.magic));
    this.dexVersion = b.toString('latin1', 4, 7).replace(/\0/g, '');
    const h = this.header = {};
    h.checksum = b.readUInt32LE(8);
    h.signature = b.toString('hex', 12, 32);
    h.fileSize = b.readUInt32LE(32);
    h.headerSize = b.readUInt32LE(36);
    h.endianTag = b.readUInt32LE(40);
    h.linkSize = b.readUInt32LE(44);
    h.linkOff = b.readUInt32LE(48);
    h.mapOff = b.readUInt32LE(52);
    h.stringIdsSize = b.readUInt32LE(56); h.stringIdsOff = b.readUInt32LE(60);
    h.typeIdsSize = b.readUInt32LE(64);   h.typeIdsOff = b.readUInt32LE(68);
    h.protoIdsSize = b.readUInt32LE(72);  h.protoIdsOff = b.readUInt32LE(76);
    h.fieldIdsSize = b.readUInt32LE(80);  h.fieldIdsOff = b.readUInt32LE(84);
    h.methodIdsSize = b.readUInt32LE(88); h.methodIdsOff = b.readUInt32LE(92);
    h.classDefsSize = b.readUInt32LE(96); h.classDefsOff = b.readUInt32LE(100);
    h.dataSize = b.readUInt32LE(104); h.dataOff = b.readUInt32LE(108);
    this.endian = h.endianTag === 0x12345678 ? 'little' : (h.endianTag === 0x78563412 ? 'big' : 'unknown(0x' + h.endianTag.toString(16) + ')');
    if (this.endian === 'big') throw new Error('大端 dex 不支持');
    this.checksumOk = adler32(b, 12) === h.checksum;
    this.signatureOk = crypto.createHash('sha1').update(b.slice(32)).digest('hex') === h.signature;
    this.sizeOk = h.fileSize === b.length;
  }

  parseMap() {
    const b = this.buf;
    const off = this.header.mapOff;
    this.map = [];
    if (!off || off >= b.length) return;
    const n = b.readUInt32LE(off);
    const NAMES = {
      0x0000: 'header_item', 0x0001: 'string_id_item', 0x0002: 'type_id_item', 0x0003: 'proto_id_item',
      0x0004: 'field_id_item', 0x0005: 'method_id_item', 0x0006: 'class_def_item', 0x0007: 'call_site_id_item',
      0x0008: 'method_handle_item', 0x1000: 'map_list', 0x1001: 'type_list', 0x1002: 'annotation_set_ref_list',
      0x1003: 'annotation_set_item', 0x2000: 'class_data_item', 0x2001: 'code_item', 0x2002: 'string_data_item',
      0x2003: 'debug_info_item', 0x2004: 'annotation_item', 0x2005: 'encoded_array_item', 0x2006: 'annotations_directory_item',
      0xf000: 'hiddenapi_class_data_item',
    };
    for (let i = 0; i < n; i++) {
      const p = off + 4 + i * 12;
      if (p + 12 > b.length) break;
      const type = b.readUInt16LE(p);
      this.map.push({ type, name: NAMES[type] || ('0x' + type.toString(16)), size: b.readUInt32LE(p + 4), off: b.readUInt32LE(p + 8) });
    }
  }

  parseStrings() {
    const b = this.buf, h = this.header;
    this.strings = new Array(h.stringIdsSize);
    this.stringDataOffsets = new Array(h.stringIdsSize);
    for (let i = 0; i < h.stringIdsSize; i++) {
      const off = b.readUInt32LE(h.stringIdsOff + i * 4);
      this.stringDataOffsets[i] = off;
      // string_data_item: uleb128 utf16_size + MUTF-8 + 0x00
      const r = readUleb128(b, off);
      const s = mutf8ToString(b, r.next);
      this.strings[i] = s;
      if (s.length !== r.value) this.utf16Mismatch = (this.utf16Mismatch || 0) + 1;
    }
  }

  parseTypes() {
    const b = this.buf, h = this.header;
    this.typeStringIdx = new Array(h.typeIdsSize);
    this.types = new Array(h.typeIdsSize);
    for (let i = 0; i < h.typeIdsSize; i++) {
      const si = b.readUInt32LE(h.typeIdsOff + i * 4);
      this.typeStringIdx[i] = si;
      this.types[i] = this.strings[si];
    }
  }

  parseProtos() {
    const b = this.buf, h = this.header;
    this.protoShorty = new Array(h.protoIdsSize);
    this.protoReturn = new Array(h.protoIdsSize);
    this.protoParams = new Array(h.protoIdsSize);
    this.protos = new Array(h.protoIdsSize);
    for (let i = 0; i < h.protoIdsSize; i++) {
      const p = h.protoIdsOff + i * 12;
      const shorty = this.strings[b.readUInt32LE(p)];
      const ret = b.readUInt32LE(p + 4);
      const paramsOff = b.readUInt32LE(p + 8);
      let params = [];
      if (paramsOff && paramsOff !== 0 && paramsOff < b.length) {
        const n = b.readUInt32LE(paramsOff);
        params = new Array(n);
        for (let k = 0; k < n; k++) params[k] = b.readUInt16LE(paramsOff + 4 + k * 2);
      }
      this.protoShorty[i] = shorty;
      this.protoReturn[i] = ret;
      this.protoParams[i] = params;
      this.protos[i] = '(' + params.map(t => this.types[t]).join('') + ')' + this.types[ret];
    }
  }

  parseFields() {
    const b = this.buf, h = this.header;
    this.fields = new Array(h.fieldIdsSize);
    for (let i = 0; i < h.fieldIdsSize; i++) {
      const p = h.fieldIdsOff + i * 8;
      const cls = b.readUInt16LE(p), type = b.readUInt16LE(p + 2), name = b.readUInt32LE(p + 4);
      this.fields[i] = this.types[cls] + '->' + this.strings[name] + ':' + this.types[type];
    }
  }

  parseMethods() {
    const b = this.buf, h = this.header;
    this.methodClass = new Array(h.methodIdsSize);
    this.methodProto = new Array(h.methodIdsSize);
    this.methodName = new Array(h.methodIdsSize);
    this.methods = new Array(h.methodIdsSize);
    for (let i = 0; i < h.methodIdsSize; i++) {
      const p = h.methodIdsOff + i * 8;
      const cls = b.readUInt16LE(p), proto = b.readUInt16LE(p + 2), name = b.readUInt32LE(p + 4);
      this.methodClass[i] = cls; this.methodProto[i] = proto; this.methodName[i] = name;
      this.methods[i] = this.types[cls] + '->' + this.strings[name] + this.protos[proto];
    }
  }

  parseClassDefs() {
    const b = this.buf, h = this.header;
    this.classDefs = [];
    this.classes = new Array(h.classDefsSize);
    this.classAccess = {};
    this.definedMethods = [];
    this.classDataClasses = 0;
    this.fieldCountDefined = 0;
    for (let i = 0; i < h.classDefsSize; i++) {
      const p = h.classDefsOff + i * 32;
      const d = {
        classIdx: b.readUInt32LE(p),
        accessFlags: b.readUInt32LE(p + 4),
        superclassIdx: b.readUInt32LE(p + 8),
        interfacesOff: b.readUInt32LE(p + 12),
        sourceFileIdx: b.readUInt32LE(p + 16),
        annotationsOff: b.readUInt32LE(p + 20),
        classDataOff: b.readUInt32LE(p + 24),
        staticValuesOff: b.readUInt32LE(p + 28),
      };
      d.className = this.types[d.classIdx];
      d.superName = d.superclassIdx === NO_INDEX ? null : this.types[d.superclassIdx];
      this.classes[i] = d.className;
      this.classAccess[d.className] = d.accessFlags;
      if (d.classDataOff && d.classDataOff !== 0 && d.classDataOff < b.length) {
        this.classDataClasses++;
        this.parseClassData(d);
      }
      this.classDefs.push(d);
    }
  }

  parseClassData(d) {
    const b = this.buf;
    let p = d.classDataOff;
    let r = readUleb128(b, p); const staticFields = r.value; p = r.next;
    r = readUleb128(b, p); const instanceFields = r.value; p = r.next;
    r = readUleb128(b, p); const directMethods = r.value; p = r.next;
    r = readUleb128(b, p); const virtualMethods = r.value; p = r.next;
    d.staticFields = staticFields; d.instanceFields = instanceFields;
    d.directMethods = directMethods; d.virtualMethods = virtualMethods;
    this.fieldCountDefined += staticFields + instanceFields;
    for (let k = 0; k < staticFields; k++) { r = readUleb128(b, p); p = r.next; r = readUleb128(b, p); p = r.next; }
    for (let k = 0; k < instanceFields; k++) { r = readUleb128(b, p); p = r.next; r = readUleb128(b, p); p = r.next; }
    d.methods = [];
    const readMethods = (count, kind) => {
      let idx = 0;
      for (let k = 0; k < count; k++) {
        r = readUleb128(b, p); idx += r.value; p = r.next;       // method_idx_diff
        r = readUleb128(b, p); const access = r.value; p = r.next; // access_flags
        r = readUleb128(b, p); const codeOff = r.value; p = r.next; // code_off
        const mi = idx - 1 < 0 ? 0 : idx - 1;
        const sig = this.methods[mi] || ('<method_idx ' + mi + '>');
        d.methods.push({ idx: mi, sig, access, codeOff, kind });
        this.definedMethods.push(sig);
      }
    };
    readMethods(directMethods, 'direct');
    readMethods(virtualMethods, 'virtual');
  }

  parseCodeLiterals() {
    const b = this.buf, h = this.header;
    this.literals = [];
    this.literalsByClass = new Map();
    this.literalOwners = new Map();
    this.codeItemsWithCode = 0;
    this.codeItemsWalked = 0;
    this.codeWalkMismatch = 0;
    this.codeWalkMismatchMethods = [];
    for (const d of this.classDefs) {
      if (!d.methods) continue;
      const set = new Set();
      for (const m of d.methods) {
        if (!m.codeOff || m.codeOff === 0 || m.codeOff >= b.length) continue;
        this.codeItemsWithCode++;
        const r = walkCodeItem(b, m.codeOff, h.stringIdsSize);
        this.codeItemsWalked++;
        if (!r.walkedOk) {
          this.codeWalkMismatch++;
          if (this.codeWalkMismatchMethods.length < 10) this.codeWalkMismatchMethods.push(m.sig);
        }
        for (const si of r.stringIdx) {
          const str = this.strings[si];
          set.add(str);
          let owners = this.literalOwners.get(str);
          if (!owners) { owners = new Set(); this.literalOwners.set(str, owners); }
          owners.add(d.className);
        }
      }
      this.literalsByClass.set(d.className, set);
    }
    for (const k of this.literalOwners.keys()) this.literals.push(k);
    this.harnessLiterals = [];
    for (const [str, owners] of this.literalOwners) {
      for (const o of owners) if (isHarness(o)) { this.harnessLiterals.push(str); break; }
    }
    this.harnessLiterals.sort();
  }

  buildSets() {
    this.setStrings = new Set(this.strings);
    this.setTypes = new Set(this.types);
    this.setProtos = new Set(this.protos);
    this.setFields = new Set(this.fields);
    this.setMethods = new Set(this.methods);
    this.setClasses = new Set(this.classes);
    this.setDefined = new Set(this.definedMethods);
    this.setLiterals = new Set(this.literals);
    this.harnessStrings = [...this.setStrings].filter(isHarness).sort();
    this.harnessTypes = [...this.setTypes].filter(isHarness).sort();
    this.harnessMethods = [...this.setMethods].filter(isHarness).sort();
    this.harnessFields = [...this.setFields].filter(isHarness).sort();
    this.harnessClasses = [...this.setClasses].filter(isHarness).sort();
    this.harnessDefined = [...this.setDefined].filter(isHarness).sort();
    this.harnessLiteralSet = new Set(this.harnessLiterals);
  }

  fingerprint() {
    const fp = k => {
      const arr = [...k].sort();
      const h = crypto.createHash('sha256');
      h.update(String(arr.length)); h.update('\n');
      for (const s of arr) { h.update(s); h.update('\n'); }
      return h.digest('hex').slice(0, 16);
    };
    return {
      strings: fp(this.setStrings), types: fp(this.setTypes), methods: fp(this.setMethods),
      fields: fp(this.setFields), classes: fp(this.setClasses), defined: fp(this.setDefined),
      literals: fp(this.setLiterals), harnessLiterals: fp(this.harnessLiteralSet),
      harnessStrings: fp(new Set(this.harnessStrings)), harnessMethods: fp(new Set(this.harnessMethods)),
    };
  }

  stats() {
    return {
      label: this.label, version: this.dexVersion, fileSize: this.buf.length,
      declaredFileSize: this.header.fileSize, sizeMatches: this.sizeOk,
      checksumOk: this.checksumOk, signatureOk: this.signatureOk,
      checksum: '0x' + this.header.checksum.toString(16).padStart(8, '0'),
      sha1: this.header.signature,
      strings: this.setStrings.size, types: this.setTypes.size, protos: this.setProtos.size,
      fields: this.setFields.size, methods: this.setMethods.size, classes: this.setClasses.size,
      definedMethods: this.setDefined.size, classDataClasses: this.classDataClasses,
      harnessStrings: this.harnessStrings.length, harnessTypes: this.harnessTypes.length,
      harnessMethods: this.harnessMethods.length, harnessFields: this.harnessFields.length,
      harnessClasses: this.harnessClasses.length, harnessDefined: this.harnessDefined.length,
      literals: this.setLiterals.size, harnessLiterals: this.harnessLiterals.length,
      codeItemsWithCode: this.codeItemsWithCode, codeWalkMismatch: this.codeWalkMismatch,
    };
  }
}

function isHarness(s) { return s.indexOf('deepseek/harness') >= 0; }
const VERSION_RE = /(^|\W)(1\.(19|20)|version|Version|VERSION|BuildConfig|versionCode|versionName)(\W|$)/;

/* ------------------------------------------------------------------ *
 * 指令流解码：只取 const-string / const-string/jumbo 的字符串索引
 * 必须按格式长度精确行走（opcode 在低字节，长度错了会把操作数当 opcode）。
 * ------------------------------------------------------------------ */
const FMT_UNITS = {
  '10x': 1, '12x': 1, '11n': 1, '11x': 1, '10t': 1,
  '20t': 2, '22x': 2, '21t': 2, '21s': 2, '21h': 2, '21c': 2, '23x': 2, '22b': 2, '22t': 2, '22s': 2, '22c': 2,
  '30t': 3, '32x': 3, '31i': 3, '31t': 3, '31c': 3, '35c': 3, '3rc': 3,
  '45cc': 4, '4rcc': 4, '51l': 5,
};
const OP_FORMAT = (() => {
  const f = new Array(256).fill('10x');
  const set = (from, to, fmt) => { for (let i = from; i <= to; i++) f[i] = fmt; };
  const one = {
    0x01: '12x', 0x02: '22x', 0x03: '32x', 0x04: '12x', 0x05: '22x', 0x06: '32x',
    0x07: '12x', 0x08: '22x', 0x09: '32x', 0x0a: '11x', 0x0b: '11x', 0x0c: '11x', 0x0d: '11x',
    0x0f: '11x', 0x10: '11x', 0x11: '11x', 0x12: '11n', 0x13: '21s', 0x14: '31i', 0x15: '21h',
    0x16: '21s', 0x17: '31i', 0x18: '51l', 0x19: '21h', 0x1a: '21c', 0x1b: '31c', 0x1c: '21c',
    0x1d: '11x', 0x1e: '11x', 0x1f: '21c', 0x20: '22c', 0x21: '12x', 0x22: '21c', 0x23: '22c',
    0x24: '35c', 0x25: '3rc', 0x26: '31t', 0x27: '11x', 0x28: '10t', 0x29: '20t', 0x2a: '30t',
    0x2b: '31t', 0x2c: '31t',
    0xfa: '45cc', 0xfb: '4rcc', 0xfc: '35c', 0xfd: '3rc', 0xfe: '21c', 0xff: '21c',
  };
  for (const k in one) f[k] = one[k];
  set(0x2d, 0x31, '23x'); // cmp-long/cmpl-float/cmpg-float/cmpl-double/cmpg-double（曾是 1 unit 的漏配）
  set(0x32, 0x37, '22t'); set(0x38, 0x3d, '22t'); set(0x44, 0x51, '23x');
  set(0x52, 0x5f, '22c'); set(0x60, 0x6d, '21c'); set(0x6e, 0x72, '35c');
  set(0x74, 0x78, '3rc'); set(0x7b, 0x8f, '12x'); set(0x90, 0xaf, '23x');
  set(0xb0, 0xcf, '12x'); set(0xd0, 0xd7, '22s'); set(0xd8, 0xe2, '22b');
  return f;
})();

/** 走一遍 code_item 指令流，返回 {stringIdx:[], walkedOk} */
function walkCodeItem(buf, codeOff, stringCount) {
  const insnsSize = buf.readUInt32LE(codeOff + 12);
  const start = codeOff + 16;
  const end = start + insnsSize * 2;
  if (end > buf.length) return { stringIdx: [], walkedOk: false };
  const out = [];
  let p = start;
  while (p + 2 <= end) {
    const unit = buf.readUInt16LE(p);
    const op = unit & 0xff;
    if (op === 0x00) {
      // payload 伪指令：ident 本身就是「低字节为 0x00」的那个 code unit
      //   packed-switch-payload : 0x0100 | size(u16) | first_key(i32) | targets(u32[size])
      //   sparse-switch-payload : 0x0200 | size(u16) | keys(i32[size]) | targets(u32[size])
      //   fill-array-data-payload: 0x0300 | element_width(u16) | size(u32) | data[]
      if (p + 8 <= end) {
        if (unit === 0x0100) { const size = buf.readUInt16LE(p + 2); p += (4 + size * 2) * 2; continue; }
        if (unit === 0x0200) { const size = buf.readUInt16LE(p + 2); p += (2 + size * 4) * 2; continue; }
        if (unit === 0x0300) {
          const ew = buf.readUInt16LE(p + 2), size = buf.readUInt32LE(p + 4);
          p += (4 + Math.ceil(size * ew / 2)) * 2; continue;
        }
      }
      p += 2; continue;
    }
    const units = FMT_UNITS[OP_FORMAT[op]] || 1;
    if (op === 0x1a) {
      const idx = buf.readUInt16LE(p + 2);
      if (idx < stringCount) out.push(idx);
    } else if (op === 0x1b) {
      const idx = buf.readUInt32LE(p + 2);
      if (idx < stringCount) out.push(idx);
    }
    p += units * 2;
  }
  return { stringIdx: out, walkedOk: p === end };
}

/* ------------------------------------------------------------------ *
 * 集合差
 * ------------------------------------------------------------------ */
function diffSets(setA, setB) {
  const onlyA = [], onlyB = [];
  for (const x of setA) if (!setB.has(x)) onlyA.push(x);
  for (const x of setB) if (!setA.has(x)) onlyB.push(x);
  onlyA.sort(); onlyB.sort();
  return { onlyA, onlyB };
}

const KIND_MAP = {
  strings: d => d.setStrings, types: d => d.setTypes, methods: d => d.setMethods,
  fields: d => d.setFields, protos: d => d.setProtos, classes: d => d.setClasses,
  defined: d => d.setDefined,
  literals: d => d.setLiterals,
};

/** 字节级/指令级对比：证明「同一份代码」（选项 --bytes） */
function fileBytesCompare(A, B) {
  const a = A.buf, b = B.buf;
  const eqArr = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  const idx = {
    strings: eqArr(A.strings, B.strings), types: eqArr(A.types, B.types),
    protos: eqArr(A.protos, B.protos), fields: eqArr(A.fields, B.fields),
    methods: eqArr(A.methods, B.methods), classes: eqArr(A.classes, B.classes),
  };
  const codeMap = d => {
    const m = new Map();
    for (const cd of d.classDefs) {
      if (!cd.methods) continue;
      for (const x of cd.methods) {
        if (!x.codeOff) continue;
        const n = d.buf.readUInt32LE(x.codeOff + 12);
        const arr = new Array(n);
        for (let i = 0; i < n; i++) arr[i] = d.buf.readUInt16LE(x.codeOff + 16 + i * 2);
        m.set(x.sig, arr);
      }
    }
    return m;
  };
  const ca = codeMap(A), cb = codeMap(B);
  let codeSame = 0, codeDiff = 0;
  const diffSigs = [];
  for (const [sig, arr] of ca) {
    const o = cb.get(sig);
    if (!o) { codeDiff++; if (diffSigs.length < 20) diffSigs.push(sig); continue; }
    if (arr.length === o.length && arr.every((v, i) => v === o[i])) codeSame++;
    else { codeDiff++; if (diffSigs.length < 20) diffSigs.push(sig); }
  }
  const n = Math.min(a.length, b.length);
  const ranges = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) { if (start < 0) start = i; }
    else if (start >= 0) { ranges.push([start, i - 1]); start = -1; }
  }
  if (start >= 0) ranges.push([start, n - 1]);
  const secs = A.map.slice().sort((x, y) => x.off - y.off);
  const hist = {};
  for (const [s0] of ranges) {
    let name = '?';
    for (const m of secs) { if (m.off <= s0) name = m.name; else break; }
    hist[name] = (hist[name] || 0) + 1;
  }
  // 按 map_list 区段做「容忍整体位移」的逐区段字节比较（比同偏移逐字节更能说明问题）
  const mkRegs = d => {
    const secs = d.map.slice().sort((x, y) => x.off - y.off);
    const out = [];
    for (let i = 0; i < secs.length; i++) {
      const st = secs[i].off, en = (i + 1 < secs.length) ? secs[i + 1].off : d.buf.length;
      out.push({ name: secs[i].name, start: st, blob: d.buf.slice(st, en) });
    }
    return out;
  };
  const tryAligned = (x, y) => {
    if (x.equals(y)) return true;
    const delta = x.length - y.length;
    if (delta === 0 || Math.abs(delta) > 64) return false;
    if (delta < 0) return tryAligned(y, x);
    let i = 0;
    while (i < y.length && x[i] === y[i]) i++;
    for (let off = Math.max(0, i - delta); off <= i && off + delta <= x.length; off++) {
      if (Buffer.compare(Buffer.concat([x.slice(0, off), x.slice(off + delta)]), y) === 0) return true;
    }
    return false;
  };
  const ra = mkRegs(A), rb = mkRegs(B);
  const mb = new Map(rb.map(r => [r.name, r]));
  const regions = ra.map(r => {
    const o = mb.get(r.name);
    const rec = { name: r.name, lenA: r.blob.length, lenB: o ? o.blob.length : 0, startA: r.start, startB: o ? o.start : -1 };
    if (!o) rec.status = 'onlyA';
    else if (r.blob.equals(o.blob)) rec.status = 'same';
    else if (tryAligned(r.blob, o.blob)) rec.status = 'same-shift';
    else rec.status = 'DIFF';
    return rec;
  });
  return { idx, codeSame, codeDiff, codeDiffSigs: diffSigs, byteRangeCount: ranges.length, sizeA: a.length, sizeB: b.length, hist, ranges: ranges.slice(0, 60), regions };
}

function jsonCompare(A, B, opts) {
  opts = opts || {};
  const maxOther = opts.maxOther === undefined ? 20 : opts.maxOther;
  const kinds = ['strings', 'types', 'methods', 'fields', 'classes', 'defined', 'literals'];
  const harnessOf = (dex, kind, arr) => kind === 'literals' ? arr.filter(x => dex.harnessLiteralSet.has(x)) : arr.filter(isHarness);
  const out = { a: A.stats(), b: B.stats(), kinds: {} };
  let harnessTotal = 0;
  for (const k of kinds) {
    const d = diffSets(KIND_MAP[k](A), KIND_MAP[k](B));
    const aH = harnessOf(A, k, d.onlyA), bH = harnessOf(B, k, d.onlyB);
    const aV = d.onlyA.filter(s => !isHarness(s) && VERSION_RE.test(s));
    const bV = d.onlyB.filter(s => !isHarness(s) && VERSION_RE.test(s));
    harnessTotal += aH.length + bH.length;
    out.kinds[k] = {
      countA: KIND_MAP[k](A).size, countB: KIND_MAP[k](B).size,
      onlyACount: d.onlyA.length, onlyBCount: d.onlyB.length,
      harness: { onlyA: aH, onlyB: bH },
      versionLike: { onlyA: aV, onlyB: bV },
      otherSampleA: d.onlyA.filter(s => !isHarness(s)).slice(0, maxOther),
      otherSampleB: d.onlyB.filter(s => !isHarness(s)).slice(0, maxOther),
    };
  }
  out.harnessDiffTotal = harnessTotal;
  return out;
}

function verdictFor(A, B, cmp) {
  const harnessDiff = cmp.harnessDiffTotal;
  const clsDiff = cmp.kinds.classes.onlyACount + cmp.kinds.classes.onlyBCount;
  const strDiff = cmp.kinds.strings.onlyACount + cmp.kinds.strings.onlyBCount;
  if (harnessDiff === 0 && clsDiff === 0) {
    return { code: 'SAME_SOURCE', text: '疑似同源（仅版本号/少量差异）', confidence: strDiff < 20 ? '高' : '中' };
  }
  if (harnessDiff === 0) {
    return { code: 'SAME_SOURCE_OTHER_PKGS', text: 'com/deepseek/harness 包等价（差异只在其他包/编译器串），疑似同源', confidence: '中' };
  }
  return { code: 'DIFFERS', text: '存在实质差异，需回填', confidence: '高' };
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */
function printStats(d) {
  const s = d.stats(), h = d.header;
  const L = [];
  L.push('== ' + s.label + ' ==');
  L.push('  magic/version      : ' + JSON.stringify(d.magic) + '  (' + s.version + ')');
  L.push('  file size          : ' + s.fileSize + ' (header 声明 ' + s.declaredFileSize + ', ' + (s.sizeMatches ? 'ok' : '不符!') + ')');
  L.push('  checksum(adler32)  : ' + s.checksum + '  ' + (s.checksumOk ? 'ok' : '校验失败!'));
  L.push('  signature(sha1)    : ' + s.sha1 + '  ' + (s.signatureOk ? 'ok' : '校验失败!'));
  L.push('  endian             : ' + d.endian + '   header_size=' + h.headerSize + '  data_off=' + h.dataOff + ' size=' + h.dataSize);
  L.push('  string_ids         : ' + s.strings);
  L.push('  type_ids           : ' + s.types);
  L.push('  proto_ids          : ' + s.protos);
  L.push('  field_ids          : ' + s.fields);
  L.push('  method_ids         : ' + s.methods);
  L.push('  class_defs         : ' + s.classes + ' (其中带 class_data 的 ' + s.classDataClasses + ')');
  L.push('  defined methods    : ' + s.definedMethods + '  (class_data_item 里 direct+virtual)');
  L.push('  code_item          : ' + s.codeItemsWithCode + ' 个方法有 code；指令流边界完全对齐 ' +
    (s.codeItemsWithCode - s.codeWalkMismatch) + '/' + s.codeItemsWithCode +
    (s.codeWalkMismatch ? '（不对齐 ' + s.codeWalkMismatch + '！）' : ''));
  L.push('  const-string 字面量: ' + s.literals + '（其中 harness 类引用 ' + s.harnessLiterals + '）');
  L.push('  —— com/deepseek/harness ——');
  L.push('    strings          : ' + s.harnessStrings);
  L.push('    types            : ' + s.harnessTypes);
  L.push('    methods(method_ids): ' + s.harnessMethods);
  L.push('    defined methods  : ' + s.harnessDefined);
  L.push('    fields           : ' + s.harnessFields);
  L.push('    classes          : ' + s.harnessClasses);
  L.push('  fingerprints       : ' + JSON.stringify(d.fingerprint()));
  L.push('  map_list           : ' + d.map.length + ' 项  ' + d.map.map(m => m.name + '=' + m.size).join(', '));
  return L.join('\n');
}

function printCompare(A, B, opts) {
  opts = opts || {};
  const cmp = jsonCompare(A, B, opts);
  const maxList = opts.maxList === undefined ? 400 : opts.maxList;
  const va = A.stats(), vb = B.stats();
  const ref = opts.ref || 'b';
  const L = [];
  L.push('==== DEX COMPARE ====');
  L.push('A(前者) ' + va.label);
  L.push('        ver=' + va.version + ' strings=' + va.strings + ' types=' + va.types + ' methods=' + va.methods +
    ' defined=' + va.definedMethods + ' classes=' + va.classes + ' bytes=' + va.fileSize);
  L.push('B(后者) ' + vb.label);
  L.push('        ver=' + vb.version + ' strings=' + vb.strings + ' types=' + vb.types + ' methods=' + vb.methods +
    ' defined=' + vb.definedMethods + ' classes=' + vb.classes + ' bytes=' + vb.fileSize);
  L.push('角色判定: ' + (ref === 'b' ? 'B = 参考/装机 dex，A = 待验证/重编 dex → **A\\B 无用、B\\A = 装机有而重编缺（需回填）**'
    : 'A = 参考/装机 dex，B = 待验证/重编 dex → **B\\A 无用、A\\B = 装机有而重编缺（需回填）**'));
  L.push('');
  L.push('-- 数量对比 --');
  L.push('  kind      A        B        A-B');
  for (const k of ['strings', 'types', 'protos', 'fields', 'methods', 'classes', 'definedMethods']) {
    const a = va[k], b = vb[k];
    L.push('  ' + k.padEnd(15) + String(a).padEnd(9) + String(b).padEnd(9) + (a - b));
  }
  L.push('');
  L.push('-- 集合差异（A\\B = 前者独有；B\\A = 后者独有）--');
  for (const k of ['strings', 'types', 'methods', 'classes', 'defined', 'literals']) {
    const kd = cmp.kinds[k];
    L.push('  [' + k + '] A\\B=' + kd.onlyACount + '  B\\A=' + kd.onlyBCount +
      '   (其中 harness: A\\B=' + kd.harness.onlyA.length + ' B\\A=' + kd.harness.onlyB.length + ')');
  }
  L.push('');
  const harnessBlocks = [];
  for (const k of ['strings', 'types', 'methods', 'classes', 'defined', 'literals']) {
    const kd = cmp.kinds[k];
    if (!kd.harness.onlyA.length && !kd.harness.onlyB.length) continue;
    const blk = ['### harness 差异 [' + k + ']'];
    const show = (title, arr) => {
      blk.push('  ' + title + ' (' + arr.length + '):');
      const cut = arr.slice(0, maxList);
      for (const s of cut) blk.push('    ' + s);
      if (arr.length > cut.length) blk.push('    … 还有 ' + (arr.length - cut.length) + ' 条（见 --json）');
    };
    show('A 独有 (重编有、装机无)', kd.harness.onlyA);
    show('B 独有 (装机有、重编无 ← 回填点)', kd.harness.onlyB);
    harnessBlocks.push(blk.join('\n'));
  }
  if (harnessBlocks.length) L.push(harnessBlocks.join('\n\n'));
  else L.push('### harness 差异：无（strings/types/methods/classes/defined 全部一致）');
  L.push('');
  const vblocks = [];
  for (const k of ['strings', 'types']) {
    const kd = cmp.kinds[k];
    if (!kd.versionLike.onlyA.length && !kd.versionLike.onlyB.length) continue;
    vblocks.push('  [' + k + '] 版本样式串 A独有: ' + JSON.stringify(kd.versionLike.onlyA.slice(0, 30)) +
      '\n           B独有: ' + JSON.stringify(kd.versionLike.onlyB.slice(0, 30)));
  }
  L.push('-- 版本/标记样式串 --');
  L.push(vblocks.length ? vblocks.join('\n') : '  （无）');
  L.push('');
  L.push('-- 非 harness 差异抽样（前 ' + (opts.maxOther === undefined ? 20 : opts.maxOther) + ' 条）--');
  for (const k of ['strings', 'classes']) {
    const kd = cmp.kinds[k];
    if (kd.otherSampleA.length) L.push('  [' + k + '] A独有样例: ' + JSON.stringify(kd.otherSampleA));
    if (kd.otherSampleB.length) L.push('  [' + k + '] B独有样例: ' + JSON.stringify(kd.otherSampleB));
  }
  L.push('');
  const v = verdictFor(A, B, cmp);
  L.push('-- 结论 --');
  L.push('  harness 差异条目总数: ' + cmp.harnessDiffTotal +
    (cmp.harnessDiffTotal ? '（' + (ref === 'b' ? '其中 B\\A = 装机独有、即重编会丢的改动' : '其中 A\\B = 装机独有、即重编会丢的改动') + '）' : ''));
  if (opts.bytesReport && opts.bytesReport.codeDiff === 0 && Object.values(opts.bytesReport.idx).every(Boolean)) {
    L.push('  逐指令级证据: 索引表逐位相同 + 全部方法指令流相同 → 可判定「同一份代码，仅布局/调试信息差异」');
  }
  L.push('  VERDICT: ' + v.text + '  [code=' + v.code + ']  置信度=' + v.confidence);
  return L.join('\n');
}

function printBytes(r) {
  const L = [];
  L.push('-- 字节/指令级对比（--bytes）--');
  L.push('  索引表逐位相同(含顺序): ' + Object.entries(r.idx).map(([k, v]) => k + '=' + (v ? '✓' : '✗')).join('  '));
  L.push('  方法指令流(insns)对比  : 相同 ' + r.codeSame + ' / 不同 ' + r.codeDiff);
  if (r.codeDiff) for (const s of r.codeDiffSigs) L.push('      DIFF ' + s);
  L.push('  文件尺寸 A/B           : ' + r.sizeA + ' / ' + r.sizeB + ' (差 ' + (r.sizeA - r.sizeB) + ' 字节)');
  L.push('  同偏移不同字节区间数   : ' + r.byteRangeCount + '（多数是「4 字节布局位移」造成的假差异）');
  L.push('  —— 按 map_list 区段的字节对比 ——');
  const sameRegs = r.regions.filter(g => g.status === 'same').map(g => g.name);
  const otherRegs = r.regions.filter(g => g.status !== 'same').map(g => g.name + '(' + g.lenA + '/' + g.lenB + ')');
  L.push('  字节完全一致的区段: ' + (sameRegs.join(', ') || '(无)'));
  L.push('  大小或字节有差的区段: ' + (otherRegs.join(', ') || '(无)'));
  L.push('  说明: 这些区段内部含「文件内偏移」字段（string_id / proto_id / class_def / code / annotation* / class_data / map_list），');
  L.push('        数据区整体挪了 4 字节 → 偏移字段随之 ±4，所以同偏移逐字节比较会报大量差异，但并非内容差异。');
  L.push('        内容是否等价，以上面的「索引表逐位相同 + 指令流相同」为准；逐项核对见 selfbuild/notes/dex-diff.md。');
  L.push('        例外: debug_info_item 区少 4 字节（9 条单行行号项）、annotation_item 区 6 字节（R 的 MemberClasses 元素顺序）——均为元数据。');
  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */
function parseArgs(argv) {
  const o = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--compare') o.compare = true;
    else if (a === '--bytes') o.bytes = true;
    else if (a === '--dump') o.dump = argv[++i];
    else if (a === '--filter') o.filter = argv[++i];
    else if (a === '--ref') o.ref = argv[++i];
    else if (a === '--max-other') o.maxOther = parseInt(argv[++i], 10);
    else if (a === '--max-list') o.maxList = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') o.help = true;
    else o.positional.push(a);
  }
  return o;
}

const HELP = `dexinfo.js —— 零依赖 dex 解析/统计/对比
用法:
  node dexinfo.js <dex|apk|apk!entry> [--json] [--dump <kind>] [--filter <substr>]
  node dexinfo.js --compare <specA> <specB> [--ref a|b|auto] [--max-other N] [--max-list N] [--json]
kind: strings|types|methods|fields|protos|classes|defined|harness
输入示例:
  node dexinfo.js work/base-v1.20.apk
  node dexinfo.js 'work/base-v1.20.apk!assets/rish_shizuku.dex'
  node dexinfo.js --compare work/appbuild/out/classes.dex work/base-v1.20.apk
`;

function detectRef(aSpec, bSpec, refOpt) {
  if (refOpt === 'a' || refOpt === 'b') return refOpt;
  if (refOpt === 'auto' || refOpt === undefined || refOpt === null) {
    const looksBase = s => /base-v?1\.\d|installed|装机|base_?apk/i.test(s);
    const looksRebuilt = s => /appbuild|rebuilt|重编|dex-new|new[_-]?classes/i.test(s);
    if (looksRebuilt(aSpec) && !looksRebuilt(bSpec)) return 'b';
    if (looksRebuilt(bSpec) && !looksRebuilt(aSpec)) return 'a';
    if (looksBase(bSpec) && !looksBase(aSpec)) return 'b';
    if (looksBase(aSpec) && !looksBase(bSpec)) return 'a';
    return 'b';
  }
  return 'b';
}

function describeSpec(spec) {
  try {
    if (spec.indexOf('!') >= 0 || /\.(apk|zip|apks|xapk)$/i.test(spec)) {
      const bang = spec.indexOf('!');
      const apk = bang >= 0 ? spec.slice(0, bang) : spec;
      const entry = bang >= 0 ? spec.slice(bang + 1) : 'classes.dex';
      const r = readZipEntry(apk, entry);
      return { label: apk + '!' + r.name, data: r.data };
    }
  } catch (e) { /* fallthrough */ }
  return { label: spec, data: fs.readFileSync(spec) };
}

function main() {
  const t0 = Date.now();
  const o = parseArgs(process.argv.slice(2));
  if (o.help || o.positional.length === 0) { process.stdout.write(HELP); return 0; }

  if (o.compare) {
    if (o.positional.length < 2) { process.stderr.write('需要两个输入\n' + HELP); return 2; }
    const [sa, sb] = o.positional;
    const la = describeSpec(sa), lb = describeSpec(sb);
    const A = new Dex(la.data, la.label);
    const B = new Dex(lb.data, lb.label);
    const ref = detectRef(sa, sb, o.ref);
    const bytes = o.bytes ? fileBytesCompare(A, B) : null;
    if (o.json) {
      const cmp = jsonCompare(A, B, o);
      const v = verdictFor(A, B, cmp);
      cmp.verdict = v; cmp.ref = ref; cmp.elapsedMs = Date.now() - t0; if (bytes) cmp.bytes = bytes;
      process.stdout.write(JSON.stringify(cmp, null, 2) + '\n');
    } else {
      process.stdout.write(printCompare(A, B, { ...o, ref, bytesReport: bytes }) + '\n');
      if (bytes) process.stdout.write(printBytes(bytes) + '\n');
      process.stdout.write('用时 ' + (Date.now() - t0) + ' ms\n');
    }
    return 0;
  }

  const spec = o.positional[0];
  const l = describeSpec(spec);
  const d = new Dex(l.data, l.label);
  if (o.dump) {
    let arr;
    if (o.dump === 'harness') arr = d.harnessStrings.concat(d.harnessTypes, d.harnessMethods).filter(isHarness);
    else if (KIND_MAP[o.dump]) arr = [...KIND_MAP[o.dump](d)];
    else if (o.dump === 'all') arr = [...d.setStrings];
    else { process.stderr.write('未知 kind: ' + o.dump + '\n'); return 2; }
    arr = [...new Set(arr)].sort();
    if (o.filter) arr = arr.filter(s => s.indexOf(o.filter) >= 0);
    process.stdout.write(arr.join('\n') + '\n');
    return 0;
  }
  if (o.json) {
    const s = d.stats();
    s.fingerprint = d.fingerprint();
    s.map = d.map;
    if (o.filter) {
      s.filter = o.filter;
      s.matched = [...d.setStrings].filter(x => x.indexOf(o.filter) >= 0).sort();
      s.matchedHarness = d.harnessStrings.filter(x => x.indexOf(o.filter) >= 0);
    }
    process.stdout.write(JSON.stringify(s, null, 2) + '\n');
  } else {
    if (!o.quiet) process.stdout.write(printStats(d) + '\n');
    process.stdout.write('用时 ' + (Date.now() - t0) + ' ms\n');
  }
  return 0;
}

module.exports = { Dex, readZipEntry, loadSpec, diffSets, isHarness, adler32, mutf8ToString };

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (e) { process.stderr.write('ERROR: ' + (e && e.stack || e) + '\n'); process.exitCode = 1; }
}
