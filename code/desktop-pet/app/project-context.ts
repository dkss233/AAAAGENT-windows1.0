import type { ProjectProviderInputBudget, ProjectRecentTurn, ProjectRecentWindow } from '../contracts/project-memory.js';
import type { WorkbenchTaskRef } from '../contracts/workbench.js';
import { ManagementError } from '../contracts/management.js';
import { readTurnMessageBindings } from './turn-message-bindings.js';

const unavailable = (): never => { throw new ManagementError('unavailable', '近期原生对话暂不可完整核对。'); };
const boundedId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 250 &&
  !/[\u0000-\u001f\u007f]/u.test(value);

/** Recent user turns share the terminal reader's explicit native association and completeness check. */
export function normalizeProjectRecentTurns(ref: WorkbenchTaskRef, value: unknown): ProjectRecentWindow {
  if (ref.origin !== 't3') return unavailable();
  const window = readTurnMessageBindings(ref, value);
  if (!(window.branchRef === null || boundedId(window.branchRef))) return unavailable();
  const anchored: { turn: ProjectRecentTurn; anchor: number }[] = [];
  for (const turn of window.turns.values()) {
    if (turn.userMessageId === null) continue; // Native subagent turns have no user anchor.
    if (turn.state === 'running') return unavailable();
    const messages = window.byTurn.get(turn.turnId)!.map(({ id, role, text, createdAt }) =>
      ({ id, role, text, createdAt }));
    messages.sort((a, b) => (a.role === 'user' ? 0 : 1) - (b.role === 'user' ? 0 : 1) ||
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
    anchored.push({ turn: { nativeTurnId: turn.turnId, messages },
      anchor: Date.parse(messages.find(m => m.id === turn.userMessageId)!.createdAt) });
  }
  anchored.sort((a, b) => a.anchor - b.anchor || a.turn.nativeTurnId.localeCompare(b.turn.nativeTurnId));
  if (anchored.length > 50) return unavailable();
  return { version: '0.1.0', projectId: ref.projectId, taskId: ref.id,
    environmentId: ref.environmentId, threadId: ref.threadId,
    branchRef: window.branchRef, snapshotSequence: window.snapshotSequence,
    turns: anchored.map(item => item.turn), hasOlder: window.hasMore };
}

/** The provider owns this limit. No default or character-to-token guess can authorize a model call. */
export function validateProjectProviderBudget(budget: ProjectProviderInputBudget,
  expectedProviderInstanceId: string): ProjectProviderInputBudget {
  if (!budget || budget.source !== 'verified_provider_configuration' ||
      budget.providerInstanceId !== expectedProviderInstanceId || !boundedId(budget.modelId) ||
      !Number.isSafeInteger(budget.maxInputUtf8Bytes) || budget.maxInputUtf8Bytes < 1 ||
      budget.maxInputUtf8Bytes > 100_000_000 ||
      !Number.isSafeInteger(budget.fixedOverheadUtf8Bytes) || budget.fixedOverheadUtf8Bytes < 0 ||
      budget.fixedOverheadUtf8Bytes >= budget.maxInputUtf8Bytes) {
    throw new ManagementError('invalid_request', '执行器输入预算尚未核实。');
  }
  return budget;
}
