import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateLocalSpeech } from '../dist/providers/local-speech.js';
import { updateSpeechConfiguration } from './local-speech-config.mjs';
const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!opt('--config')) throw Error('Usage: node tools/configure-local-speech.mjs --config PATH [--asr sensevoice-small] [--tts gpt-sovits --voice pet-smoke] [--off]');
const configPath = resolve(opt('--config'));
const backup = await updateSpeechConfiguration(configPath, async config => {
for (const lockPath of [resolve(dirname(configPath), '../../backend.lock'), resolve(config.projectRoot, '.local/model-evaluation/backend.lock')]) {
  try {
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    if (Number.isSafeInteger(lock.pid) && lock.pid > 0) { process.kill(lock.pid, 0); throw Error('Quit the running desktop before changing speech configuration.'); }
  } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
}
if (args.includes('--off')) delete config.localSpeech;
else config.localSpeech = validateLocalSpeech({ baseUrl: opt('--url') ?? 'http://127.0.0.1:19380/v1',
  ...(opt('--asr') ? { asr: { model: opt('--asr'), language: 'zh' } } : {}),
  ...(opt('--tts') ? { tts: { model: opt('--tts'), voice: opt('--voice') } } : {}) });
  return config;
});
console.log('Local speech selection saved. Restart the desktop after starting the selected local service. Activation status preserved.');
console.log('Backup files: ' + backup.config + ' and ' + backup.activation);
