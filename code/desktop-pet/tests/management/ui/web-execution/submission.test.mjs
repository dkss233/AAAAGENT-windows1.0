import test from 'node:test';
import assert from 'node:assert/strict';
import {readNativeSubmission,rememberNativeSubmission,clearNativeSubmission} from '../../../../t3-native/apps/web/src/aaaagent/native-submission.ts';
function storage(){const values=new Map();return{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values};}
const identity={environmentId:'env-a',threadId:'thread-a',commandId:'command-a'};

test('unresolved identity survives refresh and blocks another submission to the same exact thread',()=>{
  const store=storage();assert.equal(rememberNativeSubmission(identity,store),true);
  assert.deepEqual(readNativeSubmission('env-a','thread-a',store),identity);
  assert.equal(rememberNativeSubmission({...identity,commandId:'new-command'},store),false);
  assert.deepEqual(readNativeSubmission('env-a','thread-a',store),identity);
  assert.equal(readNativeSubmission('other-env','thread-a',store),null);
  assert.equal(readNativeSubmission('env-a','other-thread',store),null);
  assert.deepEqual([...store.values.values()].map(JSON.parse),[identity]);
});

test('only the exact resolved receipt can clear an unresolved command identity',()=>{
  const store=storage();rememberNativeSubmission(identity,store);
  clearNativeSubmission({...identity,commandId:'other'},store);
  assert.deepEqual(readNativeSubmission('env-a','thread-a',store),identity);
  clearNativeSubmission(identity,store);assert.equal(readNativeSubmission('env-a','thread-a',store),null);
});

test('unavailable identity storage refuses a new dispatch rather than losing recovery state',()=>{
  assert.equal(rememberNativeSubmission(identity,{getItem(){throw new Error('unavailable');},setItem(){throw new Error('unavailable');}}),false);
  const store=storage();rememberNativeSubmission(identity,store);store.removeItem=()=>{throw new Error('blocked');};
  assert.doesNotThrow(()=>clearNativeSubmission(identity,store));
  assert.deepEqual(readNativeSubmission('env-a','thread-a',store),identity);
});
