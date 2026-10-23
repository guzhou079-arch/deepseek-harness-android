/** Android console data routes. Native actions remain in the WebView bridge. */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const packagedLife = process.env.DSH_HOME && join(process.env.DSH_HOME, 'skills/dsh-life/scripts/life.js');
/** 生活守护脚本：优先用包内那份，退回 /sdcard 的运行副本。 */
const lifeScriptPath = packagedLife && existsSync(packagedLife) ? packagedLife : '/sdcard/DeepSeekHarness/tools/life.js';

/**
 * App 启动即拉起生活中枢守护（幂等，只在引擎启动时打一次）。
 *
 * 为什么挂这里：生活守护只在 selfcheck §7 / tick 被叫时才保活，App 冷启动后没人叫它，
 * 于是打开 App 看到的是「生活中枢未运行」，得手动点启动。插件 apply() 是引擎启动时必然
 * 跑一次的点。`tick` 自身幂等（守护活着就只做心跳检查），也不排付费闹钟（watchdog 默认关）。
 */
let lifeAutostartDone = false;
export function autoStartLife(logger) {
  if (lifeAutostartDone) return { ok: false, skipped: 'already' };
  lifeAutostartDone = true;
  if (!existsSync(lifeScriptPath)) return { ok: false, skipped: 'no-life-script' };
  try {
    const child = spawn(process.execPath, [lifeScriptPath, 'tick'], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    logger?.warn?.(`android-console: life autostart failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, failed: true };
  }
}

const ROUTES = [
  ['/life', packagedLife && existsSync(packagedLife) ? packagedLife : '/sdcard/DeepSeekHarness/tools/life.js', 'createHandler'],
  ['/office', '/sdcard/DeepSeekHarness/tools/office.js', 'createOfficeHandler'],
  ['/voice-hub', '/sdcard/DeepSeekHarness/tools/voice.js', 'createVoiceHubHandler'],
  ['/lan-mesh', '/sdcard/DeepSeekHarness/tools/lan-mesh.js', 'createLanMeshHandler'],
  ['/rag', '/sdcard/DeepSeekHarness/tools/rag.mjs', 'createRagHandler'],
];
export const name = 'android-console';
export const inject = ['webServer'];

/** Run the engine Host/Origin fence and signed-cookie check before loading tools. */
export function admitConsoleRequest(ctx, req, res) {
  let status = 503;
  try {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
    if (connection && typeof connection.admit === 'function') {
      const verdict = connection.admit(req);
      if (verdict && verdict.rejection === undefined && verdict.peer !== undefined) return true;
      if (verdict && (verdict.rejection === 401 || verdict.rejection === 403)) status = verdict.rejection;
    }
  } catch (error) {
    ctx.logger?.warn('android-console: request admission failed');
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'authentication service unavailable');
  return false;
}

export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    autoStartLife(ctx.logger);
    for (const [prefix, toolPath, factoryName] of ROUTES) {
      let handlerPromise;
      const getHandler = () => {
        if (!handlerPromise) {
          handlerPromise = Promise.resolve().then(async () => {
            // A stable ESM URL avoids retaining one module instance per request.
            const tool = toolPath.endsWith('.mjs') ? await import(toolPath) : require(toolPath);
            return tool[factoryName](prefix);
          }).catch(error => {
            handlerPromise = undefined; // Optional tools may be installed later.
            throw error;
          });
        }
        return handlerPromise;
      };
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'prefix',
        path: prefix,
        handler: async (req, res) => {
          if (!admitConsoleRequest(webCtx, req, res)) return;
          try {
            const handler = await getHandler();
            await handler(req, res);
          } catch (error) {
            if (res.headersSent) {
              res.destroy(error);
              return;
            }
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
          }
        },
      }), `android-console: ${prefix} route`);
    }
  });
}
