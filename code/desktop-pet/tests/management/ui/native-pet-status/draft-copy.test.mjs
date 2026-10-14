import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Original controller/HTML/CSS; no renderer, model, native service or device.
const taskRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const option = name => { const at = process.argv.indexOf(name); assert.ok(at >= 0 && process.argv[at + 1]); return resolve(process.argv[at + 1]); };
const evidence = option('--evidence'), playwright = option('--playwright');
assert.ok(evidence.startsWith(join(taskRoot, 'artifacts/W1/native-pet-status-54/')));
await mkdir(evidence, { recursive: true });
const desktop = join(taskRoot, 'code/desktop-pet/desktop');
const source = await readFile(join(desktop, 'workbench-card.mjs'), 'utf8'), css = await readFile(join(desktop, 'style.css'), 'utf8');
const html = (await readFile(join(desktop, 'index.html'), 'utf8')).replace(/<script[\s\S]*?<\/script>/g, '')
  .replace('</body>', '<script type="module" src="/harness.mjs"></script></body>');
const task = { id: 'controlled-c', projectId: 'controlled-project', provider: 'codex', origin: 't3',
  environmentId: 'controlled-env', t3ProjectId: 'controlled-native-project', threadId: 'controlled-independent-c', providerInstanceId: 'codex' };
const drafts = ['open', 'claimed', 'dismissed'].map(state => ({ id: 'draft-' + state, commandId: 'command-' + state, state, version: 1, task,
  input: { inputId: 'message-' + state, origin: { channel: 'desktop', channelSessionId: 'controlled-session', messageId: 'message-' + state },
    rawText: '受控原话：只读核对两份原回报。', dispatchText: '受控完整正文：沿原任务读取既有回报。', createdAt: '2026-10-02T00:00:00Z' } }));
const harness = `
import { DesktopWorkbenchCard } from '/workbench-card.mjs';
const task=${JSON.stringify(task)},drafts=${JSON.stringify(drafts)};
window.__actions=[];window.__nativeOpens=[];
window.__card=new DesktopWorkbenchCard({get:id=>document.getElementById(id),online:()=>true,
 send:action=>window.__actions.push(action),openNative:action=>window.__nativeOpens.push(action)});
let sequence=0;
window.__state=(selected='claimed',phase='completed',mismatch=false)=>{
 const draft=drafts.find(row=>row.state===selected);
 return {version:'0.1.0',sequence:++sequence,readAvailable:true,dispatchEnabled:true,
 focus:{version:'0.1.0',revision:1,projectId:task.projectId,task},projects:[{id:task.projectId,name:'受控原项目'}],projectsTruncated:false,
 tasks:[{task,projection:{taskId:task.id,sequence:10,eventId:'controlled-event',phase,nativeTurnId:'controlled-result-turn'},
 resultPreview:{nativeTurnId:mismatch?'unrelated-turn':'controlled-result-turn',messageId:'controlled-result',text:'受控原结果：两份回报已核对。',truncated:false}}],
 drafts,selectedDraftId:draft.id,draftsTruncated:false,
 command:{commandId:draft.commandId,state:selected==='claimed'?'accepted':'recorded',task}};
};
document.getElementById('drawer').hidden=false;
window.__card.receive(window.__state());window.__card.open();
`;
const { webkit } = await import(pathToFileURL(playwright).href), browser = await webkit.launch({ headless: true });
const cases = [], errors = [], blocked = []; let failure;
try {
  for (const width of process.argv.includes('--red') ? [380] : [380, 500]) {
    const context = await browser.newContext({ viewport: { width, height: 800 } }), page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.addInitScript(() => {
      for (const name of ['WebSocket', 'EventSource']) window[name] = class { constructor() { throw Error('controlled blocks ' + name); } };
      if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(Error('controlled blocks device'));
    });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.host === 'draft-copy.invalid') {
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html });
        if (url.pathname === '/harness.mjs') return route.fulfill({ contentType: 'text/javascript', body: harness });
        if (url.pathname === '/workbench-card.mjs') return route.fulfill({ contentType: 'text/javascript', body: source });
        if (url.pathname === '/style.css') return route.fulfill({ contentType: 'text/css', body: css });
      }
      blocked.push(url.origin + url.pathname); return route.abort('blockedbyclient');
    });
    await page.goto('http://draft-copy.invalid/');
    await page.waitForSelector('#workbench-dialog[open]');
    const stateLabel = () => page.locator('.desktop-workbench-draft .desktop-workbench-pair').filter({ hasText: '版本与状态' }).locator('span').innerText();
    const initial = { width, name: 'claimed draft with original completed task result', label: await stateLabel(),
      text: await page.locator('#workbench-content').innerText(), confirmDisabled: await page.locator('#workbench-confirm').isDisabled() };
    cases.push(initial);
    await page.locator('#workbench-dialog').screenshot({ path: join(evidence, `${width}-claimed.png`) });
    assert.equal(initial.label, 'v1 · 已领取');
    assert.ok(initial.text.includes('受控原结果：两份回报已核对。'));
    assert.equal(initial.confirmDisabled, true);
    assert.equal(initial.text.includes('已领取，结果待核对'), false);
    for (const [state, expected] of [['open', '待确认'], ['claimed', '已领取'], ['dismissed', '已取消未提交']]) {
      await page.evaluate(state => window.__card.receive(window.__state(state)), state);
      assert.equal(await stateLabel(), `v1 · ${expected}`);
      assert.equal(await page.locator(`[data-draft-id="draft-${state}"]`).getAttribute('aria-pressed'), 'true');
      assert.ok((await page.locator(`[data-draft-id="draft-${state}"]`).innerText()).endsWith(expected));
      assert.equal(await page.locator('.desktop-workbench-draft h3').innerText(), '当前草稿');
      if (state !== 'open') {
        assert.equal(await page.locator('#workbench-confirm').isDisabled(), true);
        assert.equal(await page.locator('#workbench-dismiss').isDisabled(), true);
        await page.evaluate(() => { window.__card.confirm(); window.__card.dismiss(); });
      }
      cases.push({ width, name: `exact ${state} fact without changing dispatch`, label: await stateLabel(), passed: true });
    }
    await page.evaluate(() => window.__card.receive(window.__state('claimed', 'running')));
    assert.equal(await stateLabel(), 'v1 · 已领取');
    assert.equal((await page.locator('#workbench-content').innerText()).includes('受控原结果：两份回报已核对。'), false);
    assert.ok((await page.locator(`[data-task-id="${task.id}"]`).innerText()).includes('正在处理'));
    cases.push({ width, name: 'claimed fact never invents completed execution', passed: true });
    await page.evaluate(() => window.__card.receive(window.__state('claimed', 'completed', true)));
    assert.equal((await page.locator('#workbench-content').innerText()).includes('受控原结果：两份回报已核对。'), false);
    cases.push({ width, name: 'existing exact native-turn preview check still rejects unrelated result', passed: true });
    await page.evaluate(() => window.__card.receive(window.__state()));
    await page.locator('#workbench-content').focus();
    await page.evaluate(() => { document.getElementById('workbench-content').scrollTop=50; });
    const scroll = await page.locator('#workbench-content').evaluate(element => element.scrollTop);
    await page.evaluate(() => window.__card.receive(window.__state()));
    assert.equal(await page.locator('#workbench-content').evaluate(element => document.activeElement === element), true);
    assert.equal(await page.locator('#workbench-content').evaluate(element => element.scrollTop), scroll);
    const sends = await page.evaluate(() => window.__actions);
    assert.deepEqual(sends, []);
    assert.deepEqual(await page.evaluate(() => window.__nativeOpens), []);
    cases.push({ width, name: 'refresh preserves source, target, focus, scroll; zero confirm/dismiss/native actions', passed: true, actions: sends.length });
    await page.evaluate(() => window.__card.close());
    await page.waitForFunction(() => document.activeElement.id === 'workbench-open');
    await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
} catch (error) { failure = error; }
finally { await browser.close(); }
await writeFile(join(evidence, 'results.json'), JSON.stringify({ cases, errors, blocked, failure: failure ? String(failure) : null,
  sourceSha256: createHash('sha256').update(source).digest('hex'), boundary: 'original DesktopWorkbenchCard/HTML/CSS in controlled WebKit; bridge state supplied locally, no original native window/service or model/device acceptance',
  modelRequests: 0, nativeActions: 0, liveNetworkRequests: 0 }, null, 2) + '\n');
if (failure) throw failure;
console.log(JSON.stringify({ widths: 2, groups: cases.length, liveNetwork: 0, nativeActions: 0, models: 0 }));
