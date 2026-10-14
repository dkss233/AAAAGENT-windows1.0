import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fixture } from '../management/helpers.js';
import type { ProjectEntry, ProjectIndexPort } from '../../contracts/projects.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';
import type { SingleDshContinuationAuthorization } from '../../contracts/workbench-runtime.js';
import { readWorkbenchTurnAuthorization, workbenchInputDigest } from '../../app/workbench-runtime.js';
import { SqliteWorkbenchStore } from '../../app/workbench-store.js';
import { WorkbenchService, type T3WorkbenchClient } from '../../app/workbench-service.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';

const model = 'deepseek-official/deepseek-flash';
const json = (file: string, value: unknown) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); chmodSync(file, 0o600); };

test('DSH real HTTP/SQLite creation preserves exact model effort across lost reply and cold recovery without a model turn', async t => {
  const f = await fixture(t), at = new Date().toISOString();
  const project: ProjectEntry = { id: randomUUID(), name: 'DSH fixture', abstract: '', detailRef: { rootPath: f.c.projectRoot }, version: 1, updatedAt: at };
  const projects: ProjectIndexPort = { async get(id) { return id === project.id ? project : null; }, async list() { throw Error('unexpected'); },
    async save() { throw Error('unexpected'); }, async remove() { throw Error('unexpected'); }, async close() {} };
  const environmentId = randomUUID(), nativeProjects: { id: string; workspaceRoot: string }[] = [],
    threads: { id: string; projectId: string; modelSelection: { instanceId: string }; latestTurn: null }[] = [];
  const receipts = new Map<string, { status: 'accepted'; aggregateKind: 'project' | 'thread'; aggregateId: string; resultSequence: number }>();
  const creates: string[] = []; let turnSends = 0;
  const native: T3WorkbenchClient = {
    async environmentDescriptor() { return { environmentId }; },
    async shellSnapshot() { return { snapshotSequence: creates.length, updatedAt: at, projects: nativeProjects, threads }; },
    async threadSnapshot() { throw Error('unexpected detail'); },
    async providerModels(instance) { assert.equal(instance, 'dsh'); return { providers: [{ instanceId: 'dsh', driver: 'dsh',
      enabled: true, installed: true, status: 'ready', authStatus: 'authenticated', checkedAt: at,
      models: [{ id: model, name: 'Native Flash', reasoningEfforts: [{ id: 'high', name: 'High' }], defaultReasoningEffort: 'high' }] }] }; },
    async dispatch() { turnSends++; throw Error('unexpected model'); },
    async readReceipt(id) { return receipts.get(id) ?? null; },
    async createCommand(command) {
      creates.push(command.type);
      if (command.type === 'project.create') {
        nativeProjects.push({ id: command.projectId, workspaceRoot: f.c.projectRoot });
        receipts.set(command.commandId, { status: 'accepted', aggregateKind: 'project', aggregateId: command.projectId, resultSequence: 1 });
      } else {
        assert.deepEqual(command.modelSelection, { instanceId: 'dsh', model, options: [{ id: 'reasoningEffort', value: 'high' }] });
        threads.push({ id: String(command.threadId), projectId: command.projectId, modelSelection: { instanceId: 'dsh' }, latestTurn: null });
      }
      throw Error('reply lost');
    },
  };
  const filename = join(f.c.projectRoot, 'data/desktop-pet/workbench.sqlite');
  let store = new SqliteWorkbenchStore(filename), service = new WorkbenchService(projects, store, native);
  const settings = await ManagementSettingsStore.open(join(f.c.projectRoot, 'settings.json'), f.c), runtime = new ManagementRuntime(f.c.sourceRevision);
  const memory: ManagementMemoryPort = { characters: () => [], list() { throw Error('unexpected'); }, edit() { throw Error('unexpected'); },
    context() { throw Error('unexpected'); }, prompt() { throw Error('unexpected'); }, savePrompt() { throw Error('unexpected'); } };
  const start = () => startManagementServer({ uiRoot: resolve(import.meta.dirname, '../../../management/ui'), settings, memory, projects, workbench: service,
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: [], events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: [] }) });
  let server = await start(); t.after(async () => { await server.close(); store.close(); });
  const request = { operationId: randomUUID(), projectId: project.id, title: 'Synthetic DSH empty task', provider: 'dsh', modelSelection: { instanceId: 'dsh', model, reasoningEffort: 'high' } };
  const call = async (path: string, body?: unknown) => fetch(server.origin + path, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${server.token}`, Origin: server.origin, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const catalog = await (await call('/api/workbench/provider-models?provider=dsh')).json() as { provider: string; models: unknown[] };
  assert.equal(catalog.provider, 'dsh'); assert.equal(catalog.models.length, 1);
  assert.equal((await call('/api/workbench/tasks/create', { ...request, modelSelection: { instanceId: 'dsh', model } })).status, 400);
  assert.equal((await call('/api/workbench/tasks/create', { ...request, modelSelection: { ...request.modelSelection, reasoningEffort: 'unlisted' } })).status, 400);
  assert.deepEqual(creates, []);
  assert.deepEqual(await (await call('/api/workbench/tasks/create', request)).json(), { operationId: request.operationId, state: 'unknown', stage: 'thread' });
  const intent = store.getNativeCreate(request.operationId)!;
  await server.close(); store.close(); store = new SqliteWorkbenchStore(filename); service = new WorkbenchService(projects, store, native); server = await start();
  const recovery = await (await call('/api/workbench/tasks/creations?projectId=' + project.id)).json() as { creations: { request: unknown }[] };
  assert.deepEqual(recovery.creations[0]?.request, request);
  assert.deepEqual(creates, ['project.create', 'thread.create']);
  receipts.set(intent.threadCommandId, { status: 'accepted', aggregateKind: 'thread', aggregateId: intent.threadId, resultSequence: 2 });
  const accepted = await (await call('/api/workbench/tasks/create', request)).json() as { state: string; task: { threadId: string; provider: string } };
  assert.equal(accepted.state, 'accepted'); assert.equal(accepted.task.threadId, intent.threadId); assert.equal(accepted.task.provider, 'dsh');
  assert.equal((await call('/api/workbench/tasks/create', { ...request, modelSelection: { ...request.modelSelection, reasoningEffort: 'off' } })).status, 409);
  assert.deepEqual(creates, ['project.create', 'thread.create']); assert.equal(turnSends, 0);
});

test('DSH admission checks the existing unlimited policy, exact frozen configuration and native effort before dispatch', async t => {
  const f = await fixture(t), at = new Date().toISOString();
  const task = { id: randomUUID(), projectId: randomUUID(), provider: 'dsh' as const, origin: 't3' as const,
    environmentId: randomUUID(), t3ProjectId: randomUUID(), threadId: randomUUID(), providerInstanceId: 'dsh' };
  const draft = { id: randomUUID(), version: 1, commandId: randomUUID(), task, state: 'open' as const,
    input: { inputId: randomUUID(), rawText: 'Synthetic', dispatchText: 'Synthetic', createdAt: at,
      origin: { channel: 'web' as const, channelSessionId: 'fixture', messageId: randomUUID() } } };
  const native = { id: task.threadId, projectId: task.t3ProjectId, modelSelection: { instanceId: 'dsh', model,
    options: [{ id: 'reasoningEffort', value: 'high' }] }, runtimeMode: 'approval-required', interactionMode: 'default', latestTurn: null };
  const configFile = join(f.c.projectRoot, 'artifacts/W0-I/model-evaluation/trial/user-trial/config.json');
  json(configFile, { ...f.c, budgetMode: 'unlimited', limitMicros: null });
  const configurationSha256 = createHash('sha256').update(readFileSync(configFile)).digest('hex');
  const activationFile = join(dirname(configFile), 'activation.json'); json(activationFile, { status: 'active', configSha256: configurationSha256 });
  // Historical blocked state does not impose a new global cap on the accepted unlimited policy.
  json(f.c.budgetFile, { batchId: f.c.budgetBatchId, currency: 'CNY', budgetMode: 'unlimited', limitMicros: null, blocked: true, entries: [f.historical] });
  const budgetBefore = readFileSync(f.c.budgetFile);
  const authorization: SingleDshContinuationAuthorization = { version: 1, kind: 'single-dsh-continuation', draftId: draft.id,
    draftVersion: 1, commandId: draft.commandId, task, inputSha256: workbenchInputDigest(draft.input), modelId: model,
    reasoningEffort: 'high', expiresAt: new Date(Date.now() + 60000).toISOString(), authType: 'native-deepseek-api',
    sourceRevision: f.c.sourceRevision, configurationSha256, budget: { batchId: f.c.budgetBatchId, mode: 'unlimited', limitMicros: null }, maxTurns: 1, automaticRetries: 0 };
  const file = join(f.c.projectRoot, 'data/desktop-pet/workbench-execution.json'); json(file, authorization);
  const gate = readWorkbenchTurnAuthorization(f.c.projectRoot)!; assert.ok(gate); assert.equal(gate.allows(draft, native), true);
  assert.equal(gate.allows(draft, { ...native, modelSelection: { ...native.modelSelection, options: [{ id: 'reasoningEffort', value: 'off' }] } }), false);
  assert.equal(gate.allows({ ...draft, task: { ...task, provider: 'codex', providerInstanceId: 'codex' } }, native), false);
  assert.deepEqual(readFileSync(f.c.budgetFile), budgetBefore);
  json(f.c.budgetFile, { batchId: 'different', currency: 'CNY', budgetMode: 'unlimited', limitMicros: null }); assert.equal(gate.available(), false);
  writeFileSync(f.c.budgetFile, budgetBefore); assert.equal(gate.available(), true);
  json(activationFile, { status: 'stopped', configSha256: configurationSha256 }); assert.equal(gate.available(), false);
  json(activationFile, { status: 'active', configSha256: configurationSha256 });
  json(file, { ...authorization, authType: 'chatgpt' }); assert.equal(readWorkbenchTurnAuthorization(f.c.projectRoot), undefined);
  json(file, authorization); json(configFile, { ...f.c, budgetMode: 'unlimited', limitMicros: null, sourceRevision: 'b'.repeat(40) });
  assert.equal(gate.available(), false); unlinkSync(file); assert.equal(gate.available(), false);
});
