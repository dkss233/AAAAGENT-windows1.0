import type { WorkbenchCommandResult, WorkbenchInteraction, WorkbenchTaskEvent, WorkbenchTaskRef } from '../contracts/workbench.js';

/** Synthetic contract examples for W1/W2/I; these are not live-provider acceptance evidence. */
export const WORKBENCH_FIXTURE_VERSION = '0.1.1' as const;
export const fixtureTask: WorkbenchTaskRef = {
  id: 'fixture-task-1', projectId: 'fixture-project', provider: 'codex', origin: 't3',
  environmentId: 'fixture-env', t3ProjectId: 'fixture-native-project', threadId: 'fixture-thread', providerInstanceId: 'codex',
};
export const fixtureEvents: readonly WorkbenchTaskEvent[] = [
  { eventId: 'fixture-accepted', taskId: fixtureTask.id, sequence: 1, phase: 'accepted', observedAt: '2026-01-01T00:00:00.000Z', evidence: 't3_event' },
  { eventId: 'fixture-running', taskId: fixtureTask.id, sequence: 2, phase: 'running', observedAt: '2026-01-01T00:00:01.000Z', nativeTurnId: 'fixture-turn', evidence: 't3_event' },
  { eventId: 'fixture-awaiting-approval', taskId: fixtureTask.id, sequence: 3, phase: 'waiting_approval', observedAt: '2026-01-01T00:00:02.000Z', nativeTurnId: 'fixture-turn', interactionId: 'fixture-interaction', evidence: 't3_event' },
  { eventId: 'fixture-complete', taskId: fixtureTask.id, sequence: 4, phase: 'completed', observedAt: '2026-01-01T00:00:03.000Z', nativeTurnId: 'fixture-turn', nativeEventId: 'fixture-native-end', resultRef: 'fixture:result', evidence: 't3_event' },
];
export const fixtureInteraction: WorkbenchInteraction = {
  id: 'fixture-interaction', taskId: fixtureTask.id, nativeRequestId: 'fixture-native-request',
  liveEventId: 'fixture-live-event', transportGeneration: 'fixture-generation-1',
  answerLifetime: 'live_only', nativeTurnId: 'fixture-turn', version: 1, state: 'pending', kind: 'approval',
  summary: 'Allow fixture command?', choices: [{ id: 'allow', label: 'Allow' }, { id: 'deny', label: 'Deny' }],
};
export const fixtureResults: readonly WorkbenchCommandResult[] = [
  { commandId: 'fixture-command-accepted', state: 'accepted', task: fixtureTask },
  { commandId: 'fixture-command-unknown', state: 'unknown', task: fixtureTask, detail: 'Await native receipt readback; do not resubmit' },
  { commandId: 'fixture-command-conflict', state: 'conflict', detail: 'command ID already bound to another target or text' },
  { commandId: 'fixture-command-unsupported', state: 'unsupported', detail: 'exact native request not verified' },
];
