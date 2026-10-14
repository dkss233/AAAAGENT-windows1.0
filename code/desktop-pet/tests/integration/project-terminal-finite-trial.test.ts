import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { TrialConfiguration } from '../../app/trial-config.js';
import type { ProjectTerminalMaterial, ProjectMemoryJob } from '../../contracts/project-memory.js';
import { deepseekFlashModel } from '../../providers/text-protocol.js';
import { credentialRegistry } from '../../management/credentials.js';
import { defaultProjectTerminalConfiguration, projectTerminalConfigurationFile } from '../../management/project-terminal-configuration.js';
import { freezeProjectTerminalRequests } from '../../management/project-terminal-request-review.js';
import { SqliteProjectMemory } from '../../projects/project-memory-sqlite.js';

const toolUrl = new URL('../../../tools/project-terminal-finite-trial.mjs', import.meta.url);
const { runApprovedFiniteTerminalTrial: run } = await import(toolUrl.href);
const artifacts = fileURLToPath(new URL('../../../../../artifacts/W0-I/project-memory-config-54/finite-tests/', import.meta.url));
const prior = { operationId: 'prior-unknown', model: 'prior-model', reservedMicros: 99, actualMicros: null, status: 'unknown' };
const material = (suffix: string): ProjectTerminalMaterial => ({ version: '0.1.0', source: 't3_thread_detail',
  evidence: { projectId: 'project-' + suffix, taskId: 'task-' + suffix, nativeTurnId: 'turn-' + suffix,
    terminalEventId: 'event-' + suffix, terminalPhase: 'completed', resultRef: `t3:env:thread:message:answer-${suffix}`,
    occurredAt: '2026-09-28T00:00:00.000Z', extractionVersion: 'b54-t3-terminal-v1' },
  userMessages: [{ id: 'user-' + suffix, text: '合成项目要求：保留来源。' }],
  assistantMessage: { id: 'answer-' + suffix, text: '已收到；尚待真实验收。' } });
const response = (finish: unknown = 'stop', content = '{"outcome":"no_change"}', usage: unknown = { prompt_tokens: 100, completion_tokens: 10 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }], usage }));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  await mkdir(artifacts, { recursive: true }); const root = await mkdtemp(join(artifacts, 'case-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, 'project'), key = join(root, 'synthetic.key');
  await mkdir(join(projectRoot, 'data/desktop-pet'), { recursive: true });
  await writeFile(key, 'synthetic-only-never-real', { mode: 0o600 });
  const model = deepseekFlashModel(key), budgetFile = join(projectRoot, 'artifacts/budget.json');
  await mkdir(dirname(budgetFile));
  await writeFile(budgetFile, JSON.stringify({ batchId: 'finite-fixture', currency: 'CNY', budgetMode: 'unlimited',
    limitMicros: null, blocked: false, entries: [prior] }));
  const configuration: TrialConfiguration = { version: 1, product: 'companion-v1', purpose: 'user-trial',
    phaseId: 'local-trial-finite', sourceRevision: 'a'.repeat(40), projectRoot, runtimeFiles: {},
    database: join(projectRoot, 'data/desktop-pet/companion.sqlite'), budgetFile, budgetBatchId: 'finite-fixture',
    budgetMode: 'unlimited', limitMicros: null, phaseLimitMicros: 0, maxCalls: 0,
    operationLimits: { dialogue: 0, summary: 0, admission: 0, memory_turn: 0, perception: 0, tts: 0 },
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
    models: { dialogue: model, summary: model, admission: model, memory_turn: model, perception: model, tts: model } };
  const disabled = defaultProjectTerminalConfiguration(credentialRegistry(configuration).ref(key, 'deepseek'));
  const materials = [material('a'), material('b')], other = material('unselected'), future = material('future');
  const port = { async readTerminalMaterial(e: ProjectTerminalMaterial['evidence']) {
    return structuredClone(materials.find(m => m.evidence.projectId === e.projectId)!);
  } };
  const file = join(projectRoot, 'data/desktop-pet/project-memory.sqlite');
  const queue = new SqliteProjectMemory(file, { autoProcess: false });
  const jobs: ProjectMemoryJob[] = [];
  for (const m of materials) {
    const { jobId } = await queue.enqueueTerminal(m.evidence); jobs.push((await queue.getJob(m.evidence.projectId, jobId))!);
  }
  const { jobId: otherId } = await queue.enqueueTerminal(other.evidence);
  jobs.sort((a, b) => a.id.localeCompare(b.id));
  const review = await freezeProjectTerminalRequests(disabled, jobs, port);
  const approval = { version: '0.1.0', mode: 'offline-test', reference: 'synthetic-only', maxRequests: 2,
    maxRequestsPerJob: 1, automaticRetries: 0, accountCurrency: 'CNY', currencyEvidence: 'synthetic-only',
    credentialRef: disabled.selection.credentialRef, installedSourceRevision: configuration.sourceRevision,
    configurationSha256: review.configurationSha256, queueSha256: review.queueSha256,
    requests: review.requests.map(r => ({ jobId: r.jobId, operationId: r.operationId,
      requestSha256: r.requestSha256, bodySha256: r.bodySha256 })) };
  await queue.close();
  const readJobs = () => { const db = new Database(file, { readonly: true });
    try { return db.prepare('SELECT * FROM project_memory_jobs ORDER BY id').all() as Record<string, unknown>[]; } finally { db.close(); } };
  const assertHeld = () => { const rows = readJobs(); for (const id of [otherId]) {
    const row = rows.find(r => r.id === id)!; assert.equal(row.state, 'queued'); assert.equal(row.attempts, 0);
  } };
  const options = { configuration, defaultOffConfiguration: disabled, review, approval, materialPort: port };
  return { root, file, jobs, materials, future, otherId, options, readJobs, assertHeld };
}

test('exact two jobs share original queue and ledger; unselected and future jobs stay queued0; repeat/restart never send', async t => {
  const f = await fixture(t); let sends = 0; const bodies: string[] = [];
  const fetcher = async (_url: string, init: RequestInit) => {
    sends++; bodies.push(String(init.body));
    if (sends === 1) { const q = new SqliteProjectMemory(f.file, { autoProcess: false });
      await q.enqueueTerminal(f.future.evidence); await q.close(); }
    const m = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    return response('stop', JSON.stringify({ outcome: 'proposals', claims: [{ stableKey: 'source', kind: 'constraint',
      text: '保留来源。', sourceMessageIds: [m.userMessages[0].id] }] }));
  };
  const result = await run({ ...f.options, fetcher });
  assert.equal(result.status, 'done'); assert.equal(result.fetchInvocations, 2);
  assert.deepEqual(bodies, f.options.review.requests.map(r => r.bodyJson));
  f.assertHeld(); const future = f.readJobs().find(r => JSON.parse(String(r.evidence_json)).taskId === f.future.evidence.taskId)!;
  assert.equal(future.state, 'queued'); assert.equal(future.attempts, 0);
  const q = new SqliteProjectMemory(f.file, { autoProcess: false });
  for (const j of f.jobs) { const items = await q.list({ projectId: j.projectId, limit: 10 });
    assert.equal(items.length, 1); assert.equal(items[0]!.status, 'candidate'); }
  await q.close();
  await assert.rejects(run({ ...f.options, fetcher })); assert.equal(sends, 2);
  const ledger = JSON.parse(await readFile(f.options.configuration.budgetFile, 'utf8'));
  assert.deepEqual(ledger.entries[0], prior); assert.equal(ledger.entries.length, 3);
});

for (const kind of ['length', 'unknown-finish', 'network-unknown', 'invalid-json', 'missing-usage']) {
  test(`first ${kind} stops second job and cannot replay after reopening`, async t => {
    const f = await fixture(t); let sends = 0;
    const fetcher = async () => { sends++;
      if (kind === 'network-unknown') throw Error('synthetic lost response');
      return response(kind === 'length' ? 'length' : kind === 'unknown-finish' ? 'other' : 'stop',
        kind === 'invalid-json' ? '{' : '{"outcome":"no_change"}', kind === 'missing-usage' ? null : { prompt_tokens: 100, completion_tokens: 10 });
    };
    const result = await run({ ...f.options, fetcher });
    assert.equal(result.status, 'stopped'); assert.equal(sends, 1);
    assert.equal(result.jobs[0].state, 'failed'); assert.equal(result.jobs[0].attempts, 1);
    assert.equal(result.jobs[1].state, 'queued'); assert.equal(result.jobs[1].attempts, 0); f.assertHeld();
    await assert.rejects(run({ ...f.options, fetcher })); assert.equal(sends, 1);
    const db = new Database(f.file, { readonly: true });
    assert.equal((db.prepare('SELECT count(*) n FROM project_memory_items').get() as { n: number }).n, 0); db.close();
    if (['unknown-finish', 'network-unknown', 'missing-usage'].includes(kind)) assert.equal(result.accounting[0].status, 'unknown');
  });
}

test('approval, body, evidence, config, order and real-material drift reject before claim or ledger mutation', async t => {
  const f = await fixture(t), original = f.readJobs(), ledger = await readFile(f.options.configuration.budgetFile); let sends = 0;
  const fetcher = async () => { sends++; return response(); };
  const changes = [
    { approval: { ...f.options.approval, maxRequests: 3 } },
    { approval: { ...f.options.approval, credentialRef: 'deepseek-000000000000' } },
    { defaultOffConfiguration: { ...f.options.defaultOffConfiguration, enabled: true } },
    { review: { ...f.options.review, requests: f.options.review.requests.map(r => ({ ...r, bodyJson: r.bodyJson + ' ' })) } },
    { review: { ...f.options.review, queue: [...f.options.review.queue].reverse() } },
    { materialPort: { async readTerminalMaterial(e: ProjectTerminalMaterial['evidence']) {
      const m = await f.options.materialPort.readTerminalMaterial(e); return { ...m, userMessages: [{ id: m.userMessages[0]!.id, text: 'drift' }] };
    } } },
    { materialPort: { async readTerminalMaterial() { return null; } } },
  ];
  for (const change of changes) await assert.rejects(run({ ...f.options, ...change, fetcher }));
  assert.deepEqual(f.readJobs(), original); assert.deepEqual(await readFile(f.options.configuration.budgetFile), ledger); assert.equal(sends, 0);
  const file = projectTerminalConfigurationFile(f.options.configuration.projectRoot);
  for (const value of [JSON.stringify({ ...f.options.defaultOffConfiguration, enabled: true }), '{malformed']) {
    await writeFile(file, value, { mode: 0o600 }); await assert.rejects(run({ ...f.options, fetcher }));
  }
  assert.deepEqual(f.readJobs(), original); assert.equal(sends, 0);
});

test('material or config drift after preflight fails first claimed job before POST, holding second', async t => {
  const f = await fixture(t); let reads = 0, sends = 0;
  const result = await run({ ...f.options, materialPort: { async readTerminalMaterial(e: ProjectTerminalMaterial['evidence']) {
    const m = await f.options.materialPort.readTerminalMaterial(e);
    if (++reads === 3) return { ...m, userMessages: [{ id: m.userMessages[0]!.id, text: 'late drift' }] };
    return m;
  } }, fetcher: async () => { sends++; return response(); } });
  assert.equal(sends, 0); assert.equal(result.jobs[0].state, 'failed'); assert.equal(result.jobs[1].attempts, 0);
  assert.equal(result.accounting.length, 0);
});

test('config changed at transport boundary prevents POST and records proven no-send', async t => {
  const f = await fixture(t); let guards = 0, sends = 0;
  const result = await run({ ...f.options, beforeSend: async () => {
    if (++guards === 2) throw Error('synthetic installed config changed');
  }, fetcher: async () => { sends++; return response(); } });
  assert.equal(sends, 0); assert.equal(result.jobs[0].state, 'failed'); assert.equal(result.jobs[1].attempts, 0);
  assert.equal(result.accounting[0].actualMicros, 0); assert.equal(result.accounting[0].status, 'settled');
});

test('existing operation reservation prevents replay even if jobs have never been attempted', async t => {
  const f = await fixture(t), path = f.options.configuration.budgetFile;
  const ledger = JSON.parse(await readFile(path, 'utf8'));
  ledger.entries.push({ ...prior, operationId: f.options.review.requests[0]!.operationId });
  await writeFile(path, JSON.stringify(ledger)); const before = f.readJobs(); let sends = 0;
  await assert.rejects(run({ ...f.options, fetcher: async () => { sends++; return response(); } }));
  assert.equal(sends, 0); assert.deepEqual(f.readJobs(), before);
});

test('exact evidence and inactive worker are required; callback after recovery cannot apply proposals', async t => {
  const f = await fixture(t), held = deferred(), entered = deferred();
  const q = new SqliteProjectMemory(f.file, { autoProcess: false, extractor: async e => {
    entered.resolve(); await held.promise;
    return [{ stableKey: 'late', kind: 'fact', text: 'must never be written', basis: 'model_suggestion',
      sources: [{ taskId: e.taskId, nativeTurnId: e.nativeTurnId, terminalEventId: e.terminalEventId, recordedAt: e.occurredAt }] }];
  } });
  const wrong = f.jobs.map((j, i) => i ? j : { ...j, evidence: { ...j.evidence, occurredAt: '2026-09-28T00:00:01.000Z' } });
  await assert.rejects(q.runSelectedFirstAttempts(wrong));
  const pending = q.runSelectedFirstAttempts(f.jobs); await entered.promise;
  await assert.rejects(q.runPending()); assert.throws(() => q.startProcessing()); await assert.rejects(q.recoverInterruptedJobs());
  // Fault injection: a different owner incorrectly recovers a live worker. Its late callback must still fail closed.
  const recovery = new SqliteProjectMemory(f.file, { autoProcess: false });
  assert.equal(await recovery.recoverInterruptedJobs(), 1); await recovery.close(); held.resolve();
  const result = await pending; assert.equal(result[0]!.errorCode, 'interrupted');
  assert.deepEqual(await q.list({ projectId: f.jobs[0]!.projectId, limit: 10 }), []);
  assert.equal((await q.getJob(f.jobs[1]!.projectId, f.jobs[1]!.id))!.attempts, 0); await q.close();
});

test('two independent processes cannot split the batch past a failed first request', async t => {
  const f = await fixture(t), input = join(f.root, 'input.json');
  await writeFile(input, JSON.stringify({ ...f.options, materials: f.materials }));
  const childCode = `import {readFile} from 'node:fs/promises';
    import {runApprovedFiniteTerminalTrial as run} from ${JSON.stringify(toolUrl.href)};
    const o=JSON.parse(await readFile(process.argv[1]));let reads=0,sends=0;
    let go;const released=new Promise(r=>go=r);process.stdin.once('data',()=>go());
    try{const result=await run({...o,materialPort:{async readTerminalMaterial(e){
      if(++reads===2){console.log('ready');await released;}
      return o.materials.find(m=>m.evidence.projectId===e.projectId);
    }},fetcher:async()=>{sends++;await new Promise(r=>setTimeout(r,80));throw Error('unknown synthetic');}});
    console.log(JSON.stringify({status:result.status,sends,jobs:result.jobs.map(j=>({state:j.state,attempts:j.attempts}))}));}
    catch{console.log(JSON.stringify({status:'rejected',sends}));}`;
  const children = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, input], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = ''; const ready = deferred();
    child.stdout.on('data', bytes => { output += bytes.toString(); if (output.includes('ready\n')) ready.resolve(); });
    child.stderr.on('data', bytes => { errors += bytes.toString(); });
    const done = new Promise<{ status: string; sends: number }>((resolve, reject) => {
      child.on('error', reject); child.on('exit', code => {
        if (code !== 0) reject(Error(errors)); else resolve(JSON.parse(output.trim().split('\n').at(-1)!));
      });
    });
    t.after(async () => { if (child.exitCode === null) child.kill(); });
    return { child, ready: ready.promise, done };
  });
  await Promise.all(children.map(c => c.ready)); for (const c of children) c.child.stdin.end('go');
  const results = await Promise.all(children.map(c => c.done));
  assert.deepEqual(results.map(r => r.status).sort(), ['rejected', 'stopped']);
  assert.equal(results.reduce((n, r) => n + r.sends, 0), 1);
  const second = f.readJobs().find(j => j.id === f.jobs[1]!.id)!;
  assert.equal(second.state, 'queued'); assert.equal(second.attempts, 0); f.assertHeld();
});

test('process killed after first send leaves running1/reserved; cold retry sends nothing and holds second', async t => {
  const f = await fixture(t), input = join(f.root, 'crash-input.json');
  await writeFile(input, JSON.stringify({ ...f.options, materials: f.materials }));
  const childCode = `import {readFile} from 'node:fs/promises';
    import {runApprovedFiniteTerminalTrial as run} from ${JSON.stringify(toolUrl.href)};
    const o=JSON.parse(await readFile(process.argv[1]));
    await run({...o,materialPort:{async readTerminalMaterial(e){return o.materials.find(m=>m.evidence.projectId===e.projectId);}},
      fetcher:async()=>{console.log('sent');await new Promise(()=>{});}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode, input], { stdio: ['ignore', 'pipe', 'pipe'] });
  const sent = deferred(); let output = '';
  child.stdout.on('data', bytes => { output += bytes.toString(); if (output.includes('sent\n')) sent.resolve(); });
  const ended = new Promise<void>(resolve => child.once('exit', () => resolve()));
  t.after(async () => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await sent.promise; child.kill('SIGKILL'); await ended;
  const before = f.readJobs(), ledger = await readFile(f.options.configuration.budgetFile); let sends = 0;
  assert.equal(before.find(r => r.id === f.jobs[0]!.id)!.state, 'running');
  assert.equal(JSON.parse(ledger.toString()).entries.at(-1).status, 'reserved');
  await assert.rejects(run({ ...f.options, fetcher: async () => { sends++; return response(); } }));
  assert.equal(sends, 0); assert.deepEqual(f.readJobs(), before);
  assert.deepEqual(await readFile(f.options.configuration.budgetFile), ledger);
  const second = before.find(r => r.id === f.jobs[1]!.id)!;
  assert.equal(second.state, 'queued'); assert.equal(second.attempts, 0);
});
