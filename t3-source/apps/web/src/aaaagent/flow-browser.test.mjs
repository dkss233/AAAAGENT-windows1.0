import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an existing Playwright module; this test installs nothing');
const { webkit } = await import(process.env.PLAYWRIGHT_MODULE);
const origin = process.env.NATIVE_FLOW_PREVIEW_URL ?? 'http://127.0.0.1:59912/';
const target = new URL(origin);
assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, '59912');
const output = process.env.NATIVE_FLOW_EVIDENCE ?? 'artifacts/W1/t3-flow-native-ui-54/browser';
await mkdir(output, { recursive: true });
const observations = [];
const browser = await webkit.launch({ headless: true });
async function pageAt(width=1440, height=900) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  const page = await context.newPage(); const errors=[], network=[], external=[];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => network.push({ method:r.method(), path:new URL(r.url()).pathname }));
  await page.route('**/*', r => { const url=new URL(r.request().url()); if(url.origin===target.origin) return r.continue(); external.push(url.origin); return r.abort(); });
  await page.addInitScript(() => { window.__testDeviceCalls=0; if(navigator.mediaDevices) navigator.mediaDevices.getUserMedia=()=>{window.__testDeviceCalls++;throw Error('No device calls in this preview test');}; });
  await page.goto(origin, { waitUntil:'networkidle' }); await page.locator('.aaa-flow-node').first().waitFor();
  return { page, context, errors, network, external };
}
async function record(name, s) {
  const data = await s.page.evaluate(()=>({url:location.href,theme:document.documentElement.dataset.themeId,dark:document.documentElement.classList.contains('dark'),overflow:document.documentElement.scrollWidth>innerWidth,deviceCalls:window.__testDeviceCalls,audit:window.__AAA_PREVIEW_TRANSPORT?.audit()}));
  assert.deepEqual(s.errors, []); assert.deepEqual(s.external, []); assert.equal(data.deviceCalls,0); assert.equal(s.network.filter(r=>r.method!=='GET').length,0);
  observations.push({name,...data,networkRequests:s.network.length,errors:s.errors});
  await s.page.screenshot({path:`${output}/${name}.png`,fullPage:true});
  await s.context.close();
}
try {
 await test('native T3 Flow browser behavior', async t => {
  await t.test('native overview has original identities and persistent example label', async()=>{
    const s=await pageAt(); const p=s.page;
    assert.match(await p.locator('.aaa-workspace-bar').innerText(),/界面示例/);
    assert.equal(await p.locator('.aaa-flow-node').count(),3);
    const identities=await p.locator('.aaa-flow-node').evaluateAll(es=>es.map(e=>e.dataset.threadId));
    assert.equal(new Set(identities).size,3);
    const labels=await p.locator('.aaa-node-footer small').allTextContents(); assert.equal(new Set(labels).size,3);
    assert.equal(await p.locator('.aaa-flow-plane svg').count(),0);
    await record('overview-light',s);
  });
  await t.test('drag, pan, zoom, fit and locate work without opening on drag',async()=>{
    const s=await pageAt();const p=s.page;const node=p.locator('.aaa-flow-node').first(),box=await node.boundingBox();
    await p.mouse.move(box.x+65,box.y+65);await p.mouse.down();await p.mouse.move(box.x+150,box.y+110,{steps:6});await p.mouse.up();
    assert.equal(new URL(p.url()).pathname,'/');const moved=await node.boundingBox();assert.ok(Math.abs(moved.x-box.x)>60);
    const canvas=p.locator('.aaa-flow-canvas'),c=await canvas.boundingBox();const before=await canvas.getAttribute('data-viewport');
    await p.mouse.move(c.x+c.width-35,c.y+c.height-40);await p.mouse.down();await p.mouse.move(c.x+c.width-95,c.y+c.height-95,{steps:5});await p.mouse.up();
    assert.notEqual(await canvas.getAttribute('data-viewport'),before);
    await p.getByRole('button',{name:'放大画布',exact:true}).click();assert.match(await p.getByLabel('画布缩放').innerText(),/120/);
    await p.getByRole('button',{name:'适应全部',exact:true}).click();
    for(const card of await p.locator('.aaa-flow-node').all()){const b=await card.boundingBox();assert.ok(b.x>=c.x-1 && b.x+b.width<=c.x+c.width+1);}
    await node.getByRole('button',{name:/选中/}).click();await p.getByRole('button',{name:'定位选中',exact:true}).click();
    const centered=await node.boundingBox();assert.ok(Math.abs(centered.x+centered.width/2-(c.x+c.width/2))<2);
    await node.focus();await p.keyboard.press('ArrowRight');
    const after=await node.boundingBox();assert.ok(after.x>centered.x);
    const saved=await canvas.getAttribute('data-viewport');await p.reload({waitUntil:'networkidle'});await p.locator('.aaa-flow-canvas').waitFor();assert.deepEqual(JSON.parse(await p.locator('.aaa-flow-canvas').getAttribute('data-viewport')),JSON.parse(saved));
    await record('canvas-moved',s);
  });
  await t.test('original chat, Markdown, code, diff panel and typed draft survive return',async()=>{
    const s=await pageAt();const p=s.page;const id=await p.locator('.aaa-flow-node').first().getAttribute('data-thread-id');
    await p.locator('.aaa-flow-node').first().getByRole('button',{name:/展开对话/}).click();await p.locator('[contenteditable=true]').first().waitFor();
    assert.equal(decodeURIComponent(new URL(p.url()).pathname.split('/').pop()),id);
    assert.match(await p.locator('body').innerText(),/原生 T3 聊天组件/);await p.getByText('export const keepThread = true;',{exact:true}).waitFor();
    await p.locator('[contenteditable=true]').first().fill('保留这份原生草稿');
    await p.getByRole('button',{name:'Open diff',exact:true}).click();await p.getByRole('button',{name:'Expand src/flow.ts',exact:true}).click();await p.getByText('export const view = "canvas";',{exact:true}).waitFor();
    assert.match(await p.locator('body').innerText(),/Diff/);await p.screenshot({path:`${output}/diff-expanded-light.png`});
    await p.getByRole('link',{name:/项目总览/}).click();await p.locator('.aaa-flow-node').first().waitFor();
    await p.locator(`[data-thread-id="${id}"]`).getByRole('button',{name:/展开对话/}).click();await p.locator('[contenteditable=true]').first().waitFor();
    assert.match(await p.locator('[contenteditable=true]').first().innerText(),/保留这份原生草稿/);
    await record('native-chat-diff',s);
  });
  await t.test('voice simulation appends original text, cancel and switch do not misroute',async()=>{
    const s=await pageAt();const p=s.page;
    await p.locator('.aaa-flow-node').first().getByRole('button',{name:/展开对话/}).click();const editor=p.locator('[contenteditable=true]').first();await editor.waitFor();await editor.fill('已输入的草稿');
    await p.getByRole('button',{name:'◉ 语音输入',exact:true}).click();await p.getByLabel('模拟语音原话').fill('  模拟原话保持  ');await p.getByRole('button',{name:'回填当前草稿',exact:true}).click();
    assert.match(await editor.innerText(),/已输入的草稿/);assert.match(await editor.innerText(),/模拟原话保持/);
    await p.getByRole('button',{name:'◉ 语音输入',exact:true}).click();await p.getByLabel('模拟语音原话').fill('取消的原话');await p.getByRole('button',{name:'取消',exact:true}).click();assert.doesNotMatch(await editor.innerText(),/取消的原话/);
    await p.getByRole('button',{name:'◉ 语音输入',exact:true}).click();await p.getByLabel('模拟语音原话').fill('旧会话录音原话');await p.getByRole('link',{name:/项目总览/}).click();await p.locator('.aaa-flow-node').first().waitFor();await p.locator('.aaa-flow-node').last().getByRole('button',{name:/展开对话/}).click();await editor.waitFor();assert.doesNotMatch(await editor.innerText(),/旧会话录音原话|模拟原话保持/);
    await record('voice-switch',s);
  });
  await t.test('project search, filter and empty state stay within the selected project',async()=>{
    const s=await pageAt();const p=s.page;
    await p.getByLabel('搜索当前项目对话').fill('语音');assert.equal(await p.locator('.aaa-flow-node').count(),1);
    await p.getByLabel('状态筛选').selectOption('working');assert.match(await p.locator('body').innerText(),/没有匹配/);
    const select=p.getByLabel('选择项目');const options=await select.locator('option').evaluateAll(e=>e.map(x=>({label:x.label,value:x.value})));await select.selectOption(options.find(x=>x.label.includes('另一项目')).value);assert.equal(await p.locator('.aaa-flow-node').count(),1);
    await select.selectOption(options.find(x=>x.label.includes('空项目')).value);assert.match(await p.locator('body').innerText(),/这个项目还没有对话/);
    await record('empty-project',s);
  });
  await t.test('paired themes persist and original panel controls stay below AAA toolbar',async()=>{
    const s=await pageAt();const p=s.page;await p.getByRole('button',{name:'深色',exact:true}).click();assert.equal(await p.evaluate(()=>document.documentElement.classList.contains('dark')),true);
    await p.reload({waitUntil:'networkidle'});assert.equal(await p.evaluate(()=>document.documentElement.classList.contains('dark')),true);
    await p.locator('.aaa-flow-node').first().getByRole('button',{name:/展开对话/}).click();await p.getByRole('button',{name:'Open diff',exact:true}).click();await p.getByRole('button',{name:'Expand src/flow.ts',exact:true}).click();await p.getByText('export const view = "canvas";',{exact:true}).waitFor();
    const bar=await p.locator('.aaa-workspace-bar').boundingBox();const controls=await p.locator('[data-workspace-titlebar-controls]').boundingBox();assert.ok(controls.y>=bar.y+bar.height-1);
    await p.getByRole('button',{name:'跟随系统',exact:true}).click();await p.emulateMedia({colorScheme:'dark'});await p.waitForFunction(()=>document.documentElement.classList.contains('dark'));assert.equal(await p.evaluate(()=>document.documentElement.classList.contains('dark')),true);await p.getByRole('button',{name:'深色',exact:true}).click();
    await record('native-dark',s);
  });
  await t.test('390 and 320px original details and view controls remain usable',async()=>{
    for(const width of [390,320]){const s=await pageAt(width,844);const p=s.page;assert.equal(await p.locator('.aaa-flow-list').count(),1);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await p.getByRole('button',{name:'画布',exact:true}).click();await p.getByRole('button',{name:'适应全部',exact:true}).click();const frame=await p.locator('.aaa-flow-canvas').boundingBox();for(const card of await p.locator('.aaa-flow-node').all()){const box=await card.boundingBox();assert.ok(box.x>=frame.x-1 && box.x+box.width<=frame.x+frame.width+1,'fit must include all nodes on a narrow canvas');}await p.getByRole('button',{name:'列表',exact:true}).click();await p.locator('.aaa-flow-node').first().getByRole('button',{name:/展开对话/}).click();await p.getByText('Ask anything...',{exact:true}).click();await p.locator('[contenteditable=true]').first().waitFor();await p.locator('[contenteditable=true]').first().fill('窄屏原生草稿');assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const home=await p.locator('.aaa-home-link').boundingBox(),sidebar=await p.getByRole('button',{name:'Toggle main sidebar',exact:true}).boundingBox();assert.ok(home.x>=sidebar.x+sidebar.width);await record(`native-mobile-${width}`,s);}
  });
 });
} finally { await writeFile(`${output}/observations.json`,JSON.stringify(observations,null,2)+'\n');await browser.close(); }
