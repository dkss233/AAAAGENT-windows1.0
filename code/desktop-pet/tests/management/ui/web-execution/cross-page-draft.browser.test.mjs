import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
assert.ok(process.env.CROSS_PAGE_INPUT_RECEIPT,'Exact registered input receipt required');
assert.ok(process.env.CROSS_PAGE_EVIDENCE,'Fresh owned evidence directory required');
const receiptBytes=await readFile(process.env.CROSS_PAGE_INPUT_RECEIPT);
assert.equal(digest(receiptBytes),'50e198f3581ad2202934ebd823a4302afbae86667812b72b72a9820e2ebe4678');
const receipt=JSON.parse(receiptBytes),input=receipt.runtime;
const root=resolve(receipt.git.worktree,'../../..'),own=resolve(process.cwd());
const ownershipBytes=await readFile(join(root,'docs/agent/blackboard/OWNERSHIP.json'));
const ownership=JSON.parse(ownershipBytes),registration=ownership.tasks.find(t=>['W1','W0-I'].includes(t.task_id)&&resolve(t.worktree)===own);
assert.ok(registration,'Only the formally registered W1 or I worktree may execute');
assert.equal(registration.current_package_id,'B56-WEB-EXECUTION-COMPLETION');
const artifactRoot=join(own,registration.actual_artifact_root);
const evidenceRoot=artifactRoot.endsWith('/cross-page-draft-snapshot-01/')||artifactRoot.endsWith('/cross-page-draft-snapshot-01')?artifactRoot:join(artifactRoot,'cross-page-draft-snapshot-01');
assert.ok(registration.writable_paths.some(p=>p.startsWith('artifacts/')&&(evidenceRoot+ '/').startsWith(join(own,p).replace(/\/$/,'')+'/')));
execFileSync('/usr/bin/git',['merge-base','--is-ancestor',registration.task_id==='W1'?receipt.git.currentHead:receipt.git.currentMainline,'HEAD']);
const testExecutionGitHead=execFileSync('/usr/bin/git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const directory=resolve(process.env.CROSS_PAGE_EVIDENCE);
assert.ok(directory.startsWith(evidenceRoot.replace(/\/$/,'')+'/'),'Evidence must remain in this executor own registered draft scope');
assert.equal(existsSync(directory),false,'Never reuse a fixture home');
const sourceInputs=[];
async function verify(entry){const bytes=await readFile(entry.path);assert.equal(digest(bytes),entry.sha256,entry.path);sourceInputs.push(entry);}
for(const group of ['inputFiles','formalInputs','oldOriginals'])for(const entry of receipt[group])await verify(entry);
for(const entry of receipt.productUI.sourceFiles)for(const base of [root,own])await verify({...entry,path:join(base,entry.path)});
const transitiveFiles=['code/workbench/integration/t3-child-service.mjs','code/workbench/integration/t3-http-client.mjs','code/desktop-pet/workbench/native-mount/execution-binding.mjs','code/desktop-pet/workbench/native-mount/execution-gate.mjs','code/desktop-pet/workbench/native-mount/server.mjs'];
const integrationRoot=resolve(input.fixture.path,'../../../../../../');
for(const path of transitiveFiles){const actual=join(integrationRoot,path);const bytes=await readFile(actual);assert.equal(digest(bytes),digest(await readFile(join(own,path))));sourceInputs.push({path:actual,sha256:digest(bytes)});}
assert.ok(process.env.CROSS_PAGE_CANDIDATE_RECEIPT,'Registered new renderer receipt required');
const candidateBytes=await readFile(process.env.CROSS_PAGE_CANDIDATE_RECEIPT);
assert.equal(digest(candidateBytes),'777f98a4e314d4734ddbdbe8e517e49af7158753acc5956d87bad88c4b2c537f');
const candidate=JSON.parse(candidateBytes);
assert.equal(candidate.inputReceiptSha256,digest(receiptBytes));
assert.equal(candidate.repairRegistrationSha256,'87b3eff12a3ad209f6f18305d63fce1ce4c719388badc8523b4e3dfe7fb5137d');
assert.ok(candidate.build.startsWith(join(receipt.git.worktree,'artifacts/W1/web-execution-56/cross-page-draft-snapshot-01')+'/'));
const composerPath='code/desktop-pet/t3-native/apps/web/src/composerDraftStore.ts';
assert.equal(candidate.productSource.path,join(receipt.git.worktree,composerPath));
assert.equal(digest(await readFile(join(own,composerPath))),candidate.productSource.sha256);
assert.ok([candidate.originalComposerSha256,candidate.productSource.sha256].includes(digest(await readFile(join(root,composerPath)))));
await verify(candidate.productSource);await verify(candidate.rendererReceipt);await verify(candidate.index);await verify(candidate.materialization);
assert.equal(digest(execFileSync('/usr/bin/git',['show',candidate.sourceCommit+':'+composerPath])),candidate.productSource.sha256);
if(registration.task_id==='W1')execFileSync('/usr/bin/git',['merge-base','--is-ancestor',candidate.sourceCommit,'HEAD']);
else assert.equal(digest(execFileSync('/usr/bin/git',['show','HEAD:'+composerPath])),candidate.productSource.sha256,'Integrated committed blob must equal the tested original source');
assert.deepEqual(candidate.sourceInputs.filter(e=>e.sha256!==e.originalSha256).map(e=>e.relativePath),['apps/web/src/composerDraftStore.ts']);
for(const entry of candidate.sourceInputs)assert.equal(digest(await readFile(join(candidate.build,entry.relativePath))),entry.sha256);
for(const entry of candidate.compiledFiles)assert.equal(digest(await readFile(entry.path)),entry.sha256);
const rendererReceipt=JSON.parse(await readFile(candidate.rendererReceipt.path,'utf8'));
assert.equal(rendererReceipt.mode,'native-read');assert.equal(rendererReceipt.base,'/native/');
assert.equal(rendererReceipt.assemblySha256,candidate.assemblySha256);assert.equal(rendererReceipt.indexSha256,candidate.index.sha256);
assert.equal(rendererReceipt.composerSha256,candidate.productSource.sha256);
const assembly=JSON.stringify(candidate.sourceInputs.map(e=>({originalSha256:e.originalSha256,relativePath:e.relativePath,sha256:e.sha256})));
assert.equal(digest(Buffer.from(assembly)),candidate.assemblySha256);
await access(input.chromiumExecutable);assert.equal(execFileSync(input.parentNode,['--version'],{encoding:'utf8'}).trim(),'v'+input.parentNodeVersion);assert.equal(execFileSync(input.childNode,['--version'],{encoding:'utf8'}).trim(),'v'+input.childNodeVersion);
const require=createRequire(input.fixture.path),{build}=await import(pathToFileURL(require.resolve('esbuild')));
const {startBrowserFixture}=await import(pathToFileURL(input.fixture.path));
const {chromium}=await import(pathToFileURL(input.playwrightModule));
assert.equal(JSON.parse(await readFile(join(dirname(input.playwrightModule),'package.json'),'utf8')).version,input.playwrightVersion);
assert.equal(chromium.executablePath(),input.chromiumExecutable);
await mkdir(directory,{recursive:true,mode:0o700});
process.env.AAA_WEB_TEST_DIRECTORY=directory;
process.env.AAA_WEB_TEST_WIRE=join(input.dependencySource,'apps/server/src/provider/testFixtures/codexMultiAgentWire.json');
process.env.AAA_WEB_TEST_SCHEMA=join(directory,'native-peer-schema.mjs');
await build({stdin:{contents:'import * as S from "effect/Schema";import * as C from '+JSON.stringify(join(input.dependencySource,'packages/effect-codex-app-server/src/_generated/schema.gen.ts'))+';export const approval=S.decodeUnknownSync(C.ServerRequest__CommandExecutionRequestApprovalParams);export const question=S.decodeUnknownSync(C.ServerRequest__ToolRequestUserInputParams);export const resolved=S.decodeUnknownSync(C.ServerNotification__ServerRequestResolvedNotification);export const threadRead=S.decodeUnknownSync(C.V2ThreadReadResponse);',resolveDir:input.dependencySource,loader:'ts'},outfile:process.env.AAA_WEB_TEST_SCHEMA,bundle:true,platform:'node',format:'esm',banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'",peer=fileURLToPath(new URL('./fake-codex-cli.mjs',import.meta.url)),cli=join(directory,'fake-codex');
await writeFile(cli,'#!/bin/sh\nprintf "%s\\n" fixture-invocation >> '+quote(join(directory,'fake-cli-invocations.log'))+'\nexec '+quote(input.childNode)+' '+quote(peer)+' "$@"\n',{mode:0o700});
const report={scope:'original E02 unsent draft refresh/reentry subset; no Send, native thread/turn, real model, installed home, DSH Host, App or device',inputReceipt:{path:process.env.CROSS_PAGE_INPUT_RECEIPT,sha256:digest(receiptBytes)},executionOwnership:{path:join(root,'docs/agent/blackboard/OWNERSHIP.json'),revision:ownership.revision,sha256:digest(ownershipBytes),taskId:registration.task_id,worktree:own,evidenceRoot},git:{...receipt.git,testExecutionGitHead},productUI:receipt.productUI.source,candidate:{inputReceipt:{path:process.env.CROSS_PAGE_CANDIDATE_RECEIPT,sha256:digest(candidateBytes)},sourceCommit:candidate.sourceCommit,productSource:candidate.productSource,rendererReceipt:candidate.rendererReceipt,index:candidate.index,assemblySha256:candidate.assemblySha256,sourceFilesVerified:candidate.sourceInputs.length,compiledFilesVerified:candidate.compiledFiles.length,onlyComposerException:true},sourceInputs,snapshots:[],checks:[],failures:[],browserCommands:[],blockedCommands:[],uploads:[],assetReads:[],pageErrors:[],bootstrapCommands:[]};
let fixture,browser,context,releaseUpload;const pages=[],pendingReads=[];
const editor=page=>page.locator('[data-testid="composer-editor"] [contenteditable="true"], [data-testid="composer-editor"][contenteditable="true"]').first();
async function eventually(check){let last;const until=Date.now()+15000;while(Date.now()<until){try{await check();return;}catch(e){last=e;await new Promise(done=>setTimeout(done,50));}}throw last;}
async function snapshot(page,label){
  const url=page.url(),routeDraftId=new URL(url).pathname.split('/').at(-1);
  const stored=await page.evaluate(id=>{const state=JSON.parse(localStorage.getItem('t3code:composer-drafts:v1')??'{}').state??{};return {session:state.draftThreadsByThreadKey?.[id]??null,draft:state.draftsByThreadKey?.[id]??null};},routeDraftId);
  const visible=await editor(page).count()>0&&await editor(page).isVisible();
  const record={label,url,routeDraftId,...stored,editorText:visible?await editor(page).innerText():null,editorHTML:visible?await editor(page).innerHTML():null,chips:visible?await editor(page).locator('[aria-label^="File attachment,"], [aria-label^="Unavailable context,"]').evaluateAll(nodes=>nodes.map(node=>({text:node.innerText,tag:node.tagName,copyMarkdown:node.getAttribute('data-markdown-copy'),unresolved:node.getAttribute('data-context-unresolved'),label:node.getAttribute('aria-label')}))):[],body:await page.locator('body').innerText()};
  if(report.snapshots.at(-1)?.label===label)report.snapshots[report.snapshots.length-1]=record;else report.snapshots.push(record);return record;
}
function fail(phase,index,detail){report.failures.push({phase,index,detail});}
async function observePage(){
  const page=await context.newPage();pages.push(page);page.setDefaultTimeout(15000);page.on('pageerror',e=>report.pageErrors.push(String(e)));
  page.on('response',response=>{
    const path=new URL(response.url()).pathname,request=response.request();
    if(path.startsWith('/native/api/attachments/upload/')||path.startsWith('/api/attachments/upload/'))report.uploads.push({method:request.method(),status:response.status()});
    if(request.method()==='GET'&&(path.startsWith('/native/api/assets/')||path.startsWith('/api/assets/')))pendingReads.push((async()=>{try{for(const [transport,actual] of [['browser-response-body',response],['isolated-http-read',await context.request.get(response.url())]]){const bytes=await actual.body(),text=bytes.toString('utf8');report.assetReads.push({transport,status:actual.status(),contentType:actual.headers()['content-type'],bytes:bytes.length,sha256:digest(bytes),ownNonceMatches:(report.expected??[]).filter(e=>text.includes(e.nonce)).map(e=>e.key),...(text.startsWith('UTF-8 ')&&bytes.length<512?{originalText:text}:{}),scope:'actual original signed asset URL; signature kept out of report'});}}catch(e){report.assetReads.push({status:response.status(),error:String(e).split('\n')[0]});}})());
  });return page;
}
try{
  await test('original two page drafts retain exact body, identity and usable TXT after refresh and reopen without sending',async()=>{
    fixture=await startBrowserFixture({runtimeSourceDir:resolve(input.currentBin.path,'../../../..'),dependencySourceDir:input.dependencySource,nodeExecutable:input.childNode,directory,rendererDist:dirname(candidate.rendererReceipt.path),fakeCodexExecutable:cli,providers:[{providerInstanceId:'codex',send:true,continue:true,modelSelection:true,runtimeModes:['approval-required'],attachments:{file:true,image:true,maxBytes:52428800},interrupt:true,approval:true,userInput:true}]});
    const originalSettings=JSON.parse(await readFile(join(directory,'fixture-configuration.json'),'utf8'));assert.equal(originalSettings.schemaDecodedBeforeStart,true);assert.equal(originalSettings.effectiveOriginalSettingsMatched,true);assert.deepEqual(originalSettings.enabledProviders,['codex']);assert.equal(originalSettings.binaryPath,cli);report.originalSettings=originalSettings;
    const project=join(directory,'project');await mkdir(project);execFileSync('/usr/bin/git',['init','-q'],{cwd:project});const projectId=randomUUID();
    const bootstrap=[{type:'project.create',commandId:randomUUID(),projectId,title:'Cross-page draft retention',workspaceRoot:project,createdAt:new Date().toISOString()},{type:'project.meta.update',commandId:randomUUID(),projectId,defaultModelSelection:{instanceId:'codex',model:'fixture-a'}}];
    for(const command of bootstrap){await fixture.client.dispatch(command);report.bootstrapCommands.push(command);}
    const session=await fixture.issueSession();assert.equal(session.session.mode,'native-operate');const split=session.cookie.indexOf('=');
    browser=await chromium.launch({headless:true,executablePath:input.chromiumExecutable});context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await context.addCookies([{name:session.cookie.slice(0,split),value:session.cookie.slice(split+1),url:fixture.origin,httpOnly:true,sameSite:'Strict'}]);
    await context.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());if(url.origin!==fixture.origin)return route.abort();if(url.pathname.endsWith('/api/orchestration/dispatch')){report.blockedCommands.push({transport:'HTTP',reason:'all browser execution dispatch forbidden'});return route.abort();}return route.continue();});
    await context.routeWebSocket('**/*',socket=>{const server=socket.connectToServer();socket.onMessage(message=>{let raw;try{raw=JSON.parse(String(message));}catch{report.blockedCommands.push({transport:'WS',reason:'unparsed frame;fail closed'});return;}for(const item of Array.isArray(raw)?raw:[raw])if(item?.tag==='orchestration.dispatchCommand'){report.browserCommands.push({type:item.payload?.type,commandId:item.payload?.commandId,threadId:item.payload?.threadId});report.blockedCommands.push({transport:'WS',reason:'all browser execution dispatch forbidden'});return;}server.send(message);});});
    const capsResponse=await context.request.get(fixture.origin+'/api/native-mount/capabilities');assert.equal(capsResponse.ok(),true);const caps=await capsResponse.json();assert.equal(caps.environmentId,fixture.environmentId);assert.equal(caps.providers.find(p=>p.providerInstanceId==='codex')?.attachments.file,true);report.capabilities=caps;
    const expected=[];
    for(const key of ['a','b']){const nonce=randomUUID(),name='draft-'+key+'.txt',content='UTF-8 草稿附件 '+key+' '+nonce+'\n',path=join(directory,name);await writeFile(path,content);expected.push({key,nonce,name,path,content,sha256:digest(Buffer.from(content)),body:'Original draft '+key+' '+randomUUID()});}
    async function newDraft(index){const page=await observePage();await page.goto(fixture.origin+'/native/?aaaProject='+projectId+'&aaaEnvironment='+fixture.environmentId);await page.getByRole('button',{name:'New thread',exact:true}).click();await editor(page).waitFor();await page.locator('[data-composer-shortcut="composer.mode"]:visible').first().click();await page.getByRole('option',{name:/^Supervised(?:\s|$)/}).or(page.getByRole('menuitemradio',{name:'Supervised',exact:true})).first().click();await editor(page).fill(expected[index].body);await page.waitForLoadState('networkidle');await eventually(async()=>{const s=await snapshot(page,'initial-'+index);assert.ok(s.session?.threadId);assert.equal(s.session.runtimeMode,'approval-required');});return page;}
    const first=await newDraft(0);const firstIdentity=await snapshot(first,'first-original-identity');let heldUploads=0;const held=new Promise(done=>{releaseUpload=done;});
    await first.route('**/api/attachments/upload/**',async route=>{heldUploads++;await held;await route.continue();});await first.locator('input[type=file]').first().setInputFiles(expected[0].path);await eventually(async()=>assert.ok(heldUploads>0));await snapshot(first,'first-upload-held');
    const second=await newDraft(1);await second.locator('input[type=file]').first().setInputFiles(expected[1].path);await second.waitForLoadState('networkidle');
    await eventually(async()=>{const s=await snapshot(second,'second-prepared');assert.ok(s.editorText?.includes(expected[1].name));assert.equal(/\d+%/.test(s.editorText),false);assert.ok(s.draft?.files?.[0]?.attachmentId);});
    const secondIdentity=await snapshot(second,'second-original-identity');assert.notEqual(firstIdentity.routeDraftId,secondIdentity.routeDraftId);assert.notEqual(firstIdentity.session.threadId,secondIdentity.session.threadId);assert.ok([firstIdentity,secondIdentity].every(s=>s.session.projectId===projectId&&s.session.environmentId===fixture.environmentId));
    releaseUpload();await first.waitForLoadState('networkidle');await first.unroute('**/api/attachments/upload/**');
    await eventually(async()=>{const s=await snapshot(first,'first-upload-complete');assert.ok(s.editorText?.includes(expected[0].name));assert.equal(/\d+%/.test(s.editorText),false);assert.ok(report.uploads.filter(u=>u.method==='POST'&&u.status>=200&&u.status<300).length>=2);});
    const identities=[firstIdentity,secondIdentity],originalPages=[first,second];report.expected=expected;report.originalIdentities=identities;report.heldUploads=heldUploads;
    try{await eventually(async()=>{
      for(const [index,page] of originalPages.entries()){
        const saved=await page.evaluate(id=>{const state=JSON.parse(localStorage.getItem('t3code:composer-drafts:v1')??'{}').state??{};return {session:state.draftThreadsByThreadKey?.[id],draft:state.draftsByThreadKey?.[id]};},identities[index].routeDraftId);
        assert.equal(saved.session?.threadId,identities[index].session.threadId);assert.ok(saved.draft?.prompt?.includes(expected[index].body));assert.equal(saved.draft?.files?.[0]?.environmentId,fixture.environmentId);assert.ok(saved.draft?.files?.[0]?.attachmentId);
      }
    });report.saveCompletionVerified=true;}catch(e){report.saveCompletionVerified=false;fail('save',-1,'original upload/save metadata did not become complete before refresh');}

    async function checkPage(page,index,phase){
      await page.waitForLoadState('networkidle');const s=await snapshot(page,phase+'-'+index);await page.screenshot({path:join(directory,phase+'-'+index+'.png')});
      if(s.routeDraftId!==identities[index].routeDraftId)fail(phase,index,'actual route changed from original draft');
      if(!s.editorText?.includes(expected[index].body))fail(phase,index,'own unsent body not visible in original editor');
      if(s.editorText?.includes(expected[1-index].body)||s.editorText?.includes(expected[1-index].name))fail(phase,index,'other draft body/file appears in original editor');
      if(s.session&&(s.session.threadId!==identities[index].session.threadId||s.session.environmentId!==fixture.environmentId||s.session.projectId!==projectId))fail(phase,index,'observed original binding changed');
      const chip=editor(page).getByLabel(new RegExp('^File attachment, '+expected[index].name.replaceAll('.','\\.')+'(?:,|$)')).first();
      const result={phase,index,routeMatches:s.routeDraftId===identities[index].routeDraftId,ownBodyVisible:s.editorText?.includes(expected[index].body)??false,fileChipVisible:await chip.count()>0,usableFile:false,persistedIdentityPresent:!!s.session};
      if(!result.fileChipVisible){fail(phase,index,'own TXT chip missing in original editor');report.checks.push(result);return;}
      try{await chip.click({timeout:5000});const dialog=page.getByRole('dialog').last();await dialog.waitFor({timeout:5000});const ownText=dialog.getByText(new RegExp(expected[index].nonce)).first();await ownText.waitFor({timeout:5000});result.previewText=await dialog.innerText();result.previewDOMText=await dialog.textContent();result.actualVisibleText=await ownText.textContent();assert.equal(result.actualVisibleText.trim(),expected[index].content.trim());assert.equal(result.actualVisibleText.includes(expected[1-index].nonce),false);result.usableFile=true;await page.screenshot({path:join(directory,phase+'-'+index+'-preview.png')});await dialog.getByRole('button',{name:'Close',exact:true}).click();}catch(e){result.previewError=String(e).split('\n')[0];fail(phase,index,'original TXT preview did not show own file contents');await page.screenshot({path:join(directory,phase+'-'+index+'-preview-failed.png')});await page.keyboard.press('Escape');}
      report.checks.push(result);
    }
    for(const [index,page] of originalPages.entries())await checkPage(page,index,'prepared');
    for(const [index,page] of originalPages.entries()){await page.reload();await checkPage(page,index,'refresh');}
    await first.close();await second.close();
    for(const [index,identity] of identities.entries()){const page=await observePage();await page.goto(identity.url);await checkPage(page,index,'reopen');}
    await Promise.allSettled(pendingReads);report.database={threads:fixture.database.prepare('SELECT COUNT(*) n FROM projection_threads').get().n,turns:fixture.database.prepare('SELECT COUNT(*) n FROM projection_turns').get().n,messages:fixture.database.prepare('SELECT COUNT(*) n FROM projection_thread_messages').get().n};
    assert.deepEqual(report.database,{threads:0,turns:0,messages:0});assert.deepEqual(report.browserCommands,[]);assert.deepEqual(report.blockedCommands,[]);assert.deepEqual(report.pageErrors,[]);
    assert.equal(report.failures.length,0,JSON.stringify(report.failures));
    for(const item of expected.filter((_,index)=>report.checks.some(check=>check.index===index&&['refresh','reopen'].includes(check.phase)&&check.usableFile)))assert.ok(report.assetReads.some(r=>r.transport==='isolated-http-read'&&r.status===200&&r.sha256===item.sha256),'original remote preview raw bytes must match '+item.name);
  });
}finally{
  releaseUpload?.();for(const [index,page] of pages.entries())if(!page.isClosed()){await snapshot(page,'final-'+index).catch(()=>{});await page.screenshot({path:join(directory,'final-'+index+'.png')}).catch(()=>{});}
  await Promise.allSettled(pendingReads);await browser?.close();await fixture?.close();
  const wirePath=join(directory,'fake-provider-wire.jsonl');report.nativeWire=existsSync(wirePath)?(await readFile(wirePath,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse):[];report.nativeThreadOrTurnStarts=report.nativeWire.filter(x=>['thread/start','turn/start','thread/resume','turn/interrupt'].includes(x.method)).length;report.testSha256=digest(await readFile(new URL(import.meta.url)));report.processesClosed=true;
  await writeFile(join(directory,'observations.json'),JSON.stringify(report,null,2)+'\n');assert.equal(report.nativeThreadOrTurnStarts,0,'No native execution operation permitted');
}
