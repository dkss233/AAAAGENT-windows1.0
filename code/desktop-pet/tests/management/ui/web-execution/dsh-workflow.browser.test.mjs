import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {controlledHost} from './controlled-dsh-host.mjs';

for(const key of ['PLAYWRIGHT_MODULE','WEB_EXECUTION_FIXTURE_MODULE','WEB_EXECUTION_RUNTIME','WEB_EXECUTION_RENDERER_DIST','WEB_EXECUTION_NODE','WEB_EXECUTION_DEPENDENCY_SOURCE','DSH_SDK_ROOT'])assert.ok(process.env[key],key+' must identify an existing approved input');
const {startBrowserFixture}=await import(pathToFileURL(process.env.WEB_EXECUTION_FIXTURE_MODULE));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const require=createRequire(join(process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,'package.json'));
const {NodeWS}=await import(pathToFileURL(require.resolve('@effect/platform-node/NodeSocket')));
const wire=await import(pathToFileURL(join(process.env.DSH_SDK_ROOT,'dsh-api-gateway/lib/types/stream-protocol.js')));
const descriptors=new Map();
for(const name of ['dsh-commands','dsh-user-questions','dsh-api-session-controller','dsh-permission-presets']){
  const {TYPERT}=await import(pathToFileURL(join(process.env.DSH_SDK_ROOT,name,'lib/typert.host.js')));
  for(const d of TYPERT.invocations)descriptors.set(d.namespace+'/'+d.method,d);
}
const directory=resolve(process.env.WEB_EXECUTION_EVIDENCE??'artifacts/W1/web-execution-56/dsh-workflow-'+randomUUID());
assert.ok(directory.includes('/artifacts/W1/web-execution-56/'));
await mkdir(directory,{recursive:true,mode:0o700});
const providers=[{providerInstanceId:'dsh',send:true,continue:true,modelSelection:true,runtimeModes:['auto-accept-edits','full-access'],attachments:{file:true,image:true,maxBytes:52428800},interrupt:false,approval:true,userInput:true}];
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function eventually(check){const deadline=Date.now()+10000;let error;while(Date.now()<deadline){try{await check();return;}catch(e){error=e;await new Promise(done=>setTimeout(done,50));}}throw error;}
const observations={level:'isolated original DSH UI + original HTTP/WS/T3 SQLite + controlled native Host/SDK; no model/device/daily home',checks:[],errors:[],commands:[]};
let fixture,browser,page,host;
try{
  await test('DSH original UI keeps native SID, actual parts/permissions, pending approval and continued-question third reply',async()=>{
    const project=join(directory,'synthetic-project');await mkdir(project);execFileSync('/usr/bin/git',['init','-q'],{cwd:project});
    host=await controlledHost(NodeWS,project,descriptors,wire);
    const log=join(directory,'controlled-host.log');await writeFile(log,'dsh web: '+host.origin+'/?token=controlled-host\n',{mode:0o600});
    const deny=join(directory,'deny-codex');await writeFile(deny,'#!/bin/sh\nexit 82\n',{mode:0o700});
    fixture=await startBrowserFixture({runtimeSourceDir:process.env.WEB_EXECUTION_RUNTIME,dependencySourceDir:process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,nodeExecutable:process.env.WEB_EXECUTION_NODE,directory,rendererDist:resolve(process.env.WEB_EXECUTION_RENDERER_DIST),fakeCodexExecutable:deny,providers,controlledDshHost:{webLogPath:log,agentPreset:'controlled-preset'}});
    const projectId=randomUUID();await fixture.client.dispatch({type:'project.create',commandId:randomUUID(),projectId,title:'受控DSH网页项目',workspaceRoot:project,createdAt:new Date().toISOString()});
    await fixture.client.dispatch({type:'project.meta.update',commandId:randomUUID(),projectId,defaultModelSelection:{instanceId:'dsh',model:'controlled/first'}});
    const issued=await fixture.issueSession();assert.equal(issued.session.mode,'native-operate');const split=issued.cookie.indexOf('=');
    browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await context.addCookies([{name:issued.cookie.slice(0,split),value:issued.cookie.slice(split+1),url:fixture.origin,httpOnly:true,sameSite:'Strict'}]);
    await context.route('**/*',route=>new URL(route.request().url()).origin===fixture.origin?route.continue():route.abort());
    page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>observations.errors.push(String(error)));
    page.on('websocket',socket=>socket.on('framesent',frame=>{try{const raw=JSON.parse(String(frame.payload));for(const x of Array.isArray(raw)?raw:[raw])if(x.tag==='orchestration.dispatchCommand')observations.commands.push({type:x.payload.type,commandId:x.payload.commandId,threadId:x.payload.threadId,requestId:x.payload.requestId,modelSelection:x.payload.modelSelection,runtimeMode:x.payload.runtimeMode});}catch{}}));
    observations.inputs={runtime:resolve(process.env.WEB_EXECUTION_RUNTIME),rendererDist:resolve(process.env.WEB_EXECUTION_RENDERER_DIST),serverBinSha256:digest(await readFile(join(process.env.WEB_EXECUTION_RUNTIME,'apps/server/dist/bin.mjs'))),fixtureModuleSha256:digest(await readFile(process.env.WEB_EXECUTION_FIXTURE_MODULE)),renderer:digest(await readFile(join(process.env.WEB_EXECUTION_RENDERER_DIST,'aaa-native-read-build.json')))};
    await page.goto(fixture.origin+'/native/');await page.getByRole('button',{name:'New thread',exact:true}).click();
    const editor=page.locator('[data-testid="composer-editor"] [contenteditable="true"], [data-testid="composer-editor"][contenteditable="true"]').first();await editor.waitFor();
    const mode=()=>page.locator('[data-composer-shortcut="composer.mode"]:visible').first();await mode().click();
    const supervised=page.getByRole('option',{name:/^Supervised(?:\s|$)/}).or(page.getByRole('menuitemradio',{name:'Supervised',exact:true}));
    assert.equal(await supervised.isDisabled(),true);await supervised.dispatchEvent('click');
    await page.getByRole('option',{name:/^Auto-accept edits(?:\s|$)/}).or(page.getByRole('menuitemradio',{name:'Auto-accept edits',exact:true})).click();
    const first='dsh-ui-first-'+randomUUID(),file=Buffer.from('DSH受控附件 '+randomUUID());
    const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
    await editor.fill(first);await page.locator('input[type=file]').first().setInputFiles([{name:'controlled.txt',mimeType:'text/plain',buffer:file},{name:'controlled.png',mimeType:'image/png',buffer:image}]);
    const send=page.locator('button[type=submit][data-aaa-native-command="thread.turn.start"]:visible').first();await page.waitForLoadState('networkidle');await send.click();
    const approve=page.getByRole('button',{name:/^(Approve|允许一次)$/});await approve.waitFor();
    const row=fixture.database.prepare('SELECT thread_id FROM projection_threads WHERE project_id=?').get(projectId);assert.ok(row);
    const cursor=fixture.database.prepare('SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id=?').get(row.thread_id);const sid=JSON.parse(cursor.resume_cursor_json).sessionId;
    observations.environmentId=fixture.environmentId;observations.projectId=projectId;observations.threadId=row.thread_id;observations.nativeSessionId=sid;
    assert.equal(sid,'t3_'+digest(JSON.stringify([fixture.environmentId,row.thread_id])).slice(0,40));assert.equal(host.state.sessions.size,1);
    const prompt=host.state.calls.find(c=>c.method==='session/prompt').args.request;assert.equal(prompt.sessionId,sid);assert.ok(prompt.content[0].text.includes(first));
    assert.deepEqual(host.state.uploads,[{sessionId:sid,name:'controlled.txt',hash:digest(file)}]);
    assert.deepEqual(prompt.content.find(p=>p.type==='file'),{type:'file',receiptId:'controlled-file'});
    const nativeImage=prompt.content.find(p=>p.type==='image');assert.equal(nativeImage.mediaType,'image/png');assert.equal(digest(Buffer.from(nativeImage.data,'base64')),digest(image));
    assert.equal(host.state.sessions.get(sid).mode,'workspace-write');
    assert.equal(host.state.calls.some(c=>c.method==='commands/execute'),false,'strict click cannot silently grant full access');
    for(const b of await page.locator('button[data-aaa-native-command="thread.turn.interrupt"]:visible').all())assert.equal(await b.isDisabled(),true);
    observations.checks.push('DSH E01/E05 original Composer -> exact native SID; original file upload receipt/hash and image bytes/type; workspace-write/ask; unsupported strict/Stop closed');
    await approve.click();await page.getByText('已提交，等待原服务确认',{exact:true}).waitFor();
    await eventually(async()=>assert.equal(host.state.calls.filter(c=>c.method==='$events/result').length,1));
    const activity=fixture.database.prepare("SELECT payload_json FROM projection_thread_activities WHERE thread_id=? AND kind='approval.requested'").get(row.thread_id);const requestId=JSON.parse(activity.payload_json).requestId;
    assert.equal(requestId,'dsh:'+sid+':'+host.state.sessions.get(sid).auditId);assert.ok(JSON.parse(activity.payload_json).responseSubmitted);
    assert.equal(host.state.sessions.get(sid).events.some(e=>e.type==='approval/decided'),false);
    for(const b of await page.locator('button[data-aaa-native-command="thread.approval.respond"]:visible').all())assert.equal(await b.isDisabled(),true);
    await page.screenshot({path:join(directory,'approval-submitted.png')});host.confirmApproval();
    await page.getByText('controlled reply 1',{exact:true}).first().waitFor();await eventually(async()=>assert.equal(await approve.count(),0));
    observations.checks.push('DSH E04 exact native audit/waterfall responseSubmitted keeps card/buttons closed; actual approval audit/finish resolves card');
    await page.locator('[data-chat-provider-model-picker="true"]:visible').first().click();await page.getByRole('option',{name:/second/}).click();
    await mode().click();await page.getByRole('option',{name:/^Full access(?:\s|$)/}).or(page.getByRole('menuitemradio',{name:'Full access',exact:true})).click();
    const second='dsh-ui-second-'+randomUUID();await editor.fill(second);await page.waitForLoadState('networkidle');await send.click();
    await page.getByText('controlled reply 2',{exact:true}).first().waitFor();
    const question=page.locator('[data-chat-composer-top-drawer="true"]:visible').getByText('Continue?',{exact:true}).first();await question.waitFor();
    assert.equal(host.state.sessions.get(sid).turn,2);assert.equal(host.state.sessions.get(sid).running,false);
    await eventually(async()=>{
      const native=fixture.database.prepare("SELECT payload_json FROM projection_thread_activities WHERE thread_id=? AND kind='native.session.sync'").get(row.thread_id);
      assert.equal(JSON.parse(native?.payload_json??'null')?.observation,'waiting_answer');
    });
    await page.locator('[data-native-session-status="waiting_answer"][data-thread-id="'+row.thread_id+'"][data-native-id="'+sid+'"]:visible').first().waitFor();
    observations.waitingNativeDOM={status:'waiting_answer',threadId:row.thread_id,nativeSessionId:sid};
    for(const b of await send.all())assert.equal(await b.isDisabled(),true,'a native continued question cannot grant a new prompt');
    await page.screenshot({path:join(directory,'continued-question.png')});
    const dismiss=page.locator('[data-aaa-native-command="thread.user-input.dismiss"]:visible');observations.unsupportedDismissControls=await dismiss.count();
    for(const b of await dismiss.all()){assert.equal(await b.isDisabled(),true);await b.dispatchEvent('click');}
    assert.equal(observations.commands.some(c=>c.type==='thread.user-input.dismiss'),false,'unsupported DSH dismiss never dispatches');
    await page.getByRole('button',{name:/^yes(?:\s|$)/}).click();
    await page.getByText('actual question follow-up reply',{exact:true}).first().waitFor();await eventually(async()=>assert.equal(await question.count(),0));
    await page.getByText('User input submitted',{exact:true}).first().waitFor();
    assert.equal(await page.getByText('User input dismissed',{exact:true}).count(),0,'a confirmed native answer cannot be displayed as dismissed');
    const prompts=host.state.calls.filter(c=>c.method==='session/prompt');assert.equal(prompts.length,2);assert.ok(prompts.every(p=>p.args.request.sessionId===sid));assert.ok(prompts[1].args.request.content[0].text.includes(second));
    assert.deepEqual(host.state.calls.filter(c=>c.method==='session/selectModel').map(c=>c.args.request.model),['first','second']);
    assert.equal(host.state.sessions.get(sid).mode,'danger-full-access');
    assert.equal(host.state.calls.filter(c=>c.method==='userQuestions/answer').length,1);assert.equal(host.state.sessions.size,1);
    await eventually(async()=>{
      const native=fixture.database.prepare("SELECT payload_json FROM projection_thread_activities WHERE thread_id=? AND kind='native.session.sync'").get(row.thread_id);
      const payload=JSON.parse(native?.payload_json??'null');assert.equal(payload?.checkpoint?.native?.afterSeq,host.state.sessions.get(sid).events.at(-1).seq);
      assert.equal(payload.observation,'ready');observations.finalNativeSync=payload;
    });
    const assertFinalTurns=()=>{
      const turns=fixture.database.prepare('SELECT turn_id,state FROM projection_turns WHERE thread_id=? ORDER BY row_id').all(row.thread_id);
      assert.equal(turns.length,3);assert.ok(turns.every(t=>t.state==='completed'));
      assert.equal(turns[2].turn_id,'dsh:'+sid+':question:controlled-question:3');
      assert.equal(fixture.database.prepare("SELECT count(*) AS n FROM projection_thread_messages WHERE thread_id=? AND role='assistant'").get(row.thread_id).n,3);
      observations.finalTurns=turns;
    };
    await eventually(async()=>assertFinalTurns());
    observations.checks.push('DSH E02/E03/E04 same SID two prompts/model first->second/full permission; original completed continued question yields actual third reply and terminal');
    const draft='dsh-ui-draft-'+randomUUID();await editor.fill(draft);await page.reload();await editor.waitFor();await eventually(async()=>assert.ok((await editor.innerText()).includes(draft)));
    await page.getByText('actual question follow-up reply',{exact:true}).first().waitFor();assert.equal(host.state.calls.filter(c=>c.method==='session/prompt').length,2);
    await eventually(async()=>assertFinalTurns());
    for(const text of [first,second]){
      assert.equal(fixture.database.prepare("SELECT count(*) AS n FROM projection_thread_messages WHERE thread_id=? AND role='user' AND instr(text,?)>0").get(row.thread_id,text).n,1,'original and native source inputs share the original message identity');
      if(text===second)assert.equal(await page.getByText(text,{exact:true}).count(),1,'native history does not render a duplicate source message');
    }
    assert.equal(host.state.calls.some(c=>c.method==='session/cancel'),false);assert.equal(observations.commands.some(c=>['thread.turn.interrupt','thread.session.stop'].includes(c.type)),false);
    assert.deepEqual(observations.errors,[]);assert.deepEqual(host.state.errors,[]);
    observations.checks.push('DSH E02/E06 refresh retains actual three native replies/exact thread/draft without new prompt or cancel; unsupported Stop never dispatched');
  });
}finally{
  if(page){observations.lastUrl=page.url();observations.lastVisibleText=await page.locator('body').innerText().catch(()=>'');await page.screenshot({path:join(directory,'last-state.png')}).catch(()=>{});}
  if(host){observations.hostCalls=host.state.calls;observations.hostErrors=host.state.errors;observations.sessions=[...host.state.sessions.values()];}
  await writeFile(join(directory,'observations.json'),JSON.stringify(observations,null,2)+'\n');
  await browser?.close();await fixture?.close();await host?.close();
}
