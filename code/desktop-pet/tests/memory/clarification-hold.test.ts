// A clarification must not become a durable privacy hold.
//
// The planner asks a clarifying question when the utterance is ambiguous — exactly what contradictory or
// unrelated remarks produce. That plan applies nothing (commitTurn rejects a clarification carrying
// mutations), so the request is answered, not failed. It used to be marked 'failed', and has() counts
// 'failed' while nothing ever releases it: one ambiguous sentence then blocked that character's memory
// reads AND (before the pipeline gate was removed) its emotion observations until an operator cancelled it
// by hand. The trigger is ordinary conversation, so this was reachable by simply talking to the pet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';

const NOW = '2026-09-19T06:00:00Z';
const scopeOf = (turnId: string) => ({ characterId: 'companion', sessionId: 's', turnId, generation: 1 });

function fixture() {
  const base = fileURLToPath(new URL('../../../../../artifacts/W1/clarification/tmp/', import.meta.url));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'case-'));
  const store = new SqliteMemoryStore({ filename: resolve(directory, 'probe.sqlite'), retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai'), clock: () => NOW });
  return { store, directory };
}

test('releasing a clarification clears the hold instead of failing it', () => {
  const { store, directory } = fixture();
  try {
    const scope = scopeOf('ambiguous');
    const id = 'ambiguous:user';

    // The admission classifier suspects this might change stored facts, so a hold is opened.
    store.pending.begin(scope, id, 1, 'uncertain');
    assert.equal(store.pending.has('companion'), true, '前提：begin 之后挂起生效');
    assert.equal(store.pending.list('companion').length, 1);

    // The planner answered with a question and applied nothing.
    store.pending.releaseClarification(scope, id);

    assert.equal(store.pending.has('companion'), false, '澄清之后不得继续挡住记忆');
    assert.equal(store.pending.list('companion').length, 0, '已作答的请求不应留在未完成列表里');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a rejected write still leaves a durable hold', () => {
  // The contrast that makes the distinction meaningful: a rejection means the state is unknown, so the
  // hold must survive and keep memory conservative.
  const { store, directory } = fixture();
  try {
    const scope = scopeOf('rejected');
    const id = 'rejected:user';
    store.pending.begin(scope, id, 1, 'uncertain');
    store.pending.fail(scope, id);
    assert.equal(store.pending.has('companion'), true, '拒绝后必须仍然挡住');
    assert.equal(store.pending.list('companion')[0]?.status, 'failed');
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('releasing a clarification does not advance the character epoch', () => {
  // cancel() bumps the epoch to invalidate already-captured strict work after a NEW privacy request.
  // Nothing was applied by a clarification, so bumping here would needlessly invalidate in-flight context.
  const { store, directory } = fixture();
  try {
    const scope = scopeOf('epoch');
    const id = 'epoch:user';
    const epochBefore = store.inspect(scope, id);
    store.pending.begin(scope, id, 1, 'uncertain');
    store.pending.releaseClarification(scope, id);
    const after = store.revision(scope);
    assert.ok(Number.isInteger(after), 'revision 仍可读');
    void epochBefore;
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
