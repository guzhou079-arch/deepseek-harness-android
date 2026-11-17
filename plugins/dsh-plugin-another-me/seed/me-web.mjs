#!/usr/bin/env node
// 另一个我 · 服务核心
//
// 两种跑法：
//   ① 独立：node me-web.mjs          → http://127.0.0.1:4780
//   ② 挂在 DSH 引擎上：dsh-plugin-another-me 的 index.js 取 createHandler('/another-me')
//      —— 引擎一直在跑，进程不会被系统回收（dsh-memory-ui 踩出来的结论）。
//
// 页面用相对路径 fetch（api/xxx），所以前缀挂载和独立跑都能用。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.DSH_HOME || path.join(process.env.HOME || '.', 'payload', 'dshhome');
const ME = path.join(HOME, 'another-me');
const PORT = Number(process.env.ME_PORT || 4780);
const HOST = '127.0.0.1';

function runMe(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ME, 'me.mjs'), ...args], { cwd: ME });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => resolve({ code: -1, out, err: e.message }));
    p.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

const readIf = (f, fb = '') => { try { return fs.readFileSync(f, 'utf8'); } catch { return fb; } };

// 开关：文件在 = 开着。引擎那边每次组装提示词都读它，所以改完下一轮就生效
function isOn() {
  const v = readIf(path.join(ME, 'enabled'), '').trim().toLowerCase();
  return v === '1' || v === 'on' || v === 'true';
}

const send = (res, code, type, buf) => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(buf);
};
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
});

// pi-ai 内置 provider 的默认地址（引擎配置里没写 baseURL 的通道从这里补）
const PI_BASE = {
  'opencode-go': 'https://opencode.ai/inference/go/v1',
  'kimi-coding': 'https://api.kimi.com/coding/v1',
};

// 读引擎的 llm-pi-ai 配置，解析成 provider 列表（含协议、地址、模型）
export function parseEngineProviders() {
  const txt = readIf(path.join(HOME, 'profiles/web/cordis.patch.yml'), '');
  if (!txt) return [];
  const lines = txt.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*-\s*id:\s*llm-pi-ai\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return [];
  const out = [];
  let inProv = false, cur = null;
  for (let i = start; i < lines.length; i++) {
    const ln = lines[i];
    if (i > start && /^-\s/.test(ln)) break;
    if (/^\s*providers:\s*$/.test(ln)) { inProv = true; continue; }
    if (!inProv) continue;
    let mm;
    if ((mm = ln.match(/^\s{6}([A-Za-z0-9_-]+):\s*$/))) {
      cur = { name: mm[1], api: '', baseURL: '', keyName: '', models: [] };
      out.push(cur); continue;
    }
    if (!cur) continue;
    if ((mm = ln.match(/^\s{8}api:\s*(\S+)/))) { cur.api = mm[1]; continue; }
    if ((mm = ln.match(/^\s{8}baseURL:\s*(\S+)/))) { cur.baseURL = mm[1]; continue; }
    if ((mm = ln.match(/^\s{8}apiKeyEnv:\s*(\S+)/))) { cur.keyName = mm[1]; continue; }
    if ((mm = ln.match(/^\s{10}-\s*id:\s*(\S+)/))) { cur.models.push({ id: mm[1], name: mm[1] }); continue; }
    if ((mm = ln.match(/^\s{12}name:\s*(.+)$/)) && cur.models.length) {
      cur.models[cur.models.length - 1].name = mm[1].trim(); continue;
    }
  }
  return out;
}

/** 返回一个 (req,res) handler。prefix 为空表示挂在根上（独立模式）。 */
export function createHandler(prefix = '') {
  return async (req, res) => {
    try {
      let url = req.url || '/';
      if (prefix) {
        if (url === prefix) {  // /another-me → /another-me/，保证相对路径能解析
          res.writeHead(302, { location: prefix + '/' });
          return res.end();
        }
        if (!url.startsWith(prefix + '/')) return json(res, 404, { error: 'not found' });
        url = url.slice(prefix.length);
      }
      const u = new URL(url, 'http://x');
      const p = u.pathname;

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        try { return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(ME, 'ui.html'))); }
        catch { return json(res, 500, { error: 'ui.html 不见了' }); }
      }

      if (req.method === 'GET' && p === '/api/models') {
        const c = JSON.parse(fs.readFileSync(path.join(ME, 'config.json'), 'utf8'));
        const list = (c.models || []).map(m => ({
          id: m.id, label: m.label, vendor: m.vendor, note: m.note,
          baseURL: m.baseURL, model: m.model, keyName: m.keyName, keyRef: m.keyRef,
        }));
        return json(res, 200, { default: c.default, models: list });
      }

      // 添加 / 更新一个模型
      if (req.method === 'POST' && p === '/api/models') {
        const b = await readBody(req);
        if (!b.baseURL || !b.model) return json(res, 400, { error: 'baseURL 和 model 都要填' });
        const CF = path.join(ME, 'config.json');
        const c = JSON.parse(fs.readFileSync(CF, 'utf8'));
        c.models = Array.isArray(c.models) ? c.models : [];
        const id = String(b.id || b.model);
        const item = {
          id, label: b.label || b.model, vendor: b.vendor || '', note: b.note || '',
          baseURL: String(b.baseURL), model: String(b.model),
        };
        if (b.apiKey && String(b.apiKey).trim()) {
          const sf = path.join(ME, 'secrets.json');
          const sec = JSON.parse(readIf(sf, '{}'));
          sec[id] = String(b.apiKey).trim();
          fs.writeFileSync(sf, JSON.stringify(sec, null, 2), { mode: 0o600 });
          item.keyRef = id;
        } else if (b.keyName && String(b.keyName).trim()) {
          item.keyName = String(b.keyName).trim();
        }
        const i = c.models.findIndex(m => m.id === id);
        if (i >= 0) c.models[i] = { ...c.models[i], ...item };
        else c.models.push(item);
        if (!c.default || !c.models.some(m => m.id === c.default)) c.default = id;
        fs.writeFileSync(CF, JSON.stringify(c, null, 2));
        return json(res, 200, { ok: true, id });
      }

      if (req.method === 'DELETE' && p === '/api/models') {
        const id = u.searchParams.get('id');
        const CF = path.join(ME, 'config.json');
        const c = JSON.parse(fs.readFileSync(CF, 'utf8'));
        c.models = (c.models || []).filter(m => m.id !== id);
        if (c.default === id) c.default = c.models[0] ? c.models[0].id : '';
        fs.writeFileSync(CF, JSON.stringify(c, null, 2));
        return json(res, 200, { ok: true });
      }

      // 从一个通道把可用模型列出来
      if (req.method === 'POST' && p === '/api/models/fetch') {
        const b = await readBody(req);
        let key = (b.apiKey || '').trim();
        if (!key && b.keyName) {
          const s = readIf(path.join(HOME, '.credentials.yaml'));
          const mm = s.match(new RegExp('^\\s+' + String(b.keyName).trim() + ':\\s*(\\S+)', 'm'));
          key = mm ? mm[1].replace(/^["']|["']$/g, '') : '';
        }
        if (!b.baseURL) return json(res, 400, { error: 'baseURL 没填' });
        const base = String(b.baseURL).replace(/\/chat\/completions\/?$/, '').replace(/\/+$/, '');
        try {
          const r = await fetch(base + '/models', { headers: key ? { authorization: 'Bearer ' + key } : {} });
          const t = await r.text();
          if (!r.ok) return json(res, 200, { error: 'HTTP ' + r.status + ' ' + t.slice(0, 160), models: [] });
          const ids = (JSON.parse(t).data || []).map(m => m.id);
          return json(res, 200, { models: ids });
        } catch (e) { return json(res, 200, { error: e.message, models: [] }); }
      }

      // 把引擎设置页里的模型（llm-pi-ai 的 providers）导进来
      if (req.method === 'POST' && p === '/api/models/import') {
        const provs = parseEngineProviders();
        const CF = path.join(ME, 'config.json');
        const c = JSON.parse(fs.readFileSync(CF, 'utf8'));
        c.models = Array.isArray(c.models) ? c.models : [];
        const added = [], skipped = [];
        for (const pr of provs) {
          const base = (pr.baseURL || PI_BASE[pr.name] || '').replace(/\/+$/, '');
          if (!base) { skipped.push(pr.name + '：引擎里没写地址'); continue; }
          if (!pr.keyName) { skipped.push(pr.name + '：没配 key'); continue; }
          if (!pr.models.length) { skipped.push(pr.name + '：没配模型'); continue; }
          const anth = pr.api === 'anthropic-messages';
          const hasV = /\/v\d+$/.test(base);
          const url = anth
            ? (hasV ? base : base + '/v1')
            : (hasV ? base + '/chat/completions' : base + '/v1/chat/completions');
          for (const m of pr.models) {
            const id = pr.name + '/' + m.id;
            if (c.models.some(x => x.id === id)) continue;
            c.models.push({
              id, label: m.name, vendor: pr.name, note: pr.api || '',
              baseURL: url, model: m.id, keyName: pr.keyName,
              ...(anth ? { api: 'anthropic-messages' } : {}),
            });
            added.push(id);
          }
        }
        fs.writeFileSync(CF, JSON.stringify(c, null, 2));
        return json(res, 200, { ok: true, added, skipped, providers: provs.length });
      }

      if (req.method === 'GET' && p === '/api/history') {
        const r = await runMe(['history', '--limit', String(u.searchParams.get('limit') || 60)]);
        if (r.code !== 0) return json(res, 200, { items: [], error: r.err });
        try { return json(res, 200, { items: JSON.parse(r.out) }); }
        catch { return json(res, 200, { items: [], error: 'history 解析失败' }); }
      }

      if (req.method === 'GET' && p === '/api/status') {
        const c = JSON.parse(fs.readFileSync(path.join(ME, 'config.json'), 'utf8'));
        const cnt = (d) => { try { return fs.readdirSync(d).filter(f => f.endsWith('.md')).length; } catch { return 0; } };
        const st = (d) => { try { return fs.readdirSync(d).filter(f => f.endsWith('.jsonl'))
          .reduce((n, f) => n + fs.readFileSync(path.join(d, f), 'utf8').split('\n').filter(Boolean).length, 0); } catch { return 0; } };
        const talks = (() => { try { return fs.readdirSync(path.join(ME, 'logs')).filter(f => f.endsWith('.jsonl'))
          .reduce((n, f) => n + fs.readFileSync(path.join(ME, 'logs', f), 'utf8').split('\n').filter(l => l.includes('"kind":"talk"')).length, 0); } catch { return 0; } })();
        return json(res, 200, { model: c.model, cases: cnt(path.join(ME, 'cases')), stream: st(path.join(ME, 'stream')), talks, on: isOn() });
      }

      // 开关：开启后主界面的对话对象变成「另一个我」
      if (req.method === 'GET' && p === '/api/toggle') {
        return json(res, 200, { on: isOn() });
      }
      if (req.method === 'POST' && p === '/api/toggle') {
        const b = await readBody(req);
        const on = b.on === undefined ? !isOn() : !!b.on;
        fs.writeFileSync(path.join(ME, 'enabled'), on ? '1' : '0');
        return json(res, 200, { on });
      }

      // 认知：identity / stance 的读写（面板里直接编辑）
      if (req.method === 'GET' && p === '/api/profile') {
        return json(res, 200, {
          identity: readIf(path.join(ME, 'identity.md'), ''),
          stance: readIf(path.join(ME, 'stance.md'), ''),
        });
      }
      if (req.method === 'POST' && p === '/api/profile') {
        const b = await readBody(req);
        if (typeof b.identity === 'string') fs.writeFileSync(path.join(ME, 'identity.md'), b.identity);
        if (typeof b.stance === 'string') fs.writeFileSync(path.join(ME, 'stance.md'), b.stance);
        return json(res, 200, { ok: true });
      }

      // 过去：做过的决定（cases）——面板里能记能翻
      if (req.method === 'GET' && p === '/api/cases') {
        const dir = path.join(ME, 'cases');
        let files = [];
        try {
          files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse().slice(0, 80);
        } catch { /* 还没记过 */ }
        const items = files.map(f => {
          const txt = readIf(path.join(dir, f), '');
          const g = (k) => { const m = txt.match(new RegExp('^' + k + ':\\s*(.*)$', 'm')); return m ? m[1] : ''; };
          return { file: f, title: g('title'), decision: g('decision'), why: g('why'), result: g('result') };
        });
        return json(res, 200, { items });
      }
      if (req.method === 'POST' && p === '/api/cases') {
        const b = await readBody(req);
        const title = String(b.title || '').trim();
        if (!title) return json(res, 400, { error: '标题不能空' });
        const dir = path.join(ME, 'cases');
        fs.mkdirSync(dir, { recursive: true });
        const day = new Date().toISOString().slice(0, 10);
        const slug = title.replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40) || 'case';
        const f = path.join(dir, day + '-' + slug + '.md');
        fs.writeFileSync(f, ['title: ' + title,
          'decision: ' + String(b.decision || ''),
          'why: ' + String(b.why || ''),
          'result: ' + String(b.result || ''),
          '', '---', '', String(b.note || '')].join('\n'));
        return json(res, 200, { ok: true, file: path.basename(f) });
      }

      if (req.method === 'POST' && p === '/api/ask') {
        const b = await readBody(req);
        const q = String(b.q || '').trim();
        if (!q) return json(res, 400, { error: '问题是空的' });
        const args = ['ask', q];
        if (b.dissent) args.push('--dissent');
        if (b.model) args.push('--model', String(b.model));
        const r = await runMe(args);
        if (r.code !== 0 || !r.out) return json(res, 200, { error: r.err || '它没说话' });
        return json(res, 200, { answer: r.out });
      }

      if (req.method === 'POST' && p === '/api/feed') {
        const b = await readBody(req);
        const t = String(b.text || '').trim();
        if (!t) return json(res, 400, { error: '空的' });
        const r = await runMe(['feed', t]);
        return json(res, 200, { ok: r.code === 0, out: r.out || r.err });
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      // 任何意外都吞掉，只回 500 —— 绝不能把引擎的请求链路带崩
      try { json(res, 500, { error: String(e && e.message || e) }); } catch { /* 已断开 */ }
    }
  };
}

export function startServer() {
  const server = http.createServer(createHandler(''));
  server.listen(PORT, HOST, () => console.log('另一个我 → http://' + HOST + ':' + PORT));
  return server;
}

// 直接跑才起服务；被插件 require 时只导出
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startServer();
}
