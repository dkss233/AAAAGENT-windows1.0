import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {prepareTrialUpdate} from '../../../tools/prepare-trial-update.mjs';
import {T3_ENGINE_BUNDLE_SUPPORT_PATHS,isTrialRuntimePath} from '../../../dist/app/trial-config.js';

test('the original complete engine metadata and map enter the exact normal update and rollback plan',async()=>{
  const root='/Users/example/AAAAGENT',candidate=process.cwd();
  assert(candidate.endsWith('/artifacts/worktrees/W0-I-engine-pin-54'));
  const current=JSON.parse(fs.readFileSync(root+'/artifacts/W0-I/model-evaluation/trial/user-trial/config.json'));
  const result=await prepareTrialUpdate({projectRoot:root,candidateRoot:candidate,
    sourceRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    outputDirectory:'artifacts/W0-I/web-execution-56/real-adoption/graph-test-plan'});
  for(const p of T3_ENGINE_BUNDLE_SUPPORT_PATHS){
    assert(isTrialRuntimePath(p));assert(result.plan.files.some(f=>f.path===p),'changed original graph input must be included for install and rollback');
    const hash=createHash('sha256').update(fs.readFileSync(candidate+'/'+p)).digest('hex');
    assert.equal(result.plan.files.find(f=>f.path===p).after,hash);
  }
  assert(!isTrialRuntimePath('artifacts/runtime/engine-pin-54/t3-runtime/auth.json'));
  assert(!isTrialRuntimePath('artifacts/runtime/engine-pin-54/t3-runtime/apps/server/dist/arbitrary.js'));
  assert.equal(result.plan.currentConfigSha256,createHash('sha256').update(fs.readFileSync(root+'/artifacts/W0-I/model-evaluation/trial/user-trial/config.json')).digest('hex'));
  assert.equal(result.plan.projectRoot,current.projectRoot);assert.equal(result.sameDatabase,true);
});
