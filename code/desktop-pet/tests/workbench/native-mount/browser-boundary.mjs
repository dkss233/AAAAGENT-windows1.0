// Bounded integration receipt probe; uses the real candidate and never sends a turn.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.AAAAGENT_PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const session = JSON.parse(readFileSync(resolve(root, 'artifacts/runtime/native-mount-read-54/candidate-session.json')));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const result = { source: '70c29c7', mode: 'real-existing-readonly', ws: { opened: 0, received: 0, errors: 0 }, pageErrors: 0 };
page.on('websocket', socket => {
  result.ws.opened++;
  socket.on('framereceived', () => result.ws.received++);
  socket.on('socketerror', () => result.ws.errors++);
});
page.on('pageerror', () => result.pageErrors++);
try {
  await page.goto(session.url);
  await page.locator('#nav-workbench').click();
  const frame = page.frameLocator('iframe.native-workbench-frame');
  await frame.locator('.aaa-workspace-shell').waitFor();
  const selector = frame.getByLabel('选择项目');
  const projectValue = (await selector.locator('option').evaluateAll(es => es.map(e => e.value)))
    .find(v => v.includes('5659cde4-4f61-4748-807f-cef35b1aecf5'));
  if (!projectValue) throw Error('Original registered project absent');
  await selector.selectOption(projectValue);
  await frame.locator('[data-thread-id="55321ff5-339c-4654-b094-8eed93833125"]').press('Enter');
  await frame.getByText('AAA_B54_CODEX_OK', { exact: true }).waitFor();
  result.markerVisible = true;
  result.nativeStatus = await frame.locator('.aaa-native-read-status').innerText();
  result.buttons = {};
  for (const name of ['Add action', 'Open']) {
    const button = frame.getByRole('button', { name, exact: true });
    result.buttons[name] = { count: await button.count(), enabled: await button.isEnabled() };
  }
  result.actualFrameOrigin = new URL(page.frames().find(f => new URL(f.url()).pathname.startsWith('/native/')).url()).origin;
  result.parentDocumentCanAccessFrame = await page.locator('iframe.native-workbench-frame').evaluate(e => Boolean(e.contentDocument));
  result.passed = result.markerVisible && result.ws.received > 0 && result.ws.errors === 0 &&
    Object.values(result.buttons).every(b => b.count === 1 && !b.enabled);
} catch (error) {
  result.passed = false;
  result.failureType = error.name;
} finally {
  await browser.close();
  writeFileSync(resolve(root, 'artifacts/W0-I/t3-native-mount-read-54/browser-boundary-739.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify(result));
process.exitCode = result.passed ? 0 : 1;
