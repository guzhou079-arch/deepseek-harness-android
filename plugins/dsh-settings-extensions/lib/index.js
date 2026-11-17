// dsh-settings-extensions —— node 半边：技能清单/开关 + 自建插件清单，挂在引擎自己的 webServer（/settings-ext）。
//
// 技能开关的真相：SKILL.md frontmatter。关 = 写入 `disable-model-invocation: true` + `user-invocable: false`
// （模型目录与 /技能 菜单都排除），开 = 去掉这两行。dsh-skill-filesystem 的 watcher 会热更新，不用重启。
// 另存一份状态 $DSH_HOME/settings-extensions/skills-state.json，引擎启动时重放一次：
// 万一升级/解包把 skills 目录覆盖回出厂版，关掉的技能仍然是关的。
// 首次改某个 SKILL.md 前，原文备份到 settings-extensions/backups/<name>.SKILL.md（只备一次）。
//
// 插件清单：动态扫 profiles/web/node_modules 下的自建包（不写死任何插件名），
// 出包里没有的插件自然不会出现。
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const name = 'settings-extensions';
export const inject = ['webServer'];

const HOME = process.env.DSH_HOME || path.join(process.env.HOME || '.', 'payload', 'dshhome');
const SKILLS = path.join(HOME, 'skills');
const PROFILE = path.join(HOME, 'profiles', 'web');
const MODULES = path.join(PROFILE, 'node_modules');
const STATE_DIR = path.join(HOME, 'settings-extensions');
const STATE_FILE = path.join(STATE_DIR, 'skills-state.json');
const BACKUP_DIR = path.join(STATE_DIR, 'backups');
const SELF = 'dsh-settings-extensions';
const OFF_KEYS = ['disable-model-invocation', 'user-invocable'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

async function writeAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

/** 拆 frontmatter：返回 { lines, start, end }（end 是收尾 --- 的行号），没有就 null。 */
function splitFront(text) {
  const lines = text.split('\n');
  if ((lines[0] || '').trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') return { lines, end: i };
  return null;
}

function frontValue(fm, key) {
  for (let i = 1; i < fm.end; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(fm.lines[i]);
    if (m && m[1] === key) return m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return undefined;
}

function isOff(fm) {
  return frontValue(fm, 'disable-model-invocation') === 'true' && frontValue(fm, 'user-invocable') === 'false';
}

/** 改 frontmatter：先删掉两把开关键，关的话再插在 name 行后面。 */
function setOff(text, off) {
  const fm = splitFront(text);
  if (!fm) throw new Error('SKILL.md 没有 frontmatter');
  const head = [];
  for (let i = 1; i < fm.end; i++) {
    const m = /^([A-Za-z0-9_-]+):/.exec(fm.lines[i]);
    if (m && OFF_KEYS.includes(m[1])) continue;
    head.push(fm.lines[i]);
  }
  if (off) {
    let at = head.findIndex((l) => /^name:/.test(l));
    at = at < 0 ? head.length : at + 1;
    head.splice(at, 0, 'disable-model-invocation: true', 'user-invocable: false');
  }
  return ['---', ...head, ...fm.lines.slice(fm.end)].join('\n');
}

async function readState() {
  try {
    const s = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return s && typeof s === 'object' && s.disabled && typeof s.disabled === 'object' ? s : { disabled: {} };
  } catch { return { disabled: {} }; }
}

async function listSkills() {
  const out = [];
  let names = [];
  try { names = await fs.readdir(SKILLS); } catch { return out; }
  for (const dir of names.sort()) {
    if (!NAME_RE.test(dir)) continue;
    const file = path.join(SKILLS, dir, 'SKILL.md');
    let text;
    try { text = await fs.readFile(file, 'utf8'); } catch { continue; }
    const fm = splitFront(text);
    const desc = fm ? (frontValue(fm, 'description') || '') : '';
    out.push({
      dir,
      name: (fm && frontValue(fm, 'name')) || dir,
      description: desc,
      deprecated: /^（已废弃）|^\(deprecated\)/i.test(desc),
      enabled: fm ? !isOff(fm) : true,
      partial: fm ? (frontValue(fm, 'disable-model-invocation') === 'true') !== (frontValue(fm, 'user-invocable') === 'false') : false,
      size: Buffer.byteLength(text),
    });
  }
  return out;
}

async function toggleSkill(dir, enabled) {
  if (!NAME_RE.test(dir)) throw Object.assign(new Error('技能名不合法'), { code: 400 });
  const file = path.join(SKILLS, dir, 'SKILL.md');
  const text = await fs.readFile(file, 'utf8');
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const bak = path.join(BACKUP_DIR, dir + '.SKILL.md');
  try { await fs.access(bak); } catch { await fs.writeFile(bak, text, 'utf8'); }
  const next = setOff(text, !enabled);
  if (next !== text) await writeAtomic(file, next);
  const state = await readState();
  if (enabled) delete state.disabled[dir]; else state.disabled[dir] = new Date().toISOString();
  await writeAtomic(STATE_FILE, JSON.stringify(state, null, 2));
}

/** 启动时重放：state 里关掉的技能，如果 SKILL.md 被换回了开着的版本，再关一次。 */
async function replayState(logger) {
  const state = await readState();
  for (const dir of Object.keys(state.disabled)) {
    if (!NAME_RE.test(dir)) continue;
    const file = path.join(SKILLS, dir, 'SKILL.md');
    try {
      const text = await fs.readFile(file, 'utf8');
      const fm = splitFront(text);
      if (fm && !isOff(fm)) {
        await writeAtomic(file, setOff(text, true));
        logger && logger.info && logger.info('settings-extensions: 重放关闭技能 %s', dir);
      }
    } catch { /* 技能已不在：留着记录，装回来时照样关 */ }
  }
}

async function readSkill(dir) {
  if (!NAME_RE.test(dir)) throw Object.assign(new Error('技能名不合法'), { code: 400 });
  return fs.readFile(path.join(SKILLS, dir, 'SKILL.md'), 'utf8');
}

/** 自建插件：profile node_modules 下带 dsh 字段的非作用域包，排除自己。 */
async function listPlugins() {
  let patch = '';
  // 插件可能挂在两处：$DSH_HOME/cordis.patch.yml（全局）或 profiles/web/cordis.patch.yml，两份都要看
  for (const p of [path.join(HOME, 'cordis.patch.yml'), path.join(PROFILE, 'cordis.patch.yml')]) {
    try { patch += (await fs.readFile(p, 'utf8')) + '\n'; } catch { /* 无 */ }
  }
  let deps = {};
  try { deps = JSON.parse(await fs.readFile(path.join(PROFILE, 'package.json'), 'utf8')).dependencies || {}; } catch { /* 无 */ }
  let names = [];
  try { names = await fs.readdir(MODULES); } catch { return []; }
  const out = [];
  for (const dir of names.sort()) {
    if (dir.startsWith('@') || dir.startsWith('.') || dir === SELF) continue;
    let pkg;
    try { pkg = JSON.parse(await fs.readFile(path.join(MODULES, dir, 'package.json'), 'utf8')); } catch { continue; }
    if (!pkg || !pkg.dsh) continue;
    const pkgName = pkg.name || dir;
    const esc = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inserted = new RegExp("^\\s*name:\\s*['\"]?" + esc + "['\"]?\\s*$", 'm').test(patch);
    let client = '';
    try { client = await fs.readFile(path.join(MODULES, dir, 'lib', 'client.js'), 'utf8'); } catch { /* 没有客户端半边 */ }
    const panels = [];
    const pid = /PANEL_ID\s*=\s*'([a-z0-9-]+)'/.exec(client);
    if (pid && /sidebar\.panellist/.test(client)) {
      const lab = /sidebar\.panellist[\s\S]{0,200}?label:\s*\(\)\s*=>\s*'([^']+)'/.exec(client);
      panels.push({ id: pid[1], label: lab ? lab[1] : pid[1] });
    }
    const sections = [];
    const secRe = /name:\s*'settings\.section',\s*id:\s*'([a-z0-9-]+)',[\s\S]{0,80}?label:\s*\(\)\s*=>\s*'([^']+)'/g;
    for (let m; (m = secRe.exec(client));) sections.push({ id: m[1], label: m[2] });
    out.push({
      dir,
      name: pkgName,
      version: pkg.version || '',
      description: (pkg.description || '').slice(0, 200),
      configured: inserted || Object.prototype.hasOwnProperty.call(deps, pkgName),
      panels,
      sections,
    });
  }
  return out;
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) throw Object.assign(new Error('too large'), { code: 413 });
  }
  return JSON.parse(body || '{}');
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const p = url.pathname.replace(/^\/settings-ext/, '') || '/';
  if (p === '/api/skills' && req.method === 'GET') return send(res, 200, { ok: true, skills: await listSkills() });
  if (p === '/api/skill' && req.method === 'GET') return send(res, 200, { ok: true, text: await readSkill(url.searchParams.get('name') || '') });
  if (p === '/api/skill/toggle' && req.method === 'POST') {
    const b = await readBody(req);
    if (typeof b.name !== 'string' || typeof b.enabled !== 'boolean') return send(res, 400, { ok: false, error: '参数要 name + enabled(boolean)' });
    await toggleSkill(b.name, b.enabled);
    return send(res, 200, { ok: true, skills: await listSkills() });
  }
  if (p === '/api/plugins' && req.method === 'GET') return send(res, 200, { ok: true, plugins: await listPlugins() });
  if (p === '/api/ping') return send(res, 200, { ok: true, name, startedAt: STARTED });
  send(res, 404, { ok: false, error: 'not found' });
}

const STARTED = new Date().toISOString();

/** 存活标记：判断插件在不在跑看这个文件的 mtime，别看路由 401。 */
async function markAlive() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await writeAtomic(path.join(STATE_DIR, 'alive.json'), JSON.stringify({ pid: process.pid, startedAt: STARTED }, null, 2));
}

export function apply(ctx) {
  replayState(ctx.logger).catch(() => { /* 重放失败不拖垮引擎 */ });
  markAlive().catch(() => { /* 标记失败不影响功能 */ });
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/settings-ext',
      handler: (req, res) => {
        // 门禁 fail closed：拿不到 connection、admit 抛错或回答不成形，一律 503（这条路由能改文件）
        let verdict;
        try {
          const conn = typeof webCtx.get === 'function' ? webCtx.get('connection') : void 0;
          verdict = conn && typeof conn.admit === 'function' ? conn.admit(req) : void 0;
        } catch { verdict = void 0; }
        // 真 admit：放行 = { peer }，拒绝 = { rejection: 401/403/409 }；别的形状一律当不可用
        if (!verdict || typeof verdict !== 'object' || (verdict.rejection === void 0 && !('peer' in verdict))) {
          res.writeHead(503, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
          res.end('settings-ext: connection admission unavailable.\n');
          return;
        }
        if (verdict.rejection !== void 0) {
          res.writeHead(verdict.rejection, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
          res.end(verdict.rejection === 401 ? 'dsh web authentication required.\n' : undefined);
          return;
        }
        handle(req, res).catch((e) => {
          const code = e && (e.code === 400 || e.code === 413) ? e.code : e && e.code === 'ENOENT' ? 404 : 500;
          try { send(res, code, { ok: false, error: String((e && e.message) || e) }); } catch { /* 头已发 */ }
        });
      },
    }), 'settings-extensions: /settings-ext 路由');
  });
}
