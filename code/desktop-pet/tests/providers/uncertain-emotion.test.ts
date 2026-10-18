// An 'uncertain' memory request must not degrade the dialogue request.
//
// 'uncertain' means only "this remark MIGHT touch memory". It used to be folded into the `forgetting`
// flag, which caused three defects at once: the user's own words were replaced by a neutral placeholder
// (so the pet answered a sentence it never saw), emotionAssessment was dropped from the template, and
// parseEmotionAssessment was skipped — leaving the mood frozen for as long as remarks kept being
// classified 'uncertain'. This pins the two observable halves of that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDialogueRequest } from '../../providers/dialogue-request.js';
import { dialogueLiveV1 } from './fixtures/dialogue-live-v1.js';
import { hostClock } from '../../providers/host-clock.js';

// The recorded case is a forget turn and already carries memoryOutcome; it must be dropped before a
// memoryPending state can be injected (the builder rejects both being set at once).
const { memoryOutcome: _omitted, ...recorded } = dialogueLiveV1.cases[1].input as never as Record<string, any>;
const config = { endpoint: 'https://controlled.invalid/chat/completions', model: 'qwen-plus-2025-12-01',
  apiKey: () => 'test-only', authorizer: { async authorize() { return { async settle() {} }; } } };
const frame = { now: hostClock(new Date('2026-01-01T00:00:00.000Z')), presets: [] as const };
const text = '嗯，那件事你看着办吧';

function build(extra: Record<string, unknown>) {
  const currentId = `${recorded.scope.turnId}:user`;
  const recent = recorded.context.recent.map((m: any) => (m.id === currentId ? { ...m, text } : m));
  return buildDialogueRequest({ ...recorded, text, context: { ...recorded.context, recent }, ...extra } as never,
    config, frame, {});
}

const uncertain = { memoryPending: { scope: recorded.scope, request: 'uncertain', status: 'pending' } };
const forget = { memoryPending: { scope: recorded.scope, request: 'forget', status: 'pending' } };

test('an uncertain request still asks for an emotion assessment', () => {
  const system = build(uncertain).body.messages[0]!.content;
  assert.match(system, /"emotionAssessment"/, 'uncertain 轮次仍必须要求情绪评估');
  assert.match(system, /"intensity":\d/, '强度仍应以数值示例出现');
  console.log('  uncertain: 模板含 emotionAssessment ✔');
});

test('an uncertain request still carries the user’s own words', () => {
  const payload = JSON.stringify(build(uncertain).body.messages);
  assert.ok(payload.includes(text), 'uncertain 轮次必须把用户原话发给模型');
  assert.doesNotMatch(payload, /具体内容暂不用于回应/, '不得用占位句替换用户原话');
  console.log('  uncertain: 原话已发送 ✔');
});

test('a real forget request still withholds the text and the assessment', () => {
  const built = build(forget);
  const system = built.body.messages[0]!.content;
  const payload = JSON.stringify(built.body.messages);
  assert.doesNotMatch(system, /"emotionAssessment"/, '真正遗忘时不应要求情绪评估');
  assert.ok(!payload.includes(text), '真正遗忘时不得复述用户原话');
  console.log('  forget: 原话被抑制、情绪不采集 ✔（保留）');
});
