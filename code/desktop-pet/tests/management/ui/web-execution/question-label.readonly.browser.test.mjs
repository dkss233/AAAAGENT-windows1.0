import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

for(const key of ['PLAYWRIGHT_MODULE','WEB_EXECUTION_FIXTURE_MODULE','WEB_EXECUTION_RUNTIME','WEB_EXECUTION_RENDERER_DIST','WEB_EXECUTION_NODE','WEB_EXECUTION_DEPENDENCY_SOURCE','READONLY_SOURCE_HOME','READONLY_SOURCE_OBSERVATIONS','WEB_EXECUTION_EVIDENCE'])assert.ok(process.env[key],key+' must identify an existing approved input');
const {startBrowserFixture}=await import(pathToFileURL(process.env.WEB_EXECUTION_FIXTURE_MODULE));
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const sourceHome=resolve(process.env.READONLY_SOURCE_HOME),directory=resolve(process.env.WEB_EXECUTION_EVIDENCE);
assert.ok(directory.includes('/artifacts/W1/web-execution-56/'));
assert.notEqual(directory,sourceHome);
const source=JSON.parse(await readFile(process.env.READONLY_SOURCE_OBSERVATIONS,'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function sourceHashes(){
  const result={};
  for(const name of ['environment-id','state.sqlite','state.sqlite-wal']){
    const file=join(sourceHome,'userdata',name);
    if(existsSync(file))result[name]=digest(await readFile(file));
  }
  return result;
}
const before=await sourceHashes();
assert.ok(before['state.sqlite']);
await mkdir(directory,{recursive:true,mode:0o700});
const marker=join(directory,'unexpected-cli-invocation');
const deny=join(directory,'deny-codex');
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
await writeFile(deny,'#!/bin/sh\nprintf invoked >> '+quote(marker)+'\nexit 82\n',{mode:0o700});
const observations={level:'read-only original answered conversation in isolated SQLite backup; no prompts, answers, seeded state or enabled providers',sourceHome,sourceBefore:before,errors:[],dispatches:[],httpWrites:[],checks:[]};
let fixture,browser,page;
try{
  await test('original answered activity renders submitted without replaying its conversation',async()=>{
    fixture=await startBrowserFixture({runtimeSourceDir:process.env.WEB_EXECUTION_RUNTIME,dependencySourceDir:process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,nodeExecutable:process.env.WEB_EXECUTION_NODE,directory,rendererDist:resolve(process.env.WEB_EXECUTION_RENDERER_DIST),fakeCodexExecutable:deny,providers:[],readOnlySnapshot:{sourceHome,sqliteSha256:before['state.sqlite']}});
    assert.equal(fixture.environmentId,source.environmentId);
    const resolved=fixture.database.prepare("SELECT * FROM projection_thread_activities WHERE thread_id=? AND kind='user-input.resolved'").all(source.threadId);
    assert.equal(resolved.length,1);assert.equal(resolved[0].summary,'User input submitted');
    assert.deepEqual(JSON.parse(resolved[0].payload_json),{requestId:'dsh:'+source.nativeSessionId+':question:controlled-question',answers:{}});
    const messages=fixture.database.prepare('SELECT message_id,turn_id,role,text FROM projection_thread_messages WHERE thread_id=? ORDER BY created_at,message_id').all(source.threadId);
    assert.equal(messages.filter(row=>row.role==='assistant').length,3);
    const turns=fixture.database.prepare('SELECT turn_id,state FROM projection_turns WHERE thread_id=? ORDER BY row_id').all(source.threadId);
    assert.deepEqual(turns,source.finalTurns);
    observations.originalActivity=resolved[0];observations.originalMessages=messages;observations.originalTurns=turns;
    observations.identity={environmentId:fixture.environmentId,threadId:source.threadId,nativeSessionId:source.nativeSessionId};
    observations.inputs={runtime:resolve(process.env.WEB_EXECUTION_RUNTIME),rendererDist:resolve(process.env.WEB_EXECUTION_RENDERER_DIST),serverBinSha256:digest(await readFile(join(process.env.WEB_EXECUTION_RUNTIME,'apps/server/dist/bin.mjs'))),fixtureModuleSha256:digest(await readFile(process.env.WEB_EXECUTION_FIXTURE_MODULE)),rendererReceiptSha256:digest(await readFile(join(process.env.WEB_EXECUTION_RENDERER_DIST,'aaa-native-read-build.json'))),testSha256:digest(await readFile(new URL(import.meta.url))),originalObservationsSha256:digest(await readFile(process.env.READONLY_SOURCE_OBSERVATIONS))};
    const configuration=JSON.parse(await readFile(join(directory,'fixture-configuration.json'),'utf8'));
    assert.deepEqual(configuration.enabledProviders,[]);assert.equal(configuration.readOnlySnapshot.sourceHome,sourceHome);assert.equal(configuration.readOnlySnapshot.originalUnchanged,true);
    const issued=await fixture.issueSession();assert.equal(issued.session.readonly,true);assert.equal(issued.session.mode,'native-read');
    const split=issued.cookie.indexOf('=');
    browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
    await context.addCookies([{name:issued.cookie.slice(0,split),value:issued.cookie.slice(split+1),url:fixture.origin,httpOnly:true,sameSite:'Strict'}]);
    await context.route('**/*',route=>new URL(route.request().url()).origin===fixture.origin?route.continue():route.abort());
    page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>observations.errors.push(String(error)));
    page.on('request',request=>{if(!['GET','HEAD'].includes(request.method()))observations.httpWrites.push({method:request.method(),path:new URL(request.url()).pathname});});
    page.on('websocket',socket=>socket.on('framesent',frame=>{try{const raw=JSON.parse(String(frame.payload));for(const item of Array.isArray(raw)?raw:[raw])if(item.tag==='orchestration.dispatchCommand')observations.dispatches.push({type:item.payload.type,commandId:item.payload.commandId});}catch{}}));
    await page.goto(fixture.origin+'/native/'+fixture.environmentId+'/'+source.threadId);
    await page.getByText('actual question follow-up reply',{exact:true}).first().waitFor();
    await page.getByText('User input submitted',{exact:true}).first().waitFor();
    assert.equal(await page.getByText('User input dismissed',{exact:true}).count(),0);
    observations.checks.push('exact retained thread displays its actual final reply and original submitted label; dismissed label absent');
    await page.screenshot({path:join(directory,'submitted-outcome.png')});
    assert.deepEqual(observations.errors,[]);assert.deepEqual(observations.dispatches,[]);assert.deepEqual(observations.httpWrites,[]);assert.equal(existsSync(marker),false);
    observations.checks.push('all providers disabled, native-read session and zero dispatch/HTTP mutation/CLI invocation');
  });
}finally{
  if(page){observations.lastUrl=page.url();observations.lastVisibleText=await page.locator('body').innerText().catch(()=>'');}
  await browser?.close();await fixture?.close();
  observations.sourceAfter=await sourceHashes();observations.sourceUnchanged=JSON.stringify(observations.sourceAfter)===JSON.stringify(before);
  observations.unexpectedCLI=existsSync(marker);
  await writeFile(join(directory,'observations.json'),JSON.stringify(observations,null,2)+'\n');
  assert.deepEqual(observations.sourceAfter,before,'original environment, main SQLite and WAL must remain unchanged');
  assert.equal(observations.unexpectedCLI,false);
}
