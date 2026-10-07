/**
 * dsh-android-console —— node 半边：什么都不做。
 *
 * 控制台的动作全部是**安卓壳**的事（解压 / 起引擎 / 授权 / 安装自建环境…），
 * 由客户端半边经 window.dshshell（WebView 的 JavascriptInterface）回调原生执行。
 * 引擎这边既不需要路由、也不需要服务，所以这里刻意保持零依赖、零副作用：
 * 一个 import 都不写，就不会有 "failed to import" 把引擎拖住。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const LIFE_TOOL_PATH = '/sdcard/DeepSeekHarness/tools/life.js';
const OFFICE_TOOL_PATH = '/sdcard/DeepSeekHarness/tools/office.js';
const VOICE_TOOL_PATH = '/sdcard/DeepSeekHarness/tools/voice.js';
const LAN_MESH_TOOL_PATH = '/sdcard/DeepSeekHarness/tools/lan-mesh.js';
const RAG_TOOL_PATH = '/sdcard/DeepSeekHarness/tools/rag.mjs';

export const name = 'android-console';
export const inject = ['webServer'];

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/life',
      handler: (req, res) => {
        let handler;
        try {
          try { delete require.cache[require.resolve(LIFE_TOOL_PATH)]; } catch (_) {}
          handler = require(LIFE_TOOL_PATH).createHandler('/life');
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
          return;
        }
        return handler(req, res);
      },
    }), 'android-console: /life 路由');

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/office',
      handler: (req, res) => {
        let handler;
        try {
          try { delete require.cache[require.resolve(OFFICE_TOOL_PATH)]; } catch (_) {}
          handler = require(OFFICE_TOOL_PATH).createOfficeHandler('/office');
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
          return;
        }
        return handler(req, res);
      },
    }), 'android-console: /office 路由');

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/voice-hub',
      handler: (req, res) => {
        let handler;
        try {
          try { delete require.cache[require.resolve(VOICE_TOOL_PATH)]; } catch (_) {}
          handler = require(VOICE_TOOL_PATH).createVoiceHubHandler('/voice-hub');
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
          return;
        }
        return handler(req, res);
      },
    }), 'android-console: /voice-hub 路由');

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/lan-mesh',
      handler: (req, res) => {
        let handler;
        try {
          try { delete require.cache[require.resolve(LAN_MESH_TOOL_PATH)]; } catch (_) {}
          handler = require(LAN_MESH_TOOL_PATH).createLanMeshHandler('/lan-mesh');
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
          return;
        }
        return handler(req, res);
      },
    }), 'android-console: /lan-mesh 路由');

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/rag',
      handler: async (req, res) => {
        try {
          const { createRagHandler } = await import(RAG_TOOL_PATH + '?t=' + Date.now());
          const handler = createRagHandler('/rag');
          return handler(req, res);
        } catch (e) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) }));
        }
      },
    }), 'android-console: /rag 路由');
  });
}
