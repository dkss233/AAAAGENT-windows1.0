import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { T3LocalService } from '../../t3-local-service.mjs';
import { T3HttpClient } from '../../t3-http-client.mjs';

const [sourceArgument, evidenceArgument, nodeArgument, distArgument] = process.argv.slice(2);
if (!sourceArgument || !evidenceArgument || !nodeArgument || !distArgument) {
  throw Error('Usage: aaa-t3-pipeline.mjs <isolated prepared source> <evidence dir> <Node 24> <AAA dist>');
}
const sourceDir = resolve(sourceArgument), evidenceDir = resolve(evidenceArgument);
const nodeExecutable = resolve(nodeArgument), desktopDist = resolve(distArgument);
const nonce = randomUUID();
const runDir = join(evidenceDir, `pipeline-run-${nonce}`);
const syntheticRoot = join(runDir, 'synthetic-project');
const isolatedHome = join(runDir, 'isolated-home');
const t3Home = join(runDir, 't3-home');
const fakeBin = join(runDir, 'fake-bin');
for (const path of [syntheticRoot, isolatedHome, fakeBin, join(t3Home, 'userdata')]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
execFileSync('/usr/bin/git', ['init', '-q'], { cwd: syntheticRoot });
const fakePeer = resolve(import.meta.dirname, 'fake-codex-app-server.mjs');
const wrapper = join(fakeBin, 'codex');
writeFileSync(wrapper, `#!/bin/sh\nexec "${nodeExecutable}" "${fakePeer}" "$@"\n`, { mode: 0o700 });
chmodSync(wrapper, 0o700);
const codexHome = join(isolatedHome, '.codex');
mkdirSync(codexHome, { recursive: true, mode: 0o700 });
writeFileSync(join(t3Home, 'userdata/settings.json'), JSON.stringify({
  projectSettingsFolded: true,
  providers: { codex: { enabled: true, binaryPath: wrapper, homePath: codexHome },
    claudeAgent: { enabled: false }, cursor: { enabled: false }, grok: { enabled: false },
    opencode: { enabled: false }, antigravity: { enabled: false } },
}, null, 2) + '\n', { mode: 0o600 });

const captureFile = join(runDir, 'fake-provider-requests.jsonl');
const keys = ['HOME', 'CODEX_HOME', 'PATH', 'T3_P1_FIXTURE', 'T3_P1_CAPTURE'];
const oldEnvironment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
Object.assign(process.env, { HOME: isolatedHome, CODEX_HOME: codexHome,
  PATH: `${fakeBin}:${dirname(nodeExecutable)}:/usr/bin:/bin`,
  T3_P1_FIXTURE: join(sourceDir, 'apps/server/src/provider/testFixtures/codexMultiAgentWire.json'),
  T3_P1_CAPTURE: captureFile });

const { SqliteProjectIndex } = await import(join(desktopDist, 'projects/sqlite-project-index.js'));
const { SqliteWorkbenchStore } = await import(join(desktopDist, 'app/workbench-store.js'));
const { WorkbenchService } = await import(join(desktopDist, 'app/workbench-service.js'));
const { prepareProjectProviderContext } = await import(join(desktopDist, 'workbench/project-provider-context.js'));
const { signProviderContextFreeze } = await import(join(desktopDist, 'workbench/project-provider-context-proof.js'));
const { default: Database } = await import(join(desktopDist, 'node_modules/better-sqlite3/lib/index.js'));

const newService = () => new T3LocalService({ sourceDir, nodeExecutable,
  baseDir: t3Home, logFile: join(runDir, 't3.log') });
let nativeService = newService(), t3 = new T3HttpClient(nativeService);
let index, store;
const nativeProjectId = `project-${nonce}`, threadId = `thread-${nonce}`;
const result = { version: 'B54-P1-no-model', sourceDir, desktopDist, runDir,
  nativeProjectId, threadId, checks: [], fakeProvider: true, realModelRequests: 0 };
const capture = () => existsSync(captureFile) ? readFileSync(captureFile, 'utf8').trim().split('\n')
  .filter(Boolean).map(line => JSON.parse(line)) : [];
const turns = () => capture().filter(item => item.method === 'turn/start');
function eventCount(commandId) {
  const database = new Database(join(t3Home, 'userdata/state.sqlite'),
    { readonly: true, fileMustExist: true });
  try {
    return database.prepare('SELECT count(*) AS total FROM orchestration_events WHERE command_id = ?')
      .get(commandId).total;
  } finally { database.close(); }
}
function turnStartEvent(commandId) {
  const database = new Database(join(t3Home, 'userdata/state.sqlite'),
    { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare(`SELECT payload_json FROM orchestration_events
      WHERE command_id = ? AND event_type = 'thread.turn-start-requested' LIMIT 1`).get(commandId);
    return row ? JSON.parse(row.payload_json) : null;
  } finally { database.close(); }
}
async function until(predicate, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Timed out waiting for fake provider observation');
}
const input = (text, tag) => ({ inputId: `input-${tag}-${nonce}`,
  origin: { channel: 'web', channelSessionId: 'p1-test-web', messageId: `message-${tag}-${nonce}` },
  rawText: `Synthetic original ${tag}`, dispatchText: text, createdAt: new Date().toISOString() });
try {
  const firstConnection = await nativeService.start();
  const unauthorized = await fetch(firstConnection.origin + '/api/orchestration/shell',
    { signal: AbortSignal.timeout(5000) });
  assert.equal(unauthorized.status, 401);
  const descriptor = await t3.environmentDescriptor();
  assert.ok(descriptor.environmentId);
  result.checks.push('real loopback HTTP requires token; bootstrap exchange allows protected read');
  const catalog = await t3.providerModels();
  const selected = catalog.providers.find(item => item.instanceId === 'codex');
  assert.equal(selected?.status, 'ready');
  assert.equal(selected?.authStatus, 'authenticated');
  assert.deepEqual(selected?.models, [{ id: 'synthetic-only', name: 'Synthetic Only' }]);
  result.checks.push('T3 process uses only explicit synthetic Codex peer and model catalog');

  const projectReceiptId = `project-create-${nonce}`;
  const threadReceiptId = `thread-create-${nonce}`;
  await t3.createCommand({ type: 'project.create', commandId: projectReceiptId,
    projectId: nativeProjectId, title: 'P1 isolated synthetic', workspaceRoot: syntheticRoot,
    createdAt: new Date().toISOString() });
  await t3.createCommand({ type: 'thread.create', commandId: threadReceiptId,
    threadId, projectId: nativeProjectId, title: 'P1 fake provider',
    modelSelection: { instanceId: 'codex', model: 'synthetic-only' },
    runtimeMode: 'approval-required', interactionMode: 'default',
    branch: null, worktreePath: null, createdAt: new Date().toISOString() });
  assert.equal((await t3.readReceipt(threadReceiptId))?.status, 'accepted');
  result.checks.push('protected HTTP created synthetic native project and thread once');

  index = new SqliteProjectIndex(join(runDir, 'project-index.sqlite'));
  const project = await index.save({ expectedVersion: 0, name: 'P1 synthetic', abstract: '',
    detailRef: { rootPath: syntheticRoot } });
  store = new SqliteWorkbenchStore(join(runDir, 'workbench.sqlite'));
  const ordinary = new WorkbenchService(index, store, t3, true);
  await ordinary.bindProject(project.id, nativeProjectId, syntheticRoot);
  const task = await ordinary.bindTask(project.id, nativeProjectId, threadId, 'codex');
  const normal = await ordinary.prepareContinuation(task.id, input('P1 ordinary turn', 'ordinary'));
  const plainResult = await ordinary.confirmContinuation(normal.id, normal.version, 'web', 'p1-test-web');
  assert.equal(plainResult.state, 'accepted');
  await until(() => turns().length >= 1);
  result.checks.push('AAA confirmed ordinary draft traversed authenticated HTTP and real T3 Reactor to fake provider');
  await until(async () => {
    const shell = await t3.shellSnapshot();
    return shell.threads.find(item => item.id === threadId)?.latestTurn?.state === 'completed';
  });

  const memory = { id: `memory-${nonce}`, projectId: project.id, kind: 'decision',
    status: 'accepted', version: 1, text: 'Keep the synthetic P1 retry limit.',
    sources: [{ taskId: task.id, recordedAt: new Date().toISOString() }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const preparedContext = { async prepare({ binding, durableMessageText }) {
    return prepareProjectProviderContext({ binding, durableMessageText, memories: [memory] },
      { async verify() { return 'fits'; } }); // Test-only capacity decision; no production preflight.
  } };

  const invalidId = `bad-proof-${nonce}`, invalidMessageId = `bad-message-${nonce}`;
  const invalidSnapshot = await t3.threadSnapshot(threadId);
  const badBinding = { projectId: project.id, taskId: task.id,
    environmentId: (await t3.environmentDescriptor()).environmentId,
    threadId, providerInstanceId: 'codex', modelId: 'synthetic-only',
    branchRef: null, snapshotSequence: invalidSnapshot.snapshotSequence,
    commandId: invalidId, draftId: `bad-draft-${nonce}`, draftVersion: 1, messageId: invalidMessageId };
  const badFreeze = await prepareProjectProviderContext({
    binding: badBinding, durableMessageText: 'P1 bad proof must never reach provider', memories: [memory],
  }, { async verify() { return 'fits'; } });
  assert.equal(badFreeze.status, 'ready');
  const goodProof = await signProviderContextFreeze(badFreeze, nativeProjectId, nativeService);
  const badCommand = { type: 'thread.turn.start', commandId: invalidId, threadId,
    message: { messageId: invalidMessageId, role: 'user',
      text: badFreeze.durableMessageText, attachments: [] },
    runtimeMode: 'approval-required', interactionMode: 'default',
    providerOnlyProjectContext: { version: 1, commandId: invalidId, messageId: invalidMessageId,
      threadId, t3ProjectId: nativeProjectId, providerInstanceId: 'codex', modelId: 'synthetic-only',
      branchRef: null, snapshotSequence: invalidSnapshot.snapshotSequence,
      draftId: badBinding.draftId, draftVersion: 1, fingerprint: badFreeze.fingerprint,
      context: { version: 1, records: badFreeze.records },
      proof: { ...goodProof, mac: '0'.repeat(64) } },
    createdAt: new Date().toISOString() };
  const turnsBeforeBadProof = turns().length;
  await assert.rejects(t3.dispatch(badCommand));
  assert.equal(await t3.readReceipt(invalidId), null);
  assert.equal(eventCount(invalidId), 0);
  assert.equal(turns().length, turnsBeforeBadProof);
  result.checks.push('wrong private context proof rejected before native command receipt and provider turn');

  const withMemory = new WorkbenchService(index, store, t3, true,
    undefined, undefined, preparedContext, nativeService);
  const memoryDraft = await withMemory.prepareContinuation(task.id, input('P1 valid memory turn', 'memory'));
  const memoryResult = await withMemory.confirmContinuation(memoryDraft.id, 1, 'web', 'p1-test-web');
  result.memoryResult = memoryResult;
  assert.equal(memoryResult.state, 'accepted');
  await until(() => turns().length >= turnsBeforeBadProof + 1);
  const freeze = store.readProviderContextFreeze(memoryDraft.commandId);
  assert.equal(freeze?.records[0]?.payload.text, memory.text);
  const ordinaryInput = turns()[0]?.params?.input?.[0]?.text;
  const memoryInput = turns()[1]?.params?.input?.[0]?.text;
  assert.equal(ordinaryInput, 'P1 ordinary turn');
  assert.equal(typeof memoryInput, 'string');
  assert.equal(memoryInput.split(memory.text).length - 1, 1);
  assert.ok(memoryInput.includes('<context kind="project-memory"'));
  assert.ok(memoryInput.startsWith('P1 valid memory turn'));
  result.providerInput = { ordinaryExact: ordinaryInput === 'P1 ordinary turn',
    memoryOccurrences: memoryInput.split(memory.text).length - 1,
    memoryTurnContainsContextRecord: memoryInput.includes('<context kind="project-memory"') };
  result.checks.push('AAA frozen accepted memory with private proof and sent one provider-only context turn');

  let droppedCommandId, dispatchAttempts = 0, hideReceipt = true;
  const lostTransport = async (url, options) => {
    if (String(url).endsWith('/api/orchestration/dispatch') &&
      JSON.parse(options.body).commandId === droppedCommandId) {
      dispatchAttempts++;
      const response = await fetch(url, options);
      assert.equal(response.status, 200);
      throw Error('synthetic response lost after native acceptance');
    }
    if (hideReceipt && droppedCommandId &&
      String(url).includes(`/api/orchestration/commands/${encodeURIComponent(droppedCommandId)}/receipt`)) {
      throw Error('synthetic temporary receipt outage');
    }
    return fetch(url, options);
  };
  const uncertainClient = new T3HttpClient(nativeService, { transport: lostTransport });
  const uncertainService = new WorkbenchService(index, store, uncertainClient, true);
  const uncertain = await uncertainService.prepareContinuation(task.id, input('P1 lost response turn', 'unknown'));
  droppedCommandId = uncertain.commandId;
  const unknown = await uncertainService.confirmContinuation(uncertain.id, 1, 'web', 'p1-test-web');
  assert.equal(unknown.state, 'unknown');
  assert.equal((await uncertainService.confirmContinuation(uncertain.id, 1, 'web', 'p1-test-web')).state, 'unknown');
  assert.equal(dispatchAttempts, 1);
  assert.equal((await t3.readReceipt(droppedCommandId))?.status, 'accepted');
  await until(() => turns().some(item => item.params?.input?.[0]?.text === 'P1 lost response turn'));
  result.checks.push('lost HTTP response and receipt outage kept AAA command unknown with exactly one POST');

  const turnsBeforeRestart = turns().length;
  await nativeService.stop();
  store.close(); store = new SqliteWorkbenchStore(join(runDir, 'workbench.sqlite'));
  nativeService = newService(); t3 = new T3HttpClient(nativeService);
  const secondConnection = await nativeService.start();
  assert.notEqual(secondConnection.accessToken, firstConnection.accessToken);
  assert.equal((await t3.readReceipt(memoryDraft.commandId))?.status, 'accepted');
  const afterRestart = await t3.threadSnapshot(threadId);
  const durableMemoryMessage = afterRestart.thread.messages.find(item =>
    item.id === memoryDraft.input.inputId);
  assert.equal(durableMemoryMessage?.text, 'P1 valid memory turn');
  assert.equal(turnStartEvent(memoryDraft.commandId)?.providerOnlyProjectContext?.context?.records?.[0]
    ?.payload?.text, memory.text);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(turns().length, turnsBeforeRestart);
  hideReceipt = false;
  const reopened = new WorkbenchService(index, store, t3, true);
  const recovered = await reopened.readContinuation(uncertain.id, 'web', 'p1-test-web');
  assert.equal(recovered.state, 'accepted');
  assert.equal(dispatchAttempts, 1);
  assert.equal(turns().length, turnsBeforeRestart);
  assert.ok(eventCount(memoryDraft.commandId) > 0);
  result.checks.push('new AAA store and T3 child cold-read same ID after key rotation; no replay');
  result.checks.push('old accepted provider-only event and its context remain readable after key rotation');
  result.dispatchAttemptsForUnknown = dispatchAttempts;
  result.accessTokenChanged = firstConnection.accessToken !== secondConnection.accessToken;
  result.nativeEventCounts = { badProof: eventCount(invalidId),
    memory: eventCount(memoryDraft.commandId), unknown: eventCount(droppedCommandId) };
  result.status = 'passed';
  result.logicalProjectId = project.id;
  result.taskId = task.id;
  result.commandIds = { normal: normal.commandId, badProof: invalidId,
    memory: memoryDraft.commandId, unknown: droppedCommandId };
  result.fakeProviderTurnCount = turns().length;
} catch (error) {
  result.status = 'failed';
  result.error = String(error);
  throw error;
} finally {
  await nativeService.stop();
  store?.close();
  await index?.close();
  for (const [key, value] of Object.entries(oldEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  writeFileSync(join(evidenceDir, 'aaa-t3-pipeline.json'), JSON.stringify(result, null, 2) + '\n',
    { mode: 0o600 });
}
