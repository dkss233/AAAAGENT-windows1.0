import { describe, it, expect } from "vite-plus/test";
import { EventId, MessageId, ProjectId, ProviderInstanceId, ThreadId, TurnId, type OrchestrationThread, type OrchestrationEvent } from "@t3tools/contracts";
import { isThreadDetailEvent } from "../ws.ts";
import { applyThreadDetailEvent } from "../../../../packages/client-runtime/src/state/threadReducer.ts";

const at = "2026-10-03T00:00:00.000Z", threadId = ThreadId.make("detail-thread"), turnId = TurnId.make("native-turn");
const original: OrchestrationThread = {
  id: threadId, projectId: ProjectId.make("detail-project"), title: "Original", modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
  runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null, latestTurn: null,
  createdAt: at, updatedAt: at, archivedAt: null, settledOverride: "settled", settledAt: at, deletedAt: null,
  pullRequests: [], messages: [], proposedPlans: [], checkpoints: [], session: null,
  activities: [{ id: EventId.make("question"), turnId: null, tone: "info", kind: "user-input.requested", summary: "Pending", payload: { requestId: "original-question" }, createdAt: at }],
};
const message = { id: MessageId.make("native-user"), role: "user" as const, text: "external input", turnId, streaming: false, createdAt: at, updatedAt: at };
const latestTurn = { turnId, state: "running" as const, requestedAt: at, startedAt: at, completedAt: null, assistantMessageId: null };
const event: OrchestrationEvent = {
  type: "thread.native-session-synced", eventId: EventId.make("native-detail-event"), sequence: 4,
  aggregateKind: "thread", aggregateId: threadId, occurredAt: at, commandId: null, causationEventId: null, correlationId: null, metadata: {},
  payload: { threadId, nativeId: "original-native", provider: "codex", instanceId: ProviderInstanceId.make("codex"), expectedBinding: "fixture",
    previousVersion: null, syncVersion: "version-1", checkedAt: at, observation: "running", checkpoint: {}, messages: [message], turns: [{ ...latestTurn, userMessageId: message.id }], latestTurn },
};

describe("native detail subscription delivery", () => {
  it("passes the WS live/replay filter and updates the same formal client dialogue without starting a provider session", () => {
    expect(isThreadDetailEvent(event)).toBe(true);
    const result = applyThreadDetailEvent(original, event);
    expect(result.kind).toBe("updated");
    if (result.kind !== "updated") throw Error("Native detail event lost");
    expect(result.thread.id).toBe(threadId); expect(result.thread.messages.map(m => m.text)).toEqual(["external input"]);
    expect(result.thread.latestTurn?.state).toBe("running"); expect(result.thread.session).toBeNull();
    expect(result.thread.nativeSessionObservation?.status).toBe("running");
    expect(result.thread.settledOverride).toBeNull(); expect(result.thread.activities[0]).toEqual(original.activities[0]);
    const repeated = applyThreadDetailEvent(result.thread, event);
    expect(repeated.kind === "updated" && repeated.thread.messages).toHaveLength(1);
  });
  it("keeps already synchronized messages and pending questions when native history is temporarily unavailable", () => {
    const first = applyThreadDetailEvent(original, event);
    if (first.kind !== "updated") throw Error("Missing first event");
    const unavailable: OrchestrationEvent = { ...event, payload: { ...event.payload, previousVersion: "version-1", syncVersion: "unknown-2", observation: "unknown", messages: [], turns: [], latestTurn: null } };
    const result = applyThreadDetailEvent(first.thread, unavailable);
    if (result.kind !== "updated") throw Error("Missing unavailable event");
    expect(result.thread.messages).toHaveLength(1); expect(result.thread.latestTurn?.state).toBe("running");
    expect(result.thread.nativeSessionObservation?.status).toBe("unknown");
    expect(result.thread.activities.some(a => a.id === "question")).toBe(true);
    expect(result.thread.activities.filter(a => a.kind === "native.session.sync")).toHaveLength(1);
  });
});
