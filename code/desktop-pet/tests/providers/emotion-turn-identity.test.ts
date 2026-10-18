// An assessment must survive when the assembled context omits the turn being answered.
//
// memory/context.ts deliberately excludes that turn from `recent` (the question travels in the provider's
// currentMessage instead), so the old lookup — `recent.find(id === turnId+':user')` — always missed, and
// every correct assessment was discarded with it. That is what kept the console's mood panel empty even
// though the model returned {"user":{"label":"happy"},...} verbatim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmotionAssessment, normalizeUserEmotion } from '../../providers/emotion-inference.js';

const raw = { user: { label: 'happy', intensity: null, confidence: null },
  companion: { label: 'warm', intensity: null, confidence: null } };
const text = '谢谢你让我今天的心情变好了。';
const scope = { characterId: 'companion', sessionId: 's', turnId: 'turn-1', generation: 1 };
const currentMessage = { characterId: 'companion', id: 'turn-1:user', role: 'user' as const,
  text, createdAt: '2026-01-01T00:00:00.000Z' };

test('a context that omits the current turn still yields an assessment when the identity is supplied', () => {
  // This is the real production shape: recent holds only EARLIER turns.
  const request = { scope, text, context: { recent: [
    { characterId: 'companion', id: 'older:user', role: 'user' as const, text: '上一句话', createdAt: '2026-01-01T00:00:00.000Z' },
    { characterId: 'companion', id: 'older:assistant', role: 'assistant' as const, text: '上一句回复', createdAt: '2026-01-01T00:00:01.000Z' },
  ] } };

  // Without the identity the guard rejects it — the behaviour that produced 暂无.
  assert.equal(parseEmotionAssessment(raw, request as never), undefined,
    '没有当前消息身份时应拒绝（这正是原来的失败）');

  // With it, the assessment binds to this turn.
  const result = parseEmotionAssessment(raw, request as never, { id: 'turn-1:user', version: 1 });
  assert.ok(result, '显式提供身份后必须能解析');
  assert.equal(result.user?.label, 'happy');
  assert.equal(result.companion?.label, 'warm');
  assert.equal(result.user?.provenance, 'text_recent_context');
  assert.deepEqual(result.user?.sources, [{ id: 'turn-1:user', version: 1 }]);
  console.log(`  recent 只有 ${request.context.recent.length} 条历史，仍解析出 user=${result.user?.label} companion=${result.companion?.label}`);
});

test('the supplied identity must belong to this turn and the payload must be sane', () => {
  const request = { scope, text, context: { recent: [] } };
  // The text is taken from the request, so a text comparison alone would be self-confirming; the
  // identity itself has to name this turn.
  assert.equal(parseEmotionAssessment(raw, request as never, { id: 'other-turn:user', version: 1 }),
    undefined, '身份不属于本轮时必须拒绝');
  assert.equal(parseEmotionAssessment({ user: { label: 'happy', intensity: 3, confidence: null }, companion: null },
    request as never, { id: 'turn-1:user', version: 1 }), undefined, '强度越界必须拒绝');
  assert.equal(parseEmotionAssessment({ user: { label: 'not-an-emotion', intensity: null, confidence: null }, companion: null },
    request as never, { id: 'turn-1:user', version: 1 }), undefined, '无法归一的用户情绪词必须拒绝');
  assert.equal(parseEmotionAssessment({ user: { label: '  ', intensity: null, confidence: null }, companion: null },
    request as never, { id: 'turn-1:user', version: 1 }), undefined, '空标签必须拒绝');
  console.log('  四个非法输入全部被拒');
});

test('the in-context path still works for callers that do carry the turn', () => {
  const request = { scope, text, context: { recent: [currentMessage] } };
  const result = parseEmotionAssessment(raw, request as never);
  assert.ok(result, 'recent 含当前轮时无需额外参数');
  assert.equal(result.user?.label, 'happy');
  assert.equal(normalizeUserEmotion('开心'), 'happy');
});
