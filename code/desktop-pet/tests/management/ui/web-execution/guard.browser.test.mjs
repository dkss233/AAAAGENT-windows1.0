import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
assert.ok(process.env.PLAYWRIGHT_MODULE,'Use an existing Playwright dependency; installs nothing');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const source=stripTypeScriptTypes(await readFile(new URL('../../../../t3-native/apps/web/src/aaaagent/native-operation-guard.ts',import.meta.url),'utf8'));
const output=process.env.WEB_EXECUTION_EVIDENCE??'artifacts/W1/web-execution-56/guard-controlled';
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true}),context=await browser.newContext(),page=await context.newPage();
const errors=[],unexpected=[];page.on('pageerror',error=>errors.push(String(error)));
await page.route('**/*',route=>{
  const path=new URL(route.request().url()).pathname;
  if(route.request().method()!=='GET'){unexpected.push(route.request().method());return route.abort();}
  if(path==='/guard.ts')return route.fulfill({contentType:'text/javascript',body:source});
  if(path==='/test')return route.fulfill({contentType:'text/html',body:`<!doctype html><button id="send" type="submit" aria-label="Send message" data-aaa-native-command="thread.turn.start" data-aaa-native-allowed="false" data-aaa-native-disabled="false">发送</button><button id="draft-remove" aria-label="Remove file" data-aaa-local-draft-action="true">移除草稿附件</button><button id="terminal" aria-label="Open terminal">终端</button><button id="git" aria-label="Commit">Git</button><button id="unknown" data-aaa-native-command="project.create" data-aaa-native-allowed="true" data-aaa-native-disabled="false">未知写操作</button><button id="approval" data-aaa-native-command="thread.approval.respond" data-aaa-native-allowed="false" data-aaa-native-disabled="false">批准</button><script type="module">import {lockNativeControl,preventNativeControlEvent,nativeControlSelector} from '/guard.ts';window.calls=[];window.lock=()=>document.querySelectorAll(nativeControlSelector).forEach(lockNativeControl);document.addEventListener('click',preventNativeControlEvent,true);document.addEventListener('pointerdown',preventNativeControlEvent,true);document.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>window.calls.push(b.id)));window.lock();</script>`});
  unexpected.push(path);return route.abort();
});
try{
  await page.goto('http://127.0.0.1:55998/test');await page.waitForFunction(()=>typeof window.lock==='function');
  await test('protected native DOM opens only explicit supported controls and preserves original busy state',async()=>{
    assert.equal(await page.locator('#send').isDisabled(),true);
    await page.evaluate(()=>{const button=document.querySelector('#send');button.dataset.aaaNativeAllowed='true';window.lock();});
    assert.equal(await page.locator('#send').isDisabled(),false);await page.locator('#send').click();
    await page.evaluate(()=>{document.querySelector('#send').dataset.aaaNativeDisabled='true';window.lock();});
    assert.equal(await page.locator('#send').isDisabled(),true);
    await page.evaluate(()=>{document.querySelector('#send').dataset.aaaNativeDisabled='false';window.lock();});
    assert.equal(await page.locator('#send').isDisabled(),false);
    assert.equal(await page.locator('#draft-remove').isDisabled(),false);await page.locator('#draft-remove').click();
    for(const id of ['terminal','git','unknown','approval'])assert.equal(await page.locator('#'+id).isDisabled(),true);
    await page.evaluate(()=>{document.querySelector('#approval').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));});
    assert.deepEqual(await page.evaluate(()=>window.calls),['send','draft-remove']);
    await page.evaluate(()=>{document.querySelector('#send').dataset.aaaNativeAllowed='false';window.lock();});
    assert.equal(await page.locator('#send').isDisabled(),true);
    assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
  });
}finally{
  await writeFile(`${output}/observations.json`,JSON.stringify({level:'isolated original DOM guard module; no native service or model',calls:await page.evaluate(()=>window.calls),errors,unexpected},null,2)+'\n');
  await browser.close();
}
