import { createHash } from "node:crypto";
import {
  EventId, RuntimeRequestId, ProviderDriverKind, ProviderInstanceId, ThreadId, TurnId, RuntimeItemId,
  type ModelSelection, type ChatAttachment, type RuntimeMode,
  type ProviderRuntimeEvent, type ProviderSession, type ServerProviderModel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError, ProviderAdapterValidationError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { NativeRealtimeQueue } from "../../orchestration/NativeRealtimeQueue.ts";
import { readDshAttachments, dshInputDigest } from "./DshWebInput.ts";

const DRIVER = ProviderDriverKind.make("dsh");
const nativeId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const now = Effect.map(DateTime.now, DateTime.formatIso);

export interface DshTurnObservation {
  readonly status: "unknown" | "queued" | "running" | "waiting_approval" | "waiting_answer" | "completed" | "failed" | "cancelled";
  readonly nativeTurn?: number;
  readonly terminalSeq?: number;
  readonly approvals?: readonly { id: string; toolName: string; callId?: string; reason?: string; outcome?: string; actionable?: boolean }[];
  readonly questions?: readonly { callId: string; state: "open" | "continued";
    questions: readonly { id: string; question: string; detail?: string; header?: string; options?: readonly { label: string; description?: string }[]; multiSelect?: boolean }[] }[];
  readonly messages?: readonly { readonly seq: number; readonly text: string }[];
}

/** Host methods use the fixed DSH 0.2.0-rc.2 Gateway. */
export interface DshHostPort {
  /** I supplies this from the protected launcher and native model catalog. */
  readonly attachmentsDir?: string;
  discoverHistory?(): Promise<readonly import("./DshHistoryDiscovery.ts").DshHistorySource[]>;
  watchHistory?(sessionId: string, cwd: string, changed: () => void): Promise<() => void>;
  watchTurn?(sessionId: string, cwd: string, changed: () => void): Promise<() => void>;
  retain?(sessionId: string): Promise<void>;
  release?(sessionId: string): void;
  permission?(sessionId: string, mode: RuntimeMode): Promise<void>;
  interrupt?(sessionId: string, requestId: string): Promise<void>;
  approve?(sessionId: string, requestId: string, auditId: string, decision: string): Promise<void>;
  answer?(sessionId: string, requestId: string, callId: string, answers: Record<string, unknown>): Promise<void>;
  describe(): Promise<{ readonly installed: boolean; readonly authenticated: boolean;
    readonly version: string | null; readonly models: readonly ServerProviderModel[] }>;
  readHistory?(sessionId: string, cwd: string, preset: string, checkpoint?: unknown): Promise<unknown>;
  create(sessionId: string, cwd: string, preset: string): Promise<void>;
  /** Cold read only; no Agent activation. */
  hasSession(sessionId: string, cwd: string, preset: string): Promise<boolean>;
  selectModel(sessionId: string, selection: ModelSelection): Promise<void>;
  pinTitle(sessionId: string): Promise<void>;
  /** Uses exactly the T3 command ID as Host requestId. */
  prompt(sessionId: string, requestId: string, text: string, files?: ReturnType<typeof readDshAttachments>): Promise<void>;
  observe(sessionId: string, requestId: string): Promise<DshTurnObservation & {
    /** Native user-question-reply lineage, never another prompt or session. */
    readonly followUps?: readonly (DshTurnObservation & { readonly callId: string; readonly nativeTurn: number })[];
  }>;
}

/** I supplies one scoped, authenticated Host implementation. No URL or cookie enters provider settings. */
export class DshHostService extends Context.Service<DshHostService, {
  readonly environmentId: string;
  readonly port: DshHostPort;
}>()("t3/provider/Layers/DshAdapter/DshHostService") {}

export interface DshAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environmentId: string;
  readonly preset: string;
  readonly host: DshHostPort;
}

const sessionIdFor = (environmentId: string, threadId: ThreadId) => {
  // A deterministic ID avoids creating another session after a lost create response.
  return `t3_${createHash("sha256").update(JSON.stringify([environmentId, threadId])).digest("hex").slice(0, 40)}`;
};

const cursor = (value: unknown): { sessionId: string; requestId?: string; messageDigest?: string } | null => {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { sessionId?: unknown; requestId?: unknown; messageDigest?: unknown };
  if (typeof candidate.sessionId !== "string" || !nativeId(candidate.sessionId) ||
      candidate.requestId !== undefined && (typeof candidate.requestId !== "string" || !nativeId(candidate.requestId)) ||
      candidate.messageDigest !== undefined && (typeof candidate.messageDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(candidate.messageDigest) || candidate.requestId === undefined)) return null;
  return { sessionId: candidate.sessionId,
    ...(typeof candidate.requestId === "string" ? { requestId: candidate.requestId } : {}),
    ...(typeof candidate.messageDigest === "string" ? { messageDigest: candidate.messageDigest } : {}) };
};

/** Saved by the existing ProviderSessionDirectory before any native side effect. */
export function dshPendingPromptCursor(resumeCursor: unknown, requestId: string | undefined, text: string | undefined, attachments: readonly ChatAttachment[] = [], attachmentsDir?: string) {
  const saved = cursor(resumeCursor);
  if (!saved || !requestId || !nativeId(requestId) || (!text?.trim() && !attachments.length)) return null;
  let messageDigest: string;
  try { messageDigest = dshInputDigest(saved.sessionId, requestId, text ?? "", readDshAttachments(attachmentsDir, attachments)); } catch { return null; }
  if (saved.requestId === requestId && saved.messageDigest !== messageDigest) return null;
  return { sessionId: saved.sessionId, requestId, messageDigest };
}

export const makeDshAdapter = Effect.fn("makeDshAdapter")(function* (options: DshAdapterOptions) {
  const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, ProviderSession>();
  const requests = new Map<ThreadId, Map<string, TurnId>>();
  const attempted = new Map<ThreadId, Set<string>>();
  const monitoring = new Set<string>();
  // Retain emitted identities across rebinding/runtime-mode changes in this adapter.
  // Re-observing an older terminal must never consume the next pending source input.
  const monitorStates = new Map<string, { started: Set<TurnId>; terminalEmitted: Set<TurnId>; waiting: Map<TurnId, string>; emittedMessages: Set<number>; opened: Set<string>; resolved: Set<string> }>();
  const pendingResponses = new Map<string, { sessionId: string; requestId: string; turnId: TurnId; nativeId: string; kind: "approval" | "question" }>();
  const monitorStops = new Map<string, () => void>();

  const error = (method: string, detail: string): ProviderAdapterError => new ProviderAdapterRequestError({
    provider: DRIVER, method, detail,
  });
  const remote = <A>(method: string, action: () => Promise<A>) => Effect.tryPromise({
    try: action,
    catch: () => error(method, "DSH Host operation unavailable; inspect the original session"),
  });
  const emit = (event: ProviderRuntimeEvent) => Queue.offer(events, event).pipe(Effect.asVoid);
  const base = (threadId: ThreadId, eventId: string, createdAt: string, turnId?: TurnId) => ({
    eventId: EventId.make(eventId), provider: DRIVER, providerInstanceId: options.instanceId,
    threadId, createdAt, ...(turnId === undefined ? {} : { turnId }),
  });

  const monitor = (threadId: ThreadId, sessionId: string, requestId: string, rootTurnId: TurnId) =>
    Effect.gen(function* () {
      const key = `${threadId}:${requestId}`;
      if (monitoring.has(key)) return;
      monitoring.add(key);
      const state = monitorStates.get(key) ?? { started: new Set<TurnId>(), terminalEmitted: new Set<TurnId>(), waiting: new Map<TurnId, string>(), emittedMessages: new Set<number>(), opened: new Set<string>(), resolved: new Set<string>() };
      monitorStates.set(key, state);
      const { started, terminalEmitted, waiting, emittedMessages, opened, resolved } = state;
      const notifications = new NativeRealtimeQueue<number>();
      let closeWatch: (() => void) | undefined;
      const stop = () => { notifications.close(); closeWatch?.(); };
      monitorStops.set(key, stop);
      try {
        const cwd = sessions.get(threadId)?.cwd;
        if (options.host.watchTurn && cwd) closeWatch = yield* remote("session/watch", () => options.host.watchTurn!(sessionId, cwd, () => notifications.mark(0)));
        notifications.mark(0); // One opening reconciliation, then original notifications only.
        while (sessions.has(threadId)) {
          if ((yield* Effect.promise(signal => notifications.take(signal))) === undefined) return;
          const snapshot = yield* remote("session/page", () => options.host.observe(sessionId, requestId))
            .pipe(Effect.orElseSucceed((): Awaited<ReturnType<DshHostPort["observe"]>> => ({ status: "unknown" })));
          if (!sessions.has(threadId)) return;
          const turns = [snapshot, ...(snapshot.followUps ?? [])], liveQuestions = new Set<string>();
          for (const observed of turns) {
            const turnId = "callId" in observed ? TurnId.make(`dsh:${sessionId}:question:${observed.callId}:${observed.nativeTurn}`) : rootTurnId;
          if (observed.status === "running" || observed.status.startsWith("waiting_") ||
              observed.status === "completed" || observed.status === "failed" || observed.status === "cancelled") {
            if (!started.has(turnId)) {
              yield* emit({ ...base(threadId, `${turnId}:started`, yield* now, turnId),
                type: "turn.started", payload: {} });
              started.add(turnId);
            }
            if (["running", "waiting_approval", "waiting_answer"].includes(observed.status)) {
              const session = sessions.get(threadId);
              if (session && cursor(session.resumeCursor)?.requestId === requestId)
                sessions.set(threadId, { ...session, activeTurnId: turnId, status: "running", updatedAt: yield* now });
            }
          }
          if ("messages" in observed && observed.nativeTurn !== undefined) {
            for (const message of observed.messages ?? []) {
              if (emittedMessages.has(message.seq)) continue;
              yield* emit({ ...base(threadId, `dsh:${sessionId}:${message.seq}:message`, yield* now, turnId),
                type: "item.completed", itemId: RuntimeItemId.make(`dsh:${sessionId}:${message.seq}`),
                payload: { itemType: "assistant_message", status: "completed", detail: message.text } });
              emittedMessages.add(message.seq);
            }
          }
          for (const approval of observed.approvals ?? []) {
            const requestKey = `dsh:${sessionId}:${approval.id}`;
            if (approval.actionable && !opened.has(requestKey)) {
              pendingResponses.set(requestKey, { sessionId, requestId, turnId, nativeId: approval.id, kind: "approval" });
              yield* emit({ ...base(threadId, requestKey + ":opened", yield* now, turnId),
                requestId: RuntimeRequestId.make(requestKey), type: "request.opened", payload: {
                  requestType: "permission_approval", detail: approval.reason ?? approval.toolName,
                  options: [{ decision: "accept", label: "允许一次" }, { decision: "decline", label: "拒绝" }],
                  args: { toolName: approval.toolName, ...(approval.callId ? { callId: approval.callId } : {}) } } });
              opened.add(requestKey);
            }
            if (approval.outcome && opened.has(requestKey) && !resolved.has(requestKey)) {
              yield* emit({ ...base(threadId, requestKey + ":resolved", yield* now, turnId),
                requestId: RuntimeRequestId.make(requestKey), type: "request.resolved", payload: {
                  requestType: "permission_approval", decision: approval.outcome === "allowed-once" ? "accept" : "decline",
                  resolution: { nativeOutcome: approval.outcome } } });
              pendingResponses.delete(requestKey); resolved.add(requestKey);
            }
          }
          for (const question of observed.questions ?? []) {
            const requestKey = `dsh:${sessionId}:question:${question.callId}`; liveQuestions.add(requestKey);
            if (!opened.has(requestKey)) {
              pendingResponses.set(requestKey, { sessionId, requestId, turnId, nativeId: question.callId, kind: "question" });
              yield* emit({ ...base(threadId, requestKey + ":opened", yield* now, turnId),
                requestId: RuntimeRequestId.make(requestKey), type: "user-input.requested", payload: {
                  questions: question.questions.map(item => ({ id: item.id, header: item.header ?? "请回答",
                    question: item.detail ? `${item.question}\n${item.detail}` : item.question, options: (item.options ?? []).map(option => ({ label: option.label,
                      description: option.description ?? "" })), allowCustomAnswer: true, multiSelect: item.multiSelect ?? false })) } });
              opened.add(requestKey);
            }
          }
          if (observed.status === "waiting_approval" || observed.status === "waiting_answer") {
            if (waiting.get(turnId) !== observed.status) {
              yield* emit({ ...base(threadId, `${turnId}:${observed.status}`, yield* now, turnId),
                type: "session.state.changed", payload: { state: "waiting",
                  reason: observed.status === "waiting_approval" ? "Approval pending in original DSH Host" :
                    "Question pending in original DSH Host" } });
              waiting.set(turnId, observed.status);
            }
          }
          if (observed.status === "completed" || observed.status === "failed" || observed.status === "cancelled") {
            if (observed.nativeTurn === undefined || observed.terminalSeq === undefined) continue;
            if (!terminalEmitted.has(turnId)) yield* emit({ ...base(threadId, `dsh:${sessionId}:${observed.terminalSeq}`, yield* now, turnId),
              type: "turn.completed", payload: { state: observed.status } });
            terminalEmitted.add(turnId);
            const session = sessions.get(threadId);
            if (session && session.activeTurnId === turnId) {
              const { activeTurnId: _activeTurnId, ...settled } = session;
              sessions.set(threadId, { ...settled, status: "ready", updatedAt: yield* now });
            }
          }
          }
          for (const [requestKey, response] of pendingResponses) {
            if (response.kind === "question" && response.sessionId === sessionId && response.requestId === requestId &&
                turns.every(turn => turn.questions !== undefined) && opened.has(requestKey) && !liveQuestions.has(requestKey) && !resolved.has(requestKey)) {
              yield* emit({ ...base(threadId, requestKey + ":resolved", yield* now, response.turnId),
                requestId: RuntimeRequestId.make(requestKey), type: "user-input.resolved", payload: { answers: {} } });
              pendingResponses.delete(requestKey); resolved.add(requestKey);
            }
          }
          if (turns.every(turn => ["completed", "failed", "cancelled"].includes(turn.status) && turn.terminalSeq !== undefined) && !liveQuestions.size) return;
        }
      } finally { stop(); monitorStops.delete(key); monitoring.delete(key); }
    }).pipe(Effect.forkDetach, Effect.asVoid);

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
    Effect.gen(function* () {
      if (!input.cwd) return yield* new ProviderAdapterValidationError({ provider: DRIVER,
        operation: "startSession", issue: "DSH requires an explicit workspace path" });
      const resumed = input.resumeCursor === undefined ? null : cursor(input.resumeCursor);
      if (input.resumeCursor !== undefined && !resumed) return yield* error("startSession", "Invalid DSH resume cursor");
      const expectedSessionId = sessionIdFor(options.environmentId, input.threadId);
      if (resumed && resumed.sessionId !== expectedSessionId)
        return yield* error("startSession", "DSH resume cursor belongs to another T3 thread");
      const sessionId = expectedSessionId;
      if (!nativeId(sessionId)) return yield* error("startSession", "Invalid DSH session ID");
      const exists = yield* remote("session/list", () => options.host.hasSession(sessionId, input.cwd!, options.preset));
      if (resumed && !exists) return yield* error("startSession", "Original DSH session missing; no new session was created");
      if (!exists) {
        yield* remote("session/create", () => options.host.create(sessionId, input.cwd!, options.preset));
        yield* remote("session/rename", () => options.host.pinTitle(sessionId));
      }
      if (options.host.retain) yield* remote("$events", () => options.host.retain!(sessionId));
      if (options.host.permission) yield* remote("commands/execute", () => options.host.permission!(sessionId, input.runtimeMode)).pipe(
        Effect.tapError(() => Effect.sync(() => options.host.release?.(sessionId))),
      );
      const timestamp = yield* now;
      const session: ProviderSession = { provider: DRIVER, providerInstanceId: options.instanceId,
        threadId: input.threadId, status: "ready", runtimeMode: input.runtimeMode, cwd: input.cwd,
        ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
        resumeCursor: resumed ?? { sessionId }, createdAt: timestamp, updatedAt: timestamp };
      sessions.set(input.threadId, session);
      yield* emit({ ...base(input.threadId, `dsh:${sessionId}:session-started`, yield* now),
        type: "session.started", payload: { resume: { sessionId } } });
      if (resumed?.requestId) {
        const turnId = TurnId.make(`dsh:${resumed.requestId}`);
        requests.set(input.threadId, new Map([[resumed.requestId, turnId]]));
        attempted.set(input.threadId, new Set([resumed.requestId]));
        yield* monitor(input.threadId, sessionId, resumed.requestId, turnId);
      }
      return session;
    });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const session = sessions.get(input.threadId);
      const saved = cursor(session?.resumeCursor);
      if (!saved) return yield* error("sendTurn", "Original DSH session unavailable");
      if (!options.preset.trim()) return yield* error("sendTurn", "DSH agent preset is not configured");
      if (!input.modelSelection || input.modelSelection.instanceId !== options.instanceId) {
        return yield* error("sendTurn", "Explicit native DSH model and reasoning selection required");
      }
      if (!input.sourceCommandId || !nativeId(String(input.sourceCommandId)) || (!input.input?.trim() && !input.attachments?.length)) return yield* new ProviderAdapterValidationError({ provider: DRIVER,
            operation: "sendTurn", issue: "Stable command ID and valid text or attachments are required" });
      const requestId = String(input.sourceCommandId);
      const turnId = TurnId.make(`dsh:${requestId}`);
      const files = yield* Effect.try({ try: () => readDshAttachments(options.host.attachmentsDir, input.attachments ?? []),
        catch: () => error("sendTurn", "Original attachment content unavailable") });
      const digest = dshInputDigest(saved.sessionId, requestId, input.input ?? "", files);
      if (saved.requestId === requestId && saved.messageDigest !== digest) {
        return yield* error("sendTurn", "Restored command text cannot be verified; no retry was sent");
      }
      // Also retain the pending identity in memory so a graceful shutdown cannot overwrite
      // the ProviderSessionDirectory's pre-send claim with the previous cursor.
      sessions.set(input.threadId, { ...session!, resumeCursor: {
        sessionId: saved.sessionId, requestId, messageDigest: digest,
      } });
      const readback = () => remote("session/page", () => options.host.observe(saved.sessionId, requestId)).pipe(
        Effect.map((observed) => observed.status !== "unknown"),
        Effect.orElseSucceed(() => false),
      );
      if (requests.get(input.threadId)?.has(requestId) && !(yield* readback())) {
        return yield* error("sendTurn", "Prompt receipt unknown; no retry was sent");
      }
      if (!requests.get(input.threadId)?.has(requestId)) {
        const attemptSet = attempted.get(input.threadId) ?? new Set<string>();
        const priorAttempt = attemptSet.has(requestId);
        attemptSet.add(requestId);
        attempted.set(input.threadId, attemptSet);
        if (!priorAttempt) {
          const exists = yield* remote("session/list", () => options.host.hasSession(saved.sessionId, session!.cwd!, options.preset));
          if (!exists) return yield* error("sendTurn", "Original DSH session missing");
          yield* remote("session/selectModel", () => options.host.selectModel(saved.sessionId, input.modelSelection!));
          // Explicit title prevents the native Host from starting a separate title-model request.
          yield* remote("session/rename", () => options.host.pinTitle(saved.sessionId));
        }
        const accepted = priorAttempt ? yield* readback()
          : yield* remote("session/prompt", () => options.host.prompt(saved.sessionId, requestId, input.input ?? "", files)).pipe(
              Effect.matchEffect({ onSuccess: () => Effect.succeed(true), onFailure: readback }),
            );
        if (!accepted) return yield* error("sendTurn", "Prompt receipt unknown; no retry was sent");
      }
      const nextCursor = { sessionId: saved.sessionId, requestId, messageDigest: digest };
      sessions.set(input.threadId, { ...session!, status: "running", resumeCursor: nextCursor, updatedAt: yield* now, activeTurnId: turnId });
      const byRequest = requests.get(input.threadId) ?? new Map<string, TurnId>();
      byRequest.set(requestId, turnId);
      requests.set(input.threadId, byRequest);
      yield* monitor(input.threadId, saved.sessionId, requestId, turnId);
      return { threadId: input.threadId, turnId, resumeCursor: nextCursor };
    });

  const unsupported = (method: string) => Effect.fail(error(method, "Native request identity or exact-turn condition unverified; use original DSH Host"));
  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: DRIVER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn: (threadId, turnId) => Effect.gen(function* () {
      const session = sessions.get(threadId), saved = cursor(session?.resumeCursor);
      if (!saved?.requestId || !turnId || session?.activeTurnId !== turnId || !options.host.interrupt)
        return yield* error("interruptTurn", "Exact original active turn unavailable");
      yield* remote("session/cancel", () => options.host.interrupt!(saved.sessionId, saved.requestId!));
    }),
    respondToRequest: (threadId, requestKey, decision) => Effect.gen(function* () {
      const saved = cursor(sessions.get(threadId)?.resumeCursor), pending = pendingResponses.get(requestKey);
      if (!saved || pending?.kind !== "approval" || pending.sessionId !== saved.sessionId || !options.host.approve)
        return yield* error("respondToRequest", "Original live approval unavailable");
      yield* remote("$events/result", () => options.host.approve!(pending.sessionId, pending.requestId, pending.nativeId, decision));
    }),
    respondToUserInput: (threadId, requestKey, answers) => Effect.gen(function* () {
      const saved = cursor(sessions.get(threadId)?.resumeCursor), pending = pendingResponses.get(requestKey);
      if (!saved || pending?.kind !== "question" || pending.sessionId !== saved.sessionId || !options.host.answer)
        return yield* error("respondToUserInput", "Original pending question unavailable");
      yield* remote("userQuestions/answer", () => options.host.answer!(pending.sessionId, pending.requestId, pending.nativeId, answers));
    }),
    stopSession: threadId => Effect.gen(function* () {
      const session = sessions.get(threadId), saved = cursor(session?.resumeCursor);
      if (session?.activeTurnId) {
        if (!saved?.requestId || !options.host.interrupt) return yield* error("stopSession", "Original session cancel unavailable");
        yield* remote("session/cancel", () => options.host.interrupt!(saved.sessionId, saved.requestId!));
        let confirmed = false;
        for (let attempt = 0; attempt < 10; attempt++) {
          const observed = yield* remote("session/page", () => options.host.observe(saved.sessionId, saved.requestId!));
          if ([observed, ...(observed.followUps ?? [])].every(turn => ["cancelled","completed","failed"].includes(turn.status))) { confirmed = true; break; }
          yield* Effect.sleep("100 millis");
        }
        if (!confirmed) return yield* error("stopSession", "Native cancellation unknown; original session retained");
      }
      if (saved) options.host.release?.(saved.sessionId);
      for (const [key, stop] of monitorStops) if (key.startsWith(`${threadId}:`)) stop();
      sessions.delete(threadId); requests.delete(threadId); attempted.delete(threadId);
      for (const [key, pending] of pendingResponses) if (pending.sessionId === saved?.sessionId) pendingResponses.delete(key);
    }),
    listSessions: () => Effect.sync(() => [...sessions.values()]),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) => Effect.sync(() => ({ threadId,
      turns: [...(requests.get(threadId)?.values() ?? [])].map(id => ({ id, items: [] })) })),
    rollbackThread: () => unsupported("rollbackThread"),
    stopAll: () => Effect.sync(() => { for (const stop of monitorStops.values()) stop(); monitorStops.clear(); for (const session of sessions.values()) { const saved = cursor(session.resumeCursor); if (saved) options.host.release?.(saved.sessionId); } sessions.clear(); requests.clear(); attempted.clear(); pendingResponses.clear(); monitorStates.clear(); }),
    streamEvents: Stream.fromQueue(events),
  };
  return adapter;
});
