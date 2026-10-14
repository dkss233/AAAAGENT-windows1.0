import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {sha} from './deepseek-text-update.mjs';
import {validateTrialConfiguration} from '../dist/app/trial-config.js';
import {defaultManagedSettings,validateManagedSettings} from '../dist/management/settings.js';
import {RegisteredVoiceStore} from '../dist/providers/registered-voices.js';
const json=value=>JSON.stringify(value,null,2)+'\n';
export function nextVoiceConfiguration(current){
  const next=structuredClone(current), p=next.models.perception;
  next.models.asr={provider:'dashscope',model:'qwen3-asr-flash-2026-02-10',endpoint:p.endpoint,credentialFile:p.credentialFile,
    inputTokenLimit:0,outputTokenLimit:0,inputMicrosPerToken:0,outputMicrosPerToken:0,audioMicrosPerSecond:220,reservationMicros:220};
  p.inputMicrosPerToken=p.model.includes('omni-plus')?7:2.2;
  p.reservationMicros=Math.ceil(p.inputTokenLimit*p.inputMicrosPerToken+p.outputTokenLimit*p.outputMicrosPerToken);
  // Daily operation/phase quotas are retired; the authorizer uses only the original cumulative ledger.
  delete next.operationLimits; delete next.maxCalls; delete next.phaseLimitMicros;
  return validateTrialConfiguration(next);
}
export function nextVoiceSettings(previous,next,savedAt){
  if(previous.version!==1||!Number.isSafeInteger(previous.current?.revision)||!Array.isArray(previous.history))throw Error('Invalid settings history');
  const settings=structuredClone(previous.current.settings),defaults=defaultManagedSettings(next);
  settings.providers.asr=defaults.providers.asr;
  const old=settings.providers.perception,plus=old.model.includes('omni-plus');
  settings.providers.perception={...old,adapterId:'qwen-visual-emotion',inputMicrosPerToken:plus?7:2.2,
    reservationMicros:Math.ceil(196608*(plus?7:2.2)+65536*(plus?40:13.3))};
  return {version:1,current:{revision:previous.current.revision+1,savedAt,settings},history:[...previous.history,previous.current].slice(-10)};
}
export async function inspectVoiceUpdate(plan,current,next){
  if(!plan.voicePipelineUpdate)return null;
  const update=plan.voicePipelineUpdate;
  if(update.kind!=='split-asr-visual-v1'||plan.textProviderUpdate||plan.legacyData)throw Error('Invalid voice transition');
  const expected=nextVoiceConfiguration(current);expected.sourceRevision=next.sourceRevision;expected.runtimeFiles=next.runtimeFiles;
  if(JSON.stringify(expected)!==JSON.stringify(next))throw Error('Voice transition changes unrelated configuration');
  const file=resolve(current.projectRoot,'artifacts/W0-I/model-evaluation/trial/user-trial/management-settings.json');
  const before=await readFile(file),after=await readFile(update.nextSettingsFile),previous=JSON.parse(before),prepared=JSON.parse(after);
  if(sha(before)!==update.beforeSha256||sha(after)!==update.afterSha256||JSON.stringify(prepared)!==JSON.stringify(nextVoiceSettings(previous,next,prepared.current.savedAt)))throw Error('Voice transition changes unrelated settings');
  const voices=await RegisteredVoiceStore.open(resolve(current.projectRoot,'data/desktop-pet/registered-voices.json'));
  validateManagedSettings(previous.current.settings,current,voices);
  for(const item of previous.history)validateManagedSettings(item.settings,current,voices,true);
  validateManagedSettings(prepared.current.settings,next,voices);
  for(const item of prepared.history)validateManagedSettings(item.settings,next,voices,true);
  return {file,before,after};
}
export async function prepareVoiceUpdate(planFile){
  const plan=JSON.parse(await readFile(planFile)),current=JSON.parse(await readFile(plan.nextConfigFile)),next=nextVoiceConfiguration(current),nextBytes=json(next);
  const file=resolve(plan.projectRoot,'artifacts/W0-I/model-evaluation/trial/user-trial/management-settings.json'),before=await readFile(file);
  const after=json(nextVoiceSettings(JSON.parse(before),next,new Date().toISOString())),nextSettingsFile=resolve(plan.nextConfigFile,'../next-settings.json');
  await writeFile(nextSettingsFile,after,{flag:'wx',mode:0o600});
  plan.voicePipelineUpdate={kind:'split-asr-visual-v1',nextSettingsFile,beforeSha256:sha(before),afterSha256:sha(after)};
  plan.nextConfigSha256=sha(nextBytes);await writeFile(plan.nextConfigFile,nextBytes,{mode:0o600});await writeFile(planFile,json(plan),{mode:0o600});return plan;
}
