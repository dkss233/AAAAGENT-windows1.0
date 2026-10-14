import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { credentialRegistry } from '../../management/credentials.js';
import { createProjectTerminalModelCall } from '../../management/project-terminal-processing.js';
import { assertProjectTerminalRetrySafe, projectTerminalOperationId } from '../../management/project-terminal-processing.js';
import { EvaluationBudget } from '../../core/evaluation-budget.js';
import { SqliteProjectMemory, type ProjectMemoryOptions } from '../../projects/project-memory-sqlite.js';
import Database from 'better-sqlite3';
import { ProjectTerminalTransportError, type ProjectTerminalModelRequest, type ProjectTerminalModelSelection,
  ProjectTerminalModelTransport } from '../../contracts/project-terminal-processing.js';
import { ManagementError } from '../../contracts/management.js';

const evidence = { projectId: 'project-a', taskId: 'task-1', nativeTurnId: 'turn-1',
  terminalEventId: 'event-1', terminalPhase: 'completed' as const,
  resultRef: 't3:env:thread:message:answer-1', occurredAt: '2026-09-27T00:00:00.000Z',
  extractionVersion: 'b54-t3-terminal-v1' };
const input: ProjectTerminalModelRequest = { evidence, systemText: 'Return bounded JSON claims from exact sources.',
  userText: 'Synthetic project terminal material only.' };

test('project-scoped model port requires reviewed selection, separate credential reference and shared ledger', async t => {
  const f = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), 'aaa-project-terminal-fixture-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const credentialFile = join(external, 'synthetic.key');
  await writeFile(credentialFile, 'test-only-not-a-provider-key', { mode: 0o600 });
  const summary = { ...f.c.models.summary, credentialFile };
  const config = { ...f.c, models: { ...f.c.models, summary } };
  const selection: ProjectTerminalModelSelection = { version: '0.1.0', scope: 'project-terminal',
    adapterId: 'qwen-summary', provider: 'dashscope', model: summary.model, endpoint: summary.endpoint,
    credentialRef: credentialRegistry(config).ref(credentialFile, 'dashscope'),
    inputTokenLimit: summary.inputTokenLimit, outputTokenLimit: summary.outputTokenLimit,
    inputMicrosPerToken: summary.inputMicrosPerToken, outputMicrosPerToken: summary.outputMicrosPerToken,
    reservationMicros: summary.reservationMicros, timeoutMs: 30000 };
  let calls = 0;
  const transport: ProjectTerminalModelTransport = { async complete(request) {
    calls++;
    assert.equal(request.scope, 'project-terminal');
    assert.equal(request.projectId, evidence.projectId);
    assert.equal(request.credentialFile, credentialFile);
    assert.equal(request.signal.aborted, false);
    assert.equal(request.operationId.startsWith('project-terminal:'), true);
    assert.equal(request.maxOutputTokens, summary.outputTokenLimit);
    return { text: '{"outcome":"no_change"}', finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 8 } };
  } };
  assert.equal(createProjectTerminalModelCall(config, undefined, transport), null);
  assert.equal(createProjectTerminalModelCall(config, selection, undefined), null);
  assert.throws(() => createProjectTerminalModelCall(config, { ...selection, model: 'unknown-model' }, transport),
    (error: unknown) => error instanceof ManagementError && error.code === 'unavailable');
  const port = createProjectTerminalModelCall(config, selection, transport)!;
  for (const maxOutputTokens of [0, -1, 1.5, summary.outputTokenLimit + 1]) {
    await assert.rejects(port.complete({ ...input, maxOutputTokens }),
      (error: unknown) => error instanceof ManagementError && error.code === 'unavailable');
  }
  assert.equal(calls, 0);
  assert.equal((await new EvaluationBudget(config.budgetFile, config.budgetBatchId,
    config.limitMicros).snapshot()).entries.some(row => row.operationId ===
      projectTerminalOperationId(evidence, 1)), false);
  assert.equal(await port.complete(input), '{"outcome":"no_change"}');
  await assert.rejects(port.complete(input), /already reserved/);
  assert.equal(calls, 1);
  const ledger = JSON.parse(await readFile(config.budgetFile, 'utf8')) as { entries: { operationId: string;
    status: string; actualMicros: number }[] };
  const entry = ledger.entries.find(row => row.operationId.startsWith('project-terminal:'))!;
  assert.equal(entry.status, 'settled'); assert.equal(entry.actualMicros, 26);
  assert.equal(JSON.stringify(ledger).includes(input.userText), false);
});

test('unknown provider outcome remains reserved and never repeats the same terminal event', async t => {
  const f = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), 'aaa-project-terminal-fixture-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const credentialFile = join(external, 'synthetic.key');
  await writeFile(credentialFile, 'test-only-not-a-provider-key', { mode: 0o600 });
  const summary = { ...f.c.models.summary, credentialFile };
  const config = { ...f.c, models: { ...f.c.models, summary } };
  const selection: ProjectTerminalModelSelection = { version: '0.1.0', scope: 'project-terminal',
    adapterId: 'qwen-summary', provider: 'dashscope', model: summary.model, endpoint: summary.endpoint,
    credentialRef: credentialRegistry(config).ref(credentialFile, 'dashscope'),
    inputTokenLimit: summary.inputTokenLimit, outputTokenLimit: summary.outputTokenLimit,
    inputMicrosPerToken: summary.inputMicrosPerToken, outputMicrosPerToken: summary.outputMicrosPerToken,
    reservationMicros: summary.reservationMicros, timeoutMs: 30000 };
  let calls = 0;
  const port = createProjectTerminalModelCall(config, selection, { async complete() {
    calls++; throw new Error('synthetic uncertain provider failure containing raw text');
  } })!;
  await assert.rejects(port.complete(input), (error: unknown) => error instanceof ManagementError &&
    error.code === 'unavailable' && !error.message.includes('raw text'));
  await assert.rejects(port.complete(input), /already reserved/);
  assert.equal(calls, 1);
  const raw = await readFile(config.budgetFile, 'utf8');
  assert.equal(raw.includes('raw text'), false);
  assert.equal((JSON.parse(raw) as { entries: { status: string }[] }).entries.at(-1)?.status, 'unknown');
});

test('parseable JSON with supplier length finish is rejected before the deriver can use it', async t => {
  const f = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), 'aaa-project-terminal-fixture-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const credentialFile = join(external, 'synthetic.key');
  await writeFile(credentialFile, 'test-only-not-a-provider-key', { mode: 0o600 });
  const summary = { ...f.c.models.summary, credentialFile };
  const config = { ...f.c, models: { ...f.c.models, summary } };
  const selection: ProjectTerminalModelSelection = { version: '0.1.0', scope: 'project-terminal',
    adapterId: 'qwen-summary', provider: 'dashscope', model: summary.model, endpoint: summary.endpoint,
    credentialRef: credentialRegistry(config).ref(credentialFile, 'dashscope'),
    inputTokenLimit: summary.inputTokenLimit, outputTokenLimit: summary.outputTokenLimit,
    inputMicrosPerToken: summary.inputMicrosPerToken, outputMicrosPerToken: summary.outputMicrosPerToken,
    reservationMicros: summary.reservationMicros, timeoutMs: 30000 };
  let calls = 0;
  const port = createProjectTerminalModelCall(config, selection, { async complete() {
    calls++; return { text: '{"outcome":"no_change"}', finishReason: 'length',
      usage: { inputTokens: 12, outputTokens: 8 } };
  } })!;
  await assert.rejects(port.complete(input), (error: unknown) => error instanceof ManagementError &&
    error.code === 'unavailable');
  await assert.rejects(port.complete(input), /already reserved/);
  assert.equal(calls, 1);
  const ledger = JSON.parse(await readFile(config.budgetFile, 'utf8')) as { entries: { status: string;
    actualMicros: number | null }[] };
  assert.equal(ledger.entries.at(-1)?.status, 'settled');
  assert.equal(ledger.entries.at(-1)?.actualMicros, 26);
});

async function attemptFixture(t: Parameters<typeof fixture>[0]) {
  const f = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), 'aaa-project-terminal-attempt-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const credentialFile = join(external, 'synthetic.key');
  await writeFile(credentialFile, 'test-only-not-a-provider-key', { mode: 0o600 });
  const summary = { ...f.c.models.summary, credentialFile };
  const config = { ...f.c, models: { ...f.c.models, summary } };
  const selection: ProjectTerminalModelSelection = { version: '0.1.0', scope: 'project-terminal',
    adapterId: 'qwen-summary', provider: 'dashscope', model: summary.model, endpoint: summary.endpoint,
    credentialRef: credentialRegistry(config).ref(credentialFile, 'dashscope'),
    inputTokenLimit: summary.inputTokenLimit, outputTokenLimit: summary.outputTokenLimit,
    inputMicrosPerToken: summary.inputMicrosPerToken, outputMicrosPerToken: summary.outputMicrosPerToken,
    reservationMicros: summary.reservationMicros, timeoutMs: 30000 };
  const budget = new EvaluationBudget(config.budgetFile, config.budgetBatchId, config.limitMicros);
  return { config, selection, budget };
}

test('local preflight failure has no reservation and an explicit job retry gets a fresh attempt', async t => {
  const { config, selection, budget } = await attemptFixture(t);
  let sends = 0;
  const transport: ProjectTerminalModelTransport = { async complete() {
    sends++; return { text: '{"outcome":"no_change"}', finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 8 } };
  } };
  const store = new SqliteProjectMemory(join(config.projectRoot, 'project-memory.sqlite'), {
    autoProcess: false,
    retryGate: (job, next) => assertProjectTerminalRetrySafe(budget, job.evidence, next),
    extractor: async (frozen, attempt) => {
      const port = createProjectTerminalModelCall(config, selection, transport, budget, attempt)!;
      await port.complete({ ...input, evidence: frozen, systemText: attempt === 1 ? 'x'.repeat(33000) : 'prompt' });
      return [];
    },
  });
  t.after(() => store.close());
  const queued = await store.enqueueTerminal(evidence);
  await store.runPending();
  assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.state, 'failed');
  assert.equal(sends, 0);
  assert.equal((await budget.snapshot()).entries.some(row => row.operationId === projectTerminalOperationId(evidence, 1)), false);
  assert.equal((await store.retryJob(evidence.projectId, queued.jobId)).state, 'queued');
  await store.runPending();
  assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.attempts, 2);
  assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.state, 'done');
  assert.equal(sends, 1);
  assert.equal((await budget.snapshot()).entries.find(row => row.operationId === projectTerminalOperationId(evidence, 2))?.status, 'settled');
});

test('proved pre-send adapter failure settles zero and permits only an explicit new job attempt', async t => {
  const { config, selection, budget } = await attemptFixture(t);
  let sends = 0;
  const transport: ProjectTerminalModelTransport = { async complete() {
    if (sends++ === 0) throw new ProjectTerminalTransportError('credential_unavailable', false);
    return { text: '{"outcome":"no_change"}', finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 8 } };
  } };
  const store = new SqliteProjectMemory(join(config.projectRoot, 'project-memory.sqlite'), {
    autoProcess: false,
    retryGate: (job, next) => assertProjectTerminalRetrySafe(budget, job.evidence, next),
    extractor: async (frozen, attempt) => {
      await createProjectTerminalModelCall(config, selection, transport, budget, attempt)!
        .complete({ ...input, evidence: frozen });
      return [];
    },
  });
  t.after(() => store.close());
  const queued = await store.enqueueTerminal(evidence);
  await store.runPending();
  assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.state, 'failed');
  assert.equal((await budget.snapshot()).entries.find(row => row.operationId ===
    projectTerminalOperationId(evidence, 1))?.actualMicros, 0);
  assert.equal((await budget.snapshot()).entries.find(row => row.operationId ===
    projectTerminalOperationId(evidence, 1))?.status, 'settled');
  assert.equal(sends, 1);
  assert.equal((await store.retryJob(evidence.projectId, queued.jobId)).state, 'queued');
  await store.runPending();
  assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.state, 'done');
  assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.attempts, 2);
  assert.equal((await budget.snapshot()).entries.find(row => row.operationId ===
    projectTerminalOperationId(evidence, 2))?.actualMicros, 26);
  assert.equal(sends, 2);
});

test('adapter failure after fetch starts stays unknown and blocks retry', async t => {
  const { config, selection, budget } = await attemptFixture(t);
  let sends = 0;
  const transport: ProjectTerminalModelTransport = { async complete() {
    sends++; throw new ProjectTerminalTransportError('transport_unknown', true);
  } };
  const store = new SqliteProjectMemory(join(config.projectRoot, 'project-memory.sqlite'), {
    autoProcess: false,
    retryGate: (job, next) => assertProjectTerminalRetrySafe(budget, job.evidence, next),
    extractor: async (frozen, attempt) => {
      await createProjectTerminalModelCall(config, selection, transport, budget, attempt)!
        .complete({ ...input, evidence: frozen });
      return [];
    },
  });
  t.after(() => store.close());
  const queued = await store.enqueueTerminal(evidence);
  await store.runPending();
  assert.equal((await budget.snapshot()).entries.find(row => row.operationId ===
    projectTerminalOperationId(evidence, 1))?.status, 'unknown');
  await assert.rejects(store.retryJob(evidence.projectId, queued.jobId),
    (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict');
  assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.state, 'failed');
  assert.equal(sends, 1);
});

test('confirmed length and malformed extraction consume distinct, explicitly retried paid attempts', async t => {
  const { config, selection, budget } = await attemptFixture(t);
  const sent: string[] = [];
  const transport: ProjectTerminalModelTransport = { async complete(request) {
    sent.push(request.operationId);
    return { text: sent.length === 2 ? '{bad JSON' : '{"outcome":"no_change"}',
      finishReason: sent.length === 1 ? 'length' : 'stop', usage: { inputTokens: 12, outputTokens: 8 } };
  } };
  const store = new SqliteProjectMemory(join(config.projectRoot, 'project-memory.sqlite'), {
    autoProcess: false,
    retryGate: (job, next) => assertProjectTerminalRetrySafe(budget, job.evidence, next),
    extractor: async (frozen, attempt) => {
      const port = createProjectTerminalModelCall(config, selection, transport, budget, attempt)!;
      const result = await port.complete({ ...input, evidence: frozen });
      JSON.parse(result); // Synthetic deriver parse rejection after a confirmed stop and known usage.
      return [];
    },
  });
  t.after(() => store.close());
  const queued = await store.enqueueTerminal(evidence);
  for (let attempt = 1; attempt <= 2; attempt++) {
    await store.runPending();
    assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.state, 'failed');
    assert.equal((await budget.snapshot()).entries.find(row => row.operationId === projectTerminalOperationId(evidence, attempt))?.status, 'settled');
    assert.equal((await store.retryJob(evidence.projectId, queued.jobId)).state, 'queued');
  }
  await store.runPending();
  assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.state, 'done');
  assert.deepEqual(sent, [1, 2, 3].map(attempt => projectTerminalOperationId(evidence, attempt)));
  assert.equal(new Set(sent).size, 3);
});

test('unknown transport outcome stays failed across restart and cannot queue or send again', async t => {
  const { config, selection, budget } = await attemptFixture(t);
  let sends = 0;
  const transport: ProjectTerminalModelTransport = { async complete() { sends++; throw Error('synthetic provider uncertainty'); } };
  const filename = join(config.projectRoot, 'project-memory.sqlite');
  const options: ProjectMemoryOptions = { autoProcess: false,
    retryGate: (job, next) => assertProjectTerminalRetrySafe(budget, job.evidence, next),
    extractor: async (frozen, attempt) => {
      await createProjectTerminalModelCall(config, selection, transport, budget, attempt)!.complete({ ...input, evidence: frozen });
      return [];
    },
  };
  const first = new SqliteProjectMemory(filename, options);
  const queued = await first.enqueueTerminal(evidence);
  await first.runPending();
  assert.equal((await budget.snapshot()).entries.find(row => row.operationId === projectTerminalOperationId(evidence, 1))?.status, 'unknown');
  await first.close();
  const restarted = new SqliteProjectMemory(filename, options);
  t.after(() => restarted.close());
  await assert.rejects(restarted.retryJob(evidence.projectId, queued.jobId),
    (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict');
  assert.equal((await restarted.getJob(evidence.projectId, queued.jobId))?.state, 'failed');
  assert.equal((await restarted.getJob(evidence.projectId, queued.jobId))?.attempts, 1);
  assert.equal(await restarted.runPending(), 0);
  assert.equal(sends, 1);
});

test('interrupted reserved attempt blocks retry before it becomes queued', async t => {
  const { config, selection, budget } = await attemptFixture(t);
  let sends = 0;
  const transport: ProjectTerminalModelTransport = { async complete() {
    sends++; return { text: '{"outcome":"no_change"}', finishReason: 'stop',
      usage: { inputTokens: 12, outputTokens: 8 } };
  } };
  const filename = join(config.projectRoot, 'project-memory.sqlite');
  const first = new SqliteProjectMemory(filename, { autoProcess: false });
  const queued = await first.enqueueTerminal(evidence);
  await first.close();
  const db = new Database(filename);
  db.prepare("UPDATE project_memory_jobs SET state='running',attempts=1 WHERE id=?").run(queued.jobId);
  db.close();
  await budget.reserve(projectTerminalOperationId(evidence, 1), selection.model, selection.reservationMicros);
  const restarted = new SqliteProjectMemory(filename, { autoProcess: false,
    retryGate: (job, next) => assertProjectTerminalRetrySafe(budget, job.evidence, next),
    extractor: async (frozen, attempt) => {
      await createProjectTerminalModelCall(config, selection, transport, budget, attempt)!.complete({ ...input, evidence: frozen });
      return [];
    },
  });
  t.after(() => restarted.close());
  assert.equal(await restarted.recoverInterruptedJobs(), 1);
  await assert.rejects(restarted.retryJob(evidence.projectId, queued.jobId),
    (error: unknown) => error instanceof ManagementError && error.code === 'version_conflict');
  assert.equal((await restarted.getJob(evidence.projectId, queued.jobId))?.state, 'failed');
  assert.equal(await restarted.runPending(), 0);
  assert.equal(sends, 0);
});

test('supplier unknown finish is unresolved even when token usage is present', async t => {
  const { config, selection, budget } = await attemptFixture(t);
  const port = createProjectTerminalModelCall(config, selection, { async complete() {
    return { text: '{"outcome":"no_change"}', finishReason: 'unknown',
      usage: { inputTokens: 12, outputTokens: 8 } };
  } }, budget)!;
  await assert.rejects(port.complete(input), (error: unknown) =>
    error instanceof ManagementError && error.code === 'unavailable');
  assert.equal((await budget.snapshot()).entries.find(row => row.operationId === projectTerminalOperationId(evidence, 1))?.status, 'unknown');
  await assert.rejects(assertProjectTerminalRetrySafe(budget, evidence, 2), (error: unknown) =>
    error instanceof ManagementError && error.code === 'version_conflict');
});
