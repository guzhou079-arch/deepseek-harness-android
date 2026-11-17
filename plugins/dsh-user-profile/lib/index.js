// dsh-user-profile —— node 半边：把「用户资料」面板与读写接口挂在引擎自己的 webServer 上。
//
// 为什么挂引擎、不另起进程：dsh-memory-ui 已经踩过（2026-10-04）——独立进程会被系统回收，
// 面板就变成「服务未启动」。引擎一直在跑，挂上去＝进程/跨源/认证一次解决。
//
// 数据：$DSH_HOME/user-profile.json。写入用 tmp + rename（原子替换），
// 写一半断电也不会把已有一份毁掉；文件不存在＝用默认值，不报错。
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { PAGE } from './page.js';

export const name = 'user-profile';
// webServer：面板与读写接口；systemPrompt：把资料变成正文，注入每次请求
export const inject = ['webServer', 'systemPrompt'];

const HOME = process.env.DSH_HOME || path.join(process.env.HOME || '.', 'payload', 'dshhome');
const FILE = path.join(HOME, 'user-profile.json');

const DEFAULT = {
  nickname: '',
  aboutMe: '',
  style: 'friendly',
  warmth: 'high',
  energy: 'high',
  proactive: 'default',
  emoji: 'high',
};

// ── 把资料翻译成 prompt 正文 ──
// ⚠️ 与 lib/page.js 里前端预览的 persona() 是同一套模板：改一边必须改另一边，
//    预览所见 = 实际注入，两边不一致会让"预览"变成谎话。
const STYLE_TEXT = {
  friendly: '亲和友善，温和健谈',
  professional: '专业可靠，精确克制',
  direct: '直言不讳，直率乐观',
  playful: '天马行空，有趣味',
  efficient: '高效务实，简练直白',
  sharp: '吐槽达人，犀利但有分寸',
};
const LEVEL_TEXT = { low: '偏低', default: '默认', high: '偏高' };
const PROACTIVE_TEXT = { low: '答完就停，不追加建议', default: '有必要时才补一句', high: '答完给判断或下一步，主动递出' };
const EMOJI_TEXT = { low: '尽量不用', default: '偶尔，不刻意', high: '偶尔一个，放句尾' };

function pick(map, key, fallback) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;
}

/** 同步读：在 system prompt 组装时调用，必须够快（几 KB 的 JSON）。 */
function buildProfileText() {
  let p;
  try {
    p = { ...DEFAULT, ...JSON.parse(readFileSync(FILE, 'utf8')) };
  } catch {
    return ''; // 没配过 / 文件坏了：什么都不注入，别拿半成品污染每个请求
  }
  const lines = [];
  if (p.nickname && p.nickname.trim()) lines.push('对方希望被叫作「' + p.nickname.trim() + '」。');
  if (p.aboutMe && p.aboutMe.trim()) {
    lines.push('', '关于他（这是你要记住的）：', p.aboutMe.trim());
  }
  lines.push('', '说话基调：' + pick(STYLE_TEXT, p.style, STYLE_TEXT.friendly) + '。');
  lines.push('- 亲切程度：' + pick(LEVEL_TEXT, p.warmth, '默认') + '。'
    + (p.warmth === 'high' ? '用「你」「咱们」，不用「您」。'
      : p.warmth === 'low' ? '保持专业距离，少用亲昵称呼。' : '自然即可。'));
  lines.push('- 热情程度：' + pick(LEVEL_TEXT, p.energy, '默认') + '。'
    + (p.energy === 'high' ? '愿意多说一句，但不堆感叹号。'
      : p.energy === 'low' ? '只说必要的话，不扩写。' : '按内容需要。'));
  lines.push('- 主动程度：' + pick(PROACTIVE_TEXT, p.proactive, PROACTIVE_TEXT.default) + '。');
  lines.push('- 表情符号：' + pick(EMOJI_TEXT, p.emoji, EMOJI_TEXT.default) + '。');
  lines.push('- 不确定就说不确定；不总结、不喊口号、不反问「还需要什么」。');
  return lines.join('\n');
}

async function readProfile() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ...DEFAULT };
    // 解析失败不吞掉：把原因带回页面，别让用户对着空表单猜
    return { ...DEFAULT, _error: String((e && e.message) || e) };
  }
}

async function writeProfile(input) {
  const clean = { ...DEFAULT };
  for (const k of Object.keys(DEFAULT)) {
    if (input && typeof input[k] === 'string') clean[k] = input[k].slice(0, 8000);
  }
  clean.updatedAt = new Date().toISOString();
  const tmp = FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(clean, null, 2), 'utf8');
  await fs.rename(tmp, FILE); // 原子替换
  return clean;
}

// 页面热更新：page.js 的 mtime 一变就重新 import 一次 —— 调 UI 不用重启 App。
// 只在 mtime 变化时加载，避免每个请求都新建模块实例、把 ESM 缓存撑爆。
const PAGE_FILE = new URL('./page.js', import.meta.url);
let cachedPage = PAGE;
let cachedMtime = 0;
async function getPage() {
  try {
    const st = await fs.stat(PAGE_FILE);
    if (st.mtimeMs !== cachedMtime) {
      const mod = await import('./page.js?v=' + st.mtimeMs);
      cachedPage = mod.PAGE;
      cachedMtime = st.mtimeMs;
    }
  } catch { /* stat/import 失败就沿用上一份，别让面板 500 */ }
  return cachedPage;
}

function send(res, code, type, body) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const p = url.pathname.replace(/^\/user-profile/, '') || '/';

  if (p === '/' || p === '/index.html') {
    return send(res, 200, 'text/html; charset=utf-8', await getPage());
  }

  if (p === '/api/profile') {
    if (req.method === 'GET') {
      return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(await readProfile()));
    }
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 65536) return send(res, 413, 'text/plain; charset=utf-8', 'too large');
      }
      try {
        const saved = await writeProfile(JSON.parse(body || '{}'));
        return send(res, 200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, profile: saved }));
      } catch (e) {
        return send(res, 400, 'text/plain; charset=utf-8', 'bad json: ' + String((e && e.message) || e));
      }
    }
  }

  send(res, 404, 'text/plain; charset=utf-8', 'not found');
}

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/user-profile',
      handler: (req, res) => {
        // 门禁：跟 /memory、/plugins/* 一样先过 connection.admit（懒取，激活期可能还没就绪）
        const conn = typeof webCtx.get === 'function' ? webCtx.get('connection') : void 0;
        if (conn && typeof conn.admit === 'function') {
          const verdict = conn.admit(req);
          if (verdict && verdict.rejection !== void 0) {
            res.writeHead(verdict.rejection, {
              'cache-control': 'no-store',
              'content-type': 'text/plain; charset=utf-8',
            });
            res.end(verdict.rejection === 401 ? 'dsh web authentication required.\n' : undefined);
            return;
          }
        }
        handle(req, res).catch((e) => {
          try { send(res, 500, 'text/plain; charset=utf-8', String((e && e.stack) || e)); } catch { /* 头已发 */ }
        });
      },
    }), 'user-profile: /user-profile 路由');
  });

  // system prompt 半边：每次组装都现读一次 user-profile.json。
  // → 在面板里改完保存，**下一条消息立即生效**，不用重启 App。
  // order 100：紧跟 persona prefix(0) 之后、plan policy(500) 之前 —— 人设先于策略。
  ctx.inject(['systemPrompt'], (pctx) => {
    pctx.effect(() => pctx.systemPrompt.section({
      name: 'deployment:user-profile',
      order: 100,
      text: () => buildProfileText(),
    }), 'user-profile: system prompt section');
  });
}
