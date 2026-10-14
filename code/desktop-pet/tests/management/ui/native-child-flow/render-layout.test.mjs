import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Uses existing dependencies, original components and saved public trial records.
// Every browser request is fulfilled from memory or aborted; no server is started.
const taskRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(name);
  assert.ok(at >= 0 && args[at + 1], `Missing ${name}`);
  return resolve(args[at + 1]);
}
const assembly = option("--assembly"), playwright = option("--playwright"), esbuildPackage = option("--esbuild");
const evidence = option("--evidence"), fixtureRoot = option("--fixtures"), styleRoot = option("--styles");
assert.ok(assembly.startsWith(join(taskRoot, "artifacts/runtime/")), "Use this registered task assembly");
assert.ok(["artifacts/W1/native-child-flow-54/", "artifacts/W0-I/native-child-flow-54/"]
  .some(prefix => evidence.startsWith(join(taskRoot, prefix))), "Keep W1 or integration evidence exactly scoped");
await mkdir(evidence, { recursive: true });
const require = createRequire(join(esbuildPackage, "package.json"));
const { build } = require(esbuildPackage);
const { chromium } = await import(pathToFileURL(playwright).href);
const childIds = ["01a0f649-c6eb-7dd2-9fa6-9ed2848fff38", "01a0f649-e098-73f1-adc7-e5d9b3943d0c"];
const fixtures = await Promise.all(childIds.map(id => readFile(join(fixtureRoot, `actual-child-${id}.json`), "utf8").then(JSON.parse)));
for (const [index, fixture] of fixtures.entries()) {
  assert.equal(fixture.complete, true);
  assert.equal(fixture.child.nativeThreadId, childIds[index]);
  assert.equal(fixture.nativeThread.id, childIds[index]);
  assert.equal(fixture.scope.parentThreadId, "b54-skill-multi-20261001");
}
const cssFiles = (await readdir(styleRoot)).filter(file => file.endsWith(".css"));
assert.ok(cssFiles.length, "Use the original compiled native UI stylesheet");
const baseStyles = (await Promise.all(cssFiles.map(file => readFile(join(styleRoot, file), "utf8")))).join("\n");
const moduleStylePath = args.includes("--module-css") ? option("--module-css")
  : join(taskRoot, "code/desktop-pet/t3-native/apps/web/src/aaaagent/flow.css");
assert.ok(moduleStylePath.startsWith(taskRoot + "/"), "Replay only this task's saved stylesheet");
const moduleStyles = await readFile(moduleStylePath, "utf8");
const entry = `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { NativeChildConversation } from ${JSON.stringify(join(assembly, "apps/web/src/aaaagent/NativeChildConversation.tsx"))};
const fixtures = ${JSON.stringify(fixtures)};
const fixture = fixtures[Number(new URL(location.href).searchParams.get("child") || "0")];
const reader = { relations: async () => ({ apiVersion: "0.1.0", scope: fixture.scope, children: [fixture.child] }), conversation: async () => fixture };
function Harness() {
  const [open, setOpen] = useState(false);
  return <><button id="original-opener" onClick={() => setOpen(true)}>Open original child</button>
    {open && <NativeChildConversation target={fixture.scope} child={fixture.child} reader={reader}
      onClose={() => setOpen(false)} onOpenParent={() => setOpen(false)} />}</>;
}
const route = createRootRoute({ component: Harness });
const router = createRouter({ routeTree: route });
createRoot(document.getElementById("root")).render(<RouterProvider router={router} />);
`;
const bundled = await build({ stdin: { contents: entry, resolveDir: join(assembly, "apps/web"), sourcefile: "original-native-child-render.tsx", loader: "tsx" },
  plugins: [{ name: "unused-offline-diff-worker", setup(builder) {
    builder.onResolve({ filter: /\?worker$/ }, args => ({ path: args.path, namespace: "offline-unused-worker" }));
    builder.onLoad({ filter: /.*/, namespace: "offline-unused-worker" }, () => ({ contents: 'export default class OfflineUnusedDiffWorker { constructor() { throw new Error("Diff worker is outside command/reply fixture coverage"); } }', loader: "js" }));
  } }],
  bundle: true, write: false, platform: "browser", format: "esm", target: "es2022", jsx: "automatic",
  tsconfig: join(assembly, "apps/web/tsconfig.json"), define: { "import.meta.env": JSON.stringify({ APP_VERSION: "offline-render-test", VITE_AAA_NATIVE_READ: "1", VITE_AAA_PREVIEW: "0", MODE: "test", DEV: false, PROD: true }), "process.env.NODE_ENV": '"production"' },
  loader: { ".svg": "dataurl", ".woff2": "dataurl", ".wasm": "binary" }, logLevel: "silent" });
const script = bundled.outputFiles.find(file => file.path.endsWith(".js"))?.text ?? bundled.outputFiles[0]?.text;
assert.ok(script, "Original component bundle must exist");
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>';
const origin = "http://native-child-render.invalid";
const browser = await chromium.launch({ headless: true });
const records = [];
try {
  for (const [width, height] of [[319, 767], [1440, 900]]) {
    for (const [index, fixture] of fixtures.entries()) {
      const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
      const page = await context.newPage(), errors = [], blocked = [], served = [];
      page.on("pageerror", error => errors.push(String(error)));
      await page.addInitScript(() => {
        window.__offlineBlockedEffects = [];
        for (const name of ["WebSocket", "EventSource"]) window[name] = class {
          constructor() { window.__offlineBlockedEffects.push(name); throw new Error("Offline render blocks " + name); }
        };
        if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => { window.__offlineBlockedEffects.push("device"); return Promise.reject(new Error("Offline render blocks devices")); };
      });
      await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && route.request().method() === "GET") {
          const responses = { "/": ["text/html", html], "/bundle.js": ["text/javascript", script], "/style.css": ["text/css", `${baseStyles}\n${moduleStyles}`] };
          const response = responses[url.pathname];
          if (response) { served.push(url.pathname); return route.fulfill({ status: 200, contentType: response[0], body: response[1] }); }
        }
        blocked.push({ method: route.request().method(), path: url.pathname, origin: url.origin });
        return route.abort();
      });
      try {
        await page.goto(`${origin}/?child=${index}`, { waitUntil: "load" });
        await page.getByRole("button", { name: "Open original child", exact: true }).click();
        await page.locator("[data-assistant-citation-viewport]").waitFor({ timeout: 12_000 });
        await page.locator("[data-timeline-root]").last().waitFor({ state: "attached", timeout: 12_000 });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await page.evaluate(() => {
          const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          const container = document.querySelector(".aaa-native-child-timeline"), viewport = container.querySelector("[data-assistant-citation-viewport]");
          return { container: rect(container), viewport: rect(viewport), rows: [...viewport.querySelectorAll("[data-timeline-root]")].map(element => ({ ...rect(element), maxWidth: Number.parseFloat(getComputedStyle(element).maxWidth) })),
            text: viewport.textContent, containerDisplay: getComputedStyle(container).display,
            containerDirection: getComputedStyle(container).flexDirection, documentWidth: document.documentElement.scrollWidth, blockedEffects: window.__offlineBlockedEffects };
        });
        const label = `${fixture.child.title}-${width}`;
        const observation = { label, childId: fixture.child.nativeThreadId, geometry, errors, blocked, served };
        records.push(observation);
        await page.screenshot({ path: join(evidence, `${label}-detail.png`), fullPage: true });
        await writeFile(join(evidence, "geometry.json"), JSON.stringify({ offline_only: true, source_component: "NativeChildConversation + original MessagesTimeline", fixtures: "saved original readonly a/b trial records", module_styles_sha256: createHash("sha256").update(moduleStyles).digest("hex"), records }, null, 2) + "\n");
        assert.deepEqual(errors, [], "Original components must render without page errors");
        assert.deepEqual(geometry.blockedEffects, [], "Original render must not attempt sockets or devices");
        assert.ok(geometry.viewport.width >= geometry.container.width * 0.9,
          `${label}: timeline shrank to ${geometry.viewport.width}px inside ${geometry.container.width}px container`);
        assert.ok(geometry.viewport.height >= 120, `${label}: timeline has no usable height`);
        assert.ok(geometry.rows.every(row => row.width >= Math.min(geometry.container.width * 0.75, row.maxWidth * 0.9)), `${label}: original rows are visually clipped`);
        assert.ok(geometry.documentWidth <= width, `${label}: document overflows viewport`);
        const reply = fixture.nativeThread.turns.flatMap(turn => turn.items).find(item => item.type === "agentMessage").text;
        const replyText = reply.split("\n")[0].replaceAll("`", "");
        assert.ok(geometry.text.includes(replyText), `${label}: original final reply missing`);
        const replyNode = page.getByText(replyText, { exact: true }).first();
        await replyNode.scrollIntoViewIfNeeded();
        observation.replyGeometry = await replyNode.boundingBox();
        assert.ok(observation.replyGeometry && observation.replyGeometry.width > 120 && observation.replyGeometry.height > 5,
          `${label}: reply text exists in DOM but has no readable area`);
        await page.screenshot({ path: join(evidence, `${label}-reply.png`), fullPage: true });
        await page.getByRole("button", { name: /Worked for/ }).click();
        observation.afterWorkedText = await page.locator("[data-assistant-citation-viewport]").textContent();
        const command = fixture.nativeThread.turns.flatMap(turn => turn.items).find(item => item.type === "commandExecution");
        const commandRow = page.getByText(command.command, { exact: true }).first();
        await commandRow.waitFor({ timeout: 5_000 });
        const commandGeometry = await commandRow.boundingBox();
        assert.ok(commandGeometry && commandGeometry.width > 20 && commandGeometry.height > 5, `${label}: original command row invisible`);
        await commandRow.click();
        await page.waitForFunction(output => document.querySelector("[data-assistant-citation-viewport]").textContent.includes(output), command.aggregatedOutput, { timeout: 5_000 });
        observation.commandGeometry = commandGeometry;
        observation.exactCommandOutputVisible = true;
        await page.screenshot({ path: join(evidence, `${label}-command.png`), fullPage: true });
        await page.keyboard.press("Escape");
        await page.locator(".aaa-native-child-dialog").waitFor({ state: "detached" });
        observation.escapeClosed = true;
        assert.equal(await page.locator("#original-opener").evaluate(element => document.activeElement === element), true, `${label}: original opener focus not restored`);
        observation.openerFocusRestored = true;
      } finally { await context.close(); }
    }
  }
} finally {
  await browser.close();
  await writeFile(join(evidence, "geometry.json"), JSON.stringify({ offline_only: true, source_component: "NativeChildConversation + original MessagesTimeline", module_styles_sha256: createHash("sha256").update(moduleStyles).digest("hex"), records }, null, 2) + "\n");
}
console.log(JSON.stringify({ passed: records.length, no_network_sent: true, original_components: true }));
