'use strict';
// Binary Android XML editor. Existing string indices, style spans and unknown
// chunks remain intact; added attributes receive framework resource IDs.
const NS = 'http://schemas.android.com/apk/res/android';
const NONE = 0xffffffff;
const IDS = { name: 0x01010003, exported: 0x01010010, launchMode: 0x0101001d, mimeType: 0x01010026, versionCode: 0x0101021b, versionName: 0x0101021c };
function invariant(ok, message) { if (!ok) throw new Error(message); }
function chunks(b, start = b.readUInt16LE(2)) {
  const out = []; let p = start;
  while (p < b.length) {
    invariant(p + 8 <= b.length, 'Truncated XML chunk');
    const type = b.readUInt16LE(p), header = b.readUInt16LE(p + 2), size = b.readUInt32LE(p + 4);
    invariant(header >= 8 && size >= header && p + size <= b.length && size % 4 === 0, 'Invalid XML chunk');
    out.push({ type, header, size, offset: p, bytes: Buffer.from(b.subarray(p, p + size)) }); p += size;
  }
  return out;
}
function parsePool(c) {
  const b = c.bytes, count = b.readUInt32LE(8), styles = b.readUInt32LE(12), flags = b.readUInt32LE(16);
  const start = b.readUInt32LE(20), styleStart = b.readUInt32LE(24), strings = [];
  invariant(c.header >= 28 && c.header + 4 * (count + styles) <= start && start <= b.length, 'Invalid XML string pool');
  invariant(!styles || styleStart >= start && styleStart <= b.length, 'Invalid XML style pool');
  function length8(p) { invariant(p < b.length, 'Truncated string'); const x = b[p]; return x & 128 ? [((x & 127) << 8) | b[p + 1], p + 2] : [x, p + 1]; }
  function length16(p) { invariant(p + 2 <= b.length, 'Truncated string'); const x = b.readUInt16LE(p); return x & 32768 ? [((x & 32767) * 65536) + b.readUInt16LE(p + 2), p + 4] : [x, p + 2]; }
  for (let i = 0; i < count; i++) {
    let p = start + b.readUInt32LE(c.header + i * 4), n;
    if (flags & 256) { [, p] = length8(p); [n, p] = length8(p); invariant(p + n < (styleStart || b.length) && b[p + n] === 0, 'Invalid UTF8 XML string'); strings.push(b.subarray(p, p + n).toString('utf8')); }
    else { [n, p] = length16(p); invariant(p + n * 2 + 2 <= (styleStart || b.length) && b.readUInt16LE(p + n * 2) === 0, 'Invalid UTF16 XML string'); strings.push(b.subarray(p, p + n * 2).toString('utf16le')); }
  }
  return { strings, flags, header: Buffer.from(b.subarray(0, c.header)),
    styleOffsets: Buffer.from(b.subarray(c.header + count * 4, c.header + (count + styles) * 4)),
    styleData: styles ? Buffer.from(b.subarray(styleStart)) : Buffer.alloc(0), styleCount: styles };
}
function buildPool(pool) {
  const utf8 = (pool.flags & 256) !== 0, offsets = [], encoded = []; let length = 0;
  const len8 = n => { invariant(n < 32768, 'XML UTF8 string too long'); return n < 128 ? Buffer.from([n]) : Buffer.from([(n >> 8) | 128, n & 255]); };
  const len16 = n => { const b = Buffer.alloc(n < 32768 ? 2 : 4); if (b.length === 2) b.writeUInt16LE(n); else { b.writeUInt16LE((n >>> 16) | 32768); b.writeUInt16LE(n & 65535, 2); } return b; };
  for (const s of pool.strings) {
    const bytes = Buffer.from(s, utf8 ? 'utf8' : 'utf16le');
    const data = utf8 ? Buffer.concat([len8(s.length), len8(bytes.length), bytes, Buffer.alloc(1)]) : Buffer.concat([len16(s.length), bytes, Buffer.alloc(2)]);
    offsets.push(length); encoded.push(data); length += data.length;
  }
  const start = pool.header.length + offsets.length * 4 + pool.styleOffsets.length, padding = (4 - length % 4) % 4;
  const styleStart = pool.styleCount ? start + length + padding : 0;
  const out = Buffer.alloc(start + length + padding + pool.styleData.length); pool.header.copy(out);
  out.writeUInt32LE(out.length, 4); out.writeUInt32LE(offsets.length, 8); out.writeUInt32LE(pool.styleCount, 12);
  out.writeUInt32LE(pool.flags & ~1, 16); out.writeUInt32LE(start, 20); out.writeUInt32LE(styleStart, 24);
  offsets.forEach((n, i) => out.writeUInt32LE(n, pool.header.length + i * 4)); pool.styleOffsets.copy(out, pool.header.length + offsets.length * 4);
  let p = start; for (const data of encoded) { data.copy(out, p); p += data.length; }
  if (pool.styleCount) pool.styleData.copy(out, styleStart); return out;
}
function parse(b) {
  invariant(b.length >= 8 && b.readUInt16LE(0) === 3 && b.readUInt32LE(4) === b.length, 'Invalid binary Android XML');
  const list = chunks(b), pools = list.filter(c => c.type === 1), maps = list.filter(c => c.type === 0x180);
  invariant(pools.length === 1 && maps.length <= 1, 'Unexpected XML pools');
  const pool = parsePool(pools[0]), resources = maps.length ? Array.from({ length: (maps[0].size - maps[0].header) / 4 }, (_, i) => maps[0].bytes.readUInt32LE(maps[0].header + i * 4)) : [];
  const str = n => n === NONE ? null : pool.strings[n];
  const roots = [], stack = [], byChunk = new Map();
  for (const c of list) {
    const d = c.bytes, h = c.header;
    if (c.type === 0x102) {
      invariant(h >= 16 && h + 20 <= d.length, 'Invalid XML element');
      const start = d.readUInt16LE(h + 8), size = d.readUInt16LE(h + 10), count = d.readUInt16LE(h + 12), attrs = [];
      invariant(size >= 20 && h + start + count * size <= d.length, 'Invalid XML attributes');
      for (let i = 0; i < count; i++) {
        const raw = Buffer.from(d.subarray(h + start + i * size, h + start + (i + 1) * size));
        const nsIndex = raw.readUInt32LE(0), nameIndex = raw.readUInt32LE(4), valueIndex = raw.readUInt32LE(8), data = raw.readUInt32LE(16), type = raw[15];
        attrs.push({ raw, ns: str(nsIndex), name: str(nameIndex), nameIndex, type, data,
          value: type === 3 ? str(data) : type === 0x12 ? data !== 0 : str(valueIndex) ?? data });
      }
      const node = { name: str(d.readUInt32LE(h + 4)), ns: str(d.readUInt32LE(h)), attrs, children: [], start: c, parent: stack.at(-1) };
      if (node.parent) node.parent.children.push(node); else roots.push(node); stack.push(node); byChunk.set(c, node);
    } else if (c.type === 0x103) {
      const node = stack.pop(); invariant(node && node.name === str(d.readUInt32LE(h + 4)), 'Unbalanced XML elements'); node.end = c;
    }
  }
  invariant(stack.length === 0 && roots.length === 1 && roots[0].name === 'manifest', 'Missing XML manifest');
  return { header: Buffer.from(b.subarray(0, b.readUInt16LE(2))), list, pool, poolChunk: pools[0], mapChunk: maps[0], resources, root: roots[0], byChunk };
}
const attr = (node, name, ns = NS) => node.attrs.find(a => a.name === name && a.ns === ns);
function fullName(name, pkg) { return name?.startsWith('.') ? pkg + name : name?.includes('.') ? name : pkg + '.' + name; }
function describeTree(doc) {
  const pkg = attr(doc.root, 'package', null)?.value;
  const app = doc.root.children.find(n => n.name === 'application');
  const activities = (app?.children || []).filter(n => n.name === 'activity' || n.name === 'activity-alias').map(n => ({
    name: fullName(attr(n, 'name')?.value, pkg), exported: attr(n, 'exported')?.value,
    launchMode: attr(n, 'launchMode')?.data ?? 0,
    intentFilters: n.children.filter(f => f.name === 'intent-filter').map(f => ({
      actions: f.children.filter(c => c.name === 'action').map(c => attr(c, 'name')?.value),
      categories: f.children.filter(c => c.name === 'category').map(c => attr(c, 'name')?.value),
      mimeTypes: f.children.filter(c => c.name === 'data').map(c => attr(c, 'mimeType')?.value).filter(Boolean),
      dataRestrictions: f.children.filter(c => c.name === 'data').flatMap(c => c.attrs.filter(a => a.name !== 'mimeType').map(a => a.name))
    }))
  }));
  const permissions = doc.root.children.filter(n => n.name === 'uses-permission').map(n => attr(n, 'name')?.value).filter(Boolean);
  return { packageName: pkg, versionName: attr(doc.root, 'versionName')?.value, versionCode: attr(doc.root, 'versionCode')?.data, permissions, activities };
}
function hasShareTarget(summary, target) {
  const activity = summary.activities.find(a => a.name === target);
  return activity?.exported === true && activity.launchMode === 1 && ['android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE'].every(action => activity.intentFilters.some(f => f.actions.length === 1 && f.actions[0] === action && f.categories.includes('android.intent.category.DEFAULT') && f.mimeTypes.includes('*/*') && f.dataRestrictions.length === 0));
}
function patchManifest(input, { versionName, versionCode, shareTarget, permissions } = {}) {
  const doc = parse(input), replacement = new Map(), before = new Map(), after = new Map();
  function string(s) { const old = doc.pool.strings.indexOf(s); if (old >= 0) return old; doc.pool.strings.push(s); return doc.pool.strings.length - 1; }
  function name(s) {
    const id = IDS[s]; invariant(id, 'Unknown Android attribute: ' + s);
    let i = doc.pool.strings.findIndex((v, n) => v === s && (doc.resources[n] === id || !doc.resources[n]));
    if (i < 0) { i = doc.pool.strings.length; doc.pool.strings.push(s); }
    while (doc.resources.length <= i) doc.resources.push(0); doc.resources[i] = id; return i;
  }
  function attribute(key, value, type = 3, size = 20) {
    const b = Buffer.alloc(size); b.writeUInt32LE(string(NS), 0); b.writeUInt32LE(name(key), 4);
    b.writeUInt32LE(type === 3 ? string(value) : NONE, 8); b.writeUInt16LE(8, 12); b[15] = type; b.writeUInt32LE(type === 3 ? string(value) : value, 16); return b;
  }
  function update(node, key, value, type) {
    const c = node.start, d = replacement.get(c) || c.bytes, h = c.header, start = d.readUInt16LE(h + 8), size = d.readUInt16LE(h + 10), count = d.readUInt16LE(h + 12);
    const attrs = Array.from({ length: count }, (_, i) => Buffer.from(d.subarray(h + start + i * size, h + start + (i + 1) * size)));
    const idx = attrs.findIndex(a => doc.pool.strings[a.readUInt32LE(4)] === key && doc.pool.strings[a.readUInt32LE(0)] === NS);
    const special = [14, 16, 18].map(o => { const i = d.readUInt16LE(h + o); return i ? attrs[i - 1] : null; });
    const valueAttr = attribute(key, value, type, size);
    if (idx >= 0) { valueAttr.copy(attrs[idx], 0, 0, 20); } else attrs.push(valueAttr);
    attrs.sort((a, b) => (doc.resources[a.readUInt32LE(4)] || 0xffffffff) - (doc.resources[b.readUInt32LE(4)] || 0xffffffff));
    const nb = Buffer.concat([d.subarray(0, h + start), ...attrs, d.subarray(h + start + size * count)]);
    nb.writeUInt32LE(nb.length, 4); nb.writeUInt16LE(attrs.length, h + 12);
    special.forEach((a, i) => nb.writeUInt16LE(a ? attrs.indexOf(a) + 1 : 0, h + 14 + i * 2)); replacement.set(c, nb);
  }
  function element(tag, attrs = [], line = 0) {
    const start = Buffer.alloc(36 + attrs.length * 20), end = Buffer.alloc(24), index = string(tag);
    for (const [b, t] of [[start, 0x102], [end, 0x103]]) { b.writeUInt16LE(t); b.writeUInt16LE(16, 2); b.writeUInt32LE(b.length, 4); b.writeUInt32LE(line, 8); b.writeUInt32LE(NONE, 12); b.writeUInt32LE(NONE, 16); b.writeUInt32LE(index, 20); }
    start.writeUInt16LE(20, 24); start.writeUInt16LE(20, 26); start.writeUInt16LE(attrs.length, 28); attrs.forEach((a, i) => a.copy(start, 36 + i * 20)); return [start, end];
  }
  if (versionName !== undefined) { invariant(typeof versionName === 'string' && versionName.length > 0, 'Invalid versionName'); invariant(attr(doc.root, 'versionName'), 'Missing versionName'); update(doc.root, 'versionName', versionName, 3); }
  if (versionCode !== undefined) { invariant(Number.isInteger(versionCode) && versionCode > 0 && versionCode <= 0x7fffffff, 'Invalid versionCode'); invariant(attr(doc.root, 'versionCode'), 'Missing versionCode'); update(doc.root, 'versionCode', versionCode, 0x10); }
  if (permissions) {
    invariant(Array.isArray(permissions), 'permissions must be an array');
    const declared = new Set(doc.root.children.filter(n => n.name === 'uses-permission').map(n => attr(n, 'name')?.value));
    const app = doc.root.children.find(n => n.name === 'application');
    invariant(app, 'Missing application element');
    const line = app.start.bytes.readUInt32LE(8), additions = [];
    for (const p of permissions) {
      invariant(/^[A-Za-z0-9_.]+$/.test(p), 'Invalid permission: ' + p);
      if (declared.has(p)) continue;
      additions.push(...element('uses-permission', [attribute('name', p)], line));
    }
    if (additions.length) before.set(app.start, additions);
  }
  if (shareTarget) {
    const summary = describeTree(doc), app = doc.root.children.find(n => n.name === 'application');
    const candidates = (app?.children || []).filter(n => n.name === 'activity' && fullName(attr(n, 'name')?.value, summary.packageName) === shareTarget);
    invariant(candidates.length === 1 && attr(candidates[0], 'exported')?.value === true, 'Share target must be one exported activity');
    const activity = candidates[0], existing = summary.activities.find(a => a.name === shareTarget); update(activity, 'launchMode', 1, 0x10);
    const line = activity.start.bytes.readUInt32LE(8), additions = [];
    for (const action of ['android.intent.action.SEND', 'android.intent.action.SEND_MULTIPLE']) {
      if (existing.intentFilters.some(f => f.actions.length === 1 && f.actions[0] === action && f.categories.includes('android.intent.category.DEFAULT') && f.mimeTypes.includes('*/*') && f.dataRestrictions.length === 0)) continue;
      const [start, end] = element('intent-filter', [], line); additions.push(start);
      for (const [tag, key, value] of [['action', 'name', action], ['category', 'name', 'android.intent.category.DEFAULT'], ['data', 'mimeType', '*/*']]) additions.push(...element(tag, [attribute(key, value)], line));
      additions.push(end);
    }
    before.set(activity.end, additions);
  }
  const pool = buildPool(doc.pool), rm = Buffer.alloc(8 + doc.resources.length * 4); rm.writeUInt16LE(0x180); rm.writeUInt16LE(8, 2); rm.writeUInt32LE(rm.length, 4); doc.resources.forEach((id, i) => rm.writeUInt32LE(id, 8 + i * 4));
  replacement.set(doc.poolChunk, pool);
  if (doc.mapChunk) replacement.set(doc.mapChunk, rm); else after.set(doc.poolChunk, [rm]);
  const parts = [doc.header]; for (const c of doc.list) parts.push(...(before.get(c) || []), replacement.get(c) || c.bytes, ...(after.get(c) || []));
  const result = Buffer.concat(parts); result.writeUInt32LE(result.length, 4);
  const checked = describeTree(parse(result));
  invariant(versionName === undefined || checked.versionName === versionName, 'versionName readback mismatch');
  invariant(versionCode === undefined || checked.versionCode === versionCode, 'versionCode readback mismatch');
  invariant(!shareTarget || hasShareTarget(checked, shareTarget), 'Share filters readback mismatch');
  invariant(!permissions || permissions.every(p => checked.permissions.includes(p)), 'permission readback mismatch'); return result;
}
module.exports = { NS, IDS, NONE, parse, parsePool, buildPool, describeManifest: b => describeTree(parse(b)), hasShareTarget, patchManifest };
