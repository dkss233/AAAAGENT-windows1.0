import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareDshController, controllerSource } from './dsh-controller.mjs';

const source = process.env.DSH_CONTROLLER_ROOT;
assert.ok(source, 'Set DSH_CONTROLLER_ROOT to the pinned installed controller for native no-model tests');
const artifacts = resolve('artifacts/dsh-controller');
await mkdir(artifacts, { recursive: true });

test('actual pinned native controller selects only the named session and preserves global defaults', async t => {
  const temp = await mkdtemp(join(artifacts, 'native-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const candidate = join(temp, 'controller');
  const result = await prepareDshController(source, candidate);
  assert.equal(result.originalHostModified, false);
  for (const [name, sha] of Object.entries(result.files)) {
    assert.equal(createHash('sha256').update(await readFile(join(candidate, name))).digest('hex'), sha);
  }
  await assert.rejects(prepareDshController(source, candidate), /already exists/);
  await assert.rejects(prepareDshController(candidate, join(temp, 'second')), /source changed/);
  // The temporary entry exposes the real bundled private class to fake service ports.
  // It is never part of the production patch or the candidate fingerprint inventory.
  await symlink(dirname(dirname(source)), join(candidate, 'node_modules'), 'dir');
  await writeFile(join(candidate, 'lib/test-entry.mjs'),
    await readFile(join(candidate, 'lib/index.js'), 'utf8') + '\nexport { SessionCommandController };\n');
  const native = await import(pathToFileURL(join(candidate, 'lib/test-entry.mjs')));
  const { TYPERT: host } = await import(pathToFileURL(join(candidate, 'lib/typert.host.js')));
  const { TYPERT_REMOTE: client } = await import(pathToFileURL(join(candidate, 'lib/typert.remote-client.js')));
  const invocation = (table, name) => (table.invocations ?? table.descriptors).find(row => row.method === name);
  const codec = value => value.schema ?? value.create();
  const selection = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
  const sessions = new Map([['a', { id: 'a' }], ['b', { id: 'b' }]]), picked = new Map();
  const defaults = [];
  const ctx = { llm: {
    async resolveCallConfig(request) { assert.deepEqual(request, selection); return selection; },
    listProviders() { return [{ id: selection.provider, name: 'DeepSeek' }]; },
    async listModels() { return [{ id: selection.model, name: 'Flash' }]; },
    async resolveModelInfo() { return { id: selection.model, name: 'Flash' }; },
  }, agentDefaultModel: { async saveSelection(value) { defaults.push(value); }, currentSelection() { return selection; } },
  logger: { warn() { throw Error('unexpected native warning'); } } };
  const agents = {
    async resolveAgent(id) { return sessions.has(id) ? { agent: sessions.get(id) } : { error: Error('missing exact session') }; },
    async serializeImageAdmission(agent, action) { assert.ok(sessions.has(agent.id)); return action(); },
    selectForNextRequest(agent, value) { picked.set(agent.id, value); },
  };
  const commands = new native.SessionCommandController(ctx, agents, '/synthetic');
  const requested = { sessionId: 'a', ...selection, scope: 'session' };
  const request = codec(invocation(host, 'selectModel').parameters[0].codec).parse(requested);
  assert.equal(request.scope, 'session', 'native wire decoder must not strip the safety field');
  const answer = await commands.selectModel(request);
  assert.deepEqual(codec(invocation(client, 'selectModel').result).parse(answer), { selected: selection, scope: 'session' });
  assert.deepEqual(defaults, []);
  assert.deepEqual(picked.get('a'), selection);
  assert.equal(picked.has('b'), false);
  const catalogue = await native.SessionController.prototype.modelCatalog.call({ ctx });
  assert.equal(codec(invocation(host, 'modelCatalog').result).parse(catalogue).sessionModelSelectionVersion, 1);
  assert.equal(codec(invocation(client, 'modelCatalog').result).parse(catalogue).sessionModelSelectionVersion, 1);
  assert.deepEqual(defaults, []);
  await commands.selectModel({ sessionId: 'b', ...selection });
  assert.equal(defaults.length, 1, 'original native callers retain the preexisting global-default behavior');
  assert.throws(() => codec(invocation(host, 'selectModel').parameters[0].codec).parse({ ...requested, scope: 'global' }));
  await assert.rejects(commands.selectModel({ ...requested, scope: 'global' }), /invalid model selection scope/);
  await assert.rejects(commands.selectModel({ ...requested, sessionId: 'missing' }), /missing exact session/);
  assert.equal(defaults.length, 1);
  for (const [name, sha] of Object.entries(controllerSource.files)) {
    assert.equal(createHash('sha256').update(await readFile(join(source, name))).digest('hex'), sha,
      'original native package is unchanged: ' + name);
  }
});

test('native scoped trial blocks tools and retries without changing another native session', async t => {
  const packages = dirname(source);
  const { Context } = await import(pathToFileURL(join(packages, 'cordis/lib/index.js')));
  const { SystemPrompt } = await import(pathToFileURL(join(packages, 'dsh-system-prompt/lib/index.js')));
  const { ToolRuntime } = await import(pathToFileURL(join(packages, 'dsh-tools/lib/index.js')));
  const { createScope, scopeTarget } = await import(pathToFileURL(join(packages, 'dsh-scope/lib/index.js')));
  const trial = await import('./dsh-trial.mjs');
  const { apply, DSH_TRIAL_INPUT, DSH_TRIAL_MAX_TOKENS, dshTrialPresetFiles } = trial;
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime);
  t.after(() => ctx.fiber.dispose());
  let globalRetries = 0;
  ctx.on('agent/request-error', async () => { globalRetries++; return { kind: 'retry' }; });
  ctx.tools.register({ name: 'fixture_tool', description: 'Synthetic only', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { throw Error('must never execute'); } });
  const old = { id: 'old', session: { snapshotEvents: () => [] } };
  const agent = { id: 'trial', session: { snapshotEvents: () => [] } };
  const binding = { sessionId: agent.id, requestId: 'one-request' };
  const scope = createScope(ctx, agent); await scope.ctx.plugin(trial, binding);
  assert.throws(() => apply(ctx, binding), /requires a scoped context/);
  assert.equal(ctx.tools.schemas(old).length, 1);
  assert.deepEqual(ctx.tools.schemas(agent), []);
  const target = scopeTarget(agent, agent), route = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };
  const decision = { kind: 'enter', messages: [{ source: { kind: 'user', rpcId: 'one-request' }, content: [{ type: 'text', text: DSH_TRIAL_INPUT }] }] };
  assert.equal((await ctx.waterfall(target, 'agent/pre-step', { agent, step: 1 }, async () => decision)).kind, 'enter');
  assert.equal((await ctx.waterfall(target, 'agent/pre-step', { agent, step: 2 }, async () => decision)).kind, 'reject');
  assert.deepEqual(await ctx.waterfall(target, 'agent/request', { agent }, async () => route), { ...route, maxTokens: DSH_TRIAL_MAX_TOKENS });
  await assert.rejects(ctx.waterfall(target, 'agent/request', { agent }, async () => route), /no retry/);
  assert.equal(await ctx.waterfall(target, 'agent/request-error', { agent }, async () => undefined), undefined);
  assert.equal(globalRetries, 0);
  assert.deepEqual(await ctx.waterfall(scopeTarget(old, old), 'agent/request-error', { agent: old }, async () => undefined), { kind: 'retry' });
  assert.equal(globalRetries, 1, 'existing native sessions keep their original retry behavior');
  // A fresh scope after a Host restart still refuses a logged earlier request.
  const restored = { id: 'trial', session: { snapshotEvents: () => [{ type: 'request/header' }] } };
  const resumed = createScope(ctx, restored); await resumed.ctx.plugin(trial, binding);
  await assert.rejects(ctx.waterfall(scopeTarget(restored, restored), 'agent/request', { agent: restored }, async () => route), /no retry/);
  await resumed.dispose();
  const files = dshTrialPresetFiles(new URL('./dsh-trial.mjs', import.meta.url), binding);
  assert.match(files['agent.cordis.yml'], /complete: true/);
  assert.match(files['agent.cordis.yml'], /includeRuntimeContext: false/);
  assert.equal(Object.keys(files).length, 2);
  assert.throws(() => dshTrialPresetFiles(new URL('./dsh-trial.mjs', import.meta.url)), /binding required/);
  const stranger = { ...agent, id: 'another-session' };
  const wrong = createScope(ctx, stranger); await wrong.ctx.plugin(trial, binding);
  // Use the exact scope key for dispatch, while testing a foreign user request in the original scope.
  assert.equal((await ctx.waterfall(target, 'agent/pre-step', { agent, step: 1 }, async () => ({ ...decision,
    messages: [{ ...decision.messages[0], source: { kind: 'user', rpcId: 'another-request' } }] }))).kind, 'reject');
  await assert.rejects(ctx.waterfall(scopeTarget(stranger, stranger), 'agent/request', { agent: stranger }, async () => route), /another session/);
  await wrong.dispose(); await scope.dispose();
});

test('actual native agent loop submits one bounded synthetic request, projects text and rejects re-entry', async t => {
  const packages = dirname(source);
  const native = async name => import(pathToFileURL(join(packages, name, 'lib/index.js')));
  const { Context } = await native('cordis');
  const llm = await native('dsh-llm');
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  for (const name of ['dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent']) {
    await ctx.plugin((await native(name)).default);
  }
  await ctx.plugin((await native('dsh-agent-loop')).default, { agents: [] });
  await ctx.plugin((await native('dsh-session-title')).default, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 });
  await ctx.plugin(await native('dsh-session-title-first-prompt-llm'), {
    targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000 });
  const trial = await import('./dsh-trial.mjs'), requests = [];
  const persona = await native('dsh-persona');
  let failures = false, retries = 0;
  ctx.on('agent/request-error', async () => { retries++; return { kind: 'retry' }; });
  class FakeAdapter extends llm.LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model,
      reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }; }
    async *stream(options) {
      requests.push(options);
      if (failures) { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TEST', message: 'synthetic failure', retryable: true } } }; return; }
      const text = 'AAA_B54_DSH_OK';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['deepseek-official'], new FakeAdapter());
  const create = sessionId => ctx.agents.create({ sessionId, meta: { cwd: '/synthetic-only' },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
    async setup(agentCtx) { await agentCtx.plugin(persona, { prefix: trial.DSH_TRIAL_SYSTEM, complete: true, includeRuntimeContext: false });
      await agentCtx.plugin(trial, { sessionId, requestId: 'exact-original-request' }); } });
  const send = async agent => { agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: trial.DSH_TRIAL_INPUT }],
    source: { kind: 'user', rpcId: 'exact-original-request' } })); await agent.whenIdle(); };
  const handle = await create('native-trial-success'), agent = handle.agent;
  ctx.sessionTitle.rename(agent.session, 'Synthetic pinned title');
  await send(agent);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].maxTokens, trial.DSH_TRIAL_MAX_TOKENS);
  assert.equal(requests[0].reasoningEffort, 'high'); assert.deepEqual(requests[0].tools ?? [], []);
  assert.deepEqual(requests[0].messages.map(m => ({ role: m.role, content: m.content })), [
    { role: 'system', content: [{ type: 'text', text: trial.DSH_TRIAL_SYSTEM }] },
    { role: 'user', content: [{ type: 'text', text: trial.DSH_TRIAL_INPUT }] },
  ]);
  assert.equal(agent.session.snapshotEvents().find(e => e.type === 'assistant/message').data.message.content[0].text, 'AAA_B54_DSH_OK');
  assert.equal(agent.session.snapshotEvents().filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'completed');
  await send(agent); assert.equal(requests.length, 1);
  failures = true;
  const failed = await create('native-trial-failure');
  ctx.sessionTitle.rename(failed.agent.session, 'Synthetic failure title'); await send(failed.agent);
  assert.equal(requests.length, 2); assert.equal(retries, 0);
  assert.equal(failed.agent.session.snapshotEvents().filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'error');
  await send(failed.agent); assert.equal(requests.length, 2);
  assert.equal([...agent.session.snapshotEvents(), ...failed.agent.session.snapshotEvents()]
    .filter(event => event.type === 'session/title-llm-request').length, 0);
});
