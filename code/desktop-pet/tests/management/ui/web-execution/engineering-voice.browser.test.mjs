import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const hash = value => createHash('sha256').update(value).digest('hex');
const own = resolve(process.cwd()), root = resolve(own, '../../..');
assert.ok(process.env.ENGINEERING_VOICE_INPUT && process.env.ENGINEERING_VOICE_EVIDENCE);
const inputBytes = await readFile(process.env.ENGINEERING_VOICE_INPUT), input = JSON.parse(inputBytes);
const ownershipBytes = await readFile(join(root, 'docs/agent/blackboard/OWNERSHIP.json')), ownership = JSON.parse(ownershipBytes);
const registration = ownership.tasks.find(t => ['W1','W0-I'].includes(t.task_id) && resolve(t.worktree) === own);
assert.ok(registration && registration.current_package_id === 'B56-ENGINEERING-VOICE-UI-01');
const scope = join(own, 'artifacts/W1/web-execution-56/engineering-voice-01'), directory = resolve(process.env.ENGINEERING_VOICE_EVIDENCE);
assert.ok(directory.startsWith(scope+'/') && !existsSync(directory));
assert.ok(registration.writable_paths.some(p => directory.startsWith(join(own,p).replace(/\/$/,'')+'/')));
execFileSync('/usr/bin/git',['merge-base','--is-ancestor',input.baseline,'HEAD']);
for (const entry of input.inputs) assert.equal(hash(await readFile(entry.path)),entry.sha256,entry.path);
for (const entry of input.sourceInputs) assert.equal(hash(await readFile(join(input.build,entry.relativePath))),entry.sha256,entry.relativePath);
for (const entry of input.compiledFiles) assert.equal(hash(await readFile(entry.path)),entry.sha256,entry.path);
for (const entry of input.productFiles) assert.equal(hash(await readFile(join(own,entry.path))),entry.sha256,entry.path);
const req = createRequire(input.runtime.fixture.path), {build} = await import(pathToFileURL(req.resolve('esbuild')));
const {startBrowserFixture} = await import(pathToFileURL(input.runtime.fixture.path));
const {chromium} = await import(pathToFileURL(input.runtime.playwrightModule));
await mkdir(directory,{recursive:true,mode:0o700});
process.env.AAA_WEB_TEST_DIRECTORY=directory;
process.env.AAA_WEB_TEST_WIRE=join(input.runtime.dependencySource,'apps/server/src/provider/testFixtures/codexMultiAgentWire.json');
process.env.AAA_WEB_TEST_SCHEMA=join(directory,'native-peer-schema.mjs');
await build({stdin:{contents:'import * as S from "effect/Schema";import * as C from '+JSON.stringify(join(input.runtime.dependencySource,'packages/effect-codex-app-server/src/_generated/schema.gen.ts'))+';export const approval=S.decodeUnknownSync(C.ServerRequest__CommandExecutionRequestApprovalParams);export const question=S.decodeUnknownSync(C.ServerRequest__ToolRequestUserInputParams);export const resolved=S.decodeUnknownSync(C.ServerNotification__ServerRequestResolvedNotification);export const threadRead=S.decodeUnknownSync(C.V2ThreadReadResponse);',resolveDir:input.runtime.dependencySource,loader:'ts'},outfile:process.env.AAA_WEB_TEST_SCHEMA,bundle:true,platform:'node',format:'esm',banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});
const quote=v=>"'"+v.replaceAll("'","'\\''")+"'", cli=join(directory,'fake-codex');
await writeFile(cli,'#!/bin/sh\nexec '+quote(input.runtime.childNode)+' '+quote(fileURLToPath(new URL('./fake-codex-cli.mjs',import.meta.url)))+' "$@"\n',{mode:0o700});
const report={scope:'controlled media and HTTP responses in original authenticated mounted renderer/composer; no physical microphone, real ASR, model, installed GUI or native execution',input:{path:process.env.ENGINEERING_VOICE_INPUT,sha256:hash(inputBytes)},formal:ownership.revision,baseline:input.baseline,productFiles:input.productFiles,voiceRequests:[],checks:[],media:[],screenshots:[],commands:[],blocked:[],pageErrors:[],bootstrap:[]};
let fixture,browser,context,projectId,capabilityMode='ready',voiceMode='completed',coldMode='unknown';
const receipts=new Map(),pages=[],held=[];
const raw='  twelve 十二 English  42  ',edited='  编辑后的十二 English  42  ';
const editor=p=>p.locator('[data-testid="composer-editor"] [contenteditable="true"], [data-testid="composer-editor"][contenteditable="true"]').first();
async function eventually(fn){let last;for(let i=0;i<200;i++){try{return await fn();}catch(error){last=error;await new Promise(r=>setTimeout(r,50));}}throw last;}
async function saved(page){return page.evaluate(()=>{const id=new URL(location.href).pathname.split('/').at(-1),s=JSON.parse(localStorage.getItem('t3code:composer-drafts:v1')??'{}').state??{};return {id,session:s.draftThreadsByThreadKey?.[id],draft:s.draftsByThreadKey?.[id]};});}
async function observe(){const page=await context.newPage();pages.push(page);page.setDefaultTimeout(7000);page.on('pageerror',e=>report.pageErrors.push(String(e)));return page;}
async function draft(label){const page=await observe();await page.goto(fixture.origin+'/native/?aaaProject='+projectId+'&aaaEnvironment='+fixture.environmentId);await page.getByRole('button',{name:'New thread',exact:true}).click();await editor(page).waitFor();await page.locator('[data-composer-shortcut="composer.mode"]:visible').first().click();await page.getByRole('option',{name:/^Supervised(?:\s|$)/}).or(page.getByRole('menuitemradio',{name:'Supervised',exact:true})).first().click();await editor(page).fill(label);await eventually(async()=>{const s=await saved(page);assert.ok(s.session?.threadId);assert.ok(s.draft?.prompt?.includes(label));});return page;}
async function record(page){await page.getByRole('button',{name:'◉ 语音输入',exact:true}).click();await page.getByRole('button',{name:'停止录音',exact:true}).waitFor();await page.waitForTimeout(100);}
async function releaseCheck(page){await eventually(async()=>{const stats=await page.evaluate(()=>window.__voiceStats);assert.equal(stats.activeTracks,0);assert.equal(stats.activeContexts,0);return stats;});report.media.push(await page.evaluate(()=>window.__voiceStats));}
async function screenshot(page,name){const path=join(directory,name+'.png');await page.screenshot({path});report.screenshots.push(path);}
try {
 fixture=await startBrowserFixture({runtimeSourceDir:resolve(input.runtime.currentBin.path,'../../../..'),dependencySourceDir:input.runtime.dependencySource,nodeExecutable:input.runtime.childNode,directory,rendererDist:join(input.build,'apps/web/dist'),fakeCodexExecutable:cli,providers:[{providerInstanceId:'codex',send:true,continue:true,modelSelection:true,runtimeModes:['approval-required'],attachments:{file:true,image:true,maxBytes:52428800},interrupt:true,approval:true,userInput:true}]});
 const settings=JSON.parse(await readFile(join(directory,'fixture-configuration.json'),'utf8'));assert.equal(settings.schemaDecodedBeforeStart,true);assert.equal(settings.effectiveOriginalSettingsMatched,true);assert.deepEqual(settings.enabledProviders,['codex']);assert.equal(settings.binaryPath,cli);report.settings=settings;
 const project=join(directory,'project');await mkdir(project);execFileSync('/usr/bin/git',['init','-q'],{cwd:project});projectId=randomUUID();
 for(const command of [{type:'project.create',commandId:randomUUID(),projectId,title:'Engineering voice controlled UI',workspaceRoot:project,createdAt:new Date().toISOString()},{type:'project.meta.update',commandId:randomUUID(),projectId,defaultModelSelection:{instanceId:'codex',model:'fixture-a'}}]){await fixture.client.dispatch(command);report.bootstrap.push(command);}
 const session=await fixture.issueSession();assert.equal(session.session.mode,'native-operate');report.sessionMode=session.session.mode;
 browser=await chromium.launch({headless:true,executablePath:input.runtime.chromiumExecutable});context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
 const split=session.cookie.indexOf('=');await context.addCookies([{name:session.cookie.slice(0,split),value:session.cookie.slice(split+1),url:fixture.origin,httpOnly:true,sameSite:'Strict'}]);
 await context.addInitScript(()=>{
   const stats=window.__voiceStats={getUserMedia:0,tracksStopped:0,activeTracks:0,contextsClosed:0,activeContexts:0};
   window.__mediaMode='ready';window.__mediaGrant=null;
   const stream=()=>{stats.activeTracks++;let stopped=false;return {getTracks:()=>[{stop(){if(!stopped){stopped=true;stats.tracksStopped++;stats.activeTracks--;}}}]};};
   Object.defineProperty(navigator,'mediaDevices',{value:{async getUserMedia(){stats.getUserMedia++;if(window.__mediaMode==='deny')throw Error('controlled denial');if(window.__mediaMode==='delay')return new Promise(resolve=>{window.__mediaGrant=()=>resolve(stream());});return stream();}}});
   class Node {connect(){}disconnect(){}}
   class Context {
    sampleRate=48000;state='running';destination={};timer=null;processor=null;
    constructor(){stats.activeContexts++;}createMediaStreamSource(){return new Node();}
    createScriptProcessor(){this.processor={connect(){},disconnect(){},onaudioprocess:null};return this.processor;}
    createGain(){return {connect(){},disconnect(){},gain:{value:1}};}
    async resume(){this.timer=setInterval(()=>{this.processor?.onaudioprocess?.({inputBuffer:{numberOfChannels:1,length:4096,getChannelData:()=>new Float32Array(4096).fill(0.25)}});},20);}
    async close(){if(this.state==='closed')return;clearInterval(this.timer);this.state='closed';stats.contextsClosed++;stats.activeContexts--;}
   }
   window.AudioContext=Context;
 });
 // The owned HTTP replacement is deliberately recorded separately from I's service acceptance.
 await context.route('**/api/native-mount/voice/**',async route=>{
   const request=route.request(),url=new URL(request.url());
   const headers=await request.allHeaders();
   assert.ok((headers.cookie??'').includes('aaa_native_read_session='),'Original authenticated cookie must be present');
   if(url.pathname.endsWith('/capabilities'))return route.fulfill({status:capabilityMode==='ready'?200:capabilityMode==='readonly'?403:503,json:capabilityMode==='ready'?{version:'0.1.0',available:true,model:'controlled-asr',sampleRate:16000,channels:1,bits:16,maxAudioSeconds:60}:{error:'unavailable'}});
   if(request.method()==='POST'){
    const body=request.postDataJSON();assert.equal(url.origin,fixture.origin);assert.equal(body.version,'0.1.0');assert.ok(body.target.draftId);assert.equal(body.target.environmentId,fixture.environmentId);assert.equal(body.target.projectId,projectId);
    const bytes=Buffer.from(body.audio.wavBase64,'base64');assert.equal(bytes.readUInt32LE(24),16000);assert.equal(bytes.readUInt16LE(22),1);assert.equal(bytes.readUInt16LE(34),16);
    const receipt={version:body.version,inputId:body.inputId,target:body.target,status:voiceMode==='unknown'?'unknown':'completed',...(voiceMode==='unknown'?{}:{transcript:raw})};receipts.set(body.inputId,receipt);
    report.voiceRequests.push({method:'POST',inputId:body.inputId,target:body.target,bytes:bytes.length,authenticatedCookie:true,mode:voiceMode});
    if(voiceMode==='held')await new Promise(resolve=>held.push(resolve));
    try{return await route.fulfill({json:receipt});}catch{return;}
   }
   const inputId=url.pathname.split('/').at(-1),target=JSON.parse(url.searchParams.get('target'));assert.deepEqual(target,receipts.get(inputId)?.target);
   report.voiceRequests.push({method:'GET',inputId,target,authenticatedCookie:true});
   try{return await route.fulfill({json:{...receipts.get(inputId),status:coldMode,...(coldMode==='completed'?{transcript:raw}:{transcript:undefined})}});}catch{return;}
 });
 await context.route('**/*',async route=>{const request=route.request();if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/native-mount/dispatch'){report.blocked.push('HTTP dispatch');return route.abort();}return route.fallback();});
 await context.routeWebSocket('**/websocket',ws=>{const server=ws.connectToServer();ws.onMessage(message=>{let value;try{value=JSON.parse(String(message));}catch{}if(value?.method==='orchestration.dispatchCommand'){report.commands.push(value.params);report.blocked.push('WS dispatch');return;}server.send(message);});});
 const probe=await observe();await probe.goto(fixture.origin+'/native/');report.browserFetchReceiverProbe=await probe.evaluate(async()=>{const value={request:fetch};try{await value.request('/api/native-mount/voice/capabilities');return 'accepted';}catch(error){return String(error);}});await probe.close();
 await test('original draft shows editable raw words and appends once with uploaded TXT and fields retained, zero Send',async()=>{
  const body='Original unsent body '+randomUUID(),page=await draft(body),file=join(directory,'original.txt');await writeFile(file,'UTF-8 attachment 保持 '+randomUUID());await page.locator('input[type=file]').first().setInputFiles(file);
  await eventually(async()=>{const s=await saved(page);assert.ok(s.draft?.files?.[0]?.attachmentId);});const before=await saved(page);
  await record(page);await page.getByRole('button',{name:'停止录音',exact:true}).click();const text=page.getByRole('textbox',{name:'识别原话',exact:true});await text.waitFor();assert.equal(await text.inputValue(),raw);await screenshot(page,'raw-review');await text.fill(edited);
  const post=report.voiceRequests.filter(r=>r.method==='POST').at(-1);assert.deepEqual(post.target,{environmentId:before.session.environmentId,projectId:before.session.projectId,threadId:before.session.threadId,draftId:before.id,captureEpoch:post.target.captureEpoch});
  await page.getByRole('button',{name:'放入当前草稿',exact:true}).click({clickCount:2});
  await eventually(async()=>assert.ok((await saved(page)).draft?.prompt?.includes(edited)));const after=await saved(page);
  assert.equal(after.draft.prompt,before.draft.prompt+'\n'+edited);const withoutPrompt=v=>{const x={...v};delete x.prompt;return x;};assert.deepEqual(withoutPrompt(after.draft),withoutPrompt(before.draft));assert.deepEqual(after.session,before.session);assert.ok((await editor(page).innerText()).includes('original.txt'));
  await releaseCheck(page);await screenshot(page,'appended-with-attachment');report.checks.push({name:'raw-edit-append-once',before,after});await page.close();
 });
 await test('record cancellation leaves body intact and releases tracks without POST',async()=>{
  const page=await draft('cancel original body'),before=await saved(page),count=report.voiceRequests.length;await record(page);await page.getByRole('button',{name:'取消语音输入',exact:true}).click();await releaseCheck(page);assert.deepEqual(await saved(page),before);assert.equal(report.voiceRequests.length,count);await page.close();report.checks.push({name:'record-cancel'});
 });
 await test('late permission grant after route switch is released and never opens audio or changes new draft',async()=>{
  const page=await draft('permission pending old body');await page.evaluate(()=>window.__mediaMode='delay');await page.getByRole('button',{name:'◉ 语音输入',exact:true}).click();await eventually(async()=>assert.equal(await page.evaluate(()=>typeof window.__mediaGrant),'function'));
  const old=await saved(page);await page.getByRole('button',{name:'New thread',exact:true}).click();await editor(page).fill('new target remains');await page.evaluate(()=>{window.__mediaMode='ready';window.__mediaGrant();});await releaseCheck(page);
  await eventually(async()=>assert.ok((await saved(page)).draft?.prompt?.includes('new target remains')));const next=await saved(page);assert.notEqual(next.id,old.id);assert.equal(next.draft.prompt,'new target remains');assert.equal((await page.evaluate(()=>window.__voiceStats)).contextsClosed,0);await page.close();report.checks.push({name:'late-permission-route-switch',old,next});
 });
 await test('unknown only cold reads same input, manual query can show raw and cancel never appends',async()=>{
  voiceMode='unknown';coldMode='unknown';const page=await draft('unknown original body'),before=await saved(page),start=report.voiceRequests.length;await record(page);await page.getByRole('button',{name:'停止录音',exact:true}).click();await page.getByRole('button',{name:'查询这次输入',exact:true}).waitFor();await releaseCheck(page);
  coldMode='completed';await page.getByRole('button',{name:'查询这次输入',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'识别原话',exact:true}).inputValue(),raw);await page.getByRole('button',{name:'取消语音输入',exact:true}).click();
  await eventually(async()=>assert.ok(report.voiceRequests.slice(start).filter(r=>r.method==='GET').length>=3));const requests=report.voiceRequests.slice(start);assert.equal(requests.filter(r=>r.method==='POST').length,1);assert.equal(new Set(requests.map(r=>r.inputId)).size,1);assert.deepEqual(await saved(page),before);await page.close();voiceMode='completed';coldMode='unknown';report.checks.push({name:'unknown-cold-read',requests});
 });
 await test('late ASR after route change is discarded, cancellation cold reads original target',async()=>{
  voiceMode='held';const page=await draft('ASR pending old body'),old=await saved(page),start=report.voiceRequests.length;await record(page);await page.getByRole('button',{name:'停止录音',exact:true}).click();await eventually(async()=>assert.equal(report.voiceRequests.slice(start).filter(r=>r.method==='POST').length,1));
  await page.getByRole('button',{name:'New thread',exact:true}).click();await editor(page).fill('new target after ASR');await eventually(async()=>assert.ok((await saved(page)).draft?.prompt?.includes('new target after ASR')));const next=await saved(page);assert.notEqual(old.id,next.id);
  held.splice(0).forEach(resolve=>resolve());await eventually(async()=>assert.ok(report.voiceRequests.slice(start).some(r=>r.method==='GET')));await page.waitForTimeout(150);assert.equal((await saved(page)).draft.prompt,'new target after ASR');assert.equal(await page.getByRole('textbox',{name:'识别原话',exact:true}).count(),0);await releaseCheck(page);await page.close();voiceMode='completed';report.checks.push({name:'late-asr-discard',old,next,requests:report.voiceRequests.slice(start)});
 });
 await test('unmount during active recording releases microphone resources',async()=>{
  const page=await draft('unmount original body');await record(page);await page.getByRole('button',{name:'New thread',exact:true}).click();await releaseCheck(page);assert.equal(await page.getByRole('button',{name:'停止录音',exact:true}).count(),0);await page.close();report.checks.push({name:'record-unmount'});
 });
 await test('denied microphone can cancel and recover; readonly and unavailable capability never request media',async()=>{
  const page=await draft('denied original body');await page.evaluate(()=>window.__mediaMode='deny');await page.getByRole('button',{name:'◉ 语音输入',exact:true}).click();await page.getByText('麦克风无法使用或未获得权限，请检查浏览器设置。',{exact:true}).waitFor();await releaseCheck(page);assert.equal(await page.getByRole('button',{name:'◉ 语音输入',exact:true}).isEnabled(),true);await page.close();
  for(const mode of ['readonly','unavailable']){capabilityMode=mode;const p=await draft(mode+' body');await p.getByText('当前连接的语音输入不可用，请从控制台重新进入。',{exact:true}).waitFor();assert.equal(await p.getByRole('button',{name:'◉ 语音输入',exact:true}).isEnabled(),false);assert.equal((await p.evaluate(()=>window.__voiceStats)).getUserMedia,0);await p.close();}capabilityMode='ready';report.checks.push({name:'denied-readonly-unavailable'});
 });
 report.database={threads:fixture.database.prepare('SELECT COUNT(*) n FROM projection_threads').get().n,turns:fixture.database.prepare('SELECT COUNT(*) n FROM projection_turns').get().n,messages:fixture.database.prepare('SELECT COUNT(*) n FROM projection_thread_messages').get().n};
 assert.deepEqual(report.database,{threads:0,turns:0,messages:0});assert.deepEqual(report.commands,[]);assert.deepEqual(report.blocked,[]);assert.deepEqual(report.pageErrors,[]);
} finally {
 held.splice(0).forEach(resolve=>resolve());for(const [i,page]of pages.entries())if(!page.isClosed())await screenshot(page,'remaining-'+i).catch(()=>{});
 await browser?.close();await fixture?.close();report.processesClosed=true;
 const wire=join(directory,'fake-provider-wire.jsonl');report.nativeWire=existsSync(wire)?(await readFile(wire,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse):[];
 report.nativeThreadOrTurnStarts=report.nativeWire.filter(x=>['thread/start','turn/start','thread/resume','turn/interrupt'].includes(x.method)).length;
 report.testSha256=hash(await readFile(new URL(import.meta.url)));await writeFile(join(directory,'observations.json'),JSON.stringify(report,null,2)+'\n');assert.equal(report.nativeThreadOrTurnStarts,0);
}
