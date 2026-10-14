import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectTerminalModelDeriver } from '../dist/projects/project-terminal-model-deriver.js';
import { createProjectTerminalExtractor } from '../dist/projects/project-terminal-extractor.js';
import { SqliteProjectMemory } from '../dist/projects/project-memory-sqlite.js';
import { createProjectTerminalModelCall, projectTerminalOperationId } from '../dist/management/project-terminal-processing.js';
import { createDeepSeekProjectTerminalTransport } from '../dist/management/project-terminal-deepseek-transport.js';
import { EvaluationBudget } from '../dist/core/evaluation-budget.js';
import { deepseekFlashModel, textJsonProtocol } from '../dist/providers/text-protocol.js';

const ATTEMPT = 1;
const OUTPUT_CAP = 1024;
const TIMEOUT_MS = 30000;
const digest = value => createHash('sha256').update(value).digest('hex');

/** Fixed fiction only. A completed source turn does not mean project acceptance passed. */
export function syntheticTerminalMaterial() {
  return {
    version: '0.1.0', source: 't3_thread_detail',
    evidence: {
      projectId: 'synthetic-pinecone-project', taskId: 'synthetic-pinecone-task',
      nativeTurnId: 'synthetic-pinecone-turn', terminalEventId: 'synthetic-pinecone-terminal',
      terminalPhase: 'completed', resultRef: 't3:synthetic:pinecone:message:synthetic-assistant-1',
      occurredAt: '2026-09-27T00:00:00.000Z', extractionVersion: 'b54-synthetic-trial-v1',
    },
    userMessages: [{ id: 'synthetic-user-1', text: '这是完全虚构的合成项目“松果”。验收条件：必须通过真实 Host 执行并核对结果，才能标记验收通过。编译成功或模拟检查不算真实 Host 验收。' }],
    assistantMessage: { id: 'synthetic-assistant-1', text: '已收到松果项目的验收条件。目前尚未执行真实 Host 验收，不能声称验收通过。' },
  };
}

/** Calls the actual deriver with a capture-only port. No config, credential, ledger or database reads. */
export async function prepareSyntheticTrial() {
  const material = syntheticTerminalMaterial();
  let request;
  await createProjectTerminalModelDeriver({ async complete(input) {
    request = input;
    return '{"outcome":"no_change"}';
  } })(material);
  const model = deepseekFlashModel('/unused-dry-run-placeholder');
  const body = { model: model.model,
    messages: [{ role: 'system', content: request.systemText }, { role: 'user', content: request.userText }],
    ...textJsonProtocol(model), max_tokens: OUTPUT_CAP };
  const bodyJson = JSON.stringify(body);
  const requestSha256 = digest(JSON.stringify({ method: 'POST', endpoint: model.endpoint,
    bodyJson, timeoutMs: TIMEOUT_MS, attemptOrdinal: ATTEMPT,
    operationId: projectTerminalOperationId(material.evidence, ATTEMPT) }));
  return {
    version: 'b54-synthetic-trial-review-v1', mode: 'dry-run', syntheticOnly: true,
    material, attemptOrdinal: ATTEMPT, operationId: projectTerminalOperationId(material.evidence, ATTEMPT),
    method: 'POST', endpoint: model.endpoint, body, bodyJson, requestSha256,
    timeoutMs: TIMEOUT_MS, automaticRetries: 0,
    accounting: {
      estimateCurrency: 'CNY', providerAccountCurrency: null,
      inputTokenCeiling: model.inputTokenLimit, outputTokenCeiling: OUTPUT_CAP,
      inputMicrosPerToken: model.inputMicrosPerToken, outputMicrosPerToken: model.outputMicrosPerToken,
      assumptionBoundMicros: model.inputTokenLimit * model.inputMicrosPerToken + OUTPUT_CAP * model.outputMicrosPerToken,
      existingCatalogReservationMicros: model.reservationMicros,
      providerBill: null,
      note: '按现有登记输入上限及 2/8 CNY 每百万 token 假设估算；不是实际账单或新预算。公共口仍按既有目录预留。',
    },
    executionBlockedBy: ['Exact request approval absent', 'Actual account currency unverified'],
    executionEntry: 'runApprovedSyntheticTrial(options): supply existing configuration/credentialRef, an artifact directory, exact request approval and verified currency evidence, and an explicit fetcher. CLI is dry-run only.',
  };
}

/** Future one-request entry. Never invoked by this CLI; no ambient fetch fallback or retry. */
export async function runApprovedSyntheticTrial(options) {
  const review = await prepareSyntheticTrial();
  const { configuration, credentialRef, trialDirectory, approval, fetcher } = options;
  if (approval?.requestSha256 !== review.requestSha256 || approval?.maxRequests !== 1 ||
      !['offline-test', 'approved-live'].includes(approval?.mode) ||
      approval?.accountCurrency !== 'CNY' || typeof approval?.currencyEvidence !== 'string' ||
      !approval.currencyEvidence.trim() || approval?.credentialRef !== credentialRef ||
      typeof approval?.reference !== 'string' || !approval.reference.trim() ||
      typeof fetcher !== 'function') throw new Error('Exact approval, verified compatible currency and explicit fetcher required');
  if (!configuration || typeof credentialRef !== 'string' || !credentialRef ||
      typeof trialDirectory !== 'string' || !isAbsolute(trialDirectory)) throw new Error('Trial configuration missing');
  const artifactRoot = resolve(configuration.projectRoot, 'artifacts');
  const location = relative(artifactRoot, resolve(trialDirectory));
  if (!location || location === '..' || location.startsWith('../') || isAbsolute(location))
    throw new Error('Synthetic database must use a dedicated project artifact directory');
  // Existing accounting only: never initialize a replacement production ledger or alter its policy.
  const before = JSON.parse(await readFile(configuration.budgetFile, 'utf8'));
  if (before.batchId !== configuration.budgetBatchId || before.currency !== 'CNY' ||
      before.limitMicros !== configuration.limitMicros || !Array.isArray(before.entries))
    throw new Error('Existing shared ledger metadata mismatch');
  const metadata = deepseekFlashModel('/unused-selection-placeholder');
  const selection = { version: '0.1.0', scope: 'project-terminal', adapterId: 'deepseek-summary',
    provider: metadata.provider, model: metadata.model, endpoint: metadata.endpoint, credentialRef,
    inputTokenLimit: metadata.inputTokenLimit, outputTokenLimit: metadata.outputTokenLimit,
    inputMicrosPerToken: metadata.inputMicrosPerToken, outputMicrosPerToken: metadata.outputMicrosPerToken,
    reservationMicros: metadata.reservationMicros, timeoutMs: TIMEOUT_MS };
  const budget = new EvaluationBudget(configuration.budgetFile, configuration.budgetBatchId, configuration.limitMicros);
  let providerResponse = null;
  let transportError = null;
  let fetchInvocations = 0;
  const adapter = createDeepSeekProjectTerminalTransport((...args) => {
    if (fetchInvocations !== 0) throw new Error('Only one fetch invocation is permitted');
    fetchInvocations++;
    return fetcher(...args);
  });
  const transport = { async complete(input) {
    try { providerResponse = await adapter.complete(input); return providerResponse; }
    catch (error) {
      transportError = { code: typeof error.code === 'string' ? error.code : 'unknown',
        requestStarted: error.requestStarted === true };
      throw error;
    }
  } };
  const call = createProjectTerminalModelCall(configuration, selection, transport, budget, ATTEMPT);
  if (!call) throw new Error('Project terminal call unavailable');
  const derive = createProjectTerminalModelDeriver({ complete: input => call.complete({ ...input, maxOutputTokens: OUTPUT_CAP }) });
  const extract = createProjectTerminalExtractor({ readTerminalMaterial: async () => syntheticTerminalMaterial() }, derive);
  const store = new SqliteProjectMemory(join(trialDirectory, 'project-terminal-synthetic-trial.sqlite'), {
    autoProcess: false,
    extractor: (evidence, attempt) => {
      if (attempt !== ATTEMPT) throw new Error('Only the fixed first attempt is permitted');
      return extract(evidence);
    },
    retryGate: async () => { throw new Error('This trial does not permit another attempt'); },
  });
  try {
    const queued = await store.enqueueTerminal(review.material.evidence);
    await store.runPending();
    const job = await store.getJob(review.material.evidence.projectId, queued.jobId);
    const items = await store.list({ projectId: review.material.evidence.projectId, limit: 25 });
    const ledger = await budget.snapshot();
    return { mode: approval.mode, requestSha256: review.requestSha256, operationId: review.operationId,
      job, items, providerResponse, transportError, fetchInvocations,
      accountingEntry: ledger.entries.find(entry => entry.operationId === review.operationId) ?? null,
      evidenceLevel: approval.mode === 'offline-test' ? 'fake-fetch and isolated SQLite only' : 'single synthetic provider request; no real Host acceptance',
    };
  } finally { await store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some(arg => arg !== '--dry-run') || process.argv.length > 3) {
    process.stderr.write('Only --dry-run is available in this preparation CLI.\n');
    process.exitCode = 2;
  } else process.stdout.write(JSON.stringify(await prepareSyntheticTrial(), null, 2) + '\n');
}
