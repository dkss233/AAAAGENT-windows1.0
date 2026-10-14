import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TrialConfiguration } from '../../app/trial-config.js';
import { deepseekFlashModel } from '../../providers/text-protocol.js';
import { credentialRegistry } from '../../management/credentials.js';

const toolUrl = new URL('../../../tools/project-terminal-synthetic-trial.mjs', import.meta.url);
const { prepareSyntheticTrial, runApprovedSyntheticTrial } = await import(toolUrl.href);
const artifactRoot = fileURLToPath(new URL('../../../../../artifacts/W3/project-terminal-synthetic-trial-54/', import.meta.url));
const historical = { operationId: 'synthetic-prior-entry', model: 'prior-synthetic', reservedMicros: 30,
  actualMicros: 20, status: 'settled' };
const validClaims = { outcome: 'proposals', claims: [
  { stableKey: 'host-acceptance', kind: 'constraint', text: '松果项目必须通过真实 Host 验收。', sourceMessageIds: ['synthetic-user-1'] },
  { stableKey: 'host-pending', kind: 'fact', text: '尚未执行真实 Host 验收。', sourceMessageIds: ['synthetic-assistant-1'] },
] };
function response(content: unknown = validClaims, finish: unknown = 'stop', usage: unknown = { prompt_tokens: 401, completion_tokens: 77 }) {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: finish }], usage }));
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  await mkdir(artifactRoot, { recursive: true });
  const root = await mkdtemp(join(artifactRoot, 'test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot);
  const credentialFile = join(root, 'synthetic.key');
  await writeFile(credentialFile, 'synthetic-test-key-never-a-real-credential', { mode: 0o600 });
  const model = deepseekFlashModel(credentialFile);
  const budgetFile = join(projectRoot, 'artifacts/W0-I/model-evaluation/budget.json');
  await mkdir(dirname(budgetFile), { recursive: true });
  await writeFile(budgetFile, JSON.stringify({ batchId: 'synthetic-existing-batch', currency: 'CNY',
    limitMicros: null, budgetMode: 'unlimited', blocked: false, entries: [historical] }));
  const configuration: TrialConfiguration = { version: 1, product: 'companion-v1', purpose: 'user-trial',
    phaseId: 'local-trial-synthetic', sourceRevision: '4bb08e53948b401a36d245757d5cc05f73db0d14',
    projectRoot, runtimeFiles: {}, database: join(projectRoot, 'unused-companion.sqlite'),
    budgetFile, budgetBatchId: 'synthetic-existing-batch', budgetMode: 'unlimited', limitMicros: null,
    phaseLimitMicros: 0, maxCalls: 0, operationLimits: { dialogue: 0, summary: 0, admission: 0, memory_turn: 0, perception: 0, tts: 0 },
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
    models: { dialogue: model, summary: model, admission: model, memory_turn: model, perception: model, tts: model },
  };
  const review = await prepareSyntheticTrial();
  const credentialRef = credentialRegistry(configuration).ref(credentialFile, 'deepseek');
  const options = { configuration, credentialRef,
    trialDirectory: join(projectRoot, 'artifacts/trial'),
    approval: { mode: 'offline-test', requestSha256: review.requestSha256, maxRequests: 1, credentialRef,
      accountCurrency: 'CNY', currencyEvidence: 'synthetic fixture only', reference: 'synthetic approval only' } };
  return { options, review };
}

test('default CLI emits reproducible complete dry-run JSON and refuses execute arguments', async () => {
  const first = JSON.parse(execFileSync(process.execPath, [fileURLToPath(toolUrl)], { encoding: 'utf8' }));
  assert.deepEqual(first, await prepareSyntheticTrial());
  assert.equal(first.mode, 'dry-run');
  assert.equal(first.accounting.providerAccountCurrency, null);
  assert.equal(first.accounting.assumptionBoundMicros, 32768 * 2 + 1024 * 8);
  assert.equal(first.accounting.existingCatalogReservationMicros, 3211264);
  assert.equal(first.body.messages.length, 2);
  assert.match(first.body.messages[0].content, /Every proposal remains a candidate/);
  const material = JSON.parse(first.body.messages[1].content);
  assert.match(material.userMessages[0].text, /完全虚构/);
  assert.match(material.assistantMessage.text, /尚未执行真实 Host 验收/);
  assert.deepEqual(JSON.parse(first.bodyJson), first.body);
  assert.equal(first.body.max_tokens, 1024);
  assert.deepEqual(first.body.thinking, { type: 'disabled' });
  assert.deepEqual(first.body.response_format, { type: 'json_object' });
  assert.equal(first.timeoutMs, 30000);
  assert.equal(first.automaticRetries, 0);
  assert.doesNotMatch(JSON.stringify(first), /Bearer|\/Users\//);
  assert.equal(spawnSync(process.execPath, [fileURLToPath(toolUrl), '--execute']).status, 2);
});

test('approved payload equals actual adapter bytes; candidates retain sources and same attempt never resends', async t => {
  const { options, review } = await fixture(t);
  const originalConfig = JSON.stringify(options.configuration);
  let sends = 0;
  const fetcher = async (url: string, init: RequestInit) => {
    sends++;
    assert.equal(url, review.endpoint);
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, review.bodyJson);
    assert.equal(init.signal?.aborted, false);
    const signature = createHash('sha256').update(JSON.stringify({ method: 'POST', endpoint: url,
      bodyJson: init.body, timeoutMs: 30000, attemptOrdinal: 1, operationId: review.operationId })).digest('hex');
    assert.equal(signature, review.requestSha256);
    return response();
  };
  const result = await runApprovedSyntheticTrial({ ...options, fetcher });
  assert.equal(result.job.state, 'done');
  assert.equal(result.fetchInvocations, 1);
  assert.equal(result.job.attempts, 1);
  assert.equal(result.items.length, 2);
  assert.ok(result.items.every((item: { status: string }) => item.status === 'candidate'));
  assert.ok(result.items.some((item: { sources: { userInputId?: string }[] }) => item.sources[0]?.userInputId === 'synthetic-user-1'));
  assert.ok(result.items.some((item: { sources: { artifactRef?: string }[] }) => item.sources[0]?.artifactRef?.endsWith(':message:synthetic-assistant-1')));
  assert.equal(result.providerResponse.finishReason, 'stop');
  assert.deepEqual(result.providerResponse.usage, { inputTokens: 401, outputTokens: 77 });
  assert.equal(result.accountingEntry.actualMicros, 401 * 2 + 77 * 8);
  const repeated = await runApprovedSyntheticTrial({ ...options, fetcher });
  assert.equal(repeated.job.id, result.job.id);
  assert.equal(repeated.fetchInvocations, 0);
  assert.equal(repeated.job.attempts, 1);
  // Even a newly created SQLite database cannot bypass the existing operation in the shared ledger.
  const other = await runApprovedSyntheticTrial({ ...options, trialDirectory: options.trialDirectory + '-second', fetcher });
  assert.equal(other.job.state, 'failed');
  assert.equal(other.fetchInvocations, 0);
  assert.equal(sends, 1);
  assert.equal(JSON.stringify(options.configuration), originalConfig);
  const ledger = JSON.parse(await readFile(options.configuration.budgetFile, 'utf8'));
  assert.deepEqual(ledger.entries[0], historical);
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.limitMicros, null);
});

test('unknown currency or changed review is refused before files or sends', async () => {
  let sends = 0;
  const valid = { mode: 'offline-test', requestSha256: (await prepareSyntheticTrial()).requestSha256,
    maxRequests: 1, credentialRef: 'synthetic-ref', accountCurrency: 'CNY',
    currencyEvidence: 'synthetic currency proof', reference: 'synthetic approval' };
  for (const change of [{ accountCurrency: null }, { accountCurrency: 'USD' }, { currencyEvidence: '' },
    { requestSha256: 'stale' }, { credentialRef: 'other-account' }, { maxRequests: 2 }]) {
    await assert.rejects(runApprovedSyntheticTrial({ credentialRef: 'synthetic-ref', approval: { ...valid, ...change },
      fetcher: async () => { sends++; return response(); } }), /approval/);
  }
  assert.equal(sends, 0);
});

for (const scenario of ['length', 'unknown', 'invalid-source', 'malformed', 'missing-usage', 'network-unknown', 'no-change'] as const) {
  test(`single-attempt boundary: ${scenario}`, async t => {
    const { options } = await fixture(t);
    let sends = 0;
    const fetcher = async () => {
      sends++;
      if (scenario === 'network-unknown') throw new Error('synthetic network exception');
      if (scenario === 'invalid-source') return response({ outcome: 'proposals', claims: [{ ...validClaims.claims[0], sourceMessageIds: ['invented'] }] });
      if (scenario === 'malformed') return response('{broken');
      if (scenario === 'missing-usage') return response(validClaims, 'stop', null);
      if (scenario === 'no-change') return response({ outcome: 'no_change' });
      return response(validClaims, scenario);
    };
    const result = await runApprovedSyntheticTrial({ ...options, fetcher });
    assert.equal(result.job.state, ['missing-usage', 'no-change'].includes(scenario) ? 'done' : 'failed');
    assert.equal(result.items.length, scenario === 'missing-usage' ? 2 : 0);
    assert.equal(result.accountingEntry.status, ['unknown', 'missing-usage', 'network-unknown'].includes(scenario) ? 'unknown' : 'settled');
    if (scenario === 'length') assert.equal(result.providerResponse.finishReason, 'length');
    if (scenario === 'network-unknown') assert.equal(result.transportError.requestStarted, true);
    await runApprovedSyntheticTrial({ ...options, fetcher });
    assert.equal(sends, 1);
  });
}
