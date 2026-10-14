import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { deepseekFlashModel, TEXT_SLOTS } from '../dist/providers/text-protocol.js';
import { defaultManagedSettings, validateManagedSettings } from '../dist/management/settings.js';
import { RegisteredVoiceStore } from '../dist/providers/registered-voices.js';
import { validateTrialConfiguration } from '../dist/app/trial-config.js';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
export function nextTextConfiguration(current) {
  const next = structuredClone(current);
  for (const slot of TEXT_SLOTS) next.models[slot] = deepseekFlashModel(current.models.memory_turn.credentialFile);
  return validateTrialConfiguration(next);
}
export function nextTextSettings(previous, next, savedAt) {
  if (previous.version !== 1 || !previous.current || !Number.isSafeInteger(previous.current.revision)
    || !Array.isArray(previous.history) || previous.history.length > 10) throw Error('Invalid previous settings history');
  const settings = structuredClone(previous.current.settings), defaults = defaultManagedSettings(next);
  for (const slot of TEXT_SLOTS) {
    settings.providers[slot] = defaults.providers[slot];
    if (slot === 'dialogue' && previous.current.settings.providers.dialogue.temperature !== undefined)
      settings.providers.dialogue.temperature = previous.current.settings.providers.dialogue.temperature;
  }
  return {version:1,current:{revision:previous.current.revision+1,savedAt,settings},history:[...previous.history,previous.current].slice(-10)};
}
/** Exact three-slot transition, existing registered Pro credential, unchanged phase/budget/data policy. */
export async function inspectTextUpdate(plan, current, next) {
  if (!plan.textProviderUpdate) return null;
  const update = plan.textProviderUpdate;
  if (update.kind !== 'deepseek-flash-text-v1' || plan.legacyData) throw Error('Invalid text provider transition');
  const expected = nextTextConfiguration(current);
  expected.sourceRevision = next.sourceRevision; expected.runtimeFiles = next.runtimeFiles;
  if (JSON.stringify(expected) !== JSON.stringify(next)) throw Error('Text update exceeds the exact registered three-slot transition');
  const file = resolve(current.projectRoot,'artifacts/W0-I/model-evaluation/trial/user-trial/management-settings.json');
  const before = await readFile(file), after = await readFile(update.nextSettingsFile);
  if (sha(before)!==update.beforeSha256 || sha(after)!==update.afterSha256) throw Error('User settings changed since preparation');
  const previous=JSON.parse(before), prepared=JSON.parse(after);
  if (!prepared.current?.savedAt || JSON.stringify(prepared)!==JSON.stringify(nextTextSettings(previous,next,prepared.current.savedAt))) throw Error('Text update changes unrelated settings or history');
  const voices=await RegisteredVoiceStore.open(resolve(current.projectRoot,'data/desktop-pet/registered-voices.json'));
  validateManagedSettings(previous.current.settings,current,voices);
  for (const item of previous.history) validateManagedSettings(item.settings,current,voices,true);
  validateManagedSettings(prepared.current.settings,next,voices);
  return {file,before,after};
}
/** Adds only the user-authorized exact profile to an already prepared ordinary update. No install or model call. */
export async function prepareTextUpdate(planFile) {
  const plan=JSON.parse(await readFile(planFile)),current=JSON.parse(await readFile(plan.nextConfigFile));
  const next=nextTextConfiguration(current), nextBytes=json(next);
  const settingsFile=resolve(plan.projectRoot,'artifacts/W0-I/model-evaluation/trial/user-trial/management-settings.json');
  const before=await readFile(settingsFile), prepared=nextTextSettings(JSON.parse(before),next,new Date().toISOString());
  const nextSettingsFile=resolve(plan.nextConfigFile,'../next-settings.json'), after=json(prepared);
  await writeFile(nextSettingsFile,after,{flag:'wx',mode:0o600});
  plan.textProviderUpdate={kind:'deepseek-flash-text-v1',nextSettingsFile,beforeSha256:sha(before),afterSha256:sha(after)};
  plan.nextConfigSha256=sha(nextBytes);
  await writeFile(plan.nextConfigFile,nextBytes,{mode:0o600});await writeFile(planFile,json(plan),{mode:0o600});
  return plan;
}
