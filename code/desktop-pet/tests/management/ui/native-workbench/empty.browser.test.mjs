import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
assert.ok(process.env.PLAYWRIGHT_MODULE&&process.env.NATIVE_MOUNT_SESSION_FILE,'Use the existing I candidate and installed browser runtime');
const {webkit}=await import(process.env.PLAYWRIGHT_MODULE);
const session=JSON.parse(await readFile(process.env.NATIVE_MOUNT_SESSION_FILE,'utf8'));
assert.equal(new URL(session.origin).hostname,'127.0.0.1');assert.equal(new URL(session.origin).port,'59913');
const output=process.env.NATIVE_MOUNT_EMPTY_EVIDENCE??'artifacts/W1/t3-native-mount-read-54/real-empty';
await mkdir(output,{recursive:true});
const browser=await webkit.launch({headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage();
const requests=[],errors=[],external=[];let observation=null;
page.on('request',r=>requests.push({method:r.method(),path:new URL(r.url()).pathname}));page.on('pageerror',e=>errors.push(e.name));
await page.route('**/*',r=>new URL(r.request().url()).origin===session.origin?r.continue():(external.push(new URL(r.request().url()).origin),r.abort()));
try{
 await test('actual real project search has a clear empty result and recovers the same original node',async()=>{
  try{await page.goto(session.url,{waitUntil:'domcontentloaded'});}catch{throw Error('Candidate unavailable; private entry omitted');}
  await page.getByRole('tab',{name:'工程入口',exact:true}).click();await page.locator('.native-workbench-frame').waitFor();
  const frame=page.frames().find(f=>f!==page.mainFrame());await frame.locator('.aaa-flow-node').first().waitFor();
  const descriptor=await (await context.request.get(session.origin+'/.well-known/t3/environment')).json();
  const projectId='5659cde4-4f61-4748-807f-cef35b1aecf5',threadId='55321ff5-339c-4654-b094-8eed93833125';
  await frame.getByLabel('选择项目').selectOption(JSON.stringify([descriptor.environmentId,projectId]));await frame.locator(`[data-thread-id="${threadId}"]`).waitFor();
  const search=frame.getByLabel('搜索当前项目对话');await search.fill('W1_NOMATCH_LOCAL_FILTER_54');
  await frame.getByRole('heading',{name:'没有匹配的对话',exact:true}).waitFor();assert.equal(await frame.locator('.aaa-flow-node').count(),0);
  await frame.locator('.aaa-flow-overview').screenshot({path:`${output}/empty-search-real-project.png`});
  await search.fill('');await frame.locator(`[data-thread-id="${threadId}"]`).waitFor();
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.ok(requests.filter(r=>r.method!=='GET').every(r=>['/api/native-mount/session','/api/auth/websocket-ticket'].includes(r.path)));
  observation={level:'actual original project/client search; no fabricated empty backend',environmentId:descriptor.environmentId,projectId,threadId,emptySearchVisible:true,sameOriginalNodeRecovered:true,errors,external,nonReads:requests.filter(r=>r.method!=='GET')};
 });
}finally{await writeFile(`${output}/observations.json`,JSON.stringify(observation??{incomplete:true,errors,external},null,2)+'\n');await context.close();await browser.close();}
