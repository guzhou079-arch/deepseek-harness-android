'use strict';
// Unchanged entries keep their compressed bytes, method and CRC. STORE APK
// resources are aligned when the local headers are rebuilt.
const fs = require('node:fs');
const zlib = require('node:zlib');
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = b => { let c = -1; for (const v of b) c = CRC[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function readAt(fd, length, offset) {
  const b = Buffer.alloc(length); let n = 0;
  while (n < length) { const got = fs.readSync(fd, b, n, length - n, offset + n); if (!got) throw new Error('Truncated ZIP'); n += got; }
  return b;
}
function readZip(file, { load = true } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, 65557);
    const tail = readAt(fd, len, size - len); let end = -1;
    for (let i = len - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === len) { end = i; break; }
    if (end < 0) throw new Error('ZIP EOCD missing');
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Multi-disk ZIP unsupported');
    const count = tail.readUInt16LE(end + 10), cdSize = tail.readUInt32LE(end + 12), cdOff = tail.readUInt32LE(end + 16);
    if (count === 65535 || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new Error('ZIP64 unsupported');
    if (cdOff + cdSize > size - len + end) throw new Error('Invalid ZIP directory bounds');
    const cd = readAt(fd, cdSize, cdOff), entries = []; let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Invalid ZIP directory');
      const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16), csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), elen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32), lho = cd.readUInt32LE(p + 42);
      if (p + 46 + nlen + elen + clen > cd.length || lho + 30 > cdOff) throw new Error('Invalid ZIP entry bounds');
      const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
      const lh = readAt(fd, 30, lho);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP local header missing: ' + name);
      const ln = lh.readUInt16LE(26), le = lh.readUInt16LE(28), dataOffset = lho + 30 + ln + le;
      if (dataOffset + csize > cdOff || flags & 1) throw new Error('Invalid or encrypted ZIP entry: ' + name);
      const meta = { name, method, flags, crc, csize, usize, dataOffset,
        time: cd.readUInt16LE(p + 12), date: cd.readUInt16LE(p + 14),
        madeBy: cd.readUInt16LE(p + 4), externalAttrs: cd.readUInt32LE(p + 38), internalAttrs: cd.readUInt16LE(p + 36),
        localExtra: readAt(fd, le, lho + 30 + ln),
        centralExtra: Buffer.from(cd.subarray(p + 46 + nlen, p + 46 + nlen + elen)),
        comment: Buffer.from(cd.subarray(p + 46 + nlen + elen, p + 46 + nlen + elen + clen)) };
      if (load) meta.raw = readAt(fd, csize, dataOffset);
      entries.push(meta); p += 46 + nlen + elen + clen;
    }
    if (p !== cd.length) throw new Error('Unexpected ZIP directory data');
    return entries;
  } finally { fs.closeSync(fd); }
}
function readEntry(file, entry) {
  let raw = entry.raw;
  if (!raw) { const fd = fs.openSync(file, 'r'); try { raw = readAt(fd, entry.csize, entry.dataOffset); } finally { fs.closeSync(fd); } }
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('Unsupported ZIP method: ' + entry.method);
}
function writeZip(entries, out, when = new Date()) {
  // entries 可以是数组，也可以是**生成器**（内核树 200MB 不能全进堆，见 prep-kernel-payload.js）。
  // 所以条目数不能用 entries.length —— 生成器没有 length，写进 EOCD 会变成 0，
  // 读回来就是 "Unexpected ZIP directory data"。这里改成自己数。
  if (Array.isArray(entries) && entries.length >= 65535) throw new Error('ZIP64 required');
  const fd = fs.openSync(out, 'w'), central = []; let offset = 0, written = 0;
  const put = b => { let n = 0; while (n < b.length) n += fs.writeSync(fd, b, n, b.length - n); };
  const defaultTime = ((when.getHours() & 31) << 11) | ((when.getMinutes() & 63) << 5) | ((when.getSeconds() / 2) & 31);
  const defaultDate = (((when.getFullYear() - 1980) & 127) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  try {
    for (const e of entries) {
      const name = Buffer.from(e.name, 'utf8'); let { method, crc, csize, usize, raw } = e;
      // 2026-10-19：rawFile —— 大条目（如 155MB 的 payload.zip）分块从文件写，
      // 不整份读进堆。调用方必须给 crc 与 usize；本模式只能 STORE。
      if (!raw && e.rawFile) {
        if (typeof e.crc !== 'number' || typeof e.usize !== 'number') throw new Error('rawFile 需要调用方提供 crc/usize: ' + e.name);
        method = 0; crc = e.crc; usize = e.usize; csize = usize;
      }
      if (!raw && !e.rawFile) {
        const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
        crc = crc32(data); usize = data.length; const def = e.store ? null : zlib.deflateRawSync(data, { level: 9 });
        if (e.store || def.length >= data.length) { method = 0; raw = data; } else { method = 8; raw = def; }
        csize = raw.length;
      }
      if (![0, 8].includes(method) || (e.flags || 0) & 1) throw new Error('Unsupported ZIP entry: ' + e.name);
      let extra = e.localExtra || Buffer.alloc(0);
      const alignment = method !== 0 ? 1 : e.name === 'resources.arsc' ? 4 : /^lib\/.*\.so$/.test(e.name) ? 16384 : 4;
      if ((offset + 30 + name.length + extra.length) % alignment) {
        const padSize = (alignment - ((offset + 30 + name.length + extra.length + 4) % alignment)) % alignment;
        const pad = Buffer.alloc(4 + padSize); pad.writeUInt16LE(0xd935, 0); pad.writeUInt16LE(padSize, 2); extra = Buffer.concat([extra, pad]);
      }
      const ce = e.centralExtra || Buffer.alloc(0), comment = e.comment || Buffer.alloc(0);
      if ([name.length, extra.length, ce.length, comment.length].some(n => n > 65535)) throw new Error('ZIP field too large');
      const flags = ((e.flags || 0) | 0x800) & ~8, time = e.time ?? defaultTime, date = e.date ?? defaultDate;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(usize, 22);
      lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(extra.length, 28); put(lh); put(name); put(extra);
      if (e.rawFile) {
        const rfd = fs.openSync(e.rawFile, 'r');
        const CH = 4 << 20;
        try {
          for (let off = 0; off < csize; off += CH) put(readAt(rfd, Math.min(CH, csize - off), off));
        } finally { fs.closeSync(rfd); }
      } else put(raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(e.madeBy || 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10);
      ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(usize, 24);
      ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(ce.length, 30); ch.writeUInt16LE(comment.length, 32);
      ch.writeUInt16LE(e.internalAttrs || 0, 36); ch.writeUInt32LE(e.externalAttrs || 0, 38); ch.writeUInt32LE(offset, 42);
      central.push(ch, name, ce, comment); offset += 30 + name.length + extra.length + (raw ? raw.length : csize);
      if (++written >= 65535) throw new Error('ZIP64 required');
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    if (offset + cd.length > 0xffffffff) throw new Error('ZIP64 required');
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(written, 8); end.writeUInt16LE(written, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16); put(cd); put(end);
  } finally { fs.closeSync(fd); }
}
module.exports = { readZip, writeZip, readEntry, crc32 };
