#!/usr/bin/env node
/**
 * review-channels.mjs —— 会审通道体检 / 授权清单核对（零依赖）
 * ============================================================================
 * 会审前先跑这个（不花钱）：确认「我要用的那几条通道」确实在我自己的授权清单里、
 * 且上游状态监控没有把它们标红。
 *
 * 授权清单来源：$DSH_HOME/profiles/web/cordis.patch.yml 的 llm-pi-ai.providers
 *   —— ⛔ 这是唯一权威。价目表（站方卖什么）≠ 授权清单（我有什么）。
 *
 * 可选配置：$DSH_HOME/review.json
 *   {
 *     "monitor": "https://<状态监控站>",     // 可选；New API 风格监控站
 *     "window": "1h",
 *     "defaults": { "claude": "<id>", "gpt": "<id>", "gemini": "<id>" }
 *   }
 *   没配 monitor → 只做静态检查（模型 id 还在不在授权清单里）。
 *   没配 defaults → --gate 直接报错退出（不替你猜价格）。
 *
 * 用法：
 *   node review-channels.mjs              # 列出可用厂商与模型
 *   node review-channels.mjs --models     # 连模型 id 一起列
 *   node review-channels.mjs --gate       # 体检 defaults；0=全绿 1=有非绿 2=配置/网络问题
 *   node review-channels.mjs --json       # 机器可读
 *
 * 退出码：0 = 全绿；1 = 有非 green / 模型不在清单里；2 = 配置读不到或监控不可达
 * ============================================================================
 */
import fs from 'node:fs';
import path from 'node:path';

/* ---- 定位 DSH_HOME：环境变量优先，否则从本脚本位置推导 ----
   <dshhome>/skills/dsh-review/scripts/review-channels.mjs  → 上溯 3 级 = dshhome */
function resolveHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, '..', '..', '..');
}

const HOME = resolveHome();
const YML = path.join(HOME, 'profiles', 'web', 'cordis.patch.yml');
const CFG = path.join(HOME, 'review.json');

const args = process.argv.slice(2);
const GATE = args.includes('--gate');
const SHOW_MODELS = GATE || args.includes('--models');
const JSON_OUT = args.includes('--json');

const RANK = { green: 0, yellow: 1, orange: 2, red: 3, gray: 4, unknown: 5 };
/** New API 风格命名里的按次一口价：…次-0.04￥… */
const perCall = (name) => {
  const m = /次-([0-9.]+)\s*￥/.exec(name || '');
  return m ? Number(m[1]) : null;
};

/* ---------------- 读配置 ---------------- */
if (!fs.existsSync(YML)) {
  console.error(`✗ 读不到引擎配置：${YML}\n  （用 DSH_HOME=<你的 dshhome> 指定，或确认本技能在 <dshhome>/skills/ 下）`);
  process.exit(2);
}

/** 从 cordis.patch.yml 里粗解析 providers：id / api / models[].id
 *  只认结构（缩进），不做完整 YAML —— 依赖的是"每层缩进 2 空格"这个稳定事实。 */
function parseProviders(text) {
  const out = [];
  const lines = text.split('\n');
  const i0 = lines.findIndex((l) => /^\s*providers:\s*$/.test(l));
  if (i0 < 0) return out;
  const base = lines[i0].match(/^\s*/)[0].length; // providers: 的缩进
  let cur = null;
  for (let i = i0 + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const ind = raw.match(/^\s*/)[0].length;
    if (ind <= base) break; // providers 段结束
    const pm = raw.match(new RegExp(`^\\s{${base + 2}}([A-Za-z0-9_.-]+):\\s*$`));
    if (pm) { cur = { id: pm[1], model: null, models: [] }; out.push(cur); continue; }
    if (!cur) continue;
    const am = raw.match(new RegExp(`^\\s{${base + 4}}api:\\s*(\\S+)`));
    if (am) { cur.api = am[1]; continue; }
    const mm = raw.match(new RegExp(`^\\s{${base + 6}}- id:\\s*(\\S[^\\n]*)`));
    if (mm) cur.models.push(mm[1].trim());
  }
  return out;
}

const YMLTEXT = fs.readFileSync(YML, 'utf8');
const providers = parseProviders(YMLTEXT);
const totalModels = providers.reduce((n, p) => n + p.models.length, 0);
// ⚠️ 跨模型会审 2026-10-02 指出：正则解析 YAML 是「靠每层 2 空格」的脆弱假设。
//    一旦格式变了，脚本会**静默解析出空清单**，然后报「模型不在授权清单」——把人带偏。
//    → 解析不到东西时**硬失败**，并把「解析到几个 provider / 几个模型」打出来。
//    但还有一种完全正常的情况：**新装的 App 里根本没有 providers 段**
//    （用户还没配模型）—— 这时要说人话，不能报「格式变了」把人吓一跳。
const hasProvidersKey = /^\s*providers:\s*$/m.test(YMLTEXT);
if (!providers.length || !totalModels) {
  if (!hasProvidersKey) {
    console.error(`✗ 配置里还没有 providers 段：${YML}`);
    console.error('  → 说明你还没配好要参与会审的模型。先在中继站/引擎里配至少两个不同厂商的 provider，再跑本脚本。');
  } else {
    console.error(`✗ 有 providers 段，但一个 provider / 模型都没解析出来（provider=${providers.length}，模型=${totalModels}）：${YML}`);
    console.error('  → 多半是缩进格式变了（本脚本按「每层 2 空格」解析）。手工核对那段缩进，或改用完整 YAML 解析。');
  }
  process.exit(2);
}

let cfg = {};
if (fs.existsSync(CFG)) {
  try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); }
  catch (e) { console.error(`✗ review.json 不是合法 JSON：${e.message}`); process.exit(2); }
}

/* ---------------- 选择要体检的通道 ---------------- */
const defaults = cfg.defaults && typeof cfg.defaults === 'object' ? cfg.defaults : {};

async function statusOf(models) {
  const url = String(cfg.monitor || '').replace(/\/+$/, '');
  if (!url) return { map: new Map(), note: '未配 monitor → 只做静态检查（授权清单里有这个 id 就行）' };
  const win = cfg.window || '1h';
  let j;
  try {
    const r = await fetch(`${url}/api/model-status/embed/status/batch?window=${encodeURIComponent(win)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(models), signal: AbortSignal.timeout(30000),
    });
    j = await r.json();
  } catch (e) { return { err: `状态监控请求失败：${e.message}` }; }
  if (!j || !j.success) return { err: '监控返回 success=false' };
  const map = new Map();
  for (const d of j.data || []) {
    map.set(d.model_name, { status: d.current_status || '?', fail: d.failure_count ?? 0, empty: d.empty_count ?? 0 });
  }
  return { map, note: `监控窗口 ${win}` };
}

const entries = [];
if (GATE) {
  if (!Object.keys(defaults).length) {
    console.error(`✗ 没有配默认会审通道：${CFG}\n  先决定每条线用哪个模型（写进 "defaults"），再跑 --gate。`);
    process.exit(2);
  }
  for (const [vendor, model] of Object.entries(defaults)) {
    const p = providers.find((x) => x.id === vendor);
    entries.push({ vendor, model, entitled: !!(p && p.models.includes(model)), provider: p || null });
  }
} else {
  for (const p of providers) entries.push({ vendor: p.id, model: null, entitled: true, provider: p });
}

const st = await statusOf(entries.filter((e) => e.model).map((e) => e.model));
if (st.err) {
  if (GATE) { console.error('✗ ' + st.err); process.exit(2); }
  console.error('⚠ ' + st.err + '（继续做静态检查）');
}
const hasMonitor = !!String(cfg.monitor || '').trim() && !!st.map;

for (const e of entries) {
  const s = e.model ? (st.map ? st.map.get(e.model) : null) : null;
  e.status = e.model ? (s ? s.status : (st.map && st.map.size ? '未在监控清单' : 'unknown')) : '-';
  e.fail = s ? s.fail : null;
  e.empty = s ? s.empty : null;
  e.perCall = e.model ? perCall(e.model) : null;
  // ⚠️ 会审指出：没查到状态（unknown / 未在监控清单）**不能算通过** ——
  //    那只是「未验证」。只有明确 green 才算过；没配监控站时是「静态通过」，
  //    结论里必须写明「运行状态未验证」。
  e.ok = e.entitled && (!hasMonitor || e.status === 'green');
}

/* ---------------- 输出 ---------------- */
if (JSON_OUT) {
  console.log(JSON.stringify({
    home: HOME, config: fs.existsSync(CFG) ? CFG : null, monitor: cfg.monitor || null,
    providers: providers.map((p) => ({ id: p.id, api: p.api, models: p.models.length })),
    entries, gate: GATE, ok: entries.every((e) => e.ok),
  }, null, 2));
} else if (GATE) {
  console.log('=== 默认会审通道体检 ===');
  console.log(`配置：${CFG}${cfg.monitor ? '  监控：' + cfg.monitor : '  （未配监控站）'}`);
  console.log(`解析：${providers.length} 个 provider / ${totalModels} 个模型（按「每层 2 空格」解析）；未查到状态 ≠ 通过`);
  for (const e of entries) {
    const mark = e.ok ? '✅' : '❌';
    const bits = [
      `${e.vendor.padEnd(7)} ${e.model}`,
      e.entitled ? '在授权清单' : '⛔ 不在授权清单（必然调不通）',
      e.status,
      e.fail != null ? `失败${e.fail}/空${e.empty}` : '',
      e.perCall != null ? `标称≈¥${e.perCall}/次` : '',
    ].filter(Boolean);
    console.log(`  ${mark} ${bits.join('  |  ')}`);
  }
  const bad = entries.filter((e) => !e.ok);
  console.log(bad.length
    ? `\n❌ ${bad.length} 条有问题 → 换同源回退或升档，**不要盲调用**`
    : `\n✅ 通道就绪（${st.note || ''}）${hasMonitor ? '' : '　⚠️ 未配监控站：这是「静态通过」，模型能否真的调用、以及 provider 能否真的路由到不同厂商，都还没验证。'}`);
} else {
  console.log(`授权清单（${YML}）：`);
  for (const p of providers) {
    console.log(`  ${p.id.padEnd(8)} api=${(p.api || '?').padEnd(18)} ${p.models.length} 个模型`);
    if (SHOW_MODELS) for (const m of p.models) {
      const c = perCall(m);
      console.log(`      - ${m}${c != null ? `   标称≈¥${c}/次（读自模型名，实际以账单为准）` : ''}`);
    }
  }
  console.log(cfg.monitor ? `\n监控站：${cfg.monitor}（--gate 时会查状态）` : `\n（未配 monitor；只做静态检查）`);
}

process.exit(entries.every((e) => e.ok) ? 0 : (GATE ? 1 : 0));
