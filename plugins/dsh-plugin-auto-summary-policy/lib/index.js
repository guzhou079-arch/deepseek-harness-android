import { Context, symbols } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';

export const name = 'auto-summary-policy';
export const inject = ['agents', 'agentPresets', 'llm', 'tokenMeter'];

export const DEFAULT_POLICY = Object.freeze({
  thresholdRatio: 0.125,
  retainTokens: 16000,
  headroomTokens: 16384,
  maxTokens: 16384,
  compactionRetries: 0,
  maxOverflowRetries: 1,
  auto: true,
});

/** Validate with the actual backend, without installing another listener. */
export function validatePolicy(input = DEFAULT_POLICY) {
  const detached = new Context();
  const backend = new BasicCompactionEngine(detached, { ...input, auto: false });
  return Object.freeze({ ...backend.config, auto: true });
}

/** Mirror native exact-target policy merging for read-only diagnostics. */
export function effectivePolicy(config, target) {
  const override = (config.modelPolicies ?? []).find(item => item.provider === target?.provider && item.model === target?.model);
  const retention = override?.retainTokens !== undefined
    ? { retainTokens: override.retainTokens }
    : override?.retainRatio !== undefined
      ? { retainRatio: override.retainRatio }
      : config.retainTokens !== undefined
        ? { retainTokens: config.retainTokens }
        : { retainRatio: config.retainRatio };
  return {
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens,
    ...retention,
    maxTokens: override?.maxTokens ?? config.maxTokens,
    compactionRetries: override?.compactionRetries ?? config.compactionRetries,
    maxOverflowRetries: override?.maxOverflowRetries ?? config.maxOverflowRetries,
    auto: config.auto,
  };
}

/** Install and reversibly update existing native services, including retained preset revisions. */
export function installPolicy(ctx, input = DEFAULT_POLICY) {
  const policy = validatePolicy(input);
  const touched = new Map();
  let disposed = false;
  const findEngine = agent => {
    let service = ctx.agentPresets.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction');
    while (service?.[symbols.original] && service[symbols.original] !== service) service = service[symbols.original];
    return service;
  };
  function applyToAgent(agent) {
    if (disposed) return false;
    const engine = findEngine(agent);
    if (!(engine instanceof BasicCompactionEngine)) return false;
    // auto installs listeners at construction time; do not claim to enable an intentionally manual backend.
    if (!engine.config.auto) return false;
    if (touched.has(engine)) return true;
    const original = engine.config;
    engine.config = policy;
    touched.set(engine, { original, applied: policy });
    return true;
  }
  for (const agent of ctx.agents.list()) applyToAgent(agent);
  ctx.on('agent/created', ({ agent }) => { applyToAgent(agent); });
  ctx.effect(() => () => {
    disposed = true;
    for (const [engine, record] of touched) {
      // Avoid undoing another component's newer policy.
      if (engine.config === record.applied) engine.config = record.original;
    }
    touched.clear();
  });
  return {
    policy,
    applyToAgent,
    findEngine,
    snapshot(agents = ctx.agents.list()) {
      return {
        implementation: '0.1.2-effective-policy',
        enabled: !disposed,
        appliedNativeInstances: touched.size,
        policy,
        agents: agents.map(agent => {
          const engine = findEngine(agent);
          const active = touched.has(engine) && engine.config === policy;
          const routed = agent.session.requestHeader()?.config;
          return {
            preset: ctx.agentPresets.composedPreset(agent.ctx) ?? null,
            applied: active,
            actualPolicy: engine instanceof BasicCompactionEngine ? effectivePolicy(engine.config, routed) : null,
            ...(routed ? { provider: routed.provider, model: routed.model } : {}),
            historyNodes: agent.session.surface.nodes.length,
          };
        }),
      };
    },
  };
}

/** Read-only status route; use the engine's own signed-cookie and Host/Origin admission. */
export function apply(ctx, config = DEFAULT_POLICY) {
  const installed = installPolicy(ctx, config);
  ctx.logger.info('auto-summary-policy: applied earlier threshold to %d native preset instances', installed.snapshot().appliedNativeInstances);
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: '/auto-summary',
      handler: async (req, res) => {
        const connection = webCtx.get('connection');
        let verdict;
        try { verdict = connection?.admit(req); } catch {}
        if (verdict?.rejection !== undefined || verdict?.peer === undefined) {
          const status = verdict?.rejection === 401 || verdict?.rejection === 403 ? verdict.rejection : 503;
          res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        const path = new URL(req.url, 'http://127.0.0.1').pathname;
        if (req.method !== 'GET' || path !== '/auto-summary/status') {
          res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        const agents = ctx.agents.list();
        const snapshot = installed.snapshot(agents);
        const status = { ...snapshot, agents: [] };
        for (let i = 0; i < snapshot.agents.length; i++) {
          const row = snapshot.agents[i];
          const agent = agents[i];
          if (!agent) continue;
          try {
            const model = row.provider && row.model ? await ctx.llm.resolveModelInfo(row.provider, row.model, AbortSignal.timeout(3000)) : null;
            const window = model?.context?.contextWindow;
            const output = agent.session.requestHeader()?.config.maxTokens ?? model?.defaultMaxTokens ?? 0;
            const currentTokens = ctx.tokenMeter.measure(agent.session).totalTokens;
            status.agents.push({ ...row, currentTokens, ...(window && row.actualPolicy ? {
              contextWindow: window,
              triggerTokens: Math.floor(Math.min(window * row.actualPolicy.thresholdRatio, window - output - row.actualPolicy.headroomTokens)),
            } : {}) });
          } catch { status.agents.push({ ...row, measurementUnavailable: true }); }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(status));
      },
    }), 'auto-summary-policy: authenticated status');
  });
}
