import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { readCompleteNativeThread } from "./CodexNativeChildRead.ts";

describe("original native readonly history", () => {
  it("reads only the original tail through the last synced turn and preserves chronological ordering", async () => {
    const calls: string[] = [];
    const client = { raw: { request: (method: string, params: any) => Effect.sync(() => {
      calls.push(method);
      if (method === "thread/read") return { thread: { id: "same", historyMode: "paginated" } };
      if (method !== "thread/turns/list" || params.sortDirection !== "desc") throw Error("Unexpected native operation");
      return { data: [{ id: "t3", items: [] }, { id: "t2", items: [] }, { id: "t1", items: [] }], nextCursor: "older" };
    }) } };
    const result: any = await Effect.runPromise(readCompleteNativeThread(client, "same", true, { afterTurnId: "t2" }));
    expect(result.turns.map((t: any) => t.id)).toEqual(["t2", "t3"]);
    expect(calls).toEqual(["thread/read", "thread/turns/list"]);
  });
  it("rejects a removed native checkpoint without resetting or mutating the original conversation", async () => {
    const client = { raw: { request: (method: string) => Effect.succeed(method === "thread/read" ? { thread: { id: "same", historyMode: "paginated" } } : { data: [{ id: "new", items: [] }], nextCursor: null }) } };
    await expect(Effect.runPromise(readCompleteNativeThread(client, "same", true, { afterTurnId: "gone" }))).rejects.toThrow(/checkpoint/);
  });
  it("takes every paginated turn and preserves user/tool/output/status fields without resume", async () => {
    const calls: { method: string; params: any }[] = [];
    const turns = [{ id: "t1", status: "completed", items: [{ type: "userMessage", id: "u1", content: [{ type: "text", text: "exact original task" }] }, { type: "commandExecution", id: "c1", command: "cat task-a.md", aggregatedOutput: "public fixture" }] }, { id: "t2", status: "interrupted", error: { message: "kept original error" }, items: [{ type: "agentMessage", id: "a2", text: "exact original reply", phase: "final_answer" }] }];
    const client = { raw: { request: (method: string, params: any) => Effect.sync(() => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { id: "child", parentThreadId: "parent", historyMode: "paginated", status: { type: "notLoaded" }, turns: [] } };
      if (method === "thread/turns/list") return params.cursor === null ? { data: [turns[0]], nextCursor: "next" } : { data: [turns[1]], nextCursor: null };
      throw Error("Mutation invoked");
    }) } };
    const result: any = await Effect.runPromise(readCompleteNativeThread(client, "child", true));
    expect(result.turns).toEqual(turns);
    expect(result.status.type).toBe("notLoaded");
    expect(calls.map(c => c.method)).toEqual(["thread/read", "thread/turns/list", "thread/turns/list"]);
    expect(calls[1]?.params).toEqual({ threadId: "child", cursor: null, limit: 100, sortDirection: "asc", itemsView: "full" });
  });
  it("legacy native full read preserves exact items", async () => {
    const full = { id: "child", source: "cli", turns: [{ id: "t1", status: "completed", items: [{ type: "agentMessage", id: "a", text: "all text" }] }] };
    const client = { raw: { request: (_: string, p: any) => Effect.succeed({ thread: p.includeTurns ? full : { id: "child", turns: [] } }) } };
    expect(await Effect.runPromise(readCompleteNativeThread(client, "child", true))).toEqual(full);
  });
  it("metadata reading does not fetch or load turns", async () => {
    const calls: string[] = [];
    const client = { raw: { request: (m: string) => Effect.sync(() => { calls.push(m); return { thread: { id: "child", turns: [] } }; }) } };
    await Effect.runPromise(readCompleteNativeThread(client, "child", false));
    expect(calls).toEqual(["thread/read"]);
  });
  it("repeated cursors fail instead of claiming a truncated history is complete", async () => {
    const client = { raw: { request: (m: string) => Effect.succeed(m === "thread/read" ? { thread: { id: "child", historyMode: "paginated" } } : { data: [], nextCursor: "same" }) } };
    await expect(Effect.runPromise(readCompleteNativeThread(client, "child", true))).rejects.toThrow("pagination cursor");
  });
  it("wrong native child identity is rejected", async () => {
    const client = { raw: { request: () => Effect.succeed({ thread: { id: "other", turns: [] } }) } };
    await expect(Effect.runPromise(readCompleteNativeThread(client, "child", true))).rejects.toThrow("identity mismatch");
  });
});
