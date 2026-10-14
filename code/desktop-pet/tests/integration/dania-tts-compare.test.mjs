import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {runComparison,requests,checkLedger,inspectSource,prefix,characterUpperBound} from '../../tools/dania-tts-compare.mjs';
import {uploadReference} from '../../tools/minimax-voice-audition.mjs';
import {pcm16Wav,inspectPcmWav,joinPcmWav} from '../../dist/media/wav.js';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function dir(t){const parent=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../artifacts/W0-I/dania-tts-compare-01/tmp');await mkdir(parent,{recursive:true});const d=await mkdtemp(parent+'/test-');t.after(()=>rm(d,{recursive:true,force:true}));return d;}
const historical=()=>({batchId:'synthetic',currency:'CNY',limitMicros:20000000,blocked:false,entries:[{operationId:'old:settled',model:'old',reservedMicros:3000000,actualMicros:2144189,status:'settled'},{operationId:'old:unknown',model:'old-HD',reservedMicros:10000000,actualMicros:null,status:'unknown'}]});
for(const provider of ['qwen','minimax'])for(const failure of [false,true])test(provider+' single bounded audition preserves unknown history; failure='+failure,async t=>{
 const d=await dir(t),budgetFile=d+'/budget.json',before=JSON.stringify(historical());await writeFile(budgetFile,before);
 const reference={url:'oss://synthetic/ref.wav',sha256:'a'.repeat(64)},voiceId=provider==='minimax'?'DaniaCompareSynthetic2026':null;
 const plan={provider,budgetFile,budgetBatchId:'synthetic',ledgerSha256:sha(before),reference,referenceInspection:{durationMs:20930},voiceId,requests:requests(provider,reference,20930,voiceId),outputDirectory:d+'/result',credentialRef:'synthetic'};
 let posts=0,downloads=0;const wav=pcm16Wav(new Float32Array(24000*2).fill(.1),24000);
 const fetcher=async(url,init)=>{
  if(init.method==='POST'){
   posts++;const body=JSON.parse(init.body);
   if(failure)return Response.json({code:'InvalidParameter',message:'product not activated',request_id:'synthetic-failure'},{status:400});
   if(provider==='qwen'&&posts===1){assert.equal(body.input.max_prompt_audio_length,20.93);assert.equal(body.input.url,reference.url);assert.equal(init.headers['X-DashScope-OssResourceResolve'],'enable');return Response.json({output:{voice_id:'qwen-audio-3.0-tts-plus-daniacmp-synthetic'},usage:{count:1}});}
   if(provider==='qwen'){assert.equal(body.input.voice,'qwen-audio-3.0-tts-plus-daniacmp-synthetic');assert.equal(init.headers['X-DashScope-OssResourceResolve'],undefined);return Response.json({output:{finish_reason:'stop',audio:{url:'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/synthetic%20clip.wav?Signature=a%2Bb%3D'}},usage:{characters:51}});}
   assert.equal(body.model,'MiniMax/speech-2.8-turbo');assert.equal(body.input.action,'voice_clone');assert.equal(init.headers['X-DashScope-OssResourceResolve'],'enable');return Response.json({output:{base_resp:{status_code:0},input_sensitive:false,input_sensitive_type:0,demo_audio:'https://synthetic.invalid/audio'},usage:{characters:29}});
  }
  downloads++;assert.equal(init.headers,undefined);if(provider==='qwen')assert.equal(url,'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/synthetic%20clip.wav?Signature=a%2Bb%3D');return new Response(wav);
 };
 const r=await runComparison(plan,()=> 'synthetic',fetcher,()=>({format:'wav',durationMs:2000,sampleRate:24000,channels:1}));
 assert.equal(r.status,failure?'failed_stopped_no_retry':'sample_ready_for_user_listening');assert.equal(posts,failure?1:provider==='qwen'?2:1);assert.equal(downloads,failure?0:1);assert.equal(r.historicalLedgerUnchanged,true);
 const after=JSON.parse(await readFile(budgetFile));assert.deepEqual(after.entries.slice(0,2),historical().entries);assert.ok(after.entries.slice(2).every(e=>e.reservedMicros<20000));
 assert.equal(after.entries[2].actualMicros,provider==='qwen'?0:failure?null:5800);assert.equal(r.playback,false);assert.equal(r.installed,false);
 await assert.rejects(runComparison(plan,()=> 'unused',fetcher),{code:'EEXIST'});assert.equal(posts,failure?1:provider==='qwen'?2:1);
});
test('ledger counts unknown balance, rejects active/repeat/malformed and insufficient state',()=>{
 assert.equal(checkLedger(historical(),'synthetic','qwen'),7855811);assert.equal(characterUpperBound,56);
 for(const mutate of [s=>s.entries[1].status='reserved',s=>s.entries[1].operationId=prefix+'qwen:create',s=>s.entries[1].actualMicros=0,s=>s.entries[1].reservedMicros=19000000,s=>s.blocked=true]){const s=historical();mutate(s);assert.throws(()=>checkLedger(s,'synthetic','qwen'));}
});
test('four source slices retain explicit missing ranges and permit only recorded zero deletion',async t=>{
 const d=await dir(t),parts=[],clips=[],gaps=[];let start=0;
 for(let i=0;i<4;i++){
  if(i===2||i===3){const end=start+320;gaps.push({startFrame:start,endFrame:end});start=end;}
  const end=start+172800,name='source.wav_'+String(start).padStart(10,'0')+'_'+String(end).padStart(10,'0')+'.wav';const samples=new Float32Array(172800).fill(.2);if(i===0)samples.fill(0,0,32000);
  const bytes=pcm16Wav(samples,32000),file=d+'/'+name;await writeFile(file,bytes);clips.push(bytes);parts.push({file,archivePath:name,startFrame:start,endFrame:end,sha256:sha(bytes),pcmSha256:sha(inspectPcmWav(bytes).data)});start=end;
 }
 const archiveSha256='3cef696c6af5eb397431bacb4a24fc3e4c0db5f38923caa27f73c0e022743ea6',inventoryFile=d+'/inventory.json',inventory=JSON.stringify({summary:{archive_sha256:archiveSha256,all_entries_read_successfully:true},files:parts.map(p=>({archive_path:p.archivePath,sha256:p.sha256,frames:p.endFrame-p.startFrame}))});await writeFile(inventoryFile,inventory);
 const kept=joinPcmWav([pcm16Wav(new Float32Array(9600),32000),pcm16Wav(new Float32Array(140800).fill(.2),32000),...clips.slice(1)]),file=d+'/reference.wav';await writeFile(file,kept);
 const ref={file,sha256:sha(kept),source:'ModelScope/villia/dania-original',generated:false,concatenated:true,composition:{archiveSha256,sourceName:'source.wav',parts,inventoryFile,inventorySha256:sha(inventory),missingSourceRanges:gaps,removedSilenceRanges:[{startFrame:0,endFrame:22400}],outputPcmSha256:sha(inspectPcmWav(kept).data)}};
 assert.equal((await inspectSource(ref)).durationMs,20900);
 for(const mutation of [c=>c.missingSourceRanges=[],c=>c.parts.reverse(),c=>c.parts[2].startFrame++,c=>c.removedSilenceRanges=[{startFrame:32000,endFrame:54400}],c=>c.outputPcmSha256='a'.repeat(64)]){const bad=structuredClone(ref);mutation(bad.composition);await assert.rejects(inspectSource(bad));}
});
for(const model of ['voice-enrollment','MiniMax/speech-2.8-turbo'])test('private upload binds exact comparison model '+model,async t=>{
 const d=await dir(t),file=d+'/reference.wav',bytes=Buffer.from('synthetic');await writeFile(file,bytes);let calls=0;
 const r=await uploadReference({file,sha256:sha(bytes)},()=> 'synthetic',d+'/upload',async(url,init)=>{
  if(++calls===1){assert.equal(new URL(url).searchParams.get('model'),model);return Response.json({data:{upload_host:'https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com',upload_dir:'dashscope-instant/synthetic/path',policy:'secret',signature:'secret',oss_access_key_id:'secret',expire_in_seconds:300,x_oss_object_acl:'private',x_oss_forbid_overwrite:'true'}});}
  assert.equal(init.headers,undefined);return new Response('');
 },model,async()=>({format:'wav',durationMs:20930}));
 assert.equal(r.uploadHttpStatus,200);assert.equal(r.model,model);assert.equal(JSON.parse(await readFile(d+'/upload/reference.json')).uploadModel,model);
});
test('one authorized Qwen recovery reuses registered voice and keeps failed download history',async t=>{
 const d=await dir(t),state=historical();state.entries.push({operationId:prefix+'qwen:create',model:'voice-enrollment',reservedMicros:1,actualMicros:0,status:'settled'},{operationId:prefix+'qwen:tts',model:'qwen-audio-3.0-tts-plus',reservedMicros:7840,actualMicros:7140,status:'settled'},{operationId:prefix+'minimax:clone-demo',model:'MiniMax/speech-2.8-turbo',reservedMicros:11200,actualMicros:10200,status:'settled'});
 const before=JSON.stringify(state),budgetFile=d+'/budget.json';await writeFile(budgetFile,before);
 const ref={url:'oss://synthetic/ref.wav',sha256:'a'.repeat(64)},recoveryVoice='qwen-audio-3.0-tts-plus-daniacmp-reuse';
 const plan={provider:'qwen',recoveryVoice,budgetFile,budgetBatchId:'synthetic',ledgerSha256:sha(before),reference:ref,referenceInspection:{durationMs:20930},voiceId:null,requests:requests('qwen',ref,20930,null,recoveryVoice),outputDirectory:d+'/recovery',credentialRef:'synthetic'};
 let posts=0;const wav=pcm16Wav(new Float32Array(24000).fill(.1),24000);
 const r=await runComparison(plan,()=> 'synthetic',async(url,init)=>{if(init.method==='POST'){posts++;assert.match(url,/SpeechSynthesizer$/);const body=JSON.parse(init.body);assert.equal(body.input.voice,recoveryVoice);assert.equal(body.input.action,undefined);return Response.json({output:{finish_reason:'stop',audio:{url:'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/recovery.wav?Signature=a%2Fb'}},usage:{characters:51}});}assert.equal(url,'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/recovery.wav?Signature=a%2Fb');return new Response(wav);},()=>({format:'wav',durationMs:1000}));
 assert.equal(posts,1);assert.equal(r.status,'sample_ready_for_user_listening');assert.equal(r.historicalLedgerUnchanged,true);const after=JSON.parse(await readFile(budgetFile));assert.deepEqual(after.entries.slice(0,state.entries.length),state.entries);assert.equal(after.entries.at(-1).operationId,prefix+'qwen:tts-recovery-1');assert.equal(after.entries.at(-1).actualMicros,7140);assert.throws(()=>checkLedger(after,'synthetic','qwen',true));await assert.rejects(readFile(d+'/recovery/audio-location.private.json'),{code:'ENOENT'});
});
