import { historicalDialoguePrefix } from './companion-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { DialogueRequest } from '../../contracts/index.js';
import { contextInputUpperBound } from '../../app/input-budgets.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';
import { dialogueFactorALiveV1 } from './fixtures/dialogue-factor-a-live-v1.js';

type Body = { messages: { role: string; content: string }[]; [key: string]: unknown };
const factStart = '本轮感知', outcomeStart = '记忆执行状态由程序提供';

for (const fixture of dialogueFactorALiveV1.cases) test(`factor B changes only generic fact wording for original A ${fixture.name}`, async t => {
  assert.equal(createHash('sha256').update(fixture.rawModelText).digest('hex'), fixture.modelTextSha256);
  const requests: Body[] = [];
  const transport = new ProviderTransport(async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: fixture.rawModelText } }] });
  });
  const provider = new QwenDialogueProvider({ endpoint: 'https://controlled.invalid/chat/completions', model: 'qwen-plus-2025-12-01', apiKey: () => 'test-only', authorizer: { async authorize() { return { async settle() {} }; } } }, transport);
  const input: DialogueRequest = fixture.input, before = structuredClone(input);
  assert.deepEqual(await provider.reply(input, new AbortController().signal), fixture.originalReply, 'neither the old failure nor improved sample is rewritten');
  assert.deepEqual(input, before); assert.equal(requests.length, 1);
  const body = requests[0]!, system = body.messages[0]!.content, originalSystem = fixture.originalMessages[0]!.content;
  const generic = system.slice(system.indexOf(factStart), system.indexOf(outcomeStart));
  assert.equal(historicalDialoguePrefix(system.slice(0, system.indexOf(factStart))), originalSystem.slice(0, originalSystem.indexOf(factStart)), 'historical prefix is preserved apart from later presentation/manual-edit rules');
  assert.match(system,/expression描述助手本轮回复的表达/);assert.match(system,/不能仅用旧对话或自动摘要推翻人工修正/);
  assert.equal(system.slice(system.indexOf(outcomeStart)), originalSystem.slice(originalSystem.indexOf(outcomeStart)), 'actual factor A rule suffix stays byte-identical');
  assert.deepEqual(body.messages.slice(1), fixture.originalMessages.slice(1), 'actual outcome and all single-user JSON data stay byte-identical');
  assert.doesNotMatch(generic, /嘴瓢|误听|小名|玩笑|遗忘|忘记|失忆/);
  assert.match(generic, /用户、宠物、共同经历和助手既往行为的事实，均以给定资料为依据/);
  assert.match(generic, /资料足够时直接回答当前所问；资料不足时只说明当前可确认的范围/);
  assert.match(generic, /允许用户纠正/); assert.match(generic, /不能编造/);
  assert.match(system, /按内容需要简洁或详细，不强行限制字数/);
  assert.equal(body.messages[2]!.content.split(input.text).length - 1, 1);
  assert.equal(body.messages.filter(m => m.role === 'user').length, 1);
  const { messages: _messages, ...parameters } = body;
  assert.deepEqual(parameters, { stream: false, enable_thinking: false, response_format: { type: 'json_object' }, model: 'qwen-plus-2025-12-01' });
  assert.ok(Buffer.byteLength(JSON.stringify(body.messages)) <= contextInputUpperBound(input.context, input.text));
  assert.equal(fixture.stableOrCausalAcceptance, false);
  t.diagnostic(`Original A observation=${fixture.observation}; no real factor B model call or semantic acceptance`);
});
