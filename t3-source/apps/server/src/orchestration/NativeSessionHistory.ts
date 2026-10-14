// @effect-diagnostics globalDate:off preferSchemaOverJson:off -- Pure native decoder uses provider timestamps and a deterministic binding fingerprint.
import { createHash } from "node:crypto";
import { MessageId, TurnId, type OrchestrationMessage, type OrchestrationLatestTurn } from "@t3tools/contracts";

export const object = (v: unknown): Record<string, any> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
export const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export interface NativeMessage { id: string; role: "user" | "assistant"; text: string; createdAt: string; sourceCommandId?: string }
export interface NativeTurn { id: string; sourceTurnId?: string; state: OrchestrationLatestTurn["state"]; startedAt: string; completedAt: string | null; messages: NativeMessage[] }
export interface NativeHistory { nativeId: string; cwd: string; turns: NativeTurn[]; observation: "ready" | "running" | "waiting_approval" | "waiting_answer" | "unknown"; checkpoint: Record<string, any>; complete: boolean }
export const nativeMessageKey = (provider: string, nativeId: string, turn: NativeTurn, row: NativeMessage) => `native:${provider}:${nativeId}:message:${turn.id}:${String(turn.messages.indexOf(row)).padStart(8, "0")}:${row.id}`;
export interface SavedTurn { turnId: TurnId | null; pendingMessageId: MessageId | null; assistantMessageId: MessageId | null; state?: string; requestedAt?: string; startedAt?: string | null; completedAt?: string | null }

export function nativeBindingToken(binding: { provider: string; providerInstanceId?: string; resumeCursor?: unknown; runtimePayload?: unknown }) {
  const cursor = object(binding.resumeCursor), runtime = object(binding.runtimePayload);
  const nativeId = binding.provider === "codex" ? cursor?.threadId : cursor?.sessionId;
  if (typeof nativeId !== "string" || typeof runtime?.cwd !== "string") throw Error("Original native binding unavailable");
  return JSON.stringify({ provider: binding.provider, instanceId: binding.providerInstanceId, nativeId, cwd: runtime.cwd, ...(binding.provider === "dsh" && runtime.nativeImport?.kind === "dsh" ? { nativePreset: runtime.nativeImport.preset } : {}) });
}

const isoSeconds = (v: unknown, fallback?: string) => {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  if (fallback) return fallback;
  throw Error("Original native timestamp unavailable");
};

/** Only human input and assistant text enter formal messages. Other visible input is explicitly marked. */
export function nativeVisibleText(content: unknown) {
  if (!Array.isArray(content)) throw Error("Original native content unavailable");
  return content.map(p => {
    const part = object(p); if (!part || typeof part.type !== "string") throw Error("Invalid original native content");
    if (part.type === "reasoning" || part.type === "tool-call") return "";
    if (part.type === "text" || part.type === "inputText") {
      if (typeof part.text !== "string" || part.text.includes("\0")) throw Error("Invalid original native text");
      return part.text;
    }
    // Paths, file bodies, model instructions and private reasoning are never copied as placeholders.
    return `\n[原生附件：${part.type.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || "其他"}；详情见原会话]\n`;
  }).join("");
}

/** Import the App's exact named forwarded-input record, with its original source visible. */
export function nativeForwardedInput(item: Record<string, any>): string | undefined {
  if (item.type !== "functionCallOutput" || item.namespace !== "codex_app" || item.name !== "send_message_to_thread" || typeof item.output !== "string" || item.output.includes("\0")) return undefined;
  const match = /^<codex_delegation>\s*<source_thread_id>([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/.exec(item.output);
  if (!match || match[2]!.length === 0) return undefined;
  return `[原生转发输入；来源会话：${match[1]}]\n${match[2]}`;
}

export function decodeCodexHistory(value: unknown, nativeId: string, cwd: string): NativeHistory {
  const thread = object(value);
  if (!thread || thread.id !== nativeId || thread.cwd !== cwd || !Array.isArray(thread.turns)) throw Error("Original Codex history scope changed");
  const turns: NativeTurn[] = [], turnIds = new Set<string>(), ids = new Set<string>();
  for (const raw of thread.turns) {
    const turn = object(raw);
    if (!turn || typeof turn.id !== "string" || turnIds.has(turn.id) || !Array.isArray(turn.items)) throw Error("Invalid original Codex turn identity");
    turnIds.add(turn.id);
    const startedAt = isoSeconds(turn.startedAt, isoSeconds(thread.createdAt));
    const state = turn.status === "inProgress" ? "running" : turn.status === "completed" ? "completed" : turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "error" : undefined;
    if (!state) throw Error("Original Codex turn state unavailable");
    const row: NativeTurn = { id: turn.id, state, startedAt, completedAt: state === "running" ? null : isoSeconds(turn.completedAt, isoSeconds(thread.updatedAt)), messages: [] };
    for (const rawItem of turn.items) {
      const item = object(rawItem);
      if (!item) continue;
      const forwarded = nativeForwardedInput(item);
      if (!["userMessage", "agentMessage"].includes(item.type) && forwarded === undefined) continue;
      if (typeof item.id !== "string" || ids.has(item.id)) throw Error("Duplicate original Codex message identity");
      ids.add(item.id);
      const text = forwarded ?? (item.type === "userMessage" ? nativeVisibleText(item.content) : item.text);
      if (typeof text !== "string" || text.includes("\0")) throw Error("Invalid original Codex assistant text");
      const isInput = item.type === "userMessage" || forwarded !== undefined;
      row.messages.push({ id: item.id, role: isInput ? "user" : "assistant", text, createdAt: isInput ? startedAt : row.completedAt ?? startedAt });
    }
    turns.push(row);
  }
  return { nativeId, cwd, turns, observation: turns.at(-1)?.state === "running" ? "running" : "ready", checkpoint: { afterTurnId: turns.at(-1)?.id ?? null }, complete: true };
}

/** Existing T3 turn/user identities are authoritative; text similarity never establishes identity. */
export function planNativeHistory(history: NativeHistory, provider: "codex" | "dsh", savedTurns: readonly SavedTurn[], existing: readonly OrchestrationMessage[], aliases: Record<string, string> = {}) {
  const messages: OrchestrationMessage[] = [];
  const turns: (OrchestrationLatestTurn & { userMessageId: MessageId | null })[] = [];
  const nextAliases = { ...aliases }, existingById = new Map(existing.map(m => [String(m.id), m]));
  for (const native of history.turns) {
    const firstUser = native.messages.find(m => m.role === "user");
    const knownTurnId = provider === "codex" ? native.id : native.sourceTurnId ?? (firstUser?.sourceCommandId ? `dsh:${firstUser.sourceCommandId}` : undefined);
    const saved = savedTurns.find(t => t.turnId === (nextAliases[`turn:${native.id}`] ?? knownTurnId));
    const turnId = TurnId.make(saved?.turnId ?? nextAliases[`turn:${native.id}`] ?? `native:${provider}:${history.nativeId}:turn:${native.id}`);
    nextAliases[`turn:${native.id}`] = turnId;
    let userMessageId: MessageId | null = null, assistantMessageId: MessageId | null = null;
    for (const row of native.messages) {
      const nativeKey = `message:${row.id}`;
      const originalAssistant = `assistant:${row.id}`;
      const mapped = nextAliases[nativeKey] ?? (row === firstUser && saved?.pendingMessageId ? saved.pendingMessageId : row.role === "assistant" && (existingById.has(originalAssistant) || saved?.assistantMessageId === originalAssistant) ? originalAssistant : undefined);
      const id = MessageId.make(mapped ?? nativeMessageKey(provider, history.nativeId, native, row));
      nextAliases[nativeKey] = id;
      const old = existingById.get(id);
      // Preserve the original source message, context, attachments, creation time and turn binding.
      if (old && (old.role !== row.role || old.turnId !== null && old.turnId !== undefined && old.turnId !== turnId)) throw Error("Original message identity conflict");
      // The exact saved turn/pending input establishes identity. Provider transport
      // can add a file reference or private context; it cannot rewrite source input.
      const sourceInput = old?.role === "user" && row === firstUser && saved?.pendingMessageId === id && !id.startsWith("native:");
      if (old && !id.startsWith("native:") && old.text !== row.text && !sourceInput) throw Error("Original T3/native message content conflicts; no overwrite");
      const candidate: OrchestrationMessage = { ...(old ?? {}), id, role: row.role, text: sourceInput ? old.text : row.text, turnId: old ? old.turnId ?? null : turnId, streaming: native.state === "running" && row.role === "assistant", createdAt: old?.createdAt ?? row.createdAt, updatedAt: native.completedAt ?? row.createdAt };
      if (!old || old.text !== candidate.text || old.streaming !== candidate.streaming || old.turnId !== candidate.turnId) messages.push(candidate);
      if (row.role === "user" && userMessageId === null) userMessageId = id;
      if (row.role === "assistant") assistantMessageId = id;
    }
    turns.push({ turnId, userMessageId, state: native.state, requestedAt: saved?.requestedAt ?? native.startedAt, startedAt: saved?.startedAt ?? native.startedAt, completedAt: saved?.state === native.state && saved.completedAt ? saved.completedAt : native.completedAt, assistantMessageId });
  }
  return { messages, turns, latestTurn: turns.at(-1) ?? null, aliases: nextAliases };
}
