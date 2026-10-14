import * as Assert from "node:assert/strict";
import { CommandId, ProviderInstanceId, ThreadId, type ProviderRuntimeEvent, type ProviderSessionStartInput } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { DshDriver } from "../Drivers/DshDriver.ts";
import { DshHostService, makeDshAdapter, type DshHostPort } from "./DshAdapter.ts";

const instanceId = ProviderInstanceId.make("dsh-fixture");
const threadId = ThreadId.make("fixture-thread");
const start: ProviderSessionStartInput = { threadId, cwd: "/fixture/project", runtimeMode: "approval-required" };
const modelSelection = { instanceId, model: "deepseek-official/deepseek-flash", options: [{ id: "reasoningEffort", value: "high" }] };
const input = { threadId, sourceCommandId: CommandId.make("fixture-command"), input: "synthetic", modelSelection };
function fixture() {
  const created: string[] = [], prompts: string[] = [], selected: string[] = [], titles: string[] = [];
  const host: DshHostPort = {
    describe: async () => ({ installed: true, authenticated: true, version: "fixture", models: [] }),
    hasSession: async (id, cwd, preset) => {
      Assert.equal(cwd, start.cwd); Assert.equal(preset, "fixture-preset"); return created.includes(id);
    },
    create: async id => { created.push(id); },
    selectModel: async (id, selection) => { Assert.deepEqual(selection, modelSelection); selected.push(id); },
    pinTitle: async id => { titles.push(id); },
    prompt: async (_id, requestId) => { prompts.push(requestId); },
    observe: async () => ({ status: "completed", nativeTurn: 7, terminalSeq: 4, messages: [{ seq: 3, text: "FIXTURE_OK" }] }),
  };
  const adapter = () => Effect.runPromise(makeDshAdapter({ instanceId, environmentId: "fixture-env", preset: "fixture-preset", host }));
  return { host, adapter, created, prompts, selected, titles };
}

it("binds one native session and requires explicit model and stable command identity", async () => {
  const f = fixture(), adapter = await f.adapter();
  const session = await Effect.runPromise(adapter.startSession(start));
  Assert.match((session.resumeCursor as { sessionId: string }).sessionId, /^t3_[a-f0-9]{40}$/);
  await Assert.rejects(Effect.runPromise(adapter.sendTurn({ threadId, input: "synthetic" })));
  await Assert.rejects(Effect.runPromise(adapter.sendTurn({ ...input, modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("other") } })));
  Assert.deepEqual(f.prompts, []);
  const first = await Effect.runPromise(adapter.sendTurn(input));
  const second = await Effect.runPromise(adapter.sendTurn(input));
  Assert.equal(first.turnId, second.turnId);
  Assert.deepEqual(f.prompts, ["fixture-command"]);
  Assert.equal(f.selected.length, 1);
  await Effect.runPromise(adapter.stopAll());
});

it("rejects a foreign resume cursor before any Host operation", async () => {
  const f = fixture();
  f.host.hasSession = async () => { throw Error("unexpected Host read"); };
  const adapter = await f.adapter();
  await Assert.rejects(Effect.runPromise(adapter.startSession({ ...start, resumeCursor: { sessionId: "t3_other" } })));
  Assert.deepEqual(f.created, []);
});

it("keeps a lost prompt response unknown without repeating it", async () => {
  const f = fixture();
  f.host.prompt = async (_id, request) => { f.prompts.push(request); throw Error("lost reply"); };
  f.host.observe = async () => ({ status: "unknown" });
  const adapter = await f.adapter();
  await Effect.runPromise(adapter.startSession(start));
  await Assert.rejects(Effect.runPromise(adapter.sendTurn(input)));
  await Assert.rejects(Effect.runPromise(adapter.sendTurn(input)));
  Assert.deepEqual(f.prompts, ["fixture-command"]);
  const pending = (await Effect.runPromise(adapter.listSessions()))[0]!.resumeCursor;
  Assert.equal((pending as { requestId: string }).requestId, input.sourceCommandId);
  await Effect.runPromise(adapter.stopAll());
  const restored = await f.adapter();
  await Effect.runPromise(restored.startSession({ ...start, resumeCursor: pending }));
  await Assert.rejects(Effect.runPromise(restored.sendTurn(input)));
  Assert.deepEqual(f.prompts, ["fixture-command"]);
  await Effect.runPromise(restored.stopAll());
});

it("restores the exact existing turn with read-only Host operations", async () => {
  const f = fixture(), adapter = await f.adapter();
  await Effect.runPromise(adapter.startSession(start));
  const sent = await Effect.runPromise(adapter.sendTurn(input));
  await Effect.runPromise(adapter.stopAll());
  const before = { created: f.created.length, selected: f.selected.length, titles: f.titles.length, prompts: f.prompts.length };
  const restored = await f.adapter();
  await Effect.runPromise(restored.startSession({ ...start, resumeCursor: sent.resumeCursor }));
  Assert.equal((await Effect.runPromise(restored.readThread(threadId))).turns[0]?.id, sent.turnId);
  Assert.deepEqual({ created: f.created.length, selected: f.selected.length, titles: f.titles.length, prompts: f.prompts.length }, before);
  await Assert.rejects(Effect.runPromise(restored.sendTurn({ ...input, input: "changed text" })));
  f.host.observe = async () => ({ status: "unknown" });
  await Assert.rejects(Effect.runPromise(restored.sendTurn(input)));
  Assert.equal(f.prompts.length, 1);
  await Effect.runPromise(restored.stopAll());
});

it("emits native assistant text before terminal state with stable IDs after restart", async () => {
  const f = fixture();
  const run = async (resumeCursor?: unknown) => {
    const adapter = await f.adapter(), received: ProviderRuntimeEvent[] = [];
    const reader = Effect.runPromise(Stream.runForEach(adapter.streamEvents.pipe(Stream.takeUntil(event => event.type === "turn.completed")), event => Effect.sync(() => { received.push(event); })).pipe(Effect.timeout("3 seconds")));
    await Effect.runPromise(adapter.startSession({ ...start, ...(resumeCursor ? { resumeCursor } : {}) }));
    const sent = resumeCursor ? { resumeCursor } : await Effect.runPromise(adapter.sendTurn(input));
    await reader;
    await Effect.runPromise(adapter.stopAll());
    const message = received.find(e => e.type === "item.completed");
    Assert.ok(message && message.type === "item.completed");
    Assert.equal(message.payload.detail, "FIXTURE_OK");
    Assert.ok(received.indexOf(message) < received.findIndex(e => e.type === "turn.completed"));
    return { sent, message };
  };
  const first = await run(), second = await run(first.sent.resumeCursor);
  Assert.equal(first.message.eventId, second.message.eventId);
  Assert.equal(first.message.itemId, second.message.itemId);
  Assert.equal(f.prompts.length, 1);
});

it("rejects dispatch when session-only model selection is unavailable", async () => {
  const f = fixture(); f.host.selectModel = async () => { throw Error("native capability missing"); };
  const adapter = await f.adapter(); await Effect.runPromise(adapter.startSession(start));
  await Assert.rejects(Effect.runPromise(adapter.sendTurn(input)));
  Assert.deepEqual(f.prompts, []);
  await Effect.runPromise(adapter.stopAll());
});

it("driver exposes only native verified models and keeps auxiliary generation disabled", async () => {
  const f = fixture();
  const instance = await Effect.runPromise(DshDriver.create({
    instanceId, displayName: undefined, environment: [], enabled: true, config: { agentPreset: "fixture-preset" },
  }).pipe(Effect.provideService(DshHostService, { environmentId: "fixture-env", port: f.host }), Effect.scoped));
  const snapshot = await Effect.runPromise(instance.snapshot.getSnapshot);
  Assert.equal(snapshot.status, "warning"); Assert.deepEqual(snapshot.models, []);
  Assert.equal(snapshot.supportsTextGeneration, false);
  await Assert.rejects(Effect.runPromise(instance.textGeneration.generateThreadTitle({ cwd: start.cwd!, message: "synthetic", modelSelection })));
});

it("reads an owned native turn once at opening and only again on its original notification", async () => {
  const f = fixture(); let reads = 0, completed = false, changed: (() => void) | undefined, closed = 0;
  f.host.watchTurn = async (sessionId, cwd, notify) => {
    Assert.equal(sessionId, f.created[0]); Assert.equal(cwd, start.cwd); changed = notify;
    return () => { closed++; changed = undefined; };
  };
  f.host.observe = async () => { reads++; return completed ? { status: "completed", nativeTurn: 7, terminalSeq: 4, messages: [{ seq: 3, text: "FIXTURE_OK" }] } : { status: "running", nativeTurn: 7, messages: [] }; };
  const adapter = await f.adapter(), received: ProviderRuntimeEvent[] = [];
  await Effect.runPromise(adapter.startSession(start));
  const reader = Effect.runPromise(Stream.runForEach(adapter.streamEvents.pipe(Stream.takeUntil(event => event.type === "turn.completed")), event => Effect.sync(() => { received.push(event); })).pipe(Effect.timeout("6 seconds")));
  try {
    await Effect.runPromise(adapter.sendTurn(input));
    await Effect.runPromise(Effect.sleep("2300 millis"));
    Assert.equal(reads, 1, "an idle live source must not be polled every two seconds");
    Assert.ok(changed); completed = true; changed(); changed();
    await reader;
    Assert.equal(reads, 2); Assert.equal(received.filter(event => event.type === "item.completed").length, 1);
    Assert.equal(received.filter(event => event.type === "turn.completed").length, 1); Assert.equal(closed, 1);
  } finally { await Effect.runPromise(adapter.stopAll()); }
});
