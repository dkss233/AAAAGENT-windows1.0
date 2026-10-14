import { createHash } from 'node:crypto';
import type { ProjectMemoryJob, ProjectTerminalMaterialPort } from '../contracts/project-memory.js';
import type { ProjectTerminalModelRequest } from '../contracts/project-terminal-processing.js';
import { ManagementError } from '../contracts/management.js';
import { createProjectTerminalExtractor } from '../projects/project-terminal-extractor.js';
import { createProjectTerminalModelDeriver } from '../projects/project-terminal-model-deriver.js';
import { projectTerminalOperationId } from './project-terminal-processing.js';
import { projectTerminalDeepSeekBody } from './project-terminal-deepseek-transport.js';
import { validateProjectTerminalConfiguration } from './project-terminal-configuration.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
type ReviewJob = Pick<ProjectMemoryJob, 'id' | 'state' | 'attempts' | 'evidence'>;

/** Runs the existing source verifier and deriver with a capture-only model port. No worker or paid port. */
export async function freezeProjectTerminalRequests(value: unknown, jobs: readonly ReviewJob[],
  materials: ProjectTerminalMaterialPort) {
  const config = validateProjectTerminalConfiguration(value);
  if (config.enabled || jobs.length < 1 || jobs.length > 100 ||
      new Set(jobs.map(job => job.id)).size !== jobs.length ||
      jobs.some(job => !/^pmj_[a-f0-9]{40}$/u.test(job.id) || job.state !== 'queued' || job.attempts !== 0))
    throw new ManagementError('invalid_request', '只能审阅关闭配置下尚未尝试的准确待处理作业。');
  const configurationSha256 = sha(JSON.stringify(config));
  const queue = jobs.map(({ id, state, attempts, evidence }) => ({ id, state, attempts, evidence }));
  const queueSha256 = sha(JSON.stringify(queue));
  const requests = [];
  for (const job of queue) {
    let captured: ProjectTerminalModelRequest | undefined;
    const derive = createProjectTerminalModelDeriver({ async complete(request) {
      if (captured) throw new Error('One request capture per original job');
      captured = structuredClone(request);
      return '{"outcome":"no_change"}';
    } });
    await createProjectTerminalExtractor(materials, derive)(job.evidence);
    if (!captured) throw new Error('Project terminal request was not captured');
    const input = captured as ProjectTerminalModelRequest;
    const bodyJson = projectTerminalDeepSeekBody({ model: config.selection.model,
      systemText: input.systemText, userText: input.userText, maxOutputTokens: config.maxOutputTokens });
    const operationId = projectTerminalOperationId(job.evidence, 1);
    const wire = { method: 'POST' as const, endpoint: config.selection.endpoint, bodyJson,
      timeoutMs: config.selection.timeoutMs, attemptOrdinal: 1, operationId };
    requests.push({ jobId: job.id, evidence: job.evidence, ...wire,
      systemText: input.systemText, userText: input.userText, body: JSON.parse(bodyJson) as unknown,
      bodySha256: sha(bodyJson), requestSha256: sha(JSON.stringify(wire)),
      configurationSha256, queueSha256, automaticRetries: 0 });
  }
  return { version: '0.1.0' as const, mode: 'review_only' as const,
    configuration: config, configurationSha256, queue, queueSha256, requests,
    precisePendingJobIds: queue.map(job => job.id), prospectiveRequests: requests.length,
    modelRequests: 0, workerStarted: false, queueMutations: 0,
    activationScope: 'Enabling the existing background worker processes all queued and future terminal jobs; this frozen list is the current pending scope, not activation authorization.',
    accountCurrency: null, currencyEvidence: null,
    accounting: { estimateCurrency: 'CNY', catalogReservationMicros: config.selection.reservationMicros,
      inputMicrosPerToken: config.selection.inputMicrosPerToken,
      outputMicrosPerToken: config.selection.outputMicrosPerToken, actualBill: null },
  };
}
