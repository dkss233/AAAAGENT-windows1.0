import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryTurnInput } from '../../contracts/memory-lifecycle.js';
import { fixture, scope, message, change, NOW } from './sqlite-fixture.js';
import { lifecycle, none, signal, contextOptions } from './lifecycle-fixture.js';

/** Point the lifecycle diagnostic at the fixture directory so the recorded skip count is observable. */
function diagnosticIn(directory: string): () => void {
  const prior = process.env.PET_TRIAL_CONFIG;
  process.env.PET_TRIAL_CONFIG = join(directory, 'config.json');
  return () => { if (prior === undefined) delete process.env.PET_TRIAL_CONFIG; else process.env.PET_TRIAL_CONFIG = prior; };
}

test('a recent summary whose coverage exceeds the raw budget is skipped whole instead of rejecting the turn',async t=>{
  const f=fixture();t.after(f.cleanup);t.after(diagnosticIn(f.directory));const store=f.open();
  store.append(scope(),[message('m1','那次面试失败了'),message('m2','面试让我失望'),message('m3','我还在想那次面试')]);
  store.recordDerived(scope(),{id:'rsum',kind:'summary',text:'用户面试失败了',sourceIds:['m1','m2','m3'],createdAt:NOW});
  store.append(scope(),[message('m4','今天天气一般'),message('m5','再说说面试')]);
  let seen!:MemoryTurnInput;
  const port=lifecycle(store,async input=>{seen=input;return none(input);},undefined,{context:{...contextOptions,maxRecentMessages:2}});
  const outcome=await port.prepareTurn(scope(),'m5','再说说面试',signal());
  // The turn is ordinary maintenance: the summary bundle (summary + 3 raw ancestors) does not fit the
  // budget of 2, so it is dropped as one unit and the turn still completes with the recent window.
  assert.equal(outcome.status,'unchanged',outcome.rejectionCode??'');
  assert.deepEqual(seen.messages.map(entry=>entry.id),['m4','m5']);
  const log=readFileSync(join(f.directory,'memory-lifecycle.log'),'utf8');
  assert.match(log,/transcripts=2 summaries=0 memories=0 sources=2 omitted=4/);
});

test('a window candidate whose evidence does not fit is skipped whole and recorded instead of rejecting the turn',async t=>{
  const f=fixture();t.after(f.cleanup);t.after(diagnosticIn(f.directory));const store=f.open();
  store.append(scope(),[message('cited','我喜欢猫')]);store.apply(change({type:'add',id:'cat',text:'用户喜欢猫',sourceIds:['cited']},'add-cat'));
  store.append(scope(),[message('current','今天随便聊聊')]);
  let seen!:MemoryTurnInput;
  const port=lifecycle(store,async input=>{seen=input;return none(input);},undefined,{context:{...contextOptions,maxRecentMessages:4,maxMemories:0}});
  const outcome=await port.prepareTurn(scope(),'current','今天随便聊聊',signal());
  assert.equal(outcome.status,'unchanged',outcome.rejectionCode??'');
  // The older turn is only a window candidate; its cited memory cannot fit, so the whole candidate is
  // dropped. The turn still reaches the planner instead of being rejected for the sample.
  assert.deepEqual(seen.messages.map(entry=>entry.id),['current']);
  const log=readFileSync(join(f.directory,'memory-lifecycle.log'),'utf8');
  assert.match(log,/omitted=2/);
  assert.match(log,/window=0\/4/);
});
