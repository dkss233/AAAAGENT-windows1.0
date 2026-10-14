/** Separate native preset for one reviewed fictional knowledge turn. Never installs itself. */
import { createHash } from 'node:crypto';
export const name = 'aaaagent-b54-rich-memory';
export const inject = ['tools'];
export const RICH_PRESET = 'aaaagent-b54-rich-memory-v1';
export const RICH_SYSTEM = 'You are recording requirements for an explicitly fictional project. Use only the supplied text. Do not execute tools, infer completed verification, or change the stated scope. Reply briefly in Chinese.';
export const RICH_OUTPUT_CAP = 1024;
const hash = text => createHash('sha256').update(text).digest('hex');
function binding(config) {
  if (!config || Object.keys(config).sort().join(',') !== 'input,inputSha256,requestId,sessionId' ||
      ![config.sessionId, config.requestId].every(v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v)) ||
      typeof config.input !== 'string' || !config.input.includes('完全虚构') || config.input.length > 4000 ||
      config.inputSha256 !== hash(config.input)) throw Error('Exact fictional input and native session/request binding required');
  return config;
}
export function apply(ctx, raw) {
  const config = binding(raw);
  ctx.tools.restrict({ allow: [] });
  ctx.tools.guard(() => 'No tools are authorized in this fictional knowledge turn.');
  const attempted = new WeakSet();
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    const messages = decision.messages;
    if (payload.agent.id !== config.sessionId || payload.step !== 1 || messages.length !== 1 ||
        messages[0]?.source?.kind !== 'user' || messages[0].source.rpcId !== config.requestId ||
        messages[0].content?.length !== 1 || messages[0].content[0].type !== 'text' ||
        messages[0].content[0].text !== config.input) return { kind: 'reject' };
    return decision;
  }, { prepend: true });
  ctx.on('agent/request', async ({ agent }, next) => {
    if (agent.id !== config.sessionId || attempted.has(agent) ||
        agent.session.snapshotEvents().some(e => ['request/header', 'assistant/message', 'assistant/attempt'].includes(e.type)))
      throw Error('Original native request may already have run; no replay');
    if (ctx.tools.schemas(agent).length) throw Error('Native tool scope changed');
    const selected = await next();
    if (selected.provider !== 'deepseek-official' || selected.model !== 'deepseek-flash' || selected.reasoningEffort !== 'high')
      throw Error('Reviewed native route changed');
    attempted.add(agent);
    return { ...selected, maxTokens: RICH_OUTPUT_CAP };
  }, { prepend: true });
  ctx.on('agent/request-error', async () => undefined, { prepend: true });
}
export function richPresetFiles(moduleUrl, raw) {
  const config = binding(raw), url = new URL(moduleUrl);
  if (url.protocol !== 'file:' || url.search || url.hash) throw Error('Exact local preset module required');
  return {
    'preset.yml': 'name: AAAAGENT B54 fictional knowledge\ndescription: One reviewed fictional text turn; no tools.\n',
    'agent.cordis.yml': '- id: persona\n  name: \'@deepseek-ai/dsh-persona\'\n  config:\n' +
      `    prefix: ${JSON.stringify(RICH_SYSTEM)}\n    complete: true\n    includeRuntimeContext: false\n` +
      `- id: aaaagent-b54-rich-memory\n  name: ${JSON.stringify(url.href)}\n  config:\n` +
      Object.entries(config).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}\n`).join(''),
  };
}
