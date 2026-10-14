import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {runAudition,checkReference,redact,uploadReference} from '../../tools/minimax-voice-audition.mjs';import {pcm16Wav,inspectPcmWav,joinPcmWav} from '../../dist/media/wav.js';
const sentence='今天的事先放一放。喝点水，早点休息，明天再慢慢来，好吗？';
const parent=resolve('../../artifacts/W0-I/dania-minimax-audition-01/tmp');
async function directory(t){await mkdir(parent,{recursive:true});const d=await mkdtemp(parent+'/test-');t.after(()=>rm(d,{recursive:true,force:true}));return d;}
for(const failure of ['none','permission','transport','invalid_demo','sensitive'])test('single MiniMax clone demo: '+failure,async t=>{
  const dir=await directory(t),budgetFile=resolve(dir,'budget.json');const history={operationId:'prior',model:'old',reservedMicros:10,actualMicros:5,status:'settled'};
  await writeFile(budgetFile,JSON.stringify({batchId:'synthetic',currency:'CNY',limitMicros:20000000,blocked:false,entries:[history]}));
  const reference={url:'oss://synthetic/input.wav',sha256:'a'.repeat(64)};
  const plan={outputDirectory:resolve(dir,'result'),reference,budgetFile,budgetBatchId:'synthetic',credentialRef:'synthetic',request:{model:'MiniMax/speech-2.8-hd',input:{action:'voice_clone',voice_id:'DaniaMiniMaxSynthetic2026',audio_url:reference.url,text:sentence,language_boost:'Chinese'}}};
  let posts=0,downloads=0;
  const result=await runAudition(plan,()=> 'synthetic-key',async(_url,init)=>{
    if(init.method==='POST'){
      posts++;assert.equal(init.headers['X-DashScope-OssResourceResolve'],'enable');assert.equal(JSON.parse(init.body).model,'MiniMax/speech-2.8-hd');
      if(failure==='transport')throw Error('Transport timeout');
      return Response.json({output:{base_resp:{status_code:failure==='permission'?2038:0,status_msg:failure==='permission'?'no cloning permission':'success'},input_sensitive:failure==='sensitive',input_sensitive_type:failure==='sensitive'?7:0,demo_audio:'https://synthetic.invalid/demo?Signature=SECRET'},usage:{characters:failure==='permission'?0:51}});
    }
    downloads++;assert.equal(init.headers,undefined);return new Response('synthetic bytes');
  },async()=>{if(failure==='invalid_demo')throw Error('Invalid MP3');return{format:'mp3',durationMs:6000,sampleRate:32000,channels:1,codec:'mp3'};});
  assert.equal(posts,1);assert.equal(downloads,['none','invalid_demo'].includes(failure)?1:0);assert.equal(result.status,failure==='none'?'clone_demo_ready_for_user_listening':'failed_stopped_no_retry');
  assert.equal(result.historicalLedgerUnchanged,true);assert.deepEqual(JSON.parse(await readFile(budgetFile)).entries[0],history);
  assert.equal(result.entries[0].actualMicros,failure==='transport'?null:failure==='permission'?0:17850);
  if(failure==='invalid_demo')assert.equal(await readFile(resolve(plan.outputDirectory,'demo-original.bin'),'utf8'),'synthetic bytes');
  assert.doesNotMatch(JSON.stringify(result),/Signature|SECRET|synthetic-key/);assert.equal(result.playback,false);assert.equal(result.installed,false);
  await assert.rejects(runAudition(plan,()=> 'unused',async()=>{throw Error('No retry');}),{code:'EEXIST'});
});
test('reference duration and original-source declarations fail before transport',async t=>{
  const dir=await directory(t),file=resolve(dir,'reference.wav'),wav=pcm16Wav(new Float32Array(32000*6.74),32000);await writeFile(file,wav);
  const ref={file,url:'https://synthetic.invalid/original.wav',sha256:createHash('sha256').update(wav).digest('hex'),source:'ModelScope/villia/dania-original',generated:false,concatenated:false};
  await assert.rejects(checkReference(ref),/10s/);await assert.rejects(checkReference({...ref,generated:true}),/original/);await assert.rejects(checkReference({...ref,concatenated:true}),/original/);
});
test('error codes stay visible while returned credentials and signed URLs are removed',()=>{
  assert.equal(redact('<Code>SignatureDoesNotMatch</Code><SignatureProvided>secret</SignatureProvided><OSSAccessKeyId>private</OSSAccessKeyId>'),'<Code>SignatureDoesNotMatch</Code><SignatureProvided>[redacted]</SignatureProvided><OSSAccessKeyId>[redacted]</OSSAccessKeyId>');
  assert.deepEqual(redact({output:{base_resp:{status_code:2038,status_msg:'no cloning permission'},demo_audio:'https://private.invalid/?Signature=SECRET'},policy:'secret',request_id:'id'}),{output:{base_resp:{status_code:2038,status_msg:'no cloning permission'},demo_audio:'[redacted]'},policy:'[redacted]',request_id:'id'});
});
for(const kind of ['success','foreign_policy','upload_failure'])test('private reference upload: '+kind,async t=>{
  const dir=await directory(t),file=resolve(dir,'reference.wav'),bytes=pcm16Wav(new Float32Array(24000*11),24000);await writeFile(file,bytes);
  const reference={file,sha256:createHash('sha256').update(bytes).digest('hex'),source:'ModelScope/villia/dania-original',generated:false,concatenated:false};
  let calls=0;const result=await uploadReference(reference,()=> 'synthetic-bearer',resolve(dir,'upload'),async(url,init)=>{
    calls++;
    if(calls===1){assert.match(url,/model=MiniMax%2Fspeech-2.8-hd$/);assert.equal(init.headers.Authorization,'Bearer synthetic-bearer');
      return Response.json({data:{upload_host:kind==='foreign_policy'?'https://foreign.invalid':'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com',upload_dir:'dashscope-instant/synthetic/path',policy:'private-policy',signature:'private-signature',oss_access_key_id:'private-access',expire_in_seconds:300,x_oss_object_acl:'private',x_oss_forbid_overwrite:'true'}});}
    assert.equal(url,'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com/');assert.equal(init.headers,undefined);assert.equal(init.redirect,'error');
    assert.equal([...init.body.keys()].at(-1),'file');assert.equal(init.body.get('x-oss-object-acl'),'private');assert.equal(init.body.get('x-oss-forbid-overwrite'),'true');
    assert.deepEqual(Buffer.from(await init.body.get('file').arrayBuffer()),Buffer.from(bytes));
    return new Response('',{status:kind==='upload_failure'?403:200});
  });
  assert.equal(calls,kind==='foreign_policy'?1:2);assert.equal(result.status,kind==='success'?'uploaded_private_reference_clone_compatibility_unverified':'failed_stopped_no_retry');
  assert.doesNotMatch(JSON.stringify(result),/private-policy|private-signature|private-access|synthetic-bearer/);assert.equal(result.modelCalls,0);
  if(kind==='success'){const persisted=JSON.parse(await readFile(resolve(dir,'upload/reference.json')));assert.match(persisted.url,/^oss:\/\/dashscope-instant\/synthetic\/path\/dania-/);assert.equal((await checkReference(persisted)).durationMs,11000);}
  await assert.rejects(uploadReference(reference,()=> 'unused',resolve(dir,'upload'),async()=>{throw Error('No repeat upload');}),{code:'EEXIST'});
});
test('adjacent original slices require exact names, frame boundaries, inventory, and unchanged reconstructed PCM',async t=>{
  const dir=await directory(t),hash=b=>createHash('sha256').update(b).digest('hex'),parts=[],clips=[];
  for(let i=0;i<2;i++){
    const startFrame=i*192000,endFrame=(i+1)*192000,archivePath=`source.wav_${String(startFrame).padStart(10,'0')}_${String(endFrame).padStart(10,'0')}.wav`,file=resolve(dir,archivePath);
    const samples=new Float32Array(192000).fill(i?.125:-.125);if(i===1)samples.fill(0,0,32000);
    const clip=pcm16Wav(samples,32000);await writeFile(file,clip);clips.push(clip);
    parts.push({file,archivePath,startFrame,endFrame,sha256:hash(clip),pcmSha256:hash(inspectPcmWav(clip).data)});
  }
  const archiveSha256='3cef696c6af5eb397431bacb4a24fc3e4c0db5f38923caa27f73c0e022743ea6';
  const inventoryFile=resolve(dir,'inventory.json'),inventory=JSON.stringify({summary:{archive_sha256:archiveSha256,all_entries_read_successfully:true},files:parts.map(p=>({archive_path:p.archivePath,sha256:p.sha256,frames:p.endFrame-p.startFrame}))});await writeFile(inventoryFile,inventory);
  const combined=joinPcmWav(clips),file=resolve(dir,'combined.wav');await writeFile(file,combined);
  const ref={file,source:'ModelScope/villia/dania-original',sha256:hash(combined),generated:false,concatenated:true,url:'https://synthetic.invalid/original.wav',composition:{method:'adjacent_source_slices',archiveSha256,sourceName:'source.wav',parts,inventoryFile,inventorySha256:hash(inventory),outputPcmSha256:hash(inspectPcmWav(combined).data)}};
  assert.equal((await checkReference(ref)).durationMs,12000);
  for(const change of [c=>c.sourceName='different.wav',c=>c.parts[1].startFrame++,c=>c.parts.reverse(),c=>c.parts[0].sha256='a'.repeat(64),c=>c.outputPcmSha256='a'.repeat(64)]){
    const invalid=structuredClone(ref);change(invalid.composition);await assert.rejects(checkReference(invalid));
  }
  const trimmed=joinPcmWav([clips[0],pcm16Wav(new Float32Array(160000).fill(.125),32000)]);
  await writeFile(file,trimmed);const trimmedRef={...ref,sha256:hash(trimmed),composition:{...ref.composition,removedSilenceRanges:[{startFrame:192000,endFrame:224000}],outputPcmSha256:hash(inspectPcmWav(trimmed).data)}};
  assert.equal((await checkReference(trimmedRef)).durationMs,11000);
  for(const ranges of [[{startFrame:0,endFrame:32000}],[{startFrame:192000,endFrame:212000},{startFrame:200000,endFrame:224000}]])await assert.rejects(checkReference({...trimmedRef,composition:{...trimmedRef.composition,removedSilenceRanges:ranges}}),/silence|Silence/);
  const altered=combined.slice();altered[100]^=1;await writeFile(file,altered);await assert.rejects(checkReference({...ref,sha256:hash(altered)}),/PCM/);
});
