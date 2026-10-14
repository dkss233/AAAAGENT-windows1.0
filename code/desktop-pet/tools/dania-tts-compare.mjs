import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,realpath,stat,unlink} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EvaluationBudget} from '../dist/core/evaluation-budget.js';
import {readActiveTrialConfiguration} from '../dist/app/trial-config.js';
import {credentialRegistry} from '../dist/management/credentials.js';
import {normalizeQwenAudioWav} from '../dist/providers/qwen-audio-tts.js';
import {audioDownloadUrl} from '../dist/providers/qwen-tts.js';
import {inspectPcmWav} from '../dist/media/wav.js';
import {redact,inspectAudio,uploadReference} from './minimax-voice-audition.mjs';
export const sentence='今天的事先放一放。喝点水，早点休息，明天再慢慢来，好吗？';
export const prefix='W0-I:B-DANIA-TTS-COMPARE-01:';
const models={qwen:'qwen-audio-3.0-tts-plus',minimax:'MiniMax/speech-2.8-turbo'};
const urls={create:'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization',tts:'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',minimax:'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'};
const hash=b=>createHash('sha256').update(b).digest('hex');
export const characterUpperBound=2*Array.from(sentence).length;
export async function inspectSource(ref){
  if(ref.source!=='ModelScope/villia/dania-original'||ref.generated!==false||ref.concatenated!==true)throw Error('Original source declaration required');
  const bytes=await readFile(ref.file);if(hash(bytes)!==ref.sha256||bytes.length>20*1024*1024)throw Error('Reference changed');
  const c=ref.composition;if(!c||c.archiveSha256!=='3cef696c6af5eb397431bacb4a24fc3e4c0db5f38923caa27f73c0e022743ea6'||c.parts?.length!==4)throw Error('Four reviewed same-source parts required');
  const invBytes=await readFile(c.inventoryFile);if(hash(invBytes)!==c.inventorySha256)throw Error('Inventory changed');
  const inv=JSON.parse(invBytes);if(inv.summary?.archive_sha256!==c.archiveSha256||inv.summary?.all_entries_read_successfully!==true)throw Error('Unverified archive');
  let last=null;const pieces=[],gaps=[];
  for(const part of c.parts){
    const m=/^(.*)_(\d{10})_(\d{10})\.wav$/.exec(part.archivePath??'');
    if(!m||m[1]!==c.sourceName||!Number.isSafeInteger(part.startFrame)||!Number.isSafeInteger(part.endFrame)||part.startFrame<0||part.endFrame<=part.startFrame||Number(m[2])!==part.startFrame||Number(m[3])!==part.endFrame||(last!==null&&part.startFrame<last))throw Error('Invalid ordered original slices');
    if(last!==null&&part.startFrame>last)gaps.push({startFrame:last,endFrame:part.startFrame});last=part.endFrame;
    const row=inv.files.find(x=>x.archive_path===part.archivePath),raw=await readFile(part.file),wav=inspectPcmWav(raw);
    if(!row||row.sha256!==part.sha256||hash(raw)!==part.sha256||row.frames!==part.endFrame-part.startFrame||wav.data.length/2!==row.frames||wav.sampleRate!==32000||wav.channels!==1||wav.bits!==16||hash(wav.data)!==part.pcmSha256)throw Error('Original part mismatch');
    pieces.push(Buffer.from(wav.data));
  }
  if(JSON.stringify(gaps)!==JSON.stringify(c.missingSourceRanges))throw Error('Missing source ranges must remain explicit');
  const original=Buffer.concat(pieces),kept=[];let cursor=0;
  if(!Array.isArray(c.removedSilenceRanges))throw Error('Explicit silence ranges required');
  for(const r of c.removedSilenceRanges){
    if(!Number.isSafeInteger(r.startFrame)||!Number.isSafeInteger(r.endFrame)||r.startFrame<cursor||r.endFrame<=r.startFrame||r.endFrame>original.length/2||original.subarray(r.startFrame*2,r.endFrame*2).some(x=>x!==0))throw Error('Invalid zero-only removal');
    kept.push(original.subarray(cursor*2,r.startFrame*2));cursor=r.endFrame;
  }
  kept.push(original.subarray(cursor*2));const wav=inspectPcmWav(bytes);
  if(wav.sampleRate!==32000||wav.channels!==1||wav.bits!==16||!Buffer.from(wav.data).equals(Buffer.concat(kept))||hash(wav.data)!==c.outputPcmSha256)throw Error('Final PCM differs from recorded source operations');
  if(wav.durationMs<19000||wav.durationMs>23000)throw Error('Expected approximately20s reference');
  return {format:'wav',codec:'pcm_s16le',durationMs:wav.durationMs,sampleRate:32000,channels:1,bytes:bytes.length,pcmSha256:hash(wav.data),missingSourceRanges:gaps};
}
export function checkLedger(ledger,batch,provider,recovery=false){
  if(!models[provider]||ledger.batchId!==batch||ledger.currency!=='CNY'||ledger.limitMicros!==20000000||ledger.blocked||!Array.isArray(ledger.entries))throw Error('Original ledger invalid');
  if(ledger.entries.some(e=>!['settled','unknown'].includes(e.status)||e.operationId.startsWith(prefix+(recovery?'qwen:tts-recovery-1':provider+':'))||!Number.isSafeInteger(e.reservedMicros)||e.reservedMicros<=0||(e.actualMicros!==null&&(!Number.isSafeInteger(e.actualMicros)||e.actualMicros<0))||(e.status==='unknown'&&e.actualMicros!==null)||(e.status==='settled'&&e.actualMicros===null)))throw Error('Ledger has active/invalid entries or repeated provider step');
  const available=ledger.limitMicros-ledger.entries.reduce((s,e)=>s+(e.actualMicros??e.reservedMicros),0);
  if(available<characterUpperBound*(provider==='qwen'?140:200)+1)throw Error('Insufficient conservative shared balance');return available;
}
export function requests(provider,ref,durationMs,voiceId,recoveryVoice=null){
  if(provider==='qwen'&&recoveryVoice){const r=requests(provider,ref,durationMs,voiceId);return {tts:{...r.tts,input:{...r.tts.input,voice:recoveryVoice}}};}
  if(provider==='qwen')return {create:{model:'voice-enrollment',input:{action:'create_voice',target_model:models.qwen,prefix:'daniacmp',url:ref.url,language_hints:['zh'],max_prompt_audio_length:durationMs/1000,enable_preprocess:false,enable_volume_normalization:'false'}},tts:{model:models.qwen,input:{text:sentence,voice:'$CREATED_VOICE',format:'wav',sample_rate:24000,instruction:'自然温和，像日常聊天一样说话。',language_hints:['zh']}}};
  if(provider==='minimax'&&/^DaniaCompare[A-Za-z0-9-]{8,100}$/.test(voiceId))return {clone:{model:models.minimax,input:{action:'voice_clone',voice_id:voiceId,audio_url:ref.url,text:sentence,language_boost:'Chinese',need_noise_reduction:false,need_volume_normalization:false}}};
  throw Error('Unsupported exact comparison provider');
}
export async function runComparison(plan,key,fetcher=fetch,probe=inspectAudio){
  const out=plan.outputDirectory;await mkdir(out,{recursive:true});const file=resolve(out,'execution.json');
  const report={package:'B-DANIA-TTS-COMPARE-01',provider:plan.provider,status:'running',startedAt:new Date().toISOString(),calls:[],downloads:0,devices:0,playback:false,installed:false};
  await writeFile(file,JSON.stringify(report),{flag:'wx',mode:0o600});const record=()=>writeFile(file,JSON.stringify(report,null,2)+'\n');
  const originalBytes=await readFile(plan.budgetFile),original=JSON.parse(originalBytes),budget=new EvaluationBudget(plan.budgetFile,plan.budgetBatchId,20000000);
  const post=async(kind,endpoint,body,unit,reference=false)=>{
    const id=prefix+plan.provider+':'+kind,reservation=unit?characterUpperBound*unit:1;
    const credential=key();await budget.reserve(id,body.model,reservation,{operationIdPrefix:prefix,limitMicros:500000,maxCalls:4});
    const call={operationId:id,kind,model:body.model,status:'running',reservedMicros:reservation};report.calls.push(call);let actual=unit?null:0;await record();
    try{
      const response=await fetcher(endpoint,{method:'POST',headers:{Authorization:'Bearer '+credential,'Content-Type':'application/json; charset=utf-8',...(reference?{'X-DashScope-OssResourceResolve':'enable'}:{})},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(120000)});
      call.httpStatus=response.status;const raw=await response.text();let result;
      try{result=JSON.parse(raw);}catch{call.responseText=redact(raw);throw Error('Non-JSON provider response');}
      call.response=redact(result);call.requestId=result.request_id??response.headers.get('x-request-id');
      if(unit&&Number.isSafeInteger(result.usage?.characters)&&result.usage.characters>=0)actual=result.usage.characters*unit;
      if(!response.ok||result.code||result.error||(plan.provider==='minimax'&&result.output?.base_resp?.status_code!==0))throw Error(`Provider ${response.status}: ${result.code??result.error?.code??result.output?.base_resp?.status_code??'invalid response'} ${result.message??result.output?.base_resp?.status_msg??''}`);
      if(unit&&(actual===null||actual>reservation))throw Error('Missing or excessive returned usage');
      call.status='success';return result;
    }catch(error){call.status='failed';call.failure=redact({name:error.name,message:error.message});throw error;}
    finally{call.actualMicros=actual;await budget.settle(id,actual);await record();}
  };
  try{
    if(hash(originalBytes)!==plan.ledgerSha256)throw Error('Frozen historical ledger changed');checkLedger(original,plan.budgetBatchId,plan.provider,Boolean(plan.recoveryVoice));
    const expected=requests(plan.provider,plan.reference,plan.referenceInspection.durationMs,plan.voiceId,plan.recoveryVoice);
    if(JSON.stringify(expected)!==JSON.stringify(plan.requests))throw Error('Exact requests changed');
    let result,url;
    if(plan.provider==='qwen'){
      let voice=plan.recoveryVoice;
      if(!voice){result=await post('create',urls.create,plan.requests.create,0,true);voice=result.output?.voice_id;if(result.usage?.count!==1)throw Error('Unexpected clone count');}
      if(typeof voice!=='string'||!/^qwen-audio-3\.0-tts-plus-daniacmp-[A-Za-z0-9_-]+$/.test(voice))throw Error('Unexpected created Qwen voice');
      report.voice={voiceId:voice,model:models.qwen,referenceSha256:plan.reference.sha256,credentialRef:plan.credentialRef};await record();
      result=await post(plan.recoveryVoice?'tts-recovery-1':'tts',urls.tts,{...plan.requests.tts,input:{...plan.requests.tts.input,voice}},140);
      if(result.output?.finish_reason!=='stop')throw Error('Incomplete Qwen synthesis');url=result.output?.audio?.url;
    }else{
      result=await post('clone-demo',urls.minimax,plan.requests.clone,200,true);
      if(result.output.input_sensitive!==false||result.output.input_sensitive_type!==0)throw Error('MiniMax rejected input');url=result.output.demo_audio;
      report.voice={voiceId:plan.voiceId,model:models.minimax,referenceSha256:plan.reference.sha256,credentialRef:plan.credentialRef,unlockFeeCharged:false};await record();
    }
    // Keep the returned location locally until a successful download; never add this private file to Git.
    const locationFile=resolve(out,'audio-location.private.json');await writeFile(locationFile,JSON.stringify({url,provider:plan.provider,at:new Date().toISOString()}),{flag:'wx',mode:0o600});
    const audioUrl=new URL(plan.provider==='qwen'?audioDownloadUrl(url):url);if(audioUrl.protocol!=='https:'||audioUrl.username||audioUrl.password)throw Error('Invalid sample URL');
    report.downloads=1;const response=await fetcher(audioUrl.href,{redirect:'error',signal:AbortSignal.timeout(30000)}),raw=new Uint8Array(await response.arrayBuffer());
    const rawFile=resolve(out,'sample-original.bin');await writeFile(rawFile,raw,{flag:'wx'});report.rawAudio={httpStatus:response.status,bytes:raw.length,sha256:hash(raw),first64Hex:Buffer.from(raw.subarray(0,64)).toString('hex')};
    if(!response.ok||raw.length>20*1024*1024)throw Error('Audio download failed');
    const audio=plan.provider==='qwen'?normalizeQwenAudioWav(raw):raw;const inspectedFile=resolve(out,'sample-inspected.bin');await writeFile(inspectedFile,audio,{flag:'wx'});
    const shape=await probe(inspectedFile);if(shape.durationMs<=0||shape.durationMs>60000)throw Error('Unexpected sample length');
    const path=resolve(out,plan.provider+'-same-reference-demo.'+shape.format);await writeFile(path,audio,{flag:'wx'});
    report.sample={path,...shape,bytes:audio.length,sha256:hash(audio),text:sentence};report.status='sample_ready_for_user_listening';await unlink(locationFile);
  }catch(error){report.status='failed_stopped_no_retry';report.failure=redact({name:error.name,message:error.message,code:error.cause?.code??error.code});}
  finally{
    const after=JSON.parse(await readFile(plan.budgetFile));report.entries=after.entries.filter(e=>e.operationId.startsWith(prefix+plan.provider+':'));
    report.historicalLedgerUnchanged=JSON.stringify(after.entries.slice(0,original.entries.length))===JSON.stringify(original.entries);
    report.finishedAt=new Date().toISOString();await record();
  }
  return report;
}
async function main(){
  const [mode,selected,root,referenceFile,expectedHash]=process.argv.slice(2),recovery=selected==='qwen-recovery',provider=recovery?'qwen':selected;if(!['--upload','--check','--execute'].includes(mode)||!models[provider]||await realpath(root)!==root)throw Error('Explicit comparison mode/provider/root required');
  const candidate=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),out=resolve(candidate,'artifacts/W0-I/dania-tts-compare-01',selected);
  const refBytes=await readFile(referenceFile),ref=JSON.parse(refBytes),inspection=await inspectSource(ref);
  const authorization=JSON.parse(await readFile(resolve(root,'artifacts/W0-I/dania-tts-compare-01/registration.json')));
  if(authorization.reference_confirmation?.sha256!==ref.sha256||authorization.package_id!=='B-DANIA-TTS-COMPARE-01')throw Error('Final reference not yet frozen by integration');
  let recoveryVoice=null,recoveryReceiptSha256=null;
  if(recovery){
    if(mode==='--upload')throw Error('Recovery must reuse original reference and voice');
    const receiptBytes=await readFile(resolve(candidate,'artifacts/W0-I/dania-tts-compare-01/qwen/execution.json')),receipt=JSON.parse(receiptBytes);
    recoveryVoice=receipt.voice?.voiceId;recoveryReceiptSha256=hash(receiptBytes);
    if(authorization.recovery_authorization?.voiceId!==recoveryVoice||authorization.recovery_authorization?.operationId!==prefix+'qwen:tts-recovery-1'||receipt.status!=='failed_stopped_no_retry'||receipt.calls?.length!==2||receipt.calls.some(c=>c.status!=='success')||receipt.voice?.referenceSha256!==ref.sha256)throw Error('Exact one-time recovery not authorized or source receipt changed');
  }
  const directory=resolve(root,'artifacts/W0-I/model-evaluation/trial/user-trial'),config=await readActiveTrialConfiguration(directory+'/config.json',directory+'/activation.json');
  const ledgerBytes=await readFile(config.budgetFile),ledger=JSON.parse(ledgerBytes);const available=checkLedger(ledger,config.budgetBatchId,provider,recovery);
  const keyFile=await realpath(config.models.tts.credentialFile),info=await stat(keyFile);if(keyFile.startsWith(root+'/')||!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077))throw Error('Restricted existing credential required');
  const key=()=>{const value=readFileSync(keyFile,'utf8').trim();if(!/^sk-[A-Za-z0-9_-]+$/.test(value))throw Error('Invalid credential');return value;};
  if(mode==='--upload'){
    const result=await uploadReference(ref,key,resolve(out,'upload'),fetch,provider==='qwen'?'voice-enrollment':models.minimax,inspectSource);
    console.log(JSON.stringify({status:result.status,policyHttpStatus:result.policyHttpStatus,uploadHttpStatus:result.uploadHttpStatus,path:resolve(out,'upload/upload.json')}));if(result.status==='failed_stopped_no_retry')process.exitCode=1;return;
  }
  if(!ref.url?.startsWith('oss://')||ref.uploadModel!==(provider==='qwen'?'voice-enrollment':models.minimax)||!Number.isFinite(Date.parse(ref.uploadedAt))||Date.now()-Date.parse(ref.uploadedAt)>46*3600000||Date.parse(ref.uploadedAt)>Date.now())throw Error('Fresh provider-bound upload required');
  const planFile=resolve(out,'plan.json'),previous=mode==='--execute'?await readFile(planFile):null,voiceId=previous?JSON.parse(previous).voiceId:provider==='minimax'?'DaniaCompare'+randomUUID().replaceAll('-',''):null;
  const support=['dist/core/evaluation-budget.js','dist/providers/qwen-audio-tts.js','dist/providers/qwen-tts.js','dist/media/wav.js','dist/app/trial-config.js','dist/management/credentials.js','tools/minimax-voice-audition.mjs'];
  const plan={package:'B-DANIA-TTS-COMPARE-01',provider,root,candidate,sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:candidate,encoding:'utf8'}).trim(),toolSha256:hash(await readFile(fileURLToPath(import.meta.url))),supportHashes:Object.fromEntries(await Promise.all(support.map(async p=>[p,hash(await readFile(resolve(candidate,'code/desktop-pet',p)))]))),reference:ref,referenceInspection:inspection,referenceMetadataSha256:hash(refBytes),voiceId,recoveryVoice,recoveryReceiptSha256,requests:requests(provider,ref,inspection.durationMs,voiceId,recoveryVoice),characterUpperBound,phaseLimitMicros:500000,availableMicros:available,outputDirectory:out,budgetFile:config.budgetFile,budgetBatchId:config.budgetBatchId,ledgerSha256:hash(ledgerBytes),credentialRef:credentialRegistry(config).ref(config.models.tts.credentialFile,'dashscope'),configSha256:hash(await readFile(directory+'/config.json')),settingsSha256:hash(await readFile(directory+'/management-settings.json')),retries:0,devices:0,install:false};
  await mkdir(out,{recursive:true});
  if(mode==='--check'){const bytes=JSON.stringify(plan,null,2)+'\n';await writeFile(planFile,bytes,{flag:'wx',mode:0o600});console.log(JSON.stringify({path:planFile,sha256:hash(bytes),modelCalls:0}));return;}
  if(hash(previous)!==expectedHash||JSON.stringify(JSON.parse(previous))!==JSON.stringify(plan))throw Error('Exact comparison plan changed');
  const result=await runComparison(plan,key);console.log(JSON.stringify({status:result.status,path:resolve(out,'execution.json')}));if(result.status==='failed_stopped_no_retry')process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
