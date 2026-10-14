import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Original Sheet, AgentsPanel and native child dialog. Only their reader is a saved fixture.
const taskRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const args = process.argv.slice(2);
const option = name => { const at = args.indexOf(name); assert.ok(at >= 0 && args[at + 1], name); return resolve(args[at + 1]); };
const assembly = option("--assembly"), evidence = option("--evidence"), fixtureRoot = option("--fixtures");
const playwright = option("--playwright"), esbuildPackage = option("--esbuild"), styleRoot = option("--styles");
assert.ok(assembly.startsWith(join(taskRoot, "artifacts/runtime/")));
assert.ok(["artifacts/W1/native-child-flow-54/", "artifacts/W0-I/native-child-flow-54/"]
 .some(prefix => evidence.startsWith(join(taskRoot, prefix))));
await mkdir(evidence, { recursive: true });
const fixtures = await Promise.all(["01a0f649-c6eb-7dd2-9fa6-9ed2848fff38", "01a0f649-e098-73f1-adc7-e5d9b3943d0c"]
 .map(id => readFile(join(fixtureRoot, `actual-child-${id}.json`), "utf8").then(JSON.parse)));
const web = join(assembly, "apps/web"), source = join(web, "src/aaaagent/NativeChildConversation.tsx");
const original = await readFile(source, "utf8"), begin = original.indexOf("export function useNativeChildReader()"), end = original.indexOf("\nexport function NativeChildConversation", begin);
assert.ok(begin >= 0 && end > begin, "Replace only the runtime reader hook; preserve the complete original dialog component");
const sourceWithFixtureReader = original.slice(0, begin) + 'export function useNativeChildReader(): NativeChildReader { return window.__fixtureReader; }\n' + original.slice(end);
const css = (await Promise.all((await readdir(styleRoot)).filter(name => name.endsWith(".css")).map(name => readFile(join(styleRoot, name), "utf8")))).join("\n")
 + await readFile(join(taskRoot, "code/desktop-pet/t3-native/apps/web/src/aaaagent/flow.css"), "utf8");
const entry = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { Dialog } from "@base-ui/react/dialog";
import { RightPanelSheet } from ${JSON.stringify(join(web, "src/components/RightPanelSheet.tsx"))};
import { AgentsPanel } from ${JSON.stringify(join(web, "src/components/AgentsPanel.tsx"))};
import { NativeChildConversation } from ${JSON.stringify(source)};
import { usePanelPresence } from ${JSON.stringify(join(web, "src/panelAnimations.ts"))};
const fixtures = ${JSON.stringify(fixtures)}, target = fixtures[0].scope;
window.__fixtureReader = { relations: async () => ({ apiVersion: "0.1.0", scope: target, children: fixtures.map(row => row.child) }),
 conversation: async (_, id) => fixtures.find(row => row.child.nativeThreadId === id) };
const agents = fixtures.map(({ child }) => ({ id: child.nativeThreadId, kind: "subagent", title: child.title, role: child.agentPath,
 model: child.model, effort: child.effort, status: "idle", activationCount: 1, usage: null, progress: null, lastToolName: null,
 result: null, error: null, outputFile: null, parentAgentId: child.parentNativeThreadId, agentIndex: null, phaseIndex: null, phaseTitle: null,
 attempt: null, workflowName: null, phases: [], runHandles: null, recentActivity: [], firstSeenAt: child.createdAt,
 startedAt: child.createdAt, completedAt: child.updatedAt, updatedAt: child.updatedAt }));
const model = { workflows: [], directAgents: agents, runningCount: 0, waitingCount: 0, idleCount: 2, settledCount: 0, totalTokens: 0, hasAgents: true, liveCount: 0 };
function Harness() {
 const [open, setOpen] = useState(false), [flow, setFlow] = useState(false);
 const presence = usePanelPresence(open, true, false, target.parentThreadId, 0);
 window.__parentOpen = open;
 return <><input id="public-draft" defaultValue="Public offline draft; do not send." /><div id="public-viewport" data-scale="30%" />
 <button id="agents-opener" onClick={() => setOpen(true)}>Open original Agents panel</button>
 <button id="flow-opener" onClick={() => setFlow(true)}>Open Flow child</button>
 {presence.present && <RightPanelSheet open={open} animationDurationMs={0} onClose={() => {
  window.__events.push({ phase: "original-Sheet-onClose", key: window.__lastKeyEvent?.key, defaultPrevented: window.__lastKeyEvent?.defaultPrevented,
   childPresent: !!document.querySelector(".aaa-native-child-dialog") }); setOpen(false);
 }}><Dialog.Title>Original Agents</Dialog.Title><AgentsPanel model={model} environmentId={target.environmentId} threadId={target.parentThreadId} nativeTarget={target} /></RightPanelSheet>}
 {flow && <NativeChildConversation target={target} child={fixtures[0].child} reader={window.__fixtureReader} onClose={() => setFlow(false)} onOpenParent={() => setFlow(false)} />}
 </>;
}
const route = createRootRoute({ component: Harness });
createRoot(document.getElementById("root")).render(<RouterProvider router={createRouter({ routeTree: route })} />);
`;
const { build } = createRequire(join(esbuildPackage, "package.json"))(esbuildPackage);
const built = await build({ stdin: { contents: entry, resolveDir: web, sourcefile: "original-escape-layer.tsx", loader: "tsx" },
 bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", jsx: "automatic", tsconfig: join(web, "tsconfig.json"),
 define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({ APP_VERSION: "offline", VITE_AAA_NATIVE_READ: "1", VITE_AAA_PREVIEW: "0", MODE: "test", DEV: false, PROD: true }) },
 plugins: [{ name: "saved-reader-only", setup(builder) {
  builder.onLoad({ filter: /NativeChildConversation\.tsx$/ }, () => ({ contents: sourceWithFixtureReader, loader: "tsx", resolveDir: dirname(source) }));
  builder.onResolve({ filter: /\?worker$/ }, input => ({ path: input.path, namespace: "unused-worker" }));
  builder.onLoad({ filter: /.*/, namespace: "unused-worker" }, () => ({ contents: 'export default class { constructor() { throw new Error("unused offline worker"); } }', loader: "js" }));
 } }], loader: { ".svg": "dataurl", ".woff2": "dataurl" }, logLevel: "silent" });
const script = built.outputFiles.find(file => file.path.endsWith(".js"))?.text ?? built.outputFiles[0].text;
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>';
const { chromium } = await import(pathToFileURL(playwright).href), browser = await chromium.launch({ headless: true });
const cases = [], flowCases = [], blocked = [], errors = []; let failure;
try {
 for (const [width, height] of [[319, 767], [1440, 900]]) {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" }), page = await context.newPage();
  page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(() => {
   window.__events = [];
   window.addEventListener("keydown", event => { window.__lastKeyEvent = event; if (event.key === "Escape") window.__events.push({ phase: "window-capture", defaultPrevented: event.defaultPrevented }); }, true);
   for (const capture of [true, false]) document.addEventListener("keydown", event => {
    if (event.key === "Escape") window.__events.push({ phase: capture ? "document-capture" : "document-bubble", defaultPrevented: event.defaultPrevented });
   }, capture);
   for (const name of ["WebSocket", "EventSource"]) window[name] = class { constructor() { throw new Error("offline blocks " + name); } };
   if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error("offline blocks device"));
  });
  await page.route("**/*", route => {
   const url = new URL(route.request().url());
   if (url.host === "escape-layer.invalid") {
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.pathname === "/style.css") return route.fulfill({ contentType: "text/css", body: css });
   }
   blocked.push(url.origin + url.pathname); return route.abort("blockedbyclient");
  });
  await page.goto("http://escape-layer.invalid/");
  for (const [index, fixture] of fixtures.entries()) {
   await page.locator("#agents-opener").click();
   const opener = page.getByRole("button", { name: `打开子Agent ${fixture.child.title} 的完整原对话`, exact: true });
   await opener.waitFor({ state: "visible" }); await opener.click();
   const child = page.locator(".aaa-native-child-dialog"); await child.waitFor({ state: "visible" });
   await child.locator(".aaa-native-child-timeline").getByText(index === 0 ? "任务 A 实际结果" : "离线查看", { exact: false }).first().waitFor({ state: "visible" });
   await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab");
   assert.equal(await child.evaluate(element => element.contains(document.activeElement)), true);
   await page.keyboard.press("Escape"); await child.waitFor({ state: "detached" });
   const state = await page.evaluate(() => ({ parentOpen: window.__parentOpen, focused: document.activeElement?.getAttribute("aria-label"),
    draft: document.querySelector("#public-draft").value, scale: document.querySelector("#public-viewport").dataset.scale, events: window.__events.slice() }));
   await page.screenshot({ path: join(evidence, `${index === 0 ? "a" : "b"}-${width}-escape.png`) });
   cases.push({ width, height, childId: fixture.child.nativeThreadId, ...state });
   assert.equal(state.parentOpen, true, "Escape from native child must preserve original Agents Sheet");
   assert.equal(state.focused, `打开子Agent ${fixture.child.title} 的完整原对话`);
   assert.equal(state.draft, "Public offline draft; do not send."); assert.equal(state.scale, "30%");
   await opener.click(); await child.waitFor({ state: "visible" }); await child.getByRole("button", { name: "返回", exact: true }).click();
   await child.waitFor({ state: "detached" }); assert.equal(await opener.evaluate(element => document.activeElement === element), true);
   assert.equal(await page.evaluate(() => window.__parentOpen), true);
   cases.at(-1).returnButtonPreservesPanelAndOpener = true;
   await page.keyboard.press("Escape"); await page.waitForFunction(() => !window.__parentOpen);
   await page.waitForFunction(() => document.activeElement?.id === "agents-opener");
   cases.at(-1).nextEscapeClosesParentAndRestoresRootOpener = true;
  }
  await page.locator("#flow-opener").click();
  await page.locator(".aaa-native-child-dialog").waitFor({ state: "visible" }); await page.keyboard.press("Escape");
  await page.locator(".aaa-native-child-dialog").waitFor({ state: "detached" });
  assert.equal(await page.locator("#flow-opener").evaluate(element => document.activeElement === element), true);
  flowCases.push({ width, height, standaloneEscapeRestoresOpener: true });
  await context.close();
 }
 assert.deepEqual(errors, []);
} catch (error) { failure = String(error); }
finally {
 await browser.close();
 const paths = ["src/aaaagent/NativeChildConversation.tsx", "src/components/AgentsPanel.tsx", "src/components/RightPanelSheet.tsx", "src/components/ui/sheet.tsx", "src/panelAnimations.ts"];
 const hashes = await Promise.all(paths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(join(web, path))).digest("hex") })));
 await writeFile(join(evidence, "results.json"), JSON.stringify({ hashes, harnessSha256: createHash("sha256").update(await readFile(fileURLToPath(import.meta.url))).digest("hex"),
  cases, flowCases, blocked, errors, failure: failure ?? null, boundaries: "Original Sheet/presence/AgentsPanel/dialog/renderer; only useNativeChildReader hook returns saved public fixtures; all requests memory fulfilled or aborted. No full ChatView/custom shortcut configuration/live service. Draft and viewport marker are controlled public harness fields, not real composer/canvas acceptance." }, null, 2) + "\n");
}
if (failure) throw new Error(failure);
console.log(JSON.stringify({ ok: true, cases: cases.length, memoryOnly: true, evidence }));
