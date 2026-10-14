import { ProviderInstanceId } from "@t3tools/contracts";
import * as Assert from "node:assert/strict";
import { it } from "@effect/vitest";

import { DshTransportError, HttpDshSessionRpc, makeDshHostProtocol, type DshSessionRpc } from "./DshHostProtocol.ts";

const events = [
  { seq: 1, type: "turn/start", data: { turn: 7 } },
  { seq: 2, type: "user/message", data: { source: { kind: "user", rpcId: "request-1" } } },
  { seq: 3, type: "assistant/message", data: { turn: 7, message: { content: [{ type: "text", text: "private fixture" }] } } },
  { seq: 4, type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } },
];

it("maps supervised DSH to read-only with native ask approval and verifies effective knobs", async () => {
  let preset = "workspace-write", sandbox = preset, approval = "ask";
  const writes: string[] = [];
  const host = makeDshHostProtocol({ call: async (method, args) => {
    if (method === "permissionPresets/catalog") return { options: [{ value: "read-only" }, { value: "workspace-write" }, { value: "danger-full-access" }] };
    if (method === "session/list") return { items: [{ sessionId: "supervised", running: false, projections: { asOfSeq: 1, values: { permissions: { currentValue: preset } } } }] };
    if (method === "commands/execute") { const line = (args as { line: string }).line; writes.push(line); preset = line.slice("/permission ".length); sandbox = preset; return { result: { kind: "success" } }; }
    if (method === "session/page") return { hasMore: false, records: [{ type: "event", event: { seq: 0, type: "sandbox/mode", data: { mode: sandbox } } }, { type: "event", event: { seq: 1, type: "approval/policy", data: { policy: approval } } }] };
    throw Error("unexpected permission operation");
  } });
  await host.permission!("supervised", "approval-required");
  Assert.deepEqual(writes, ["/permission read-only"]);
  await host.permission!("supervised", "approval-required");
  Assert.equal(writes.length, 1);
  approval = "never";
  await Assert.rejects(host.permission!("supervised", "approval-required"));
  Assert.equal(writes.length, 1, "a preset name must not bypass native approval verification");
});

it("reads the exact native turn and keeps an old Host model capability closed", async () => {
  const calls: string[] = [];
  const rpc: DshSessionRpc = { call: async (method) => {
    calls.push(method);
    if (method === "session/list") return { items: [{ sessionId: "session-1", cwd: "/fixture/project", running: false,
      projections: { asOfSeq: 4, values: { agentPreset: "preset-1", userQuestions: { active: [], settled: [] } } } }] };
    if (method === "session/modelCatalog") return { groups: [], failures: [], routableProviders: [] };
    if (method === "session/page") return { records: events.map(event => ({ type: "event", event })), hasMore: false };
    if (method === "session/prompt") return { accepted: true };
    if (method === "session/create") return { sessionId: "session-1", agentPreset: "preset-1" };
    throw new Error("unexpected method");
  } };
  const host = makeDshHostProtocol(rpc);
  const description = await host.describe();
  Assert.equal(description.version, null);
  Assert.deepEqual(description.models, []);
  Assert.equal(await host.hasSession("session-1", "/fixture/project", "preset-1"), true);
  await host.create("session-1", "/fixture/project", "preset-1");
  await host.prompt("session-1", "request-1", "synthetic text");
  Assert.deepEqual(await host.observe("session-1", "request-1"), {
    status: "completed", nativeTurn: 7, terminalSeq: 4, messages: [{ seq: 3, text: "private fixture" }], approvals: [], questions: [], followUps: [],
  });
  Assert.ok(!JSON.stringify(description).includes("private fixture"));
  Assert.equal(calls.filter(call => call === "session/prompt").length, 1);
});

it("does not promote a broken or foreign native history to completion", async () => {
  const rpc = (source: typeof events): DshSessionRpc => ({ call: async (method) => {
    if (method === "session/list") return { items: [{ sessionId: "session-1", cwd: "/fixture/project", running: false,
      projections: { asOfSeq: 4, values: { agentPreset: "preset-1", userQuestions: { active: [], settled: [] } } } }] };
    if (method === "session/page") return { records: source.map(event => ({ type: "event", event })), hasMore: false };
    throw new Error("read only fixture");
  } });
  Assert.equal((await makeDshHostProtocol(rpc([events[0]!, events[2]!, events[3]!])).observe("session-1", "request-1")).status,
    "unknown");
  const foreign = [events[0]!, { seq: 2, type: "user/message", data: { source: { kind: "user", rpcId: "other" } } },
    { ...events[1]!, seq: 3 }, events[3]!];
  Assert.equal((await makeDshHostProtocol(rpc(foreign)).observe("session-1", "request-1")).status, "unknown");
});

it("restricts the launcher exchange to loopback and redacts transport errors", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (input: URL | Request, init?: RequestInit): Promise<Response> => {
    if (calls.length === 0) {
      calls.push("launcher");
      Assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 303, headers: { location: "/", "set-cookie": "sid=fixture-cookie; Path=/" } });
    }
    calls.push("rpc");
    Assert.equal(String(input), "http://127.0.0.1:12345/api/session/list");
    const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string };
    Assert.equal(request.method, "session/list");
    return new Response(JSON.stringify({ type: "server-response", rpcId: request.rpcId,
      result: { ok: true, value: { items: [] } } }), { status: 200 });
  }) as typeof fetch;
  const rpc = new HttpDshSessionRpc(async () => "http://127.0.0.1:12345/?token=fixture-secret", fakeFetch);
  Assert.deepEqual(await rpc.call("session/list", { _request: {} }), { items: [] });
  Assert.deepEqual(calls, ["launcher", "rpc"]);
  const hostile = new HttpDshSessionRpc(async () => "https://example.com/?token=fixture-secret", fakeFetch);
  await Assert.rejects(hostile.call("session/list", {}), (error: unknown) =>
    error instanceof DshTransportError && error.code === "authentication_required" && !error.message.includes("fixture-secret"));
  Assert.equal(calls.length, 2);
});

it("negotiates native scoped model selection and preserves exact provider/effort routes", async () => {
  let capability = true;
  const writes: object[] = [];
  const catalog = { default: { provider: "provider/a", model: "flash" }, routableProviders: ["provider/a"], failures: [],
    groups: [{ id: "provider/a", name: "Native provider", models: [{ id: "flash", name: "Native Flash",
      reasoning: { efforts: [{ id: "high", name: "High" }, { id: "off", name: "Off" }], defaultEffort: "high" } }] }] };
  const rpc: DshSessionRpc = { call: async (method, args) => {
    if (method === "session/list") return { items: [] };
    if (method === "session/modelCatalog") return { ...catalog, ...(capability ? { sessionModelSelectionVersion: 1 } : {}) };
    if (method === "session/selectModel") {
      writes.push(args);
      return { scope: "session", selected: { provider: "provider/a", model: "flash", reasoningEffort: "high" } };
    }
    throw Error("unexpected mutation");
  } };
  const host = makeDshHostProtocol(rpc), model = { instanceId: ProviderInstanceId.make("dsh"), model: "provider%2Fa/flash",
    options: [{ id: "reasoningEffort", value: "high" }] };
  const description = await host.describe();
  Assert.equal(description.models[0]?.slug, model.model);
  Assert.equal(description.models[0]?.name, "Native Flash");
  await host.selectModel("session-1", model);
  Assert.deepEqual(writes, [{ request: { sessionId: "session-1", provider: "provider/a", model: "flash", reasoningEffort: "high", scope: "session" } }]);
  await Assert.rejects(host.selectModel("session-1", { ...model, options: [] }));
  await Assert.rejects(host.selectModel("session-1", { ...model, options: [{ id: "reasoningEffort", value: "max" }] }));
  capability = false;
  Assert.deepEqual((await host.describe()).models, []);
  await Assert.rejects(host.selectModel("session-1", model));
  Assert.equal(writes.length, 1, "legacy Host never receives selectModel");
});

it("checks native preset without activation and pins only a new untitled session", async () => {
  let title: string | null = null;
  const writes: string[] = [];
  const rpc: DshSessionRpc = { call: async (method, args) => {
    if (method === "session/list") return { items: [{ sessionId: "session-1", cwd: "/fixture/project", running: false,
      projections: { asOfSeq: 0, values: { agentPreset: "preset-1", title } } }] };
    if (method === "session/rename") { writes.push(method); title = (args as { request: { title: string } }).request.title; return { title, seq: 1 }; }
    throw Error("unexpected operation");
  } };
  const host = makeDshHostProtocol(rpc);
  await Assert.rejects(host.hasSession("session-1", "/fixture/project", "other-preset"));
  Assert.equal(await host.hasSession("session-1", "/fixture/project", "preset-1"), true);
  await host.pinTitle("session-1"); await host.pinTitle("session-1");
  title = "User original title";
  await host.pinTitle("session-1");
  Assert.equal(title, "User original title");
  Assert.deepEqual(writes, ["session/rename"]);
});

it("excludes reasoning and other native turns from the visible reply", async () => {
  const native = [
    ...events.slice(0, 2),
    { seq: 3, type: "assistant/message", data: { turn: 7, message: { content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "visible" }] } } },
    events[3]!,
    { seq: 5, type: "turn/start", data: { turn: 8 } },
    { seq: 6, type: "user/message", data: { source: { kind: "user", rpcId: "different-request" } } },
    { seq: 7, type: "assistant/message", data: { turn: 8, message: { content: [{ type: "text", text: "foreign" }] } } },
    { seq: 8, type: "turn/end", data: { turn: 8, reason: { kind: "completed" } } },
  ];
  const host = makeDshHostProtocol({ call: async method => {
    if (method === "session/list") return { items: [{ sessionId: "session-1", running: false, projections: { asOfSeq: 8, values: { userQuestions: { active: [], settled: [] } } } }] };
    if (method === "session/page") return { records: native.map(event => ({ type: "event", event })), hasMore: false };
    throw Error("read only");
  } });
  Assert.deepEqual(await host.observe("session-1", "request-1"), { status: "completed", nativeTurn: 7, terminalSeq: 4, messages: [{ seq: 3, text: "visible" }], approvals: [], questions: [], followUps: [] });
});
