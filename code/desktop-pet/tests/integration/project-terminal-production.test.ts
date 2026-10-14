import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture } from '../management/helpers.js';
import { deepseekFlashModel } from '../../providers/text-protocol.js';
import { credentialRegistry } from '../../management/credentials.js';
import { defaultProjectTerminalConfiguration, projectTerminalRuntimeRegistration } from '../../management/project-terminal-configuration.js';
import { freezeProjectTerminalRequests } from '../../management/project-terminal-request-review.js';
import { createDeepSeekProjectTerminalTransport } from '../../management/project-terminal-deepseek-transport.js';
import { assertProjectTerminalRetrySafe, createProjectTerminalModelCall, projectTerminalOperationId } from '../../management/project-terminal-processing.js';
import { EvaluationBudget } from '../../core/evaluation-budget.js';
import { SqliteProjectMemory } from '../../projects/project-memory-sqlite.js';
import { createProjectTerminalExtractor } from '../../projects/project-terminal-extractor.js';
import type { ProjectTerminalMaterial } from '../../contracts/project-memory.js';

const materialFor = (suffix: string): ProjectTerminalMaterial => ({ version: '0.1.0', source: 't3_thread_detail',
  evidence: { projectId: 'project-a', taskId: 'task-' + suffix, nativeTurnId: 'turn-' + suffix,
    terminalEventId: 'event-' + suffix, terminalPhase: 'completed',
    resultRef: `t3:environment:thread:message:answer-${suffix}`, occurredAt: '2026-09-28T00:00:00.000Z',
    extractionVersion: 'b54-t3-terminal-v1' },
  userMessages: [{ id: 'user-' + suffix, text: '只回复测试标记。' }],
  assistantMessage: { id: 'answer-' + suffix, text: 'OK' } });

test('default-off preparation freezes exact jobs; explicit isolated processing sends exactly the reviewed bodies once', async t => {
  const f = await fixture(t), external = await mkdtemp(join(tmpdir(), 'terminal-production-key-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const key = join(external, 'synthetic.key'); await writeFile(key, 'fake-key-for-capture-only', { mode: 0o600 });
  const base = { ...f.c, budgetMode: 'unlimited' as const, limitMicros: null,
    models: { ...f.c.models, summary: deepseekFlashModel(key) } };
  const oldLedger = JSON.parse(await readFile(base.budgetFile, 'utf8'));
  oldLedger.limitMicros = null; oldLedger.budgetMode = 'unlimited';
  await writeFile(base.budgetFile, JSON.stringify(oldLedger));
  const originalLedger = await readFile(base.budgetFile);
  const disabled = defaultProjectTerminalConfiguration(credentialRegistry(base).ref(key, 'deepseek'));
  const materials = [materialFor('1'), materialFor('2')];
  const port = { async readTerminalMaterial(e: ProjectTerminalMaterial['evidence']) {
    return materials.find(m => m.evidence.taskId === e.taskId)!;
  } };
  const file = join(base.projectRoot, 'project-memory.sqlite');
  const queue = new SqliteProjectMemory(file, { autoProcess: false });
  for (const m of materials) await queue.enqueueTerminal(m.evidence);
  const jobs = await queue.listJobs('project-a');
  const review = await freezeProjectTerminalRequests(disabled, jobs, port);
  assert.equal(review.prospectiveRequests, 2);
  assert.deepEqual(await queue.listJobs('project-a'), jobs);
  assert.deepEqual(await readFile(base.budgetFile), originalLedger);
  assert.equal(projectTerminalRuntimeRegistration(base, disabled), undefined);
  await assert.rejects(freezeProjectTerminalRequests({ ...disabled, enabled: true }, jobs, port));
  await assert.rejects(freezeProjectTerminalRequests(disabled, jobs.map(j => ({ ...j, attempts: 1 })), port));
  await assert.rejects(freezeProjectTerminalRequests(disabled, jobs, {
    async readTerminalMaterial() { return { ...materials[0]!, evidence: materials[1]!.evidence }; },
  }));
  await queue.close();
  const sent: string[] = [];
  const transport = createDeepSeekProjectTerminalTransport(async (_url, init) => {
    sent.push(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"outcome":"no_change"}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8 } }), { status: 200 });
  });
  const registration = projectTerminalRuntimeRegistration(base, { ...disabled, enabled: true }, transport)!;
  assert.equal(sent.length, 0);
  const budget = new EvaluationBudget(base.budgetFile, base.budgetBatchId, base.limitMicros);
  const options = { autoProcess: false, extractor: (e: ProjectTerminalMaterial['evidence'], attempt: number) => {
    const call = createProjectTerminalModelCall(base, registration.selection, registration.transport, budget, attempt)!;
    return createProjectTerminalExtractor(port, registration.createDeriver(call))(e);
  }, retryGate: (job: typeof jobs[number], next: number) => assertProjectTerminalRetrySafe(budget, job.evidence, next) };
  const running = new SqliteProjectMemory(file, options);
  assert.equal(await running.runPending(), 2);
  assert.deepEqual(sent.sort(), review.requests.map(r => r.bodyJson).sort());
  assert.ok(sent.every(s => JSON.parse(s).max_tokens === 1024));
  for (const m of materials) assert.equal((await running.enqueueTerminal(m.evidence)).state, 'already_queued');
  assert.equal(await running.runPending(), 0); assert.equal(sent.length, 2);
  assert.deepEqual(await running.list({ projectId: 'project-a', limit: 10 }), []);
  await running.close();
  const reopened = new SqliteProjectMemory(file, options); t.after(() => reopened.close());
  await reopened.recoverInterruptedJobs(); assert.equal(await reopened.runPending(), 0);
  assert.equal(sent.length, 2);
  const ledger = JSON.parse(await readFile(base.budgetFile, 'utf8'));
  assert.deepEqual(ledger.entries.slice(0, oldLedger.entries.length), oldLedger.entries);
  assert.equal(ledger.limitMicros, null); assert.equal(ledger.entries.length, oldLedger.entries.length + 2);
});

test('truncated and unknown transport results fail without memory; interruption and unknown accounting cannot auto-resend', async t => {
  const f = await fixture(t), external = await mkdtemp(join(tmpdir(), 'terminal-failure-key-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  const key = join(external, 'synthetic.key'); await writeFile(key, 'fake-only', { mode: 0o600 });
  const base = { ...f.c, models: { ...f.c.models, summary: deepseekFlashModel(key) } };
  const config = { ...defaultProjectTerminalConfiguration(credentialRegistry(base).ref(key, 'deepseek')), enabled: true };
  const materials = [materialFor('truncated'), materialFor('unknown')], calls: string[] = [];
  const registration = projectTerminalRuntimeRegistration(base, config, createDeepSeekProjectTerminalTransport(async (_url, init) => {
    const body = String(init?.body); calls.push(body);
    if (body.includes('answer-unknown')) throw Error('synthetic network result unknown');
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"outcome":"no_change"}' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 10, completion_tokens: 8 } }), { status: 200 });
  }))!;
  const file = join(base.projectRoot, 'memory.sqlite'), budget = new EvaluationBudget(base.budgetFile, base.budgetBatchId, base.limitMicros);
  const options = { autoProcess: false, extractor: (e: ProjectTerminalMaterial['evidence'], attempt: number) =>
    createProjectTerminalExtractor({ async readTerminalMaterial() { return materials.find(m => m.evidence.taskId === e.taskId)!; } },
      registration.createDeriver(createProjectTerminalModelCall(base, registration.selection, registration.transport, budget, attempt)!))(e),
    retryGate: (job: { evidence: ProjectTerminalMaterial['evidence'] }, next: number) => assertProjectTerminalRetrySafe(budget, job.evidence, next) };
  const queue = new SqliteProjectMemory(file, options);
  for (const m of materials) await queue.enqueueTerminal(m.evidence);
  await queue.runPending(); assert.equal(calls.length, 2);
  const jobs = await queue.listJobs('project-a'); assert.ok(jobs.every(j => j.state === 'failed' && j.attempts === 1));
  assert.deepEqual(await queue.list({ projectId: 'project-a', limit: 10 }), []);
  const unknown = jobs.find(j => j.evidence.taskId === 'task-unknown')!;
  await assert.rejects(queue.retryJob('project-a', unknown.id));
  assert.equal(await queue.runPending(), 0); await queue.close();
  const db = new Database(file); db.prepare("UPDATE project_memory_jobs SET state='running' WHERE id=?").run(unknown.id); db.close();
  const recovered = new SqliteProjectMemory(file, options); t.after(() => recovered.close());
  await recovered.recoverInterruptedJobs(); assert.equal((await recovered.getJob('project-a', unknown.id))?.errorCode, 'interrupted');
  await assert.rejects(recovered.retryJob('project-a', unknown.id));
  assert.equal(await recovered.runPending(), 0); assert.equal(calls.length, 2);
  const ledger = JSON.parse(await readFile(base.budgetFile, 'utf8'));
  assert.deepEqual(ledger.entries[0], f.historical);
  assert.equal(ledger.entries.find((entry: { operationId: string }) =>
    entry.operationId === projectTerminalOperationId(unknown.evidence, 1)).status, 'unknown');
});
