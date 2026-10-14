import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, realpath, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvaluationBudget } from '../dist/core/evaluation-budget.js';
import { readActiveTrialConfiguration } from '../dist/app/trial-config.js';
import { credentialRegistry } from '../dist/management/credentials.js';
import { inspectPcmWav } from '../dist/media/wav.js';

const model = 'MiniMax/speech-2.8-hd';
const endpoint = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const prefix = 'W0-I:B-DANIA-MINIMAX-AUDITION-01:';
const text = '今天的事先放一放。喝点水，早点休息，明天再慢慢来，好吗？';
const sha = b => createHash('sha256').update(b).digest('hex');
export function redact(value, key = '') {
  if (/authorization|token|key|signature|policy|url|audio$/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return value.replace(/<([\w:-]*(?:sign|key|token|policy)[\w:-]*)>[\s\S]*?<\/\1>/gi,'<$1>[redacted]</$1>').replace(/(?:https?|oss):\/\/[^\s"']+/g, '[url]').replace(/sk-[A-Za-z0-9_-]+/g, '[key]').slice(0, 4000);
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redact(v,k)]));
  return value;
}
export function inspectAudio(file) {
  const raw = execFileSync('/opt/homebrew/anaconda3/bin/ffprobe', ['-v','error','-show_entries','format=duration,format_name:stream=codec_type,codec_name,sample_rate,channels','-of','json',file], { encoding:'utf8',timeout:30000,maxBuffer:100000 });
  const p = JSON.parse(raw), audio = p.streams?.filter(s => s.codec_type === 'audio');
  if (audio?.length !== 1 || p.streams.length !== 1 || !Number.isFinite(Number(p.format?.duration)) || Number(p.format.duration) <= 0
    || !['mp3','wav','flac'].includes(p.format.format_name) || ![1,2].includes(audio[0].channels)) throw Error('Invalid complete audio container');
  return { durationMs: Math.round(Number(p.format.duration)*1000), format:p.format.format_name, codec:audio[0].codec_name, sampleRate:Number(audio[0].sample_rate), channels:audio[0].channels };
}
async function inspectReference(reference) {
  if (!reference || !/^[a-f0-9]{64}$/.test(reference.sha256) || reference.source !== 'ModelScope/villia/dania-original'
    || reference.generated!==false || ![false,true].includes(reference.concatenated)) throw Error('Exact original reference required');
  const bytes=await readFile(reference.file); if(bytes.length > 20*1024*1024 || sha(bytes)!==reference.sha256)throw Error('Reference bytes changed or too large');
  if(reference.concatenated)await verifyAdjacentSourceSlices(reference,bytes);
  const audio=inspectAudio(reference.file); if(audio.durationMs<10000 || audio.durationMs>300000)throw Error('Reference must be natural original 10s to 5min');
  if(!['wav','mp3'].includes(audio.format))throw Error('Only verified WAV or MP3 original input is enabled');
  return {...audio,bytes:bytes.length};
}
export async function verifyAdjacentSourceSlices(reference, bytes) {
  const c=reference.composition,archiveSha='3cef696c6af5eb397431bacb4a24fc3e4c0db5f38923caa27f73c0e022743ea6';
  if(!c||c.method!=='adjacent_source_slices'||c.archiveSha256!==archiveSha||!Array.isArray(c.parts)||c.parts.length!==2
    ||typeof c.sourceName!=='string'||!c.sourceName.endsWith('.wav'))throw Error('Unverified original adjacent slices');
  const inventoryBytes=await readFile(c.inventoryFile);if(sha(inventoryBytes)!==c.inventorySha256)throw Error('Source inventory changed');
  const inventory=JSON.parse(inventoryBytes);if(inventory.summary?.archive_sha256!==archiveSha||inventory.summary?.all_entries_read_successfully!==true)throw Error('Unverified source archive inventory');
  const chunks=[];let previousEnd=null;
  for(const part of c.parts){
    const name=/^(.*)_(\d{10})_(\d{10})\.wav$/.exec(part.archivePath??'');
    if(!name||name[1]!==c.sourceName||!Number.isSafeInteger(part.startFrame)||!Number.isSafeInteger(part.endFrame)
      ||part.startFrame<0||part.endFrame<=part.startFrame||Number(name[2])!==part.startFrame||Number(name[3])!==part.endFrame
      ||(previousEnd!==null&&part.startFrame!==previousEnd))throw Error('Source slices are not strictly adjacent');
    const source=inventory.files.find(f=>f.archive_path===part.archivePath);
    if(!source||source.sha256!==part.sha256||source.frames!==part.endFrame-part.startFrame)throw Error('Slice differs from original archive inventory');
    const raw=await readFile(part.file);if(sha(raw)!==part.sha256)throw Error('Original slice bytes changed');
    const wav=inspectPcmWav(raw);
    if(wav.sampleRate!==32000||wav.channels!==1||wav.bits!==16||wav.data.length/2!==part.endFrame-part.startFrame||sha(wav.data)!==part.pcmSha256)throw Error('Original slice PCM mismatch');
    chunks.push(Buffer.from(wav.data));previousEnd=part.endFrame;
  }
  const output=inspectPcmWav(bytes),original=Buffer.concat(chunks),kept=[];
  const ranges=c.removedSilenceRanges??[];if(!Array.isArray(ranges))throw Error('Invalid removed silence ranges');
  let cursor=0;
  for(const range of ranges){
    const {startFrame,endFrame}=range;
    if(!Number.isSafeInteger(startFrame)||!Number.isSafeInteger(endFrame)||startFrame<cursor||endFrame<=startFrame||endFrame>original.length/2)throw Error('Invalid or overlapping silence range');
    if(original.subarray(startFrame*2,endFrame*2).some(value=>value!==0))throw Error('Silence removal would discard nonzero original PCM');
    kept.push(original.subarray(cursor*2,startFrame*2));cursor=endFrame;
  }
  kept.push(original.subarray(cursor*2));const expected=Buffer.concat(kept);
  if(output.sampleRate!==32000||output.channels!==1||output.bits!==16||!Buffer.from(output.data).equals(expected)||sha(output.data)!==c.outputPcmSha256)throw Error('Reconstructed PCM is not the exact adjacent original bytes');
}
export async function checkReference(reference) {
  const audio=await inspectReference(reference);
  if(!/^(https:\/\/|oss:\/\/)/.test(reference.url))throw Error('Exact reference transport required');
  if(reference.url.startsWith('oss://') && (!Number.isFinite(Date.parse(reference.uploadedAt)) || Date.now()-Date.parse(reference.uploadedAt)>46*3600*1000 || Date.parse(reference.uploadedAt)>Date.now()))throw Error('Fresh reviewed upload receipt required');
  return audio;
}
/** One fresh policy and one exact private upload. Secrets live only in memory. No model invocation. */
export async function uploadReference(reference, apiKey, outputDirectory, fetcher=fetch, uploadModel=model, inspectInput=inspectReference) {
  if(![model,'MiniMax/speech-2.8-turbo','voice-enrollment'].includes(uploadModel))throw Error('Unreviewed upload model');
  const inspection=await inspectInput(reference),bytes=await readFile(reference.file);
  if(sha(bytes)!==reference.sha256)throw Error('Reference changed before upload');
  await mkdir(outputDirectory,{recursive:true});const file=resolve(outputDirectory,'upload.json');
  const report={status:'running',model:uploadModel,referenceSha256:reference.sha256,inspection,startedAt:new Date().toISOString(),metadataGets:0,uploads:0,modelCalls:0};
  await writeFile(file,JSON.stringify(report),{flag:'wx',mode:0o600});
  try {
    const key=apiKey();report.metadataGets=1;
    const response=await fetcher('https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model='+encodeURIComponent(uploadModel),{
      headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},signal:AbortSignal.timeout(30000),redirect:'error'});
    report.policyHttpStatus=response.status;const raw=await response.text();let payload;
    try{payload=JSON.parse(raw);}catch{report.responseText=redact(raw);throw Error('Non-JSON upload policy');}
    report.policyResponse=redact(payload);if(!response.ok||!payload.data)throw Error('Upload policy rejected');
    const p=payload.data,host=new URL(p.upload_host);
    if(host.protocol!=='https:'||host.hostname!=='dashscope-file-mgr.oss-cn-beijing.aliyuncs.com'||host.port||host.username||host.password||host.search||host.pathname!=='/'
      ||!/^dashscope-instant\/[A-Za-z0-9/_-]+$/.test(p.upload_dir)||p.x_oss_object_acl!=='private'||p.x_oss_forbid_overwrite!=='true'
      ||!Number.isFinite(p.expire_in_seconds)||p.expire_in_seconds<60||['policy','signature','oss_access_key_id'].some(k=>typeof p[k]!=='string'||!p[k]))throw Error('Unexpected upload policy destination or fields');
    const object=p.upload_dir+'/dania-'+reference.sha256.slice(0,16)+'.'+inspection.format,form=new FormData();
    for(const [k,v]of Object.entries({OSSAccessKeyId:p.oss_access_key_id,policy:p.policy,Signature:p.signature,key:object,'x-oss-object-acl':p.x_oss_object_acl,'x-oss-forbid-overwrite':p.x_oss_forbid_overwrite,success_action_status:'200'}))form.append(k,v);
    form.append('file',new Blob([bytes],{type:inspection.format==='wav'?'audio/wav':'audio/mpeg'}),'dania.'+inspection.format);
    report.uploads=1;
    const uploaded=await fetcher(host.href,{method:'POST',body:form,signal:AbortSignal.timeout(60000),redirect:'error'});
    report.uploadHttpStatus=uploaded.status;report.uploadResponseText=redact(await uploaded.text());
    if(!uploaded.ok)throw Error('Private reference upload failed');
    const result={...reference,url:'oss://'+object,uploadedAt:new Date().toISOString(),uploadModel,uploadReceipt:file};
    await writeFile(resolve(outputDirectory,'reference.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    report.status='uploaded_private_reference_clone_compatibility_unverified';report.referenceMetadataFile=resolve(outputDirectory,'reference.json');
  }catch(error){report.status='failed_stopped_no_retry';report.failure=redact({name:error.name,message:error.message,code:error.cause?.code??error.code});}
  report.finishedAt=new Date().toISOString();await writeFile(file,JSON.stringify(report,null,2)+'\n');return report;
}
/** Exactly one clone including its demo. Never unlock a second TTS, install, or play audio. */
export async function runAudition(plan, apiKey, fetcher=fetch, probe=inspectAudio) {
  await mkdir(plan.outputDirectory,{recursive:true});const file=resolve(plan.outputDirectory,'execution.json');
  const report={package:'B-DANIA-MINIMAX-AUDITION-01',status:'running',startedAt:new Date().toISOString(),posts:0,downloads:0,stage:'preflight'};
  await writeFile(file,JSON.stringify(report),{flag:'wx',mode:0o600});
  const record=()=>writeFile(file,JSON.stringify(report,null,2)+'\n');
  const original=JSON.parse(await readFile(plan.budgetFile));
  const budget=new EvaluationBudget(plan.budgetFile,plan.budgetBatchId,20000000);let reserved=false,actual=null;
  try {
    if(plan.request?.model!==model||plan.request.input?.action!=='voice_clone'||plan.request.input?.text!==text
      ||plan.request.input.audio_url!==plan.reference.url||!/^DaniaMiniMax[A-Za-z0-9_-]{8,100}[A-Za-z0-9]$/.test(plan.request.input.voice_id))throw Error('Only exact MiniMax clone-demo request is permitted');
    if(original.batchId!==plan.budgetBatchId||original.limitMicros!==20000000||original.blocked||original.entries.some(e=>e.status!=='settled'||e.operationId.startsWith(prefix)))throw Error('Original ledger not ready or package already consumed');
    const key=apiKey();
    await budget.reserve(prefix+'clone-demo',model,10000000,{operationIdPrefix:prefix,limitMicros:10000000,maxCalls:1});reserved=true;
    report.stage='clone-demo';report.posts=1;await record();
    const response=await fetcher(endpoint,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json; charset=utf-8',...(plan.reference.url.startsWith('oss://')?{'X-DashScope-OssResourceResolve':'enable'}:{})},body:JSON.stringify(plan.request),signal:AbortSignal.timeout(120000),redirect:'error'});
    report.httpStatus=response.status;report.traceId=response.headers.get('x-request-id')??response.headers.get('x-dashscope-request-id');
    const raw=await response.text();let json;
    try{json=JSON.parse(raw);}catch{report.responseText=redact(raw);throw Error('Non-JSON provider response');}
    report.response=redact(json);
    if(Number.isSafeInteger(json.usage?.characters)&&json.usage.characters>=0)actual=json.usage.characters*350;
    // Clone itself is free; the returned demo has text charges. 9.9 unlock only applies to a later TTS, which this runner never sends.
    if(!response.ok||json.code||json.error||json.output?.base_resp?.status_code!==0)throw Error(`Provider ${response.status}: ${json.code??json.error?.code??json.output?.base_resp?.status_code??'missing status'} ${json.output?.base_resp?.status_msg??''}`);
    if(actual===null||actual>100000)throw Error('Missing or unexpected demo usage');
    if(json.output.input_sensitive!==false||json.output.input_sensitive_type!==0||typeof json.output.demo_audio!=='string')throw Error('Clone rejected input or omitted demo');
    report.voice={voiceId:plan.request.input.voice_id,model,credentialRef:plan.credentialRef,referenceSha256:plan.reference.sha256,registeredAt:new Date().toISOString(),unlockFeeCharged:false};
    await budget.settle(prefix+'clone-demo',actual);reserved=false;await record();
    const url=new URL(json.output.demo_audio);if(url.protocol!=='https:'||url.username||url.password)throw Error('Unexpected demo URL');
    report.stage='demo-download';report.downloads=1;const download=await fetcher(url.href,{signal:AbortSignal.timeout(30000),redirect:'error'});
    const bytes=new Uint8Array(await download.arrayBuffer());const originalFile=resolve(plan.outputDirectory,'demo-original.bin');
    await writeFile(originalFile,bytes,{flag:'wx'});report.rawAudio={bytes:bytes.length,sha256:sha(bytes),first64Hex:Buffer.from(bytes.subarray(0,64)).toString('hex'),httpStatus:download.status};
    if(!download.ok||bytes.length>20*1024*1024)throw Error('Demo download failed or exceeded size bound');
    report.stage='format-check';const audio=await probe(originalFile);if(audio.durationMs<=0||audio.durationMs>60000)throw Error('Unexpected demo duration');
    const sample=resolve(plan.outputDirectory,'dania-minimax-demo.'+audio.format);await writeFile(sample,bytes,{flag:'wx'});
    report.sample={path:sample,...audio,sha256:sha(bytes),bytes:bytes.length,text};report.status='clone_demo_ready_for_user_listening';report.stage='complete';
  }catch(error){report.status='failed_stopped_no_retry';report.failure=redact({name:error.name,code:error.cause?.code??error.code,message:error.message});}
  finally {
    if(reserved)await budget.settle(prefix+'clone-demo',actual);
    const after=JSON.parse(await readFile(plan.budgetFile));report.entries=after.entries.filter(e=>e.operationId.startsWith(prefix));
    report.historicalLedgerUnchanged=JSON.stringify(after.entries.slice(0,original.entries.length))===JSON.stringify(original.entries);
    report.finishedAt=new Date().toISOString();report.actualMicros=actual;report.devices=0;report.playback=false;report.installed=false;await record();
  }
  return report;
}
async function main() {
  const [mode,root,referenceFile,expectedHash]=process.argv.slice(2);if(!['--check','--execute'].includes(mode)||await realpath(root)!==root)throw Error('Explicit mode/root required');
  const candidate=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),out=resolve(candidate,'artifacts/W0-I/dania-minimax-audition-01/execution');
  const reference=JSON.parse(await readFile(referenceFile)),referenceInspection=await checkReference(reference);
  const directory=resolve(root,'artifacts/W0-I/model-evaluation/trial/user-trial');const config=await readActiveTrialConfiguration(directory+'/config.json',directory+'/activation.json');
  const ledgerBytes=await readFile(config.budgetFile),ledger=JSON.parse(ledgerBytes);
  if(ledger.blocked||ledger.batchId!==config.budgetBatchId||ledger.entries.some(e=>e.status!=='settled'||e.operationId.startsWith(prefix)))throw Error('Ledger changed/blocked or package already used');
  const previous=mode==='--execute'?await readFile(resolve(out,'plan.json')):null;
  const voiceId=previous?JSON.parse(previous).request.input.voice_id:'DaniaMiniMax-'+randomUUID().replaceAll('-','');
  const request={model,input:{action:'voice_clone',voice_id:voiceId,audio_url:reference.url,text,language_boost:'Chinese',need_noise_reduction:false,need_volume_normalization:false}};
  if(reference.clonePrompt)throw Error('Optional clone prompt needs separate exact source validation before use');
  const plan={package:'B-DANIA-MINIMAX-AUDITION-01',root,candidate,sourceRevision:execFileSync('git',['rev-parse','HEAD'],{cwd:candidate,encoding:'utf8'}).trim(),toolSha256:sha(await readFile(fileURLToPath(import.meta.url))),budgetSupportSha256:sha(await readFile(resolve(candidate,'code/desktop-pet/dist/core/evaluation-budget.js'))),reference,referenceInspection,referenceMetadataSha256:sha(await readFile(referenceFile)),request,endpoint,credentialRef:credentialRegistry(config).ref(config.models.tts.credentialFile,'dashscope'),outputDirectory:out,budgetFile:config.budgetFile,budgetBatchId:config.budgetBatchId,ledgerSha256:sha(ledgerBytes),sharedLimitMicros:20000000,phaseReservationMicros:10000000,cloneCostMicros:0,demoCharacterMicros:350,subsequentUnlockMicros:9900000,subsequentSynthesisCalls:0,maxCloneCalls:1,maxDemoDownloads:1,retries:0,devices:0,install:false,configSha256:sha(await readFile(directory+'/config.json')),settingsSha256:sha(await readFile(directory+'/management-settings.json'))};
  await mkdir(out,{recursive:true});const path=resolve(out,'plan.json');
  if(mode==='--check'){const bytes=JSON.stringify(plan,null,2)+'\n';await writeFile(path,bytes,{flag:'wx',mode:0o600});console.log(JSON.stringify({path,sha256:sha(bytes),calls:0}));return;}
  if(sha(previous)!==expectedHash||JSON.stringify(JSON.parse(previous))!==JSON.stringify(plan))throw Error('Exact reviewed plan changed');
  const keyFile=await realpath(config.models.tts.credentialFile),info=await stat(keyFile);if(keyFile.startsWith(root+'/')||!info.isFile()||info.uid!==process.getuid()||(info.mode&0o077))throw Error('Existing restricted credential required');
  const result=await runAudition(plan,()=>{const v=readFileSync(keyFile,'utf8').trim();if(!/^sk-[A-Za-z0-9_-]+$/.test(v))throw Error('Invalid credential');return v;});
  console.log(JSON.stringify({status:result.status,posts:result.posts,evidence:resolve(out,'execution.json')}));if(result.status==='failed_stopped_no_retry')process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
