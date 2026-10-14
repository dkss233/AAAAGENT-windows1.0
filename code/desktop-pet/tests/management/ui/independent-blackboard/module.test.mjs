import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)), taskRoot = resolve(here, '../../../../../..');
const option = name => { const at = process.argv.indexOf(name); assert.ok(at >= 0 && process.argv[at + 1]); return resolve(process.argv[at + 1]); };
const evidence = option('--evidence'), esbuildPath = option('--esbuild');
assert.ok(evidence.startsWith(join(taskRoot, 'artifacts/W1/independent-blackboard-54/')));
await mkdir(evidence, { recursive: true });
const fixtures = JSON.parse(execFileSync('/usr/bin/python3', [join(here, 'fixtures.py')], { encoding: 'utf8' }));
await writeFile(join(evidence, 'controlled-fixtures.json'), JSON.stringify(fixtures, null, 2) + '\n');
const source = join(taskRoot, 'code/desktop-pet/t3-native/apps/web/src/aaaagent');
const esbuild = createRequire(import.meta.url)(esbuildPath);
const bundle = await esbuild.build({ stdin: { contents: `export * from ${JSON.stringify(join(source, 'independent-blackboard.ts'))}; export * from ${JSON.stringify(join(source, 'blackboard-poll.ts'))};`, resolveDir: source, loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
const compiled = bundle.outputFiles[0].text;
const { validateBoard, projectBoardFlow, boardEndpoint, observeBoard, BoardReadError } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const scope = fixtures.empty.scope;
const bindings = fixtures.empty.participants.map(actor => ({ ...scope, threadId: actor.threadId, providerInstanceId: actor.providerInstanceId }));
const roots = bindings.map((binding, index) => ({ key: JSON.stringify([binding.environmentId, binding.threadId]), environmentId: binding.environmentId,
  threadId: binding.threadId, title: '原标题' + index, provider: 'Codex', model: 'controlled', status: '空闲', category: 'idle',
  updatedAt: fixtures.empty.updatedAt, progress: '原进度' }));
const clone = value => structuredClone(value);
const cases = []; let failures = 0;
const check = async (name, action) => test(name, async () => {
  try { await action(); cases.push({ name, passed: true }); }
  catch (error) { failures++; cases.push({ name, passed: false, error: String(error) }); throw error; }
});
const flush = () => new Promise(resolve => setImmediate(resolve));
function controlled() {
  const calls = [], scheduled = new Map(), states = [];
  let connection, released = 0, next = 0;
  const reader = { snapshot: (target, { signal }) => new Promise((resolve, reject) => calls.push({ target, signal, resolve, reject })),
    watchConnection: (target, callback) => { connection = callback; callback(false); return () => released++; } };
  const observer = observeBoard(scope, reader, state => states.push(state), {
    set: (callback, ms) => { const id = ++next; scheduled.set(id, { callback, ms }); return id; },
    clear: id => scheduled.delete(id),
  });
  return { observer, calls, states, scheduled, connect: value => connection(value), released: () => released,
    tick: () => { assert.equal(scheduled.size, 1); const [id, timer] = [...scheduled][0]; scheduled.delete(id); assert.equal(timer.ms, 2000); timer.callback(); },
    current: () => states.at(-1) };
}
await check('real fixed store outputs validate empty, assignment, execution, reports and summary', () => {
  for (const snapshot of Object.values(fixtures)) assert.equal(validateBoard(snapshot, scope, bindings), snapshot);
  assert.equal(projectBoardFlow(roots, fixtures.empty, scope, bindings).edges.length, 0);
  const assigned = projectBoardFlow(roots, fixtures.assigned, scope, bindings);
  assert.equal(assigned.edges.length, 2); assert.equal(assigned.nodes.length, roots.length);
  assert.ok(assigned.nodes.every(node => !node.parentKey && !node.nativeChild));
  const final = projectBoardFlow(roots, fixtures.final, scope, bindings);
  assert.equal(final.edges.length, 4); assert.equal(final.nodes[0].role, '协调 Agent');
  assert.equal(final.nodes[1].role, '执行 Agent'); assert.ok(final.nodes[1].progress.includes('已回报'));
  assert.equal(final.nodes[1].status, roots[1].status); // original runtime remains authoritative
  assert.equal(final.edges[2].target, roots[0].key);
});
await check('exact scope encodes delimiters and rejects old environment or project', () => {
  assert.ok(boardEndpoint({ environmentId: 'env/a?', projectId: 'p/x?' }).includes('p%2Fx%3F'));
  for (const target of [{ ...scope, environmentId: 'other' }, { ...scope, projectId: 'other' }])
    assert.throws(() => validateBoard(fixtures.final, target, bindings));
});
await check('provider mismatch, missing original participant and duplicate identity reject before graph', () => {
  assert.throws(() => projectBoardFlow(roots, fixtures.final, scope, bindings.slice(1)));
  assert.throws(() => validateBoard(fixtures.final, scope, bindings.map(row => ({ ...row, providerInstanceId: 'other' }))));
  const duplicate = clone(fixtures.final); duplicate.participants[1].threadId = duplicate.participants[0].threadId;
  assert.throws(() => validateBoard(duplicate, scope));
});
await check('native ancestry and guessed identities cannot create independent relations', () => {
  const unknown = clone(fixtures.final); delete unknown.participants[0].identitySource;
  assert.throws(() => validateBoard(unknown, scope));
  const fake = clone(fixtures.final); fake.relations[0].sourceThreadId = 'invented-native-parent';
  assert.throws(() => validateBoard(fake, scope));
  const noRoot = roots.slice(1); assert.throws(() => projectBoardFlow(noRoot, fixtures.final, scope, bindings));
});
await check('forged event, revision, reversed edge, omitted edge and unproven assignment read reject', () => {
  for (const mutate of [value => value.relations[0].eventId = 'fake', value => value.relations[0].recordRevision++,
    value => value.relations[0].targetThreadId = value.participants[0].threadId, value => value.relations.pop(),
    value => value.tasks[0].report.assignmentReadEventId = value.tasks[1].report.assignmentReadEventId]) {
    const bad = clone(fixtures.final); mutate(bad); assert.throws(() => validateBoard(bad, scope));
  }
});
await check('summary references exact reports and its coordinator read; unknown source and version reject', () => {
  for (const mutate of [value => value.summary.reportEventIds = ['fake'], value => value.summary.actorId = 'a',
    value => value.source = 'native-child', value => value.revision--, value => value.apiVersion = 'later']) {
    const bad = clone(fixtures.final); mutate(bad); assert.throws(() => validateBoard(bad, scope));
  }
});
await check('visible cold None waits, Some starts one GET, settled polling uses exactly 2 seconds', async () => {
  const rig = controlled(); rig.observer.visible(true); assert.equal(rig.calls.length, 0);
  rig.connect(true); assert.equal(rig.calls.length, 1); rig.calls[0].resolve(fixtures.empty); await flush();
  assert.equal(rig.current().fresh, true); rig.tick(); assert.equal(rig.calls.length, 2);
  rig.calls[1].resolve(fixtures.assigned); await flush(); assert.equal(rig.current().snapshot.revision, 1);
  rig.observer.dispose(); assert.equal(rig.scheduled.size, 0); assert.equal(rig.released(), 1);
});
await check('leaving visible surface aborts in-flight GET, ignores delayed response, and clears timer', async () => {
  const rig = controlled(); rig.observer.visible(true); rig.connect(true);
  rig.observer.visible(false); assert.equal(rig.calls[0].signal.aborted, true);
  rig.calls[0].resolve(fixtures.final); await flush(); assert.equal(rig.current().snapshot, null); assert.equal(rig.scheduled.size, 0);
  rig.observer.visible(true); assert.equal(rig.calls.length, 2); rig.calls[1].resolve(fixtures.final); await flush();
  rig.observer.visible(false); assert.equal(rig.current().fresh, false); assert.equal(rig.scheduled.size, 0); rig.observer.dispose();
});
await check('disconnect invalidates cached relations and reconnect replaces pending old result', async () => {
  const rig = controlled(); rig.observer.visible(true); rig.connect(true); rig.calls[0].resolve(fixtures.assigned); await flush();
  rig.tick(); rig.connect(false); assert.equal(rig.calls[1].signal.aborted, true); assert.equal(rig.current().fresh, false);
  rig.connect(true); rig.calls[2].resolve(fixtures.final); await flush(); rig.calls[1].resolve(fixtures.empty); await flush();
  assert.equal(rig.current().snapshot.revision, fixtures.final.revision); assert.equal(rig.current().fresh, true); rig.observer.dispose();
});
await check('401 error marks cached source unavailable; 404 never retains registered records', async () => {
  const rig = controlled(); rig.observer.visible(true); rig.connect(true); rig.calls[0].resolve(fixtures.final); await flush();
  rig.tick(); rig.calls[1].reject(new BoardReadError(401)); await flush();
  assert.equal(rig.current().phase, 'unavailable'); assert.equal(rig.current().fresh, false); assert.equal(rig.current().snapshot.boardId, fixtures.final.boardId);
  rig.tick(); rig.calls[2].reject(new BoardReadError(404)); await flush();
  assert.equal(rig.current().phase, 'unregistered'); assert.equal(rig.current().snapshot, null); rig.observer.dispose();
});
await check('older revision and changed board cannot overwrite current verified source', async () => {
  const rig = controlled(); rig.observer.visible(true); rig.connect(true); rig.calls[0].resolve(fixtures.final); await flush();
  rig.tick(); rig.calls[1].resolve(fixtures.assigned); await flush(); assert.equal(rig.current().phase, 'unavailable');
  assert.equal(rig.current().snapshot.revision, fixtures.final.revision);
  rig.tick(); rig.calls[2].resolve({ ...fixtures.final, boardId: 'replacement' }); await flush();
  assert.equal(rig.current().fresh, false); assert.equal(rig.current().snapshot.boardId, fixtures.final.boardId); rig.observer.dispose();
});
await check('scope disposal cancels and releases while shared registry/other observers remain alive', async () => {
  const first = controlled(), second = controlled();
  for (const rig of [first, second]) { rig.observer.visible(true); rig.connect(true); }
  first.observer.dispose(); first.calls[0].resolve(fixtures.final); second.calls[0].resolve(fixtures.final); await flush();
  assert.equal(first.calls[0].signal.aborted, true); assert.equal(first.released(), 1);
  assert.equal(first.current().snapshot, null); assert.equal(second.current().fresh, true); second.observer.dispose();
});
await writeFile(join(evidence, 'module-results.json'), JSON.stringify({ evidence: 'controlled fixed-store/UI projection and lifecycle; no real conversations, HTTP or model',
  cases, failures, bundleSha256: createHash('sha256').update(compiled).digest('hex'), fixtureSha256: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'),
  source: await Promise.all(['independent-blackboard.ts', 'blackboard-poll.ts'].map(async file => ({ file, sha256: createHash('sha256').update(await readFile(join(source, file))).digest('hex') }))),
  modelRequests: 0 }, null, 2) + '\n');
if (failures) process.exitCode = 1;
