// Configure an operator-defined OpenAI-compatible TTS endpoint, without editing JSON by hand.
//
// This is the configuration surface for the custom-supplier feature: the reviewed catalogue is a closed
// list, so before this the only way to add a supplier was a source change. The endpoint is printed in
// full before it is saved, because it is the operator's own address and the key will be sent to it.
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateCustomTts } from '../dist/providers/local-speech.js';
import { updateSpeechConfiguration } from './local-speech-config.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const usage = `Usage: node tools/configure-custom-tts.mjs --config PATH --provider NAME --url URL --model MODEL --voice VOICE --credential-ref REF [--timeout-ms N] [--off]

  --provider NAME        供应商名称，2–32 位小写字母/数字/下划线/连字符（例如 siliconflow）
  --url URL              服务地址，必须指向 /v1（例如 https://api.siliconflow.cn/v1）
  --model MODEL          模型名（例如 FunAudioLLM/CosyVoice2-0.5B）
  --voice VOICE          音色名（例如 alex）
  --credential-ref REF   已保存的 API Key 引用（在控制台「设置」里保存后可见）
  --off                  清除自定义语音设置，回到已登记的服务商

必须先退出正在运行的桌宠，改完需重启。`;

if (!opt('--config')) throw Error(usage);
const configPath = resolve(opt('--config'));

if (!args.includes('--off')) {
  const provider = opt('--provider'), url = opt('--url'), model = opt('--model'), voice = opt('--voice');
  const credentialRef = opt('--credential-ref'), timeoutMs = opt('--timeout-ms');
  const missing = [['--provider', provider], ['--url', url], ['--model', model], ['--voice', voice], ['--credential-ref', credentialRef]]
    .filter(([, value]) => value === undefined).map(([name]) => name);
  if (missing.length) throw Error('缺少参数：' + missing.join('、') + '\n\n' + usage);
  // Validate before writing so a bad address is refused while the operator is still looking at it.
  const validated = validateCustomTts({ provider, baseUrl: url, model, voice, credentialRef,
    ...(timeoutMs === undefined ? {} : { timeoutMs: Number(timeoutMs) }) });
  console.log('即将保存的自定义语音设置：');
  console.log('  供应商    : ' + validated.provider);
  console.log('  请求地址  : ' + validated.baseUrl + '/audio/speech');
  console.log('  模型/音色 : ' + validated.model + ' / ' + validated.voice);
  console.log('  凭据引用  : ' + validated.credentialRef);
  console.log('  超时      : ' + (validated.timeoutMs ?? 120000) + ' ms');
  console.log('');
  console.log('⚠ 合成时会把该凭据发送到上面这个地址。请确认它是你信任的服务商。');
  console.log('');
}

const backup = await updateSpeechConfiguration(configPath, async (config) => {
  for (const lockPath of [resolve(dirname(configPath), '../../backend.lock'), resolve(config.projectRoot, '.local/model-evaluation/backend.lock')]) {
    try {
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      if (Number.isSafeInteger(lock.pid) && lock.pid > 0) { process.kill(lock.pid, 0); throw Error('请先退出正在运行的桌宠，再修改语音设置。'); }
    } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
  }
  if (args.includes('--off')) {
    delete config.customTts;
    return config;
  }
  config.customTts = validateCustomTts({ provider: opt('--provider'), baseUrl: opt('--url'), model: opt('--model'),
    voice: opt('--voice'), credentialRef: opt('--credential-ref'),
    ...(opt('--timeout-ms') === undefined ? {} : { timeoutMs: Number(opt('--timeout-ms')) }) });
  return config;
});

console.log('自定义语音设置已保存。重启桌宠后生效。');
console.log('备份文件: ' + backup.config + ' 和 ' + backup.activation);
console.log('');
console.log('要在合成时使用它，还需在桌宠控制台的「设置」里把语音槽位选为「自定义语音」。');
