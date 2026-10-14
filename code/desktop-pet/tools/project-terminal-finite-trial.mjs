import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { SqliteProjectMemory } from '../dist/projects/project-memory-sqlite.js';
import { createProjectTerminalExtractor } from '../dist/projects/project-terminal-extractor.js';
import { createProjectTerminalModelCall } from '../dist/management/project-terminal-processing.js';
import { projectTerminalConfigurationFile, projectTerminalFiniteRegistration,
  validateProjectTerminalConfiguration } from '../dist/management/project-terminal-configuration.js';
import { freezeProjectTerminalRequests } from '../dist/management/project-terminal-request-review.js';
import { createDeepSeekProjectTerminalTransport, projectTerminalDeepSeekBody,
  ProjectTerminalTransportError } from '../dist/management/project-terminal-deepseek-transport.js';
import { validateTrialConfiguration } from '../dist/app/trial-config.js';
import { t3TerminalMaterial } from '../dist/app/terminal-material.js';
import { projectTerminalEvidence } from '../dist/workbench/events.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const requestIdentity = r => ({ jobId: r.jobId, operationId: r.operationId,
  requestSha256: r.requestSha256, bodySha256: r.bodySha256 });
const coreReview = r => ({ configuration: r.configuration, configurationSha256: r.configurationSha256,
  queue: r.queue, queueSha256: r.queueSha256, requests: r.requests });
const jobRow = r => ({ id: r.id, projectId: r.project_id, state: r.state, attempts: r.attempts,
  evidence: JSON.parse(r.evidence_json) });

/** Strict read: malformed/enabled settings never count as off. No configuration file is created. */
async function assertGlobalOff(root, expected) {
  const file = projectTerminalConfigurationFile(root);
  assert.equal(await realpath(dirname(file)), dirname(file));
  let bytes;
  try {
    const info = await lstat(file);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 65536 && (info.mode & 0o077) === 0);
    bytes = await readFile(file);
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert.deepEqual(validateProjectTerminalConfiguration(JSON.parse(bytes)), expected);
  assert.equal(expected.enabled, false);
}

/** Explicit finite operation. Caller supplies the reviewed approval and a fetcher; no ambient model send. */
export async function runApprovedFiniteTerminalTrial({ configuration, defaultOffConfiguration, review, approval,
  materialPort, fetcher, beforeSend = async () => {} }) {
  const base = structuredClone(configuration), draft = validateProjectTerminalConfiguration(defaultOffConfiguration);
  const frozen = structuredClone(review), allowed = structuredClone(approval);
  assert.equal(draft.enabled, false);
  assert.ok(['offline-test', 'approved-live'].includes(allowed?.mode));
  assert.equal(allowed.version, '0.1.0');
  assert.ok(typeof allowed.reference === 'string' && allowed.reference.trim());
  assert.equal(allowed.maxRequests, 2); assert.equal(allowed.maxRequestsPerJob, 1);
  assert.equal(allowed.automaticRetries, 0); assert.equal(allowed.accountCurrency, 'CNY');
  assert.ok(typeof allowed.currencyEvidence === 'string' && allowed.currencyEvidence.trim());
  assert.equal(allowed.credentialRef, draft.selection.credentialRef);
  assert.equal(allowed.installedSourceRevision, base.sourceRevision);
  assert.equal(typeof fetcher, 'function'); assert.equal(typeof materialPort?.readTerminalMaterial, 'function');
  assert.equal(frozen.queue.length, 2); assert.equal(frozen.requests.length, 2);
  assert.deepEqual(allowed.requests, frozen.requests.map(requestIdentity));
  assert.equal(allowed.configurationSha256, frozen.configurationSha256);
  assert.equal(allowed.queueSha256, frozen.queueSha256);
  assert.deepEqual(draft, frozen.configuration);
  assert.ok(frozen.queue[0].id < frozen.queue[1].id);
  const root = await realpath(base.projectRoot);
  assert.equal(root, base.projectRoot);
  await assertGlobalOff(root, draft);
  const file = resolve(root, 'data/desktop-pet/project-memory.sqlite');
  assert.equal(await realpath(file), file);
  const ro = new Database(file, { readonly: true, fileMustExist: true });
  let queue;
  try {
    const rows = frozen.queue.map(target => {
      const row = ro.prepare('SELECT * FROM project_memory_jobs WHERE id=? AND project_id=?')
        .get(target.id, target.evidence.projectId);
      assert.ok(row); return jobRow(row);
    });
    assert.equal(ro.prepare("SELECT count(*) n FROM project_memory_jobs WHERE state='running'").get().n, 0);
    // Re-read both actual materials and run the original verifier/deriver in capture-only mode.
    const fresh = await freezeProjectTerminalRequests(draft, rows, materialPort);
    assert.deepEqual(coreReview(fresh), coreReview(frozen));
    const before = JSON.parse(await readFile(base.budgetFile, 'utf8'));
    assert.equal(before.batchId, base.budgetBatchId); assert.equal(before.limitMicros, base.limitMicros);
    assert.equal(before.currency, 'CNY'); assert.ok(Array.isArray(before.entries));
    const ids = frozen.requests.map(r => r.operationId);
    assert.ok(ids.every(id => !before.entries.some(entry => entry.operationId === id)));
    let activeRequest = null;
    const sends = new Set(), responses = [], transportErrors = [];
    const adapter = createDeepSeekProjectTerminalTransport(async (url, init) => {
      try {
        assert.ok(activeRequest); assert.ok(!sends.has(activeRequest.jobId) && sends.size < 2);
        assert.equal(url, activeRequest.endpoint); assert.equal(init.method, 'POST');
        assert.equal(init.redirect, 'error'); assert.equal(init.body, activeRequest.bodyJson);
        await beforeSend(); await assertGlobalOff(root, draft);
        const row = ro.prepare('SELECT * FROM project_memory_jobs WHERE id=? AND project_id=?')
          .get(activeRequest.jobId, activeRequest.evidence.projectId);
        assert.ok(row); assert.equal(row.state, 'running'); assert.equal(row.attempts, 1);
        assert.deepEqual(JSON.parse(row.evidence_json), activeRequest.evidence);
        assert.ok(!init.signal.aborted);
      } catch { throw new ProjectTerminalTransportError('invalid_request', false); }
      sends.add(activeRequest.jobId);
      return fetcher(url, init);
    });
    const transport = { async complete(input) {
      try {
        assert.ok(activeRequest); assert.equal(input.operationId, activeRequest.operationId);
        assert.equal(input.projectId, activeRequest.evidence.projectId);
        assert.equal(input.maxOutputTokens, 1024); assert.equal(input.timeoutMs, 30000);
        assert.equal(input.endpoint, activeRequest.endpoint);
        assert.equal(projectTerminalDeepSeekBody(input), activeRequest.bodyJson);
      } catch { throw new ProjectTerminalTransportError('invalid_request', false); }
      try {
        const response = await adapter.complete(input);
        responses.push({ jobId: activeRequest.jobId, finishReason: response.finishReason, usage: response.usage });
        return response;
      } catch (error) {
        transportErrors.push({ jobId: activeRequest.jobId, code: error instanceof ProjectTerminalTransportError ? error.code : 'unknown',
          requestStarted: error instanceof ProjectTerminalTransportError ? error.requestStarted : true });
        throw error;
      }
    } };
    const registration = projectTerminalFiniteRegistration(base, draft, transport);
    queue = new SqliteProjectMemory(file, { autoProcess: false, extractor: async (evidence, attempt) => {
      assert.equal(attempt, 1);
      const request = frozen.requests.find(r => r.evidence.projectId === evidence.projectId &&
        r.evidence.taskId === evidence.taskId && r.evidence.nativeTurnId === evidence.nativeTurnId &&
        r.evidence.terminalEventId === evidence.terminalEventId);
      assert.ok(request); assert.deepEqual(request.evidence, evidence);
      activeRequest = request;
      const call = createProjectTerminalModelCall(base, registration.selection, registration.transport, undefined, 1);
      assert.ok(call);
      const derive = registration.createDeriver({ async complete(input) {
        // Before reservation/key access, compare the actual newly built prompt to the frozen request.
        assert.deepEqual(input.evidence, request.evidence);
        assert.equal(input.systemText, request.systemText); assert.equal(input.userText, request.userText);
        assert.equal(input.maxOutputTokens, 1024);
        await assertGlobalOff(root, draft); await beforeSend();
        return call.complete(input);
      } });
      const proposals = await createProjectTerminalExtractor(materialPort, derive)(evidence);
      // A syntactically complete answer with unknown usage still stops this finite experiment.
      const ledger = JSON.parse(await readFile(base.budgetFile, 'utf8'));
      assert.equal(ledger.entries.find(entry => entry.operationId === request.operationId)?.status, 'settled');
      return proposals;
    } });
    const processed = await queue.runSelectedFirstAttempts(rows);
    const jobs = await Promise.all(rows.map(row => queue.getJob(row.projectId, row.id)));
    const after = JSON.parse(await readFile(base.budgetFile, 'utf8'));
    assert.deepEqual(after.entries.slice(0, before.entries.length), before.entries);
    assert.equal(after.limitMicros, before.limitMicros); assert.equal(after.batchId, before.batchId);
    return { status: jobs.every(j => j?.state === 'done' && j.attempts === 1) ? 'done' : 'stopped',
      mode: allowed.mode, jobs, processed: processed.length, fetchInvocations: sends.size,
      responses, transportErrors, requests: frozen.requests.map(requestIdentity),
      accounting: after.entries.filter(entry => ids.includes(entry.operationId)),
      originalLedgerEntriesPreserved: true, globalWorkerStarted: false,
      evidenceLevel: allowed.mode === 'offline-test' ? 'isolated SQLite and fake HTTP only' : 'exact original terminal jobs; knowledge quality requires separate review' };
  } finally { await queue?.close(); ro.close(); }
}

/** Local CLI reader uses the original durable event and authenticated task detail; GET only. */
async function liveMaterialPort(root, base) {
  const session = JSON.parse(await readFile(resolve(root, 'artifacts/W0-I/model-evaluation/trial/user-trial/management-session.json')));
  assert.equal(session.sourceRevision, base.sourceRevision);
  const url = new URL(session.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1'); assert.ok(token);
  return { async readTerminalMaterial(evidence) {
    const events = new Database(resolve(root, 'data/desktop-pet/workbench.sqlite'), { readonly: true, fileMustExist: true });
    try {
      const row = events.prepare(`SELECT o.event_json,t.task_json FROM workbench_terminal_outbox o
        JOIN task_refs t ON t.task_id=o.task_id WHERE o.task_id=? AND o.event_id=?`).get(evidence.taskId, evidence.terminalEventId);
      assert.ok(row);
      const task = JSON.parse(row.task_json), event = JSON.parse(row.event_json);
      assert.deepEqual(projectTerminalEvidence(task.projectId, { taskId: task.id, sequence: event.sequence,
        eventId: event.eventId, phase: event.phase, terminalEvent: event }, evidence.extractionVersion), evidence);
      const response = await fetch(url.origin + '/api/workbench/task-detail?' +
        new URLSearchParams({ projectId: evidence.projectId, taskId: evidence.taskId }), {
        method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
      });
      assert.ok(response.ok);
      const detail = await response.json(); assert.deepEqual(detail.task, task);
      const read = t3TerminalMaterial(task, evidence, detail.native); assert.ok(read.material);
      return read.material;
    } finally { events.close(); }
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, projectRoot, draftFile, reviewFile, approvalFile, outputDirectory, ...extra] = process.argv.slice(2);
  if (flag !== '--execute-approved' || !projectRoot || !draftFile || !reviewFile || !approvalFile || !outputDirectory || extra.length) {
    process.stderr.write('Usage: --execute-approved ROOT DEFAULT_OFF_CONFIG REVIEW APPROVAL OUTPUT_DIRECTORY\n'); process.exitCode = 2;
  } else {
    try {
      const root = await realpath(projectRoot), output = resolve(outputDirectory);
      const part = relative(resolve(root, 'artifacts'), output);
      assert.ok(part && !part.startsWith('..') && !isAbsolute(part));
      await mkdir(output, { recursive: true, mode: 0o700 }); assert.equal(await realpath(output), output);
      const configFile = resolve(root, 'artifacts/W0-I/model-evaluation/trial/user-trial/config.json');
      const baseBytes = await readFile(configFile), draftBytes = await readFile(draftFile);
      const reviewBytes = await readFile(reviewFile), approval = JSON.parse(await readFile(approvalFile));
      assert.equal(approval.mode, 'approved-live'); assert.equal(approval.reviewFileSha256, sha(reviewBytes));
      const base = validateTrialConfiguration(JSON.parse(baseBytes)); assert.equal(base.projectRoot, root);
      const materialPort = await liveMaterialPort(root, base);
      // This is an execution receipt, not a second queue. The original attempts/ledger are authoritative.
      await writeFile(resolve(output, 'intent.json'), JSON.stringify({ at: new Date().toISOString(),
        reference: approval.reference, requests: approval.requests }) + '\n', { flag: 'wx', mode: 0o600 });
      const result = await runApprovedFiniteTerminalTrial({ configuration: base,
        defaultOffConfiguration: JSON.parse(draftBytes), review: JSON.parse(reviewBytes), approval,
        materialPort, fetcher: fetch, beforeSend: async () => {
          assert.deepEqual(await readFile(configFile), baseBytes);
          assert.deepEqual(await readFile(draftFile), draftBytes);
        } });
      await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ status: result.status, requests: result.fetchInvocations }));
    } catch { process.stderr.write('Finite trial stopped. Inspect original jobs and accounting; do not replay unknown requests.\n'); process.exitCode = 1; }
  }
}
