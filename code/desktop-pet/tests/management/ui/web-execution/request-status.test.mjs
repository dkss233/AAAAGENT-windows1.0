import test from 'node:test';
import assert from 'node:assert/strict';
import {submittedNativeRequests} from '../../../../t3-native/apps/web/src/aaaagent/native-request-status.ts';
const marker={commandId:'command-a',sequence:42,submittedAt:'2026-10-04T00:00:00Z'};
const requested=(kind,requestId,turnId,submitted)=>({kind,turnId,payload:{requestId,...(submitted?{responseSubmitted:marker}:{})}});

test('refresh reads persisted submission by exact current request, without treating stale transport as resolved',()=>{
  const approval=requested('approval.requested','dsh:approval-a','turn-a',true);
  const question=requested('user-input.requested','dsh:question-a','turn-a',true);
  const activities=[approval,question,{kind:'provider.approval.respond.failed',payload:{requestId:'dsh:approval-a',detail:'unknown pending permission request'}}];
  let status=submittedNativeRequests(activities);
  assert.deepEqual([...status.approvals],['dsh:approval-a']);assert.deepEqual([...status.userInputs],['dsh:question-a']);
  status=submittedNativeRequests([...activities,{kind:'approval.resolved',turnId:'turn-a',payload:{requestId:'dsh:approval-a'}}]);
  assert.equal(status.approvals.size,0);assert.equal(status.userInputs.size,1);
});

test('another request or turn keeps its own status and non-DSH markers do not invent a public capability',()=>{
  const status=submittedNativeRequests([
    requested('approval.requested','dsh:previous','turn-a',true),
    requested('approval.requested','dsh:current','turn-b',false),
    requested('user-input.requested','codex:question','turn-b',true),
  ]);
  assert.equal(status.approvals.has('dsh:current'),false);assert.equal(status.approvals.has('dsh:previous'),true);
  assert.equal(status.userInputs.size,0);
});
