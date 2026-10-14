import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { configureLocalDialogue, parseLocalDialogueArguments } from '../../tools/local-dialogue-config.mjs';
import { validateTrialConfiguration } from '../../dist/app/trial-config.js';
const hash = value => createHash('sha256').update(value).digest('hex');
const selection = { baseUrl: 'http://127.0.0.1:11435/v1', model: 'aaaagent-qwen35-4b:review', contextWindowTokens: 16384, inputTokenLimit: 12000, outputTokenLimit: 768 };
async function fixture(t) {
  const prefix = resolve(tmpdir(), 'aaaagent-dialogue-pair-'), dir = await fs.mkdtemp(prefix);
  t.after(async () => { assert.ok(resolve(dir).startsWith(prefix)); await fs.rm(dir, { recursive: true }); });
  const chat = { provider: 'dashscope', model: 'fixture-chat', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    credentialFile: resolve(dir, '..', 'nonexistent-test-key'), reservationMicros: 100000, inputTokenLimit: 32768, outputTokenLimit: 1024, inputMicrosPerToken: .8, outputMicrosPerToken: 2 };
  const configuration = { version: 1, product: 'companion-v1', phaseId: 'local-trial-config-test', purpose: 'user-trial', projectRoot: dir,
    sourceRevision: 'a'.repeat(40), desktopHost: 'electron', database: resolve(dir, '.local/data/companion.sqlite'),
    budgetFile: resolve(dir, '.local/model-evaluation/budget.json'), budgetBatchId: 'local-test', limitMicros: 20000000,
    phaseLimitMicros: 20000000, maxCalls: 100, operationLimits: { dialogue: 20, memory_turn: 20, summary: 10, admission: 20, perception: 10, tts: 20 },
    runtimeFiles: Object.fromEntries(['dist/app/trial-backend.js', 'dist/app/trial-launcher.js', 'desktop/build/renderer.js',
      'desktop/electron/main.mjs', 'desktop/electron/preload.cjs', 'desktop/electron/transport.mjs', 'desktop/electron/layout.mjs', 'desktop/electron/assets.mjs', 'tools/management-url.mjs'].map(file => ['code/desktop-pet/' + file, 'a'.repeat(64)])),
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
    models: { dialogue: chat, summary: chat, admission: chat, perception: chat,
      memory_turn: { ...chat, provider: 'deepseek', model: 'fixture-memory', endpoint: 'https://api.deepseek.com/chat/completions' },
      tts: { ...chat, model: 'fixture-tts', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', characterMicros: 80 } },
    localSpeech: { baseUrl: 'http://127.0.0.1:19380/v1', asr: { model: 'sensevoice-small' } } };
  validateTrialConfiguration(configuration);
  const file = resolve(dir, '.local/model-evaluation/trial/user-trial/config.json'), activation = resolve(dirname(file), 'activation.json');
  await fs.mkdir(dirname(file), { recursive: true });
  const raw = JSON.stringify(configuration), act = JSON.stringify({ version: 1, phaseId: configuration.phaseId, status: 'prepared', configSha256: hash(raw) });
  await fs.writeFile(file, raw); await fs.writeFile(activation, act);
  return { dir, file, activation, raw, act, configuration };
}

test('local dialogue CLI requires explicit model and keeps small Ollama defaults', () => {
  assert.throws(() => parseLocalDialogueArguments(['--config', 'fixture.json']));
  for (const args of [['--config'], ['--config', 'x', '--secret', 'x'], ['--config', 'x', '--model', 'm', '--input', '0'],
    ['--config', 'x', '--off', '--model', 'm'], ['--config', 'x', '--model', 'm', '--model', 'other']]) assert.throws(() => parseLocalDialogueArguments(args));
  const parsed = parseLocalDialogueArguments(['--config', 'fixture.json', '--model', selection.model]);
  assert.deepEqual(parsed.selection, { ...selection, timeoutMs: 120000, reasoningEffort: 'none' });
  assert.equal(parseLocalDialogueArguments(['--config', 'fixture.json', '--off']).selection, null);
  assert.equal(parseLocalDialogueArguments(['--config', 'fixture.json', '--model', 'generic', '--reasoning', 'server']).selection.reasoningEffort, undefined);
});

test('local dialogue selection preserves all cloud settings, speech, activation and recoverable originals', async t => {
  const f = await fixture(t), backup = await configureLocalDialogue(f.file, selection);
  const raw = await fs.readFile(f.file, 'utf8'), next = JSON.parse(raw), activation = JSON.parse(await fs.readFile(f.activation, 'utf8'));
  assert.deepEqual(next.models, f.configuration.models); assert.deepEqual(next.memory, f.configuration.memory);
  assert.deepEqual(next.localSpeech, f.configuration.localSpeech); assert.deepEqual(next.localDialogue, { ...selection, timeoutMs: 120000 });
  assert.equal(activation.status, 'prepared'); assert.equal(activation.configSha256, hash(raw));
  assert.equal(await fs.readFile(backup.config, 'utf8'), f.raw); assert.equal(await fs.readFile(backup.activation, 'utf8'), f.act);
  await configureLocalDialogue(f.file, null);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), f.configuration);
});

test('invalid local config, mismatched activation, active desktop and competing speech edit leave pair unchanged', async t => {
  const f = await fixture(t);
  const unchanged = async () => { assert.equal(await fs.readFile(f.file, 'utf8'), f.raw); assert.equal(await fs.readFile(f.activation, 'utf8'), f.act); };
  await assert.rejects(configureLocalDialogue(f.file, { ...selection, baseUrl: 'https://outside.invalid/v1' })); await unchanged();
  const lock = resolve(f.dir, '.local/model-evaluation/backend.lock');
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(configureLocalDialogue(f.file, selection), /Quit the running desktop/); await unchanged(); await fs.unlink(lock);
  await fs.writeFile(f.file + '.speech-edit.lock', 'competing-editor');
  await assert.rejects(configureLocalDialogue(f.file, selection), { code: 'EEXIST' }); await unchanged(); await fs.unlink(f.file + '.speech-edit.lock');
  await fs.writeFile(f.activation, JSON.stringify({ ...JSON.parse(f.act), configSha256: '0'.repeat(64) }));
  await assert.rejects(configureLocalDialogue(f.file, selection), /pair differs/); assert.equal(await fs.readFile(f.file, 'utf8'), f.raw);
});
