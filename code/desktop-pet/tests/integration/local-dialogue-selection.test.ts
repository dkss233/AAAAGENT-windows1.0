import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTrialDialogue } from '../../app/dialogue-selection.js';
import type { TrialConfiguration } from '../../app/trial-config.js';
import { ProviderTransport } from '../../providers/transport.js';
import { deepseekFlashDialogueModel } from '../../providers/text-protocol.js';

const models = { dialogue: deepseekFlashDialogueModel('/external/unused') } as TrialConfiguration['models'];
const localDialogue = { baseUrl: 'http://127.0.0.1:11435/v1', model: 'aaaagent-qwen35-4b:review', contextWindowTokens: 16384, inputTokenLimit: 12000, outputTokenLimit: 768 };
const scope = { characterId: 'companion', sessionId: 's', turnId: 't', generation: 1 };
const request = { scope, text: '你好', context: { scope, characterPrompt: '朋友', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 12000 } };
const response = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: '你好。', expression: { emotion: 'neutral', intensity: .3, delivery: '平静', gesture: null } }) } }] });

test('no override keeps existing cloud model, input budget and transport', async () => {
  let cloudCalls = 0, keyReads = 0;
  const endpoint = () => ({ endpoint: models.dialogue.endpoint, model: models.dialogue.model, apiKey: () => { keyReads++; return 'fixture'; }, authorizer: { authorize: async () => ({ settle: async () => {} }) } });
  const selected = selectTrialDialogue({ models }, endpoint, new ProviderTransport(async () => { cloudCalls++; return response(); }), () => ({ presets: [] }), 200000, .6,
    async () => { throw Error('local request must not run'); });
  assert.equal(selected.foregroundBudget.effectiveInputTokens, 200000);
  await selected.dialogue.reply(request, new AbortController().signal);
  assert.equal(cloudCalls, 1); assert.equal(keyReads, 1);
});

test('local override leaves cloud registration intact and never constructs or calls cloud dialogue', async () => {
  const original = structuredClone(models); let localCalls = 0;
  const selected = selectTrialDialogue({ models, localDialogue }, () => { throw Error('cloud binding must stay lazy'); },
    new ProviderTransport(async () => { throw Error('cloud request must not run'); }), () => ({ presets: [] }), 200000, .8,
    async () => { localCalls++; return response(); });
  assert.equal(selected.foregroundBudget.effectiveInputTokens, 12000); assert.equal(selected.foregroundBudget.counting.model, localDialogue.model);
  await selected.dialogue.reply(request, new AbortController().signal);
  assert.equal(localCalls, 1); assert.deepEqual(models, original);
});
