// dsh-self-card —— 服务端：/self-card 页面 + /self-card/api/me
//
// 只读展示记忆库里的「我是谁」和 episode 经历：
//   数据源：memory/header.md 的「## 我是谁」+ memory/entries/episode-*.md
//   不另存副本，每次请求现读；页面每次现读，改 UI 不用重启。
//
// 文案全部走 config（侧栏名、副标题、统计与分区标题），默认是中性版；本机要亲切的叫法
// 就在 profiles/web/cordis.patch.yml 的 insert 块里覆盖，不用改代码。
import { promises as fs, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// 路径解析（2026-11-17）：老布局把库放 /sdcard/DeepSeekHarness/memory，开发者本机一直这么用。
// 但新装的应用默认没有「所有文件访问权限」，那里不可写，面板会读不到任何东西。
// 能写就沿用老布局，写不了退到 App 私有目录。
function writable(dir) {
  try {
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, '.wprobe-' + process.pid);
    writeFileSync(p, '');
    unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}
function privRoot() {
  const home = process.env.DSH_HOME || '';
  return home ? path.resolve(home, '..', '..') : process.cwd();
}
function pickMemDir() {
  for (const d of [process.env.DSH_MEM_DIR, process.env.DSH_MEMORY_DIR, '/sdcard/DeepSeekHarness/memory']) {
    if (d && writable(d)) return d;
  }
  const d = path.join(privRoot(), 'memory');
  try { mkdirSync(d, { recursive: true }); } catch { /* 读取时会给出空状态 */ }
  return d;
}

const MEM_DIR = pickMemDir();
const PAGE_FILE = new URL('./page.html', import.meta.url);

const LANG = String(process.env.DSH_LANG || process.env.LANG || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
const EN = {"我是谁": "Who I am", "记得的天数": "Days remembered", "经历": "Episodes", "校准": "Calibration", "最近的经历": "Recent episodes", "被校准的地方": "Where I was calibrated"};
const t = (k) => (LANG === 'en' && EN[k] !== undefined ? EN[k] : k);

/** 分发包用的默认文案：不预设任何人的名字和关系。 */
const DEFAULTS = {
  prefix: '/self-card',
  label: t('我是谁'),
  subtitle: '',
  statDays: t('记得的天数'),
  statEpisodes: t('经历'),
  statCalib: t('校准'),
  secEpisodes: t('最近的经历'),
  secCalib: t('被校准的地方'),
};

function settings(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const v = raw[key];
    out[key] = typeof v === 'string' && v.length > 0 ? v : DEFAULTS[key];
  }
  return out;
}

function parseFront(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const meta = {};
  let body = text;
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    body = text.slice(m[0].length);
  }
  body = body.replace(/^\s*#\s[^\n]*\n/, '').trim();
  return { meta, body };
}

export async function readMe(cfg) {
  let identity = '';
  try {
    const h = await fs.readFile(path.join(MEM_DIR, 'header.md'), 'utf8');
    const m = /(?:^|\n)## 我是谁[^\n]*\n([\s\S]*?)(?=\n## |\n---|$)/.exec(h);
    if (m) identity = m[1].trim();
  } catch { identity = ''; }

  const episodes = [];
  try {
    const dir = path.join(MEM_DIR, 'entries');
    const names = (await fs.readdir(dir)).filter((n) => /^episode-.*\.md$/.test(n));
    for (const n of names) {
      const { meta, body } = parseFront(await fs.readFile(path.join(dir, n), 'utf8'));
      episodes.push({
        id: meta.id || n.replace(/\.md$/, ''),
        title: meta.title || n,
        tags: (meta.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
        at: Number(meta.createdAt) || 0,
        body,
      });
    }
  } catch { /* 没有 entries 目录就当没经历 */ }
  episodes.sort((a, b) => b.at - a.at);

  // 名字从自述第一句「我叫XX」里取；没写自述就是空的，页面不硬编一个人名。
  const nameMatch = /我叫([^\s，,。「」]+)/.exec(identity);
  return {
    name: nameMatch ? nameMatch[1] : '',
    identity,
    episodes,
    meta: {
      label: cfg.label,
      subtitle: cfg.subtitle,
      statDays: cfg.statDays,
      statEpisodes: cfg.statEpisodes,
      statCalib: cfg.statCalib,
      secEpisodes: cfg.secEpisodes,
      secCalib: cfg.secCalib,
    },
  };
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function handle(req, res, cfg) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const rest = url.pathname.startsWith(cfg.prefix)
    ? url.pathname.slice(cfg.prefix.length)
    : url.pathname;
  const p = rest || '/';
  if (p === '/' || p === '/index.html') {
    return send(res, 200, 'text/html; charset=utf-8', await fs.readFile(PAGE_FILE, 'utf8'));
  }
  if (p === '/api/me' && req.method === 'GET') {
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await readMe(cfg)));
  }
  // 客户端半边拿不到 patch 里的 config（浏览器侧 entry 不传 config），
  // 所以侧栏名字/路径从这里取：服务端配置是唯一真相。
  if (p === '/api/meta' && req.method === 'GET') {
    return send(res, 200, 'application/json; charset=utf-8',
      JSON.stringify({ label: cfg.label, prefix: cfg.prefix }));
  }
  send(res, 404, 'text/plain; charset=utf-8', 'not found');
}

export function apply(ctx, config) {
  const cfg = settings(config);
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: cfg.prefix,
      handler: (req, res) => {
        const conn = typeof webCtx.get === 'function' ? webCtx.get('connection') : void 0;
        if (conn && typeof conn.admit === 'function') {
          const verdict = conn.admit(req);
          if (verdict && verdict.rejection !== void 0) {
            res.writeHead(verdict.rejection, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
            res.end(verdict.rejection === 401 ? 'dsh web authentication required.\n' : undefined);
            return;
          }
        }
        handle(req, res, cfg).catch((e) => {
          try { send(res, 500, 'text/plain; charset=utf-8', String((e && e.stack) || e)); } catch { /* 头已发 */ }
        });
      },
    }), 'self-card: ' + cfg.prefix + ' 路由');
  });
}
