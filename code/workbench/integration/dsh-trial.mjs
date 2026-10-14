/** Native preset plug-in for the one synthetic text trial. No transport, queue or model client. */
export const name = 'aaaagent-b54-text-trial';
export const inject = ['tools'];
export const DSH_TRIAL_PRESET = 'aaaagent-b54-text-v1';
export const DSH_TRIAL_INPUT = '这是一条合成连通性检查。请只回复 AAA_B54_DSH_OK。';
export const DSH_TRIAL_SYSTEM = 'You are a text connectivity check. Return only the exact requested marker.';
export const DSH_TRIAL_MAX_TOKENS = 1024;

/** Mounted inside one native preset scope. Calling at the Host root fails before installing hooks. */
const validBinding = config => config && Object.keys(config).sort().join(',') === 'requestId,sessionId' &&
  [config.sessionId, config.requestId].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value));
export function apply(ctx, config) {
  if (!validBinding(config)) throw Error('An exact reviewed native session/request binding is required.');
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => 'This synthetic text trial has no tool approval.');
  const attempted = new WeakSet();
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const messages = decision.messages;
    if (payload.agent.id !== config.sessionId || payload.step !== 1 || messages.length !== 1 || messages[0]?.source?.kind !== 'user' ||
        messages[0].source.rpcId !== config.requestId || messages[0].content?.length !== 1 ||
        messages[0].content[0].type !== 'text' || messages[0].content[0].text !== DSH_TRIAL_INPUT) return { kind: 'reject' };
    return decision;
  }, { prepend: true });
  ctx.on('agent/request', async ({ agent }, next) => {
    if (agent.id !== config.sessionId) throw Error('The native trial belongs to another session.');
    if (attempted.has(agent) || agent.session.snapshotEvents().some(event =>
        ['request/header', 'assistant/message', 'assistant/attempt'].includes(event.type))) {
      throw Error('The original synthetic request may already have run; no retry is allowed.');
    }
    if (ctx.tools.schemas(agent).length !== 0) throw Error('Synthetic trial tool scope changed.');
    const selected = await next();
    if (selected.provider !== 'deepseek-official' || selected.model !== 'deepseek-flash' || selected.reasoningEffort !== 'high') {
      throw Error('Synthetic trial requires the reviewed native model route.');
    }
    attempted.add(agent);
    return { ...selected, maxTokens: DSH_TRIAL_MAX_TOKENS };
  }, { prepend: true });
  // Prepend in the native waterfall: no fall-through into the Host-wide retry executor.
  ctx.on('agent/request-error', async () => undefined, { prepend: true });
}

/** Returned text is a candidate only. Caller owns separate review and exact-path installation. */
export function dshTrialPresetFiles(moduleUrl, binding) {
  if (!validBinding(binding)) throw Error('Exact native session/request binding required');
  const url = new URL(moduleUrl);
  if (url.protocol !== 'file:' || url.search || url.hash) throw Error('Exact local trial plug-in required');
  return {
    'preset.yml': 'name: AAAAGENT B54 synthetic text\ndescription: One reviewed synthetic text request with no tools.\n',
    'agent.cordis.yml': '- id: persona\n  name: \'@deepseek-ai/dsh-persona\'\n  config:\n' +
      `    prefix: ${JSON.stringify(DSH_TRIAL_SYSTEM)}\n    complete: true\n    includeRuntimeContext: false\n` +
      `- id: aaaagent-b54-text-trial\n  name: ${JSON.stringify(url.href)}\n  config:\n` +
      `    sessionId: ${JSON.stringify(binding.sessionId)}\n    requestId: ${JSON.stringify(binding.requestId)}\n`,
  };
}
