#!/usr/bin/env node
// Content receipts connect compilation inputs, the exact signed APK and checks.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { readZip, readEntry } = require('../lib/ziptool.js');
const { describeManifest, hasShareTarget } = require('../lib/android-manifest.js');
// 版本号允许用环境变量覆盖（1.40 起），默认仍是出包当时的 1.38/70 —— 历史收据不复算
export const VERSION = process.env.DSH_DIST_VERSION || '1.38',
  CODE = Number(process.env.DSH_DIST_CODE || 70),
  TARGET = 'com.deepseek.harness.MainActivity';
export const project = path.resolve(process.env.DSH_PROJECT || path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'));
export const sb = path.join(project, 'selfbuild');
const HASH = /^[a-f0-9]{64}$/;
export function insist(ok, message) { if (!ok) throw new Error(message); }
export function shaFile(file, offset = 0, length) {
  const fd = fs.openSync(file, 'r'), h = crypto.createHash('sha256'), buf = Buffer.allocUnsafe(1 << 20);
  try {
    let p = offset, remaining = length ?? fs.fstatSync(fd).size - offset;
    while (remaining > 0) { const n = fs.readSync(fd, buf, 0, Math.min(buf.length, remaining), p); insist(n > 0, 'Truncated input: ' + path.basename(file)); h.update(buf.subarray(0, n)); p += n; remaining -= n; }
    return h.digest('hex');
  } finally { fs.closeSync(fd); }
}
export const shaBuffer = b => crypto.createHash('sha256').update(b).digest('hex');
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const absolute = path.resolve(file), tmp = absolute + '.tmp-' + process.pid;
  insist(path.dirname(tmp) === path.dirname(absolute), 'Invalid receipt target');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, absolute);
  insist(JSON.stringify(readJson(absolute)) === JSON.stringify(value), 'Receipt readback mismatch');
}
// 「判不了」和「不合规」是两件事，退出码也得分开：2 = 判据对象缺失/解析不了。
// 收据解析失败一律走这个类，CLI 接住后退 2 —— 静默当成「没有收据」正是要治的病。
export class Undecidable extends Error {
  constructor(message) { super(message); this.undecidable = true; }
}
// 档案名的时间戳跟 APK 同形（本地时间 + pid），不带时间就必然同名 → 必然覆盖。
function stampNow() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// 一份收据两个文件：
//   无后缀  release-v1.49.6-code341.json            → 指针，内容是「当前是哪一份」
//   带时间戳 release-v1.49.6-code341-….json          → 不可变档案，写下去就不再改名/改写
// 为什么不是「无后缀那份直接当最新副本」：副本会被下一次出包覆盖，同 code 重出包时
// 上一份的证据还是没了，只是从「丢档案」变成「丢副本的上一版」，等于没修。
// 目标位的时间戳按来源定：旧收据用**它自己的** completedAt —— 那份档案代表它出包那一刻，不是现在。
function stampOf(iso) {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// 原字节直接落盘，不过 JSON 往返：往返会重排键序、重写缩进、吞掉尾随空白，
// 那就不再是「同一个凭据」了。写完立刻回读校 sha256。
function keepBytes(bytes, dest, label) {
  fs.writeFileSync(dest, bytes, { flag: 'wx' });
  insist(shaBuffer(fs.readFileSync(dest)) === shaBuffer(bytes), `保留原件后 sha256 不一致：${dest}`);
  console.log(`⚠ ${label}：原始字节一个没改，已存成 ${path.basename(dest)}（sha256 ${shaBuffer(bytes)}）`);
}
// 目标位已经躺着别的东西时，先把它原样搬走再写新指针。指针方案只治了「第二次出包」，
// 目标位若是旧格式裸收据或读不出来的文件，直接写指针会把那份唯一的凭据整份吃掉。
function preserveOccupant(file) {
  const bytes = fs.readFileSync(file), sha = shaBuffer(bytes), base = file.replace(/\.json$/i, '');
  let head = null;
  try { head = JSON.parse(bytes.toString('utf8')); } catch { /* 坏 JSON 落到最后一段保留 */ }
  if (head && head.kind === 'current') {
    const name = head.artifact, refers = typeof name === 'string' && /^[^/\\]+\.json$/i.test(name) ? path.join(path.dirname(file), name) : null;
    if (refers && fs.existsSync(refers) && head.artifactSha256 === shaBuffer(fs.readFileSync(refers))) {
      console.log(`ℹ 原位已是指针（指向 ${name}），那份档案不动，只换指针`);
      return;
    }
  }
  if (head && head.schema === 1 && head.kind === 'artifact') {
    const own = stampOf(head.completedAt);
    let dest = own ? `${base}-${own}.json` : `${base}-nostamp-${stampNow()}.json`;
    if (fs.existsSync(dest)) {
      if (shaBuffer(fs.readFileSync(dest)) === sha) { console.log(`ℹ 原位是旧格式收据，同字节档案已在盘上（${path.basename(dest)}），不重复搬`); return; }
      dest = `${base}-${own || stampNow()}-${stampNow()}-${process.pid}.json`;
    }
    keepBytes(bytes, dest, '原位是旧格式收据（无指针）');
    return;
  }
  // 坏 JSON / 结构不认识 / 坏指针：一样保留原始字节，绝静默覆盖，也绝不抛 ——
  // 这一步在 100MB 出包的最后一段，抛出去等于把整个包废掉，而丢的还只是收据。
  const dest = `${base}-unreadable-${stampNow()}.json`;
  const free = fs.existsSync(dest) ? `${base}-unreadable-${stampNow()}-${process.pid}.json` : dest;
  keepBytes(bytes, free, `原位收据读不出来（${head ? '结构不认识或指针指不到档案' : '不是合法 JSON'}）`);
  console.log(`！！！ 原位那份读不出来，已原样存到 ${path.basename(free)}；新的档案与指针照常往下写`);
}
export function writeArtifactReceipt(output, receipt) {
  const absolute = path.resolve(output);
  if (fs.existsSync(absolute)) preserveOccupant(absolute);
  // 同一秒同进程连写两次会撞名。撞了就换名，不抛：这是出包最后一段，
  // 为了一个文件名把刚打完的包废掉，比留个 -2 后缀亏得多；「不可覆盖」守的是内容，不是名字。
  const stem = `${absolute.replace(/\.json$/i, '')}-${stampNow()}-${process.pid}`;
  let archive = `${stem}.json`;
  for (let n = 2; fs.existsSync(archive); n++) archive = `${stem}-${n}.json`;
  insist(archive !== absolute, 'Artifact archive would overwrite the pointer path');
  writeJson(archive, receipt);
  const pointer = { schema: 1, kind: 'current', artifact: path.basename(archive), artifactSha256: shaFile(archive),
    completedAt: receipt.completedAt, versionName: receipt.versionName, versionCode: receipt.versionCode, apkSha256: receipt.apkSha256 };
  writeJson(absolute, pointer);
  return archive;
}
// 指针只认同目录内的文件名（不许路径穿越），并且必须能用 sha256 指回档案本身：
// 档案被换过就判不了，不拿指针里的字段冒充「收据内容」。
export function resolveReceipt(file) {
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw new Undecidable(`收据不存在：${absolute}`);
  let head;
  try { head = readJson(absolute); } catch (e) { throw new Undecidable(`收据不是合法 JSON：${absolute}（${String(e && e.message || e)}）`); }
  if (head?.kind !== 'current') return { receipt: head, archive: absolute, pointer: null };
  const name = head.artifact;
  if (!(typeof name === 'string' && /^[^/\\]+\.json$/i.test(name))) throw new Undecidable(`收据指针的 artifact 字段非法：${JSON.stringify(name)}`);
  const archive = path.join(path.dirname(absolute), name);
  if (!fs.existsSync(archive)) throw new Undecidable(`收据指针指向的档案不存在：${archive}（指针：${absolute}）—— 这不是「没有收据」，是证据链断了`);
  if (!HASH.test(head.artifactSha256 || '')) throw new Undecidable('收据指针缺 artifactSha256');
  if (shaFile(archive) !== head.artifactSha256) throw new Undecidable(`档案 sha256 与指针登记不一致：${archive}`);
  return { receipt: readJson(archive), archive, pointer: absolute };
}
export function filesUnder(dir) {
  insist(fs.statSync(dir).isDirectory(), 'Missing directory: ' + dir);
  const files = [];
  function visit(d) { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) { const f = path.join(d, e.name); if (e.isDirectory()) visit(f); else if (e.isFile()) files.push(f); else throw new Error('Unexpected symlink in input: ' + f); } }
  visit(dir); return files;
}
function recordFiles(files) { return [...new Set(files.map(f => path.resolve(f)))].sort().map(file => ({ file, sha256: shaFile(file), size: fs.statSync(file).size })); }
function digestFiles(files) { return shaBuffer(Buffer.from(JSON.stringify(files))); }
export function compileInputs({ root = project, rjava, sources, inner, mode = 'generated' }) {
  insist(rjava && sources && inner, 'Compilation receipt needs R.java, source list and command script');
  const sourceList = fs.readFileSync(sources, 'utf8').split('\n').filter(Boolean).map(f => path.resolve(f));
  insist(sourceList.length > 0, 'Empty compilation source list');
  const toolchain = process.env.DSH_TOOLCHAIN || '/data/user/0/com.deepseek.harness/files/toolchain';
  const run = process.env.DSH_PROOT_RUN || '/data/user/0/com.deepseek.harness/files/work/linux/run.sh';
  const java = filesUnder(path.join(root, 'v118/android-app/src')).filter(f => f.endsWith('.java'));
  const resources = filesUnder(path.join(root, 'v118/android-app/res'));
  const libs = filesUnder(path.join(root, 'v118/android-app/libs')).filter(f => /\.(aar|jar)$/.test(f));
  const inputs = recordFiles([...java, ...resources, ...libs, rjava, sources, inner,
    path.join(root, 'v118/android-app/AndroidManifest.xml'), path.join(root, 'selfbuild/scripts/javac-app.sh'),
    path.join(root, 'selfbuild/scripts/release-receipts.mjs'), run, path.join(toolchain, 'android.jar'), path.join(toolchain, 'd8.jar')]);
  return { schema: 1, kind: 'compile-inputs', project: path.resolve(root), rjava: path.resolve(rjava), sources: path.resolve(sources), inner: path.resolve(inner), mode, inputs, inputsSha256: digestFiles(inputs) };
}
export function checkInputs(snapshot) {
  insist(snapshot?.schema === 1 && Array.isArray(snapshot.inputs) && snapshot.inputs.length > 0 && HASH.test(snapshot.inputsSha256), 'Invalid compilation snapshot');
  insist(digestFiles(snapshot.inputs) === snapshot.inputsSha256, 'Compilation input receipt damaged');
  const current = compileInputs({ ...snapshot, root: snapshot.project });
  insist(current.inputsSha256 === snapshot.inputsSha256, 'Compilation inputs changed; re-run javac-app.sh');
  return snapshot;
}
export function completeCompile(snapshotFile, dex, output) {
  const snapshot = checkInputs(readJson(snapshotFile));
  const b = fs.readFileSync(dex);
  insist(b.length >= 112 && b.subarray(0, 4).toString() === 'dex\n' && b.readUInt32LE(32) === b.length && b.readUInt32LE(96) > 0, 'Invalid DEX header/classes');
  const receipt = { ...snapshot, kind: 'compile', completedAt: new Date().toISOString(), dex: path.resolve(dex), dexSha256: shaBuffer(b), dexSize: b.length };
  writeJson(output, receipt); return receipt;
}
export function checkCompile(receiptFile, dex) {
  const receipt = checkInputs(readJson(receiptFile));
  insist(receipt.kind === 'compile' && HASH.test(receipt.dexSha256), 'Compilation never completed');
  insist(receipt.mode !== 'placeholder', 'Placeholder R.java cannot be released');
  insist(shaFile(dex || receipt.dex) === receipt.dexSha256, 'DEX changed after compilation'); return receipt;
}
export function manifestRows(file, dist = false) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')).map(line => {
    const [name, md5, keyword, policy = 'all'] = line.split('|').map(s => s.trim());
    insist(name && !name.startsWith('/') && !name.split('/').includes('..') && ['all', 'local'].includes(policy), 'Invalid checks.manifest row');
    insist(md5 === '-' || /^[a-f0-9]{32}$/.test(md5), 'Invalid manifest MD5: ' + name);
    return { name, md5, keyword, policy };
  }).filter(row => !dist || row.policy !== 'local');
  insist(rows.length > 0, 'Empty payload manifest'); return rows;
}
export function checkPayload(payload, checks, dist = false) {
  const map = new Map(readZip(payload, { load: false }).map(e => [e.name, e]));
  const rows = manifestRows(checks, dist);
  for (const row of rows) {
    const e = map.get(row.name); insist(e, 'Payload manifest missing: ' + row.name);
    const b = readEntry(payload, e);
    insist(row.md5 === '-' || crypto.createHash('md5').update(b).digest('hex') === row.md5, 'Payload MD5 mismatch: ' + row.name);
    insist(!row.keyword || row.keyword === '-' || b.includes(Buffer.from(row.keyword)), 'Payload marker missing: ' + row.name);
  }
  return { count: rows.length, checksSha256: shaFile(checks) };
}
export function apkIdentity(apk) {
  const entries = readZip(apk, { load: false }), get = name => { const hit = entries.filter(e => e.name === name); insist(hit.length === 1, 'APK needs one ' + name); return hit[0]; };
  insist(new Set(entries.map(e => e.name)).size === entries.length, 'Duplicate APK entries');
  const manifest = readEntry(apk, get('AndroidManifest.xml')), summary = describeManifest(manifest);
  insist(summary.packageName === 'com.deepseek.harness' && summary.versionName === VERSION && summary.versionCode === CODE && hasShareTarget(summary, TARGET), 'APK version/package/share manifest mismatch');
  const resources = get('resources.arsc'); insist(resources.method === 0 && resources.dataOffset % 4 === 0, 'resources.arsc must be STORE and aligned');
  const dex = get('classes.dex'), payload = get('assets/payload.zip');
  insist(!entries.some(e => /^classes[2-9][0-9]*\.dex$/.test(e.name)), 'Unexpected extra DEX');
  const entryHash = e => e.method === 0 ? shaFile(apk, e.dataOffset, e.usize) : shaBuffer(readEntry(apk, e));
  return { apk: path.resolve(apk), apkSha256: shaFile(apk), apkSize: fs.statSync(apk).size,
    versionName: summary.versionName, versionCode: summary.versionCode, manifestSha256: shaBuffer(manifest),
    dexSha256: entryHash(dex), payloadSha256: entryHash(payload),
    kernel: readEntry(apk, get('assets/dshroot_kernel_version.txt')).toString('utf8').trim(),
    revision: readEntry(apk, get('assets/dshroot_revision.txt')).toString('utf8').trim() };
}
export function checkPackedAssets(apk, receiptFile) {
  const receipt = readJson(receiptFile);
  insist(receipt.schema === 1 && receipt.kind === 'packed-assets' && Array.isArray(receipt.assets), 'Invalid packed asset receipt');
  const entries = readZip(apk, { load: false }), names = new Set();
  for (const asset of receipt.assets) {
    insist(asset && typeof asset.name === 'string' && asset.name.startsWith('assets/') && !asset.name.split('/').includes('..'), 'Invalid packed asset name');
    insist(!names.has(asset.name) && HASH.test(asset.sha256) && Number.isSafeInteger(asset.size) && asset.size >= 0, 'Invalid packed asset entry: ' + asset.name);
    names.add(asset.name);
    insist(shaFile(asset.source) === asset.sha256 && fs.statSync(asset.source).size === asset.size, 'Packed asset source changed: ' + asset.name);
    const hit = entries.filter(e => e.name === asset.name);
    insist(hit.length === 1, 'APK needs one packed asset: ' + asset.name);
    const content = readEntry(apk, hit[0]);
    insist(content.length === asset.size && shaBuffer(content) === asset.sha256, 'APK asset differs from pack input: ' + asset.name);
  }
  return { packedAssets: path.resolve(receiptFile), packedAssetsSha256: shaFile(receiptFile), assetCount: receipt.assets.length, assets: receipt.assets };
}
export function evidence(kind, apk, report, output) {
  insist(['privacy', 'isolated'].includes(kind), 'Unknown evidence kind');
  const identity = apkIdentity(apk), details = readJson(report);
  insist(details.schema === 1 && details.kind === kind && details.ok === true && details.apkSha256 === identity.apkSha256, 'Check report is not a passing report for this APK');
  const checks = details.checks;
  if (kind === 'privacy') insist(checks?.filenames === true && checks.wallpaperBytes === true && checks.contents === true && checks.dshhomeAllowlist === true && checks.background === true && checks.purge === true && checks.profileDependencies === true, 'Privacy report incomplete');
  else insist(checks?.pidOwned === true && checks.rpc === true && checks.plugins === true && checks.native === true && checks.pending === 0 && checks.homeIsolated === true && Array.isArray(details.plugins) && ['session-rewind', 'turn-notify', 'auto-summary-policy'].every(n => details.plugins.includes(n)), 'Isolation report incomplete');
  const receipt = { schema: 1, kind, ok: true, completedAt: new Date().toISOString(), apk: identity.apk, apkSha256: identity.apkSha256, report: path.resolve(report), reportSha256: shaFile(report), details };
  writeJson(output, receipt); return receipt;
}
export function checkEvidence(file, kind, apkHash) {
  const receipt = readJson(file);
  insist(receipt.schema === 1 && receipt.kind === kind && receipt.ok === true && receipt.apkSha256 === apkHash && shaFile(receipt.report) === receipt.reportSha256, 'Missing/stale ' + kind + ' receipt'); return receipt;
}
export function recordArtifact({ apk, compile, payload, checks, signature, assets, output }) {
  const built = checkCompile(compile), identity = apkIdentity(apk), checked = checkPayload(payload, checks, true), checkedAssets = checkPackedAssets(apk, assets);
  insist(identity.dexSha256 === built.dexSha256 && identity.payloadSha256 === shaFile(payload), 'APK dex/payload differs from build inputs');
  insist(identity.kernel && /^[0-9]{14}$/.test(identity.revision), 'APK kernel/revision markers invalid');
  const pkg = readZip(payload, { load: false }).find(e => e.name === 'dshroot/lib/node_modules/@deepseek-ai/dsh/package.json');
  insist(pkg && JSON.parse(readEntry(payload, pkg).toString('utf8')).version === identity.kernel, 'Kernel marker differs from payload');
  const log = fs.readFileSync(signature, 'utf8');
  insist(/Verifies/.test(log) && /Verified using v[23] scheme.*true/.test(log) && /Signer #1 certificate SHA-256 digest: [a-f0-9]{64}/i.test(log), 'Signature verifier did not pass');
  const receipt = { schema: 1, kind: 'artifact', ok: true, completedAt: new Date().toISOString(), ...identity,
    compile: path.resolve(compile), compileSha256: shaFile(compile), inputsSha256: built.inputsSha256,
    payload: path.resolve(payload), checks: path.resolve(checks), ...checked, ...checkedAssets,
    signature: path.resolve(signature), signatureSha256: shaFile(signature), signerSha256: log.match(/Signer #1 certificate SHA-256 digest: ([a-f0-9]{64})/i)[1].toLowerCase() };
  writeArtifactReceipt(output, receipt); return receipt;
}
export function checkArtifact(file) {
  // 指针也要能验：无后缀那份现在是「当前是哪一份」，档案才是收据本体。
  // 解析不了就是判不了（exit 2），不许当成「没有收据」放过去。
  const { receipt } = resolveReceipt(file);
  insist(receipt.schema === 1 && receipt.kind === 'artifact' && receipt.ok === true, 'Invalid artifact receipt');
  const actual = apkIdentity(receipt.apk);
  for (const key of ['apkSha256', 'apkSize', 'versionName', 'versionCode', 'manifestSha256', 'dexSha256', 'payloadSha256', 'kernel', 'revision']) insist(actual[key] === receipt[key], 'Artifact changed: ' + key);
  const built = checkCompile(receipt.compile), packed = checkPackedAssets(receipt.apk, receipt.packedAssets);
  insist(shaFile(receipt.compile) === receipt.compileSha256 && built.dexSha256 === receipt.dexSha256 && shaFile(receipt.checks) === receipt.checksSha256 && shaFile(receipt.signature) === receipt.signatureSha256 && packed.packedAssetsSha256 === receipt.packedAssetsSha256, 'Artifact verification inputs changed');
  return receipt;
}
export function checkBaseline(file, expectedTag) {
  insist(expectedTag && /^v[0-9]+(?:\.[0-9]+)+$/.test(expectedTag), 'Explicit published baseline tag required');
  const r = readJson(file);
  insist(r.schema === 1 && r.kind === 'baseline' && r.ok === true && r.tag === expectedTag && r.source === 'github-api' && r.repo === 'guzhou079-arch/deepseek-harness-android' && r.assets?.length > 0, `Fresh published ${expectedTag} baseline required`);
  insist(Number.isFinite(Date.parse(r.checkedAt)) && Date.now() - Date.parse(r.checkedAt) >= 0 && Date.now() - Date.parse(r.checkedAt) <= 86400000, 'Baseline receipt expired; re-run baseline');
  for (const a of r.assets) insist(HASH.test(a.sha256) && shaFile(a.local) === a.sha256, 'Baseline local package changed'); return r;
}
function mainArgs(argv) {
  const opts = {}; for (let i = 1; i < argv.length; i++) { insist(argv[i].startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--'), 'Invalid receipt arguments'); opts[argv[i].slice(2)] = argv[++i]; } return opts;
}
async function main(argv) {
  const a = mainArgs(argv), cmd = argv[0];
  if (cmd === 'compile-begin') writeJson(a.out, compileInputs({ rjava: a.rjava, sources: a.sources, inner: a.inner, mode: a.mode }));
  else if (cmd === 'compile-finish') completeCompile(a.inputs, a.dex, a.out);
  else if (cmd === 'compile-check') checkCompile(a.receipt || path.join(sb, 'work/appbuild/out/compile-receipt.json'), a.dex);
  else if (cmd === 'payload-check') checkPayload(a.payload, a.checks || path.join(sb, 'checks.manifest'), a.dist === 'yes');
  else if (cmd === 'assets-check') checkPackedAssets(a.apk, a.assets);
  else if (cmd === 'artifact') recordArtifact({ ...a, output: a.out });
  else if (cmd === 'artifact-check') checkArtifact(a.receipt);
  else if (cmd === 'evidence') evidence(a.kind, a.apk, a.report, a.out);
  else if (cmd === 'gate') { const r = checkArtifact(a.receipt); checkBaseline(a.baseline, a.baselineTag); checkEvidence(a.privacy, 'privacy', r.apkSha256); checkEvidence(a.isolated, 'isolated', r.apkSha256); }
  else if (cmd === 'artifact-path') { const { receipt: r } = resolveReceipt(a.receipt); insist(r.kind === 'artifact' && r.ok && r.versionName === VERSION && r.versionCode === CODE && HASH.test(r.apkSha256), `No selected v${VERSION}/code${CODE} artifact`); console.log(r.apk); return; }
  else throw new Error('Unknown receipt command: ' + cmd);
  console.log('✓ ' + cmd + ' passed');
}
// 判断"是不是被直接当入口跑"必须解软链接：/sdcard 是指向 /storage/emulated/0 的软链接，
// path.resolve(argv[1]) 不会解它，而 import.meta.url 已被 Node 解成真实路径 →
// 用 path.resolve 比较在 /sdcard 下**恒为假**，整个脚本静默不执行（exit 0、零输出）。
// 后果是门禁全是假的（凭据写不出来、校验全部空转），已实测踩过。两侧都取 realpath。
// 但 realpath 在 App 进程里也走不通（看不到 /storage/emulated 这层，逐段 lstat 就 ENOENT），
// 只能按 inode 比 —— 统一放在 lib/is-main.js，别在每个脚本里再抄一遍。
if (require('../lib/is-main.js').isMain(import.meta.url)) main(process.argv.slice(2)).catch(e => { console.error('✗ ' + e.message); process.exitCode = e?.undecidable ? 2 : 1; });
