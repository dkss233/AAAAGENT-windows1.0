import { test } from 'node:test';
import { isPrivateDirectorySync, isPrivateFileSync } from '../../../dist/core/platform-files.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pcm16Wav } from '../../../dist/media/wav.js';
import { createEngineeringVoiceService } from '../../../workbench/engineering-voice/service.mjs';
function fixture(transcribe=async()=> '  原话 mixed 十二  ') {
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'aaa-engineering-voice-'))), directory=join(dir,'receipts');
  const thread={id:'thread',projectId:'project',modelSelection:{instanceId:'codex',model:'gpt-6.1-sol'},branch:null,worktreePath:null};
  const target={environmentId:'env',projectId:'project',threadId:'thread',draftId:null,captureEpoch:1};
  let calls=0;const state={threads:[thread],projects:[{id:'project',workspaceRoot:dir}],readonly:false,environmentId:'env'};
  const client={environmentDescriptor:async()=>({environmentId:state.environmentId}),shellSnapshot:async()=>state,threadSnapshot:async()=>({thread})};
  const options={directory,client,gate:{targetCapability:async()=>({environmentId:'env',projectId:'project',source:'t3',readonly:state.readonly,providerInstanceId:'codex',nativeSessionId:'native'})},asr:{model:'controlled-asr',transcribe:async(...args)=>{calls++;return transcribe(...args);}}};
  const service=createEngineeringVoiceService(options),wav=pcm16Wav(new Float32Array(160),16000);
  const request={version:'0.1.0',inputId:randomUUID(),target,audio:{wavBase64:Buffer.from(wav).toString('base64')}};
  return {dir,directory,thread,target,state,request,service,reopen:()=>createEngineeringVoiceService(options),calls:()=>calls,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
const signal=()=>new AbortController().signal;
test('raw transcript echoes exact captured target and persists private receipts without audio or companion sends',async()=>{
  let audio;const f=fixture(async(id,bytes)=>{audio=bytes;return '  原话 mixed 十二  ';});try{
    assert.equal(f.service.capabilities().sampleRate,16000);const got=await f.service.transcribe(f.request,signal());assert.equal(got.transcript,'  原话 mixed 十二  ');assert.deepEqual(got.target,f.target);assert.equal(got.status,'completed');
    assert(audio.every(x=>x===0));assert.equal(f.calls(),1);const file=join(f.directory,readdirSync(f.directory)[0]);assert.equal(isPrivateFileSync(file),true);assert.equal(isPrivateDirectorySync(f.directory),true);assert(!readFileSync(file,'utf8').includes('wavBase64'));
    assert.deepEqual(await f.reopen().transcribe(f.request,signal()),got);assert.equal(f.calls(),1);
  }finally{f.cleanup();}
});
test('concurrent same input coalesces and edited bytes or epoch cannot override it',async()=>{
  let release;const f=fixture(()=>new Promise(done=>{release=done;}));try{const first=f.service.transcribe(f.request,signal());const same=f.service.transcribe(f.request,signal());await new Promise(done=>setImmediate(done));
    await assert.rejects(f.service.transcribe({...f.request,target:{...f.target,captureEpoch:2}},signal()),/frozen/);release('exact');assert.deepEqual(await first,await same);assert.equal(f.calls(),1);
  }finally{f.cleanup();}
});
test('target, provider/session/model and draft promotion changes discard late results',async()=>{
  for(const change of ['model','promotion','environment']){let release;const f=fixture(()=>new Promise(done=>{release=done;}));try{
    if(change==='promotion'){f.state.threads=[];f.request.target={...f.target,draftId:'new-draft'};}
    const pending=f.service.transcribe(f.request,signal());await new Promise(done=>setImmediate(done));
    if(change==='model')f.thread.modelSelection.model='changed';if(change==='promotion')f.state.threads=[f.thread];if(change==='environment')f.state.environmentId='changed';release('late');
    const got=await pending;assert.equal(got.status,'discarded');assert.equal(got.transcript,undefined);assert.equal(f.calls(),1);
  }finally{f.cleanup();}}
});
test('cancelled submitted ASR remains unknown and never retries across process restart',async()=>{
  const f=fixture(async(id,bytes,signal)=>{await new Promise((done,reject)=>signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true}));});try{
    const controller=new AbortController(),pending=f.service.transcribe(f.request,controller.signal);await new Promise(done=>setImmediate(done));controller.abort();assert.equal((await pending).status,'unknown');
    assert.equal((await f.reopen().transcribe(f.request,signal())).status,'unknown');assert.equal(f.calls(),1);
  }finally{f.cleanup();}
});
test('orphaned submitted receipt cold reads unknown without another ASR request',async()=>{
  const f=fixture();try{await f.service.transcribe(f.request,signal());const file=join(f.directory,f.request.inputId+'.json'),saved=JSON.parse(readFileSync(file));saved.status='submitted';delete saved.transcript;writeFileSync(file,JSON.stringify(saved));
    assert.equal((await f.reopen().receipt(f.request.inputId,f.target)).status,'unknown');assert.equal(f.calls(),1);await assert.rejects(f.service.receipt(f.request.inputId,{...f.target,threadId:'other'}));
  }finally{f.cleanup();}
});
test('private imported or deleted targets and invalid WAV fail before ASR',async()=>{
  const f=fixture();try{f.state.readonly=true;await assert.rejects(f.service.transcribe(f.request,signal()));f.state.readonly=false;f.state.projects=[];await assert.rejects(f.service.transcribe(f.request,signal()));
    await assert.rejects(f.service.transcribe({...f.request,audio:{wavBase64:Buffer.from('invalid').toString('base64')}},signal()));assert.equal(f.calls(),0);assert.equal(readdirSync(f.directory).length,0);
  }finally{f.cleanup();}
});
test('cold read after original target changes no longer returns old transcript',async()=>{
  const f=fixture();try{await f.service.transcribe(f.request,signal());f.thread.branch='changed';const got=await f.service.receipt(f.request.inputId,f.target);assert.equal(got.status,'discarded');assert.equal(got.transcript,undefined);assert.equal(f.calls(),1);}finally{f.cleanup();}
});
