import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateLocalDialogue } from '../dist/providers/local-dialogue.js';
import { validateTrialConfiguration } from '../dist/app/trial-config.js';
import { updateProviderConfiguration } from './local-speech-config.mjs';

export function parseLocalDialogueArguments(args) {
  const values = new Map(), valued = new Set(['--config', '--url', '--model', '--context', '--input', '--output', '--timeout-ms', '--temperature', '--reasoning']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (values.has(flag) || !valued.has(flag) && flag !== '--off') throw Error('Unknown or duplicate local dialogue option: ' + flag);
    if (flag === '--off') values.set(flag, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error('Missing value for ' + flag);
      values.set(flag, value);
    }
  }
  if (!values.get('--config')) throw Error('--config PATH is required.');
  const configPath = resolve(values.get('--config'));
  if (values.has('--off')) {
    if (values.size !== 2) throw Error('--off accepts only --config.');
    return { configPath, selection: null };
  }
  const reasoning = values.get('--reasoning') ?? 'none';
  if (!['none', 'server'].includes(reasoning)) throw Error('--reasoning must be none or server.');
  const selection = validateLocalDialogue({ baseUrl: values.get('--url') ?? 'http://127.0.0.1:11435/v1', model: values.get('--model'),
    contextWindowTokens: Number(values.get('--context') ?? 16384), inputTokenLimit: Number(values.get('--input') ?? 12000),
    outputTokenLimit: Number(values.get('--output') ?? 768), timeoutMs: Number(values.get('--timeout-ms') ?? 120000),
    ...(values.has('--temperature') ? { temperature: Number(values.get('--temperature')) } : {}),
    ...(reasoning === 'none' ? { reasoningEffort: 'none' } : {}) });
  return { configPath, selection };
}

export async function configureLocalDialogue(configPath, selection) {
  if (selection !== null) selection = validateLocalDialogue(selection);
  return updateProviderConfiguration(configPath, async config => {
    for (const lockPath of [resolve(dirname(configPath), '../../backend.lock'), resolve(config.projectRoot, '.local/model-evaluation/backend.lock')]) {
      try {
        const lock = JSON.parse(await readFile(lockPath, 'utf8'));
        if (Number.isSafeInteger(lock.pid) && lock.pid > 0) { process.kill(lock.pid, 0); throw Error('Quit the running desktop before changing dialogue configuration.'); }
      } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
    }
    if (selection === null) delete config.localDialogue;
    else config.localDialogue = selection;
    return validateTrialConfiguration(config);
  });
}
