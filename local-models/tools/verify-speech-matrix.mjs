import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pcmWave } from '../src/audio.mjs';

// Real inference only. This script sends no dialogue or cloud requests.
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const data = fileURLToPath(new URL('../../.local/local-models/', import.meta.url));
const base = option('--url', 'http://127.0.0.1:19380').replace(/\/$/, '');
const at = new Date().toISOString();
const replayPath = option('--replay', undefined);
const replay = replayPath ? JSON.parse(await readFile(resolve(replayPath), 'utf8')) : undefined;
const output = resolve(option('--output', resolve(data, 'reports', `speech-matrix-${at.replace(/[:.]/g, '-')}`)));
const asrModels = ['sensevoice-small', 'paraformer-zh', 'whisper-small'];
const ttsModels = [
  { model: 'gpt-sovits', voice: option('--gpt-voice', 'pet-smoke') },
  { model: 'kokoro-82m', voice: '3' },
  { model: 'qwen3-tts-0.6b', voice: 'pet-reference' },
];
const texts = [
  '你好，今天我们一起测试本地语音。',
  '请在十月一日上午九点提醒我检查任务进度。',
  '本地语音已经启动，请把这个任务交给代码助手。',
];
const report = {
  at, platform: process.platform, arch: process.arch, node: process.version,
  scope: '3 ASR x 3 TTS x 3 Chinese phrases; no dialogue/cloud requests',
  reference: 'GPT and Qwen use the existing synthetic Kokoro sample; stock weights, not a user fine-tuned voice.',
  ...(replay ? { reusedSynthesis: { report: resolve(replayPath), at: replay.at }, note: 'Synthesis timings belong to the original run; ASR is rerun using the exact SHA256-verified WAV files.' } : {}),
  asrModels, ttsModels, texts, officialSamples: [], synthesis: [], transcriptions: [], failures: [],
};
await mkdir(output, { recursive: true });
const reportPath = resolve(output, 'results.json');
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
const normal = value => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu, '');
function cer(expected, actual) {
  const a = Array.from(normal(expected));
  const b = Array.from(normal(actual));
  let previous = b.map((_, i) => i + 1); previous.unshift(0);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    previous = next;
  }
  return Number((previous[b.length] / a.length).toFixed(3));
}
async function checked(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response;
}
async function transcription(model, audio) {
  const form = new FormData();
  form.set('model', model); form.set('language', 'zh'); form.set('response_format', 'verbose_json');
  form.set('file', new Blob([audio], { type: 'audio/wav' }), 'speech.wav');
  const started = performance.now();
  const response = await checked(await fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form, signal: AbortSignal.timeout(180000) }));
  const result = await response.json();
  assert.ok(typeof result.text === 'string' && result.text.trim(), `${model} returned empty text`);
  return { model, ms: Math.round(performance.now() - started), ...result };
}
async function record(name, action) {
  try { await action(); }
  catch (error) { report.failures.push({ name, message: error.message }); console.error(`${name}: ${error.message}`); }
  await save();
}
const catalog = await (await checked(await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) }))).json();
report.gateway = catalog;
const configured = new Set(catalog.models.map(model => model.id));
for (const model of [...asrModels, ...ttsModels.map(item => item.model)]) assert.ok(configured.has(model), `${model} is not configured`);
const fixture = await readFile(resolve(data, 'models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav'));
for (const model of asrModels) await record(`official-sample:${model}`, async () => {
  const result = await transcription(model, fixture);
  report.officialSamples.push(result);
  console.log(`${model} official sample: ${result.ms} ms, ${result.text}`);
});
for (const { model, voice } of ttsModels) {
  for (let phrase = 0; phrase < texts.length; phrase++) {
    let audio;
    await record(`tts:${model}:${phrase + 1}`, async () => {
      let ms;
      if (replay) {
        const original = replay.synthesis.find(item => item.model === model && item.phrase === phrase + 1);
        assert.ok(original && original.input === texts[phrase] && original.voice === voice, 'Replay must contain the same model, voice and phrase.');
        audio = await readFile(original.file);
        assert.equal(createHash('sha256').update(audio).digest('hex'), original.sha256, 'Replay WAV hash changed.');
        ms = original.ms;
      } else {
        const started = performance.now();
        const response = await checked(await fetch(`${base}/v1/audio/speech`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, voice, input: texts[phrase], response_format: 'wav' }),
          signal: AbortSignal.timeout(180000),
        }));
        audio = Buffer.from(await response.arrayBuffer());
        ms = Math.round(performance.now() - started);
      }
      const wave = pcmWave(audio);
      let square = 0, peak = 0;
      for (const sample of wave.samples) { square += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
      const rms = Math.sqrt(square / wave.samples.length);
      assert.ok(rms > 1e-5 && peak > 1e-4, `${model} generated silent audio`);
      const file = resolve(output, `${model}-phrase-${phrase + 1}.wav`);
      await writeFile(file, audio);
      const result = {
        model, voice, phrase: phrase + 1, input: texts[phrase], ms, file,
        bytes: audio.length, sampleRate: wave.sampleRate,
        seconds: Number((wave.samples.length / wave.sampleRate).toFixed(3)),
        rms: Number(rms.toFixed(5)), peak: Number(peak.toFixed(5)),
        sha256: createHash('sha256').update(audio).digest('hex'),
      };
      report.synthesis.push(result);
      console.log(`${model} phrase ${phrase + 1}: ${ms} ms, ${result.seconds}s WAV`);
    });
    if (!audio) continue;
    for (const asr of asrModels) await record(`asr:${asr}:${model}:${phrase + 1}`, async () => {
      const result = await transcription(asr, audio);
      report.transcriptions.push({ ttsModel: model, phrase: phrase + 1, input: texts[phrase], ...result,
        matchesIgnoringPunctuation: normal(texts[phrase]) === normal(result.text),
        literalCer: cer(texts[phrase], result.text),
      });
      console.log(`  ${asr}: ${result.ms} ms, ${result.text}`);
    });
  }
}
report.complete = report.failures.length === 0 && report.synthesis.length === 9 && report.transcriptions.length === 27 && report.officialSamples.length === 3;
report.finishedAt = new Date().toISOString();
await save();
const lines = [
  '# Windows 本地语音审核样本', '',
  `运行时间：${at}。状态：${report.complete ? '六种模型真实推理通过' : '存在失败，见 results.json'}。`, '',
  '此次仅本地验证。所有 WAV 来自实际模型推理；没有发送对话或云端请求。GPT/Qwen 使用合成参考音频与官方预训练权重，用户自己的微调音色仍需单独试听。', '',
  ...(replay ? [`合成音频与 TTS 耗时来自 ${replay.at} 的原始运行，逐文件 SHA256 校验通过。本次复测全部 ASR，以核验 Whisper UTF-8 修复。`, ''] : []),
  '| TTS | 文本 | 合成耗时 | 音频时长 | 采样率 | 样音 |',
  '| --- | --- | --- | --- | --- | --- |',
];
for (const item of report.synthesis) lines.push(`| ${item.model} | ${item.input} | ${item.ms} ms | ${item.seconds} s | ${item.sampleRate} Hz | [试听](${item.file.replace(/\\/g, '/')}) |`);
lines.push('', '每份样音分别交给三种 ASR，总共 27 次回转写。以下保留原始识别文本：', '', '| TTS / 句子 | ASR | 耗时 | 转写 |', '| --- | --- | --- | --- |');
for (const item of report.transcriptions) lines.push(`| ${item.ttsModel} / ${item.phrase} | ${item.model} | ${item.ms} ms | ${item.text.replace(/\|/g, '\\|')} |`);
lines.push('', '耗时包含 HTTP 调用和本次推理，初次模型载入另见官方样例记录。只有三条合成语音，不能作为真实录音识别率的基准。literalCer 只去标点/空格，不合并中文与阿拉伯数字、简繁体等文本差异。', '', '[完整原始结果](results.json)', '');
await writeFile(resolve(output, 'REVIEW.md'), lines.join('\n'));
console.log(`Saved review: ${resolve(output, 'REVIEW.md')}`);
if (!report.complete) process.exitCode = 1;
