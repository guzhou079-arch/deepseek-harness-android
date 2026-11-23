#!/usr/bin/env node
/**
 * DSH 全站备份 v2（流式 · 全资产）
 *
 * 用法：
 *   node backup.mjs create [--full] [--name 标签]   创建快照（默认 core，--full 含附件）
 *   node backup.mjs list                            列出快照
 *   node backup.mjs verify <文件>                    校验完整性
 *   node backup.mjs restore <文件> [--yes]           还原
 *   node backup.mjs inspect <文件>                   看快照里有什么
 *
 * 设计要点：
 *   · 流式：边读边压边写，内存恒定，附件几个 G 也不炸
 *   · 一遍读：读到哪算到哪，不会有「两遍读取哈希对不上」的竞态
 *   · SQLite：VACUUM INTO 出一致性快照，不裸拷 WAL 中的库
 *   · symlink：保留链接目标，pnpm 的 node_modules 结构能原样回去
 *   · manifest 在文件尾：写完才知道清单，不用预扫描
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// ══ 路径层 ═════════════════════════════════════════════════════
// 这个脚本要随 DSH 发到任何一台手机，所以不假设任何「本机自建」目录存在。
// 一切以 DSH_HOME 为准；外部工作区（个别用户的装配才有）发现即收，没有就跳过。

const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function isDshHome(p) {
  try {
    return fs.statSync(path.join(p, 'profiles')).isDirectory() || fs.statSync(path.join(p, 'sessions')).isDirectory();
  } catch {
    return false;
  }
}

/** 数据根：技能就住在 <DSH_HOME>/skills/<名>/scripts/，按位置上溯最可靠 */
function detectDshHome() {
  if (process.env.DSH_HOME && isDshHome(process.env.DSH_HOME)) return path.resolve(process.env.DSH_HOME);
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      dir = path.resolve(dir, '..');
      if (isDshHome(dir)) return dir;
    }
  } catch {}
  for (const cand of [
    process.env.HOME && path.join(process.env.HOME, 'dshhome'),
    '/data/data/com.deepseek.harness/files/payload/dshhome',
    '/data/user/0/com.deepseek.harness/files/payload/dshhome',
  ]) {
    if (cand && isDshHome(cand)) return path.resolve(cand);
  }
  throw new Error('找不到 DSH 数据目录；请用 DSH_HOME 环境变量指定');
}

const DSH_HOME = detectDshHome();

/** 外部工作区：不是每台设备都有。个别装配会把记忆库和工具放到外部存储，发现就收 */
function detectWorkRoots() {
  const out = [];
  const add = (p) => {
    if (!p) return;
    const r = path.resolve(p);
    if (r === path.resolve(DSH_HOME) || out.includes(r) || !isDir(r)) return;
    out.push(r);
  };
  add(process.env.DSH_WORKSPACE);
  const bases = [...new Set([process.env.EXTERNAL_STORAGE, '/storage/emulated/0', '/sdcard'].filter(Boolean))];
  for (const b of bases) for (const n of ['DeepSeekHarness', 'DSH']) add(path.join(b, n));
  return out;
}

const WORK_ROOTS = detectWorkRoots();
// 外部工作区只收这两类：记忆库和工具。截图、构建产物那些属于使用者自己的东西，不进包
const WORK_SUBDIRS = ['memory', 'tools'];

// 归档前缀：外部工作区一律走 ext/<目录名>/，避免和 DSH_HOME 下同名目录撞车
const WORK_PREFIX = new Map();
for (const root of WORK_ROOTS) {
  let base = path.basename(root) || 'workspace';
  while ([...WORK_PREFIX.keys()].includes(base)) base += '_';
  WORK_PREFIX.set(base, root);
}
const prefixOf = (root) => {
  for (const [name, r] of WORK_PREFIX) if (r === root) return `ext/${name}`;
  return 'ext/workspace';
};

/** 归档路径 → 落地位置；目标机没有对应工作区时返回 null（跳过） */
function resolveTarget(rel) {
  const m = /^ext\/([^/]+)\/(.*)$/.exec(rel);
  if (!m) return { base: DSH_HOME, sub: rel };
  const root = WORK_PREFIX.get(m[1]);
  return root ? { base: root, sub: m[2] } : null;
}

/** 备份输出位置：先试用户能看见的外部目录，不可写才退 App 私有 */
function canWriteDir(d) {
  try {
    fs.mkdirSync(d, { recursive: true });
    const probe = path.join(d, `.dsh-wtest-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'x');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function detectBackupDir() {
  if (process.env.DSH_BACKUP_DIR) return process.env.DSH_BACKUP_DIR;
  const bases = [...new Set([process.env.EXTERNAL_STORAGE, '/storage/emulated/0', '/sdcard'].filter(Boolean))];
  for (const b of bases) {
    const d = path.join(b, 'Download', 'DSH_Backups');
    if (canWriteDir(d)) return d;
  }
  return path.join(DSH_HOME, 'backups');
}

const BACKUP_DIR = detectBackupDir();

const MAGIC = 'DSHBK2\n\n';
const TAIL_MAGIC = 'DSHEND\n\n';
const HDR = 64;
const CHUNK = 1 << 20;
const GZ_LEVEL = 3;
const SKIP_FILE_RE = /(\.lock$|\.tmp$|~$|^\.DS_Store$|^\.thumbnails$)/;
// 顶层目录黑名单：只排可重建的缓存与临时物，其余一律收
const SKIP_TOP_DIRS = new Set(['cache', 'tmp', 'logs', '__pycache__', '.git', 'node_modules', '.cache']);
// 默认不收的大件（媒体/附件类），--full 时才进包
const BULK_DIRS = new Set(['attachments', 'office-kit']);
// 默认不收的大件路径前缀（参考图、素材），--full 时才收
const BULK_PREFIXES = ['crew/refs/'];
const MAX_TOP_FILE = 20 * 1024 * 1024;

const log = (...a) => console.log(...a);
const fmt = (b) =>
  b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/** 递归收集：文件记来源，软链接记目标（不进软链目录，避免重复） */
function walk(dir, relBase, acc, depth = 0) {
  if (depth > 40) return;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_FILE_RE.test(name)) continue;
    const full = path.join(dir, name);
    const rel = relBase ? `${relBase}/${name}` : name;
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue; // 断链/权限不足，跳过别让整次备份白跑
    }
    if (st.isDirectory()) {
      walk(full, rel, acc, depth + 1);
    } else if (st.isSymbolicLink()) {
      let target;
      try {
        target = fs.readlinkSync(full);
      } catch {
        continue;
      }
      acc.push({ rel, type: 'link', target });
    } else if (st.isFile()) {
      acc.push({ rel, type: 'file', src: full, size: st.size });
    }
  }
}

/** 收集要收的树：黑名单之外全收，新增目录不用改脚本 */
function collectTrees(full) {
  const acc = [];
  let names = [];
  try {
    names = fs.readdirSync(DSH_HOME).sort();
  } catch {}
  for (const name of names) {
    if (SKIP_TOP_DIRS.has(name)) continue;
    if (!full && BULK_DIRS.has(name)) continue;
    const p = path.join(DSH_HOME, name);
    if (isDir(p)) acc.push([name, p]);
  }
  // 外部工作区：记忆库和工具可能不在 DSH_HOME 里（个别装配如此），有就收
  for (const root of WORK_ROOTS) {
    const pre = prefixOf(root);
    for (const sub of WORK_SUBDIRS) {
      const p = path.join(root, sub);
      if (isDir(p)) acc.push([`${pre}/${sub}`, p]);
    }
  }
  return acc;
}
function collectTopFiles(acc) {
  let names;
  try {
    names = fs.readdirSync(DSH_HOME);
  } catch {
    return;
  }
  for (const name of names) {
    if (SKIP_FILE_RE.test(name)) continue;
    const full = path.join(DSH_HOME, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      acc.push({ rel: name, type: 'link', target: fs.readlinkSync(full) });
    } else if (st.isFile() && st.size <= MAX_TOP_FILE) {
      acc.push({ rel: name, type: 'file', src: full, size: st.size });
    }
  }
}

/** 所有记忆库的归档路径：DSH_HOME 里一个，外部工作区各一个 */
function memDbRels() {
  return ['memory/mem.db', ...WORK_ROOTS.map((r) => `${prefixOf(r)}/memory/mem.db`)];
}

/** 每个 mem.db 各做一份一致性快照：VACUUM INTO 优先，失败退化 checkpoint 后读主库 */
async function snapshotMemDbs() {
  const out = [];
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return out;
  }
  for (const rel of memDbRels()) {
    const t = resolveTarget(rel);
    if (!t) continue;
    const dbPath = path.join(t.base, t.sub);
    if (!fs.existsSync(dbPath)) continue;
    const tmp = path.join(BACKUP_DIR, `.memdb-${process.pid}-${Date.now()}.db`);
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      } finally {
        db.close();
      }
      out.push({ rel, tmp });
    } catch (e) {
      log(`  ⚠ ${rel} 一致性快照失败（${e.message}），退化为直接读取主库`);
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {}
      try {
        const db = new DatabaseSync(dbPath);
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } finally {
          db.close();
        }
      } catch {}
    }
  }
  return out;
}

function createCmd(args) {
  const full = args.includes('--full');
  const nameIdx = args.indexOf('--name');
  const tag = nameIdx !== -1 ? (args[nameIdx + 1] || 'manual') : 'manual';

  ensureDir(BACKUP_DIR);
  const t0 = Date.now();

  const trees = collectTrees(full);
  log('');
  log(`📦 DSH 全站备份${full ? '（完整 · 含附件）' : '（核心 · 不含附件）'}`);
  log('');

  const entries = [];
  collectTopFiles(entries);
  const topCount = entries.length;
  for (const [rel, dir] of trees) {
    if (!fs.existsSync(dir)) continue;
    walk(dir, rel, entries);
  }
  // 参考图/素材默认不进包；这类东西丢了能重截，不值得占几百 MB
  const picked = full ? entries : entries.filter((e) => !BULK_PREFIXES.some((p) => e.rel.startsWith(p)));
  const files = picked.filter((e) => e.type === 'file');
  const links = picked.filter((e) => e.type === 'link');
  const totalBytes = files.reduce((s, e) => s + e.size, 0);

  log(`  扫描：${files.length} 个文件 + ${links.length} 个软链，合计 ${fmt(totalBytes)}`);
  log(`  其中根目录配置 ${topCount} 项（凭据/抬头/外观）`);
  log('');

  return (async () => {
    // mem.db 一致性快照，打包时顶替原文件（可能有多个：DSH_HOME 里一个，外部工作区各一个）
    const memSnaps = await snapshotMemDbs();
    for (const { rel, tmp } of memSnaps) {
      const hit = files.find((e) => e.rel === rel);
      if (!hit) continue;
      hit.src = tmp;
      hit.size = fs.statSync(tmp).size;
    }
    if (memSnaps.length) log(`  ✓ ${memSnaps.length} 个 mem.db 出了一致性快照（VACUUM INTO）`);

    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
    const outPath = path.join(BACKUP_DIR, `DSH_Backup_${ts}${tag ? `_${tag}` : ''}.dshbackup`);

    const fd = fs.openSync(outPath, 'w');
    fs.writeSync(fd, Buffer.alloc(HDR), 0, HDR, 0);
    let written = HDR;

    const sink = new Writable({
      write(chunk, _enc, cb) {
        fs.writeSync(fd, chunk, 0, chunk.length, written);
        written += chunk.length;
        cb();
      },
    });

    const manifest = {
      format: 2,
      app: 'DeepSeek Harness Android',
      createdAt: new Date().toISOString(),
      tag,
      mode: full ? 'full' : 'core',
      dshHome: DSH_HOME,
      workRoots: WORK_ROOTS,
      stats: { files: files.length, links: links.length, totalBytes, sessions: 0, memoryDbSize: 0 },
      entries: [],
    };

    const entryMeta = [];
    let seen = 0;
    let doneBytes = 0;
    const total = files.length;

    // 文件流：读到哪算到哪，同一份字节既进归档也算哈希，不存在两遍读取的竞态
    async function* fileStream() {
      for (const e of files) {
        const hash = crypto.createHash('sha256');
        let size = 0;
        let rfd;
        try {
          rfd = fs.openSync(e.src, 'r');
        } catch (err) {
          log(`  ⚠ 跳过读不了的文件：${e.rel}（${err.code}）`);
          continue;
        }
        try {
          const buf = Buffer.alloc(CHUNK);
          let pos = 0;
          for (;;) {
            let n;
            try {
              n = fs.readSync(rfd, buf, 0, CHUNK, pos);
            } catch (err) {
              log(`  ⚠ 读取中断：${e.rel}（${err.code}）`);
              break;
            }
            if (!n) break;
            pos += n;
            size += n;
            doneBytes += n;
            const piece = Buffer.from(buf.subarray(0, n));
            hash.update(piece);
            yield piece;
          }
        } finally {
          fs.closeSync(rfd);
        }
        entryMeta.push({
          rel: e.rel,
          type: 'file',
          size,
          offset: manifest.stats.totalBytes === undefined ? 0 : 0,
          hash: hash.digest('hex'),
        });
        if (e.rel.endsWith('.jsonl') || e.rel.endsWith('.jsonl.zstd') || e.rel.endsWith('.jsonl.zst')) manifest.stats.sessions++;
        if (e.rel.endsWith('/mem.db')) manifest.stats.memoryDbSize += size;
        seen++;
        if (seen % 200 === 0 || seen === total) {
          const pct = ((doneBytes / Math.max(totalBytes, 1)) * 100).toFixed(0);
          process.stdout.write(`\r  打包 ${seen}/${total} 文件 · ${pct}% · ${fmt(doneBytes)}   `);
        }
      }
    }

    await pipeline(Readable.from(fileStream()), zlib.createGzip({ level: GZ_LEVEL }), sink);

    // 补 offset：按顺序累加
    let off = 0;
    for (const m of entryMeta) {
      m.offset = off;
      off += m.size;
      manifest.entries.push(m);
    }
    for (const l of links) manifest.entries.push({ rel: l.rel, type: 'link', target: l.target });

    manifest.stats.packedBytes = off;
    process.stdout.write('\r' + ' '.repeat(70) + '\r');

    // manifest 与尾标写在数据之后
    const dataEnd = fs.fstatSync(fd).size;
    const mBuf = zlib.gzipSync(Buffer.from(JSON.stringify(manifest)), { level: 6 });
    fs.writeSync(fd, mBuf, 0, mBuf.length, dataEnd);
    fs.writeSync(fd, Buffer.from(TAIL_MAGIC), 0, 8, dataEnd + mBuf.length);

    const hb = Buffer.alloc(HDR);
    hb.write(MAGIC, 0);
    hb.writeBigUInt64LE(BigInt(dataEnd), 8);
    hb.writeUInt32LE(mBuf.length, 16);
    fs.writeSync(fd, hb, 0, HDR, 0);
    fs.closeSync(fd);

    for (const { tmp } of memSnaps) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }

    const finalSize = fs.statSync(outPath).size;
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    log(`  ✅ 完成：${fmt(finalSize)}（原始 ${fmt(totalBytes)}，压缩率 ${((finalSize / Math.max(totalBytes, 1)) * 100).toFixed(0)}%）`);
    log(`  💬 会话 ${manifest.stats.sessions} 个 · 🧠 记忆库 ${fmt(manifest.stats.memoryDbSize)}`);
    log(`  ⏱  ${secs} 秒`);
    log('');
    log(`  ${outPath}`);
    log('');
    return outPath;
  })();
}

function openSnapshot(file) {
  const fd = fs.openSync(file, 'r');
  const hb = Buffer.alloc(HDR);
  fs.readSync(fd, hb, 0, HDR, 0);
  const magic = hb.toString('utf8', 0, 8);
  if (magic !== MAGIC) {
    fs.closeSync(fd);
    if (magic.startsWith('DSHB')) {
      throw new Error('这是 v1 老格式快照，请用旧版 backup.mjs 还原');
    }
    throw new Error(`不是有效的 DSH 快照（magic=${JSON.stringify(magic)}）`);
  }
  const dataEnd = Number(hb.readBigUInt64LE(8));
  const mLen = hb.readUInt32LE(16);
  const size = fs.statSync(file).size;
  const tb = Buffer.alloc(8);
  fs.readSync(fd, tb, 0, 8, dataEnd + mLen);
  if (tb.toString('utf8') !== TAIL_MAGIC) {
    fs.closeSync(fd);
    throw new Error('快照尾部标记缺失，文件可能被截断');
  }
  const mb = Buffer.alloc(mLen);
  fs.readSync(fd, mb, 0, mLen, dataEnd);
  fs.closeSync(fd);
  const manifest = JSON.parse(zlib.gunzipSync(mb).toString('utf8'));
  return { manifest, dataEnd, size };
}

/** 按条目顺序流式解压，逐块交给回调 */
async function streamEntries(file, manifest, dataEnd, onChunk) {
  const entries = manifest.entries.filter((e) => e.type === 'file');
  const rs = fs.createReadStream(file, { start: HDR, end: dataEnd - 1 });
  const gun = zlib.createGunzip();
  rs.pipe(gun);
  let idx = 0;
  let remain = entries.length ? entries[idx].size : 0;
  let hasher = entries.length ? crypto.createHash('sha256') : null;
  let written = 0;
  for await (const chunk of gun) {
    let p = 0;
    while (p < chunk.length) {
      if (idx >= entries.length) {
        // 多余数据说明 manifest 和实际不符
        throw new Error('解压数据比清单长，快照损坏');
      }
      const take = Math.min(remain, chunk.length - p);
      const piece = chunk.subarray(p, p + take);
      await onChunk(entries[idx], piece);
      if (hasher) hasher.update(piece);
      written += take;
      remain -= take;
      p += take;
      if (remain === 0) {
        const got = hasher ? hasher.digest('hex') : '';
        await onChunk(entries[idx], null, got);
        idx++;
        if (idx < entries.length) {
          remain = entries[idx].size;
          hasher = crypto.createHash('sha256');
        } else {
          hasher = null;
        }
      }
    }
  }
  if (idx !== entries.length) throw new Error(`解压数据比清单短（${idx}/${entries.length}）`);
  return written;
}

function verifyCmd(file) {
  log('');
  log(`🔍 校验快照：${path.basename(file)}`);
  const { manifest, dataEnd, size } = openSnapshot(file);
  log(`  创建于：${manifest.createdAt}`);
  log(`  模式：${manifest.mode} · 文件 ${manifest.stats.files} 个 · 软链 ${manifest.stats.links} 个`);
  log(`  归档大小：${fmt(size)} · 原始：${fmt(manifest.stats.totalBytes)}`);

  return (async () => {
    const byRel = new Map(manifest.entries.filter((e) => e.type === 'file').map((e) => [e.rel, e]));
    let bad = [];
    let count = 0;
    await streamEntries(file, manifest, dataEnd, (entry, piece, doneHash) => {
      if (doneHash !== undefined) {
        const expect = byRel.get(entry.rel);
        if (expect && expect.hash !== doneHash) bad.push(entry.rel);
        count++;
      }
    });
    if (bad.length) {
      log(`  ❌ ${bad.length} 个文件哈希不符：`);
      bad.slice(0, 5).forEach((r) => log(`     ${r}`));
      process.exitCode = 1;
      return false;
    }
    log(`  ✅ ${count} 个文件哈希全部一致，快照可安全还原`);
    log('');
    return true;
  })();
}

function inspectCmd(file) {
  const { manifest, dataEnd, size } = openSnapshot(file);
  const roots = new Map();
  for (const e of manifest.entries) {
    const top = e.rel.split('/')[0];
    const cur = roots.get(top) || { n: 0, bytes: 0 };
    cur.n++;
    cur.bytes += e.size || 0;
    roots.set(top, cur);
  }
  log('');
  log(`📋 ${path.basename(file)}（${manifest.mode}，${fmt(size)}）`);
  log('');
  for (const [k, v] of [...roots.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    log(`  ${k.padEnd(24)} ${String(v.n).padStart(6)} 项  ${fmt(v.bytes)}`);
  }
  log('');
}

function restoreCmd(file, yes) {
  const { manifest, dataEnd } = openSnapshot(file);
  log('');
  log(`♻️  从快照还原：${path.basename(file)}`);
  log(`  模式：${manifest.mode} · 文件 ${manifest.stats.files} 个`);
  if (!yes) {
    log('');
    log('  这是覆盖写入，会改动 DSH 数据目录。确认执行请加 --yes');
    log('');
    return;
  }

  return (async () => {
    // 还原前自动做一份安全快照（core 模式，快）
    log('  先做一份安全快照，出事能回滚…');
    try {
      const safe = await createCmd(['--name', `BeforeRestore_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`]);
      log(`  安全快照：${path.basename(safe)}`);
    } catch (e) {
      log(`  ⚠ 安全快照失败（${e.message}），继续还原。`);
    }

    // 归档路径 → 落地位置：DSH_HOME 内按原相对路径，ext/ 前缀落回对应外部工作区
    const targetOf = (rel) => {
      const t = resolveTarget(rel);
      return t ? path.join(t.base, t.sub) : null;
    };

    // 覆盖 SQLite 前先清掉同名的 -wal/-shm/-journal：旧事务残留会在下次打开时回放，
    // 把刚写回的数据冲掉（备份时的一次性快照也会因此作废）
    const dropSqliteSidecars = (dest) => {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          fs.unlinkSync(dest + suffix);
        } catch {}
      }
    };

    let restored = 0;
    const fds = new Map();
    await streamEntries(file, manifest, dataEnd, (entry, piece, doneHash) => {
      const dest = targetOf(entry.rel);
      if (!dest) return; // 本机没有这个外部工作区，跳过
      if (piece === null) {
        if (fds.has(entry.rel)) {
          fs.closeSync(fds.get(entry.rel));
          fds.delete(entry.rel);
        }
        restored++;
        return;
      }
      if (!fds.has(entry.rel)) {
        ensureDir(path.dirname(dest));
        if (entry.rel.endsWith('.db')) dropSqliteSidecars(dest);
        fds.set(entry.rel, fs.openSync(dest, 'w'));
      }
      fs.writeSync(fds.get(entry.rel), piece, 0, piece.length);
    });
    for (const fd of fds.values()) {
      try {
        fs.closeSync(fd);
      } catch {}
    }

    for (const e of manifest.entries) {
      if (e.type !== 'link') continue;
      const dest = targetOf(e.rel);
      if (!dest) continue;
      try {
        ensureDir(path.dirname(dest));
        try {
          fs.unlinkSync(dest);
        } catch {}
        fs.symlinkSync(e.target, dest);
      } catch {}
    }

    log(`  ✅ 还原 ${restored} 个文件`);
    const expect = manifest.entries.filter((e) => e.type === 'file').length;
    if (expect > restored) log(`  ⚠ 跳过 ${expect - restored} 个文件（本机没有备份里记录的外部工作区）`);

    // 记忆投影重建（发行版不一定带这个工具，找不到就跳过）
    // 工作区母版优先：包内那份可能缺 consolidate/concept，用它会重建出一份巩固不了的投影
    const memJs = [...WORK_ROOTS.map((r) => path.join(r, 'tools', 'mem.js')), path.join(DSH_HOME, 'tools', 'mem.js')].find((p) => fs.existsSync(p));
    if (memJs) {
      log('  重建记忆投影…');
      try {
        const { execFileSync } = await import('node:child_process');
        execFileSync(process.execPath, ['--preserve-symlinks', '--preserve-symlinks-main', memJs, 'sync'], { stdio: 'ignore', timeout: 120000 });
        log('  ✓ 记忆投影已重建');
      } catch {
        log('  ⚠ 记忆投影重建失败，重启后手动跑一次 mem.js sync');
      }
    }
    log('  提示：建议重启 DSH 让配置与插件重新加载');
    log('');
  })();
}

function listCmd() {
  ensureDir(BACKUP_DIR);
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.dshbackup'))
    .map((f) => {
      const p = path.join(BACKUP_DIR, f);
      const st = fs.statSync(p);
      let info = null;
      try {
        info = openSnapshot(p).manifest;
      } catch {}
      return { f, p, size: st.size, mtime: st.mtime, info };
    })
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) {
    log('还没有备份。跑 `node backup.mjs create` 生成第一份。');
    return;
  }
  log('');
  log('📚 DSH 备份快照');
  log('');
  let total = 0;
  for (const x of files) {
    total += x.size;
    const mode = x.info ? x.info.mode : 'v1老格式';
    const cnt = x.info ? `${x.info.stats.files} 文件` : '用旧脚本还原';
    log(`  ${x.f.padEnd(56)} ${fmt(x.size).padStart(10)}  ${mode.padEnd(6)} ${cnt}`);
    log(`  ${' '.repeat(8)}${x.mtime.toISOString().slice(0, 19).replace('T', ' ')}`);
  }
  log('');
  log(`  共 ${files.length} 份，占用 ${fmt(total)}`);
  if (files.length > 3) log(`  嫌占地儿就跑：node backup.mjs prune --keep 3`);
  log('');
}

/** 手动清理：默认只列不删，带 --yes 才真删 */
function pruneCmd(keep, yes) {
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.dshbackup'))
    .map((f) => {
      const p = path.join(BACKUP_DIR, f);
      const st = fs.statSync(p);
      return { f, p, size: st.size, mtime: st.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const victims = files.slice(keep);
  log('');
  if (!victims.length) {
    log(`  当前 ${files.length} 份，不超过保留数 ${keep}，无需清理。`);
    log('');
    return;
  }
  const freed = victims.reduce((s, v) => s + v.size, 0);
  log(`  保留最近 ${keep} 份，将删除 ${victims.length} 份（释放 ${fmt(freed)}）：`);
  log('');
  for (const v of victims) {
    log(`  ${v.f.padEnd(56)} ${fmt(v.size).padStart(10)}  ${v.mtime.toISOString().slice(0, 19).replace('T', ' ')}`);
  }
  log('');
  if (!yes) {
    log('  这是删除操作，确认请加 --yes');
    log('');
    return;
  }
  let done = 0;
  for (const v of victims) {
    try {
      fs.unlinkSync(v.p);
      done++;
    } catch (e) {
      log(`  ⚠ 删不掉 ${v.f}：${e.code}`);
    }
  }
  log(`  ✅ 已删除 ${done} 份，释放 ${fmt(freed)}`);
  log('');
}

const args = process.argv.slice(2);
const cmd = args[0] || 'help';

(async () => {
  try {
    switch (cmd) {
      case 'create':
      case 'backup':
        await createCmd(args.slice(1));
        break;
      case 'list':
      case 'ls':
        listCmd();
        break;
      case 'verify':
      case 'check':
        if (!args[1]) throw new Error('用法: node backup.mjs verify <文件>');
        await verifyCmd(path.resolve(args[1]));
        break;
      case 'inspect':
      case 'info':
        if (!args[1]) throw new Error('用法: node backup.mjs inspect <文件>');
        inspectCmd(path.resolve(args[1]));
        break;
      case 'restore':
        if (!args[1]) throw new Error('用法: node backup.mjs restore <文件> [--yes]');
        await restoreCmd(path.resolve(args[1]), args.includes('--yes') || args.includes('-y'));
        break;
      case 'prune': {
        const kIdx = args.indexOf('--keep');
        const keep = kIdx !== -1 ? parseInt(args[kIdx + 1], 10) || 3 : 3;
        pruneCmd(keep, args.includes('--yes') || args.includes('-y'));
        break;
      }
      default:
        log(`
DSH 全站备份 v2

  node backup.mjs create [--full] [--name 标签]   创建快照（默认 core，--full 含附件/参考图）
  node backup.mjs list                            列出快照
  node backup.mjs inspect <文件>                   看快照内容构成
  node backup.mjs verify <文件>                    校验完整性
  node backup.mjs restore <文件> [--yes]           还原
  node backup.mjs prune [--keep 3] [--yes]        清理旧快照（默认只列不删）

core 包含：记忆库、会话、配置、技能、工具、团队数据、根目录凭据与抬头
full  额外包含：attachments（聊天图片）、office-kit、crew/refs（参考图）
`);
    }
  } catch (e) {
    console.error(`\n❌ ${e.message}\n`);
    process.exitCode = 1;
  }
})();
