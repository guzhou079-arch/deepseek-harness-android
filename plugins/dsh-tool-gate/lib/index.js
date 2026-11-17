// dsh-tool-gate —— 工具声明闸门（开局不注入工具，按需加载）
//
// 机制：在 system-prompt/assemble 瀑布里收窄当前 agent 的工具声明，
//   模型开局只看见 tool_load，调它一次就解锁要用的工具，下一步请求即生效。
//
// 两种内核都兼容：
//   · 新内核（0.2.2 起）：工具声明由 provider 拥有，装配体里没有 tools，
//     改 out.tools 会被内核丢弃。改为对当前 agent 作用域调 tools.restrict()，
//     allow 之外的全局工具不进入这一步的声明。
//   · 老内核：装配体里有 tools，直接按名单过滤（原逻辑保留）。
//
// ⚠️ 发行版默认开启：没有 $DSH_HOME/tool-gate.json 时按 enabled:true 走；
//    出了问题把 enabled 改回 false 再开新会话即可恢复，不用卸插件。
import { defineTool } from '@deepseek-ai/dsh-tools';
import { readFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';

const LANG = String(process.env.DSH_LANG || process.env.LANG || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en';
const EN = {
  "本窗口开局的工具声明被收窄过，只留了 bash 和一两种常驻协作工具，其余都没下发。要用哪个先调它把工具启用（一次可以报多个），启用后下一步就能直接调用。不确定有哪些工具时，传 all:true 列出全部，或传 query 按关键词找。": "This window starts with a narrowed tool declaration: only bash and one or two always-on collaboration tools are exposed. Call this tool to enable the ones you need (several at once is fine); they become callable on the next step. If unsure what exists, pass all:true to list everything, or query to search by keyword.",
  "要启用的工具名，如 [\"read\",\"bash\",\"grep\"]": "Tool names to enable, e.g. [\"read\",\"bash\",\"grep\"]",
  "按关键词搜索工具名/说明": "Search tool names and descriptions by keyword",
  "列出全部可加载工具": "List every loadable tool",
  "已启用：": "Enabled: ",
  "（下一步生效）": " (effective next step)",
  "尚未启用新工具。": "No new tools enabled.",
  "\n没有这些工具：": "\nNot found: ",
  "\n可用工具：\n": "\nAvailable tools:\n",
  "：": ": "
};
const t = (k) => (LANG === 'en' && EN[k] !== undefined ? EN[k] : k);

export const name = 'tool-gate';
export const inject = ['tools'];

const HOME = process.env.DSH_HOME || path.join(process.env.HOME || '.', 'payload', 'dshhome');
const FILE = path.join(HOME, 'tool-gate.json');
const DEFAULT = { enabled: true, keep: ['bash'], meta: 'tool_load' };
const LOG = path.join(HOME, 'tool-gate.log');

function conf() {
  try { return { ...DEFAULT, ...JSON.parse(readFileSync(FILE, 'utf8')) }; } catch { return { ...DEFAULT }; }
}

const fullByScope = new Map();
const enabledBySession = new Map();
const restrictions = new Map(); // scope 键 -> { allow, dispose }
let lastScope = 'default';
let lastSession = 'default';

const toolName = (t) => (t && (t.name || (t.function && t.function.name))) || '';
const toolDesc = (t) => String((t && (t.description || (t.function && t.function.description))) || '').split(/[。\n]/)[0].slice(0, 70);

export function apply(ctx) {
  const cfg = conf();
  if (!cfg.enabled) return; // 关着就什么都不做：不注册工具、不挂瀑布

  const probeA = (msg) => { try { appendFileSync(LOG, new Date().toISOString() + ' boot ' + msg); } catch { /* 日志失败不影响 */ } };
  probeA('apply-start enabled=' + cfg.enabled);
  ctx.on('dispose', () => probeA('dispose'));

  ctx.tools.register(defineTool({
    name: cfg.meta,
    description: t('本窗口开局的工具声明被收窄过，只留了 bash 和一两种常驻协作工具，其余都没下发。'
      + '要用哪个先调它把工具启用（一次可以报多个），启用后下一步就能直接调用。'
      + '不确定有哪些工具时，传 all:true 列出全部，或传 query 按关键词找。'),
    parameters: {
      names: { type: 'array', items: { type: 'string' }, description: t('要启用的工具名，如 ["read","bash","grep"]') },
      query: { type: 'string', description: t('按关键词搜索工具名/说明') },
      all: { type: 'boolean', description: t('列出全部可加载工具') },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args) {
      const names = fullByScope.get(lastScope) || [];
      const descs = fullByScope.get(lastScope + '#desc') || new Map();
      const have = new Set(names);
      const enabled = enabledBySession.get(lastSession) || new Set();
      const want = Array.isArray(args.names) ? args.names.filter((n) => typeof n === 'string') : [];
      const loaded = [], missing = [];
      for (const n of want) { if (have.has(n)) { enabled.add(n); loaded.push(n); } else missing.push(n); }
      enabledBySession.set(lastSession, enabled);

      const q = typeof args.query === 'string' ? args.query.toLowerCase() : '';
      const lines = names
        .filter((n) => n !== cfg.meta)
        .filter((n) => (args.all || q) && (!q || n.toLowerCase().includes(q) || String(descs.get(n) || '').toLowerCase().includes(q)))
        .map((n) => '- ' + n + (descs.get(n) ? t('：') + descs.get(n) : ''));
      const head = loaded.length ? t('已启用：') + loaded.join(', ') + t('（下一步生效）') : t('尚未启用新工具。');
      const miss = missing.length ? t('\n没有这些工具：') + missing.join(', ') : '';
      const catalog = lines.length ? t('\n可用工具：\n') + lines.join('\n') : '';
      return { text: head + miss + catalog };
    },
  }));

  ctx.on('system-prompt/assemble', async (...args) => {
    const [assembly, context] = args;
    const next = args.length >= 3 && typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
    let out = assembly;
    if (next) { try { out = await next(); } catch { out = assembly; } }
    // 每次装配都重读配置：把 enabled 改回 false 立刻恢复全量工具，不用重启
    const live = conf();
    if (!live.enabled) return out;
    try {
      const agent = context && context.agent;
      const scope = (context && context.scope) || agent || 'default';
      const sid = (agent && agent.session && (agent.session.id || agent.session.sessionId)) || 'default';
      lastScope = scope; lastSession = sid;

      const agentCtx = agent && agent.ctx;
      const probe = (msg) => { try { appendFileSync(LOG, new Date().toISOString() + ' probe ' + sid + ' ' + msg); } catch { /* 日志失败不影响 */ } };
      if (!agent) { probe('no-agent'); return out; }
      if (!agentCtx) { probe('no-agentCtx'); return out; }
      if (!agentCtx.tools || typeof agentCtx.tools.restrict !== 'function') {
        probe('no-restrict: ' + typeof (agentCtx.tools && agentCtx.tools.restrict));
        return out;
      }
      if (agentCtx && agentCtx.tools && typeof agentCtx.tools.restrict === 'function') {
        // 新内核：工具归 provider 所有，装配体改不了，用作用域限制收窄
        let names = [];
        let descs = new Map();
        try {
          const v = agentCtx.tools.view(scope);
          names = [...(v && (v.restrictableNames || v.knownNames) ? (v.restrictableNames || v.knownNames) : [])];
          if (v && v.visible) for (const [n, d] of v.visible) descs.set(n, toolDesc(d));
        } catch { names = []; }
        if (!names.length) { probe('empty-names'); return out; } // 拿不到名单就放手，别把工具全抹掉
        fullByScope.set(scope, names);
        fullByScope.set(scope + '#desc', descs);

        const allow = [live.meta, ...(live.keep || []), ...(enabledBySession.get(sid) || [])].filter((n) => names.includes(n));
        const key = String(scope);
        const prev = restrictions.get(key);
        if (prev && prev.allow.length === allow.length && prev.allow.every((n, i) => n === allow[i])) return out;
        if (prev) { try { prev.dispose(); } catch { /* 已释放 */ } }
        try {
          const dispose = agentCtx.tools.restrict({ allow });
          restrictions.set(key, { allow, dispose });
          try { appendFileSync(LOG, new Date().toISOString() + ' ' + sid + ' restrict ' + names.length + '->' + allow.length + ' ' + allow.join(',')); } catch { /* 日志失败不影响 */ }
        } catch (e) { probe('restrict-fail: ' + (e && e.message)); } // 名字形态不认识时宁可不动，别把工具全抹掉
        return out;
      }

      // 老内核：装配体里还有 tools，按名单过滤
      const tools = Array.isArray(out && out.tools) ? out.tools : [];
      if (!tools.length) return out;
      fullByScope.set(scope, tools.map(toolName));
      const allow = new Set([live.meta, ...(live.keep || []), ...(enabledBySession.get(sid) || [])]);
      const filtered = tools.filter((t) => allow.has(toolName(t)));
      if (filtered.length && filtered.length !== tools.length) {
        out.tools = filtered;
        try { appendFileSync(LOG, new Date().toISOString() + ' ' + sid + ' ' + tools.length + '->' + filtered.length + ' ' + filtered.map(toolName).join(',')); } catch { /* 日志失败不影响 */ }
      } // 名字形态不认识时宁可不动，别把工具全抹掉
    } catch { /* 任何异常都退回原装配 */ }
    return out;
  }, { global: true, prepend: true });
}
