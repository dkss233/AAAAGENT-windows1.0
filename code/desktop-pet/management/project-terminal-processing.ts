import { createHash } from 'node:crypto';
import type { TrialConfiguration } from '../app/trial-config.js';
import { ManagementError } from '../contracts/management.js';
import { ProjectTerminalTransportError, type ProjectTerminalModelCallPort, type ProjectTerminalModelRequest,
  type ProjectTerminalModelSelection, type ProjectTerminalModelTransport } from '../contracts/project-terminal-processing.js';
import { EvaluationBudget } from '../core/evaluation-budget.js';
import type { ProjectTerminalEvidence } from '../contracts/project-memory.js';
import { managementAdapterCatalog } from '../providers/management-catalog.js';
import { credentialRegistry } from './credentials.js';

const unavailable = (): never => { throw new ManagementError('unavailable', '项目记忆后台模型配置不可用。'); };
const boundedText = (value: unknown): value is string => typeof value === 'string' &&
  value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 240000 && !value.includes('\0');
const count = (value: unknown, upper: number): value is number => Number.isSafeInteger(value) &&
  Number(value) >= 0 && Number(value) <= upper;

/** The job's durable attempt number is part of the paid-operation identity. */
export function projectTerminalOperationId(evidence: ProjectTerminalEvidence, attemptOrdinal: number): string {
  if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 1) return unavailable();
  return 'project-terminal:' + createHash('sha256').update(JSON.stringify([
    evidence.projectId, evidence.taskId, evidence.nativeTurnId, evidence.terminalEventId,
    evidence.extractionVersion, attemptOrdinal,
  ])).digest('hex');
}

/** Called before failed -> queued; an unresolved earlier request cannot authorize another paid send. */
export async function assertProjectTerminalRetrySafe(budget: EvaluationBudget,
  evidence: ProjectTerminalEvidence, nextAttempt: number): Promise<void> {
  if (!Number.isSafeInteger(nextAttempt) || nextAttempt < 2) return unavailable();
  const state = await budget.snapshot();
  for (let attempt = 1; attempt < nextAttempt; attempt++) {
    const entry = state.entries.find(row => row.operationId === projectTerminalOperationId(evidence, attempt));
    if (entry && entry.status !== 'settled') {
      throw new ManagementError('version_conflict', '上次模型请求结果或费用待核，请先核对，暂不能重试。');
    }
  }
}

/** No selection or transport means processingUnavailable; construction never opens a key or sends a request. */
export function createProjectTerminalModelCall(base: TrialConfiguration,
  selection: ProjectTerminalModelSelection | undefined, transport: ProjectTerminalModelTransport | undefined,
  budget = new EvaluationBudget(base.budgetFile, base.budgetBatchId, base.limitMicros),
  attemptOrdinal = 1): ProjectTerminalModelCallPort | null {
  if (!selection || !transport) return null;
  if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 1) return unavailable();
  if (selection.version !== '0.1.0' || selection.scope !== 'project-terminal' ||
      !Number.isSafeInteger(selection.timeoutMs) || selection.timeoutMs < 1000 || selection.timeoutMs > 300000 ||
      !selection.credentialRef || !selection.credentialRef.trim()) return unavailable();
  // Reuse reviewed model/price metadata, while keeping a separate operation, prompt and credential choice.
  const choice = managementAdapterCatalog(base).filter(adapter =>
    adapter.slots.some(slot => ['dialogue', 'summary', 'admission', 'memory_turn'].includes(slot)))
    .flatMap(adapter => adapter.choices ?? []).find(item => {
      const c = item.configuration;
      return c.adapterId === selection.adapterId && c.provider === selection.provider &&
        c.model === selection.model && c.endpoint === selection.endpoint &&
        c.inputTokenLimit === selection.inputTokenLimit && c.outputTokenLimit === selection.outputTokenLimit &&
        c.inputMicrosPerToken === selection.inputMicrosPerToken &&
        c.outputMicrosPerToken === selection.outputMicrosPerToken &&
        c.reservationMicros === selection.reservationMicros && c.thinking === selection.thinking;
    });
  if (!choice || !Number.isSafeInteger(selection.reservationMicros) || selection.reservationMicros <= 0) return unavailable();
  const credentials = credentialRegistry(base);
  let credentialFile: string;
  try {
    credentialFile = credentials.file(selection.credentialRef, selection.provider);
    if (!credentials.list().some(item => item.id === selection.credentialRef &&
        item.provider === selection.provider && item.status === 'configured')) return unavailable();
  } catch { return unavailable(); }
  const ledger = budget;
  return { async complete(input: ProjectTerminalModelRequest): Promise<string> {
    const evidence = input.evidence;
    if (!evidence || !boundedText(evidence.projectId) || !boundedText(evidence.taskId) ||
        !boundedText(evidence.nativeTurnId) || !boundedText(evidence.terminalEventId) ||
        !boundedText(evidence.extractionVersion) || !boundedText(input.systemText) ||
        !boundedText(input.userText)) return unavailable();
    // This byte guard is a local bound; it is not a provider tokenizer or full-prompt capacity claim.
    if (Buffer.byteLength(JSON.stringify([input.systemText, input.userText]), 'utf8') + 2048 >
        selection.inputTokenLimit) return unavailable();
    const maxOutputTokens = input.maxOutputTokens ?? selection.outputTokenLimit;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 ||
        maxOutputTokens > selection.outputTokenLimit) return unavailable();
    const operationId = projectTerminalOperationId(evidence, attemptOrdinal);
    await ledger.reserve(operationId, selection.model, selection.reservationMicros);
    const signal = AbortSignal.timeout(selection.timeoutMs);
    let response: Awaited<ReturnType<ProjectTerminalModelTransport['complete']>>;
    try {
      response = await transport.complete({ scope: 'project-terminal', operationId,
        projectId: evidence.projectId, provider: selection.provider, model: selection.model,
        endpoint: selection.endpoint, credentialFile, systemText: input.systemText,
        userText: input.userText, maxOutputTokens,
        timeoutMs: selection.timeoutMs, signal,
        ...(selection.thinking ? { thinking: selection.thinking } : {}) });
    } catch (error) {
      // Only the reviewed adapter's concrete pre-send error proves zero supplier usage.
      // A fetch rejection, timeout after fetch, or arbitrary exception remains unknown.
      const certainNoSend = error instanceof ProjectTerminalTransportError && !error.requestStarted;
      await ledger.settle(operationId, certainNoSend ? 0 : null);
      return unavailable();
    }
    if (signal.aborted) { await ledger.settle(operationId, null); return unavailable(); }
    const usage = response.usage;
    const cost = usage && count(usage.inputTokens, selection.inputTokenLimit) &&
      count(usage.outputTokens, selection.outputTokenLimit)
      ? Math.ceil(usage.inputTokens * selection.inputMicrosPerToken +
        usage.outputTokens * selection.outputMicrosPerToken) : null;
    await ledger.settle(operationId, response.finishReason === 'unknown' ? null : cost);
    if (response.finishReason !== 'stop' || !boundedText(response.text)) return unavailable();
    return response.text;
  } };
}
