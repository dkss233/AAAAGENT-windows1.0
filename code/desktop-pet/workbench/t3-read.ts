import { createHash } from 'node:crypto';
import type { WorkbenchTaskEvent, WorkbenchTaskRef } from '../contracts/workbench.js';

/** Narrow read model of the fixed T3 shell snapshot (c13f7d93). */
export interface T3ThreadShellRead {
  readonly id: string;
  readonly projectId: string;
  readonly modelSelection: { readonly instanceId: string };
  readonly latestTurn: null | {
    readonly turnId: string;
    readonly state: 'running' | 'interrupted' | 'completed' | 'error';
    readonly completedAt: string | null;
    readonly assistantMessageId: string | null;
  };
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

function stableId(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** A cold T3 read is a projection. Its terminal ID is local and never called a provider event ID. */
export function t3ShellToTaskEvent(ref: WorkbenchTaskRef, shell: T3ThreadShellRead, sequence: number, observedAt: string): WorkbenchTaskEvent {
  if (ref.origin === 't3' && (typeof ref.t3ProjectId !== 'string' || !ref.t3ProjectId.trim())) {
    throw new Error('t3_project_binding_unverified');
  }
  if (ref.origin !== 't3' || shell.id !== ref.threadId || shell.projectId !== ref.t3ProjectId ||
      shell.modelSelection.instanceId !== ref.providerInstanceId) throw new Error('t3_identity_mismatch');
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('invalid_t3_sequence');
  const turn = shell.latestTurn;
  const phase = !turn ? 'accepted'
    : turn.state === 'running' ? shell.hasPendingApprovals ? 'waiting_approval' : shell.hasPendingUserInput ? 'waiting_answer' : 'running'
    : !turn.completedAt ? 'unknown'
    : turn.state === 'completed' ? 'completed' : turn.state === 'error' ? 'failed' : 'cancelled';
  const fingerprint = stableId([ref.environmentId, ref.threadId, turn?.turnId ?? '', phase,
    turn?.completedAt ?? '', turn?.assistantMessageId ?? '']);
  return {
    eventId: `t3-read:${fingerprint}`,
    taskId: ref.id,
    sequence,
    phase,
    observedAt,
    ...(turn ? { nativeTurnId: turn.turnId } : {}),
    ...(phase === 'completed' && turn?.assistantMessageId ? {
      resultRef: `t3:${ref.environmentId}:${ref.threadId}:message:${turn.assistantMessageId}`,
    } : {}),
    evidence: 'native_read',
  };
}
