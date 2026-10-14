import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from '../management/helpers.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { startRuntimeManagement } from '../../management/bootstrap.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';
import type { ProjectTerminalEvidence, ProjectTerminalMaterial } from '../../contracts/project-memory.js';
import type { ProjectTerminalModelSelection, ProjectTerminalModelTransport } from '../../contracts/project-terminal-processing.js';
import { credentialRegistry } from '../../management/credentials.js';
import { EvaluationBudget } from '../../core/evaluation-budget.js';
import { SqliteProjectMemory } from '../../projects/project-memory-sqlite.js';
import { createProjectTerminalExtractor } from '../../projects/project-terminal-extractor.js';
import { createProjectTerminalModelDeriver } from '../../projects/project-terminal-model-deriver.js';
import { assertProjectTerminalRetrySafe, createProjectTerminalModelCall,
  projectTerminalOperationId } from '../../management/project-terminal-processing.js';

test('bootstrap marks interrupted project jobs before serving and reports no unconfigured model processor', async t => {
  const f = await fixture(t);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c);
  const reject = (): never => { throw Error('Companion memory must stay isolated'); };
  const memory: ManagementMemoryPort = { characters: () => [], list: reject, edit: reject,
    context: reject, prompt: reject, savePrompt: reject };
  const ledgerBefore = await readFile(f.c.budgetFile);
  const first = await startRuntimeManagement(f.c, f.configFile, settings,
    new ManagementRuntime(f.c.sourceRevision), memory);
  const headers = { Authorization: `Bearer ${first.token}`, Origin: first.origin,
    'Content-Type': 'application/json' };
  const saved = await fetch(first.origin + '/api/projects/save', { method: 'POST', headers,
    body: JSON.stringify({ expectedVersion: 0, name: 'Synthetic project', abstract: '',
      detailRef: { rootPath: f.c.projectRoot } }) });
  assert.equal(saved.status, 200);
  const project = await saved.json() as { id: string };
  const queued = await first.projectMemory!.enqueueTerminal({ projectId: project.id,
    taskId: 'task-1', nativeTurnId: 'turn-1', terminalEventId: 'event-1',
    terminalPhase: 'completed', resultRef: 't3:env:thread:message:answer-1',
    occurredAt: '2026-09-27T00:00:00.000Z', extractionVersion: 'b54-t3-terminal-v1' });
  await first.close();
  const filename = join(f.c.projectRoot, 'data/desktop-pet/project-memory.sqlite');
  const db = new Database(filename);
  db.prepare("UPDATE project_memory_jobs SET state='running',attempts=1 WHERE id=?").run(queued.jobId);
  db.close();
  const second = await startRuntimeManagement(f.c, f.configFile, settings,
    new ManagementRuntime(f.c.sourceRevision), memory);
  t.after(() => second.close());
  const jobs = await fetch(second.origin + `/api/project-memory/jobs?projectId=${project.id}`, {
    headers: { Authorization: `Bearer ${second.token}` },
  });
  assert.equal(jobs.status, 200);
  const result = await jobs.json() as { processingAvailable: boolean;
    jobs: { id: string; state: string; errorCode: string }[] };
  assert.equal(result.processingAvailable, false);
  assert.deepEqual(result.jobs.map(job => [job.id, job.state, job.errorCode]),
    [[queued.jobId, 'failed', 'interrupted']]);
  assert.deepEqual(await readFile(f.c.budgetFile), ledgerBefore);
});

test('exact terminal material flows through paid-attempt guard and bounded deriver into a sourced candidate', async t => {
  const f = await fixture(t);
  const external = await mkdtemp(join(tmpdir(), 'aaa-terminal-composition-'));
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
  const evidence: ProjectTerminalEvidence = { projectId: 'project-a', taskId: 'task-a',
    nativeTurnId: 'turn-a', terminalEventId: 'event-a', terminalPhase: 'completed',
    resultRef: 't3:env:thread:message:answer-a', occurredAt: '2026-09-27T00:00:00.000Z',
    extractionVersion: 'b54-t3-terminal-v1' };
  const material: ProjectTerminalMaterial = { version: '0.1.0', source: 't3_thread_detail', evidence,
    userMessages: [{ id: 'user-a', text: '项目结论须核对真实 Host。' }],
    assistantMessage: { id: 'answer-a', text: '已记录待验收约束。' } };
  const sent: string[] = [];
  const transport: ProjectTerminalModelTransport = { async complete(request) {
    assert.equal(request.scope, 'project-terminal');
    assert.equal(request.credentialFile, credentialFile);
    assert.deepEqual(JSON.parse(request.userText), { terminalPhase: 'completed',
      userMessages: material.userMessages, assistantMessage: material.assistantMessage });
    sent.push(request.operationId);
    return { text: sent.length === 1 ? '{"outcome":"no_change"}' : JSON.stringify({
      outcome: 'proposals', claims: [{ stableKey: 'host-check', kind: 'constraint',
        text: '项目结论须核对真实 Host', sourceMessageIds: ['user-a'] }],
    }), finishReason: sent.length === 1 ? 'length' : 'stop',
    usage: { inputTokens: 12, outputTokens: 8 } };
  } };
  const store = new SqliteProjectMemory(join(config.projectRoot, 'project-memory.sqlite'), {
    autoProcess: false,
    retryGate: (job, next) => assertProjectTerminalRetrySafe(budget, job.evidence, next),
    extractor: (event, attempt) => {
      const port = createProjectTerminalModelCall(config, selection, transport, budget, attempt)!;
      return createProjectTerminalExtractor({ readTerminalMaterial: async () => material },
        createProjectTerminalModelDeriver(port))(event);
    },
  });
  t.after(() => store.close());
  const queued = await store.enqueueTerminal(evidence);
  await store.runPending();
  assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.state, 'failed');
  assert.deepEqual(await store.list({ projectId: evidence.projectId, limit: 10 }), []);
  assert.equal((await store.retryJob(evidence.projectId, queued.jobId)).state, 'queued');
  await store.runPending();
  assert.equal((await store.getJob(evidence.projectId, queued.jobId))?.state, 'done');
  const items = await store.list({ projectId: evidence.projectId, limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.status, 'candidate');
  assert.equal(items[0]?.sources[0]?.userInputId, 'user-a');
  assert.deepEqual(await store.recall({ projectId: evidence.projectId, limit: 10 }), []);
  assert.deepEqual(sent, [1, 2].map(attempt => projectTerminalOperationId(evidence, attempt)));
  assert.deepEqual((await budget.snapshot()).entries.filter(row => sent.includes(row.operationId))
    .map(row => [row.status, row.actualMicros]), [['settled', 26], ['settled', 26]]);
});
