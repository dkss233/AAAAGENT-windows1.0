import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { restrictPrivatePathSync } from '../../../core/platform-files.js';
import { readWorkbenchTurnAuthorization, reloadingWorkbenchTurnAuthorization, workbenchInputDigest } from '../../../app/workbench-runtime.js';
import type { WorkbenchContinuationDraft } from '../../../contracts/workbench.js';
import type { ExistingCodexContinuationAuthorization } from '../../../contracts/workbench-runtime.js';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aaa-existing-codex-policy-'));
  const directory = join(root, '.local/data'); mkdirSync(directory, { recursive: true });
  const file = join(directory, 'workbench-execution.json');
  const task = { id: 'bound-task-c', projectId: 'isolated-aaa-project', origin: 't3' as const, provider: 'codex' as const,
    environmentId: randomUUID(), t3ProjectId: 'b54-independent-blackboard-20261001',
    threadId: 'b54-independent-coordinator-20261001', providerInstanceId: 'codex' };
  const input = { inputId: randomUUID(), rawText: 'Read the existing two reports.', dispatchText: 'Read the existing two reports.',
    origin: { channel: 'desktop' as const, channelSessionId: 'desktop-workbench', messageId: randomUUID() }, createdAt: new Date().toISOString() };
  const draft = { id: randomUUID(), commandId: randomUUID(), version: 1, task, input } as WorkbenchContinuationDraft;
  const policy: ExistingCodexContinuationAuthorization = { version: 1, kind: 'single-codex-existing-thread', draftId: draft.id,
    draftVersion: 1, commandId: draft.commandId, task, inputSha256: workbenchInputDigest(input), modelId: 'gpt-6-astra',
    expiresAt: new Date(Date.now() + 60000).toISOString(), authType: 'chatgpt', maxTurns: 1, automaticRetries: 0,
    expectedLatestTurnId: randomUUID(), runtimeMode: 'auto-accept-edits', interactionMode: 'default', reasoningEffort: 'low' };
  const native = { id: task.threadId, projectId: task.t3ProjectId,
    modelSelection: { instanceId: 'codex', model: 'gpt-6-astra', options: [{ id: 'reasoningEffort', value: 'low' }] },
    runtimeMode: 'auto-accept-edits', interactionMode: 'default', latestTurn: { turnId: policy.expectedLatestTurnId, state: 'completed' } };
  writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  restrictPrivatePathSync(file);
  return { root, file, draft, policy, native, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
test('existing-thread admission pins exact draft, text, scope, model, modes and completed original turn', () => {
  const f = fixture();
  try {
    const authorization = readWorkbenchTurnAuthorization(f.root); assert(authorization);
    assert.equal(authorization.allows(f.draft, f.native), true);
    assert.equal(authorization.allows({ ...f.draft, commandId: randomUUID() }, f.native), false);
    assert.equal(authorization.allows({ ...f.draft, input: { ...f.draft.input, dispatchText: 'changed' } }, f.native), false);
    assert.equal(authorization.allows(f.draft, { ...f.native, projectId: 'another' }), false);
    assert.equal(authorization.allows(f.draft, { ...f.native, runtimeMode: 'full-access' }), false);
    assert.equal(authorization.allows(f.draft, { ...f.native, modelSelection: { ...f.native.modelSelection, options: [{ id: 'reasoningEffort', value: 'high' }] } }), false);
    assert.equal(authorization.allows(f.draft, { ...f.native, latestTurn: { ...f.native.latestTurn, state: 'running' } }), false);
    assert.equal(authorization.allows(f.draft, { ...f.native, latestTurn: { ...f.native.latestTurn, turnId: randomUUID() } }), false);
    writeFileSync(f.file, JSON.stringify({ ...f.policy, expectedLatestTurnId: randomUUID() }));
    assert.equal(authorization.available(), false); assert.equal(authorization.allows(f.draft, f.native), false);
  } finally { f.cleanup(); }
});
test('missing, expired and public policy cannot enable existing-thread dispatch', () => {
  const f = fixture();
  try {
    assert.equal(readWorkbenchTurnAuthorization(f.root, () => Date.parse(f.policy.expiresAt)), undefined);
    if (process.platform === 'win32') execFileSync('icacls.exe', [f.file, '/grant', '*S-1-1-0:(R)'], { windowsHide: true, stdio: 'pipe' });
    else chmodSync(f.file, 0o644);
    assert.equal(readWorkbenchTurnAuthorization(f.root), undefined);
    rmSync(f.file); assert.equal(readWorkbenchTurnAuthorization(f.root), undefined);
  } finally { f.cleanup(); }
});
test('a running isolated bridge admits only the newly reviewed card and immediately observes revocation', () => {
  const f = fixture();
  try {
    rmSync(f.file); const live = reloadingWorkbenchTurnAuthorization(f.root);
    assert.equal(live.available(), false); assert.equal(live.allows(f.draft, f.native), false);
    writeFileSync(f.file, JSON.stringify(f.policy), { mode: 0o600 });
    restrictPrivatePathSync(f.file);
    assert.equal(live.allows(f.draft, f.native), true);
    const next = { ...f.draft, id: randomUUID(), commandId: randomUUID() };
    writeFileSync(f.file, JSON.stringify({ ...f.policy, draftId: next.id, commandId: next.commandId }));
    assert.equal(live.allows(f.draft, f.native), false); assert.equal(live.allows(next, f.native), true);
    rmSync(f.file); assert.equal(live.available(), false); assert.equal(live.allows(next, f.native), false);
  } finally { f.cleanup(); }
});
test('legacy single-empty-thread authorization remains restricted to its original UUID and null-history rule', () => {
  const f = fixture();
  try {
    const task = { ...f.draft.task, id: randomUUID(), projectId: randomUUID(), t3ProjectId: randomUUID(), threadId: randomUUID() };
    const draft = { ...f.draft, task };
    const policy = { ...f.policy, kind: 'single-codex-continuation', task };
    writeFileSync(f.file, JSON.stringify(policy)); const authorization = readWorkbenchTurnAuthorization(f.root); assert(authorization);
    const native = { ...f.native, id: task.threadId, projectId: task.t3ProjectId, runtimeMode: 'approval-required', latestTurn: null };
    assert.equal(authorization.allows(draft, native), true);
    assert.equal(authorization.allows(draft, { ...native, latestTurn: f.native.latestTurn }), false);
    assert.equal(authorization.allows(draft, { ...native, runtimeMode: 'auto-accept-edits' }), false);
  } finally { f.cleanup(); }
});
