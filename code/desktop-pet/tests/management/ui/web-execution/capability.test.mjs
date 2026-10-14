import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeNativeExecutionCapability,decodeNativeTargetCapability,nativeProviderForSelection,allowsNativeCommand,nativeTurnObservationReason} from '../../../../t3-native/apps/web/src/aaaagent/native-execution-capability.ts';

const now=Date.parse('2026-10-03T08:00:00Z'),expiresAt='2026-10-03T08:01:00Z';
const provider={providerInstanceId:'codex-current',send:true,continue:true,modelSelection:true,runtimeModes:['approval-required'],attachments:{file:true,image:false,maxBytes:4096},interrupt:true,approval:true,userInput:true};
const commands=['thread.create','thread.turn.start','thread.turn.interrupt','thread.runtime-mode.set','thread.approval.respond','thread.user-input.respond'];
const capability={apiVersion:1,version:'0.2.0',environmentId:'env-a',expiresAt,mode:'native-operate',commandTypes:commands,providers:[provider]};
const target={apiVersion:1,version:'0.2.0',environmentId:'env-a',projectId:'project-a',threadId:'thread-a',providerInstanceId:'codex-current',nativeSessionId:'native-a',source:'t3',readonly:false,reason:null,commandTypes:commands,expiresAt};
const selection={environmentId:'env-a',projectId:'project-a',threadId:'thread-a',providerInstanceId:'codex-current',routeKind:'server'};

test('capability decoders require the published version, exact environment/target and live session expiry',()=>{
  assert.deepEqual(decodeNativeExecutionCapability(capability,'env-a',now),capability);
  assert.deepEqual(decodeNativeTargetCapability(target,'env-a','thread-a',now),target);
  for(const bad of [null,{...capability,version:'0.1.0'},{...capability,environmentId:'other'},{...capability,expiresAt:new Date(now).toISOString()},{...capability,providers:[provider,provider]},{...capability,providers:[{...provider,send:'true'}]},{...capability,providers:[{...provider,attachments:{...provider.attachments,maxBytes:-1}}]}])assert.equal(decodeNativeExecutionCapability(bad,'env-a',now),null);
  assert.equal(decodeNativeTargetCapability({...target,threadId:'other'},'env-a','thread-a',now),null);
  assert.equal(decodeNativeTargetCapability({...target,nativeSessionId:42},'env-a','thread-a',now),null);
});

test('provider support alone cannot unlock an existing App, external or unverified thread',()=>{
  assert.equal(nativeProviderForSelection(capability,null,selection,now),null);
  for(const closed of [
    {...target,source:'codex-app',readonly:true,reason:'external_owner_unavailable',commandTypes:[]},
    {...target,source:'external',readonly:true,reason:'binding_unverified',commandTypes:[]},
    {...target,source:'unknown'}, {...target,nativeSessionId:null}, {...target,nativeSessionId:''}, {...target,projectId:'other-project'}, {...target,providerInstanceId:'other-instance'}, {...target,expiresAt:new Date(now).toISOString()},
  ])assert.equal(allowsNativeCommand(capability,closed,selection,'thread.turn.start',now),false);
});

test('existing turns require both command sets and exact provider continuation capability',()=>{
  assert.equal(allowsNativeCommand(capability,target,selection,'thread.turn.start',now),true);
  assert.equal(allowsNativeCommand({...capability,commandTypes:[]},target,selection,'thread.turn.start',now),false);
  assert.equal(allowsNativeCommand(capability,{...target,commandTypes:[]},selection,'thread.turn.start',now),false);
  assert.equal(allowsNativeCommand({...capability,providers:[{...provider,continue:false}]},target,selection,'thread.turn.start',now),false);
  assert.equal(allowsNativeCommand({...capability,mode:'native-read'},target,selection,'thread.turn.start',now),false);
  assert.equal(allowsNativeCommand(capability,target,selection,'project.create',now),false);
});

test('a live capability keeps imported App provenance and original SID while enabling continuation',()=>{
  const shared={...target,source:'codex-app'};
  assert.equal(decodeNativeTargetCapability(shared,'env-a','thread-a',now)?.source,'codex-app');
  assert.equal(allowsNativeCommand(capability,shared,selection,'thread.turn.start',now),true);
  assert.equal(allowsNativeCommand(capability,{...shared,readonly:true},selection,'thread.turn.start',now),false);
  assert.equal(allowsNativeCommand(capability,{...shared,nativeSessionId:null},selection,'thread.turn.start',now),false);
});

test('new drafts use send support and an existing project without pretending to continue a native SID',()=>{
  const draft={...selection,routeKind:'draft'};
  assert.equal(allowsNativeCommand(capability,null,draft,'thread.turn.start',now),true);
  assert.equal(allowsNativeCommand(capability,null,draft,'thread.create',now),true);
  assert.equal(allowsNativeCommand(capability,null,{...draft,projectId:null},'thread.turn.start',now),false);
  assert.equal(allowsNativeCommand({...capability,providers:[{...provider,send:false}]},null,draft,'thread.turn.start',now),false);
  assert.equal(allowsNativeCommand(capability,null,draft,'thread.turn.interrupt',now),false);
});

test('approval, answers and interrupt remain closed when a provider lacks those original interfaces',()=>{
  const closed={...capability,providers:[{...provider,approval:false,userInput:false,interrupt:false}]};
  for(const command of ['thread.approval.respond','thread.user-input.respond','thread.turn.interrupt'])assert.equal(allowsNativeCommand(closed,target,selection,command,now),false);
});

test('explicit native unknown/busy observations close only new turns and preserve exact request commands',()=>{
  const ready={nativeId:'native-a',instanceId:'codex-current',status:'ready'};
  assert.equal(allowsNativeCommand(capability,target,{...selection,nativeSessionObservation:ready},'thread.turn.start',now),true);
  for(const observation of [null,undefined])assert.equal(allowsNativeCommand(capability,target,{...selection,nativeSessionObservation:observation},'thread.turn.start',now),true,'no observation does not invent a native state');
  for(const observation of [
    {...ready,status:'unknown'}, {...ready,status:'running'}, {...ready,status:'waiting_approval'}, {...ready,status:'waiting_answer'},
    {...ready,nativeId:'other-native'}, {...ready,instanceId:'other-instance'}, {...ready,status:'invented'}, {},
  ]){
    const observed={...selection,nativeSessionObservation:observation};
    assert.equal(allowsNativeCommand(capability,target,observed,'thread.turn.start',now),false);
    assert.ok(nativeTurnObservationReason(target,observed));
    for(const command of ['thread.approval.respond','thread.user-input.respond','thread.turn.interrupt'])assert.equal(allowsNativeCommand(capability,target,observed,command,now),true);
    assert.equal(allowsNativeCommand(capability,null,{...observed,routeKind:'draft'},'thread.turn.start',now),true);
  }
});
