/** Android console data routes. Native actions remain in the WebView bridge. */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROUTES = [
  ['/life', '/sdcard/DeepSeekHarness/tools/life.js', 'createHandler'],
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
