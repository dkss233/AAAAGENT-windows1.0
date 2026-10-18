// The first emotion observation must be recordable on a fresh store, and it must then be sent.
//
// Regression guard for two separate faults that together made the whole "当前情绪" feature unreachable:
//
//  1. EmotionTurns.prepare() refused without context.emotionBackground, while assembleContext only
//     attached that background once an observation existed — and complete() is the only writer of
//     observations. On a fresh install nothing was ever recorded, so the console showed 暂无 forever.
//  2. The emotion layer was admitted only when it fitted inside currentEmotionReserveTokens. The
//     measured brief background is 666 characters against a 512 default, so even after a mood WAS
//     recorded it was dropped from every request — the pet never saw its own state.
//
// The pre-existing unit tests could not catch either: they hand their fixture an assessment and set a
// reserve large enough to fit, so they start as if the state already worked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';
import { lifecycle, signal } from '../memory/lifecycle-fixture.js';
import { EmotionTurns } from '../../core/emotion-state.js';

const NOW = '2026-09-19T06:00:00Z';
const TEXT = '今天有点累，随便聊聊。';

function fixture() {
  const base = fileURLToPath(new URL('../../../../../artifacts/W1/emotion-first/tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'case-'));
  const store = new SqliteMemoryStore({ filename: resolve(directory, 'probe.sqlite'), retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => NOW });
  return { store, memory: lifecycle(store), emotion: new EmotionTurns(store.emotion, store), directory };
}

const scopeOf = (turnId: string, generation: number) => ({ characterId: 'companion', sessionId: 's', turnId, generation });

async function issue(memory: ReturnType<typeof lifecycle>, scope: ReturnType<typeof scopeOf>, id: string) {
  await memory.append(scope, [{ id, characterId: 'companion', role: 'user', text: TEXT, createdAt: NOW }]);
  await memory.prepareTurn(scope, id, TEXT, signal());
  return memory.context(scope, TEXT, null, signal());
}

const caring = () => ({ subject: 'companion' as const, label: 'caring', intensity: null, confidence: null, provenance: 'companion_inference' as const, sources: [] });

test('a fresh store records its first observation without an existing emotion background', async () => {
  const { store, memory, emotion, directory } = fixture();
  try {
    const scope = scopeOf('first', 1);
    const context = await issue(memory, scope, 'first:user');

    // The premise: nothing has been recorded, so assembleContext attaches no background at all.
    assert.equal(context.emotionBackground, undefined, '全新状态不应有情绪背景');
    assert.equal(store.emotion.snapshot('companion', 0, 20).companion.revision, 0);

    const input = emotion.prepare(context, { id: 'first:user', version: 1 }, TEXT);
    assert.ok(input, '没有情绪背景时 prepare() 也必须给出 ticket，否则第一条观测永远写不进去');

    emotion.complete(input, { user: null, companion: caring() });

    const after = store.emotion.snapshot('companion', 0, 20);
    assert.equal(after.companion.observation?.label, 'caring', '第一条观测应落库');
    assert.equal(after.companion.revision, 1);
  } finally {
    await emotion.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a recorded mood is attached to the next request despite the 512 default reserve', async () => {
  const { store, memory, emotion, directory } = fixture();
  try {
    const context = await issue(memory, scopeOf('first', 1), 'first:user');
    const input = emotion.prepare(context, { id: 'first:user', version: 1 }, TEXT)!;
    emotion.complete(input, { user: null, companion: caring() });

    // The default reserve is 512 and the brief background measures 666, so this is the case that used
    // to be dropped silently rather than trimmed.
    const next = await issue(memory, scopeOf('second', 2), 'second:user');
    assert.ok(next.emotionBackground, '预留不足不应导致整个情绪层被丢弃');
    assert.equal(next.emotionBackground!.companion.observation?.label, 'caring', '已记录的心情必须进入下一轮上下文');
  } finally {
    await emotion.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an outstanding memory hold does not suppress emotion capture', async () => {
  // Two separate couplings used to freeze the mood for a character while a memory hold was outstanding,
  // and a FAILED hold is never released — so one failed memory turn stopped emotion permanently and the
  // console showed a stale value with nothing explaining why:
  //
  //  1. EmotionTurns.prepare() reused the memory privacy guard (`store.pending.has(characterId)`).
  //  2. sqlite-port omitted emotionBackground whenever privacyExcluded was set, and assembleContext is
  //     that background's only route to the emotion layer, so prepare() had nothing to work from.
  //
  // Contexts built WHILE a hold exists are marked privacyExcluded and must stay usable; only contexts
  // issued before the hold become stale. So the hold is established first, as in production.
  const { store, memory, emotion, directory } = fixture();
  try {
    const scope = scopeOf('held', 1);
    await memory.append(scope, [{ id: 'held:user', characterId: 'companion', role: 'user', text: TEXT, createdAt: NOW }]);

    // Establish and fail a real privacy hold before this turn's context is assembled.
    memory.beginPendingMutation(scope, 'held:user', { request: 'uncertain', sources: null });
    store.pending.fail(scope, 'held:user');
    assert.equal(store.pending.has('companion'), true, '前提：失败的挂起确实会挡住该角色');

    const context = await memory.context(scope, TEXT, null, signal());
    const input = emotion.prepare(context, { id: 'held:user', version: 1 }, TEXT);
    assert.ok(input, '挂起期间情绪采集仍必须进行，否则一次记忆失败会永久冻结情绪');

    emotion.complete(input, { user: null, companion: caring() });
    const after = store.emotion.snapshot('companion', 0, 20);
    assert.equal(after.companion.observation?.label, 'caring', '挂起期间的情绪观测也应落库');
    assert.equal(after.companion.revision, 1);
  } finally {
    await emotion.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
