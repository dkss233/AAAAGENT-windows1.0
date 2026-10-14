import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';

const source=resolve(process.env.UNIT_COMPOSER_SOURCE??''),directory=resolve(process.env.UNIT_EVIDENCE??'');
assert.ok(process.env.UNIT_COMPOSER_SOURCE&&process.env.UNIT_EVIDENCE);
await access(source);
assert.ok(process.env.UNIT_INPUT_RECEIPT);
const receiptBytes=await readFile(process.env.UNIT_INPUT_RECEIPT);
assert.equal(createHash('sha256').update(receiptBytes).digest('hex'),'50e198f3581ad2202934ebd823a4302afbae86667812b72b72a9820e2ebe4678');
const receipt=JSON.parse(receiptBytes),require=createRequire(receipt.runtime.fixture.path),{build}=await import(pathToFileURL(require.resolve('esbuild')));
const root=resolve(receipt.git.worktree,'../../..'),own=resolve(process.cwd());
const ownershipBytes=await readFile(join(root,'docs/agent/blackboard/OWNERSHIP.json'));
const ownership=JSON.parse(ownershipBytes),registration=ownership.tasks.find(t=>['W1','W0-I'].includes(t.task_id)&&resolve(t.worktree)===own);
assert.ok(registration,'Only the formally registered W1 or I worktree may execute');
assert.equal(registration.current_package_id,'B56-WEB-EXECUTION-COMPLETION');
const artifactRoot=join(own,registration.actual_artifact_root);
const evidenceRoot=artifactRoot.endsWith('/cross-page-draft-snapshot-01/')||artifactRoot.endsWith('/cross-page-draft-snapshot-01')?artifactRoot:join(artifactRoot,'cross-page-draft-snapshot-01');
assert.ok(registration.writable_paths.some(p=>p.startsWith('artifacts/')&&(evidenceRoot+'/').startsWith(join(own,p).replace(/\/$/,'')+'/')));
assert.ok(directory.startsWith(evidenceRoot.replace(/\/$/,'')+'/'),'Evidence must remain in this executor own registered draft scope');
const sourceSha256=createHash('sha256').update(await readFile(source)).digest('hex');
assert.ok(['59c270467f4c8da49dab040b389dad5a052798e4db6f22d9ac408d26062f3764','07f8e33e5a7da651e9d5ec20bed630a5c610d91f0d873a9606e43fed9740d99f'].includes(sourceSha256),'Only original or registered candidate composer source may run');
await mkdir(directory,{recursive:false});

const bundle=join(directory,'composer-module.mjs');
await build({entryPoints:[source],outfile:bundle,bundle:true,platform:'node',format:'esm',define:{'import.meta.env':'{}'},banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});
const key='t3code:composer-drafts:v1',environmentId='unit-environment',projectId='unit-project';
const report={executionOwnership:{path:join(root,'docs/agent/blackboard/OWNERSHIP.json'),revision:ownership.revision,sha256:createHash('sha256').update(ownershipBytes).digest('hex'),taskId:registration.task_id,worktree:own,evidenceRoot},testSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),source,sourceSha256:createHash('sha256').update(await readFile(source)).digest('hex'),networkCalls:0,checks:[]};
globalThis.fetch=async()=>{report.networkCalls++;throw new Error('Unit persistence never permits a network call');};
function storage(){const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};}
async function page(shared){
  const listeners=new Map();globalThis.localStorage=shared;globalThis.window={localStorage:shared,addEventListener:(name,fn)=>listeners.set(name,fn)};
  const module=await import(pathToFileURL(bundle).href+'?page='+randomUUID());
  return {module,store:module.useComposerDraftStore,state:()=>module.useComposerDraftStore.getState(),flush:()=>listeners.get('beforeunload')?.()};
}
function create(p,id,body,logical='unit-logical-project'){
  p.state().setLogicalProjectDraftThreadId(logical,{environmentId,projectId},id,{threadId:'thread-'+id,createdAt:'2026-10-04T00:00:00.000Z',runtimeMode:'approval-required',interactionMode:'default'});
  if(body)p.state().setPrompt(id,body);
}
function attach(p,id,name='a.txt'){
  const file=new File(['UTF-8 草稿附件'],name,{type:'text/plain'}),fileId=randomUUID();
  p.state().addFiles(id,[{type:'file',id:fileId,name,mimeType:file.type,sizeBytes:file.size,file}],{appendReference:true});
  p.state().setFileUpload(id,fileId,environmentId,'uploaded-'+fileId);return fileId;
}
const persisted=s=>JSON.parse(s.getItem(key));
async function check(name,run){await test(name,async()=>{try{await run();report.checks.push({name,passed:true});}catch(e){report.checks.push({name,passed:false,error:String(e)});throw e;}});}
try{
  await check('distinct invested drafts and upload receipts survive a stale page flush',async()=>{
    const s=storage(),a=await page(s);create(a,'a','own body a');a.flush();const b=await page(s);create(b,'b','own body b');const fb=attach(b,'b','b.txt');b.flush();const fa=attach(a,'a');a.flush();
    const restored=await page(s);for(const [id,body,fileId] of [['a','own body a',fa],['b','own body b',fb]]){const draft=restored.state().getComposerDraft(id);assert.ok(draft.prompt.includes(body));assert.equal(draft.files[0].uploadedAttachmentId,'uploaded-'+fileId);assert.equal(restored.state().getDraftSession(id).threadId,'thread-'+id);}
    assert.equal(persisted(s).version,9);
  });
  await check('a queued stale update cannot revive a deliberately deleted draft',async()=>{
    const s=storage(),a=await page(s);create(a,'a','original');a.flush();const b=await page(s);b.state().setPrompt('a','stale pending edit');a.state().clearDraftThread('a');a.flush();b.flush();const restored=await page(s);assert.equal(restored.state().getDraftSession('a'),null);assert.equal(restored.state().getComposerDraft('a'),null);assert.deepEqual(persisted(s).state.logicalProjectDraftThreadKeyByLogicalProjectKey,{});
  });
  await check('late upload completion and unrelated edits do not restore an explicitly removed TXT',async()=>{
    const s=storage(),a=await page(s);create(a,'a','retain prose');const id=attach(a,'a');a.flush();const b=await page(s);b.state().setFileUpload('a',id,environmentId,'late-upload');a.state().removeFile('a',id);a.flush();b.flush();const restored=await page(s);const draft=restored.state().getComposerDraft('a');assert.equal(draft.files.length,0);assert.ok(draft.prompt.includes('retain prose'));assert.equal(draft.prompt.includes('t3-context://v1/file/'),false);
  });
  await check('clear storage remains cleared after a stale page unload',async()=>{
    const s=storage(),a=await page(s);create(a,'a','original');a.flush();const b=await page(s);b.state().setPrompt('a','queued before clear');a.store.persist.clearStorage();b.flush();const restored=await page(s);assert.equal(restored.state().getDraftSession('a'),null);assert.equal(restored.state().getComposerDraft('a'),null);
  });
  await check('promotion retains the server composer, unrelated draft, and drops the old session',async()=>{
    const s=storage(),a=await page(s);create(a,'a','promoted prose');create(a,'b','unrelated prose');a.flush();const b=await page(s);b.state().setDraftThreadContext('a',{branch:'stale-branch'});const ref={environmentId,threadId:'thread-a'};a.state().markDraftThreadPromoting('a',ref);a.state().finalizePromotedDraftThread('a');a.flush();b.flush();const restored=await page(s);assert.equal(restored.state().getDraftSession('a'),null);assert.ok(restored.state().getComposerDraft(ref).prompt.includes('promoted prose'));assert.ok(restored.state().getComposerDraft('b').prompt.includes('unrelated prose'));
  });
  await check('new-thread remapping still cleans an unused empty draft',async()=>{
    const s=storage(),a=await page(s);create(a,'empty','');a.flush();create(a,'fresh','fresh prose');a.flush();const restored=await page(s);assert.equal(restored.state().getDraftSession('empty'),null);assert.ok(restored.state().getComposerDraft('fresh').prompt.includes('fresh prose'));
  });
  await check('a genuinely new draft can replace the logical mapping after another page cleared its predecessor',async()=>{
    const s=storage(),a=await page(s);create(a,'old','old prose');a.flush();const b=await page(s);a.state().clearDraftThread('old');a.flush();create(b,'new','new prose');b.flush();const restored=await page(s);assert.equal(restored.state().getDraftSession('old'),null);assert.equal(restored.state().getDraftSessionByLogicalProjectKey('unit-logical-project').draftId,'new');
  });
  await check('legacy v2 aliases and v8 snapshots still hydrate body, identity and uploaded files',async()=>{
    for(const version of [2,8]){const s=storage(),a=await page(s);create(a,'legacy','legacy 中文正文');const id=attach(a,'legacy');a.flush();const old=persisted(s);old.version=version;if(version===2){old.state.draftsByThreadId=old.state.draftsByThreadKey;delete old.state.draftsByThreadKey;old.state.draftThreadsByThreadId=old.state.draftThreadsByThreadKey;delete old.state.draftThreadsByThreadKey;}s.setItem(key,JSON.stringify(old));const restored=await page(s);const draft=restored.state().getComposerDraft('legacy');assert.ok(draft.prompt.includes('legacy 中文正文'));assert.equal(draft.files[0].uploadedAttachmentId,'uploaded-'+id);assert.equal(restored.state().getDraftSession('legacy').threadId,'thread-legacy');restored.state().setPrompt('legacy',draft.prompt+' continued');restored.flush();assert.equal(persisted(s).version,9);}
  });
}finally{await new Promise(done=>setTimeout(done,350));assert.equal(report.networkCalls,0);await writeFile(join(directory,'observations.json'),JSON.stringify(report,null,2)+'\n');}
