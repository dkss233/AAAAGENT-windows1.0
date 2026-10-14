import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
assert.ok(process.env.PLAYWRIGHT_MODULE&&process.env.NATIVE_MOUNT_SESSION_FILE,'Use the actual I candidate');
const {webkit}=await import(process.env.PLAYWRIGHT_MODULE);
const session=JSON.parse(await readFile(process.env.NATIVE_MOUNT_SESSION_FILE,'utf8'));
assert.equal(new URL(session.origin).hostname,'127.0.0.1');assert.equal(new URL(session.origin).port,'59913');
const output=process.env.NATIVE_MOUNT_LAYOUT_EVIDENCE??'artifacts/W1/t3-native-mount-read-54/real-layout-fixed';await mkdir(output,{recursive:true});
const browser=await webkit.launch({headless:true}),context=await browser.newContext({viewport:{width:1280,height:720},reducedMotion:'reduce'}),page=await context.newPage();
const errors=[],external=[];let observation=null;
page.on('pageerror',e=>errors.push(e.name));await page.route('**/*',r=>new URL(r.request().url()).origin===session.origin?r.continue():(external.push(new URL(r.request().url()).origin),r.abort()));
try{
 await test('actual 1280x720 engineering entry makes the exact original node action directly reachable',async()=>{
  try{await page.goto(session.url,{waitUntil:'domcontentloaded'});}catch{throw Error('Candidate entry unavailable; private URL omitted');}
  await page.getByRole('tab',{name:'工程入口',exact:true}).click();await page.locator('.native-workbench-frame').waitFor();
  const frame=page.frames().find(f=>f!==page.mainFrame()),threadId='55321ff5-339c-4654-b094-8eed93833125';await frame.locator(`[data-thread-id="${threadId}"]`).waitFor();
  await page.waitForFunction(()=>document.querySelector('.native-workbench-state').hidden);
  const button=frame.getByRole('button',{name:`展开对话 ${threadId}`,exact:true});
  const buttonRect=await button.boundingBox(),portalRect=await page.locator('.native-workbench-portal').boundingBox();
  const hit=await button.evaluate(e=>{const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {hit:e===hit||e.contains(hit),x:r.x,y:r.y,width:r.width,height:r.height,windowHeight:innerHeight};});
  const outerHit=await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.classList.contains('native-workbench-frame'),{x:buttonRect.x+buttonRect.width/2,y:buttonRect.y+buttonRect.height/2});
  observation={level:'actual original data at 1280x720',threadId,buttonRect,portalRect,hit,outerHit,loadingOverlayHidden:true,parentScrollY:await page.evaluate(()=>scrollY),errors,external};
  await page.screenshot({path:`${output}/entry-1280x720.png`});
  assert.equal(hit.hit,true,'Exact expand button must be hit-test reachable without fitting or scrolling');assert.equal(outerHit,true,'Parent must not cover the native action');assert.ok(buttonRect.y+buttonRect.height<=720,'Expand button inside outer viewport');
  await button.click();await frame.locator('[contenteditable=true]').first().waitFor();
  assert.equal(decodeURIComponent(new URL(frame.url()).pathname),`/native/a1179513-828e-4091-a9c5-d214be6b1954/${threadId}`);
  assert.equal(await frame.getByRole('button',{name:'Add action',exact:true}).isDisabled(),true);
  assert.equal(await frame.getByRole('button',{name:'Open',exact:true}).isDisabled(),true);
  observation.addActionDisabled=true;observation.openEditorDisabled=true;
  observation.exactOriginalDialogueOpened=true;assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 });
}finally{await writeFile(`${output}/observations.json`,JSON.stringify(observation??{incomplete:true,errors,external},null,2)+'\n');await context.close();await browser.close();}
