'use strict';
/**
 * dist-strip-rules.js —— 「发行 payload 里绝不该出现什么」的唯一真相源
 * ============================================================================
 * 为什么抽成单独一份：这份判据原来只住在 strip-dist-payload.js 里，而**独立复核**
 * （assert-dist-privacy.js）要验的是同一件事。两边各抄一份的结局已经见过了 ——
 * 名录漂了没人知道，更糟的那一半是：复核那边被清成空表，闸还天天报绿，因为
 * 「没有规则」和「规则全过」在输出上一模一样。所以现在只有这一份：
 *
 *   strip-dist-payload.js  require 它 → 决定**删**什么
 *   assert-dist-privacy.js require 它 → 决定在最终产物上**咬**什么
 *
 * strip 只负责删，它自己说「干净」不算数；复核那边必须能独立地红。两边共用规则，
 * 但仍然各跑各的判据 —— 共用的是「该删什么」，不是「删没删成功」的结论。
 *
 * 动这里的任何一条正则都要想清楚两件事：
 *   ① strip 的删除范围会跟着变（少一条 = 那类东西开始随包走）；
 *   ② 复核会跟着一起变（这才是它该有的样子；两边不一致才是病）。
 * 所以新增规则时，tools/test/dist-privacy.selftest.js 的**规则覆盖自查**会要求
 * 你同时给一条「能命中的假条目名」，否则自测报红 —— 没有用例的规则等于没上线的规则。
 */
const path = require('node:path');

// 自测口子（口径同 dist-tools-allow.js 的 DSH_DIST_TOOLS_ALLOW）：要验「规则表被清空时
// 闸会不会自己叫」，只能造一份空表；绝不能在真文件上改来改去 —— 测试进程一崩，
// 真规则就停在被改坏的状态，下一次打包静默放行。这里只影响 require 本模块的一方，
// 不改变 strip 的删除行为（strip 永远用真规则）。
const OVERRIDE = process.env.DSH_DIST_STRIP_RULES
  ? path.resolve(process.env.DSH_DIST_STRIP_RULES)
  : null;

// 自用包（DSH_DIST=0 / DSH_KEEP_USER_BG=1）的机主壁纸要随包走：CSS 引用了它，只留一个
// 等于留下一个坏引用。所以这一条跟着开关走，与 strip 的 --keep-user-bg、
// scan-dist-privacy.py 的 DSH_KEEP_USER_BG 是同一个口径。
const BAD_WALLPAPER = [/dsh-web-frontend\/dist\/dsh-bg-user\.(png|jpe?g|webp)$/i, '个人壁纸'];

// 发行包连内置那张矢量壁纸也不要：dsh-bg.css 在发行版里把 --dsh-user-bg-image 置 none，
// 留着这张 svg 就是一个没人引用、却能在包里被一眼看见的星空图。自用包当然要留着。
const BAD_WALLPAPER_SVG = [/dsh-web-frontend\/dist\/dsh-bg\.svg$/i, '内置矢量壁纸'];

// 发行包里绝不该出现的东西：<正则, 为什么算问题>
const BAD = [
  [/whale-shota\/(assets|preview)\//i, '桌宠源图/预览'],
  [/archive-2\.5d\/layers\//i, '派生美术'],
  [/MainActivity\.java\.(bak|pre-lan)/i, '源码备份'],
  [/\.(keystore|p12|pfx)$/i, '签名钥匙'],
  // 开发备份不属于运行内容；overlay 里出现 .bak-* / *.bak / *.orig 时也不能带进发行包。
  [/(?:\.bak(?:[.-]|$)|\.orig$)/i, '开发备份'],
  [/(^|\/)AGENTS\.md$/i, '全局指令'],
  [/(^|\/)\.credentials/i, '登录凭据'],
  [/sessions\/session-|session\.v4\.jsonl/i, '会话数据'],
  // 会审配置（监控站地址 / 默认通道）属个人数据，
  // 它住在 dshhome 根下 —— 别指望"它不在 overlay 里"这种运气。
  [/(^|\/)review\.json(\..*)?$/i, '本机会审配置'],
  [/(^|\/)skills-local\//i, '本机私有技能'],
  // 2026-10-15：dshhome 下**只允许**「可分发的种子」——与 scan-dist-privacy.py 的白名单
  // （skills / cordis.patch.yml / profiles）保持一致。骨架解出来的那份 settings.yaml 是
  // 开发机自己的状态（ui-conversation / ui-onboarding），发给新用户会让对方**跳过首次引导**，
  // 而且它属于「用户文件」（App 只在缺失时写入），本来就不该随包。
  [/(^|\/)dshhome\/settings\.yaml$/i, '个人设置（非可分发种子）'],
  // 白名单要约束底包，不只是 overlay：model-roles.json 等后增个人配置同样不能随包。
  // tool-gate.json 是**发行默认值**（{"enabled": false}），不是个人配置：缺这个文件时
  // dsh-tool-gate 按 enabled:true 走，用户装上去开局只看见 bash + tool_load。
  [/^dshhome\/(?!(?:skills|cordis\.patch\.yml|profiles|tool-gate\.json)(?:\/|$))[^/]+(?:\/|$)/i, '非可分发 dshhome 种子'],
  // 2026-10-15：第三方 changelog 是纯死重量（30 份 ≈ 830KB），
  // 更是隐私扫描**假阳性**的来源：上游 changelog 里 40 位 commit SHA 会命中
  // 11 位手机号正则，dependabot 的 @users.noreply.github.com 会命中邮箱正则。
  // 要留下的只有我们自己的那两份应用内更新日志（见下面 KEEP）。
  [/(^|\/)node_modules\/.*CHANGELOG\.md$/i, '第三方 changelog'],
  // 2026-11-04（v1.47）：占卜技能改名 dsh-zhanbu。骨架解出来的那份旧 dsh-yijing 带 27 个文件，
  // 不能随包走：全新安装会解出一整套废弃技能，老用户升级就只能靠装机侧迁移兜底。
  // 只留一份墓碑 SKILL.md —— 它覆盖旧文件，装机侧再把整个目录移进 skills-retired/；
  // 万一迁移没跑成，这份也写着"别加载本技能"。
  [/^dshhome\/skills\/dsh-yijing\/(?!SKILL\.md$).+/i, '旧技能 dsh-yijing 残留'],
];

// 例外白名单：这两份 CHANGELOG 是**我们自己的**应用内更新日志，必须随包分发，
// 而且用户界面里能直接打开 /CHANGELOG.md（见 MainActivity 的 FORCE_OVERWRITE_PREFIXES）。
// 它们都住在 node_modules 下 → 会被上面那条第三方 changelog 规则命中，所以先放行。
//
// 为什么 KEEP 也要跟 BAD 一起抽出来：复核那边如果不知道 KEEP，就会把我们自己要发的
// 两份更新日志判成「strip 没删干净」—— 那不是判得严，那是判错了，而误报的结局通常是
// 有人去放宽整条规则。
const KEEP = [
  'dshroot/CHANGELOG.md',
  'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/CHANGELOG.md',
];

// 交付给两边用的形态。keepUserBg 的口径与 strip 的 --keep-user-bg、
// scan-dist-privacy.py 的 DSH_KEEP_USER_BG 一致：自用包留壁纸，发行包不许有。
function badRules({ keepUserBg = false } = {}) {
  if (OVERRIDE) {
    const m = require(OVERRIDE);
    if (typeof m.badRules === 'function') return m.badRules({ keepUserBg });
    return Array.isArray(m.BAD) ? m.BAD.slice() : [];
  }
  return keepUserBg ? BAD.slice() : [BAD_WALLPAPER, BAD_WALLPAPER_SVG, ...BAD];
}

function keepList() {
  if (OVERRIDE) {
    const m = require(OVERRIDE);
    if (Array.isArray(m.KEEP)) return m.KEEP.slice();
  }
  return KEEP.slice();
}

module.exports = { badRules, keepList, BAD, BAD_WALLPAPER, BAD_WALLPAPER_SVG, KEEP };
module.exports.OVERRIDE = OVERRIDE;
