import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeThreadCommandReceipt, readThreadCommandReceipt } from '../../../../t3-native/apps/web/src/aaaagent/native-command-receipt.ts';

const identity = {commandId:'command-a',threadId:'thread-a'};
const receipt = {commandId:'command-a',aggregateKind:'thread',aggregateId:'thread-a',acceptedAt:'2026-10-03T08:00:00.000Z',resultSequence:7,status:'accepted'};

test('cold read accepts only the original command and thread receipt',()=>{
  assert.deepEqual(decodeThreadCommandReceipt(receipt,identity),{status:'accepted',sequence:7});
  assert.deepEqual(decodeThreadCommandReceipt({...receipt,status:'rejected'},identity),{status:'rejected',sequence:7});
  for (const value of [null,{}, {...receipt,commandId:'another-command'}, {...receipt,aggregateId:'another-thread'}, {...receipt,aggregateKind:'project'}, {...receipt,status:'pending'}, {...receipt,acceptedAt:'invalid'}, {...receipt,resultSequence:-1}, {...receipt,resultSequence:0.5}]) {
    assert.deepEqual(decodeThreadCommandReceipt(value,identity),{status:'unknown'});
  }
});

test('missing first receipt causes one authenticated read and no dispatch or replay',async()=>{
  const calls=[];
  const request=async(url,options)=>{calls.push({url,options});return new Response('null',{status:200});};
  assert.deepEqual(await readThreadCommandReceipt(identity,request),{status:'unknown'});
  assert.deepEqual(calls,[{url:'/api/orchestration/commands/command-a/receipt',options:{method:'GET',credentials:'same-origin',cache:'no-store'}}]);
  assert.equal(calls.length,1);
});

test('auth loss, network loss and malformed reads retain uncertainty without retry',async()=>{
  for (const [request,expected] of [
    [async()=>new Response('',{status:401}),{status:'unavailable',authenticationExpired:true}],
    [async()=>new Response('',{status:403}),{status:'unavailable',authenticationExpired:true}],
    [async()=>new Response('',{status:502}),{status:'unavailable',authenticationExpired:false}],
    [async()=>{throw new Error('offline');},{status:'unavailable',authenticationExpired:false}],
    [async()=>new Response('not-json',{status:200}),{status:'unavailable',authenticationExpired:false}],
  ]) {
    let count=0;
    assert.deepEqual(await readThreadCommandReceipt(identity,async(...args)=>{count++;return request(...args);}),expected);
    assert.equal(count,1);
  }
});
