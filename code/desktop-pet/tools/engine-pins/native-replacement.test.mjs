import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

// Exercise the actual reservation implementation with synthetic evidence and isolated writes.
const root = '/Users/example/AAAAGENT';
const ledgerPath = join(root, 'artifacts/W0-I/engine-pin-54/interoperability/ledger.json');
const operator = readFileSync(new URL('./interoperability.mjs', import.meta.url), 'utf8');
const code = operator.slice(operator.indexOf('function reserve('), operator.indexOf("if(action==='inspect')"));
function fixture() {
  const nativeId = 'synthetic-native', threadId = 'synthetic-thread';
  const failure = Buffer.from(JSON.stringify({ nativeThreadId: nativeId, replayed: false,
    nativeContinuation: { followupColdRead: { newTurnObserved: false, nativeMarkerPresent: false } } }));
  const release = Buffer.from(JSON.stringify({ target: { nativeThreadId: nativeId }, modelCalls: 0,
    result: { after: { thread: { session: { status: 'stopped' } } } }, protection: {
      nativeCursorUnchanged: true, allOriginalMessagesUnchanged: true, otherT3ThreadTablesUnchanged: true } }));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const config = { runId: 'synthetic-run', source: 'synthetic-runtime', expiresAt: '2030-01-01T00:00:00Z',
    targets: { codex: { t3ThreadId: threadId } }, routes: { codex: { model: 'gpt-6-astra', reasoningEffort: 'low' } },
    codexNativeReplacement: { authorized: true, maxAttempts: 1, source: 'synthetic-runtime',
      expiresAt: '2030-01-01T00:00:00Z', autoRetry: false, t3ThreadId: threadId, nativeId,
      maxTotalAttempts: 6, maxActualProviderModelTurns: 4, marker: 'synthetic-new-marker', attemptId: 'synthetic-attempt',
      failureEvidence: 'fixture-failure.json', failureEvidenceSha256: hash(failure),
      releaseEvidence: 'fixture-release.json', releaseEvidenceSha256: hash(release) } };
  const base = { runId: config.runId, entries: [
    { executor: 'codex', origin: 't3', state: 'provider-start-failed' },
    { executor: 'dsh', origin: 't3', state: 'native-completed' },
    { executor: 'dsh', origin: 'native', state: 'native-completed' },
    { executor: 'codex', origin: 't3-replacement', state: 'native-completed' },
    { executor: 'codex', origin: 'native', state: 'native-app-send-rejected-active-writer', nativeId, replayed: false },
  ], remaining: 0, status: 'running', nativeSessionIds: { codex: nativeId } };
  const original = JSON.stringify(base); let current = structuredClone(base), writes = 0;
  const context = { root, config, ledgerPath, join, createHash, now: () => 'synthetic-test',
    Date: { now: () => Date.parse(config.expiresAt) - 1000, parse: Date.parse },
    readFileSync: file => file === ledgerPath ? JSON.stringify(current) :
      file === join(root, 'fixture-failure.json') ? failure : file === join(root, 'fixture-release.json') ? release :
        (() => { throw Error('Unexpected evidence read'); })(),
    writeLedger: value => { current = JSON.parse(JSON.stringify(value)); writes++; } };
  const reserve = runInNewContext(code + '\nreserve;', context);
  return { config, original, reserve, context, current: () => current, writes: () => writes };
}
test('one independent native reservation preserves all five entries and original zero remaining', () => {
  const f = fixture();
  const entry = f.reserve('codex', 'native-replacement', f.config.codexNativeReplacement.nativeId);
  assert.equal(entry.marker, f.config.codexNativeReplacement.marker);
  assert.equal(entry.attemptId, f.config.codexNativeReplacement.attemptId);
  assert.equal(f.current().entries.length, 6); assert.equal(f.current().remaining, 0);
  assert.equal(JSON.stringify({ ...f.current(), entries: f.current().entries.slice(0, 5) }), f.original);
  assert.throws(() => f.reserve('codex', 'native-replacement', f.config.codexNativeReplacement.nativeId));
  assert.equal(f.writes(), 1);
});
test('expired, changed model, native ID or evidence scopes cannot write a reservation', () => {
  for (const change of [f => f.context.Date.now = () => Date.parse(f.config.expiresAt),
    f => f.config.routes.codex.model = 'another-model',
    f => f.config.codexNativeReplacement.nativeId = 'another-native',
    f => f.config.codexNativeReplacement.failureEvidenceSha256 = 'bad',
    f => f.config.codexNativeReplacement.maxActualProviderModelTurns = 5]) {
    const f = fixture(); const originalNative = f.config.codexNativeReplacement.nativeId; change(f);
    assert.throws(() => f.reserve('codex', 'native-replacement', originalNative)); assert.equal(f.writes(), 0);
  }
});
