import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendSession, type BackendPorts } from '../../app/backend-session.js';
import type { BackendToDesktop } from '../../contracts/desktop-bridge.js';
import type { CompanionChatHistory } from '../../contracts/companion-chat-history.js';
import { MemoryMediaStore } from '../../media/store.js';
const originalScope = { characterId: 'companion', sessionId: 'old-session', turnId: 'old-turn', generation: 2 } as const;
const history: CompanionChatHistory = { version: '0.1.0', characterId: 'companion', status: 'ready', hasMore: false,
  rows: [{ characterId: 'companion', recordId: 'old-turn:user', recordVersion: 1, role: 'user',
    text: '已保存的原话', createdAt: '2026-10-02T05:00:00.000Z', logicalOrder: 1, sourceScope: originalScope }] };
function ports(read: BackendPorts['readCompanionHistory'], counts: { calls: number }, outputMode?: 'text'): BackendPorts {
  const unexpected = () => { counts.calls++; throw Error('History must not start a turn, memory write or device/model request'); };
  return { mediaStore: new MemoryMediaStore(), ...(read ? { readCompanionHistory: read } : {}),
    ...(outputMode ? { outputMode } : {}),
    perception: { async perceive() { return unexpected(); } }, dialogue: { async reply() { return unexpected(); } },
    tts: { async synthesize() { return unexpected(); } }, memory: {
      async append() { unexpected(); }, async context() { return unexpected(); }, async maintain() { return unexpected(); },
      maintenanceInput() { return unexpected(); },
    } };
}
test('native startup carries saved rows once, keeps the original scope separate from the new live session and makes no turn/device calls', async () => {
  const outgoing: BackendToDesktop[] = [], counts = { calls: 0 }; let reads = 0;
  const session = new BackendSession(ports(character => { assert.equal(character, 'companion'); reads++; return history; }, counts), m => outgoing.push(m), () => {});
  const ready = outgoing[0]; assert.ok(ready?.channel === 'backend_ready'); assert.deepEqual(ready.history, history);
  assert.notEqual(ready.sessionId, originalScope.sessionId); assert.equal(reads, 1); assert.equal(outgoing.length, 1);
  await session.close(); assert.equal(counts.calls, 0);
});
test('legacy capability omission and non-desktop text sessions do not expose desktop chat history', async () => {
  for (const textMode of [false, true]) {
    const outgoing: BackendToDesktop[] = [], counts = { calls: 0 }; let reads = 0;
    const session = new BackendSession(ports(textMode ? () => { reads++; return history; } : undefined, counts, textMode ? 'text' : undefined), m => outgoing.push(m), () => {});
    const ready = outgoing[0]; assert.ok(ready?.channel === 'backend_ready'); assert.equal('history' in ready, false);
    await session.close(); assert.equal(reads, 0); assert.equal(counts.calls, 0);
  }
});
test('a failed or foreign history read reports unavailable while native startup remains usable', async () => {
  for (const read of [() => { throw Error('private detail must not leak'); }, () => ({ ...history, characterId: 'other' } as unknown as CompanionChatHistory)]) {
    const outgoing: BackendToDesktop[] = [], counts = { calls: 0 };
    const session = new BackendSession(ports(read, counts), m => outgoing.push(m), () => {});
    const ready = outgoing[0]; assert.ok(ready?.channel === 'backend_ready'); assert.equal(ready.history?.status, 'unavailable');
    assert.deepEqual(ready.history?.rows, []); assert.equal(JSON.stringify(ready).includes('private detail'), false);
    await session.close(); assert.equal(counts.calls, 0);
  }
});
