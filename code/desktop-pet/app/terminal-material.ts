import type { ProjectTerminalEvidence, ProjectTerminalMaterial } from '../contracts/project-memory.js';
import type { WorkbenchTaskRef } from '../contracts/workbench.js';
import { ManagementError } from '../contracts/management.js';
import { readTurnMessageBindings } from './turn-message-bindings.js';
import { t3ShellToTaskEvent } from '../workbench/t3-read.js';

const unavailable = (): never => { throw new ManagementError('unavailable', '原生轮次正文暂不可完整核对。'); };

/** Exact native turn metadata and all its messages must come from one bounded SQL snapshot. */
export function t3TerminalMaterial(ref: WorkbenchTaskRef, evidence: ProjectTerminalEvidence,
  value: unknown): { readonly snapshotSequence: number; readonly beforeCursor: string | null;
    readonly material: ProjectTerminalMaterial | null } {
  if (ref.origin !== 't3' || ref.id !== evidence.taskId || ref.projectId !== evidence.projectId) return unavailable();
  const window = readTurnMessageBindings(ref, value);
  const native = value as { thread: { latestTurn?: { turnId?: unknown; state?: unknown;
    completedAt?: unknown; assistantMessageId?: unknown } | null } };
  const latest = native.thread.latestTurn;
  const turn = window.turns.get(evidence.nativeTurnId);
  if (!turn) {
    if (latest?.turnId === evidence.nativeTurnId) return unavailable();
    return { snapshotSequence: window.snapshotSequence, beforeCursor: window.beforeCursor, material: null };
  }
  const state = evidence.terminalPhase === 'completed' ? 'completed' :
    evidence.terminalPhase === 'failed' ? 'error' : evidence.terminalPhase === 'cancelled' ? 'interrupted' : null;
  if (!state || turn.state !== state || turn.userMessageId === null ||
      !Number.isFinite(Date.parse(evidence.occurredAt))) return unavailable();
  // occurredAt is the durable observation time; native completion is bound by the read-event fingerprint.
  // WorkbenchService separately verifies the exact persisted evidence before this reader runs.
  if (evidence.terminalEventId.startsWith('t3-read:') && evidence.terminalEventId !==
      t3ShellToTaskEvent(ref, { id: ref.threadId, projectId: ref.t3ProjectId!,
        modelSelection: { instanceId: ref.providerInstanceId }, latestTurn: turn,
        hasPendingApprovals: false, hasPendingUserInput: false }, 0, evidence.occurredAt).eventId) return unavailable();
  if (latest?.turnId === turn.turnId && (latest.state !== turn.state ||
      latest.assistantMessageId !== turn.assistantMessageId ||
      typeof latest.completedAt !== 'string' || Date.parse(latest.completedAt) !== Date.parse(turn.completedAt!))) return unavailable();
  const prefix = `t3:${ref.environmentId}:${ref.threadId}:message:`;
  if (state === 'completed' ? evidence.resultRef !== prefix + turn.assistantMessageId : evidence.resultRef !== undefined)
    return unavailable();
  const messages = window.byTurn.get(turn.turnId)!;
  const userMessages = messages.filter(m => m.role === 'user').map(({ id, text }) => ({ id, text }));
  const assistant = state === 'completed' ? messages.find(m => m.id === turn.assistantMessageId) : undefined;
  if (!userMessages.length || state === 'completed' && !assistant) return unavailable();
  return { snapshotSequence: window.snapshotSequence, beforeCursor: window.beforeCursor,
    material: { version: '0.1.0', evidence, userMessages,
      ...(assistant ? { assistantMessage: { id: assistant.id, text: assistant.text } } : {}),
      source: 't3_thread_detail' } };
}
