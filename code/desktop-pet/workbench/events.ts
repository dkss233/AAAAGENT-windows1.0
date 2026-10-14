import type { WorkbenchTaskEvent, WorkbenchTaskPhase } from '../contracts/workbench.js';
import type { ProjectTerminalEvidence } from '../contracts/project-memory.js';

const terminal = new Set<WorkbenchTaskPhase>(['completed', 'failed', 'cancelled']);

export interface TaskProjection {
  readonly taskId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly phase: WorkbenchTaskPhase;
  readonly nativeTurnId?: string;
  readonly resultRef?: string;
  readonly terminalEvent?: WorkbenchTaskEvent;
}

/** Only a matching named turn can settle the visible task. Older frames are inert. */
export function applyTaskEvent(current: TaskProjection | null, event: WorkbenchTaskEvent): TaskProjection {
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0 || !event.eventId || !event.taskId) throw new Error('invalid_task_event');
  if (current && current.taskId !== event.taskId) throw new Error('task_identity_mismatch');
  if (current && event.sequence <= current.sequence) return current;
  if (terminal.has(event.phase) && (!event.nativeTurnId || !event.nativeEventId && event.evidence !== 'native_read')) {
    return current ?? unknown(event);
  }
  if (current?.nativeTurnId && !event.nativeTurnId) return current;
  // A verified latest-turn shell read may miss every intermediate stream frame.
  // Its newer sequence can name the current native turn directly; a streamed
  // terminal still needs the previously named turn to match.
  const latestNativeTurn = event.evidence === 'native_read' && !!event.nativeTurnId &&
    !!current?.nativeTurnId && current.nativeTurnId !== event.nativeTurnId;
  if (!latestNativeTurn && current && terminal.has(current.phase) &&
      (!event.nativeTurnId || current.nativeTurnId === event.nativeTurnId ||
        event.phase !== 'running' && event.phase !== 'accepted')) return current;
  if (!latestNativeTurn && current?.nativeTurnId && event.nativeTurnId && current.nativeTurnId !== event.nativeTurnId && event.phase !== 'running' && event.phase !== 'accepted') {
    return current;
  }
  if (!latestNativeTurn && terminal.has(event.phase) && current?.nativeTurnId && current.nativeTurnId !== event.nativeTurnId) return current;
  return {
    taskId: event.taskId,
    sequence: event.sequence,
    eventId: event.eventId,
    phase: event.phase,
    ...(event.nativeTurnId ? { nativeTurnId: event.nativeTurnId } : {}),
    ...(event.phase === 'completed' && event.resultRef ? { resultRef: event.resultRef } : {}),
    ...(terminal.has(event.phase) ? { terminalEvent: event } : {}),
  };
}

function unknown(event: WorkbenchTaskEvent): TaskProjection {
  return { taskId: event.taskId, sequence: event.sequence, eventId: event.eventId, phase: 'unknown' };
}

export function projectTerminalEvidence(projectId: string, projection: TaskProjection, extractionVersion: string): ProjectTerminalEvidence | null {
  const event = projection.terminalEvent;
  if (!event || !event.nativeTurnId || !terminal.has(event.phase)) return null;
  const terminalPhase = event.phase as 'completed' | 'failed' | 'cancelled';
  return {
    projectId,
    taskId: event.taskId,
    nativeTurnId: event.nativeTurnId,
    terminalEventId: event.eventId,
    terminalPhase,
    ...(terminalPhase === 'completed' && event.resultRef ? { resultRef: event.resultRef } : {}),
    occurredAt: event.observedAt,
    extractionVersion,
  };
}
