import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { restrictPrivatePathSync } from '../../core/platform-files.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectTerminalModelTransport } from '../../contracts/project-terminal-processing.js';
import { credentialRegistry } from '../../management/credentials.js';
import { createProjectTerminalModelCall } from '../../management/project-terminal-processing.js';
import { createDeepSeekProjectTerminalTransport, ProjectTerminalTransportError } from
  '../../management/project-terminal-deepseek-transport.js';
import { DEEPSEEK_ENDPOINT, deepseekFlashModel } from '../../providers/text-protocol.js';
import { fixture } from './helpers.js';

type Input = Parameters<ProjectTerminalModelTransport['complete']>[0];
const syntheticKey = 'synthetic-only-never-send';
const syntheticCompletion = (finishReason: unknown = 'stop', usage: unknown =
  { prompt_tokens: 19, completion_tokens: 8 }) => JSON.stringify({
    choices: [{ index: 0, finish_reason: finishReason,
      message: { role: 'assistant', content: '{"outcome":"no_change"}' } }], usage,
  });
const fake = (run: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch =>
  run as typeof fetch;
const failure = (code: ProjectTerminalTransportError['code'], started: boolean) =>
  (error: unknown) => error instanceof ProjectTerminalTransportError &&
    error.code === code && error.requestStarted === started &&
    !error.message.includes(syntheticKey);

async function local(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'aaa-terminal-deepseek-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialFile = join(root, 'synthetic.key');
  await writeFile(credentialFile, syntheticKey, { mode: 0o600 });
  restrictPrivatePathSync(credentialFile);
  const input: Input = { scope: 'project-terminal', operationId: `project-terminal:${'a'.repeat(64)}`,
    projectId: 'project-synthetic', provider: 'deepseek', model: 'deepseek-flash',
    endpoint: DEEPSEEK_ENDPOINT, credentialFile,
    systemText: 'Return a JSON object with bounded project knowledge.',
    userText: 'A fully synthetic project terminal turn.', maxOutputTokens: 1024,
    timeoutMs: process.platform === 'win32' ? 10000 : 1000, signal: new AbortController().signal };
  return { input, credentialFile };
}

test('dedicated request uses exact model, non-thinking JSON wire and explicit output cap', async t => {
  const { input } = await local(t);
  let calls = 0;
  const transport = createDeepSeekProjectTerminalTransport(fake(async (url, init) => {
    calls++;
    assert.equal(url, DEEPSEEK_ENDPOINT);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${syntheticKey}`);
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.deepEqual(body, { model: 'deepseek-flash',
      messages: [{ role: 'system', content: input.systemText }, { role: 'user', content: input.userText }],
      stream: false, thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
      max_tokens: 1024 });
    assert.equal(JSON.stringify(body).includes('project-synthetic'), false);
    return new Response(syntheticCompletion(), { status: 200 });
  }));
  assert.deepEqual(await transport.complete(input), {
    text: '{"outcome":"no_change"}', finishReason: 'stop',
    usage: { inputTokens: 19, outputTokens: 8 },
  });
  assert.equal(calls, 1);
});

test('supplier finish reason is preserved; absent or unsupported usage is never invented', async t => {
  const { input } = await local(t);
  for (const [supplier, expected] of [['stop', 'stop'], ['length', 'length'],
    ['content_filter', 'unknown'], [null, 'unknown']] as const) {
    const transport = createDeepSeekProjectTerminalTransport(fake(async () =>
      new Response(syntheticCompletion(supplier, { prompt_tokens: 12, completion_tokens: 5 }), { status: 200 })));
    assert.equal((await transport.complete(input)).finishReason, expected);
  }
  const missing = createDeepSeekProjectTerminalTransport(fake(async () =>
    new Response(syntheticCompletion('stop', { prompt_tokens: 12 }), { status: 200 })));
  assert.equal((await missing.complete(input)).usage, null);
  const fractional = createDeepSeekProjectTerminalTransport(fake(async () =>
    new Response(syntheticCompletion('stop', { prompt_tokens: 1.5, completion_tokens: 5 }), { status: 200 })));
  assert.equal((await fractional.complete(input)).usage, null);
});

test('invalid destination, model or aborted input never opens a request', async t => {
  const { input } = await local(t);
  let calls = 0;
  const transport = createDeepSeekProjectTerminalTransport(fake(async () => {
    calls++; return new Response(syntheticCompletion());
  }));
  await assert.rejects(transport.complete({ ...input, endpoint: 'https://elsewhere.invalid/chat/completions' }),
    failure('invalid_request', false));
  await assert.rejects(transport.complete({ ...input, model: 'deepseek-v4-pro' }),
    failure('invalid_request', false));
  await assert.rejects(transport.complete({ ...input, thinking: 'high' }),
    failure('invalid_request', false));
  await assert.rejects(transport.complete({ ...input, maxOutputTokens: 393217 }),
    failure('invalid_request', false));
  await assert.rejects(transport.complete({ ...input, userText: 'x'.repeat(240001) }),
    failure('invalid_request', false));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(transport.complete({ ...input, signal: controller.signal }), failure('aborted', false));
  assert.equal(calls, 0);
});

test('missing or insecure synthetic credential fails locally without a send or secret in errors', async t => {
  const { input, credentialFile } = await local(t);
  let calls = 0;
  const transport = createDeepSeekProjectTerminalTransport(fake(async () => {
    calls++; return new Response(syntheticCompletion());
  }));
  await assert.rejects(transport.complete({ ...input, credentialFile: join(tmpdir(), 'missing-terminal-key') }),
    failure('credential_unavailable', false));
  if (process.platform === 'win32') execFileSync('icacls.exe', [credentialFile, '/grant', '*S-1-1-0:R'], { windowsHide: true, stdio: 'pipe' });
  else await chmod(credentialFile, 0o644);
  await assert.rejects(transport.complete(input), failure('credential_unavailable', false));
  assert.equal(calls, 0);
});

test('HTTP error, malformed body, oversized response and fetch rejection are redacted and never retried', async t => {
  const { input } = await local(t);
  const cases: { response?: Response; error?: Error; code: ProjectTerminalTransportError['code'] }[] = [
    { response: new Response(`supplier says ${syntheticKey}`, { status: 429 }), code: 'http_error' },
    { response: new Response(`supplier says ${syntheticKey}`, { status: 200 }), code: 'invalid_response' },
    { response: new Response('x'.repeat(128 * 1024 + 1), { status: 200 }), code: 'response_too_large' },
    { error: new Error(`raw provider ${syntheticKey}`), code: 'transport_unknown' },
  ];
  for (const row of cases) {
    let calls = 0;
    const transport = createDeepSeekProjectTerminalTransport(fake(async () => {
      calls++;
      if (row.error) throw row.error;
      return row.response!;
    }));
    await assert.rejects(transport.complete(input), failure(row.code, true));
    assert.equal(calls, 1);
  }
});

test('caller cancellation after fetch begins ends locally and never starts another request', async t => {
  const { input } = await local(t);
  const controller = new AbortController();
  let calls = 0, entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const transport = createDeepSeekProjectTerminalTransport(fake(async () => {
    calls++; entered!(); return new Promise<Response>(() => undefined);
  }));
  const pending = transport.complete({ ...input, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, failure('aborted', true));
  assert.equal(calls, 1);
});

test('transport timeout aborts an unresponsive fetch without another request', async t => {
  const { input } = await local(t);
  let calls = 0;
  const transport = createDeepSeekProjectTerminalTransport(fake(async () => {
    calls++; return new Promise<Response>(() => undefined);
  }));
  await assert.rejects(transport.complete(input), failure('aborted', true));
  assert.equal(calls, 1);
});

test('shared project call port reserves before this transport and settles only actual usage', async t => {
  const f = await fixture(t);
  const { credentialFile } = await local(t);
  const summary = deepseekFlashModel(credentialFile);
  const config = { ...f.c, models: { ...f.c.models, summary } };
  const selection = { version: '0.1.0' as const, scope: 'project-terminal' as const,
    adapterId: 'deepseek-summary', provider: 'deepseek' as const, model: summary.model,
    endpoint: summary.endpoint, credentialRef: credentialRegistry(config).ref(credentialFile, 'deepseek'),
    inputTokenLimit: summary.inputTokenLimit, outputTokenLimit: summary.outputTokenLimit,
    inputMicrosPerToken: summary.inputMicrosPerToken, outputMicrosPerToken: summary.outputMicrosPerToken,
    reservationMicros: summary.reservationMicros, timeoutMs: 30000 };
  let calls = 0;
  const transport = createDeepSeekProjectTerminalTransport(fake(async (_url, init) => {
    calls++;
    assert.equal((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens, 1024);
    return new Response(syntheticCompletion(), { status: 200 });
  }));
  const port = createProjectTerminalModelCall(config, selection, transport)!;
  const request = { evidence: { projectId: 'project-a', taskId: 'task-a', nativeTurnId: 'turn-a',
    terminalEventId: 'event-a', terminalPhase: 'completed' as const,
    resultRef: 't3:local:thread-a:message:answer-a', occurredAt: '2026-09-27T00:00:00.000Z',
    extractionVersion: 'b54-t3-terminal-v1' },
  systemText: 'Return JSON only.', userText: 'Synthetic project requirement.' };
  assert.equal(await port.complete({ ...request, maxOutputTokens: 1024 }), '{"outcome":"no_change"}');
  await assert.rejects(port.complete({ ...request, maxOutputTokens: 2048 }));
  assert.equal(calls, 1);
  const ledger = JSON.parse(await readFile(config.budgetFile, 'utf8')) as {
    entries: { operationId: string; status: string; reservedMicros: number;
      actualMicros: number | null }[] };
  const entry = ledger.entries.find(row => row.operationId.startsWith('project-terminal:'))!;
  assert.equal(entry.status, 'settled');
  assert.equal(entry.reservedMicros, summary.reservationMicros);
  assert.equal(entry.actualMicros, 19 * 2 + 8 * 8);
});
