// Manual real-browser probe. No dispatch/device calls and no raw user text logs.
import { readFileSync,writeFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.AAAAGENT_PLAYWRIGHT_MODULE || 'playwright');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../..');
const session=JSON.parse(readFileSync(resolve(root,'artifacts/runtime/native-mount-read-54/candidate-session.json'),'utf8'));
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const responses=[],errors=[];
page.on('response',r=>{const u=new URL(r.url());if(u.origin===session.origin&&u.pathname.startsWith('/api/'))responses.push({method:r.request().method(),path:u.pathname,status:r.status()});});
page.on('pageerror',e=>errors.push({name:e.name}));
const result={mode:'real-existing-native-no-dispatch',candidateOrigin:session.origin,responses,errors};
try {
  await page.goto(session.url);await page.locator('#nav-workbench').click();
  await page.waitForTimeout(4000);
  const portal=page.locator('.native-workbench-portal');result.portalPhase=await portal.getAttribute('data-phase');
  const frame=page.frames().find(f=>new URL(f.url()).pathname.startsWith('/native/'));
  result.nativeFrame=frame?{path:new URL(frame.url()).pathname,workspaceShell:await frame.locator('.aaa-workspace-shell').count(),
    flowNodeCount:await frame.locator('[data-thread-id]').count(),flowCanvas:await frame.locator('.aaa-flow-canvas').count()}:null;
  if(frame && result.portalPhase==='ready') {
    const projectId='5659cde4-4f61-4748-807f-cef35b1aecf5',threadId='55321ff5-339c-4654-b094-8eed93833125';
    const chooser=frame.getByLabel('选择项目');
    const values=await chooser.locator('option').evaluateAll(options=>options.map(o=>o.value));
    const value=values.find(v=>v.includes(projectId));if(!value)throw Error('Existing test project absent');
    await chooser.selectOption(value);
    const node=frame.locator(`[data-thread-id="${threadId}"]`);await node.focus();await node.press('Enter');
    await frame.waitForTimeout(2000);
    result.originalDialogue={projectId,threadId,path:new URL(frame.url()).pathname,
      markerVisible:await frame.getByText('AAA_B54_CODEX_OK',{exact:true}).count()>0,
      originalComposer:await frame.locator('[contenteditable="true"]').count()};
    if(result.originalDialogue.originalComposer===1) {
      await frame.locator('[contenteditable="true"]').fill('集成只读核验草稿（未发送）');
    }
    await frame.evaluate(()=>{window.__aaaReadDocument='native54-integration';});
    const parentFrame=await page.locator('iframe.native-workbench-frame').elementHandle();
    await frame.locator('.aaa-home-link').click();await page.locator('#refresh').click();await page.waitForTimeout(700);
    result.returnAndParentRefresh={path:new URL(frame.url()).pathname,documentSame:await frame.evaluate(()=>window.__aaaReadDocument==='native54-integration'),frameSame:await page.locator('iframe.native-workbench-frame').evaluate((el,original)=>el===original,parentFrame)};
    await frame.locator(`[data-thread-id="${threadId}"]`).focus();await frame.locator(`[data-thread-id="${threadId}"]`).press('Enter');await frame.waitForTimeout(700);
    result.returnAndParentRefresh.draftRetained=result.originalDialogue.originalComposer===1 &&
      (await frame.locator('[contenteditable="true"]').innerText())==='集成只读核验草稿（未发送）';
  }
  const authPath=new URL(page.url());result.parentPath=authPath.pathname;result.parentCredentialStripped=!authPath.hash;
}finally{await browser.close();}
writeFileSync(resolve(root,'artifacts/W0-I/t3-native-mount-read-54/real-browser-first.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
