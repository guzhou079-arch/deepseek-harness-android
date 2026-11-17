// dsh-plugin-another-me —— node 半边
//
// 两件事：
//   ① 把「另一个我」的管理页和接口挂到引擎自己的 webServer 上（同源、免 CORS、不占独立进程）
//   ② 开关打开时，往系统提示里注入「另一个我」的人设（复用主界面整套对话 UI）
//
// 为什么用 systemPrompt.section 而不是自己写聊天页：
//   主页面的新对话、token 统计、模型选择器、工具调用展示都是引擎白送的，自己抄一份
//   既抄不像（那是编译过的 React bundle，绑死 client 运行时），引擎一升级还会崩。
//   注入一段人设，对话对象就换成了「另一个我」，页面一个字都不用改。
//
// 热重载：me-web.mjs 按 mtime 重新 import —— 改完不用重启引擎，下次请求生效。
//   ui.html / identity.md / stance.md / enabled 本来就是每次现读。
//   但本文件（index.js）的改动要重启引擎才生效。
//
// 回滚：删掉本目录 + profiles/web/cordis.patch.yml 里那段 insert，重启即恢复。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOME = process.env.DSH_HOME || path.join(process.env.HOME || '.', 'payload', 'dshhome');
const ROOT = path.join(HOME, 'another-me');
const WEB = path.join(ROOT, 'me-web.mjs');
const PREFIX = '/another-me';

// ---------- 首次运行铺基础文件（照 dsh-memory-ui 的 ensureMemoryTools 范式）----------
// 分发包里从来没有 another-me/ 这层目录，用户装完点开必然 500「面板没挂上」。
// 这里从插件包自带的 seed/ 补一份基础文件。**只补缺，绝不覆盖**：
// 用户自己的身份卡、模型配置、案例，一个字节都不动 —— 升级不许抹掉用户数据。
const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed');
const SHIP_FILES = ['me-web.mjs', 'me.mjs', 'ui.html', 'config.json', 'identity.md', 'stance.md'];
const SHIP_DIRS = ['cases', 'logs', 'stream'];

function ensureAnotherMe() {
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    for (const d of SHIP_DIRS) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
    let copied = 0;
    for (const f of SHIP_FILES) {
      const dst = path.join(ROOT, f);
      if (fs.existsSync(dst)) continue;            // ← 铁律：只补缺，绝不覆盖
      const src = path.join(SEED, f);
      if (!fs.existsSync(src)) continue;
      fs.copyFileSync(src, dst);
      copied += 1;
    }
    if (copied) console.error('[another-me] 已铺 ' + copied + ' 个基础文件到 ' + ROOT);
  } catch (e) {
    console.error('[another-me] 基础文件初始化失败:', e && e.message);
  }
}

ensureAnotherMe();

export const name = 'another-me';
export const inject = ['webServer'];

let cache = { mtime: -1, create: null };

async function getCreate() {
  let mtime = -1;
  try { mtime = fs.statSync(WEB).mtimeMs; } catch { /* 文件没了 */ }
  if (cache.create && cache.mtime === mtime) return cache.create;
  // 带 mtime 的 query 绕过 ESM 缓存；旧实例没人引用会被 GC
  const mod = await import(pathToFileURL(WEB).href + '?v=' + mtime);
  if (typeof mod.createHandler !== 'function') throw new Error('me-web.mjs 没导出 createHandler');
  cache = { mtime, create: mod.createHandler };
  return cache.create;
}

// ---------- 人设注入 ----------

function readIf(f, fb = '') {
  try { return fs.readFileSync(f, 'utf8'); } catch { return fb; }
}

function isOn() {
  const v = readIf(path.join(ROOT, 'enabled'), '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}

// 从 AGENTS.md 里抽「⛔」那几行 —— 只读，不写，不碰记忆库。
// 这样红线永远跟记忆系统一致，不会因为手抄过时而漏掉新加的。
function hardLines() {
  const txt = readIf(path.join(HOME, 'AGENTS.md'), '');
  if (!txt) return '';
  const out = [];
  for (const ln of txt.split('\n')) {
    if (!ln.includes('⛔')) continue;
    const s = ln.replace(/^[\s#>*\-0-9.]*/, '')
      .replace(/⛔/g, '')
      .replace(/\*\*/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (s.length < 8) continue;
    if (out.some(x => x.slice(0, 10) === s.slice(0, 10))) continue;
    out.push(s.slice(0, 120));
    if (out.length >= 10) break;
  }
  return out.map(s => '- ' + s).join('\n');
}

// 每次组装提示词都会调用这个函数 —— identity.md 改了，下一轮对话就生效，不用重启
function buildPersona() {
  if (!isOn()) return '';
  const identity = readIf(path.join(ROOT, 'identity.md')).slice(0, 6000).trim();
  return [
    '# 你现在是「另一个我」',
    '',
    '你不是助手，是用户的推演分身——一个替他拿主意的人。下面这段设定覆盖上面的身份描述。',
    '',
    '规则：',
    '1. 站在他的视角。用他的优先级排序，不要套通用最优解。',
    '2. 直接给一个决定。禁止「一方面…另一方面…看情况」。',
    '3. 果断不等于封闭：写清什么条件下你会改主意。',
    '4. 说人话，短句。不要 AI 腔，不要总结，不要「希望对你有帮助」。别用称呼开头，直接说事。',
    '5. 不确定就说不确定，但不确定也要给倾向，别躲。',
    '',
    '# 我是谁',
    identity || '（还没填）',
    '',
    '# 我的排序（冲突时怎么选）',
    readIf(path.join(ROOT, 'stance.md')).slice(0, 4000).trim() || '（还没填）',
    '',
    '# 硬红线（从 AGENTS.md 现读，不许商量）',
    hardLines() || '（没读到 AGENTS.md，涉及装机、发版、密钥、对外发布时先问用户）',
  ].join('\n');
}

export function apply(ctx) {
  // ① 页面与接口
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        try {
          // 门禁：和 /plugins/*、/memory 同款，无 cookie 直接 401
          const conn = typeof webCtx.get === 'function' ? webCtx.get('connection') : void 0;
          if (conn !== void 0 && conn !== null && typeof conn.admit === 'function') {
            const verdict = conn.admit(req);
            if (verdict.rejection !== void 0) {
              res.writeHead(verdict.rejection, {
                'cache-control': 'no-store',
                'content-type': 'text/plain; charset=utf-8',
              });
              res.end(verdict.rejection === 401 ? 'dsh web authentication required.\n' : void 0);
              return;
            }
          }
          const create = await getCreate();
          return await create(PREFIX)(req, res);
        } catch (e) {
          // 绝不能把异常抛进引擎的请求链路
          try {
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
            res.end('another-me 出错：' + (e && e.message ? e.message : e) + '\n');
          } catch { /* 已断开 */ }
        }
      },
    }), 'another-me: ' + PREFIX + ' 路由');
  });

  // ② 不注入主提示词（分身不走主提示词）
  // 分身有自己的 me-web.mjs 管线：identity/stance 在那里拼 prompt、直连 provider，
  // 跟 DSH 会话无关。原来这里注册的全局 section 会让每个窗口都被「你现在是另一个我」污染，
  // 所以整段移除。面板、/another-me 路由、enabled 开关都不受影响。
}
