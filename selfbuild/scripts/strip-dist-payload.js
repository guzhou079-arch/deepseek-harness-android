#!/usr/bin/env node
/**
 * strip-dist-payload.js —— 从**发行** payload 里剔除不该分发的东西
 * ============================================================================
 * 为什么必须有这一步：`selfbuild.sh payload` 是从**骨架 APK** 里解出 payload 的。
 * 如果骨架是你自己那台的快照，payload 里就带着个人内容 —— 2026-09-30 实测：
 *
 *   · dsh-bg-user.png（个人壁纸，1.4MB）           ← 隐私扫描抓到的
 *   · dshhome/profiles/web/package.json 里的
 *     link:/sdcard/Download/<私人目录>/...       ← 指向开发者私人路径
 *
 * 出包脚本只把壁纸从 **overlay** 挪走，管不到**从骨架解出来的那份**。
 * 所以这里直接对 payload.zip 动手：删条目 —— 而不是"指望上游没带进来"。
 *
 * 用法：
 *   node strip-dist-payload.js <payload.zip> [--base <底包 payload.zip>]
 *   node strip-dist-payload.js <payload.zip> --check-only [--base <...>] # 只报告，不改
 *   node strip-dist-payload.js <payload.zip> --base <...> --keep-user-bg  # 自用包留壁纸
 * 退出码：0 = 干净（或已修好）；1 = --check-only 且发现不该有的
 */
const fs = require('fs');
const path = require('path');
const { readZip, writeZip } = require(path.join(__dirname, '..', 'lib', 'ziptool.js'));
// 随包工具白名单的唯一真相源（strip / assert-dist-privacy / scan-dist-privacy 三处共用）。
const loadDistToolsAllow = require('./dist-tools-allow.js');
// 「该删什么」的唯一真相源 —— 与独立复核（assert-dist-privacy.js）共用同一份。
// 抽出来的理由不是省几行，是**两边必须判同一件事**：复核那边要能独立地红，
// 但红的依据不许可变。规则正文与逐条理由都搬去了那个文件，这里只消费。
const { badRules, keepList } = require('./dist-strip-rules.js');

const zip = process.argv[2];
const checkOnly = process.argv.includes('--check-only');
// DSH_KEEP_USER_BG=1 的自用包：机主壁纸要随包走，否则 CSS 引用了它必然 404
// （dsh-bg.css 的 url 与这张图是一体的，只留一个等于留下一个坏引用）。
const keepUserBg = process.argv.includes('--keep-user-bg');
if (!zip) { console.error('用法：node strip-dist-payload.js <payload.zip> [--check-only] [--keep-user-bg]'); process.exit(1); }

// 发行包里绝不该出现的东西 —— 规则本体不在这份文件里：它与独立复核（assert-dist-privacy.js）
// 共用 scripts/dist-strip-rules.js。两份手抄的结局是「删的是一套、验的是另一套」，
// 更糟的是复核那份被清空之后闸还报绿 ——「没有规则」和「规则全过」输出上长一个样。
const BAD = badRules({ keepUserBg });
// 2026-11-11：pi-ai 的工具调用「按 id 归并」（identity-over-index）是本机补丁，不进发行包。
// 为什么曾经要拦：@earendil-works/pi-ai 是依赖树里的第三方包，不是我们维护的内核；
// 发行版必须与上游 npm 版字节一致 —— 否则上游哪天真修了同一处，我们这份**整文件覆盖**
// 会把官方修法盖回去，而且没人能从版本号看出发生过这件事。
//
// 2026-11-15：这条规则原来是「整文件删掉」。删掉之后 lazy 入口仍 `import("./openai-completions.js")`，
// 任何 OpenAI 兼容自定义端点都会在调用时炸在模块解析上 —— 一个不存在的模块比一份旧补丁更糟。
// 改为：不删，由 build-overlay 放**上游原版**覆盖底包里那份补丁版，make-dist-apk.sh 在 strip 之后
// 用 md5 断言锁死「必须是上游字节」。这样既守住「发行版与上游一致」，又不会留下坏引用。
// 所以规则表里**没有**它这一条：不是漏了，是不许删。

// 例外白名单：这两份是**我们自己的**应用内更新日志，必须随包分发，
// 用户界面里能直接打开 /CHANGELOG.md（见 MainActivity 的 FORCE_OVERWRITE_PREFIXES）。
// 它们都住在 node_modules 下 → 会被上面那条第三方 changelog 规则命中，所以先放行。
// 名单本体同样在 dist-strip-rules.js：复核那边必须知道这两条放行，否则会把我们自己
// 要发的更新日志判成「strip 没删干净」—— 那不是判得严，那是判错了。
const KEEP = new Set(keepList());
// 精确放行（先查放行，再看 BAD）：`dshhome/tools/` 是技能文档点名的运行时依赖
// —— SKILL.md 正文写着 `node $DSH_HOME/tools/crew.js`，工具不在包里，技能就指向空路径
// （新装用户必然踩，老用户靠盘上副本侥幸不踩）。所以它属功能不属个人数据，必须随包。
//
// 为什么是文件级而不是把 `tools` 加进上面那条 dshhome 白名单：目录级放行等于赌「这个目录
// 以后再出现的都是同类东西」。今天是「目录级白名单把该留的删了」，明天就是「把不该留的放进来」。
// 逐文件列名后，往里新丢一个文件默认仍是「删」——要发就得在这里显式加一行，谁加谁负责。
//
// 名单本身不在这份文件里：它与 assert-dist-privacy.js、scan-dist-privacy.py 三处共用，
// 手抄三份必然漂（踩过：打包删掉技能要调的工具，三道闸各自跟自己的名单比对，三道全绿）。
// 真相源是 scripts/dist-tools-allow.json，判据与理由都写在那个文件里。
const ALLOW = new Set(loadDistToolsAllow());
const matchBad = (name) => (ALLOW.has(name) || KEEP.has(name) ? null : BAD.find(([re]) => re.test(name)) || null);

const es = readZip(zip);
const hits = es.filter((e) => matchBad(e.name));

if (!hits.length) { console.log('  ✓ payload 干净（没有个人内容条目）'); process.exit(0); }

if (checkOnly) {
  console.log(`  ❌ payload 里有 ${hits.length} 个不该分发的条目：`);
  for (const e of hits) console.log('     - ' + e.name);
  process.exit(1);
}

const keep = es.filter((e) => !matchBad(e.name));
const tmp = zip + '.strip-tmp';
writeZip(keep, tmp);
fs.renameSync(tmp, zip);

console.log(`  ✓ 已从发行 payload 剔除 ${hits.length} 个条目（${es.length} → ${keep.length}）：`);
for (const e of hits) {
  const why = (matchBad(e.name) || [])[1] || '';
  console.log(`     - ${e.name}   [${why}]`);
}
