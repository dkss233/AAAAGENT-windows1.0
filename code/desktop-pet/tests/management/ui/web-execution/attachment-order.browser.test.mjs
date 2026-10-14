import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';

for(const key of ['PLAYWRIGHT_MODULE','WEB_EXECUTION_FIXTURE_MODULE','WEB_EXECUTION_RUNTIME','WEB_EXECUTION_RENDERER_DIST','WEB_EXECUTION_NODE','WEB_EXECUTION_DEPENDENCY_SOURCE','WEB_EXECUTION_EVIDENCE','CONTROLLED_IMAGE_SOURCE'])assert.ok(process.env[key],key+' must identify an existing approved input');
const {startBrowserFixture}=await import(pathToFileURL(process.env.WEB_EXECUTION_FIXTURE_MODULE));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const require=createRequire(process.env.WEB_EXECUTION_FIXTURE_MODULE);
const {build}=await import(pathToFileURL(require.resolve('esbuild')));
const directory=resolve(process.env.WEB_EXECUTION_EVIDENCE);
assert.ok(directory.includes('/artifacts/W1/web-execution-56/'));
await mkdir(directory,{recursive:true,mode:0o700});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const image=await readFile(process.env.CONTROLLED_IMAGE_SOURCE);
assert.equal(digest(image),'8dc885909db5e0602ca1a69a374fac85144e4116d072edd67f482ea5b55e9fbc');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const cli=join(directory,'fake-codex');
await writeFile(cli,'#!/bin/sh\nexec '+quote(process.env.WEB_EXECUTION_NODE)+' '+quote(fileURLToPath(new URL('./fake-codex-cli.mjs',import.meta.url)))+' "$@"\n',{mode:0o700});
process.env.AAA_WEB_TEST_DIRECTORY=directory;
process.env.AAA_WEB_TEST_WIRE=join(process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,'apps/server/src/provider/testFixtures/codexMultiAgentWire.json');
process.env.AAA_WEB_TEST_SCHEMA=join(directory,'native-peer-schema.mjs');
await build({stdin:{contents:'import * as Schema from "effect/Schema";import * as C from '+JSON.stringify(join(process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,'packages/effect-codex-app-server/src/_generated/schema.gen.ts'))+';export const approval=Schema.decodeUnknownSync(C.ServerRequest__CommandExecutionRequestApprovalParams);export const question=Schema.decodeUnknownSync(C.ServerRequest__ToolRequestUserInputParams);export const resolved=Schema.decodeUnknownSync(C.ServerNotification__ServerRequestResolvedNotification);export const threadRead=Schema.decodeUnknownSync(C.V2ThreadReadResponse);',resolveDir:process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,loader:'ts'},outfile:process.env.AAA_WEB_TEST_SCHEMA,bundle:true,platform:'node',format:'esm',banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});
const providers=[{providerInstanceId:'codex',send:true,continue:true,modelSelection:true,runtimeModes:['approval-required'],attachments:{file:true,image:true,maxBytes:52428800},interrupt:true,approval:true,userInput:true}];
const observations={level:'isolated genuine original Composer, HTTP upload/WS/T3 SQLite and test-owned Codex protocol peer; no real model or daily home; no DSH question wire involved',commands:[],errors:[],snapshots:[],checks:[]};
let fixture,browser,context;const pages=[];let releaseUploads;
const editor=page=>page.locator('[data-testid="composer-editor"] [contenteditable="true"], [data-testid="composer-editor"][contenteditable="true"]').first();
async function eventually(check){let last;const until=Date.now()+15000;while(Date.now()<until){try{await check();return;}catch(error){last=error;await new Promise(done=>setTimeout(done,50));}}throw last;}
async function snapshot(page,label){
  const routeDraftId=new URL(page.url()).pathname.split('/').at(-1);
  const stored=await page.evaluate(id=>{const state=JSON.parse(localStorage.getItem('t3code:composer-drafts:v1')??'{}').state??{};return {session:state.draftThreadsByThreadKey?.[id]??null,draft:state.draftsByThreadKey?.[id]??null};},routeDraftId);
  const result={label,routeDraftId,...stored,editorText:await editor(page).innerText(),body:await page.locator('body').innerText(),fileShelfCount:await page.getByRole('button',{name:'Remove acceptance.txt',exact:true}).count(),imageShelfCount:await page.getByRole('button',{name:'Remove shapes.png',exact:true}).count()};
  if(observations.snapshots.at(-1)?.label===label)observations.snapshots[observations.snapshots.length-1]=result;else observations.snapshots.push(result);return result;
}
try{
  await test('path-selected attachments follow explicit editor deletion; two prepared drafts preserve files with prompt-before-attach',async()=>{
    fixture=await startBrowserFixture({runtimeSourceDir:process.env.WEB_EXECUTION_RUNTIME,dependencySourceDir:process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,nodeExecutable:process.env.WEB_EXECUTION_NODE,directory,rendererDist:resolve(process.env.WEB_EXECUTION_RENDERER_DIST),fakeCodexExecutable:cli,providers});
    const project=join(directory,'synthetic-project');await mkdir(project);execFileSync('/usr/bin/git',['init','-q'],{cwd:project});
    const projectId=randomUUID();await fixture.client.dispatch({type:'project.create',commandId:randomUUID(),projectId,title:'Controlled attachment order',workspaceRoot:project,createdAt:new Date().toISOString()});
    await fixture.client.dispatch({type:'project.meta.update',commandId:randomUUID(),projectId,defaultModelSelection:{instanceId:'codex',model:'fixture-a'}});
    const issued=await fixture.issueSession();assert.equal(issued.session.mode,'native-operate');const split=issued.cookie.indexOf('=');
    browser=await chromium.launch({headless:true});context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await context.addCookies([{name:issued.cookie.slice(0,split),value:issued.cookie.slice(split+1),url:fixture.origin,httpOnly:true,sameSite:'Strict'}]);
    await context.route('**/*',route=>new URL(route.request().url()).origin===fixture.origin?route.continue():route.abort());
    async function draftPage(){
      const page=await context.newPage();pages.push(page);page.setDefaultTimeout(15000);page.on('pageerror',error=>observations.errors.push(String(error)));
      page.on('websocket',socket=>socket.on('framesent',frame=>{try{const raw=JSON.parse(String(frame.payload));for(const item of Array.isArray(raw)?raw:[raw])if(item.tag==='orchestration.dispatchCommand')observations.commands.push(item.payload);}catch{}}));
      await page.goto(fixture.origin+'/native/?aaaProject='+projectId+'&aaaEnvironment='+fixture.environmentId);await page.getByRole('button',{name:'New thread',exact:true}).click();await editor(page).waitFor();
      await page.locator('[data-composer-shortcut="composer.mode"]:visible').first().click();await page.getByRole('option',{name:/^Supervised(?:\s|$)/}).or(page.getByRole('menuitemradio',{name:'Supervised',exact:true})).first().click();
      return page;
    }
    const inputs=[];
    for(const key of ['a','b']){
      const folder=join(directory,'inputs',key);await mkdir(folder,{recursive:true});const content=Buffer.from('UTF-8 attachment '+key+' '+randomUUID()+'\n');const file=join(folder,'acceptance.txt'),png=join(folder,'shapes.png');await writeFile(file,content);await writeFile(png,image);
      inputs.push({key,content,file,png,fileSha256:digest(content),imageSha256:digest(image),prompt:'controlled-order-'+key+'-'+randomUUID()});
    }
    const first=await draftPage();
    await first.locator('input[type=file]').first().setInputFiles([inputs[0].file,inputs[0].png]);await first.waitForLoadState('networkidle');
    await eventually(async()=>{const s=await snapshot(first,'before-full-fill');assert.equal(s.fileShelfCount,0);assert.equal(s.imageShelfCount,1);assert.ok(s.editorText.includes('acceptance.txt'));assert.equal(s.draft?.files?.length,1);});
    await first.screenshot({path:join(directory,'before-full-fill.png')});
    await editor(first).fill(inputs[0].prompt);await first.waitForLoadState('networkidle');
    await eventually(async()=>{const s=await snapshot(first,'after-full-fill');assert.equal(s.fileShelfCount,0);assert.equal(s.imageShelfCount,1);assert.equal(s.draft?.files?.length??0,0);assert.equal(s.editorText,inputs[0].prompt);});
    await first.screenshot({path:join(directory,'after-full-fill.png')});assert.equal(observations.commands.filter(c=>c.type==='thread.turn.start').length,0);
    observations.checks.push('one page and actual filesystem File paths: empty prompt attach inserts file chip; full editor fill removes file and keeps shelf-only image before any dispatch');
    await first.getByRole('button',{name:'Remove shapes.png',exact:true}).click();await editor(first).fill(inputs[0].prompt);
    let delayed=0;const held=new Promise(done=>{releaseUploads=done;});
    await first.route('**/api/attachments/upload/**',async route=>{delayed++;await held;await route.continue();});
    await first.locator('input[type=file]').first().setInputFiles([inputs[0].file,inputs[0].png]);
    await eventually(async()=>assert.ok(delayed>0,'original upload must actually reach the held route'));
    const during=await snapshot(first,'first-upload-held');assert.ok(during.editorText.includes('acceptance.txt'));
    const second=await draftPage();await second.locator('[data-chat-provider-model-picker="true"]:visible').first().click();await second.getByRole('option',{name:/fixture-B/i}).first().click();
    await editor(second).fill(inputs[1].prompt);await second.locator('input[type=file]').first().setInputFiles([inputs[1].file,inputs[1].png]);await second.waitForLoadState('networkidle');
    await eventually(async()=>{const s=await snapshot(second,'second-prepared-while-first-upload-held');assert.equal(s.draft?.files?.length,1);assert.equal(s.draft?.attachments?.length,1);assert.ok(s.editorText.includes('acceptance.txt'));assert.ok(s.editorText.includes('shapes.png'));assert.ok(s.draft?.files?.[0]?.attachmentId);});
    const secondPrepared=await snapshot(second,'second-own-persisted-identity');
    releaseUploads();await first.waitForLoadState('networkidle');await first.unroute('**/api/attachments/upload/**');
    const prepared=[];
    for(const [index,page] of [first,second].entries()){
      await eventually(async()=>{const s=await snapshot(page,'both-prepared-'+index);assert.ok(s.editorText.includes(inputs[index].prompt));assert.ok(s.editorText.includes('acceptance.txt'));assert.ok(s.editorText.includes('shapes.png'));assert.equal(/\d+%/.test(s.editorText),false);});
      const current=await snapshot(page,'freeze-'+index);const owned=index===0?current:secondPrepared;
      assert.equal(owned.draft?.files?.length,1);assert.equal(owned.draft?.attachments?.length,1);
      prepared.push({...current,observedOwnedSession:owned.session});await page.screenshot({path:join(directory,'prepared-'+index+'.png')});
    }
    assert.notEqual(prepared[0].observedOwnedSession.threadId,prepared[1].observedOwnedSession.threadId);assert.ok(prepared.every(s=>s.observedOwnedSession.environmentId===fixture.environmentId&&s.observedOwnedSession.projectId===projectId));
    observations.prepared=prepared;observations.delayedUploads=delayed;
    observations.sharedPersistedSnapshot={secondOwnIdentity:secondPrepared.session,secondAfterFirstUpload:prepared[1].session,secondPageStillHasOwnChips:prepared[1].editorText.includes('acceptance.txt')&&prepared[1].editorText.includes('shapes.png'),scope:'localStorage is shared across pages; recorded separately from each page runtime draft and outgoing command'};
    observations.checks.push('same browser context/project, two exact draft/thread identities, different models and path Files; first async upload held while second prepares; both complete with own file/image before send');
    for(const [index,page] of [first,second].entries()){
      const send=page.locator('button[type=submit][data-aaa-native-command="thread.turn.start"]:visible').first();assert.equal(await send.isDisabled(),false);await send.click();
      await page.getByText(new RegExp('actual attachment|实际附件内容:')).first().waitFor();
      await eventually(async()=>assert.equal(observations.commands.filter(c=>c.type==='thread.turn.start').length,index+1));
    }
    const starts=observations.commands.filter(c=>c.type==='thread.turn.start');assert.equal(starts.length,2);
    const wire=(await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(wire.filter(item=>item.method==='turn/start').length,2);assert.equal(wire.filter(item=>item.method==='thread/start').length,2);
    for(const [index,command] of starts.entries()){
      assert.equal(command.threadId,prepared[index].observedOwnedSession.threadId);assert.equal(command.bootstrap.createThread.projectId,projectId);
      const file=command.message.attachments.find(a=>a.type==='file'),png=command.message.attachments.find(a=>a.type==='image');assert.ok(file);assert.ok(png);assert.equal(command.message.attachments.length,2);
      for(const [attachment,kind] of [[file,'file'],[png,'image']])assert.ok(command.message.context.records.some(r=>r.kind===kind&&r.attachmentId===attachment.id));
      const read=wire.find(item=>item.fixture==='file.read'&&item.sha256===inputs[index].fileSha256);assert.ok(read);assert.equal(read.content,inputs[index].content.toString());
      const native=wire.filter(item=>item.method==='turn/start')[index];assert.equal(native.params.model,index===0?'fixture-a':'fixture-b');
      const part=native.params.input.find(p=>p.type==='localImage');assert.ok(part);
      const imagePath=await realpath(part.path);assert.ok(imagePath.startsWith(join(directory,'t3-home/userdata/attachments')+'/'));assert.equal(digest(await readFile(imagePath)),inputs[index].imageSha256);
    }
    observations.nativeWire=wire;observations.expectedInputs=inputs.map(({content,file,png,...rest})=>({...rest,bytes:content.length}));
    observations.inputs={serverBinSha256:digest(await readFile(join(process.env.WEB_EXECUTION_RUNTIME,'apps/server/dist/bin.mjs'))),rendererReceiptSha256:digest(await readFile(join(process.env.WEB_EXECUTION_RENDERER_DIST,'aaa-native-read-build.json'))),fixtureModuleSha256:digest(await readFile(process.env.WEB_EXECUTION_FIXTURE_MODULE)),testSha256:digest(await readFile(new URL(import.meta.url)))};
    assert.deepEqual(observations.errors,[]);
    observations.checks.push('two corrected original commands carry file+image with exact context identities; original native input references bytes actually read by peer and exact image SHA, no cross-draft nonce swap');
  });
}finally{
  releaseUploads?.();for(const [index,page] of pages.entries()){await snapshot(page,'last-'+index).catch(()=>{});await page.screenshot({path:join(directory,'last-'+index+'.png')}).catch(()=>{});}
  await browser?.close();await fixture?.close();await writeFile(join(directory,'observations.json'),JSON.stringify(observations,null,2)+'\n');
}
