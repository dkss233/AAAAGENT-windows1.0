import { historicalDialoguePrefix, withoutEmotionShape } from './companion-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DialogueRequest } from '../../contracts/index.js';
import type { MemoryTurnOutcome } from '../../contracts/memory-lifecycle.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';
import { dialogueLiveV1 } from './fixtures/dialogue-live-v1.js';

type Body = { messages: { role: string; content: string }[]; [key: string]: unknown };
const boundary = '记忆执行状态由程序提供';
const unchangedPrefix = dialogueLiveV1.cases[0].originalMessages[0]!.content.split('本轮感知')[0]!;
function harness(raw: string) {
  const requests: Body[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: raw } }] });
  });
  return { requests, provider: new QwenDialogueProvider({ endpoint: 'https://controlled.invalid/chat/completions', model: 'qwen-plus-2025-12-01', apiKey: () => 'test-only', authorizer: { async authorize() { return { async settle() {} }; } } }, transport) };
}
function selectedRules(body: Body) {
  const system = body.messages[0]!.content;
  assert.equal(withoutEmotionShape(historicalDialoguePrefix(system.split('本轮感知')[0]!)), unchangedPrefix, 'historical character/schema/history prefix is preserved apart from the emotionAssessment field and later presentation/manual-edit rules');
  assert.match(system,/expression描述助手本轮回复的表达/);assert.match(system,/不能仅用旧对话或自动摘要推翻人工修正/);
  return system.slice(system.indexOf(boundary));
}
function safeOutcome(body: Body) {
  const content = body.messages[1]!.content;
  return JSON.parse(content.slice(content.indexOf('：') + 1));
}

for (const fixture of dialogueLiveV1.cases) test(`factor A preserves actual c1ae4ff ${fixture.name} failure and all non-rule request data`, async t => {
  assert.equal(createHash('sha256').update(fixture.rawModelText).digest('hex'), fixture.modelTextSha256);
  const input: DialogueRequest = fixture.input, before = structuredClone(input), run = harness(fixture.rawModelText);
  assert.deepEqual(await run.provider.reply(input, new AbortController().signal), fixture.originalReply);
  assert.deepEqual(input, before); assert.equal(fixture.semanticAcceptance, false);
  const body = run.requests[0]!;
  assert.deepEqual(body.messages.slice(1), fixture.originalMessages.slice(1), 'actual outcome and single-user JSON are unchanged');
  assert.doesNotMatch(selectedRules(body), /遗忘|忘记|目标事实/);
  const { messages: _messages, ...parameters } = body;
  assert.deepEqual(parameters, { stream: false, enable_thinking: false, response_format: { type: 'json_object' }, model: 'qwen-plus-2025-12-01' });
  t.diagnostic('semanticAcceptance=false; controlled transport returns the original wrong output without repair');
});

for (const request of ['none', 'correction', 'forget'] as const) for (const status of ['applied', 'unchanged', 'rejected', 'needs_clarification'] as const) {
  test(`factor A sends only applicable ${request}/${status} rules with the actual outcome`, async () => {
    const base: DialogueRequest = dialogueLiveV1.cases[1].input;
    const memoryOutcome: MemoryTurnOutcome = { scope: base.scope, request, status, results: [], affectedIds: status === 'applied' ? ['private-record'] : [], retrievalInvalidated: status === 'applied', clarification: status === 'needs_clarification' ? '请确认指的是哪件事？' : null, rejectionCode: 'private-diagnostic' };
    const arbitrary = { text: '独立的完整受控回复。😀'.repeat(700), expression: { emotion: '平静', intensity: 0.2, delivery: '自然', gesture: null } };
    const run = harness(JSON.stringify(arbitrary)), input = { ...base, memoryOutcome }, before = structuredClone(input);
    assert.equal((await run.provider.reply(input, new AbortController().signal)).text, arbitrary.text);
    assert.deepEqual(input, before); assert.equal(run.requests.length, 1);
    const body = run.requests[0]!, rules = selectedRules(body), payload = JSON.parse(body.messages[2]!.content);
    assert.deepEqual(safeOutcome(body), { request, status, clarification: memoryOutcome.clarification });
    assert.equal(body.messages.filter(m => m.role === 'user').length, 1);
    assert.equal(body.messages.some(m => m.role === 'assistant'), false);
    assert.equal('max_tokens' in body || 'max_completion_tokens' in body || 'temperature' in body || 'seed' in body, false);
    if (request === 'forget') {
      assert.match(rules, /本轮回应遗忘请求/); assert.match(rules, /不要复述、猜测或变相提示目标事实/);
      assert.deepEqual(payload, { currentMessage: '请根据实际执行结果回应本次遗忘事项，不复述具体内容。' });
      for (const text of [base.text, '糯米', '团子', ...base.context.recent.map(m => m.text)]) assert.equal(JSON.stringify(body).includes(text), false);
    } else {
      assert.doesNotMatch(rules, /遗忘|忘记|目标事实/);
      assert.deepEqual(body.messages[2], dialogueLiveV1.cases[1].originalMessages[2]);
      assert.equal(body.messages[2]!.content.split(base.text).length - 1, 1);
      if (request === 'correction') assert.match(rules, /以用户当前更正和提供的有效资料为依据/);
      else { assert.match(rules, /按提供的当前有效资料回答当前问题/); assert.match(rules, /自动维护无需向用户逐项播报/); }
    }
    if (status === 'applied') {
      assert.match(rules, request === 'none' ? /本轮自动维护已应用/ : request === 'correction' ? /本轮更正已应用/ : /本轮遗忘已应用/);
      assert.doesNotMatch(rules, /没有变更|处理未成功|本轮需要澄清/);
    } else {
      assert.doesNotMatch(rules, /已应用|变更已生效|可以自然确认这次操作/);
      assert.match(rules, status === 'unchanged' ? /没有变更/ : status === 'rejected' ? /处理未成功/ : /按提供的clarification自然询问/);
    }
    for (const privateValue of ['private-record', 'private-diagnostic']) assert.equal(JSON.stringify(body).includes(privateValue), false);
  });
}

test('factor A missing outcome remains null, with valid data and no task-specific success rule', async () => {
  const { memoryOutcome: _unused, ...input } = dialogueLiveV1.cases[1].input;
  const run = harness(dialogueLiveV1.cases[1].rawModelText);
  assert.equal((await run.provider.reply(input, new AbortController().signal)).text, dialogueLiveV1.cases[1].originalReply.text);
  const body = run.requests[0]!, rules = selectedRules(body);
  assert.equal(safeOutcome(body), null); assert.deepEqual(body.messages[2], dialogueLiveV1.cases[1].originalMessages[2]);
  assert.match(rules, /未提供记忆执行结果，不能声称变更已经完成/);
  assert.doesNotMatch(rules, /遗忘|忘记|本轮回应更正|已应用|变更已生效/);
});
