/**
 * dsh-plugin-turn-notify —— 「AI 跑完一轮 → 手机弹横幅」
 *
 * ## 为什么需要它
 * DSH 本身**没有任何"回答结束"的通知**：通知只会在模型主动调 `android_notify`
 * 工具时发出。所以"跑完任务给我弹个横幅"从来不是自动的，全靠模型记得调工具
 * —— 这就是它长期"时有时无"的根因。
 *
 * 本插件挂在 `agent/turn-stopping`（agent-loop 在一轮真正收尾前派发的事件）上，
 * 自己往本机 App 桥 `127.0.0.1:3081/notify` 发一条系统通知。
 *
 * ## 横幅里放什么（v2，2026-10-10 用户反馈后改）
 * v1 只写「第 N 轮已结束」—— 用户原话：「那是专门做了一个横幅告诉我第几轮跑到哪了吗？」
 * ⇒ 内部计数器对用户毫无信息量。v2 改成 **像 Operit 那样把回复本身带上**：
 *   - 标题：`✅ <会话标题>`（拿不到就用 `✅ DSH 任务完成`）
 *   - 正文：这一轮**最后一步**的文字（不是中间的工具解说），压成一行、截 140 字
 *   正文文本靠 `agent/assistant-stream` 的帧在内存里累积，**不读会话日志**
 *   （chunk 形状见 dsh-llm：`{type:'text-delta', text}`）。
 *
 * ## 三道"别打扰人"的闸门
 * 1. `minSeconds`：太短的一轮不发（默认 20 秒）。
 * 2. `cooldownSeconds`：两条之间最短间隔（默认 60 秒）。
 * 3. `skipWhenForeground`：**用户正看着 DSH 时不发**（默认 true）。
 *    判据走无障碍桥 `127.0.0.1:3181/status` 的 `package` 字段。
 *
 * ## 两条实现红线（改代码前先读）
 * - **不许 await**：`agent/turn-stopping` 是 serial 派发，监听器阻塞会卡住收尾。
 *   所以监听器本身同步返回，网络请求丢进不 await 的异步分支，且必须 `.catch`。
 * - **必须用 `node:http`，不能用 `fetch`**：本机桥有 LocalHttpFence，
 *   浏览器来源的 fetch 会被 403 挡掉（见 lesson-local-bridge-fence-blocks-node-fetch）。
 *
 * 配置：`/sdcard/DeepSeekHarness/turn-notify.json`（不存在就用默认值）
 * 运行日志：`/sdcard/DeepSeekHarness/turn-notify.log`（每次只追加一行）
 *
 * @module dsh-plugin-turn-notify
 */
import http from 'node:http';
import fs from 'node:fs';

export const name = 'turn-notify';

const CFG_PATH = process.env.DSH_TURN_NOTIFY_CFG || '/sdcard/DeepSeekHarness/turn-notify.json';
const LOG_PATH = process.env.DSH_TURN_NOTIFY_LOG || '/sdcard/DeepSeekHarness/turn-notify.log';
const SELF = 'com.deepseek.harness';

const DEFAULTS = {
  enabled: true,
  minSeconds: 20,
  cooldownSeconds: 60,
  skipWhenForeground: true,
  excerptChars: 140,
  bridgeHost: '127.0.0.1',
  bridgePort: 3081,
  a11yPort: 3181,
};

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
    return raw && typeof raw === 'object' ? { ...DEFAULTS, ...raw } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function log(line) {
  try {
    fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* 日志失败绝不能影响主流程 */
  }
}

/** 极简 HTTP JSON：永远 resolve，不抛、不挂死。 */
function httpJson({ host, port, path, method = 'GET', body, timeoutMs = 1500 }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          host,
          port,
          path,
          method,
          headers: payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {},
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            if (data.length < 65536) data += c;
          });
          res.on('end', () => {
            try {
              done(JSON.parse(data));
            } catch {
              done(null);
            }
          });
        },
      );
      req.setTimeout(timeoutMs, () => {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        done(null);
      });
      req.on('error', () => done(null));
      req.end(payload === null ? undefined : payload);
    } catch {
      done(null);
    }
  });
}

/** 把一段文本压成通知能显示的干净一行。 */
export function condense(text, maxChars = 140) {
  const one = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (one.length <= maxChars) return one;
  return `${one.slice(0, maxChars)}…`;
}

/**
 * 从一帧里取出可见文本片段。
 *
 * chunk 形状来自 `@deepseek-ai/dsh-llm`：
 *   `{type:'text-delta', text}` —— 流式增量（主流）；
 *   `{type:'block-end', block:{type:'text', text}}` —— 有些提供方一次给整块。
 * 只认 text，**不要 reasoning-delta**（思考过程不该出现在通知里）。
 *
 * @param frame - `agent/assistant-stream` 的帧。
 * @returns 文本片段（可能为空串）。
 */
export function frameText(frame) {
  const c = frame && frame.type === 'chunk' ? frame.chunk : undefined;
  if (!c || typeof c !== 'object') return '';
  if (c.type === 'text-delta' && typeof c.text === 'string') return c.text;
  if (c.type === 'block-end' && c.block && c.block.type === 'text' && typeof c.block.text === 'string') {
    return c.block.text;
  }
  return '';
}

export function apply(ctx) {
  // 整个注册过程包在 try 里：apply 抛异常会变成"插件加载失败"，
  // 万一将来内核事件名变了，也只是本插件不工作，不能拖累引擎启动。
  try {
    /**
     * 每个 agent 一份累积状态：
     *   startedAt —— 本轮开始时间（算用时）
     *   parts     —— 本轮各 step 的文本（最后一步才是有用的"回答"）
     *   cur       —— 当前 step 正在累积的文本
     *   sawDelta  —— 当前 step 是否收到过 text-delta（避免 block-end 重复计入）
     */
    const state = new WeakMap();
    const stateOf = (agent) => {
      let s = state.get(agent);
      if (s === undefined) {
        s = { startedAt: null, parts: [], cur: '', sawDelta: false };
        state.set(agent, s);
      }
      return s;
    };

    let lastNotifiedAt = 0;
    let inFlight = false;

    ctx.on('agent/status', (payload) => {
      try {
        const { agent, status } = payload || {};
        if (agent && status === 'running') {
          const s = stateOf(agent);
          s.startedAt = Date.now();
          s.parts = [];
          s.cur = '';
          s.sawDelta = false;
        }
      } catch {
        /* ignore */
      }
    });

    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const { agent, frame } = payload || {};
        if (!agent || !frame) return;
        const s = stateOf(agent);
        if (frame.type === 'start') {
          // 新的 step / 重试：上一段收进 parts，重新开一段
          if (s.cur.trim() !== '') s.parts.push(s.cur);
          s.cur = '';
          s.sawDelta = false;
          return;
        }
        const text = frameText(frame);
        if (text === '') return;
        if (frame.chunk && frame.chunk.type === 'text-delta') {
          s.cur += text;
          s.sawDelta = true;
        } else if (!s.sawDelta) {
          s.cur += text;
        }
      } catch {
        /* ignore */
      }
    });

    /** 会话标题（拿不到就 undefined；只读投影，不碰会话日志）。 */
    const sessionTitleOf = (agent) => {
      try {
        const sessionId = agent && agent.session && agent.session.id;
        if (!sessionId) return undefined;
        const session = ctx.get('sessions')?.get?.(sessionId);
        const titles = ctx.get('sessionTitle');
        if (session === undefined || titles === undefined) return undefined;
        const snap = titles.get(session);
        const title = typeof snap === 'string' ? snap : snap && snap.title;
        return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined;
      } catch {
        return undefined;
      }
    };

    ctx.on('agent/turn-stopping', (payload) => {
      try {
        const { agent, turn } = payload || {};
        const cfg = loadConfig();
        if (!cfg.enabled) return;
        if (inFlight) return;

        const now = Date.now();
        if (now - lastNotifiedAt < cfg.cooldownSeconds * 1000) {
          log(`skip cooldown turn=${turn}`);
          return;
        }

        const s = agent ? stateOf(agent) : undefined;
        const startedAt = s ? s.startedAt : null;
        let reply = '';
        if (s) {
          if (s.cur.trim() !== '') s.parts.push(s.cur);
          for (let i = s.parts.length - 1; i >= 0; i--) {
            if (String(s.parts[i]).trim() !== '') {
              reply = s.parts[i];
              break;
            }
          }
          s.parts = [];
          s.cur = '';
          s.sawDelta = false;
        }
        const seconds = startedAt === null ? null : Math.round((now - startedAt) / 1000);
        if (seconds !== null && seconds < cfg.minSeconds) {
          log(`skip too-short turn=${turn} seconds=${seconds}`);
          return;
        }

        const title = sessionTitleOf(agent);
        const body = condense(reply, cfg.excerptChars);
        const suffix = seconds !== null && seconds >= 60 ? `（用时 ${Math.round(seconds / 60)} 分钟）` : '';

        inFlight = true;
        lastNotifiedAt = now;
        // 绝不 await：serial 派发会被网络请求卡住。
        void (async () => {
          try {
            if (cfg.skipWhenForeground) {
              const st = await httpJson({
                host: cfg.bridgeHost,
                port: cfg.a11yPort,
                path: '/status',
                timeoutMs: 1500,
              });
              if (st && st.ok && st.package === SELF) {
                log(`skip foreground turn=${turn} seconds=${seconds}`);
                return;
              }
            }
            const r = await httpJson({
              host: cfg.bridgeHost,
              port: cfg.bridgePort,
              path: '/notify',
              method: 'POST',
              body: {
                title: title ? `✅ ${title}` : '✅ DSH 任务完成',
                text: `${body === '' ? '这一轮没有文字输出。' : body}${suffix}`,
              // 点击只把 App 拉到前台看会话，别再弹「通知卡片」。
              // 旧版 App 会忽略这个未知字段（仍弹卡片），所以是向前兼容的。
              open: 'app',
              },
              timeoutMs: 4000,
            });
            log(
              `fired turn=${turn} seconds=${seconds} ok=${r && r.ok === true} chars=${body.length} excerpt=${condense(body, 60)}`,
            );
          } catch (e) {
            log(`error turn=${turn} ${String((e && e.message) || e)}`);
          } finally {
            inFlight = false;
          }
        })();
      } catch {
        /* 监听器永不抛 */
      }
    });
  } catch (e) {
    log(`apply failed ${String((e && e.message) || e)}`);
  }
}
