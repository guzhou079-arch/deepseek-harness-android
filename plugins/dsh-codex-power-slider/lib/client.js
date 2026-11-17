/**
 * dsh-codex-power-slider —— 浏览器半边（browser half）
 * ============================================================================
 * 这是一个**手写的经典脚本**，没有任何构建步骤：宿主侧
 * `@deepseek-ai/dsh-client-modules` 只按 `exports["./client"]` 读文件字节，
 * 组合进 combo 后由 shell 以 <script> 执行。因此：
 *   - 不能用 import/export（会语法错误）；
 *   - 顶层必须同步调用 window.__ModuleLoader__.load({ id, factory })；
 *   - factory 里能 require 的只有平台种子：
 *     react / react-dom / react/jsx-runtime / @deepseek-ai/cordis /
 *     @deepseek-ai/dsh-client-store / dsh-client-ui-slots /
 *     dsh-client-ui-primitives / dsh-client-ui-dockkit。
 *
 * 视觉参照 OpenAI Codex 应用的「电源滑块 / power slider」：
 * 一张浮在 composer 上方的卡片 —— 顶部是当前档位名，下面是模型名（可下钻
 * 到模型列表），底部是带圆点刻度的滑杆；最高档使用蓝紫渐变 + 快速流动的星尘。
 *
 * 数据全部来自 DSH 真实会话：读 = modelSelection 投影，列 = modelCatalog，
 * 写 = remote.session.selectModel。没有任何假数据。
 */
window.__ModuleLoader__.load({
  id: 'dsh-codex-power-slider',
  factory: (require) => {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const PLUGIN_ID = 'dsh-codex-power-slider'
    /** 挂载点：composer 工具条里一个空闲的 list slot（左侧）。 */
    /**
     * 入口必须占住原生模型选择器的位置：`conversation.input.model` 是 single 槽，
     * 原生 ModelSelect 用默认 priority 0 注册；slot 语义「priority 越低越优先」，
     * 所以 -1 能遮蔽它 —— 不接管的话原生那套「模型 / 推理等级」两行菜单会露出来。
     */
    const SLOT = 'conversation.input.model'
    const SLOT_PRIORITY = -1
    /* [本机补丁] 原生 ModelSelect 被顶掉后，官方 model.label 子槽（1017 徽章）没有宿主渲染它。
       子槽只能声明一次（重复声明会 throw），所以这里按官方插件同样的判断就地复刻徽章。
       条件不匹配就什么都不加：模型版本升级后自然不再显示，不会错标。 */
    const RELEASE_BADGE = {
      providers: ['deepseek-account', 'deepseek-official'],
      modelId: 'deepseek-flash',
      modelName: 'DeepSeek-V4.1-Flash',
      text: '1017',
    }
    const NAMESPACE = 'dsh-codex-power-slider'

    /** 中文原文即 key：zh 不需要词典（缺词回落成 key 本身），只维护 en。 */
    const en = {
 "使用额度消耗更快": "Uses your quota faster",
 "轻度": "Light",
 "快速思考": "Fast thinking",
 "提供快速且深思熟虑的回复": "Fast but still thoughtful replies",
 "标准": "Standard",
 "思考中": "Thinking",
 "平衡思考时间与回复速度": "Balances thinking time against reply speed",
 "深度": "Deep",
 "进阶思考": "Advanced thinking",
 "延长思考时间以处理复杂问题": "Spends more time on complex problems",
 "极高": "Ultra",
 "极高 Thinking": "Ultra thinking",
 "适用于复杂问题的极高推理深度": "Very high reasoning depth for complex problems",
 "深入": "Max",
 "深度思考": "Deep thinking",
 "针对高难度问题提供更深入的分析": "Deeper analysis for the hardest problems",
 "当前主力旗舰，前沿智能体能力，适合复杂多步任务": "Current flagship: frontier agent capability for complex multi-step tasks",
 "上一代均衡档，通用能力与成本较平衡": "Previous generation balanced tier: general capability at a moderate cost",
 "上一代快速模型，适合处理较简单的任务": "Previous generation fast model for simpler tasks",
 "上一代旗舰，编程与复杂推理表现稳定": "Previous generation flagship: steady at coding and complex reasoning",
 "更早期版本，能力有限，仅建议兼容性场景": "Older version with limited capability; compatibility scenarios only",
 "面向超长任务的编排型模型，擅长多步拆解与协同": "Orchestration model for very long tasks, strong at multi-step decomposition",
 "同代快速档，低延迟，适合日常对话与轻量任务": "Same-generation fast tier: low latency for daily chat and light tasks",
 "上一代旗舰，适合编程和日常工作": "Previous generation flagship for coding and daily work",
 "腾讯混元 Hy4 预览版，智能体与工具调用更强": "Tencent Hunyuan Hy4 preview: stronger agents and tool calling",
 "腾讯混元 Hy3，智能体能力强化，适合多步任务编排": "Tencent Hunyuan Hy3: reinforced agent capability for multi-step orchestration",
 "月之暗面编程专用版，面向代码生成、重构与调试": "Moonshot coding edition for generation, refactoring and debugging",
 "月之暗面开源旗舰，代码能力对齐一线闭源模型": "Moonshot open flagship: coding on par with top closed models",
 "月之暗面新一代旗舰，长上下文与复杂推理": "Moonshot new flagship: long context and complex reasoning",
 "美团开源万亿参数 MoE，通用推理与多任务处理": "Meituan open trillion-parameter MoE for general reasoning and multitasking",
 "小米 MiMo-V2.6 快速档，低延迟，适合日常交互": "Xiaomi MiMo-V2.6 fast tier: low latency for daily interaction",
 "小米 MiMo-V2.6 增强档，复杂推理与长任务": "Xiaomi MiMo-V2.6 enhanced tier: complex reasoning and long tasks",
 "小米 MiMo-V2.6 系列，强化学习规模化，自我提升": "Xiaomi MiMo-V2.6 series: scaled reinforcement learning and self-improvement",
 "小米 MiMo-V2.5 增强档，推理与工具调用更强": "Xiaomi MiMo-V2.5 enhanced tier: stronger reasoning and tool calling",
 "小米 MiMo-V2.5 系列，通用对话与推理均衡": "Xiaomi MiMo-V2.5 series: balanced chat and reasoning",
 "小米 MiMo 系列，通用对话与推理均衡": "Xiaomi MiMo series: balanced chat and reasoning",
 "MiniMax M2 系列，偏生产力与智能体场景": "MiniMax M2 series, oriented toward productivity and agents",
 "阿里通义千问规模最大、能力最强的旗舰模型": "Alibaba Qwen flagship: the largest and most capable in the family",
 "阿里通义千问 3.8 系列，中文与代码通用能力强": "Alibaba Qwen 3.8 series: strong general Chinese and coding",
 "阿里通义千问旗舰档，复杂推理与长任务": "Alibaba Qwen flagship tier: complex reasoning and long tasks",
 "阿里通义千问 3.7 增强档，性价比与通用能力均衡": "Alibaba Qwen 3.7 enhanced tier: balanced cost and general capability",
 "阿里通义千问 3.6 增强档，日常对话与代码均可用": "Alibaba Qwen 3.6 enhanced tier: fine for daily chat and coding",
 "阿里通义千问系列，中文与代码通用能力强": "Alibaba Qwen series: strong general Chinese and coding",
 "xAI Grok 系列，长思维链推理与实时信息结合": "xAI Grok series: long chain-of-thought plus real-time information",
 "Meta 开源权重模型，偏编程与智能体": "Meta open-weight model, oriented toward coding and agents",
 "DeepSeek 官方 V4 快速档，低延迟，适合日常改动": "DeepSeek official V4 fast tier: low latency for everyday edits",
 "DeepSeek V4 旗舰，智能体与复杂任务更强": "DeepSeek V4 flagship: stronger agents and complex tasks",
 "DeepSeek V4 系列，长上下文与复杂推理": "DeepSeek V4 series: long context and complex reasoning",
 "DeepSeek 官方模型，中文与代码表现均衡": "DeepSeek official model: balanced Chinese and coding",
 "通用对话模型，具体能力以所选接口为准": "General chat model; capabilities depend on the chosen endpoint",
 "[dsh-codex-power-slider] 出站钩子安装失败（闪电开关将只改本地状态）：": "[dsh-codex-power-slider] outbound hook failed to install (the quick switch will only change local state): ",
 "没有会话，无法切换模型": "No session, cannot switch models",
 "模型参数不完整，请求未发出": "Incomplete model parameters; the request was not sent",
 "模型选择失败": "Model selection failed",
 "会话被其他 DSH 进程占用，请退出后重试。": "The session is held by another DSH process; exit it and retry.",
 "当前会话由子代理路由接管，不能修改模型或思考强度。": "A subagent route owns this session; the model and reasoning strength cannot be changed.",
 "选择推理强度": "Select reasoning strength",
 "选择模型": "Select model",
 "子代理加速：已开启": "Subagent boost: on",
 "子代理加速：已关闭": "Subagent boost: off",
 "已开启：下一条消息会告诉模型优先考虑子智能体（只需说一次，之后保持开启）": "On: the next message tells the model to prefer subagents (once is enough; it stays on)",
 "已关闭：开启后下一条消息会告诉模型优先考虑子智能体": "Off: turning it on makes the next message tell the model to prefer subagents",
 "选择模型，当前模型：": "Select model, current: ",
 "未选择": "Not selected",
 "推理强度": "Reasoning strength",
 "恢复该模型的默认推理强度": "Restore this model default reasoning strength",
 "恢复默认": "Restore default",
 "模型目录加载中…": "Loading model catalog…",
 "推荐模型集": "Recommended models",
 "推理强度不可调整": "Reasoning strength is not adjustable",
 "当前模型未公布推理强度：在 profile 的 reasoningEfforts 里配置后即可调节": "This model publishes no reasoning strengths: configure reasoningEfforts in the profile to adjust it",
 "[dsh-codex-power-slider] 子槽声明被拒，退回无子槽模式：": "[dsh-codex-power-slider] child slot declaration rejected, falling back to no child slot: ",
 "[dsh-codex-power-slider] 挂载失败：": "[dsh-codex-power-slider] mount failed: "
};
    let T = (key, params) => {
      const template = en[key] === undefined ? key : en[key];
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
    };

    /* 几何：卡片 / 轨道 / 拖柄的尺寸集中在这里，CSS 与拖拽计算共用同一组常量，
       避免两头各写一份数字对不上。 */
    /* 几何：按 Codex 原版比例收一档（之前整体偏大：标题字、滑杆高度、拖柄、内距）。
       面板 282→262，内距 15→13，轨道 26→22，拖柄 29→25。 */
    const CARD_W = 262
    const CARD_PAD = 13
    const TRACK_H = 22
    const KNOB_D = 25
    const TRACK_INSET = TRACK_H / 2
    /**
     * 气泡**固定宽度**（不是 max-width）。
     * 之前 CSS 是 `max-width: 360`、翻转判定也拿 360 去估：实际气泡内容只有两百来像素，
     * 于是「明明放得下」也被判成放不下 → 气泡翻到面板左侧、再被 clamp 到屏幕最左，
     * 视觉上就是「离得特别远、很丑」。固定宽度后左右位置可精确预测，
     * 且每一行的间距必然完全一致（用户要求）。
     */
    const TIP_W = 300
    /** 墨点环按拖柄直径等比缩放（基准是 46px 拖柄的那组测量值）。 */
    const INK_SCALE = KNOB_D / 46
    /** 最高档「深入」时第二行显示的额度提醒（原版原文）。 */
    const QUOTA_HINT = T("使用额度消耗更快")
    /** 最高档星流的几何：轨道可视宽度 / 首尾各在容器外留多少（回绕不可见）。 */
    const FLOW_W = CARD_W - CARD_PAD * 2
    const FLOW_OVER = 16
    /** 第 ratio 档时，拖柄圆心 / 圆点相对轨道的 left 值（两端各留半个轨道高）。 */
    const posAt = (ratio) => 'calc(' + TRACK_INSET + 'px + (100% - ' + TRACK_H + 'px) * ' + ratio + ')'

    /* ======================================================================
     * 一、Codex 原版档位文案（当 DSH 适配器只给出 id、没有中文名时兜底）
     *     —— 取自 Codex 应用 thinking_efforts 的 short_label / description。
     * ==================================================================== */
    const CODEX_TIERS = [
      { short: T("轻度"), full: T("快速思考"), desc: T("提供快速且深思熟虑的回复") },
      { short: T("标准"), full: T("思考中"), desc: T("平衡思考时间与回复速度") },
      { short: T("深度"), full: T("进阶思考"), desc: T("延长思考时间以处理复杂问题") },
      { short: T("极高"), full: T("极高 Thinking"), desc: T("适用于复杂问题的极高推理深度") },
      { short: T("深入"), full: T("深度思考"), desc: T("针对高难度问题提供更深入的分析") },
    ]
    const CODEX_TIER_BY_ID = {
      none: 0, min: 0, minimal: 0, minimal_effort: 0,
      low: 1, light: 1,
      standard: 2, medium: 2, normal: 2,
      high: 3, extended: 3,
      xhigh: 3, 'x-high': 3,
      max: 4,
    }

    /* ======================================================================
     * 二、样式（走 DSH 主题 token，暗色下与 Codex 原版取色一致）
     * ==================================================================== */
    const CSS = `
/* 触发器与浮层共用一套 token 作用域：卡片是 portal 到 document.body 的，
   不再是 .dshcps-root 的后代，所以两处都必须声明变量。 */
.dshcps-root,.dshcps-pop,.dshcps-tip,.dshcps-models{
  --dshcps-card:#2d2d2d; --dshcps-line:rgba(255,255,255,.06);
  --dshcps-accent:#447ac6; --dshcps-accent-dim:#2f5fa8;
  --dshcps-sub:#b8b8b8; --dshcps-sub-hover:#dcdcdc; --dshcps-icon:#808181;
  --dshcps-track:#3f3f3f; --dshcps-dot:#636363; --dshcps-knob:#ffffff;
  --dshcps-panel:#2c2c2c; --dshcps-row-hover:#3a3a3a; --dshcps-row:#d4d4d4;
  --dshcps-dim:#808181; --dshcps-tip:#3a3a3a; --dshcps-tip-text:#e8e8e8;
  --dshcps-shadow:0 18px 48px rgba(0,0,0,.45),0 2px 8px rgba(0,0,0,.35);
}
.dshcps-root{display:inline-flex; align-items:center; font-family:var(--dsw-font-family,system-ui,sans-serif)}
.dshcps-pop,.dshcps-tip,.dshcps-models{font-family:var(--dsw-font-family,system-ui,sans-serif)}
body:not([data-ds-dark-theme]) .dshcps-root,
body:not([data-ds-dark-theme]) .dshcps-pop,
body:not([data-ds-dark-theme]) .dshcps-models,
body:not([data-ds-dark-theme]) .dshcps-tip{
  --dshcps-card:#ffffff; --dshcps-line:rgba(0,0,0,.07);
  --dshcps-sub:#6b6b6b; --dshcps-sub-hover:#111111; --dshcps-icon:#8a8a8a;
  --dshcps-track:#ececec; --dshcps-dot:#c4c4c4;
  --dshcps-panel:#ffffff; --dshcps-row-hover:#f1f1f1; --dshcps-row:#161616;
  --dshcps-dim:#8a8a8a; --dshcps-tip:#f6f6f6; --dshcps-tip-text:#161616;
  --dshcps-shadow:0 18px 48px rgba(0,0,0,.14),0 2px 8px rgba(0,0,0,.08);
}

/* ---------- composer 入口：Codex 原版那个圆角胶囊 ----------
   不是原生 ModelSelect 的 28px trigger，而是 Codex 的「选择推理强度 ⌄」胶囊：
   32px 高、左右 14px、13px 字、圆角 999px、半透明深底、无明显边框、hover 变亮。 */
/* 收起态：**原版 Harness 模型选择器**的外观（28px 单行、模型名 + 档位 + 12px 箭头）。
   点开后才变成 Codex 胶囊（见下方 .dshcps-chip.is-open），这样上方卡片里已经显示的
   模型名/档位不会在下面重复一遍 —— 避免"上下同时显示同样信息"的杂糅。 */
.dshcps-chip{
  display:flex; align-items:center; gap:4px;
  /* 两态**行盒高度必须完全一致**：切换时 composer 那一行不能重排
     （用户反馈：模型名和「选择推理强度」字号不同 → 切换时上下间距变化，看着很奇怪）。
     差异只允许来自背景/圆角/左右内距。 */
  box-sizing:border-box; height:30px; padding:0 8px;
  max-width:min(360px,45cqw); min-width:0;
  border:0; border-radius:var(--dsw-radius-sm); background:0 0;
  color:var(--dsw-alias-label-secondary); font-family:inherit; font-size:13px;
  font-weight:var(--dshcps-chip-weight,500); line-height:20px;
  -webkit-font-smoothing:antialiased;
  cursor:pointer;
  transition:background .12s ease,color .12s ease,padding .12s ease;
}
.dshcps-chip:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}
/* 打开态 = Codex 原版胶囊：**同样是 30px 高**（不靠高度制造胶囊感），
   只加大左右内距 + 999 圆角 + 半透明底。 */
.dshcps-chip.is-open:not([disabled]){
  height:30px; padding:0 14px; gap:6px; border-radius:999px;
  background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)) 35%,rgba(255,255,255,.11));
  color:var(--dsw-alias-label-primary);
}
/* 模型列表打开时，下方入口切到「次要/虚」状态（Codex 行为：这时它只是回到卡片的路标）。
   注意与 is-open 区分：卡片打开但没开列表时仍是正常色。 */
.dshcps-chip.is-selecting:not([disabled]){
  color:var(--dsw-alias-label-caption);
  background:color-mix(in srgb,var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07)) 55%,transparent);
}
.dshcps-chip.is-selecting .dshcps-chip-chev{color:var(--dsw-alias-label-caption);opacity:.72}
.dshcps-chip:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.dshcps-chip[disabled]{opacity:.5;cursor:default}
.dshcps-chipLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcps-chipEffort{
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:var(--dsw-alias-label-caption); flex-shrink:1000;
}
.dshcps-chip-chev{flex:none;color:var(--dsw-alias-label-caption);transition:transform .12s}
.dshcps-chip.is-open .dshcps-chip-chev{transform:rotate(180deg)}

/* ---------- 卡片 ---------- */
.dshcps-pop{
  position:fixed; z-index:1200; width:${CARD_W}px; box-sizing:border-box;
  padding:10px ${CARD_PAD}px 9px; border-radius:16px; border:1px solid var(--dshcps-line);
  background:var(--dshcps-card); color:var(--dshcps-row); box-shadow:var(--dshcps-shadow);
  animation:dshcps-pop-in .17s cubic-bezier(.2,0,0,1);
}
@keyframes dshcps-pop-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}

.dshcps-head{position:relative;text-align:center}
.dshcps-title{font-size:14px;font-weight:600;line-height:1.25;letter-spacing:.01em;color:var(--dshcps-accent);transition:color .18s ease}
.dshcps-title.is-ultra{
  background:linear-gradient(92deg,#5b2ee0 0%,#8a4dff 58%,#5a35c0 100%);
  -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; color:transparent;
}
/* 档位标题 + 模型名 = **一整块圆角分段**（Codex 那张图里的阴影区块覆盖这两行）。
   整块是 button，所以点哪都算点中；hover / 打开态才出圆角底 + 细边框。 */
.dshcps-segment{
  display:inline-flex; flex-direction:column; align-items:center; gap:2px;
  min-width:124px; padding:6px 16px 7px; margin:0 auto;
  border:1px solid transparent; border-radius:12px; background:none;
  font:inherit; cursor:pointer;
  transition:background .12s ease,border-color .12s ease;
}
.dshcps-segment:hover,.dshcps-segment.is-open{
  background:var(--dshcps-row-hover); border-color:var(--dshcps-line);
}
.dshcps-segment:focus-visible{outline:2px solid var(--dshcps-accent);outline-offset:2px}

/* 模型名这一行现在只是段落里的一行文字（点击由外层整块承担） */
.dshcps-sub{
  display:inline-flex; align-items:center; justify-content:center; gap:4px;
  border:0; background:none; padding:0; font:inherit; font-size:12px;
  color:var(--dshcps-sub); cursor:inherit; border-radius:0;
  transition:color .15s ease,opacity .12s ease-out;
}
.dshcps-badge{
  margin-left:4px; padding:0 4px; border-radius:4px;
  font-size:9px; line-height:14px; font-weight:600; letter-spacing:.2px;
  color:#7fb3ff; background:rgba(127,179,255,.16);
}
.dshcps-segment:hover .dshcps-sub,.dshcps-segment.is-open .dshcps-sub{color:var(--dshcps-sub-hover)}
/* 左上/右上两个图标按钮：**同尺寸 27×27、图标 16px、同一条顶线**，
   top:1px 让它们的中心基本落在档位标题那一行（之前 top:-3/-2 偏高了一点）。 */
.dshcps-reset{
  position:absolute; top:1px; right:-6px; width:27px; height:27px; display:grid; place-items:center;
  border:0; background:none; padding:0; color:var(--dshcps-icon); cursor:pointer; border-radius:8px;
  transition:background .15s ease,color .15s ease;
}
.dshcps-reset:hover{background:var(--dshcps-row-hover);color:var(--dshcps-sub-hover)}
.dshcps-reset[disabled]{opacity:.4;cursor:default}
/* 左上角「闪电」开关（镜像右上角的重置按钮）：
   未开启 = 空心闪电、caption 灰色；开启 = 白色实心 + 一圈微弱光晕。
   和重置按钮完全同尺寸、同一顶线。 */
.dshcps-boost{
  position:absolute; top:1px; left:-6px; width:27px; height:27px; display:grid; place-items:center;
  border:0; background:none; padding:0; color:var(--dsw-alias-label-caption); cursor:pointer;
  border-radius:8px; transition:background .15s ease,color .15s ease,box-shadow .15s ease;
}
.dshcps-boost:hover{background:var(--dshcps-row-hover);color:var(--dshcps-sub-hover)}
.dshcps-boost.is-on{
  color:#fff;
  box-shadow:0 0 0 1px rgba(255,255,255,.16),0 0 10px rgba(255,255,255,.22);
}
@media (prefers-reduced-motion:reduce){
  .dshcps-boost{transition:none}
}
/* 第二行是两个内容叠在同一个格子里：临时额度提醒 ↔ 可点的模型名。
   纯透明度交叉淡化 120ms、不做位移，所以卡片高度不会跳。 */
.dshcps-subwrap{
  margin-top:2px; display:grid; place-items:center; height:16px; line-height:16px;
  font-size:11.5px; color:var(--dshcps-sub);
}
.dshcps-subwrap>*{grid-area:1 / 1}
/* 额度提醒：原版就是普通副标题灰字 —— 无警示色、无图标、不可点。 */
.dshcps-quota{
  opacity:0; pointer-events:none; user-select:none; white-space:nowrap;
  transition:opacity .12s ease-out;
}
.dshcps-subwrap[data-notice=true] .dshcps-quota{opacity:1}
.dshcps-subwrap[data-notice=true] .dshcps-sub{opacity:0; pointer-events:none}
@media (prefers-reduced-motion:reduce){
  .dshcps-quota,.dshcps-sub{transition:none}
}

/* ---------- 模型列表：Codex 原生独立浮层 ---------- */
.dshcps-models{
  position:fixed; z-index:1200; box-sizing:border-box;
  display:flex; flex-direction:column;
  width:${CARD_W}px; max-height:min(360px,calc(100vh - 96px));
  padding:6px 6px 8px; border-radius:16px; border:1px solid var(--dshcps-line);
  background:var(--dshcps-card); color:var(--dshcps-row);
  box-shadow:var(--dshcps-shadow); overflow:hidden;
}
.dshcps-modelsHead{
  flex:none; display:flex; align-items:center; justify-content:space-between;
  padding:4px 6px 6px; font-size:11.5px; line-height:16px; color:var(--dshcps-dim);
}
.dshcps-modelsClose{
  width:22px; height:22px; display:grid; place-items:center;
  border:0; border-radius:7px; background:none; color:var(--dshcps-icon); cursor:pointer;
}
.dshcps-modelsClose:hover{background:var(--dshcps-row-hover);color:var(--dshcps-sub-hover)}
.dshcps-modelsBody{min-height:0;overflow-y:auto;overscroll-behavior:contain}
.dshcps-modelsGroup+.dshcps-modelsGroup{margin-top:4px;border-top:1px solid var(--dshcps-line);padding-top:4px}
/* 分组标题和模型名必须一眼分得开：
   分组 = 11.5px / 600 / 灰（dim），模型名 = 13px / 400 / 亮（row）。 */
.dshcps-group-head{padding:8px 10px 4px}
.dshcps-group-name{font-size:11px;font-weight:500;line-height:16px;letter-spacing:.02em;color:#929292}
.dshcps-group-sub{font-size:11px;line-height:15px;color:var(--dshcps-sub)}

/* ---------- 滑杆 ---------- */
.dshcps-track{
  position:relative; margin-top:11px; height:${TRACK_H}px; border-radius:999px;
  background:var(--dshcps-track); cursor:pointer; touch-action:none;
  box-shadow:inset 0 1px 0 rgba(255,255,255,.05);
}
.dshcps-fill{
  position:absolute; left:0; top:0; bottom:0; width:0; border-radius:999px; overflow:hidden;
  /* 填充层整块是**装饰**（渐变 + Ultra 材质 + 极光 + 星尘），一律不接收指针：
     保证点/拖一定落到 .dshcps-track 自己的 pointerdown 上，不会被新加的图层吃掉。 */
  pointer-events:none;
  background:linear-gradient(90deg,var(--dshcps-accent-dim),var(--dshcps-accent));
  transition:width .18s cubic-bezier(.2,.9,.25,1),background .24s ease;
}
/* 最高档（Ultra）：一条 2 倍宽的材质（左半基础蓝、右半紫蓝本体），用
   background-position 把「取景窗」从右往左推 —— 紫色连同星尘一起从右边缘铺开。
   只动 background-position 的插值一定平滑，而且两半在基础蓝处接续，
   所以扫描前沿是一道柔和的过渡，不是一刀切。
   顶层那圈径向柔光不动，只呼吸，负责「材质里有光」而不是「白点堆叠」。 */
.dshcps-ultra{
  position:absolute; inset:0; overflow:hidden; border-radius:inherit; pointer-events:none;
  --dshcps-sweep:1.8s;
  /* 底光强度（深色主题）× 呼吸区间，乘出来约 .036–.059，属于「几乎看不出在动」的量级 */
  --dshcps-haze-alpha:.065;
  background-image:
    radial-gradient(ellipse at 54% 28%,
      rgba(211,203,255,.14) 0%, rgba(185,175,255,.05) 38%, rgba(185,175,255,0) 72%),
/* 紫侧色标（加深）：
   原来 74% 的峰值是 #9298ff（L*≈66），整条读成浅薰衣草；用户要「更深的紫色」，
   把峰值压到 #8420f0（L*≈42）、右端收到 #55109e，蓝→紫的走向保留。
   ⚠️ 不要再把峰值提回接近白的那版（#c2c6ff）：它会在扫描结束后留一条定住的亮带。
   需要「材质里有光」靠上面 4 层极光，不靠把底材提亮。 */
    linear-gradient(90deg,
      var(--dshcps-accent-dim) 0%, #2f5fa8 22%, var(--dshcps-accent) 50%,
      #5c46d8 58%, #7030e8 67%, #8420f0 76%, #6c17c8 86%,
      #55109e 100%);
  background-size:100% 100%, 200% 100%;
  background-repeat:no-repeat;
  background-position:0 0, 0% 0%;
  /* 两个动画并行：
     1) 扫描（background-position 右→左）；
     2) **材质淡入**（.2s）—— 没有它，材质在挂载那一帧整体硬跳
        （实测右段亮度 +29.8/255），读起来就是「一个蓝色的东西突然出现」。
        淡入期间底下是 fill 自己的纯蓝渐变，颜色接续，不会闪。 */
  animation:dshcps-ultra-sweep var(--dshcps-sweep) linear both,
            dshcps-ultra-in .2s ease-out both;
}
@keyframes dshcps-ultra-in{ from{opacity:0} to{opacity:1} }
/* 两段式：起手用 12% 的时间（约 0.22s）把紫色快速推出来一小截（32% 进度，平稳减速不是硬弹），
   剩下 88% 的时间再慢慢铺满 —— 用逐关键帧的 animation-timing-function 分段。 */
@keyframes dshcps-ultra-sweep{
  0%{
    background-position:0 0, 0% 0%;
    animation-timing-function:cubic-bezier(.30,.70,.35,1);
  }
  12%{
    background-position:0 0, 32% 0%;
    animation-timing-function:cubic-bezier(.28,.06,.30,1);
  }
  100%{background-position:0 0, 100% 0%}
}
/* 浅色主题：底光再弱一档，运动与渐变范围不变 */
body:not([data-ds-dark-theme]) .dshcps-ultra{
  --dshcps-haze-alpha:.035;
}
/* 材质底光：这一层本身**不再有会移动的光**（切档扫入仍由材质负责）。
   这层只做极弱的明暗呼吸，峰值乘完约 .036–.059 —— 属于「材质不是死的」而不是「有东西在动」。
   之前那版会移动的散射光场已删除：它读不出流动，反而让整体发白、滑入变生硬。
   持续流动改由上方独立的 .dshcps-flow 星流层承担（「粒子快速流动」）。 */
.dshcps-ultra-haze{
  position:absolute; inset:0; pointer-events:none; border-radius:inherit;
  background:radial-gradient(ellipse at 61% 58%,
    rgba(190,150,255,var(--dshcps-haze-alpha)) 0%, rgba(170,130,255,.022) 34%, rgba(170,130,255,0) 72%);
  animation:dshcps-haze-breathe 13.6s ease-in-out infinite;
  animation-delay:-4.2s;
}
@keyframes dshcps-haze-breathe{ 0%,100%{opacity:.55} 50%{opacity:.9} }

/* ---------- 流光溢彩：多层极光（3 白/蓝/紫 + 1 深蓝） ----------
   用户要的是 Codex 那种「偏白的光条转过去、偏蓝的光条也转过去」的**极光感**，
   而不是「一层白高光停在那儿」。
   做法：4 个极宽（轨道 2.2 倍）的柔光域，各自**不同色系 / 不同周期 / 不同方向**，
   用 linear 匀速 + alternate 往返 —— 匀速保证端点也不「停一下」，
   不同周期(9/13/17/23s)与负 delay 让它们永不同步，任何时候相对位置都在变。
   - 单层 alpha .18–.30（低对比），边缘完全落在轨道外 → 圈不出边界；
   - 只动 transform / opacity；星尘在它们之上（z-index 更高）。
   - 入场扫光 1.8s 结束后 2.4s 起才淡入，避免叠成白闪。 */
.dshcps-aurora{
  position:absolute; inset:0; pointer-events:none; overflow:hidden; z-index:1;
}
.dshcps-aurora > i{
  position:absolute; top:-30%; bottom:-30%; left:-50%; width:200%; display:block;
  background-repeat:no-repeat; opacity:0;
  animation-name:dshcps-aurora-in;
  animation-duration:.9s;
  animation-timing-function:ease-out;
  animation-fill-mode:both;
}
/* 相位错开由 gpt-6.1-sol 给定（各层起始相位 ≠ 0）：
   a1 -1.7s / a2 -4.1s / a3 -8.3s / a4 -13.7s，叠加在各自 2.4/2.6/2.8/3.0s 的入场延迟上。
   这样四层永远不同步，任意时刻的相对位置都在变。 */
/* a1 偏白（最亮的一条，读成"白高光转过"） */
.dshcps-aurora > .a1{
  background-image:radial-gradient(7% 170% at 50% 45%,
    rgba(232,226,255,.34) 0%, rgba(232,226,255,.13) 46%, rgba(232,226,255,0) 76%);
  /* 「呼吸」只负责入场之后的小幅明暗，**绝不能在入场前生效**：
     ⚠️ 曾经的 bug —— 基类写的 animation-fill-mode:both 会作用到本层**三个**动画，
     而 breathe（opacity .65→1）排在最后、延迟 2.4s，于是在延迟阶段就把 opacity 顶到 .65，
     盖掉了 aurora-in 的 opacity:0；再叠加 x1 起点 translateX(-16%)，
     结果就是「刚滑到最高档，左边突然冒出一条白条」（用户三次报这个问题）。
     现在把 breathe 的 fill-mode 单独设成 none（入场前不参与遮罩），
     并让它晚于 aurora-in 结束（2.4s + .9s = 3.3s）才启动、且从 opacity:1 起手，
     这样 0 → 2.4s 全透明，2.4s 起淡入，3.3s 起才呼吸，全程无跳变。 */
  animation-name:dshcps-aurora-in, dshcps-aurora-x1, dshcps-aurora-breathe;
  animation-duration:.9s, 8.5s, 4.5s;
  animation-delay:2.4s, 0.7s, 3.3s;
  animation-iteration-count:1, infinite, infinite;
  animation-direction:normal, alternate, alternate;
  animation-timing-function:ease-out, ease-in-out, ease-in-out;
  animation-fill-mode:both, both, none;
}
/* a2 偏蓝 */
.dshcps-aurora > .a2{
  background-image:radial-gradient(10% 180% at 50% 55%,
    rgba(92,128,238,.38) 0%, rgba(92,128,238,.14) 50%, rgba(92,128,238,0) 78%);
  animation-name:dshcps-aurora-in, dshcps-aurora-x2;
  animation-duration:.9s, 13s;
  animation-delay:2.6s, -1.5s;
  animation-iteration-count:1, infinite;
  animation-direction:normal, alternate;
  animation-timing-function:ease-out, linear;
}
/* a3 偏紫 */
.dshcps-aurora > .a3{
  background-image:radial-gradient(5% 160% at 50% 50%,
    rgba(150,100,255,.34) 0%, rgba(150,100,255,.13) 52%, rgba(150,100,255,0) 80%);
  animation-name:dshcps-aurora-in, dshcps-aurora-x3;
  animation-duration:.9s, 16s;
  animation-delay:2.8s, -5.5s;
  animation-iteration-count:1, infinite;
  animation-direction:normal, alternate;
  animation-timing-function:ease-out, linear;
}
/* a4 深蓝（压底，给"极光"厚度） */
.dshcps-aurora > .a4{
  background-image:radial-gradient(8% 140% at 50% 60%,
    rgba(56,84,190,.30) 0%, rgba(56,84,190,.11) 55%, rgba(56,84,190,0) 82%);
  animation-name:dshcps-aurora-in, dshcps-aurora-x4;
  animation-duration:.9s, 23s;
  animation-delay:3s, -10.7s;
  animation-iteration-count:1, infinite;
  animation-direction:normal, alternate;
  animation-timing-function:ease-out, linear;
}
@keyframes dshcps-aurora-in{ from{opacity:0} to{opacity:1} }
/* 白光层的"呼吸"（61：整层小幅明暗，不要周期性闪白）。
   from 必须是 1 —— 它与 aurora-in 的终值（1）接上，启动时不会有跳变。 */
@keyframes dshcps-aurora-breathe{ from{opacity:1} to{opacity:.72} }
@keyframes dshcps-aurora-x1{ from{transform:translate3d(-16%,1.4px,0)} to{transform:translate3d(16%,-1.4px,0)} }
@keyframes dshcps-aurora-x2{ from{transform:translate3d(14%,-1.6px,0)} to{transform:translate3d(-14%,1.6px,0)} }
@keyframes dshcps-aurora-x3{ from{transform:translate3d(-10%,1.8px,0)} to{transform:translate3d(10%,-1.8px,0)} }
@keyframes dshcps-aurora-x4{ from{transform:translate3d(8%,-1px,0)} to{transform:translate3d(-8%,1px,0)} }

/* ---------- 星流（flow）：最高档「快速流动的星尘」 ----------
   与旧的「原地漂浮」不同，这里是**有方向的流光**：三档景深（远/中/近）
   以不同速度从右往左穿过整条滑杆，近景带彗尾、远景只留针尖，形成视差。
   只用 transform / opacity 动画，不碰布局；粒子在容器两侧外起停，
   靠 .dshcps-fill 的 overflow:hidden 裁掉首尾 —— 循环回绕永远看不见「跳回起点」。
   旧版「固定锚点 + 正交漂移 + 碰撞预算」整套删除：位移只有 2–3px，读不出流动。 */
.dshcps-flow{
  position:absolute; inset:0; pointer-events:none; z-index:1;
  animation:dshcps-ultra-stars-in var(--dshcps-sweep) linear both;
}
/* 揭示沿用原来的两段式：右边缘先露出一小片，再跟着紫色一起铺满。 */
@keyframes dshcps-ultra-stars-in{
  0%{
    clip-path:inset(0 0 0 96% round 999px); opacity:.2;
    animation-timing-function:cubic-bezier(.30,.70,.35,1);
  }
  12%{
    clip-path:inset(0 0 0 65% round 999px); opacity:.85;
    animation-timing-function:cubic-bezier(.28,.06,.30,1);
  }
  100%{clip-path:inset(0 0 0 0% round 999px); opacity:1}
}
/* 外层：水平穿场。匀速直线 —— 流光忽快忽慢会读成「卡顿」。 */
.dshcps-stream{
  position:absolute; left:0; top:var(--y); width:0; height:0;
  opacity:var(--o);
  animation:dshcps-flow-pass var(--dur) linear infinite;
  animation-delay:var(--delay);
}
@keyframes dshcps-flow-pass{
  from{transform:translate3d(var(--start),0,0)}
  to{transform:translate3d(var(--end),0,0)}
}
/* 远景的针尖会闪：闪烁周期（3.1–5.9s）与穿场周期（3.2–4.6s）互不整除，不会同步。
   中/近景不加闪烁 —— 大而亮的点一明一暗会读成「接触不良」。 */
.dshcps-stream--far{
  animation-name:dshcps-flow-pass, dshcps-flow-twinkle;
  animation-duration:var(--dur), var(--tw);
  animation-delay:var(--delay), var(--twdelay);
  animation-timing-function:linear, ease-in-out;
  animation-iteration-count:infinite, infinite;
}
@keyframes dshcps-flow-twinkle{
  0%,100%{opacity:calc(var(--o) * .55)}
  50%{opacity:var(--o)}
}
/* 星头：径向软边 + 上下微浮。浮动用独立 transform，和穿场互不覆盖。 */
.dshcps-spark{
  position:absolute; left:0; top:0; display:block; border-radius:50%;
  width:var(--size); height:var(--size);
  margin-left:calc(var(--size) * -.5); margin-top:calc(var(--size) * -.5);
  background:radial-gradient(circle,
    var(--core,#fff) 0 30%, var(--edge,rgba(214,222,255,.85)) 58%, rgba(214,222,255,0) 100%);
  animation:dshcps-flow-bob var(--bobdur) ease-in-out infinite alternate;
  animation-delay:var(--bobdelay);
}
@keyframes dshcps-flow-bob{
  from{transform:translate3d(0,var(--bob),0)}
  to{transform:translate3d(0,calc(var(--bob) * -1),0)}
}
/* 彗尾：从星头右缘向右拖出（运动方向右→左，尾巴自然留在身后），沿长度淡出。
   只有中/近景有；远景是纯针尖。 */
.dshcps-spark::after{
  content:''; position:absolute; left:100%; top:50%;
  width:var(--tail); height:var(--tailh); border-radius:999px;
  transform:translate(0,-50%);
  background:linear-gradient(90deg,var(--glow,rgba(225,230,255,.5)),rgba(225,230,255,0));
  opacity:var(--tailo,.6);
}
/* 三层景深：远景小而实、中景有实核、近景大而虚并带一圈很淡的光晕。
   软边用径向渐变做，不用 filter:blur（手机上 blur 很贵）。 */
.dshcps-stream--far .dshcps-spark{background:var(--core,#cfdcff); animation:none}
.dshcps-stream--far .dshcps-spark::after{display:none}
.dshcps-stream--mid .dshcps-spark{box-shadow:0 0 2.5px rgba(190,202,255,.38)}
.dshcps-stream--near .dshcps-spark{box-shadow:0 0 5px rgba(206,212,255,.55),0 0 1px rgba(255,255,255,.8)}

/* 拖柄溅射：原版量到的是一圈**深蓝紫「墨点」**（比卡片底更暗、更蓝），不是发光白点 ——
   白点会和轨道里的星尘混成一类。用户确认它是**一次性飞溅出来然后消失**：
   从柄缘起飞、边飞边淡、约 500ms 后整组不见，不常驻、不循环、不留在原地。 */
.dshcps-ink-ring{
  position:absolute; top:50%; width:0; height:0; overflow:visible;
  pointer-events:none; z-index:2;
}
.dshcps-ink-ray{
  position:absolute; left:0; top:0; width:0; height:0;
  opacity:0; transform:translate3d(var(--x0),var(--y0),0);
}
.dshcps-ink-ray::before{
  content:''; position:absolute; left:0; top:0;
  width:var(--size); height:var(--size); border-radius:50%;
  background:var(--ink); transform:translate(-50%,-50%);
}
.dshcps-ink-ring.is-bursting .dshcps-ink-ray{
  animation-name:dshcps-ink-fly,dshcps-ink-fade;
  animation-duration:var(--duration),var(--duration);
  animation-delay:var(--delay,0ms),var(--delay,0ms);
  animation-timing-function:cubic-bezier(.16,.58,.30,1),linear;
  animation-iteration-count:1,1;
  animation-fill-mode:both,both;
}
/* 只管位移：不在最远处停住等淡出 */
@keyframes dshcps-ink-fly{
  from{transform:translate3d(var(--x0),var(--y0),0)}
  to{transform:translate3d(var(--x1),var(--y1),0)}
}
/* 只管透明度：42% 之后边飞边淡 */
@keyframes dshcps-ink-fade{
  0%{opacity:.85}
  12%,42%{opacity:1}
  100%{opacity:0}
}
@media (prefers-reduced-motion:reduce){
  .dshcps-ultra,.dshcps-ultra-haze,
  .dshcps-stream,.dshcps-stream--far,.dshcps-spark{animation:none}
  /* 直接停在扫描终态；底光保持常亮（不呼吸），材质仍然「有光」 */
  .dshcps-ultra{background-position:0 0, 100% 0%}
  .dshcps-ultra-haze{opacity:1}
  /* 亮带不流动，停在中间且更淡：材质仍在，但不「跑」 */
  .dshcps-aurora>i{animation:none;opacity:.6;transform:translateX(0)}
  /* 星流停成一片静态星野：粒子按各自相位钉在不同位置，不全部堆到左端 */
  .dshcps-flow{animation:none;clip-path:none;opacity:1}
  .dshcps-stream{opacity:var(--o);transform:translate3d(var(--rest),0,0)}
  .dshcps-spark{transform:none}
  .dshcps-ink-ring{display:none}
}
.dshcps-dot{
  position:absolute; top:50%; width:3px; height:3px; margin:-1.5px 0 0 -1.5px; border-radius:50%;
  background:var(--dshcps-dot); transition:background .18s ease;
}
.dshcps-dot.is-passed{background:rgba(255,255,255,.45)}
.dshcps-knob{
  position:absolute; top:50%; width:${KNOB_D}px; height:${KNOB_D}px; border-radius:50%; background:var(--dshcps-knob);
  z-index:3;
  transform:translate(-50%,-50%); box-shadow:0 2px 10px rgba(0,0,0,.38),0 0 0 1px rgba(0,0,0,.05);
  /* 跳档用「先快后慢」的曲线：利落地跳到目标档，尾巴收得住，不回弹。 */
  transition:left .18s cubic-bezier(.2,.9,.25,1); will-change:left;
}
.dshcps-track.is-dragging{cursor:grabbing}
/* 拖动中**同样**保留这段过渡：Codex 原版就是「越过区间中点 → 方块自己跳过去」，
   而不是连续追着指针爬。拖柄和填充用同一条曲线、同一时长，保证同步。 */
.dshcps-track.is-dragging .dshcps-knob{transform:translate(-50%,-50%) scale(1.045)}
.dshcps-track.is-locked{cursor:default;opacity:.6}

/* ---------- 模型列表 ---------- */
/* 弹出模型列表时，**整张卡片都不显示**（只留列表）—— 用户要求：
   不要「列表在上面、卡片还杵在下面」。用 visibility 而不是不渲染，
   这样卡片的固定定位还在，列表的锚点不会因此跳动。 */
.dshcps-pop.is-models{
  visibility:hidden;
}
.dshcps-panel-title{
  position:sticky; top:0; z-index:1; margin:-1px -1px 2px; padding:6px 2px 6px;
  background:var(--dshcps-card);
  font-size:11.5px; color:var(--dshcps-dim);
}
.dshcps-group{padding-top:3px}
/* 分组标题 = 11.5px/600/灰；模型名 = 13px/400/亮 —— 两者必须一眼分得开。
   （这里和上面一版重复声明过，统一以这套为准，避免被后面覆盖。） */
.dshcps-group-head{display:block;padding:8px 10px 4px}
.dshcps-group-name{font-size:11.5px;font-weight:600;color:var(--dshcps-dim);line-height:16px;letter-spacing:.02em}
.dshcps-group-sub{font-size:11px;color:var(--dshcps-sub);line-height:15px}
/* 组与组之间一条分隔线，视觉上分出层级 */
.dshcps-modelsGroup+.dshcps-modelsGroup,
.dshcps-group+.dshcps-group{margin-top:4px;border-top:1px solid var(--dshcps-line);padding-top:4px}
/* 行按 Codex 原生菜单：34px 高、左右 10px、hover 圆角底、选中项右侧打勾 */
.dshcps-row{
  position:relative; display:flex; align-items:center; justify-content:space-between; gap:9px;
  width:100%; height:34px; padding:0 10px; box-sizing:border-box; border:0; border-radius:10px;
  background:none; font:inherit; font-size:13px; color:var(--dshcps-row); text-align:left; cursor:pointer;
  transition:background .12s ease;
}
.dshcps-row{transition:background .1s ease}
.dshcps-row:hover{background:var(--dshcps-row-hover)}
.dshcps-row:focus-visible{outline:none;background:var(--dshcps-row-hover)}
.dshcps-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcps-row-effort{flex:none;font-size:11px;color:var(--dshcps-dim)}
.dshcps-check{flex:none;width:14px;height:14px;color:var(--dshcps-row)}
.dshcps-empty{padding:8px 2px;font-size:12px;color:var(--dshcps-dim)}
.dshcps-tip{
  /* 宽度**贴合文案**（用户：固定宽 300 让短文案左侧留出一大片空白，很丑）：
     max-content + 300px 上限 —— 短文案框宽 = 文字宽 + 内距，长文案到 300 后折行。
     几何仍可精确计算：非翻转态钉左边缘（left = 面板右 + 5），翻转态钉右边缘（right 定位），
     所以宽度变化不会让与菜单的间距变大。13px / 内距 8×14 / 圆角 12 —— 照 Codex 原版。 */
  position:fixed; z-index:1201; width:max-content; max-width:var(--dshcps-tip-max, ${TIP_W}px); box-sizing:border-box;
  padding:8px 14px; border-radius:12px; text-align:right;
  background:var(--dshcps-tip); color:var(--dshcps-tip-text);
  font-size:13px; line-height:1.4; white-space:normal;
  /* 必须折行时尽量均衡断行，避免第二行只剩一两个字（用户看到「…一线闭源」+「模型」，
     误以为文字被截断）。 */
  text-wrap:balance; word-break:break-word;
  box-shadow:0 6px 22px rgba(0,0,0,.34),0 1px 4px rgba(0,0,0,.22);
  pointer-events:none; animation:dshcps-pop-in .13s ease;
}
.dshcps-error{margin-top:6px;font-size:11px;color:var(--dsw-alias-state-error-primary,#e5484d)}
.dshcps-note{margin-top:4px;font-size:11px;color:var(--dshcps-dim);text-align:center}
`

    if (typeof document !== 'undefined' && !document.querySelector('style[data-dshcps]')) {
      const style = document.createElement('style')
      style.dataset.dshcps = '1'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* ======================================================================
     * 三、小工具
     * ==================================================================== */
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)

    function hashSeed(text) {
      let hash = 2166136261
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
      }
      return hash >>> 0
    }

    /** 确定性伪随机：同一个档位每次渲染星点位置一致。 */
    function makeRandom(seed) {
      let state = seed >>> 0
      return () => {
        state = (state + 0x6d2b79f5) | 0
        let t = Math.imul(state ^ (state >>> 15), 1 | state)
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
    }

    /** 档位显示文案：DSH 给了 name 就用 DSH 的，否则回落到 Codex 文案。 */
    function tierText(effort, index, total) {
      const id = String((effort && effort.id) || '')
      const lower = id.toLowerCase()
      if (lower === 'ultra') {
        return {
          short: (effort && effort.name) || 'Ultra',
          full: (effort && effort.name) || 'Ultra',
          desc: (effort && effort.description) || T("针对高难度问题提供更深入的分析"),
        }
      }
      const hasOwnName = effort && typeof effort.name === 'string' && effort.name.length > 0 && effort.name !== id
      if (hasOwnName) {
        return { short: effort.name, full: effort.name, desc: effort.description || '' }
      }
      let tier = CODEX_TIER_BY_ID[lower]
      if (tier === undefined) tier = clamp(total <= 1 ? 2 : Math.round((index / Math.max(1, total - 1)) * 4), 0, 4)
      const preset = CODEX_TIERS[tier]
      return { short: preset.short, full: preset.full, desc: (effort && effort.description) || preset.desc }
    }

    function flattenModels(catalog) {
      const out = []
      if (!catalog || !Array.isArray(catalog.groups)) return out
      for (const group of catalog.groups) {
        if (!group || !Array.isArray(group.models)) continue
        for (const model of group.models) out.push({ provider: group.id, group, model })
      }
      return out
    }

    function findEntry(entries, selection) {
      if (!selection) return null
      return (
        entries.find((e) => e.provider === selection.provider && e.model.id === selection.model) || null
      )
    }

    function effortIndexOf(model, effortId) {
      const efforts = (model && model.reasoning && model.reasoning.efforts) || []
      if (!efforts.length) return -1
      const found = efforts.findIndex((e) => e.id === effortId)
      return found >= 0 ? found : 0
    }

    /* ======================================================================
     * 模型简介兜底表
     * ----------------------------------------------------------------------
     * 宿主 catalog 里不少模型没有 description，或者直接给的是**英文**原文 ——
     * 悬停气泡里漏出英文（用户反馈「怎么还有介绍是英文呢？V4 PRO」）。
     *
     * 所以渲染优先级改成：
     *   ① 这张表命中（我们手写的中文文案，按模型名归一化匹配）
     *   ② 没命中 → 用 catalog 自带 description，但**仅当它含中文**（英文原文不再外露）
     *   ③ 都没有 → 不弹气泡
     * 每条 12–24 字、统一产品文案口吻；事实来源为各厂商公开资料。
     * ==================================================================== */
    const MODEL_BLURBS = [
      // [归一化关键字, 简介]  —— 越具体的写在越前面（首个命中即返回）
      // 自研/内部命名系列（GPT-6.x / 5.x 的 Sol、Astra、Luna、Terra）：按定位写中性描述，不承诺具体参数
      // 【顺序很重要】首个命中即返回；'6luna' 会匹配到 "gpt56luna"，所以 5.6 系列必须写在 6.x 之前
      ['61sol', T("当前主力旗舰，前沿智能体能力，适合复杂多步任务")],
      ['56terra', T("上一代均衡档，通用能力与成本较平衡")],
      ['56luna', T("上一代快速模型，适合处理较简单的任务")],
      ['56sol', T("上一代旗舰，编程与复杂推理表现稳定")],
      ['55', T("更早期版本，能力有限，仅建议兼容性场景")],
      ['6astra', T("面向超长任务的编排型模型，擅长多步拆解与协同")],
      ['6luna', T("同代快速档，低延迟，适合日常对话与轻量任务")],
      ['6sol', T("上一代旗舰，适合编程和日常工作")],
      ['hy4', T("腾讯混元 Hy4 预览版，智能体与工具调用更强")],
      ['hy3', T("腾讯混元 Hy3，智能体能力强化，适合多步任务编排")],
      ['kimik2.7code', T("月之暗面编程专用版，面向代码生成、重构与调试")],
      ['kimik2.6', T("月之暗面开源旗舰，代码能力对齐一线闭源模型")],
      ['kimik3', T("月之暗面新一代旗舰，长上下文与复杂推理")],
      ['longcat', T("美团开源万亿参数 MoE，通用推理与多任务处理")],
      ['mimov2.6flash', T("小米 MiMo-V2.6 快速档，低延迟，适合日常交互")],
      ['mimov2.6pro', T("小米 MiMo-V2.6 增强档，复杂推理与长任务")],
      ['mimov2.6', T("小米 MiMo-V2.6 系列，强化学习规模化，自我提升")],
      ['mimov2.5pro', T("小米 MiMo-V2.5 增强档，推理与工具调用更强")],
      ['mimov2.5', T("小米 MiMo-V2.5 系列，通用对话与推理均衡")],
      ['mimo', T("小米 MiMo 系列，通用对话与推理均衡")],
      ['minimax', T("MiniMax M2 系列，偏生产力与智能体场景")],
      ['qwen3.8max', T("阿里通义千问规模最大、能力最强的旗舰模型")],
      ['qwen3.8', T("阿里通义千问 3.8 系列，中文与代码通用能力强")],
      ['qwen3.7max', T("阿里通义千问旗舰档，复杂推理与长任务")],
      ['qwen3.7plus', T("阿里通义千问 3.7 增强档，性价比与通用能力均衡")],
      ['qwen3.6plus', T("阿里通义千问 3.6 增强档，日常对话与代码均可用")],
      ['qwen', T("阿里通义千问系列，中文与代码通用能力强")],
      ['grok', T("xAI Grok 系列，长思维链推理与实时信息结合")],
      ['musespark', T("Meta 开源权重模型，偏编程与智能体")],
      ['deepseekv41flash', T("DeepSeek 官方 V4 快速档，低延迟，适合日常改动")],
      ['deepseekv4pro', T("DeepSeek V4 旗舰，智能体与复杂任务更强")],
      ['deepseekv4', T("DeepSeek V4 系列，长上下文与复杂推理")],
      ['deepseek', T("DeepSeek 官方模型，中文与代码表现均衡")],
    ]
    /** 表里没命中的模型给一句诚实的通用描述 —— 用户要求「每一行悬停都要有东西看」。 */
    const FALLBACK_BLURB = T("通用对话模型，具体能力以所选接口为准")
    /**
     * 归一化模型名：小写 + **只保留字母数字**（去掉空格/下划线/点/连字符/斜杠/括号等）。
     * 这样 `Kimi K2.6` / `kimi-k2.6` / `KIMI_K2.6` / `kimi k26` 都会归一成同一个 key，
     * 同一个模型在不同 provider / 不同接口下也共用同一条介绍（用户明确要求）。
     */
    const normalizeModelKey = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
    /** 关键字也按同一规则归一化，避免表里写 "qwen3.8"、key 里却是 "qwen38" 这种对不上 */
    const BLURB_TABLE = MODEL_BLURBS.map(([needle, blurb]) => [normalizeModelKey(needle), blurb])
    /** 取一条模型简介：① 本表（中文）优先 ② 退回 catalog 中文描述 ③ 通用兜底（保证非空）。 */
    function modelBlurb(provider, item) {
      if (!item) return ''
      const key = normalizeModelKey(item.id) + '|' + normalizeModelKey(item.name)
      for (const [needle, blurb] of BLURB_TABLE) {
        if (needle !== '' && key.indexOf(needle) >= 0) return blurb
      }
      const description = typeof item.description === 'string' ? item.description.trim() : ''
      // 宿主给的是英文原文时不再外露（用户明确要求别出现英文介绍）
      if (description !== '' && /[\u4e00-\u9fa5]/.test(description)) return description
      return FALLBACK_BLURB
    }

    function CloseIcon() {
      return h(
        'svg',
        { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4 4l8 8M12 4l-8 8',
          stroke: 'currentColor',
          strokeWidth: '1.6',
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * 闪电图标（左上角「子代理加速」开关）：
     * filled=false 空心（stroke），filled=true 白色实心（fill）。两者同一路径，尺寸 13px。
     */
    function LightningIcon({ filled = false }) {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M9.2 1.6 3.4 9.1h3.6l-1 5.3 6-7.6H8.3l.9-5.2Z',
          stroke: 'currentColor',
          strokeWidth: filled ? '1.1' : '1.25',
          strokeLinejoin: 'round',
          fill: filled ? 'currentColor' : 'none',
        }),
      )
    }

    /** 胶囊上的下拉箭头（Codex 是朝下的 ⌄，打开时旋转 180° 变 ⌃）。 */
    function ChipChevron() {
      return h(
        'svg',
        {
          className: 'dshcps-chip-chev',
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M4 6.2 8 10.2l4-4',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function CheckIcon() {
      return h(
        'svg',
        { className: 'dshcps-check', viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M3.2 8.4l3.1 3.1 6.5-7',
          stroke: 'currentColor',
          strokeWidth: '1.7',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function ChevronIcon({ size = 11 }) {
      return h(
        'svg',
        {
          className: 'dshcps-chip-chev',
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          d: 'M6 3.5L10.5 8 6 12.5',
          stroke: 'currentColor',
          strokeWidth: '1.6',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function ResetIcon({ size = 16 }) {
      /* 参考 Codex 原版（80×72 裁图）：一个回环箭头，**缺口在顶部、约 70°**，
         箭头头部落在缺口的左上端。之前缺口只有十几度、几乎闭合，用户要更明显的断开。
         圆心 (9,9)、半径 5.6：两端点关于 x=9 对称、都在 y=4.5 上（√(3.3²+4.5²)=5.58 ≈ r）。 */
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 18 18',
          fill: 'none',
          'aria-hidden': 'true',
        },
        h('path', {
          /* 顺时针弧 310°：缺口 50° 在左上（用户：70° 略大，收小一档）。
             圆心 (9,9)、半径 5.6；sweep=1 保证圆心取在下方（否则圆心会跑到视口外、弧看不见）。 */
          d: 'M7.52 3.6A5.6 5.6 0 1 1 3.92 6.66',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
        }),
        h('path', {
          /* 箭头：贴着弧的新终点 (3.92,6.66)，两片翼朝轨迹的反方向张开 */
          d: 'M4.92 8.96 3.92 6.66 1.72 8.16',
          stroke: 'currentColor',
          strokeWidth: '1.5',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * 星流参数表：44 颗，三层景深。
     * 旧的「原地漂浮」位移只有 2–3px，读不出流动；这里每颗都有**真正的方向速度**：
     *   远景 20 颗（针尖）≈ 268px / 3.2–4.6s = 60–77px/s
     *   中景 16 颗（短尾）≈ 276px / 2.1–3.0s = 92–129px/s
     *   近景  8 颗（彗尾）≈ 284px / 1.35–1.9s = 150–209px/s
     * 视差比约 1 : 1.6 : 2.5 —— 近处快、远处慢，才有深度而不是一张贴纸。
     * y 用分层抽样（每层在高度上均分再抖动），比纯随机更容易铺满、不结块。
     * 位置与周期一次性生成（模块级），不参与组件每次 render。
     */
    function makeFlow(seed) {
      const random = makeRandom(seed)
      const between = (min, max) => min + random() * (max - min)
      const pick = (list) => list[Math.floor(random() * list.length) % list.length]
      const specs = [
        {
          kind: 'far', count: 20,
          size: [0.7, 1.1], opacity: [0.2, 0.38], duration: [3.2, 4.6],
          bob: [0.5, 0.9], bobDur: [3.2, 5.2], twinkle: [3.1, 5.9], tail: [0, 0],
        },
        {
          kind: 'mid', count: 16,
          size: [1.2, 1.7], opacity: [0.38, 0.58], duration: [2.1, 3.0],
          bob: [0.6, 1.0], bobDur: [2.6, 4.4], tail: [5, 8],
        },
        {
          kind: 'near', count: 8,
          size: [2.0, 2.6], opacity: [0.55, 0.75], duration: [1.35, 1.9],
          bob: [0.7, 1.1], bobDur: [2.2, 3.6], tail: [10, 16],
        },
      ]
      /* 色板：远景偏冷蓝，中景近白，近景白心带一点紫边（和极光的紫侧呼应）。 */
      const cores = {
        far: ['#cfdcff', '#b9c8ff', '#e6ecff'],
        mid: ['#ffffff', '#e6e9ff', '#dfe4ff'],
        near: ['#ffffff', '#eef0ff', '#d9d3ff'],
      }
      const edges = {
        far: ['transparent'],
        mid: ['rgba(208,218,255,.85)', 'rgba(226,220,255,.85)', 'rgba(198,212,255,.82)'],
        near: ['rgba(206,216,255,.8)', 'rgba(222,214,255,.78)', 'rgba(235,240,255,.82)'],
      }
      const glows = {
        far: ['transparent'],
        mid: ['rgba(214,224,255,.45)', 'rgba(224,218,255,.4)'],
        near: ['rgba(236,240,255,.62)', 'rgba(222,212,255,.55)'],
      }
      const out = []
      let id = 0
      for (const spec of specs) {
        for (let i = 0; i < spec.count; i++) {
          const size = between(spec.size[0], spec.size[1])
          const duration = between(spec.duration[0], spec.duration[1])
          const tail = spec.tail[1] > 0 ? between(spec.tail[0], spec.tail[1]) : 0
          /* 相位分层：同一层的粒子均匀铺在 0..1 的相位上，再各抖 ±0.3 个格，
             既不会挤成一团，也不会像刻度一样排得整整齐齐。
             负延迟 = 从流动中途开始，第一帧就已经铺满整条轨道。 */
          const phase = (i + 0.5 + between(-0.3, 0.3)) / spec.count
          const bobDur = between(spec.bobDur[0], spec.bobDur[1])
          const twinkle = spec.twinkle ? between(spec.twinkle[0], spec.twinkle[1]) : 0
          out.push({
            id: id++,
            kind: spec.kind,
            size,
            duration,
            tail,
            phase,
            style: {
              '--y': (3 + ((i + 0.5) / spec.count) * (TRACK_H - 6) + between(-0.7, 0.7)).toFixed(2) + 'px',
              '--size': size.toFixed(3) + 'px',
              '--o': between(spec.opacity[0], spec.opacity[1]).toFixed(3),
              '--core': pick(cores[spec.kind]),
              '--edge': pick(edges[spec.kind]),
              '--glow': pick(glows[spec.kind]),
              '--start': (FLOW_W + FLOW_OVER).toFixed(2) + 'px',
              '--end': (-(tail + FLOW_OVER)).toFixed(2) + 'px',
              '--dur': duration.toFixed(3) + 's',
              '--delay': (-phase * duration).toFixed(3) + 's',
              '--rest': (8 + (FLOW_W - 16) * phase).toFixed(2) + 'px',
              '--bob': between(spec.bob[0], spec.bob[1]).toFixed(2) + 'px',
              '--bobdur': bobDur.toFixed(3) + 's',
              '--bobdelay': (-random() * bobDur).toFixed(3) + 's',
              '--tail': tail.toFixed(2) + 'px',
              '--tailh': Math.max(0.8, size * 0.4).toFixed(2) + 'px',
              '--tailo': (spec.kind === 'near' ? 0.5 + random() * 0.25 : 0.35 + random() * 0.2).toFixed(3),
              '--tw': (twinkle ? twinkle : duration).toFixed(3) + 's',
              '--twdelay': (-random() * (twinkle ? twinkle : duration)).toFixed(3) + 's',
            },
          })
        }
      }
      // 打散渲染顺序（DOM 顺序不影响定位，但调试时不会按景深连续读）
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        const swap = out[i]
        out[i] = out[j]
        out[j] = swap
      }
      /* 机械自检（不参与渲染）：速度落在设计区间内、y 不出轨道。 */
      const ys = out.map((p) => parseFloat(p.style['--y']))
      out.audit = {
        count: out.length,
        speed: out.map((p) => (FLOW_W + FLOW_OVER * 2 + p.tail) / p.duration),
        yRange: [Math.min(...ys), Math.max(...ys)],
      }
      return out
    }

    const FLOW = makeFlow(0x53a91f2d)

    /** 墨点环：角度 / 飞行终点半径 / 点径 / 颜色 / 错峰（46px 拖柄基准，按 INK_SCALE 缩放）。 */
    const INK_SPECS = [
      { angle: -95, radius: 49, size: 7.0, ink: '#20204f', delay: 0 },
      { angle: -63, radius: 46, size: 6.8, ink: '#21214b', delay: 14 },
      { angle: -30, radius: 52, size: 7.2, ink: '#242750', delay: 6 },
      { angle: -2, radius: 48, size: 7.0, ink: '#252851', delay: 22 },
      { angle: 38, radius: 51, size: 7.4, ink: '#20204f', delay: 10 },
      { angle: 86, radius: 45, size: 6.6, ink: '#21214b', delay: 28 },
      { angle: 163, radius: 47, size: 7.0, ink: '#242750', delay: 16 },
      { angle: 220, radius: 50, size: 7.2, ink: '#252851', delay: 4 },
    ]
    const INK_START_RADIUS = 24
    const INK_START_DELAY = 70
    const INK_DURATION = 400
    /** 整组从触发到完全消失：起步延迟 + 单颗时长 + 最大错峰。 */
    const INK_TOTAL = INK_START_DELAY + INK_DURATION + 28

    /** 单颗星流：外层负责水平穿场，星头负责上下微浮 + 彗尾。 */
    function FlowParticle({ particle }) {
      return h(
        'span',
        { className: 'dshcps-stream dshcps-stream--' + particle.kind, style: particle.style },
        h('i', { className: 'dshcps-spark' }),
      )
    }

    /** 最高档：滑动的紫蓝材质 + 四层极光 + 44 颗快速穿场的星尘。
     *  星尘与材质一起从右往左铺开；铺满后星流持续流动 ——
     *  （「粒子快速流动」覆盖了早先「铺满后没有移动光点」的约定；
     *   静置的亮光带仍然没有，流动只由粒子承担。） */
    function UltraLayer({ flowRef }) {
      return h(
        'div',
        { className: 'dshcps-ultra', 'aria-hidden': 'true' },
        h('div', { className: 'dshcps-ultra-haze' }),
        /* 流光溢彩：4 层不同色系（白/蓝/紫/深蓝）的极宽柔光域，各自周期与方向不同，
           匀速往返 → 任何时候都在缓慢重组，像极光在天上飘。 */
        h(
          'div',
          { className: 'dshcps-aurora' },
          h('i', { className: 'a1' }),
          h('i', { className: 'a2' }),
          h('i', { className: 'a3' }),
          h('i', { className: 'a4' }),
        ),
        h(
          'div',
          { className: 'dshcps-flow', ref: flowRef },
          FLOW.map((particle) => h(FlowParticle, { key: particle.id, particle })),
        ),
      )
    }

    /**
     * 拖柄溅射（一次性）：8 颗深蓝紫墨点从柄缘起飞、边飞边淡、约 500ms 后整组消失。
     * 靠 key 重挂载来重播；不常驻、不循环，离开最高档立即消失。
     */
    function InkRing({ knobLeft, playKey }) {
      return h(
        'div',
        {
          key: playKey,
          className: 'dshcps-ink-ring is-bursting',
          style: { left: knobLeft },
          'aria-hidden': 'true',
        },
        INK_SPECS.map((spec, i) => {
          const angle = (spec.angle * Math.PI) / 180
          const startRadius = INK_START_RADIUS * INK_SCALE
          const endRadius = spec.radius * INK_SCALE
          return h('span', {
            key: i,
            className: 'dshcps-ink-ray',
            style: {
              '--x0': (Math.cos(angle) * startRadius).toFixed(2) + 'px',
              '--y0': (Math.sin(angle) * startRadius).toFixed(2) + 'px',
              '--x1': (Math.cos(angle) * endRadius).toFixed(2) + 'px',
              '--y1': (Math.sin(angle) * endRadius).toFixed(2) + 'px',
              '--size': (spec.size * INK_SCALE).toFixed(2) + 'px',
              '--ink': spec.ink,
              '--duration': INK_DURATION + 'ms',
              '--delay': INK_START_DELAY + spec.delay + 'ms',
            },
          })
        }),
      )
    }

    /* ======================================================================
     * 四、数据钩子：读投影 + 拉目录
     * ==================================================================== */
    function useModelSelection(ctx, sessionId) {
      const [projection, setProjection] = React.useState(null)
      React.useEffect(() => {
        if (!sessionId) return undefined
        let face = null
        try {
          const binding = ctx.sessions.binding(sessionId)
          face = binding && binding.session && binding.session.projections
            ? binding.session.projections.faceOf('modelSelection')
            : null
        } catch (error) {
          face = null
        }
        if (!face || typeof face.getSnapshot !== 'function') return undefined
        const sync = () => setProjection(face.getSnapshot() || null)
        sync()
        const dispose = typeof face.subscribe === 'function' ? face.subscribe(sync) : null
        return () => {
          if (typeof dispose === 'function') dispose()
        }
      }, [ctx, sessionId])
      return projection
    }

    function useModelCatalog(ctx) {
      const [catalog, setCatalog] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        const load = () => {
          Promise.resolve()
            .then(() => ctx.remote.session.modelCatalog())
            .then((result) => {
              if (!alive) return
              if (result && result.ok) setCatalog(result.value)
            })
            .catch(() => {})
        }
        load()
        const disposers = []
        try {
          if (ctx.remote.$on) disposers.push(ctx.remote.$on('llm/adapters-updated', load))
        } catch (error) {}
        try {
          if (ctx.on) disposers.push(ctx.on('connection/reset', load))
        } catch (error) {}
        return () => {
          alive = false
          for (const dispose of disposers) {
            try {
              if (typeof dispose === 'function') dispose()
            } catch (error) {}
          }
        }
      }, [ctx])
      return catalog
    }

    /* ======================================================================
     * 左上角「闪电」开关 = 子代理加速
     * ----------------------------------------------------------------------
     * 语义：开启后，**下一条发出的用户消息**末尾追加一句偏好说明，
     * 让模型更愿意（在合适时）派出子代理。只带一条（发出即消费），开关保持常亮。
     *
     * 做法：宿主没有「发送前」注册式钩子，但 composer 的出站都经过
     * `conversation().sendSession(...)`；这里 `ctx.inject(['conversation'])`
     * 包裹 send/sendSession 两个实例方法，在出站前改写文本，dispose 时还原。
     *
     * ⚠️ 代价：这是包裹服务实例方法，不是官方钩子 —— 宿主若改成内部直连或
     *    重命名 sendSession，钩子会静默失效（失效时只是「不追加」，不会发坏消息）；
     *    追加的这句话对用户**可见**（会出现在会话记录里），因为要让模型真正读到它。
     *    已删除早先基于 settings.subagent.maxActiveSubagents 的写法 ——
     *    那是「并行容量」，与「派出意愿」不是一回事，避免一个按钮两套语义。
     * ==================================================================== */
    const BOOST_STORAGE_KEY = 'dshcps.subagentBoost'
    /* **不再往用户消息里追加任何文字**（硬性要求，别改回去）。
       闪电开关从此只做界面状态；「更愿意派子代理」由 AGENTS.md 的常驻规则负责，与开关无关。 */

    /** 开关状态：**持久**（localStorage 记住），点亮后不再自动熄灭。 */
    let boostArmed = false
    /**
     * 待追加的一句话：与开关状态**解耦**。只有"状态切换那一次"会挂上一句，
     * 下一条出站消息消费后即清空 —— 之后闪电继续亮着，但不再重复啰嗦
     * （模型读到一次就记住了）。
     * 刻意**不持久化**：刷新页面后不应把上一会话的待发文案再补发一次。
     */
    let pendingSentence = null
    const boostSubscribers = new Set()
    const readBoostFlag = () => {
      try {
        const raw = window.localStorage.getItem(BOOST_STORAGE_KEY)
        return raw === null ? true : raw === '1' // 本机默认开启
      } catch (cause) {
        return true
      }
    }
    const writeBoostFlag = (on) => {
      try {
        window.localStorage.setItem(BOOST_STORAGE_KEY, on ? '1' : '0')
      } catch (cause) {}
    }
    const notifyBoost = () => {
      for (const fn of [...boostSubscribers]) {
        try {
          fn(boostArmed)
        } catch (cause) {}
      }
    }
    /**
     * 开关唯一写入口：同步持久状态 + localStorage + 通知 UI，
     * 并在「状态真的变化」时挂上对应的那一句话（切换各说一次）。
     */
    const setBoostArmed = (on) => {
      const next = !!on
      if (next === boostArmed) return
      boostArmed = next
      pendingSentence = null // 不注入文本（见上）
      writeBoostFlag(boostArmed)
      notifyBoost()
    }
    const subscribeBoost = (fn) => {
      boostSubscribers.add(fn)
      return () => boostSubscribers.delete(fn)
    }
    boostArmed = readBoostFlag()

    /**
     * 出站改写：只在有 **pendingSentence** 时追加，并消费掉它 —— 只带下一条。
     * 注意：**不再改动开关状态**（旧实现会把开关一起关掉，用户要求常亮）。
     * 空文本（纯附件）不追加，也不消费，留给下一条真正的文字消息。
     */
    function applyBoostToText(text) {
      if (!pendingSentence || typeof text !== 'string' || text.trim() === '') return text
      const sentence = pendingSentence
      pendingSentence = null
      return text + '\n\n' + sentence
    }

    /**
     * 安装出站钩子。
     * 依据（读宿主源码确认）：@deepseek-ai/dsh-client-ui-conversation 的
     * ConversationController 暴露 send(text) 与 sendSession(session, text, ...)，
     * 浏览器侧 composer 的默认 sink 正是 conversation().sendSession(...)（client.js:14334）。
     * 宿主没有"发送前"注册式钩子，因此这里包裹这两个实例方法，并在 dispose 时还原。
     */
    function installBoostHook(ctx) {
      if (!ctx || typeof ctx.inject !== 'function') return
      try {
        ctx.inject(['conversation'], (scope) => {
          const svc = scope.conversation
          if (!svc) return
          const restores = []
          const wrap = (name, textIndex) => {
            const original = svc[name]
            if (typeof original !== 'function') return
            svc[name] = function (...args) {
              if (typeof args[textIndex] === 'string') args[textIndex] = applyBoostToText(args[textIndex])
              return original.apply(this, args)
            }
            restores.push(() => {
              svc[name] = original
            })
          }
          wrap('send', 0)
          wrap('sendSession', 1)
          scope.effect(() => () => {
            while (restores.length) restores.pop()()
          })
        })
      } catch (cause) {
        if (typeof console !== 'undefined') {
          console.warn(T("[dsh-codex-power-slider] 出站钩子安装失败（闪电开关将只改本地状态）："), cause)
        }
      }
    }

    /* ======================================================================
     * 五、主组件
     * ==================================================================== */
    function PowerSlider(props) {
      const { sessionId, locked } = props
      const ctx = props.__ctx
      /* 闪电开关：状态在模块级（出站钩子要读它），组件订阅变化。 */

      const [open, setOpen] = React.useState(false)
      const [boost, setBoost] = React.useState(readBoostFlag)
      React.useEffect(() => subscribeBoost(setBoost), [])
      const [view, setView] = React.useState('dial')
      const [dragIndex, setDragIndex] = React.useState(null)
      /** 提交期间占位档位：松手→RPC 回来→投影更新 之间，避免 isUltra 掉一下又回来
          （那会让额度提醒闪一下再显示一次、墨点也重播）。只占位到投影确认为止。 */
      const [pendingIndex, setPendingIndex] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [hovered, setHovered] = React.useState(null)
      const [pos, setPos] = React.useState(null)
      // 额度提醒：只要**停在**最高档就显示 1.6s，然后淡回模型名
      const [showQuota, setShowQuota] = React.useState(false)
      // 每次重新点亮都自增，用来把 1.6s 计时重新起算
      const [quotaTick, setQuotaTick] = React.useState(0)
      // 拖柄溅射：非 0 时挂载墨点环并播放一次，播完（或离开最高档）归 0
      const [burstKey, setBurstKey] = React.useState(0)

      const anchorRef = React.useRef(null)
      const popRef = React.useRef(null)
      /** 模型列表是**另一个 portal**，必须单独持有引用：否则「点外部关闭」的捕获监听
          会把点列表当成点外部，在 pointerdown 阶段就把列表关掉，行的 click 永远不触发
          —— 这正是「点别的模型切不过去」的根因。 */
      const modelsRef = React.useRef(null)
      /** 打开/切换视图的时间戳：pointerdown 关闭逻辑用它做 120ms 宽限 */
      const openedAtRef = React.useRef(0)
      /** 进入模型视图时**量一次**卡片高度并冻结：hover 重渲染不再让它上下动 */
      const measuredCardHRef = React.useRef(null)
      const trackRef = React.useRef(null)
      /** 星流容器：拖动时用它拿到全部流动动画，临时提速 */
      const flowRef = React.useRef(null)

      const projection = useModelSelection(ctx, sessionId)
      const catalog = useModelCatalog(ctx)
      const entries = React.useMemo(() => flattenModels(catalog), [catalog])

      const fallback = catalog && catalog.default ? catalog.default : null
      const current = (projection && (projection.next || projection.lastUsed)) || fallback
      const entry = findEntry(entries, current)

      const model = entry ? entry.model : null
      const efforts = (model && model.reasoning && model.reasoning.efforts) || []
      const defaultEffortId = (model && model.reasoning && model.reasoning.defaultEffort) || (efforts[0] && efforts[0].id)
      const activeEffortId = (current && current.reasoningEffort) || defaultEffortId
      const realIndex = effortIndexOf(model, activeEffortId)
      /* 档位取值的优先级：拖动预览 > 提交占位 > 真实投影。
         这样松手那一刻不会因为投影还没回来而「回退一档」，提醒/墨点也就不会二次触发。 */
      /* 档位取值的优先级：拖动预览 > 提交占位 > 真实投影。
         这样松手那一刻不会因为投影还没回来而「回退一档」，提醒/墨点也就不会二次触发。 */
      const index =
        dragIndex !== null ? dragIndex : pendingIndex !== null ? pendingIndex : realIndex
      const total = efforts.length
      const isUltra = total >= 3 && index === total - 1
      const effort = total ? efforts[clamp(index, 0, total - 1)] : null
      const text = effort ? tierText(effort, index, total) : null

      /* ---------- 额度提醒：停在最高档就显示，1.6s 后淡回模型名 ----------
         用 isUltra（含拖动预览）而不是提交态：**拖到那一档的瞬间就亮**，不用等松手，
         也不用等 selectModel 的 RPC 往返。离开最高档立刻收起并清掉定时器。 */
      const flashQuota = React.useCallback(() => setQuotaTick((n) => n + 1), [])

      React.useEffect(() => {
        if (!isUltra) {
          setShowQuota(false)
          return
        }
        setShowQuota(true)
        setQuotaTick((n) => n + 1)
      }, [isUltra])

      React.useEffect(() => {
        if (!showQuota) return undefined
        const timer = setTimeout(() => setShowQuota(false), 1600)
        return () => clearTimeout(timer)
      }, [showQuota, quotaTick])

      /* ---------- 提交占位的释放（三种出口，保证不会永久占位） ---------- */
      React.useEffect(() => {
        // ① 投影已经跟上了 → 占位功成身退（此时 index 由 realIndex 接管，画面不变）
        if (pendingIndex !== null && realIndex === pendingIndex) setPendingIndex(null)
      }, [pendingIndex, realIndex])
      React.useEffect(() => {
        // ② 提交失败（error 被写上来）→ 立刻回到真实投影，不假装已经切过去
        if (pendingIndex !== null && error) setPendingIndex(null)
      }, [pendingIndex, error])
      React.useEffect(() => {
        // ③ 兜底：万一宿主既不更新投影也不报错，2.5s 后释放，绝不卡在占位态
        if (pendingIndex === null) return undefined
        const timer = setTimeout(() => setPendingIndex(null), 2500)
        return () => clearTimeout(timer)
      }, [pendingIndex])

      /* ---------- 拖柄溅射：进入最高档时玩一次，约 0.5s 后整组消失 ---------- */
      React.useEffect(() => {
        if (!isUltra) {
          setBurstKey(0)
          return undefined
        }
        setBurstKey((n) => n + 1)
        const timer = setTimeout(() => setBurstKey(0), INK_TOTAL)
        return () => clearTimeout(timer)
      }, [isUltra])

      /* ---------- 星流提速：拖动时把「手速」变成星流的涌动 ----------
         只改 WAAPI 的 playbackRate，不重启动画、不跳相位；松手落回 1。
         不支持 getAnimations 的环境（或减少动态偏好）静默跳过，动画照常。 */
      React.useEffect(() => {
        const node = flowRef.current
        if (!node || typeof node.getAnimations !== 'function') return
        try {
          if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
              window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
        } catch (error) {}
        const rate = dragIndex === null ? 1 : 1.8
        try {
          for (const animation of node.getAnimations({ subtree: true })) {
            const name = String(animation.animationName || '')
            if (name.indexOf('dshcps-flow') !== 0) continue
            animation.playbackRate = rate
          }
        } catch (error) {}
      }, [dragIndex, isUltra])

      /* ---------- 位置：浮在触发器上方 ---------- */
      const place = React.useCallback(() => {
        const anchor = anchorRef.current
        const pop = popRef.current
        if (!anchor || !pop) return
        const rect = anchor.getBoundingClientRect()
        const width = pop.offsetWidth || CARD_W
        const height = pop.offsetHeight || 200
        const left = clamp(rect.left + rect.width / 2 - width / 2, 8, Math.max(8, window.innerWidth - width - 8))
        let top = rect.top - 8 - height
        if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 8)
        setPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }))
      }, [])

      React.useLayoutEffect(() => {
        openedAtRef.current = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
        if (!open) {
          setPos(null)
          return undefined
        }
        place()
        /* 只在「窗口/页面真的滚动」时重定位。
           模型列表内部滚动也会冒泡到这里（capture=true），之前会让浮层跟着跳一下。 */
        const onChange = (event) => {
          const t = event && event.target
          if (t && t !== document && t !== window) {
            const pop = popRef.current
            const models = modelsRef.current
            if ((pop && pop.contains(t)) || (models && models.contains(t))) return
          }
          place()
        }
        window.addEventListener('resize', onChange)
        window.addEventListener('scroll', onChange, true)
        return () => {
          window.removeEventListener('resize', onChange)
          window.removeEventListener('scroll', onChange, true)
        }
      }, [open, place, view, total])

      /* 进入模型视图后量一次卡片高度（此时卡片 body 为空、高度已定型），冻结给面板定位用。 */
      React.useLayoutEffect(() => {
        if (!open || view !== 'models') {
          measuredCardHRef.current = null
          return
        }
        const pop = popRef.current
        if (pop) measuredCardHRef.current = pop.offsetHeight || 150
      }, [open, view])

      /* ---------- 关闭行为 ---------- */
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const x = event.clientX
          const y = event.clientY
          const hits = (node) => {
            if (!node) return false
            if (typeof node.contains === 'function' && event.target && node.contains(event.target)) return true
            if (typeof node.getBoundingClientRect !== 'function') return false
            const r = node.getBoundingClientRect()
            return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
          }
          if (hits(popRef.current)) return
          if (hits(modelsRef.current)) return
          if (hits(anchorRef.current)) return
          /* 宽限期：刚打开 / 刚切到模型视图的 120ms 内一律不关。
             这两个时刻 portal 可能正在重挂载，ref 会短暂为 null，纯 ref 判定会误关。 */
          if (typeof performance !== 'undefined' && performance.now && performance.now() - openedAtRef.current < 120) return
          setOpen(false)
          setView('dial')
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          if (view === 'models') {
            setView('dial')
          } else {
            setOpen(false)
          }
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open, view])

      /* ---------- 写入 ---------- */
      const commit = React.useCallback(
        async (next) => {
          /* 兜底：任何提前返回都必须让用户看得见 —— 绝不允许「点了没反应」。
             （曾经的 bug：点模型行被当成点外部、面板在 pointerdown 就被关掉，
               请求根本没发出，又没有任何提示。） */
          if (!sessionId) {
            setError(T("没有会话，无法切换模型"))
            return
          }
          if (!next || !next.provider || !next.model) {
            setError(T("模型参数不完整，请求未发出"))
            setView('dial')
            return
          }
          setBusy(true)
          setError('')
          try {
            const request = { sessionId, provider: next.provider, model: next.model }
            if (next.reasoningEffort !== undefined && next.reasoningEffort !== null && next.reasoningEffort !== '') {
              request.reasoningEffort = next.reasoningEffort
            }
            const result = await ctx.remote.session.selectModel(request)
            if (!result || !result.ok) {
              const code = result && result.error ? result.error.code : ''
              const message = result && result.error ? result.error.message : T("模型选择失败")
              /* 把宿主的英文错误码翻译成人话 —— 用户之前被一串英文
                 `session "…" is owned by subagent routing` 弄懵过。 */
              const friendly =
                code === 'session/writer-held'
                  ? T("会话被其他 DSH 进程占用，请退出后重试。")
                  : /owned by subagent routing|subagent routing/i.test(message)
                    ? T("当前会话由子代理路由接管，不能修改模型或思考强度。")
                    : message
              setError(friendly)
              // 失败时把卡片切回来，否则错误藏在被隐藏的卡片里，用户看不到
              setView('dial')
            }
          } catch (cause) {
            setError(String((cause && cause.message) || cause))
            setView('dial')
          } finally {
            setBusy(false)
          }
        },
        [ctx, sessionId],
      )

      const setEffortAt = React.useCallback(
        (nextIndex) => {
          if (!total || locked || busy) return
          const target = efforts[clamp(nextIndex, 0, total - 1)]
          if (!target || !current) return
          if (target.id === activeEffortId) return
          commit({ provider: current.provider, model: current.model, reasoningEffort: target.id })
        },
        [total, locked, busy, efforts, current, activeEffortId, commit],
      )

      /* 提交期间「占位档位」：松手 → RPC 回来 → 投影更新，中间会有一次渲染
         realIndex 还是旧档。若不占位，`isUltra` 会 true→false→true，
         额度提醒就会「闪一下再显示一次」，墨点也会重播。
         这里只占位到**投影确认**为止（或失败/超时立即释放），所以不会变成永久显示；
         同时拖动预览（dragIndex）优先级更高，「拖到就亮」的既定行为不变。 */
      const commitIndex = React.useCallback(
        (nextIndex) => {
          setPendingIndex(clamp(nextIndex, 0, Math.max(0, total - 1)))
          setEffortAt(nextIndex)
        },
        [setEffortAt, total],
      )

      const pickModel = React.useCallback(
        (nextEntry) => {
          const nextEfforts = (nextEntry.model.reasoning && nextEntry.model.reasoning.efforts) || []
          const keep = nextEfforts.some((e) => e.id === activeEffortId)
          const nextEffort =
            (keep ? activeEffortId : undefined) ||
            (nextEntry.model.reasoning && nextEntry.model.reasoning.defaultEffort) ||
            (nextEfforts[0] && nextEfforts[0].id)
          setView('dial')
          setHovered(null)
          // 换了模型，档位含义变了：旧的提交占位必须作废
          setPendingIndex(null)
          commit({ provider: nextEntry.provider, model: nextEntry.model.id, reasoningEffort: nextEffort })
        },
        [activeEffortId, commit],
      )

      const resetEffort = React.useCallback(() => {
        if (!current || !defaultEffortId) return
        setDragIndex(null)
        commit({ provider: current.provider, model: current.model, reasoningEffort: defaultEffortId })
      }, [current, defaultEffortId, commit])

      /* ---------- 拖拽 ---------- */
      /** 把指针位置折算成「连续档位坐标」（0 .. total-1，可为小数）。 */
      const levelPositionFromClientX = React.useCallback(
        (clientX) => {
          const track = trackRef.current
          if (!track || total <= 1) return { pos: 0, pxPerLevel: 1 }
          const rect = track.getBoundingClientRect()
          const radius = TRACK_INSET
          const usable = Math.max(1, rect.width - radius * 2)
          const ratio = clamp((clientX - rect.left - radius) / usable, 0, 1)
          return { pos: ratio * (total - 1), pxPerLevel: usable / (total - 1) }
        },
        [total],
      )

      /** 不带迟滞的直接吸附（pointerdown / 松手时的最终判定用）。 */
      const indexFromClientX = React.useCallback(
        (clientX) => {
          const { pos } = levelPositionFromClientX(clientX)
          return Math.round(pos)
        },
        [levelPositionFromClientX],
      )

      /* 「抽抽」根因之一：指针停在中点附近时 Math.round 会让档位在 i / i+1 之间
         每个 pointermove 反复翻转，拖柄的 transition 被一次次重启 → 看起来在抽搐。
         迟滞：离开当前档超过「半档 + HYST_PX」才换档；一旦超过就直接跳到最近档
         （不限一次跨几档，快速拖动依然跟手）。 */
      const HYST_PX = 11
      const dragIndexRef = React.useRef(null)
      const nextIndexWithHysteresis = React.useCallback(
        (clientX) => {
          const { pos, pxPerLevel } = levelPositionFromClientX(clientX)
          const cur = dragIndexRef.current
          if (cur === null || cur === undefined) return clamp(Math.round(pos), 0, Math.max(0, total - 1))
          const hyst = HYST_PX / Math.max(1, pxPerLevel) // 折算成「档」单位
          if (Math.abs(pos - cur) < 0.5 + hyst) return cur
          return clamp(Math.round(pos), 0, Math.max(0, total - 1))
        },
        [levelPositionFromClientX, total],
      )

      /* 子代理路由接管的会话：宿主禁止改模型/思考强度（原生 ModelSelect 也是这么判断可用性的
         —— `sessions.subagentAddress(sessionId) === undefined`）。这种情况**提前禁用**并说明，
         而不是让用户拖完之后吃一个英文报错。 */
      const subagentOwned = (() => {
        try {
          const sessions = ctx && ctx.sessions
          if (!sessions || typeof sessions.subagentAddress !== 'function') return false
          return sessions.subagentAddress(sessionId) !== undefined
        } catch (cause) {
          return false
        }
      })()

      const canUse = !!model && total > 0 && !locked && !subagentOwned
      const canOpen = !!model || !!catalog
      const onTrackDown = (event) => {
        if (!canUse) return
        event.preventDefault()
        /* Codex 原版的手感：**离散吸附**，不是连续跟手。
           指针在某一档的区间里动是不动的；越过区间中点（再多 7px 迟滞）后才跨到下一档，
           白色方块由 CSS transition 用先快后慢的曲线跳过去。 */
        const nextIndex = indexFromClientX(event.clientX)
        dragIndexRef.current = nextIndex
        // 只有「本来就在最高档、又点了最高档」才重新计时一次提醒；
        // 拖动中每次 move 都触发会让副标题交叉淡化反复重播 —— 另一个抖动来源。
        if (total >= 3 && nextIndex === total - 1 && realIndex === total - 1) flashQuota()
        setDragIndex(nextIndex)
        const move = (moveEvent) => {
          /* 只在档位**真的变了**时 setState：pointermove 频率很高，迟滞之后一次拖动通常
             只跨档几次，所以既不必 rAF 合并、也不会引发频繁重渲染。 */
          const idx = nextIndexWithHysteresis(moveEvent.clientX)
          if (idx === dragIndexRef.current) return
          dragIndexRef.current = idx
          setDragIndex(idx)
        }
        const up = (upEvent) => {
          document.removeEventListener('pointermove', move)
          document.removeEventListener('pointerup', up)
          /* 根因修复：松手**沿用拖动中最后显示的那一档**，不再用 round() 重算 ——
             否则指针停在边界另一侧时，松手会跳到相邻档，看起来就是「松手抽一下」。 */
          const lastShown = dragIndexRef.current
          const finalIndex =
            lastShown === null || lastShown === undefined ? indexFromClientX(upEvent.clientX) : lastShown
          dragIndexRef.current = null
          setDragIndex(null)
          commitIndex(finalIndex)
        }
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', up)
      }

      const onTrackKeyDown = (event) => {
        if (!canUse) return
        if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
          event.preventDefault()
          commitIndex(index - 1)
        } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
          event.preventDefault()
          commitIndex(index + 1)
        }
      }

      /* ---------- 悬停说明气泡 ----------
         位置在 onMouseEnter 时**按整列（模型面板）的左右边界算好并冻结**，render 只读取；
         之前每次渲染都用「当前行的 right」判定是否翻到左侧，行宽差一点就在左右之间跳。
         离开时延迟 90ms 隐藏，避免行与行之间的 2px 空隙造成气泡闪断。 */
      const tipHideTimer = React.useRef(0)
      const showTipNow = React.useCallback((next) => {
        if (tipHideTimer.current) {
          clearTimeout(tipHideTimer.current)
          tipHideTimer.current = 0
        }
        setHovered(next)
      }, [])
      const hideTipSoon = React.useCallback(() => {
        if (tipHideTimer.current) clearTimeout(tipHideTimer.current)
        tipHideTimer.current = setTimeout(() => {
          tipHideTimer.current = 0
          setHovered(null)
        }, 90)
      }, [])
      React.useEffect(() => () => {
        if (tipHideTimer.current) clearTimeout(tipHideTimer.current)
      }, [])
      const hideTipNow = React.useCallback(() => {
        if (tipHideTimer.current) {
          clearTimeout(tipHideTimer.current)
          tipHideTimer.current = 0
        }
        setHovered(null)
      }, [])
      const tipStyle = React.useMemo(() => {
        if (!hovered || !hovered.text) return null
        const style = { top: hovered.tipTop, transform: 'translateY(-50%)' }
        // 宽度贴合内容：只钉一侧，另一侧交给内容撑开
        if (hovered.tipLeft !== undefined) style.left = hovered.tipLeft
        if (hovered.tipRight !== undefined) style.right = hovered.tipRight
        /* 可用宽度随几何变化：右边放得下就放宽到 360（常见 22 字文案能单行），
           放不下再收窄到实际可用空间 —— 既不会折出孤字，也不会溢出视口。 */
        if (hovered.tipMax !== undefined) style['--dshcps-tip-max'] = hovered.tipMax + 'px'
        return style
      }, [hovered])
      /**
       * 气泡位置：**左右锚在模型面板上（固定），上下跟随当前悬停的那一行**。
       * - 左右：面板右边缘 + GAP（翻转时钉右边缘），保证与菜单的间距恒等；
       * - 上下：该行矩形中心，用 translateY(-50%) 垂直居中 —— 像 Codex 那样"气泡对着你正在看的那一行"；
       * - 注意别把历史的 bug 带回来：`left` 不能按行算（行宽差一点就在左右之间跳）。
       */
      const tipPlacement = (rowRect) => {
        const panel = modelsRef.current
        if (!panel) return { tipLeft: 8, tipRight: undefined, tipTop: 80 }
        const base = panel.getBoundingClientRect()
        /* 与菜单的间距 5px（用户对照 Codex 原版：气泡应紧贴菜单边缘）。
           翻转判定仍用**最坏情况 TIP_W（300px）**去估 —— 否则会重演
           "用 max-width 估翻转、结果被 clamp 到屏幕最左" 的那个 bug。 */
        const GAP = 5
        const flip = base.right + GAP + TIP_W > window.innerWidth - 8
        /* 这一侧的真实可用宽度：用于决定"能不能放宽到 360 单行"以及折行上限。 */
        const roomRight = window.innerWidth - 8 - (base.right + GAP)
        const roomLeft = base.left - GAP - 8
        const room = flip ? Math.max(120, roomLeft) : Math.max(120, roomRight)
        const tipMax = Math.min(360, Math.max(TIP_W, room))
        /* 垂直：跟随行中心；没有行矩形（退化情况）才回落到面板中心。
           夹在视口内，但**不是**回到固定位置 —— 只是避免贴边被裁。 */
        const anchorY = rowRect ? rowRect.top + rowRect.height / 2 : base.top + base.height / 2
        return {
          /* 非翻转：钉**左**边缘（left = 面板右 + GAP），宽度贴合内容也不影响间距；
             翻转：钉**右**边缘（right 定位），同样保证间距恒为 GAP。 */
          tipLeft: flip ? undefined : clamp(base.right + GAP, 8, Math.max(8, window.innerWidth - TIP_W - 8)),
          tipRight: flip ? Math.max(8, window.innerWidth - base.left + GAP) : undefined,
          tipMax,
          tipTop: clamp(anchorY, 24, Math.max(24, window.innerHeight - 24)),
        }
      }

      if (!sessionId) return null

      const ratio = total > 1 ? index / (total - 1) : 0
      const knobLeft = posAt(ratio)
      const chipLabel = text ? text.short : T("选择推理强度")

      const chip = h(
        'button',
        {
          ref: anchorRef,
          type: 'button',
          className:
            'dshcps-chip' +
            (open ? ' is-open' : '') +
            (open && view === 'models' ? ' is-selecting' : ''),
          disabled: !canOpen && !open,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          title: text ? text.full + ' · ' + (model ? model.name : '') : T("选择推理强度"),
          onClick: () => {
            setOpen((value) => !value)
            setView('dial')
          },
        },
        /* 收起态：原版 Harness 那样显示「模型名 + 档位 + ⌄」；
           打开后卡片里已经在显示模型名和档位了，这里改成中性文案「选择推理强度」，
           避免同一组信息上下各显示一遍。 */
        open
          ? h(React.Fragment, null, h('span', { className: 'dshcps-chipLabel' }, T("选择推理强度")))
          : h(
              React.Fragment,
              null,
              h('span', { className: 'dshcps-chipLabel' }, model ? model.name : T("选择模型")),
              text ? h('span', { className: 'dshcps-chipEffort' }, text.short) : null,
            ),
        h(ChipChevron, {}),
      )

      let card = null
      if (open) {
        const openModels = () => setView(view === 'models' ? 'dial' : 'models')
        /* 标题（档位）+ 模型名合成**一整块圆角分段**：Codex 那张图里的阴影区块
           就是覆盖这两行的，所以整块才是「打开模型列表」的点击区。
           额度提醒是纯展示，绝对定位覆盖在模型名那一行上，不占点击。 */
        const head = h(
          'div',
          { className: 'dshcps-head' },
          // 左上角闪电开关（镜像右上角重置）：空心=关，白色实心=开
          h(
            'button',
            {
              type: 'button',
              className: 'dshcps-boost' + (boost ? ' is-on' : ''),
              'aria-pressed': boost ? 'true' : 'false',
              'aria-label': boost ? T("子代理加速：已开启") : T("子代理加速：已关闭"),
              title: boost
                ? T("已开启：下一条消息会告诉模型优先考虑子智能体（只需说一次，之后保持开启）")
                : T("已关闭：开启后下一条消息会告诉模型优先考虑子智能体"),
              onClick: () => setBoostArmed(!boost),
            },
            h(LightningIcon, { filled: boost }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcps-segment' + (view === 'models' ? ' is-open' : ''),
              'aria-haspopup': 'dialog',
              'aria-expanded': view === 'models' ? 'true' : 'false',
              'aria-label': T("选择模型，当前模型：") + (model ? model.name : T("未选择")),
              onClick: openModels,
            },
            h('span', { className: 'dshcps-title' + (isUltra ? ' is-ultra' : '') }, text ? text.short : T("推理强度")),
            h(
              'span',
              { className: 'dshcps-subwrap', 'data-notice': showQuota ? 'true' : 'false' },
              h('span', { className: 'dshcps-quota', 'aria-hidden': 'true' }, QUOTA_HINT),
              h(
                'span',
                { className: 'dshcps-sub' },
                h(
                  'span',
                  null,
                  model && typeof props.renderSlot === 'function'
                    ? props.renderSlot(
                        'conversation.input.model.label',
                        { provider: { id: current.provider, name: current.provider }, model, placement: 'trigger', selected: true },
                        { fallback: model.name },
                      )
                    : model ? model.name : T("选择模型"),
                  model &&
                    current &&
                    typeof props.renderSlot !== 'function' &&
                    RELEASE_BADGE.providers.indexOf(current.provider) !== -1 &&
                    model.id === RELEASE_BADGE.modelId &&
                    model.name === RELEASE_BADGE.modelName &&
                    h('span', { className: 'dshcps-badge' }, RELEASE_BADGE.text),
                ),
                h(ChevronIcon, { size: 10 }),
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshcps-reset',
              disabled: !canUse || busy || !defaultEffortId || activeEffortId === defaultEffortId,
              title: T("恢复该模型的默认推理强度"),
              'aria-label': T("恢复默认"),
              onClick: resetEffort,
            },
            h(ResetIcon, {}),
          ),
        )

        let body
        if (false) {
          const groups = (catalog && catalog.groups) || []
          body = h(
            'div',
            null,
            h('div', { className: 'dshcps-panel-title' }, T("选择模型")),
            groups.length === 0
              ? h('div', { className: 'dshcps-empty' }, T("模型目录加载中…"))
              : groups.map((group, groupIndex) =>
                  h(
                    'div',
                    { className: 'dshcps-group', key: group.id },
                    h(
                      'div',
                      { className: 'dshcps-group-head' },
                      h('div', { className: 'dshcps-group-name' }, group.name || group.id),
                      groupIndex === 0 ? h('div', { className: 'dshcps-group-sub' }, T("推荐模型集")) : null,
                    ),
                    (group.models || []).map((item) =>
                      h(
                        'button',
                        {
                          type: 'button',
                          key: group.id + '/' + item.id,
                          className:
                            'dshcps-row' +
                            (current && current.provider === group.id && current.model === item.id ? ' is-active' : ''),
                          disabled: busy,
                          onClick: () => pickModel({ provider: group.id, model: item }),
                          onMouseEnter: (event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            setHovered({
                              right: rect.right,
                              left: rect.left,
                              top: rect.top,
                              height: rect.height,
                              text: modelBlurb(group.id, item),
                              name: item.name || item.id,
                            })
                          },
                          onMouseLeave: () => setHovered(null),
                        },
                        h('span', { className: 'dshcps-row-name' }, item.name || item.id),
                        current && current.provider === group.id && current.model === item.id
                          ? h(CheckIcon, {})
                          : null,
                      ),
                    ),
                  ),
                ),
          )
        } else if (view === 'models') {
          // Codex 行为：弹出模型列表时，下面这条滑杆整体消失（位置让给列表）
          body = null
        } else {
          body = h(
            'div',
            null,
            h(
              'div',
              {
                ref: trackRef,
                className:
                  'dshcps-track' + (dragIndex !== null ? ' is-dragging' : '') + (canUse ? '' : ' is-locked'),
                role: 'slider',
                tabIndex: canUse ? 0 : -1,
                'aria-label': T("推理强度"),
                'aria-valuemin': 1,
                'aria-valuemax': total || 1,
                'aria-valuenow': total ? index + 1 : 1,
                'aria-valuetext': text ? text.full : '',
                onPointerDown: onTrackDown,
                onKeyDown: onTrackKeyDown,
              },
              h(
                'div',
                { className: 'dshcps-fill', style: { width: total > 0 ? knobLeft : '0px' } },
                isUltra ? h(UltraLayer, { flowRef }) : null,
              ),
              h(
                'div',
                { className: 'dshcps-dots' },
                efforts.map((item, i) =>
                  h('span', {
                    key: item.id,
                    className: 'dshcps-dot' + (i <= index ? ' is-passed' : ''),
                    style: { left: posAt(total > 1 ? i / (total - 1) : 0) },
                  }),
                ),
              ),
              // 墨点环在拖柄**之前**渲染；只有正在播溅射时才挂载
              burstKey > 0 ? h(InkRing, { knobLeft, playKey: burstKey }) : null,
              total > 0 ? h('div', { className: 'dshcps-knob', style: { left: knobLeft } }) : null,
            ),
            total === 0
              ? h(
                  'div',
                  { className: 'dshcps-note' },
                  locked ? T("推理强度不可调整") : T("当前模型未公布推理强度：在 profile 的 reasoningEfforts 里配置后即可调节"),
                )
              : null,
          )
        }

        card = ReactDOM.createPortal(
          h(
            'div',
            {
              ref: popRef,
              className: 'dshcps-pop' + (view === 'models' ? ' is-models' : ''),
              role: 'dialog',
              'aria-label': T("推理强度"),
              style: pos ? { left: pos.left + 'px', top: pos.top + 'px' } : { left: '-9999px', top: '0px' },
            },
            head,
            body,
            error ? h('div', { className: 'dshcps-error' }, error) : null,
          ),
          document.body,
        )

        /* 模型列表：Codex 原生的**独立圆角浮层**（不撑高主卡片）。
           16px 圆角 + 阴影 + 顶部「选择模型」小灰标题 + 分组标题 + 34px 行 + 右侧打勾，
           面板限高 360px、长列表内部滚动。 */
        if (view === 'models') {
          const groups = (catalog && catalog.groups) || []
          const viewportH = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
          /* 卡片隐藏后，列表**落下来占卡片原来的位置**：
             以卡片的底边为基准向上生长（卡片用 visibility 隐藏，量得到高度）。
             之前是锚在卡片上方 8px，所以卡片一消失，列表就悬在半空。 */
          const cardH = measuredCardHRef.current === null ? 150 : measuredCardHRef.current
          const panelStyle = pos
            ? { left: pos.left + 'px', bottom: viewportH - (pos.top + cardH) + 'px' }
            : { left: '-9999px', top: '0px' }
          card = h(
            React.Fragment,
            null,
            card,
            ReactDOM.createPortal(
              h(
                'div',
                { ref: modelsRef, className: 'dshcps-models', role: 'dialog', 'aria-label': T("选择模型"), style: panelStyle },
                h(
                  'div',
                  { className: 'dshcps-modelsHead' },
                  h('span', null, T("选择模型")),
                ),
                h(
                  'div',
                  { className: 'dshcps-modelsBody', onMouseLeave: hideTipNow },
                  groups.length === 0
                    ? h('div', { className: 'dshcps-empty' }, T("模型目录加载中…"))
                    : groups.map((group, groupIndex) =>
                        h(
                          'div',
                          { key: group.id, className: 'dshcps-modelsGroup' },
                          h(
                            'div',
                            { className: 'dshcps-group-head' },
                            h('div', { className: 'dshcps-group-name' }, group.name || group.id),
                            groupIndex === 0 ? h('div', { className: 'dshcps-group-sub' }, T("推荐模型集")) : null,
                          ),
                          (group.models || []).map((item) =>
                            h(
                              'button',
                              {
                                type: 'button',
                                key: group.id + '/' + item.id,
                                className:
                                  'dshcps-row' +
                                  (current && current.provider === group.id && current.model === item.id ? ' is-active' : ''),
                                disabled: busy,
                                onClick: () => pickModel({ provider: group.id, model: item }),
                                onMouseEnter: (event) => {
                                  // 左右锚在面板（固定），上下跟随**当前这一行**的中心；
                                  // 没有说明就不弹（且清掉上一个，避免残留）—— 两者都不会造成横向位移
                                  const blurb = modelBlurb(group.id, item)
                                  if (!blurb) {
                                    hideTipNow()
                                    return
                                  }
                                  const rowRect = event && event.currentTarget ? event.currentTarget.getBoundingClientRect() : null
                                  showTipNow(Object.assign({ text: blurb, name: item.name || item.id }, tipPlacement(rowRect)))
                                },
                                // 注意：行间**不**隐藏气泡（跨行只换文字），
                                // 只有真正离开列表才算离开 —— 见 .dshcps-modelsBody 的 onMouseLeave。
                              },
                              h('span', { className: 'dshcps-row-name' }, item.name || item.id),
                              current && current.provider === group.id && current.model === item.id
                                ? h(CheckIcon, {})
                                : null,
                            ),
                          ),
                        ),
                      ),
                ),
              ),
              document.body,
            ),
          )
        }

        // 悬停气泡：**始终**渲染外层 Fragment 与 portal 容器（无内容时为空），
        // 否则 hovered 在「有说明/没说明」之间切换会改变元素树形状 → 面板重挂载 → 抖一下。
        if (true) {
          card = h(
            React.Fragment,
            null,
            card,
            ReactDOM.createPortal(
              h(
                'div',
                { className: 'dshcps-tip', style: hovered && hovered.text ? tipStyle : { display: 'none' } },
                hovered && hovered.text ? hovered.text : '',
              ),
              document.body,
            ),
          )
        }
      }

      return h('div', { className: 'dshcps-root' }, chip, card)
    }

    /* ======================================================================
     * 六、插件挂载
     * ==================================================================== */

    function apply(ctx) {
      T = ctx.locale.bind(NAMESPACE);
      ctx.effect(() => ctx.locale.register(NAMESPACE, 'en', en), 'codex-power-slider: en');
      // 不装出站钩子：绝不改写用户发出的消息。
      const Bound = (props) => h(PowerSlider, Object.assign({}, props, { __ctx: ctx }))
      Bound.displayName = 'CodexPowerSlider'

      try {
        ctx.slots.inject(SLOT, () => {
          const base = { name: SLOT, priority: SLOT_PRIORITY, locale: NAMESPACE }
          const children = {
            "conversation.input.model.label": { kind: "single", scope: "session" },
          }
          try {
            // 原生 ModelSelect 已在 profile patch 里停用，它那条同名声明随之释放；
            // 接过 model.label 后，官方的 1017（以及以后换版本的新包）自动渲染。
            return ctx.slots.register(Object.assign({}, base, { children }), Bound)
          } catch (cause) {
            if (typeof console !== 'undefined') console.warn(T("[dsh-codex-power-slider] 子槽声明被拒，退回无子槽模式："), cause)
            return ctx.slots.register(base, Bound)
          }
        })
      } catch (cause) {
        // 挂载点尚未声明时 inject 会等；真正的异常只记录，不影响其它插件。
        if (typeof console !== 'undefined') console.warn(T("[dsh-codex-power-slider] 挂载失败："), cause)
      }
    }

    const module = {
      name: PLUGIN_ID,
      inject: ['slots', 'sessions', 'remote', 'remote.session', 'conversation', 'locale'],
      apply,
    }
    void NAMESPACE
    return module
  },
})
