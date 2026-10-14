import test from 'node:test';
import assert from 'node:assert/strict';
import type { DialogueRequest } from '../../contracts/index.js';
import { LocalDialogueProvider, localDialogueBudget, validateLocalDialogue } from '../../providers/local-dialogue.js';
import { countRequestInput } from '../../providers/input-count.js';
import { DEFAULT_CHARACTER_PROMPTS } from '../../companion/prompts.js';

const scope = { characterId: 'companion', sessionId: 'local-test', turnId: 't', generation: 1 };
const config = { baseUrl: 'http://127.0.0.1:11435/v1', model: 'aaaagent-qwen35-4b:review', contextWindowTokens: 16384,
  inputTokenLimit: 12000, outputTokenLimit: 768, reasoningEffort: 'none' as const };
const input: DialogueRequest = { scope, text: '你好，今天有点累。', context: { scope, characterPrompt: DEFAULT_CHARACTER_PROMPTS.companion!,
  recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 12000 } };
const reply = { text: '先歇一会儿吧，我陪着你。', expression: { emotion: 'warm', intensity: .4, delivery: '轻声', gesture: 'comfort', presetId: 'unavailable' } };
const response = (content: unknown = reply, finish_reason = 'stop') => Response.json({ choices: [{ finish_reason, message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });

test('local dialogue accepts only explicit loopback endpoints and bounded model configuration', () => {
  for (const baseUrl of ['https://remote.test/v1', 'http://localhost:11435/v1', 'http://127.0.0.1/v1', 'http://127.0.0.1:11435/v1?key=x',
    'http://user:pw@127.0.0.1:11435/v1', 'http://127.0.0.1:11435/other', 'http://192.168.1.2:11435/v1']) assert.throws(() => validateLocalDialogue({ ...config, baseUrl }));
  for (const invalid of [{ model: '' }, { model: 'a\nb' }, { inputTokenLimit: 16000 }, { outputTokenLimit: 0 }, { contextWindowTokens: 200000 },
    { temperature: NaN }, { timeoutMs: 10 }, { apiKey: 'must-not-be-accepted' }, { reasoningEffort: 'high' }]) assert.throws(() => validateLocalDialogue({ ...config, ...invalid }));
  assert.equal(validateLocalDialogue({ ...config, baseUrl: 'http://[::1]:11435/v1/' }).baseUrl, 'http://[::1]:11435/v1');
  assert.equal(localDialogueBudget(config, 200000).effectiveInputTokens, 12000);
  assert.equal(localDialogueBudget(config, 5000).effectiveInputTokens, 5000);
});

test('full companion prompt uses bounded OpenAI JSON, no credentials, same structured reply and count', async t => {
  let wire: Record<string, unknown> | undefined;
  const provider = new LocalDialogueProvider(config, () => ({ presets: [] }), async (url, init) => {
    assert.equal(url, config.baseUrl + '/chat/completions'); assert.equal(init?.redirect, 'error');
    assert.deepEqual(init?.headers, { 'Content-Type': 'application/json' });
    wire = JSON.parse(String(init?.body)); return response();
  });
  provider.prepare({ scope, text: input.text });
  const counted = provider.countContext(input.context, input.text);
  t.diagnostic(`Full default companion persona plus dialogue protocol: ${counted} conservative input tokens (UTF-8 request upper bound).`);
  assert.ok(counted < config.inputTokenLimit, `full persona prompt needs ${counted} conservative tokens`);
  const result = await provider.reply(input, new AbortController().signal);
  assert.deepEqual(result, { scope, ...reply, expression: { ...reply.expression, presetId: null } });
  assert.equal(countRequestInput(wire!), counted); assert.equal(wire!.model, config.model);
  assert.equal(wire!.max_tokens, 768); assert.equal(wire!.reasoning_effort, 'none');
  assert.deepEqual(wire!.response_format, { type: 'json_object' }); assert.equal(wire!.stream, false);
  assert.equal(wire!.enable_thinking, undefined); assert.equal(wire!.thinking, undefined);
});

test('local failures, malformed replies and truncation never retry or fall back', async () => {
  for (const getResponse of [() => new Response('private error body', { status: 503 }), () => response('not JSON'),
    () => response({ text: 'missing expression' }), () => response(reply, 'length'),
    () => new Response('x'.repeat(1024 * 1024 + 1))]) {
    let calls = 0;
    const provider = new LocalDialogueProvider(config, undefined, async () => { calls++; return getResponse(); });
    await assert.rejects(provider.reply(input, new AbortController().signal)); assert.equal(calls, 1);
  }
});

test('oversized required input and cross-scope context reject before any local request', async () => {
  let calls = 0;
  const provider = new LocalDialogueProvider(config, undefined, async () => { calls++; return response(); });
  await assert.rejects(provider.reply({ ...input, context: { ...input.context, inputTokenBudget: 1 } }, new AbortController().signal), /required_context_exceeds_budget/);
  await assert.rejects(provider.reply({ ...input, text: '大'.repeat(13000), context: { ...input.context, inputTokenBudget: 100000 } }, new AbortController().signal), /required_context_exceeds_budget/);
  await assert.rejects(provider.reply({ ...input, context: { ...input.context, scope: { ...scope, turnId: 'other' } } }, new AbortController().signal), /different turn/);
  assert.equal(calls, 0);
});

test('pre-cancelled and in-flight requests release callers without retries', async () => {
  let calls = 0, sent: AbortSignal | null | undefined;
  const controller = new AbortController(); controller.abort();
  const provider = new LocalDialogueProvider(config, undefined, async (_url, init) => { calls++; sent = init?.signal; return new Promise<Response>(() => {}); });
  await assert.rejects(provider.reply(input, controller.signal), { name: 'AbortError' }); assert.equal(calls, 0);
  const active = new AbortController(), pending = provider.reply(input, active.signal);
  active.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(sent?.aborted, true); assert.equal(calls, 1);
});

test('local deadline covers response reads and releases caller even if cleanup stalls', async () => {
  // Keep a referenced timer while AbortSignal.timeout's timer is unreferenced by Node.
  const keepAlive = setTimeout(() => {}, 2000); let cancelled = false;
  try {
    const provider = new LocalDialogueProvider({ ...config, timeoutMs: 1000 }, undefined, async () => new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise<void>(() => {}); } })));
    await assert.rejects(provider.reply(input, new AbortController().signal), { name: 'TimeoutError' });
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); }
});

test('HTTP failure does not wait for a stalled error-body cleanup', async () => {
  let cancelled = false;
  const provider = new LocalDialogueProvider(config, undefined, async () => new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise<void>(() => {}); } }), { status: 503 }));
  await assert.rejects(provider.reply(input, new AbortController().signal), /HTTP 503/);
  assert.equal(cancelled, true);
});
