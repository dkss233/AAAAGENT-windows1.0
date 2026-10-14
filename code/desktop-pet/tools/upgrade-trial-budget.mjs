// One authorized cumulative limit transition. Requires a quiet runtime; never edits any ledger entry.
import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { validateTrialConfiguration } from '../dist/app/trial-config.js';
import { assertReviewedUnknownCosts } from '../dist/app/trial-authorizer.js';
import { assertTrialQuiescent } from './install-trial-update.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=v=>JSON.stringify(v,null,2)+'\n';
export async function upgradeTrialBudget(root, reviews, {quiescent=assertTrialQuiescent}={}) {
 const configFile=resolve(root,'artifacts/W0-I/model-evaluation/trial/user-trial/config.json'),activationFile=resolve(dirname(configFile),'activation.json');
 const configRaw=await readFile(configFile),activationRaw=await readFile(activationFile),c=validateTrialConfiguration(JSON.parse(configRaw)),activation=JSON.parse(activationRaw);
 if(c.projectRoot!==root||c.limitMicros!==20000000||activation.status!=='active'||activation.configSha256!==sha(configRaw)||activation.phaseId!==c.phaseId)throw Error('Expected unchanged active 20CNY configuration');
 await quiescent(c);
 const lock=await open(c.budgetFile+'.lock','wx');
 const out=resolve(root,'artifacts/W0-I/model-evaluation/budget-60-transition-01');let applied=false;
 try{
  const beforeRaw=await readFile(c.budgetFile),before=JSON.parse(beforeRaw);
  if(before.batchId!==c.budgetBatchId||before.limitMicros!==20000000||before.blocked||before.entries.some(e=>e.status==='reserved'))throw Error('Original ledger is not quiescent');
  if((c.reviewedUnknownCosts??[]).some(old=>!(reviews??[]).some(next=>JSON.stringify(next)===JSON.stringify(old))))throw Error('Existing unknown review must remain');
  const next=validateTrialConfiguration({...c,limitMicros:60000000,reviewedUnknownCosts:reviews});await assertReviewedUnknownCosts(before.entries,next);
  const nextRaw=json(next),ledgerRaw=json({...before,limitMicros:60000000}),activeRaw=json({...activation,configSha256:sha(nextRaw)});
  await mkdir(out);
  for(const [name,raw]of [['config-before.json',configRaw],['activation-before.json',activationRaw],['ledger-before.json',beforeRaw]])await writeFile(resolve(out,name),raw,{mode:0o600,flag:'wx'});
  const audit={kind:'user_authorized_cumulative_budget_transition',status:'prepared',fromMicros:20000000,toMicros:60000000,authorization:'User: 加钱没关系，最后预算不要超60块钱; relayed by supervisor 2026-09-11; cumulative ceiling, not additional allowance',at:new Date().toISOString(),originalEntries:before.entries.length,entriesSha256:sha(JSON.stringify(before.entries)),before:{config:sha(configRaw),activation:sha(activationRaw),ledger:sha(beforeRaw)},after:{config:sha(nextRaw),activation:sha(activeRaw),ledger:sha(ledgerRaw)},oldRuntimeMustRemainStoppedUntilCompatibleInstallation:true};
  await writeFile(resolve(out,'audit.json'),json(audit),{mode:0o600,flag:'wx'});
  const replace=async(file,raw)=>{await writeFile(file+'.budget-next',raw,{mode:0o600,flag:'wx'});await rename(file+'.budget-next',file);};
  try{
   if(!configRaw.equals(await readFile(configFile))||!activationRaw.equals(await readFile(activationFile))||!beforeRaw.equals(await readFile(c.budgetFile)))throw Error('State changed before transition');
   await replace(c.budgetFile,ledgerRaw);await replace(configFile,nextRaw);await replace(activationFile,activeRaw);applied=true;
  }catch(error){await replace(c.budgetFile,beforeRaw);await replace(configFile,configRaw);await replace(activationFile,activationRaw);audit.status='rolled_back';await writeFile(resolve(out,'audit.json'),json(audit),{mode:0o600});throw error;}
  audit.status='applied';await writeFile(resolve(out,'audit.json'),json(audit),{mode:0o600});
  return {status:audit.status,limitMicros:next.limitMicros,entriesUnchanged:JSON.stringify(JSON.parse(await readFile(c.budgetFile)).entries)===JSON.stringify(before.entries)};
 }finally{await lock.close();await unlink(c.budgetFile+'.lock');}
}
