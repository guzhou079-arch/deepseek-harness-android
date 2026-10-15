#!/usr/bin/env node
/**
 * console-plugin-render-test.mjs —— 在 node 里把 dsh-android-console 的客户端半边**真跑一遍**。
 *
 * 为什么要有它：这一页只在 App 的 WebView 里渲染，装机前没法肉眼验。而"能不能渲染"
 * 恰恰是最容易出错的地方（拼错变量、拿不到组件、hooks 顺序错…）——这些都会在
 * 真机上表现为**整页空白或崩掉设置弹窗**。
 *
 * 做法：用一个最小 React 桩（useState/useEffect/useCallback/useRef/Component + jsx 运行时）
 * 把 client.js 加载起来，注册到假 slots，然后**逐页渲染**：
 *   主页 → 授予权限 → 插件 → 自建环境 → 日志，并模拟点击（含二次确认条）、
 *   以及"没有 dshshell 桥"时的降级文案。
 * 任何引用错误 / 拼写错误 / hooks 用错都会在这里抛出来。
 *
 * 用法：node scripts/console-plugin-render-test.mjs [client.js 路径]
 * 退出码 0 = 全部渲染通过。
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2]
  || path.join(process.env.DSH_PROJECT || '/sdcard/DeepSeekHarness/projects/dsh-android',
    'plugins/dsh-android-console/lib/client.js');

const code = fs.readFileSync(SRC, 'utf8');

// ------------------------------------------------------------------ 最小 React
let hooks = [];
let cursor = 0;
let pending = false;
let inRender = false;

const React = {
  useState(init) {
    // ⚠ 必须把当前实例的 hooks 数组**闭包捕获**：setter 会在渲染之外被调用，
    //   那时模块级 hooks 已经被还原成外层的了（第一版就栽在这，子页全点不动）。
    const arr = hooks;
    const i = cursor++;
    if (!(i in arr)) arr[i] = typeof init === 'function' ? init() : init;
    return [arr[i], (v) => { arr[i] = typeof v === 'function' ? v(arr[i]) : v; pending = true; }];
  },
  useEffect() { cursor++; },
  useCallback(fn) { cursor++; return fn; },
  useRef(v) { cursor++; return { current: v === undefined ? null : v }; },
  Component: class Component {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState(next) { Object.assign(this.state, typeof next === 'function' ? next(this.state) : next); pending = true; }
  },
};

const Fragment = Symbol('Fragment');
const jsx = (type, props, key) => ({ __el: true, type, props: props || {}, key });
const jsxs = jsx;
const jsxRuntime = { jsx, jsxs, Fragment };

// ------------------------------------------------- 最小 primitives（真组件在浏览器里）
function passthrough(name) {
  const Fn = (props) => jsx(name, props || {});
  Fn.displayName = name;
  return Fn;
}
const primitives = {
  Button: passthrough('Button'),
  Switch: passthrough('Switch'),
  SegmentedControl: passthrough('SegmentedControl'),
  Modal: passthrough('Modal'),          // 真件会 portal 到 body —— 这里的重点就是"用没用它"
  Toast: passthrough('Toast'),
  IconChevronLeftOutlineRegular: passthrough('IconChevronLeft'),
  IconChevronRightOutlineRegular: passthrough('IconChevronRight'),
  // 与真件逐字一致的实现（primitives/lib/index.js 的 fileSizeText）
  fileSizeText(bytes) {
    if (bytes < 1024) return bytes + 'B';
    const kb = bytes / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + 'KB';
    const mb = kb / 1024;
    if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : Math.round(mb)) + 'MB';
    const gb = mb / 1024;
    return (gb < 10 ? gb.toFixed(1) : Math.round(gb)) + 'GB';
  },
};

// --------------------------------------------------------------- 假 window/壳
const acts = [];
const sampleState = {
  version: '1.31 · 内核 0.2.0-rc.2',
  extract: { ready: true, busy: false, state: '已解压', meta: '运行环境与内核树已就绪' },
  engine: { running: true, booting: false, busy: false, state: '引擎运行中', meta: '端口 3080 · 已运行 3 分 · 通知 3081' },
  rescue: { safeMode: false, fails: 0, warn: false, desc: '引擎起不来时……' },
  theme: { mode: 0, label: '跟随系统' },
  perm: {
    summary: '已授权 3 / 8',
    rows: [
      { id: 'storage', title: '所有文件访问', desc: '读写 /sdcard', ok: true, disabled: false, state: '已授权' },
      { id: 'root', title: 'root（超级用户）', desc: '替代 Shizuku', ok: false, disabled: true, state: '本机无 root' },
      { id: 'a11y', title: '无障碍服务', desc: '读屏 / 点屏', ok: false, disabled: false, state: '未授权' },
    ],
  },
  workspace: { path: '', unset: true },
  plugins: {
    summary: '已启用 6 / 10',
    rows: [
      { id: 'tool-vscreen', title: 'dsh-tool-vscreen', desc: '虚拟屏', on: true },
      { id: 'pwsh-sandbox', title: 'dsh-pwsh-sandbox', desc: '无 pwsh', on: false },
    ],
  },
  buildEnv: {
    installed: false, summary: '未安装', statusText: '未安装 —— 装上之后……', installing: false,
    stage: '', resolving: false, err: '', sources: [{ index: 0, label: 'GitHub' }, { index: 1, label: 'Gitee' }],
  },
  log: { summary: 'dsh-web.log · 120 KB · 10-07 01:31', path: '/data/user/0/com.deepseek.harness/files/dsh-web.log' },
  life: {
    daemonRunning: true,
    todayExpense: 61.0,
    todayIncome: 0.0,
    monthExpense: 641.47,
    monthIncome: 1698.45,
    monthTxCount: 73,
    summary: '🟢 守护中 · 今日支出 ¥61.00 · 📦 待取快递 1 件',
    packages: [{ id: 1, pickup_code: '88-3-4012', station: '5栋大堂丰巢柜', carrier: '顺丰', created_at: Date.now() }],
    codes: [{ id: 1, code: '719305', source: '中国移动', created_at: Date.now() }],
    transactions: [{ id: 1, type: 'expense', amount: 28.5, merchant: '美团外卖', category: '餐饮', account: '微信支付', created_at: Date.now() }],
    tasks: [{ id: 'morning_brief', name: '晨间早报', cron_expr: 'daily:08:30', enabled: true, next_run_at: Date.now() + 3600000 }],
    balances: [
      { account: '农业银行(0770)', amount: 1069.97, merchant: '川链动万商科技', at: Date.now() },
      { account: '招商银行(1234)', amount: 8888.88, merchant: '瑞幸', at: Date.now() - 60000 },
    ],
    latestBalance: { account: '农业银行(0770)', amount: 1069.97, at: Date.now() },
  },
};

let bridgeOn = true;
const win = {
  __ModuleLoader__: { load: (reg) => { win.__reg = reg; } },
  dshshell: {
    ctlState: () => JSON.stringify(sampleState),
    ctlAct: (id, arg) => { acts.push([id, arg]); return '{"ok":true}'; },
  },
  addEventListener() {}, removeEventListener() {},
  get dshshell2() { return undefined; },
};
const doc = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, textContent: '', appendChild() {} }),
  head: { appendChild() {} },
};

globalThis.window = win;
globalThis.document = doc;

// ------------------------------------------------------------------ 加载插件
const requireStub = (spec) => {
  if (spec === 'react') return React;
  if (spec === 'react/jsx-runtime') return jsxRuntime;
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error('未预期的 require: ' + spec);
};

// eslint-disable-next-line no-new-func
new Function('window', 'document', 'require', code)(win, doc, requireStub);

if (!win.__reg) throw new Error('client.js 没有调用 window.__ModuleLoader__.load');
const mod = win.__reg.factory(requireStub);
if (typeof mod.apply !== 'function') throw new Error('插件没有导出 apply');

let Section = null;
let Overlay = null;
let ComposerDock = null;
const ctx = {
  inject: (_dependencies, fn) => fn(ctx),
  slots: {
    inject: (name, fn) => { fn(); },
    register: (options, component) => {
      if (options.name === 'settings.section') Section = component;
      if (options.name === 'shell.overlay') Overlay = component;
      if (options.name === 'conversation.composer.dock') ComposerDock = component;
      return () => {};
    },
  },
};
mod.apply(ctx);
if (Section === null) throw new Error('没有注册任何 settings.section');
if (Overlay === null) throw new Error('没有注册 shell.overlay（分享到货提示就看不到）');
if (ComposerDock === null) throw new Error('没有注册 conversation.composer.dock（分享卡片就没了）');

// ------------------------------------------------------------------ 渲染驱动
// 组件实例按**位置路径**记忆（这样 setState 之后重渲染能取回同一份 hooks）。
const instances = new Map();

function isClass(type) {
  return typeof type === 'function' && type.prototype && typeof type.prototype.render === 'function';
}

function expand(node, path) {
  if (node === null || node === undefined || node === false || node === true) return null;
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (Array.isArray(node)) return node.map((n, i) => expand(n, path + '.' + i));
  if (!node.__el) return node;
  const key = path + '>' + String((node.type && node.type.name) || node.type);
  if (typeof node.type === 'function') {
    const inst = instances.get(key) || { hooks: [] };
    instances.set(key, inst);
    const savedHooks = hooks;
    const savedCursor = cursor;
    hooks = inst.hooks;
    cursor = 0;
    let out;
    try {
      if (isClass(node.type)) {
        const c = new node.type(node.props);
        c.state = c.state || {};
        out = c.render();
      } else {
        out = node.type(node.props);
      }
    } finally {
      hooks = savedHooks;
      cursor = savedCursor;
    }
    return expand(out, key);
  }
  const props = Object.assign({}, node.props, { children: expand(node.props && node.props.children, key) });
  if (node.props && node.props.footer) props.footer = expand(node.props.footer, key + '.footer');
  return { __el: true, type: node.type, props: props, key: node.key };
}

/** 渲染到状态稳定（最多 N 轮，防死循环）。默认渲染设置页；传 Component 可渲染别的槽位组件。 */
function settle(props, Component) {
  const Root = Component || Section;
  let tree = null;
  for (let i = 0; i < 12; i++) {
    pending = false;
    const el = (() => { cursor = 0; inRender = true; try { return Root(props || { close() {} }); } finally { inRender = false; } })();
    tree = expand(el, 'root.' + (Component ? String(Component.name) : 'Section'));
    if (!pending) return tree;
  }
  throw new Error('渲染没有稳定下来（可能 setState 死循环）');
}

function walk(node, fn) {
  if (node === null || node === undefined || node === false) return;
  if (Array.isArray(node)) { for (const n of node) walk(n, fn); return; }
  if (typeof node !== 'object') return;
  if (node.__el) {
    fn(node);
    walk(node.props && node.props.children, fn);
    walk(node.props && node.props.footer, fn);
    walk(node.props && node.props.text, fn);
    walk(node.props && node.props.description, fn);
    // Toast 的动作是 [{prefix, label, onClick}]，真件把它们渲染成可点文字；
    // 这里包成元素递出去，好让 texts()/findByText()/点击断言都看得见。
    const actions = node.props && node.props.actions;
    if (Array.isArray(actions)) {
      for (const action of actions) fn({ __el: true, type: 'ToastAction', props: Object.assign({}, action, { children: action && action.label }) });
    }
  }
}

/** 收集树里所有可见文本（用于断言文案在页面上）。 */
function texts(tree) {
  const out = [];
  walk(tree, (el) => {
    const c = el.props && el.props.children;
    if (typeof c === 'string') out.push(c);
    const t = el.props && el.props.text;
    if (typeof t === 'string') out.push(t);
    const d = el.props && el.props.description;
    if (typeof d === 'string') out.push(d);
  });
  return out.join(' | ');
}

/** 全树里有几个某种 type 的元素（用来断言"用的是 Modal 弹层"）。 */
function countType(tree, type) {
  let n = 0;
  walk(tree, (el) => { if (el.type === type) n++; });
  return n;
}

function findByText(tree, text) {
  let hit = null;
  walk(tree, (el) => {
    if (hit) return;
    const c = el.props && el.props.children;
    if (typeof c === 'string' && c.indexOf(text) >= 0) hit = el;
  });
  return hit;
}

/** 点一个"标题行"（Row 的 onClick 挂在最外层 div 上）。 */
function clickByText(tree, text) {
  let target = null;
  walk(tree, (el) => {
    if (target) return;
    if (el.props && typeof el.props.onClick === 'function') {
      let has = false;
      // 文字可能就是这个元素自己的直接子串（比如 Button 的 children），也可能嵌在下面
      if (typeof el.props.children === 'string' && el.props.children.indexOf(text) >= 0) has = true;
      if (typeof el.props.footer !== 'undefined' && texts(el.props.footer).indexOf(text) >= 0) has = true;
      walk(el.props.children, (inner) => {
        if (typeof (inner.props && inner.props.children) === 'string'
          && inner.props.children.indexOf(text) >= 0) has = true;
      });
      if (has) target = el;
    }
  });
  if (!target) throw new Error('点不到：' + text);
  target.props.onClick({ stopPropagation() {} });
}

/** 回到干净的主页（每个子页用例互不干扰，别让上一个用例的 page 状态留下来）。 */
function freshMain() {
  instances.clear();
  return settle({ close() {} });
}

const checks = [];
function ok(name) { checks.push([true, name]); console.log('  ✅ ' + name); }
function bad(name, err) { checks.push([false, name]); console.log('  ❌ ' + name + ' → ' + (err && err.message ? err.message : err)); }

function step(name, fn) {
  try { fn(); ok(name); } catch (e) { bad(name, e); }
}

console.log('== 渲染测试：' + SRC + ' ==');

let main;
step('主页渲染（引擎运行中）', () => {
  main = settle({ close() {} });
  const t = texts(main);
  for (const want of ['DEEPSEEK HARNESS', '已解压', '引擎运行中', '安全模式', '导出全部数据',
    '授予权限', '插件', '自建环境', '日志', '时光机全站备份', '界面主题', '检查更新']) {
    if (t.indexOf(want) < 0) throw new Error('主页缺文案：' + want);
  }
});

step('模型分工入口可点击，子页显示角色和官方暂停状态', () => {
  const tree = freshMain();
  clickByText(tree, '模型分工');
  const text = texts(settle({ close() {} }));
  for (const want of ['当前使用', '按任务选择', '代码实现', '分析与审查', '架构与规划', '已暂停', '应用配置']) {
    if (!text.includes(want)) throw new Error('模型页缺文案：' + want);
  }
});

step('引擎运行中不再有「回到界面」（多此一举的那个按钮）', () => {
  const t = texts(main);
  if (t.indexOf('回到界面') >= 0) throw new Error('「回到界面」还在');
  if (t.indexOf('重启') < 0 || t.indexOf('停止') < 0) throw new Error('重启/停止按钮丢了');
});

step('界面主题用 SegmentedControl（不是三颗实心按钮）', () => {
  let seg = null;
  walk(main, (el) => { if (el.type === 'SegmentedControl') seg = el; });
  if (!seg) throw new Error('没有找到 SegmentedControl');
  if (seg.props.options.length !== 3) throw new Error('选项数不对');
  if (seg.props.value !== '0') throw new Error('当前值不对：' + seg.props.value);
  seg.props.onChange('2');
  if (acts[acts.length - 1][0] !== 'theme.set' || acts[acts.length - 1][1] !== '2') {
    throw new Error('onChange 没有发出 theme.set:2');
  }
});

step('子页：授予权限', () => {
  const home = freshMain();
  clickByText(home, '授予权限');
  const tree = settle({ close() {} });
  const t = texts(tree);
  for (const want of ['所有文件访问', 'root（超级用户）', '本机无 root', 'AI 工作区', '去授权']) {
    if (t.indexOf(want) < 0) throw new Error('权限页缺：' + want);
  }
  clickByText(tree, '去授权');
  if (acts[acts.length - 1][0] !== 'perm.action') throw new Error('去授权没有发 perm.action');
  clickByText(tree, '授予权限');   // 返回箭头
  settle({ close() {} });
});

step('子页：插件（开关 + 重启生效）', () => {
  let tree = freshMain();
  clickByText(tree, '插件');
  tree = settle({ close() {} });
  const t = texts(tree);
  for (const want of ['dsh-tool-vscreen', 'dsh-pwsh-sandbox', '重启引擎生效']) {
    if (t.indexOf(want) < 0) throw new Error('插件页缺：' + want);
  }
  let sw = null;
  walk(tree, (el) => { if (el.type === 'Switch' && el.props.checked === true) sw = el; });
  if (!sw) throw new Error('没找到处于打开状态的 Switch');
  sw.props.onChange(false);
  if (acts[acts.length - 1][0] !== 'plugin.toggle') throw new Error('开关没有发 plugin.toggle');
  clickByText(tree, '插件');   // 返回
  settle({ close() {} });
});

step('子页：自建环境（两个仓库对等：都不是实心主按钮）', () => {
  let tree = freshMain();
  clickByText(tree, '自建环境');
  tree = settle({ close() {} });
  const t = texts(tree);
  if (t.indexOf('GitHub') < 0 || t.indexOf('Gitee') < 0) throw new Error('自建环境页缺来源按钮');
  const variants = [];
  walk(tree, (el) => { if (el.type === 'Button' && typeof el.props.children === 'string') variants.push(el.props.variant); });
  if (variants.indexOf('primary') >= 0) throw new Error('自建环境页还有 primary 实心按钮');
  clickByText(tree, '从 GitHub 下载安装');
  const withConfirm = settle({ close() {} });
  if (texts(withConfirm).indexOf('确定') < 0) throw new Error('没有出现二次确认');
  if (countType(withConfirm, 'Modal') !== 1) throw new Error('确认不是 Modal 弹层 —— 又写回页面末尾的内联条了（用户报过这个）');
  clickByText(withConfirm, '取消');
  settle({ close() {} });
  clickByText(tree, '自建环境');   // 返回
  settle({ close() {} });
});

step('子页：日志', () => {
  let tree = freshMain();
  clickByText(tree, '日志');
  tree = settle({ close() {} });
  const t = texts(tree);
  for (const want of ['查看日志', '分享', '清空日志']) {
    if (t.indexOf(want) < 0) throw new Error('日志页缺：' + want);
  }
  clickByText(tree, '清空日志');
  const c = settle({ close() {} });
  if (texts(c).indexOf('确定') < 0) throw new Error('清空日志没有二次确认');
  clickByText(c, '日志');   // 返回
  settle({ close() {} });
});

step('子页：智能生活助理', () => {
  let tree = freshMain();
  clickByText(tree, '智能生活助理');
  tree = settle({ close() {} });
  const t = texts(tree);
  for (const want of ['智能生活助理', '待取快递包裹', '88-3-4012', '今日记账与消费流水', '美团外卖', '最近验证码', '719305']) {
    if (t.indexOf(want) < 0) throw new Error('生活助理页缺文案：' + want);
  }
  if (!t.includes('定时自动化任务') && !t.includes('定时任务')) throw new Error('生活助理页缺定时任务');
  // 记账卡要显示余额（从动账通知正文里读出来的账户余额）
  for (const want of ['账户余额：', '农业银行(0770) ¥1069.97', '招商银行(1234) ¥8888.88']) {
    if (t.indexOf(want) < 0) throw new Error('记账卡缺余额：' + want);
  }
  // 记账卡还要显示「月结余」（结余 = 本月收入 − 本月支出，跟着 /life/api/status 的 month* 字段走）
  // 注意：文本节点会被 trim，标签后面那个空格不保证留下，所以别在断言里带尾空格。
  for (const want of ['本月结余', '¥1056.98', '支出 ¥641.47', '收入 ¥1698.45', '73 笔']) {
    if (t.indexOf(want) < 0) throw new Error('记账卡缺月结余：' + want);
  }
  clickByText(tree, '立即执行');
  if (acts[acts.length - 1][0] !== 'life.task.run' || acts[acts.length - 1][1] !== 'morning_brief') {
    throw new Error('点「立即执行」没有发出 life.task.run:morning_brief，实际 ' + JSON.stringify(acts[acts.length - 1]));
  }
  // 删除键：先二次确认，再发 life.task.delete（带 source/id）
  clickByText(tree, '删除');
  const conf = settle({ close() {} });
  if (texts(conf).indexOf('确定') < 0) throw new Error('删除定时任务没有二次确认');
  clickByText(conf, '确定');
  const delAct = acts[acts.length - 1];
  if (delAct[0] !== 'life.task.delete') throw new Error('删除没有发出 life.task.delete，实际 ' + delAct[0]);
  let delArg = null;
  try { delArg = JSON.parse(delAct[1]); } catch (e) { throw new Error('删除参数不是 JSON: ' + delAct[1]); }
  if (delArg.id !== 'morning_brief' || delArg.source !== 'life') throw new Error('删除参数不对: ' + delAct[1]);
  clickByText(tree, '已取');
  if (acts[acts.length - 1][0] !== 'life.pkg.pick' || acts[acts.length - 1][1] !== '1') {
    throw new Error('点击已取没有发出 life.pkg.pick:1');
  }
  clickByText(tree, '复制');
  if (acts[acts.length - 1][0] !== 'life.code.copy' || acts[acts.length - 1][1] !== '719305') {
    throw new Error('点击复制没有发出 life.code.copy:719305');
  }
  clickByText(tree, '智能生活助理'); // 返回
  settle({ close() {} });
});

step('子页：语音交互与 TTS 调音台', () => {
  let tree = freshMain();
  clickByText(tree, '语音交互');
  tree = settle({ close() {} });
  const t = texts(tree);
  for (const want of ['语音交互与 TTS 调音台', '语音热词唤醒', '自定义唤醒词', 'TTS 播报引擎', '精选音色预设库', '播报语速', '试听文案与声音测试']) {
    if (t.indexOf(want) < 0) throw new Error('语音调音台页缺文案：' + want);
  }
  clickByText(tree, '提示音');
  if (acts[acts.length - 1][0] !== 'voice.test.tone') {
    throw new Error('点击提示音没有发出 voice.test.tone');
  }
  clickByText(tree, '实时开麦');
  if (acts[acts.length - 1][0] !== 'voice.test.listen') {
    throw new Error('点击实时开麦没有发出 voice.test.listen');
  }
  clickByText(tree, '语音交互与 TTS 调音台'); // 返回
  settle({ close() {} });
});

step('子页：本地知识库与全域检索 (RAG)', () => {
  let tree = freshMain();
  clickByText(tree, '本地知识库与全域检索');
  tree = settle({ close() {} });
  const t = texts(tree);
  for (const want of ['本地知识库与全域检索', '本地全域秒级检索', '随手剪藏', '保存并索引']) {
    if (t.indexOf(want) < 0) throw new Error('本地知识库页缺文案：' + want);
  }
  clickByText(tree, '本地知识库与全域检索'); // 返回
  settle({ close() {} });
});

step('子页：局域网协同与隔空投送 (LAN Mesh)', () => {
  let tree = freshMain();
  clickByText(tree, '局域网协同与隔空投送');
  tree = settle({ close() {} });
  const t = texts(tree);
  for (const want of ['局域网协同与隔空投送', '局域网访问地址', '跨设备双向剪贴板', '隔空投送文件箱']) {
    if (t.indexOf(want) < 0) throw new Error('局域网协同页缺文案：' + want);
  }
  clickByText(tree, '局域网协同与隔空投送'); // 返回
  settle({ close() {} });
});

step('确认弹层必须 portal（Modal），不能是页面末尾的内联条 —— 用户报过的"点重启没反应"', () => {
  const tree = freshMain();
  clickByText(tree, '重启');
  const withConfirm = settle({ close() {} });
  if (countType(withConfirm, 'Modal') !== 1) throw new Error('没有用 Modal');
  // 页面主体里不许再出现内联确认条那套 class
  let inline = 0;
  walk(withConfirm, (el) => {
    const c = el.props && el.props.className;
    if (typeof c === 'string' && c.indexOf('ctl-confirm') >= 0) inline++;
  });
  if (inline !== 0) throw new Error('还在用页面内联确认条');
  clickByText(withConfirm, '取消');
});

step('动作反馈用 Toast（同样 portal，不随滚动跑掉）', () => {
  const tree = freshMain();
  clickByText(tree, '重启');
  let modal = settle({ close() {} });
  clickByText(modal, '确定');
  const after = settle({ close() {} });
  if (countType(after, 'Toast') < 1) throw new Error('确认之后没有 Toast 反馈');
  const t = texts(after);
  if (t.indexOf('正在重启引擎') < 0) throw new Error('Toast 文案不对：' + t.slice(0, 120));
  if (acts[acts.length - 1][0] !== 'engine.restart') throw new Error('没有发出 engine.restart');
});

step('二次确认：重启要确认，点「确定」真的发动作', () => {
  const tree = freshMain();
  clickByText(tree, '重启');
  const withConfirm = settle({ close() {} });
  if (texts(withConfirm).indexOf('确定') < 0) throw new Error('重启没有弹确认');
  const before = acts.length;
  clickByText(withConfirm, '确定');
  settle({ close() {} });
  if (acts.length !== before + 1 || acts[acts.length - 1][0] !== 'engine.restart') {
    throw new Error('确认后没有发出 engine.restart');
  }
});

step('没有 dshshell 桥时降级为说明文案（不白屏）', () => {
  const saved = win.dshshell;
  win.dshshell = undefined;
  instances.clear();          // 状态是 useState 惰性读的：不清实例就还是旧状态
  try {
    const tree = settle({ close() {} });
    const t = texts(tree);
    if (t.indexOf('控制台只在安卓应用内可用') < 0) throw new Error('没有降级文案');
  } finally {
    win.dshshell = saved;
    instances.clear();
  }
});

step('引擎未启动时的主页（启动引擎 / 解压文件 为主按钮）', () => {
  const saved = JSON.stringify(sampleState);
  sampleState.engine = { running: false, booting: false, busy: false, state: '未启动', meta: '点「启动引擎」开始 · 端口 3080' };
  sampleState.extract = { ready: false, busy: false, state: '未解压', meta: '需要解压运行环境与内核' };
  instances.clear();          // 同上：换状态要换实例
  try {
    const tree = settle({ close() {} });
    const t = texts(tree);
    if (t.indexOf('启动引擎') < 0 || t.indexOf('解压文件') < 0) throw new Error('缺启动/解压按钮');
    clickByText(tree, '启动引擎');
    if (acts[acts.length - 1][0] !== 'engine.start') throw new Error('没有发 engine.start');
  } finally {
    const back = JSON.parse(saved);
    sampleState.engine = back.engine;
    sampleState.extract = back.extract;
    instances.clear();
  }
});

// ------------------------------------------------ 分享到货横幅（shell.overlay）
// 背景：分享卡片只挂在聊天输入框里；用户停在设置页/控制台时**看不到任何东西**，
// 两次真实分享就这样烂在 cache 里（2026-10-15）。这里验：帧级浮层真的注册了、
// 有桥有分享时能渲染出横幅、文案里带文件名/大小/落盘目录，且「忽略」会回执删除。
step('分享到货横幅：有分享时挂到帧级浮层并说清落点', () => {
  const shareState = {
    ok: true, count: 2,
    batch: { id: 'old-batch', files: [{ index: 0, name: '旧文件.pdf', bytes: 100 }] },
    latest: {
      id: 'new-batch', createdAt: Date.now(), text: '',
      files: [{ index: 0, name: '评星的项目方案.pptx', bytes: 441946 }],
      errors: [], archive: '/sdcard/DeepSeekHarness/shares/2026-10-15',
    },
  };
  const acked = [];
  win.__DSH_INPUT_TOKEN = 'test-token';
  win.dshinput = {
    shareState: () => JSON.stringify(shareState),
    shareAck: (token, id) => { acked.push([token, id]); return '{"ok":true}'; },
  };
  try {
    // 纯文案函数（与组件走同一份代码）
    const text = mod.shareNoticeText(shareState);
    if (text.indexOf('评星的项目方案.pptx') < 0) throw new Error('文案没带文件名：' + text);
    if (text.indexOf('432KB') < 0) throw new Error('文案没带大小：' + text);   // 441946B → ≥10KB 取整为 432KB（与真件 fileSizeText 一致）
    if (text.indexOf('/sdcard/DeepSeekHarness/shares/2026-10-15') < 0) throw new Error('文案没带落盘目录：' + text);
    if (text.indexOf('另有 1 条待处理') < 0) throw new Error('文案没报还有几条：' + text);
    // 真渲染一次：横幅必须出现，且「忽略」回执删的是**这一条**
    instances.clear();
    const tree = settle({}, Overlay);
    if (countType(tree, 'Toast') !== 1) throw new Error('没有渲染出 Toast 横幅');
    const rendered = texts(tree);
    if (rendered.indexOf('评星的项目方案.pptx') < 0) throw new Error('横幅文案缺文件名');
    const ignore = findByText(tree, '忽略');
    if (!ignore || typeof ignore.props.onClick !== 'function') throw new Error('横幅上没有「忽略」动作');
    ignore.props.onClick({ stopPropagation() {} });
    if (acked.length !== 1 || acked[0][1] !== 'new-batch') throw new Error('「忽略」没有删除最新那条：' + JSON.stringify(acked));
    // 没有桥（桌面浏览器）时必须安静降级，不许抛
    win.__DSH_INPUT_TOKEN = undefined; delete win.dshinput;
    instances.clear();
    if (settle({}, Overlay) !== null) throw new Error('没有桥时应该什么都不渲染');
  } finally {
    delete win.__DSH_INPUT_TOKEN; delete win.dshinput;
    instances.clear();
  }
});

const failed = checks.filter(([good]) => !good).length;
console.log('---');
console.log(failed === 0
  ? '✅ 渲染测试全部通过（' + checks.length + ' 项）'
  : '⛔ 渲染测试失败 ' + failed + ' / ' + checks.length);
process.exit(failed === 0 ? 0 : 1);
