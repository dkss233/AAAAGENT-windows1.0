// Intensity and confidence must be REQUESTED, not merely permitted.
//
// Both fields were schema-optional, and the JSON template showed `intensity:null,confidence:null` as the
// only example. The model copied it verbatim, so the console showed 未评估 forever. The fix was to show
// numbers in the template and to say what the fields mean; verified against the live model:
//   强情绪 sad     → intensity 0.85, confidence 0.9
//   平静   neutral → intensity 0.4,  confidence 0.5
//   无线索 嗯。     → user null (the intended escape hatch still works)
//
// Built from the recorded DialogueRequest so the context is genuinely the production shape rather than a
// hand-made approximation that happens to satisfy the type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EMOTION_RESPONSE_RULES } from '../../providers/emotion-inference.js';
import { buildDialogueRequest } from '../../providers/dialogue-request.js';
import { dialogueLiveV1 } from './fixtures/dialogue-live-v1.js';
import { hostClock } from '../../providers/host-clock.js';

const recorded = dialogueLiveV1.cases[1].input;
const config = { endpoint: 'https://controlled.invalid/chat/completions', model: 'qwen-plus-2025-12-01',
  apiKey: () => 'test-only', authorizer: { async authorize() { return { async settle() {} }; } } };
// The frame's `now` is the host clock's shape, so take it from the real function.
const frame = { now: hostClock(new Date('2026-01-01T00:00:00.000Z')), presets: [] as const };

function systemFor(text: string): string {
  // The current turn's saved copy must carry the same text: buildDialogueRequest rejects a mismatch
  // ("Current input does not match the saved turn"), which is the guard that keeps the answered turn
  // identifiable at all.
  const currentId = `${recorded.scope.turnId}:user`;
  const recent = recorded.context.recent.map(m => (m.id === currentId ? { ...m, text } : m));
  const built = buildDialogueRequest({ ...recorded, text, context: { ...recorded.context, recent } },
    config, frame, {});
  return built.body.messages[0]!.content;
}

test('the JSON template shows numbers for intensity/confidence, not null', () => {
  const system = systemFor('我很难过。');
  const at = system.indexOf('"emotionAssessment"');
  assert.ok(at > 0, '模板应包含 emotionAssessment');
  const shape = system.slice(at, at + 260);
  assert.match(shape, /"intensity":\d/, '模板里的 intensity 必须是数值，否则模型会照抄 null');
  assert.match(shape, /"confidence":\d/, '模板里的 confidence 必须是数值');
  assert.doesNotMatch(shape, /"intensity":null/, '不能再用 null 作示例');
  console.log('  模板示例: ' + shape.slice(0, 116));
});

test('the rules explain the scale and keep the null escape hatch', () => {
  // Both halves matter: numbers have to be asked for, and 无线索 must still be allowed to be null.
  assert.match(EMOTION_RESPONSE_RULES, /intensity是情绪强弱/);
  assert.match(EMOTION_RESPONSE_RULES, /0到1之间的小数/);
  assert.match(EMOTION_RESPONSE_RULES, /只有完全无法判断时才填null/);
  assert.match(EMOTION_RESPONSE_RULES, /不要把情绪类别机械换算成固定数值/);
  assert.match(EMOTION_RESPONSE_RULES, /无新线索允许null/);
  console.log('  规则：要求估计 + 保留 null 逃生口');
});

test('a forget reply carries no assessment at all', () => {
  const text = '忘掉那件事。';
  const currentId = `${recorded.scope.turnId}:user`;
  const recent = recorded.context.recent.map(m => (m.id === currentId ? { ...m, text } : m));
  const built = buildDialogueRequest({ ...recorded, text, context: { ...recorded.context, recent },
    memoryOutcome: { scope: recorded.scope, request: 'forget', status: 'applied',
      results: [{ characterId: recorded.scope.characterId, status: 'applied' }],
      affectedIds: ['r1'], retrievalInvalidated: true, clarification: null } } as never,
    config, frame, {});
  assert.equal(built.body.messages[0]!.content.includes('emotionAssessment'), false, '遗忘回复不应要求情绪评估');
});
