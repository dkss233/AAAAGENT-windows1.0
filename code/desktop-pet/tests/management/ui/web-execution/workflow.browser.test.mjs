import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,unlink} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';

for(const key of ['PLAYWRIGHT_MODULE','WEB_EXECUTION_FIXTURE_MODULE','WEB_EXECUTION_RUNTIME','WEB_EXECUTION_NODE','WEB_EXECUTION_DEPENDENCY_SOURCE'])assert.ok(process.env[key],key+' must point at an existing approved input');
const {startBrowserFixture}=await import(pathToFileURL(process.env.WEB_EXECUTION_FIXTURE_MODULE));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const directory=resolve(process.env.WEB_EXECUTION_EVIDENCE??'artifacts/W1/web-execution-56/workflow-'+randomUUID());
assert.ok(directory.includes('/artifacts/W1/web-execution-56/'));
await mkdir(directory,{recursive:true,mode:0o700});
const cli=join(directory,'fake-codex'),peer=fileURLToPath(new URL('./fake-codex-cli.mjs',import.meta.url));
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
await writeFile(cli,`#!/bin/sh\nexec ${quote(process.env.WEB_EXECUTION_NODE)} ${quote(peer)} "$@"\n`,{mode:0o700});
process.env.AAA_WEB_TEST_DIRECTORY=directory;
process.env.AAA_WEB_TEST_WIRE=join(process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,'apps/server/src/provider/testFixtures/codexMultiAgentWire.json');
const require=createRequire(process.env.WEB_EXECUTION_FIXTURE_MODULE);
const {build}=await import(pathToFileURL(require.resolve('esbuild')));
process.env.AAA_WEB_TEST_SCHEMA=join(directory,'native-peer-schema.mjs');
await build({stdin:{contents:'import * as Schema from "effect/Schema";import * as C from ' + JSON.stringify(join(process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,'packages/effect-codex-app-server/src/_generated/schema.gen.ts')) + ';export const approval=Schema.decodeUnknownSync(C.ServerRequest__CommandExecutionRequestApprovalParams);export const question=Schema.decodeUnknownSync(C.ServerRequest__ToolRequestUserInputParams);export const resolved=Schema.decodeUnknownSync(C.ServerNotification__ServerRequestResolvedNotification);export const threadRead=Schema.decodeUnknownSync(C.V2ThreadReadResponse);',resolveDir:process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,loader:'ts'},outfile:process.env.AAA_WEB_TEST_SCHEMA,bundle:true,platform:'node',format:'esm',banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});

const providers=[{providerInstanceId:'codex',send:true,continue:true,modelSelection:true,runtimeModes:['approval-required'],attachments:{file:true,image:true,maxBytes:50*1024*1024},interrupt:true,approval:true,userInput:true}];
async function assertEventually(check){
  const deadline=Date.now()+10000;let last;
  while(Date.now()<deadline){try{await check();return;}catch(error){last=error;await new Promise(done=>setTimeout(done,50));}}
  throw last;
}
const observations={level:'isolated original UI + HTTP/WS + original T3 SQLite/events + fake CLI; no paid model, production UI or device',directory,checks:[],errors:[],requests:[],commands:[]};
let fixture,browser,page;
let dropNextDispatch=false,dropCommandType='thread.turn.start',droppedRequestId=null,droppedCommandId=null,unknownColdReads=0;
const projectId=randomUUID(),promptNonce='web-prompt-'+randomUUID(),fileNonce='web-file-'+randomUUID();
try{
  fixture=await startBrowserFixture({runtimeSourceDir:process.env.WEB_EXECUTION_RUNTIME,dependencySourceDir:process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,nodeExecutable:process.env.WEB_EXECUTION_NODE,directory,rendererDist:resolve('artifacts/W1/web-execution-56/build-client/apps/web/dist'),fakeCodexExecutable:cli,providers});
  const project=join(directory,'synthetic-project');await mkdir(project);execFileSync('/usr/bin/git',['init','-q'],{cwd:project});
  await fixture.client.dispatch({type:'project.create',commandId:randomUUID(),projectId,title:'受控网页项目',workspaceRoot:project,createdAt:new Date().toISOString()});
  await fixture.client.dispatch({type:'project.meta.update',commandId:randomUUID(),projectId,defaultModelSelection:{instanceId:'codex',model:'fixture-a'}});
  const issued=await fixture.issueSession();assert.equal(issued.session.mode,'native-operate');
  const split=issued.cookie.indexOf('=');
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
  await context.addCookies([{name:issued.cookie.slice(0,split),value:issued.cookie.slice(split+1),url:fixture.origin,httpOnly:true,sameSite:'Strict'}]);
  page=await context.newPage();page.setDefaultTimeout(12000);

  await page.routeWebSocket(/\/ws(?:\?|$)/,socket=>{
    const server=socket.connectToServer();
    socket.onMessage(message=>{
      try{const value=JSON.parse(String(message));for(const entry of Array.isArray(value)?value:[value]){
        if(dropNextDispatch&&entry.tag==='orchestration.dispatchCommand'&&entry.payload?.type===dropCommandType){
          droppedRequestId=String(entry.id);droppedCommandId=entry.payload.commandId;
          observations.injectedLoss={requestId:droppedRequestId,commandId:droppedCommandId,scope:'controlled transport ack loss after real engine admitted exact command'};
          (observations.injectedLosses??=[]).push({...observations.injectedLoss,commandType:dropCommandType});
        }
      }}catch{}
      server.send(message);
    });
    server.onMessage(message=>{
      try{const data=JSON.parse(String(message));for(const entry of Array.isArray(data)?data:[data])if(entry._tag==='Exit'&&entry.exit?._tag==='Failure')(observations.rpcFailures??=[]).push({requestId:entry.requestId,exit:entry.exit});}catch{}
      let drop=false;
      try{const value=JSON.parse(String(message));drop=(Array.isArray(value)?value:[value]).some(entry=>entry._tag==='Exit'&&String(entry.requestId)===droppedRequestId&&dropNextDispatch);}catch{}
      if(drop){dropNextDispatch=false;socket.close({code:1011,reason:'Controlled lost command response'});return;}
      socket.send(message);
    });
  });
  const receiptRoute='**/api/orchestration/commands/*/receipt';
  const withholdFirstReceipt=async route=>{
    if(droppedCommandId&&new URL(route.request().url()).pathname.includes(droppedCommandId)&&unknownColdReads===0){
      unknownColdReads++;await route.fulfill({status:200,contentType:'application/json',body:'null'});return;
    }
    await route.continue();
  };
  await page.route(receiptRoute,withholdFirstReceipt);
  await context.route('**/*',route=>new URL(route.request().url()).origin===fixture.origin?route.continue():route.abort());
  page.on('console',message=>{if(['error','warning'].includes(message.type()))(observations.console??=[]).push(message.text().slice(0,2500));});
  page.on('pageerror',error=>observations.errors.push(String(error)));
  page.on('request',request=>observations.requests.push({method:request.method(),path:new URL(request.url()).pathname.replace(/^\/api\/attachments\/upload\/[^/]+$/, '/api/attachments/upload/:signed-token')}));
  page.on('websocket',socket=>socket.on('framesent',frame=>{
    try{const payload=JSON.parse(String(frame.payload));for(const message of Array.isArray(payload)?payload:[payload])if(message.tag==='orchestration.dispatchCommand'){
      const command=message.payload;observations.commands.push({type:command.type,commandId:command.commandId,threadId:command.threadId,modelSelection:command.modelSelection,runtimeMode:command.runtimeMode});
    }}catch{}
  }));
  await page.goto(fixture.origin+'/native/');
  await test('original UI controlled create/continue/model/strict/files/requests/stop/unknown/read-only workflow',async()=>{
    const create=page.getByRole('button',{name:'New thread',exact:true});await create.waitFor();await create.click();
    const editor=page.locator('[data-testid="composer-editor"] [contenteditable="true"], [data-testid="composer-editor"][contenteditable="true"]').first();
    await editor.waitFor();
    await page.locator('[data-composer-shortcut="composer.mode"]:visible').first().click();
    await page.getByRole('option',{name:/Supervised/}).or(page.getByRole('menuitemradio',{name:'Supervised',exact:true})).first().click();
    await editor.fill(promptNonce);
    await page.locator('input[type=file]').first().setInputFiles({name:'controlled-marker.txt',mimeType:'text/plain',buffer:Buffer.from(fileNonce)});
    const send=page.locator('button[type=submit][data-aaa-native-command="thread.turn.start"]:visible').first();
    await page.waitForLoadState("networkidle");await send.click();
    await page.getByText(/受控原生回执/).first().waitFor();
    const wire=(await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const turn=wire.find(message=>message.method==='turn/start');assert.ok(turn);
    assert.ok(JSON.stringify(turn.params.input).includes(promptNonce));assert.ok(wire.some(message=>message.fixture==='file.read'&&message.content===fileNonce),'provider peer must read exact file bytes from the path actually carried in native input');
    const nativeStart=wire.find(message=>message.method==='thread/start');assert.equal(nativeStart.params.approvalPolicy,'untrusted');assert.equal(nativeStart.params.sandbox,'read-only');
    const row=fixture.database.prepare('SELECT thread_id,project_id FROM projection_threads WHERE project_id=?').get(projectId);assert.ok(row);
    const binding=fixture.database.prepare('SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id=?').get(row.thread_id);
    const nativeSessionId=JSON.parse(binding.resume_cursor_json).threadId;assert.ok(nativeSessionId);
    observations.environmentId=fixture.environmentId;observations.projectId=projectId;observations.threadId=row.thread_id;observations.nativeSessionId=nativeSessionId;
    observations.checks.push('E01 original UI command -> durable T3 thread -> native fake wire; strict and file nonce received');
    await page.screenshot({path:join(directory,'first-turn.png')});

    // Change the real catalog selection, then continue the exact original thread.
    const beforeThreadUrl=page.url();
    await page.locator('[data-chat-provider-model-picker="true"]:visible').first().click();
    await page.getByRole('option',{name:/fixture-B/i}).click();
    await page.getByRole('button',{name:'Medium',exact:true}).click();
    await page.getByRole('menuitemradio',{name:/^High(?:\s|$)/}).click();
    const secondNonce='web-continue-'+randomUUID();
    await editor.fill(secondNonce);
    await page.waitForLoadState("networkidle");await send.click();
    await page.getByText(new RegExp('受控原生回执 fixture-b[\\s\\S]*'+secondNonce)).first().waitFor();
    const afterWire=(await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const turns=afterWire.filter(message=>message.method==='turn/start');
    assert.equal(turns.length,2);assert.equal(turns[1].params.threadId,nativeSessionId);assert.equal(turns[1].params.model,'fixture-b');assert.equal(turns[1].params.collaborationMode.settings.reasoning_effort,'high');
    assert.equal(afterWire.filter(message=>message.method==='thread/start').length,1,'continuation must not create a native session');
    assert.equal(fixture.database.prepare('SELECT count(*) as n FROM projection_threads WHERE project_id=?').get(projectId).n,1);
    assert.equal(page.url(),beforeThreadUrl);
    observations.checks.push('E02/E03 exact same native SID and one T3 thread; actual catalog model fixture-b reaches the next native turn');
    const draftNonce='web-draft-'+randomUUID();await editor.fill(draftNonce);await page.reload();
    await editor.waitFor();await assertEventually(async()=>assert.ok((await editor.innerText()).includes(draftNonce)));
    await page.getByText(new RegExp('受控原生回执 fixture-b[\\s\\S]*'+secondNonce)).first().waitFor();
    assert.equal((await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).split('\n').filter(line=>line&&JSON.parse(line).method==='turn/start').length,2,'reload must never replay');
    observations.checks.push('E02 refresh preserves original history, exact thread and draft without replay');

    const cancelledNonce='cancelled-file-'+randomUUID();
    const cancelledUpload=page.waitForResponse(response=>new URL(response.url()).pathname.startsWith('/api/attachments/upload/'));
    await page.locator('input[type=file]').first().setInputFiles({name:'cancelled-marker.txt',mimeType:'text/plain',buffer:Buffer.from(cancelledNonce)});
    assert.equal((await cancelledUpload).ok(),true);
    await assertEventually(async()=>assert.ok((await editor.innerText()).includes('cancelled-marker.txt')));
    await editor.fill(draftNonce);
    await assertEventually(async()=>assert.equal((await editor.innerText()).includes('cancelled-marker.txt'),false));
    observations.checks.push('E05 original attachment selection/removal retains draft; cancelled file is not part of next native input');
    await editor.fill('[fixture:approval] '+randomUUID());await page.waitForLoadState("networkidle");await send.click();
    const approve=page.getByRole('button',{name:'Approve',exact:true});await approve.waitFor();await approve.click();
    await page.getByText(/受控请求已回应/).first().waitFor();
    await assertEventually(async()=>assert.equal(await approve.count(),0));
    let currentWire=(await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(JSON.stringify(currentWire.filter(message=>message.method==='turn/start').at(-1).params.input).includes('cancelled-marker.txt'),false);
    assert.ok(currentWire.some(message=>message.result?.decision==='accept'),'exact native approval response must reach original peer');
    observations.checks.push('E04 original approval card -> exact native request response; actual resolved closes card');

    await editor.fill('[fixture:question] '+randomUUID());await page.waitForLoadState("networkidle");await send.click();
    const questionPrompt=page.locator('[data-chat-composer-top-drawer="true"]:visible').getByText('选择受控答案',{exact:true}).first();
    await questionPrompt.waitFor();
    await page.getByRole('button',{name:/选项甲/}).click();
    await assertEventually(async()=>assert.equal(await questionPrompt.count(),0));
    currentWire=(await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(currentWire.some(message=>message.result?.answers?.['fixture-choice']?.answers?.includes('选项甲')),'exact native question and answer must reach original peer');
    observations.checks.push('E04 original question card -> exact native question answer; resolved closes card');

    await editor.fill('[fixture:wait] '+randomUUID());await page.waitForLoadState("networkidle");await send.click();
    const stop=page.getByRole('button',{name:'Stop generation',exact:true});await stop.waitFor();
    dropCommandType='thread.turn.interrupt';dropNextDispatch=true;await stop.click();
    await page.getByText('受控任务已中止',{exact:true}).waitFor();
    currentWire=(await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    const interrupted=currentWire.find(message=>message.method==='turn/interrupt');assert.ok(interrupted);assert.equal(interrupted.params.threadId,nativeSessionId);assert.equal(interrupted.params.turnId,currentWire.filter(message=>message.fixture==='turn.started').at(-1).turnId);
    const lastStarted=currentWire.filter(message=>message.method==='turn/start').at(-1);
    assert.ok(lastStarted.params.input[0].text.includes('[fixture:wait]'));
    observations.checks.push('E06 original Stop -> exact current native thread/turn -> actual interrupted state');

    await page.getByText('原命令结果尚未核定。草稿保留，暂停发送。',{exact:true}).waitFor();
    await assertEventually(async()=>assert.equal(unknownColdReads,1));
    assert.equal(await send.isDisabled(),true);
    observations.unknownStopCommandId=droppedCommandId;
    await page.getByRole('button',{name:'查询原命令结果',exact:true}).click();
    await assertEventually(async()=>assert.equal(await page.getByRole('button',{name:'查询原命令结果',exact:true}).count(),0));
    assert.equal((await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).split('\n').filter(line=>line&&JSON.parse(line).method==='turn/interrupt').length,1,'unknown Stop receipt must not replay the interrupt');
    observations.checks.push('E06 lost original Stop ack/null receipt -> exact identity frozen -> original accepted GET; one exact interrupt, no replay');

    const beforeUnknownTurns=currentWire.filter(message=>message.method==='turn/start').length;
    const unknownNonce='unknown-delivery-'+randomUUID();
    unknownColdReads=0;droppedCommandId=null;droppedRequestId=null;dropCommandType='thread.turn.start';
    dropNextDispatch=true;await editor.fill(unknownNonce);await page.waitForLoadState("networkidle");await send.click();
    await page.getByText('原命令结果尚未核定。草稿保留，暂停发送。',{exact:true}).waitFor();
    await assertEventually(async()=>assert.equal(unknownColdReads,1));
    assert.ok(droppedCommandId);
    assert.equal(await send.isDisabled(),true);
    await assertEventually(async()=>assert.ok((await editor.innerText()).includes(unknownNonce)));
    const unresolved=await page.evaluate(([environmentId,threadId])=>JSON.parse(localStorage.getItem(`aaa-native-submission:${JSON.stringify([environmentId,threadId])}`)),[fixture.environmentId,row.thread_id]);
    assert.deepEqual(unresolved,{environmentId:fixture.environmentId,threadId:row.thread_id,commandId:droppedCommandId});
    await page.unroute(receiptRoute,withholdFirstReceipt);
    await page.getByRole('button',{name:'查询原命令结果',exact:true}).click();
    await assertEventually(async()=>assert.equal(await page.getByRole('button',{name:'查询原命令结果',exact:true}).count(),0));
    currentWire=(await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(currentWire.filter(message=>message.method==='turn/start').length,beforeUnknownTurns+1,'unknown and cold-read recovery must not replay');
    observations.checks.push('E06 actual admitted command, controlled lost RPC/null receipt -> persisted exact ID/draft freeze -> original accepted receipt GET only; no replay');

    // The original server must produce unknown from a failed native history read.
    // No capability, ready flag or UI state is seeded for this check.
    await page.locator('[data-native-session-status="ready"]').waitFor();
    const observationDraft='native-unverified-draft-'+randomUUID();await editor.fill(observationDraft);
    const fault=join(directory,'native-read-unavailable');await writeFile(fault,'test peer read fault only\n');
    await page.locator('[data-native-session-status="unknown"]').waitFor();
    await page.getByText('原生会话状态尚未核定；草稿保留，等待核验',{exact:true}).waitFor();
    assert.equal(await send.isDisabled(),true);assert.ok((await editor.innerText()).includes(observationDraft));
    await page.evaluate(()=>document.querySelector('[data-chat-composer-form]').requestSubmit());
    assert.equal((await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).split('\n').filter(line=>line&&JSON.parse(line).method==='turn/start').length,beforeUnknownTurns+1);
    await unlink(fault);await page.locator('[data-native-session-status="ready"]').waitFor();
    await assertEventually(async()=>assert.equal(await send.isDisabled(),false));
    observations.checks.push('E06 controlled native read failure -> original server unknown observation -> Composer and submit guard closed/draft kept; actual history recovery reopens without sending');

    const targetRoute='**/api/native-mount/targets/*/capabilities';
    await page.route(targetRoute,async route=>{
      const response=await route.fetch();const value=await response.json();
      await route.fulfill({response,json:{...value,source:'codex-app',readonly:true,reason:'external_owner_unavailable',commandTypes:[]}});
    });
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.getByText('原 App 会话当前仅支持浏览；草稿保留，未发送',{exact:true}).waitFor();
    const readDraft='readonly-draft-'+randomUUID();await editor.fill(readDraft);
    assert.equal(await send.isDisabled(),true);assert.equal(await page.locator('[data-chat-provider-model-picker="true"]:visible').first().isDisabled(),true);
    await page.evaluate(()=>document.querySelector('[data-chat-composer-form]')?.requestSubmit());
    await assertEventually(async()=>assert.ok((await editor.innerText()).includes(readDraft)));
    assert.equal((await readFile(join(directory,'fake-provider-wire.jsonl'),'utf8')).split('\n').filter(line=>line&&JSON.parse(line).method==='turn/start').length,beforeUnknownTurns+1);
    observations.checks.push('E07 controlled original-App readonly target revokes current controls and preserves draft; submit path cannot bypass capability');
    await page.route(targetRoute,route=>route.fulfill({status:401,contentType:'application/json',body:'{}'}));
    await page.route('**/api/native-mount/capabilities',route=>route.fulfill({status:401,contentType:'application/json',body:'{}'}));
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await page.getByText('当前对话编辑能力不可用；草稿保留，未发送',{exact:true}).waitFor();
    assert.equal(await send.isDisabled(),true);assert.ok((await editor.innerText()).includes(readDraft));
    observations.checks.push('E06 controlled auth expiry removes permission without losing the same thread draft');
  });
}finally{
  if(page){observations.lastUrl=page.url();observations.controls=await page.locator('button,[role=button]').evaluateAll(items=>items.map(item=>({name:item.getAttribute('aria-label')??item.textContent?.slice(0,90),visible:item.getBoundingClientRect().height>0,disabled:item.disabled===true,nativeCommand:item.dataset.aaaNativeCommand,nativeAllowed:item.dataset.aaaNativeAllowed})));observations.lastVisibleText=(await page.locator('body').innerText().catch(()=>''));await page.screenshot({path:join(directory,'last-state.png')}).catch(()=>{});}
  await writeFile(join(directory,'observations.json'),JSON.stringify(observations,null,2)+'\n');
  await browser?.close();await fixture?.close();
}
