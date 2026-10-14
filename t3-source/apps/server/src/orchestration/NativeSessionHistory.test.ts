import { describe, it, expect } from "vite-plus/test";
import { MessageId, TurnId, type OrchestrationMessage } from "@t3tools/contracts";
import { decodeCodexHistory, nativeVisibleText, planNativeHistory, type NativeHistory } from "./NativeSessionHistory.ts";
import { readDshHistoryChunk } from "../provider/Layers/DshNativeHistory.ts";
import type { DshSessionRpc } from "../provider/Layers/DshHostProtocol.ts";

const at = "2026-10-03T00:00:00.000Z", tid = TurnId.make("dsh:source-command");
const first: OrchestrationMessage[] = [
  { id: MessageId.make("original-user"), role: "user", text: "same", streaming: false, turnId: null, createdAt: at, updatedAt: at },
  { id: MessageId.make("assistant:dsh:sid:5"), role: "assistant", text: "reply", streaming: false, turnId: tid, createdAt: at, updatedAt: at },
];
const history: NativeHistory = { nativeId: "sid", cwd: "/fixture", observation: "ready", checkpoint: {}, complete: true, turns: [
  { id: "turn:1", state: "completed", startedAt: at, completedAt: at, messages: [
    { id: "dsh:sid:4", role: "user", text: "same", createdAt: at, sourceCommandId: "source-command" },
    { id: "dsh:sid:5", role: "assistant", text: "reply", createdAt: at },
  ] },
  { id: "turn:2", state: "completed", startedAt: at, completedAt: at, messages: [
    { id: "dsh:sid:10", role: "user", text: "same", createdAt: at, sourceCommandId: "external-command" },
    { id: "dsh:sid:11", role: "assistant", text: "reply", createdAt: at },
  ] },
] };
const saved = [{ turnId: tid, pendingMessageId: first[0]!.id, assistantMessageId: first[1]!.id }];

describe("native message identity and original records", () => {
  it("adopts original source-command user and assistant IDs while equal-text second turn remains distinct", () => {
    const plan = planNativeHistory(history, "dsh", saved, first);
    expect(plan.turns[0]?.turnId).toBe(tid);
    expect(plan.turns[0]?.userMessageId).toBe("original-user");
    expect(plan.turns[0]?.assistantMessageId).toBe(first[1]!.id);
    expect(plan.messages.some(m => m.id === "original-user")).toBe(false);
    expect(first[0]?.turnId).toBeNull();
    expect(plan.messages.filter(m => !first.some(x => x.id === m.id))).toHaveLength(2);
    expect(plan.turns[1]?.turnId).not.toBe(tid);
  });
  it("repeated read with saved aliases does not duplicate a single message", () => {
    const plan = planNativeHistory(history, "dsh", saved, first);
    const existing = [...first.filter(m => !plan.messages.some(u => u.id === m.id)), ...plan.messages];
    expect(planNativeHistory(history, "dsh", saved, existing, plan.aliases).messages).toEqual([]);
  });
  it("preserves the exact original input when the native transport includes different provider context", () => {
    const input = { ...first[0]!, text: "original input with attachment" };
    const plan = planNativeHistory(history, "dsh", saved, [input, first[1]!]);
    expect(plan.turns[0]?.userMessageId).toBe(input.id);
    expect(plan.messages.some(message => message.id === input.id)).toBe(false);
    expect(input.text).toBe("original input with attachment");
    expect(input.turnId).toBeNull();
  });
  it("rejects a mapped message owned by another turn", () => {
    expect(() => planNativeHistory(history, "dsh", saved, [first[0]!, { ...first[1]!, turnId: TurnId.make("other") }])).toThrow(/identity conflict/);
  });
  it("uses Codex native turn identity and preserves a failed pre-provider user", () => {
    const raw = { id: "native", cwd: "/fixture", createdAt: 1, updatedAt: 3, turns: [{ id: "native-turn", startedAt: 2, completedAt: 3, status: "completed", items: [
      { type: "userMessage", id: "native-user", content: [{ type: "text", text: "prompt" }] }, { type: "agentMessage", id: "native-assistant", text: "reply" },
    ] }] };
    const failed = { ...first[0]!, id: MessageId.make("failed-user"), text: "failed" };
    const original = { ...first[0]!, id: MessageId.make("success-user"), text: "prompt" };
    const plan = planNativeHistory(decodeCodexHistory(raw, "native", "/fixture"), "codex", [{ turnId: TurnId.make("native-turn"), pendingMessageId: original.id, assistantMessageId: null }], [failed, original]);
    expect(plan.turns[0]?.userMessageId).toBe("success-user");
    expect(plan.messages.some(m => m.id === "failed-user")).toBe(false);
    expect(failed.text).toBe("failed");
  });
  it("rejects wrong native ID/cwd and duplicate native item IDs", () => {
    const raw = { id: "native", cwd: "/fixture", createdAt: 1, updatedAt: 3, turns: [{ id: "t", status: "completed", items: [{ type: "agentMessage", id: "a", text: "x" }, { type: "agentMessage", id: "a", text: "x" }] }] };
    expect(() => decodeCodexHistory(raw, "other", "/fixture")).toThrow(/scope/);
    expect(() => decodeCodexHistory(raw, "native", "/other")).toThrow(/scope/);
    expect(() => decodeCodexHistory(raw, "native", "/fixture")).toThrow(/Duplicate/);
  });
  it("keeps visible attachment context without copying reasoning or private paths", () => {
    const value = nativeVisibleText([{ type: "text", text: "visible" }, { type: "reasoning", text: "private" }, { type: "image", path: "/secret" }]);
    expect(value).toContain("visible"); expect(value).toContain("原生附件"); expect(value).not.toContain("private"); expect(value).not.toContain("secret");
  });
  it("matches live assistant text after a tool call without losing attachments or weakening content checks", () => {
    const text = nativeVisibleText([
      { type: "text", text: "reply" },
      { type: "tool-call", id: "call", name: "exec", arguments: { command: "private tool arguments" } },
      { type: "reasoning", text: "private reasoning" },
    ]);
    expect(text).toBe("reply");
    const decoded = structuredClone(history);
    decoded.turns[0]!.messages[1]!.text = text;
    const plan = planNativeHistory(decoded, "dsh", saved, first);
    expect(plan.turns[0]?.assistantMessageId).toBe(first[1]!.id);
    expect(plan.messages.some(m => m.id === first[1]!.id)).toBe(false);
    const existing = [...first, ...plan.messages];
    expect(planNativeHistory(decoded, "dsh", saved, existing, plan.aliases).messages).toEqual([]);
    expect(nativeVisibleText([{ type: "image", path: "/private/image.png" }])).toContain("原生附件：image");
    decoded.turns[0]!.messages[1]!.text = "different actual reply";
    expect(() => planNativeHistory(decoded, "dsh", saved, first)).toThrow(/content conflicts/);
  });
  it("preserves an accepted terminal time when a later native read uses a thread-level fallback", () => {
    const accepted = "2026-10-03T00:00:01.123Z";
    const next = structuredClone(history);
    next.turns[0]!.completedAt = "2026-10-03T01:00:00.000Z";
    const plan = planNativeHistory(next, "dsh", [{ ...saved[0]!, state: "completed", completedAt: accepted }], first);
    expect(plan.turns[0]?.completedAt).toBe(accepted);
  });
});

describe("original App forwarded input", () => {
  it("imports only the exact named App envelope, retaining source/body and skipping unrelated tool results", () => {
    const source = "01a0759c-5c23-7f02-94a7-e9cbd4d54df3";
    const forwarded = { type: "functionCallOutput", id: "fco-original", namespace: "codex_app", name: "send_message_to_thread", output: `<codex_delegation>\n<source_thread_id>${source}</source_thread_id>\n<input>exact original body</input>\n</codex_delegation>` };
    const raw = { id: "native", cwd: "/fixture", createdAt: 1, updatedAt: 3, turns: [{ id: "app-turn", status: "completed", items: [
      { ...forwarded, id: "not-app", namespace: "other" }, { ...forwarded, id: "not-send", name: "read_thread" },
      { ...forwarded, id: "malformed", output: "private tool output" }, forwarded, { type: "agentMessage", id: "reply", text: "answer" },
    ] }] };
    const decoded = decodeCodexHistory(raw, "native", "/fixture");
    expect(decoded.turns[0]?.messages.map(m => m.id)).toEqual(["fco-original", "reply"]);
    expect(decoded.turns[0]?.messages[0]).toMatchObject({ role: "user", text: `[原生转发输入；来源会话：${source}]\nexact original body` });
    const plan = planNativeHistory(decoded, "codex", [], []);
    expect(plan.turns[0]?.userMessageId).toBe(plan.messages[0]?.id);
    expect(plan.messages).toHaveLength(2);
    expect(planNativeHistory(decoded, "codex", [], plan.messages, plan.aliases).messages).toHaveLength(0);
  });
});

describe("incremental DSH original history", () => {
  const events = Array.from({ length: 700 }, (_, seq) => ({ seq, time: 1_800_000_000_000 + seq, type: "developer/message", data: {} as any }));
  events[1] = { ...events[1]!, type: "turn/start", data: { turn: 1 } };
  events[2] = { ...events[2]!, type: "user/message", data: { id: "u", source: { kind: "user", rpcId: "source" }, role: "user", content: [{ type: "text", text: "human" }] } };
  events[650] = { ...events[650]!, type: "assistant/message", data: { turn: 1, message: { id: "a", role: "assistant", content: [{ type: "text", text: "answer" }] } } };
  events[699] = { ...events[699]!, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } };
  const makeRpc = (all = events): DshSessionRpc => ({ call: async (method, raw) => {
    if (method === "session/list") return { items: [{ sessionId: "sid", cwd: "/fixture", running: false, projections: { asOfSeq: all.at(-1)!.seq, values: { agentPreset: "preset", userQuestions: { active: [], settled: [] } } } }] };
    if (method !== "session/page") throw Error("write is forbidden");
    const q = (raw as any).request, end = Math.min(q.throughSeq, (q.beforeSeq ?? q.throughSeq + 1) - 1);
    return { records: all.filter(e => e.seq <= end && e.seq > end - 16).map(event => ({ type: "event", event })), hasMore: end >= 16 };
  } });
  it("continues past the old history size limit and carries the same active turn across batches", async () => {
    const rpc = makeRpc(); let checkpoint: unknown; const found: NativeHistory[] = [];
    for (let i = 0; i < 3; i++) { const part = await readDshHistoryChunk(rpc, "sid", "/fixture", "preset", checkpoint); found.push(part); checkpoint = part.checkpoint; }
    expect(found.map(h => h.checkpoint.afterSeq)).toEqual([255, 511, 699]);
    expect(found[0]?.complete).toBe(false); expect(found[2]?.complete).toBe(true);
    expect(found[2]?.turns[0]?.messages.map(m => m.text)).toEqual(["human", "answer"]);
    expect(found[2]?.turns[0]?.state).toBe("completed");
    const same = await readDshHistoryChunk(rpc, "sid", "/fixture", "preset", checkpoint);
    expect(same.turns).toEqual([]); expect(same.observation).toBe("ready");
  });
  it("rejects scope change and native sequence rollback", async () => {
    await expect(readDshHistoryChunk(makeRpc(), "sid", "/other", "preset")).rejects.toThrow(/scope/);
    await expect(readDshHistoryChunk(makeRpc(), "sid", "/fixture", "preset", { version: 2, afterSeq: 999 })).rejects.toThrow(/scope/);
  });
  it("rejects a missing event instead of clearing the prior checkpoint", async () => {
    await expect(readDshHistoryChunk(makeRpc(events.filter(e => e.seq !== 10)), "sid", "/fixture", "preset")).rejects.toThrow(/sequence/);
  });
});
