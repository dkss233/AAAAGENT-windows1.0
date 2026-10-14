import type { ProjectTurnMessageBindings } from '../contracts/project-memory.js';
import type { WorkbenchTaskRef } from '../contracts/workbench.js';
import { ManagementError } from '../contracts/management.js';

const unavailable = (): never => { throw new ManagementError('unavailable', '原生轮次与原话关联暂不可完整核对。'); };
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 250 &&
  !/[\u0000-\u001f\u007f]/u.test(v);
const date = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
type Message = { id: string; role: 'user' | 'assistant'; turnId: string | null;
  text: string; createdAt: string; streaming: boolean };

/** Never infer a user's turn from time, position or the latest assistant. Raw messages stay unchanged. */
export function readTurnMessageBindings(ref: WorkbenchTaskRef, value: unknown) {
  const snapshot = value as { snapshotSequence?: unknown; turnMessageBindings?: ProjectTurnMessageBindings;
    page?: { snapshotSequence?: unknown; hasMore?: unknown; beforeCursor?: unknown };
    thread?: { id?: unknown; projectId?: unknown; modelSelection?: { instanceId?: unknown };
      branch?: unknown; messages?: unknown; latestTurn?: { turnId?: unknown; state?: unknown; completedAt?: unknown; assistantMessageId?: unknown } | null } } | null;
  const page = snapshot?.page, thread = snapshot?.thread, bindings = snapshot?.turnMessageBindings;
  const sequence = snapshot?.snapshotSequence;
  if (ref.origin !== 't3' || !Number.isSafeInteger(sequence) || Number(sequence) < 0 || !page ||
      page.snapshotSequence !== sequence || typeof page.hasMore !== 'boolean' ||
      !(page.beforeCursor === null || typeof page.beforeCursor === 'string' &&
        page.beforeCursor.length > 0 && page.beforeCursor.length <= 4096 && /^[A-Za-z0-9_-]+$/u.test(page.beforeCursor)) ||
      page.hasMore !== (page.beforeCursor !== null) || thread?.id !== ref.threadId ||
      thread.projectId !== ref.t3ProjectId || thread.modelSelection?.instanceId !== ref.providerInstanceId ||
      !Array.isArray(thread.messages) || thread.messages.length > 2000 || !bindings ||
      bindings.version !== 1 || bindings.snapshotSequence !== sequence || bindings.threadId !== ref.threadId ||
      bindings.projectId !== ref.t3ProjectId || bindings.providerInstanceId !== ref.providerInstanceId ||
      !Array.isArray(bindings.turns) || bindings.turns.length > 150) return unavailable();

  const messages = new Map<string, Message>();
  let size = 0;
  for (const raw of thread.messages) {
    const m = raw as Message | null;
    if (m?.role !== 'user' && m?.role !== 'assistant') continue;
    if (!id(m.id) || messages.has(m.id) || !(m.turnId === null || id(m.turnId)) ||
        typeof m.text !== 'string' || !date(m.createdAt) || typeof m.streaming !== 'boolean') return unavailable();
    size += m.text.length;
    if (size > 240000) return unavailable();
    messages.set(m.id, m);
  }
  const turns = new Map<string, ProjectTurnMessageBindings['turns'][number]>();
  const owners = new Map<string, string>();
  const byTurn = new Map<string, readonly Message[]>();
  for (const turn of bindings.turns) {
    if (!turn || !id(turn.turnId) || turns.has(turn.turnId) ||
        !(turn.userMessageId === null || id(turn.userMessageId)) ||
        !(turn.assistantMessageId === null || id(turn.assistantMessageId)) ||
        !['running', 'completed', 'error', 'interrupted'].includes(turn.state) ||
        !(turn.completedAt === null || date(turn.completedAt)) ||
        turn.state !== 'running' && !date(turn.completedAt) ||
        !Array.isArray(turn.messageIds) || turn.messageIds.length > 2000) return unavailable();
    const selected: Message[] = [];
    for (const messageId of turn.messageIds) {
      if (!id(messageId) || owners.has(messageId)) return unavailable();
      const message = messages.get(messageId);
      if (!message || message.streaming || !message.text.trim() ||
          (message.id === turn.userMessageId
            ? message.role !== 'user' || message.turnId !== null && message.turnId !== turn.turnId
            : message.turnId !== turn.turnId)) return unavailable();
      owners.set(messageId, turn.turnId); selected.push(message);
    }
    if (turn.userMessageId !== null && !selected.some(m => m.id === turn.userMessageId && m.role === 'user') ||
        turn.assistantMessageId !== null && !selected.some(m => m.id === turn.assistantMessageId && m.role === 'assistant') ||
        turn.state === 'completed' && turn.userMessageId !== null && turn.assistantMessageId === null) return unavailable();
    turns.set(turn.turnId, turn); byTurn.set(turn.turnId, selected);
  }
  const latest = thread.latestTurn;
  const latestBinding = latest && typeof latest.turnId === 'string' ? turns.get(latest.turnId) : undefined;
  if (latestBinding && (latest!.state !== latestBinding.state ||
      latest!.assistantMessageId !== latestBinding.assistantMessageId ||
      (latestBinding.completedAt === null ? latest!.completedAt !== null :
        !date(latest!.completedAt) || Date.parse(latest!.completedAt) !== Date.parse(latestBinding.completedAt)))) return unavailable();
  // A declared turn must include its entire message set. Unlinked imported/stray text is not assigned.
  for (const message of messages.values()) {
    if (message.turnId !== null && owners.get(message.id) !== message.turnId) return unavailable();
  }
  return { snapshotSequence: sequence as number, turns, byTurn,
    beforeCursor: page.beforeCursor as string | null, hasMore: page.hasMore,
    branchRef: thread.branch };
}
