#!/usr/bin/env node
// browser.js —— 虚拟屏里开网页、读文字、点、输入（零依赖，底层包 apx vd）
// 不碰主屏；没有画面也能跑；先看文字，再点坐标。
//
// 实测注意：
// - Via 里点网页链接默认开新标签，当前页不动；要读目标页直接 open <url>，别点链接。
// - 境外站点（如 news.ycombinator.com）可能 ERR_CONNECTION_TIMED_OUT，优先国内可达站点。
// - WebView 输入框不支持 setText；ASCII 走 input 兜底，中文输入暂不支持（改用搜索 URL）。
//
// 用法:
//   node browser.js up                       起虚拟屏（幂等）
//   node browser.js open <url>               在虚拟屏里打开网址（VIEW intent，失败回退地址栏）
//   node browser.js dump                     控件树原文（带坐标）
//   node browser.js read [--max 80]          只读可见文字，去掉坐标噪音
//   node browser.js click --text "登录"       按文字点（最准）
//   node browser.js click 540 1200           按坐标点
//   node browser.js type "关键词" [--enter]   输入
//   node browser.js wait --text "结果"        等某段文字出现
//   node browser.js see                      截虚拟屏，返回 PNG 路径
//   node browser.js status                   屏 / 前台 App / 画面状态
//   node browser.js close                    关虚拟屏
'use strict';

const { spawnSync } = require('child_process');
const APX = process.env.APX_BIN || (process.env.HOME || '/data/user/0/com.deepseek.harness/files') + '/bin/apx';
const BROWSER = process.env.BROWSER_PKG || 'mark.via';

function apx(args, opts) {
  const r = spawnSync(APX, args, { encoding: 'utf8', timeout: (opts && opts.timeout) || 60000 });
  if (r.error) throw r.error;
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status !== 0 && !(opts && opts.allowFail)) throw new Error(out || `apx ${args.join(' ')} 失败`);
  return out;
}

function displayId() {
  const s = apx(['vd', 'status'], { allowFail: true });
  const m = s.match(/屏幕\s*(\d+)/) || s.match(/display(?:Id)?[^\d]*(\d+)/i) || s.match(/screen[^\d]*(\d+)/i);
  return m ? m[1] : null;
}

function up() {
  return apx(['vd', 'up']);
}

function openUrl(url) {
  up();
  const d = displayId();
  const safe = String(url).replace(/'/g, "'\\''");
  const failed = (r) => {
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    if (r.status !== 0) return out;
    if (/^(Error|Exception)/im.test(out) || /No Activity found|does not exist|unable to start/i.test(out)) return out;
    return ''; // 「Activity not started, its current task has been brought to the front」是正常送达
  };
  if (d) {
    // 优先指定 Via（干净、轻、不共享主屏浏览状态）；VIEW intent 直接落到虚拟屏
    const via = BROWSER === 'mark.via' ? ' -n mark.via/mark.via.Shell' : '';
    const r = spawnSync(APX, ['raw', `am start --display ${d} -a android.intent.action.VIEW -d '${safe}'${via}`], { encoding: 'utf8', timeout: 60000 });
    const err = failed(r);
    if (!err) return `已在 display ${d} 打开（Via）：${url}`;
    // 再试一次不指定组件
    const r2 = spawnSync(APX, ['raw', `am start --display ${d} -a android.intent.action.VIEW -d '${safe}'`], { encoding: 'utf8', timeout: 60000 });
    const err2 = failed(r2);
    if (!err2) return `已在 display ${d} 打开（默认浏览器）：${url}`;
  }
  // 回退：开浏览器，地址栏输入
  apx(['vd', 'open', BROWSER]);
  apx(['vd', 'type', url, '--enter']);
  return `已在 ${BROWSER} 地址栏输入：${url}`;
}

// 把 dump 的坐标噪音去掉，只留人看得懂的文字
function cleanDump(raw, max) {
  const lines = [];
  for (let line of String(raw).split('\n')) {
    line = line.replace(/\s*\[[\d,.\s-]+\]/g, ' ')
      .replace(/\s*\([\d,.\s-]+\)/g, ' ')
      .replace(/\b\d{1,4}\s*[,，]\s*\d{1,4}\b/g, ' ')
      .replace(/\s*@\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!line) continue;
    if (/^[\d\s,，.xX×]+$/.test(line)) continue;
    if (lines[lines.length - 1] === line) continue;
    lines.push(line);
  }
  const n = Math.max(1, Number(max || 80));
  return lines.slice(0, n).join('\n');
}

function main(argv) {
  const cmd = argv[0];
  const rest = argv.slice(1);
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : '';
  };
  const has = (name) => rest.includes(name);
  const textFlag = () => flag('--text') || flag('-t');

  switch (cmd) {
    case 'up':
      return console.log(up());
    case 'open': {
      const url = rest[0];
      if (!url) throw new Error('用法: browser.js open <url>');
      return console.log(openUrl(url));
    }
    case 'dump':
      return console.log(apx(['vd', 'dump']));
    case 'read': {
      const max = flag('--max') || 80;
      return console.log(cleanDump(apx(['vd', 'dump']), max));
    }
    case 'click': {
      const t = textFlag();
      if (t) return console.log(apx(['vd', 'tap', '--text', t]));
      if (rest.length >= 2) return console.log(apx(['vd', 'tap', rest[0], rest[1]]));
      throw new Error('用法: browser.js click --text "文字" 或 click <x> <y>');
    }
    case 'type': {
      const content = rest.filter((x) => !x.startsWith('--')).join(' ');
      if (!content) throw new Error('用法: browser.js type "内容" [--enter]');
      const args = ['vd', 'type', content];
      if (has('--enter')) args.push('--enter');
      try {
        return console.log(apx(args));
      } catch (e) {
        // WebView 输入框常不支持 setText、粘贴兜底也会失败；ASCII 用 input 兜底
        const d = displayId();
        if (!d || /[^\x00-\x7F]/.test(content)) throw e;
        const safe = content.replace(/'/g, "'\\''");
        const r = spawnSync(APX, ['raw', `input -d ${d} text '${safe}'`], { encoding: 'utf8', timeout: 30000 });
        if (r.status !== 0) throw e;
        if (has('--enter')) spawnSync(APX, ['raw', `input -d ${d} keyevent 66`], { encoding: 'utf8', timeout: 30000 });
        return console.log(`✓ 输入 ${JSON.stringify(content)} (input 兜底)`);
      }
    }
    case 'wait': {
      const t = textFlag();
      if (!t) throw new Error('用法: browser.js wait --text "文字"');
      return console.log(apx(['vd', 'wait', '--text', t], { timeout: 120000 }));
    }
    case 'see':
      return console.log(apx(['vd', 'see']));
    case 'status':
      return console.log(apx(['vd', 'status']));
    case 'close':
      return console.log(apx(['vd', 'close']));
    default:
      console.log(`browser.js —— 虚拟屏浏览器操作（零依赖）
  node browser.js up | open <url> | dump | read [--max 80]
  node browser.js click --text "文字" | click <x> <y>
  node browser.js type "内容" [--enter] | wait --text "文字"
  node browser.js see | status | close`);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error('✗ ' + (e && e.message ? e.message : e));
  process.exit(1);
}
