/** Android console data routes. Native actions remain in the WebView bridge. */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const packagedLife = process.env.DSH_HOME && join(process.env.DSH_HOME, 'skills/dsh-life/scripts/life.js');
/** 生活守护脚本：优先用包内那份，退回 /sdcard 的运行副本。 */
const lifeScriptPath = packagedLife && existsSync(packagedLife) ? packagedLife : '/sdcard/DeepSeekHarness/tools/life.js';

// —— 时光机快照仓库（列表 / 还原）——
// 控制台原先只挂了「立即备份」，还原只有命令行入口，普通用户够不到。
// 这里把备份脚本包成两条 HTTP：读清单只读文件头、不碰压缩体；还原交给脚本自己做，
// 它自带哈希校验与还原前安全快照。
const snapshotDir = process.env.DSH_BACKUP_DIR || '/sdcard/Download/DSH_Backups';
const snapshotScript = (() => {
  const packaged = process.env.DSH_HOME && join(process.env.DSH_HOME, 'skills/dsh-backup/scripts/backup.mjs');
  if (packaged && existsSync(packaged)) return packaged;
  return existsSync('/sdcard/DeepSeekHarness/tools/backup.mjs') ? '/sdcard/DeepSeekHarness/tools/backup.mjs' : null;
})();
const SNAPSHOT_FILE = /^[A-Za-z0-9._-]+\.dshbackup$/;

/** 只读快照头：魔数 + 清单长度 + 清单 JSON。整包动辄几百 MB，不进内存。 */
function readSnapshotManifest(filePath) {
  const fd = openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(8);
    if (readSync(fd, head, 0, 8, 0) !== 8) throw new Error('文件已损坏：长度过短');
    if (head.subarray(0, 4).toString('utf8') !== 'DSHB') throw new Error('未知备份格式');
    const manifestLen = head.readUInt32BE(4);
    if (manifestLen <= 0 || manifestLen > 4194304) throw new Error('清单长度异常');
    const manifestBuf = Buffer.alloc(manifestLen);
    if (readSync(fd, manifestBuf, 0, manifestLen, 8) !== manifestLen) throw new Error('文件已损坏：元数据截断');
    return JSON.parse(manifestBuf.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

/**
 * App 启动即拉起生活中枢守护（幂等，只在引擎启动时打一次）。
 *
 * 为什么挂这里：生活守护只在 selfcheck §7 / tick 被叫时才保活，App 冷启动后没人叫它，
 * 于是打开 App 看到的是「生活中枢未运行」，得手动点启动。插件 apply() 是引擎启动时必然
 * 跑一次的点。`tick` 自身幂等（守护活着就只做心跳检查），也不排付费闹钟（watchdog 默认关）。
 */
let lifeAutostartDone = false;
export function autoStartLife(logger) {
  if (lifeAutostartDone) return { ok: false, skipped: 'already' };
  lifeAutostartDone = true;
  if (!existsSync(lifeScriptPath)) return { ok: false, skipped: 'no-life-script' };
  try {
    const child = spawn(process.execPath, [lifeScriptPath, 'tick'], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    logger?.warn?.(`android-console: life autostart failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, failed: true };
  }
}

const ROUTES = [
  ['/life', packagedLife && existsSync(packagedLife) ? packagedLife : '/sdcard/DeepSeekHarness/tools/life.js', 'createHandler'],
  ['/office', '/sdcard/DeepSeekHarness/tools/office.js', 'createOfficeHandler'],
  ['/voice-hub', '/sdcard/DeepSeekHarness/tools/voice.js', 'createVoiceHubHandler'],
  ['/lan-mesh', '/sdcard/DeepSeekHarness/tools/lan-mesh.js', 'createLanMeshHandler'],
  ['/rag', '/sdcard/DeepSeekHarness/tools/rag.mjs', 'createRagHandler'],
];
export const name = 'android-console';
export const inject = ['webServer'];

/** Run the engine Host/Origin fence and signed-cookie check before loading tools. */
export function admitConsoleRequest(ctx, req, res) {
  let status = 503;
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
    if (connection && typeof connection.admit === 'function') {
      const verdict = connection.admit(req);
      if (verdict && verdict.rejection === undefined && verdict.peer !== undefined) return true;
      if (verdict && (verdict.rejection === 401 || verdict.rejection === 403)) status = verdict.rejection;
    }
  } catch (error) {
    ctx.logger?.warn('android-console: request admission failed');
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'authentication service unavailable');
  return false;
}

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    autoStartLife(ctx.logger);
    for (const [prefix, toolPath, factoryName] of ROUTES) {
      let handlerPromise;
      const getHandler = () => {
        if (!handlerPromise) {
          handlerPromise = Promise.resolve().then(async () => {
            // A stable ESM URL avoids retaining one module instance per request.
            const tool = toolPath.endsWith('.mjs') ? await import(toolPath) : require(toolPath);
            return tool[factoryName](prefix);
          }).catch(error => {
            handlerPromise = undefined; // Optional tools may be installed later.
            throw error;
          });
        }
        return handlerPromise;
      };
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: prefix,
        handler: async (req, res) => {
          if (!admitConsoleRequest(webCtx, req, res)) return;
          try {
            const handler = await getHandler();
            await handler(req, res);
          } catch (error) {
            if (res.headersSent) {
              res.destroy(error);
              return;
            }
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        },
      }), `android-console: ${prefix} route`);
    }

    // 2026-10-25：角色分工表落盘 —— 设置页编辑、AI 派活共用同一份（$DSH_HOME/model-roles.json）。
    // 22:32 Kimi 复核后加固：过准入门、按字节限长、临时文件 + rename 原子写、失败不再装成 200。
    const rolesFile = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'model-roles.json') : null;
    const ROLE_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const ROLE_FIELDS = ['id', 'label', 'provider', 'model', 'effort', 'use', 'cost'];
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/android-console-roles',
      handler: async (req, res) => {
        if (!admitConsoleRequest(webCtx, req, res)) return;
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(body));
        };
        if (!rolesFile) return send(500, { ok: false, error: 'DSH_HOME unset' });
        if (req.method === 'GET') {
          let raw;
          try { raw = readFileSync(rolesFile, 'utf8'); }
          catch (error) {
            if (error && error.code === 'ENOENT') return send(200, { ok: true, roles: null });
            return send(500, { ok: false, error: 'read failed' });
          }
          try { return send(200, { ok: true, roles: JSON.parse(raw) }); }
          catch (_e) { return send(500, { ok: false, error: 'roles file is not valid json' }); }
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' });
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of req) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buf.length;
            if (size > 65536) return send(413, { ok: false, error: 'too large' });
            chunks.push(buf);
          }
        } catch (_e) { return send(400, { ok: false, error: 'read failed' }); }
        let roles;
        try { roles = JSON.parse(Buffer.concat(chunks).toString('utf8')).roles; }
        catch (_e) { return send(400, { ok: false, error: 'bad json' }); }
        if (!Array.isArray(roles) || roles.length === 0 || roles.length > 20) return send(400, { ok: false, error: 'roles must be 1..20' });
        const ids = new Set();
        const clean = [];
        for (const role of roles) {
          if (!role || typeof role !== 'object' || Array.isArray(role)) return send(400, { ok: false, error: 'bad role' });
          for (const key of ['id', 'label', 'provider', 'model']) {
            if (typeof role[key] !== 'string' || !role[key].trim()) return send(400, { ok: false, error: 'role.' + key + ' required' });
          }
          if (ids.has(role.id)) return send(400, { ok: false, error: 'duplicate role id: ' + role.id });
          ids.add(role.id);
          if (role.effort !== undefined && role.effort !== null && !ROLE_EFFORTS.includes(String(role.effort))) {
            return send(400, { ok: false, error: 'role.effort not allowed: ' + String(role.effort) });
          }
          const row = {};
          for (const key of ROLE_FIELDS) {
            const value = role[key];
            if (value === undefined || value === null || value === '') continue;
            if (typeof value !== 'string') return send(400, { ok: false, error: 'role.' + key + ' must be string' });
            row[key] = value.trim();
          }
          clean.push(row);
        }
        const tmp = rolesFile + '.tmp-' + process.pid;
        try {
          writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n');
          renameSync(tmp, rolesFile);
        } catch (error) {
          try { unlinkSync(tmp); } catch (_e2) {}
          return send(500, { ok: false, error: 'write failed' });
        }
        return send(200, { ok: true, saved: clean.length });
      },
    }), 'android-console: model roles route');

    // 时光机快照仓库：GET 列快照 / POST 还原。
    // 走 HTTP 而不加原生动作：原生只认 apk 里编译进去的 action id，加一个要重新出包；
    // 备份脚本本来就在 node 侧，插件自己就能调它。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/android-console-snapshot',
      handler: async (req, res) => {
        if (!admitConsoleRequest(webCtx, req, res)) return;
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'GET') {
          let names = [];
          try { names = readdirSync(snapshotDir); }
          catch (_e) { return send(200, { ok: true, dir: snapshotDir, items: [], missing: true }); }
          const items = [];
          for (const name of names) {
            if (!SNAPSHOT_FILE.test(name)) continue;
            const full = join(snapshotDir, name);
            try {
              const stat = statSync(full);
              if (!stat.isFile()) continue;
              const manifest = readSnapshotManifest(full);
              const stats = manifest.stats || {};
              items.push({
                file: name,
                size: stat.size,
                mtime: stat.mtimeMs,
                createdAt: manifest.createdAt || '',
                tag: manifest.tag || '',
                sessions: stats.sessionsCount || 0,
                memoryBytes: stats.memoryDbSize || 0,
                files: stats.filesCount || 0,
              });
            } catch (_e) { /* 坏包跳过，不挡其它快照 */ }
          }
          items.sort((a, b) => (a.file < b.file ? 1 : -1));
          return send(200, { ok: true, dir: snapshotDir, items });
        }
        if (req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' });
        const chunks = [];
        let size = 0;
        try {
          for await (const chunk of req) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buf.length;
            if (size > 8192) return send(413, { ok: false, error: 'too large' });
            chunks.push(buf);
          }
        } catch (_e) { return send(400, { ok: false, error: 'read failed' }); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (_e) { return send(400, { ok: false, error: 'bad json' }); }
        const name = body && typeof body.file === 'string' ? body.file : '';
        if (!SNAPSHOT_FILE.test(name)) return send(400, { ok: false, error: 'bad file name' });
        const target = join(snapshotDir, name);
        if (!existsSync(target)) return send(404, { ok: false, error: 'snapshot not found' });
        if (!snapshotScript) return send(500, { ok: false, error: 'backup script missing' });
        const result = await new Promise((resolve) => {
          let out = '';
          let child;
          try {
            child = spawn(process.execPath, [snapshotScript, 'restore', target, '--yes'], { stdio: ['ignore', 'pipe', 'pipe'] });
          } catch (error) {
            resolve({ ok: false, error: error instanceof Error ? error.message : String(error), log: '' });
            return;
          }
          const cap = (chunk) => { out += chunk.toString(); if (out.length > 65536) out = out.slice(-65536); };
          child.stdout.on('data', cap);
          child.stderr.on('data', cap);
          // 几百 MB 的包实测分钟级；给足 20 分钟，超时就杀掉，别让请求永远挂着。
          const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) {} }, 20 * 60 * 1000);
          child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message, log: out }); });
          child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code: code, log: out }); });
        });
        return send(result.ok ? 200 : 500, result);
      },
    }), 'android-console: snapshot route');
  });
}
