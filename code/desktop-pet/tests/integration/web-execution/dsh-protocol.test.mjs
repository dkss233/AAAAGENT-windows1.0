import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { mkdir, writeFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const source = resolve(process.env.DSH_WEB_SOURCE), sdk = resolve(process.env.DSH_SDK_ROOT);
let HttpDshSessionRpc, makeDshHostProtocol, readDshAttachments, dshInputDigest, wire, descriptors;
before(async () => {
  const root = join(source, 'apps/server'), out = join(root, 'dist'); await mkdir(out, { recursive: true });
  for (const name of ['DshHostProtocol', 'DshWebInput']) {
    await build({ entryPoints: [join(root, 'src/provider/Layers/' + name + '.ts')],
      outfile: join(out, name + '.mjs'), bundle: true, platform: 'node', format: 'esm',
      external: ['effect', 'effect/*', '@effect/platform-node/*', '@effect/platform-node-shared/*'],
      banner: { js: 'import { createRequire } from "node:module";const require=createRequire(import.meta.url);' } });
  }
  ({ HttpDshSessionRpc, makeDshHostProtocol } = await import(pathToFileURL(join(out, 'DshHostProtocol.mjs'))));
  ({ readDshAttachments, dshInputDigest } = await import(pathToFileURL(join(out, 'DshWebInput.mjs'))));
  wire = await import(pathToFileURL(join(sdk, 'dsh-api-gateway/lib/types/stream-protocol.js')));
  descriptors = new Map();
  for (const name of ['dsh-commands', 'dsh-user-questions', 'dsh-api-session-controller', 'dsh-permission-presets']) {
    const { TYPERT } = await import(pathToFileURL(join(sdk, name, 'lib/typert.host.js')));
    for (const descriptor of TYPERT.invocations) descriptors.set(descriptor.namespace + '/' + descriptor.method, descriptor);
  }
});

async function fixture(t) {
  const require = createRequire(join(source, 'package.json'));
  const { NodeWS } = await import(pathToFileURL(require.resolve('@effect/platform-node/NodeSocket')));
  const state = { preset: 'workspace-write', stream: null, clientId: null, received: [], uploads: [], generation: 0,
    events: [{ seq: 0, type: 'sandbox/mode', data: { mode: 'workspace-write' } },
      { seq: 1, type: 'approval/policy', data: { policy: 'ask' } },
      { seq: 2, type: 'turn/start', data: { turn: 7 } },
      { seq: 3, type: 'user/message', data: { source: { kind: 'user', rpcId: 'request-1' } } }],
    running: true, questions: [], noOp: false };
  const append = (type, data) => state.events.push({ seq: state.events.at(-1).seq + 1, type, data });
  const native = createServer((request, response) => { void (async () => {
    if (request.url.startsWith('/?token=')) { response.writeHead(303, { location: './', 'set-cookie': 'sid=fixture-cookie; Path=/' }); response.end(); return; }
    assert.equal(request.headers.cookie, 'sid=fixture-cookie');
    assert.equal(request.headers.origin, origin);
    response.setHeader('Content-Type', 'application/json');
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const bytes = Buffer.concat(chunks);
    if (request.url.startsWith('/api/session/uploadFileBinary?')) {
      const query = new URL(request.url, origin).searchParams;
      assert.equal(query.get('sessionId'), 'session-1'); assert.equal(request.headers['content-type'], 'application/octet-stream');
      state.uploads.push(bytes);
      response.end(JSON.stringify({ ok: true, value: { receiptId: 'upload-1', file: { attachmentId: 'native-file', name: query.get('name'), bytes: bytes.length } } })); return;
    }
    const envelope = JSON.parse(bytes), { method, rpcId, payload: { args } } = envelope;
    assert.equal(envelope.type, 'client-request');
    state.received.push({ method, args });
    const descriptor = descriptors.get(method);
    if (descriptor) {
      assert.deepEqual(Object.keys(args).sort(), descriptor.parameters.map(parameter => parameter.wire).sort());
      for (const parameter of descriptor.parameters) parameter.codec.create().parse(args[parameter.wire]);
    }
    let value;
    if (method === 'session/list') value = { items: [{ sessionId: 'session-1', cwd: '/fixture/project', running: state.running,
      projections: { asOfSeq: state.events.at(-1).seq, values: { agentPreset: 'fixture-preset', permissions: { currentValue: state.preset },
        userQuestions: { active: state.questions, settled: [] } } } }] };
    else if (method === 'session/page') {
      const end = Math.min(args.request.throughSeq + 1, args.request.beforeSeq ?? state.events.length);
      const start = Math.max(0, end - (state.pageSize ?? state.events.length));
      value = { records: state.events.slice(start, end).map(event => ({ type: 'event', event })), hasMore: start > 0 };
    }
    else if (method === 'permissionPresets/catalog') {
      const options = [{ value: 'workspace-write', name: 'workspace-write' }, { value: 'danger-full-access', name: 'danger-full-access' }];
      value = { options, defaultOptions: options, defaultPreset: 'workspace-write' };
    }
    else if (method === 'commands/execute') {
      state.preset = args.line.slice('/permission '.length); append('sandbox/mode', { mode: state.preset });
      append('approval/policy', { policy: state.preset === 'workspace-write' ? 'ask' : 'never' });
      value = { commandId: 'native-command', result: { kind: 'success' } };
    } else if (method === 'session/prompt' || method === 'session/cancel') value = { accepted: true };
    else if (method === 'userQuestions/answer') value = state.questions.some(question => question.callId === args.callId);
    else if (method === '$events/result') {
      wire.parseRemoteEventResult(args);
      if (!state.noOp && args.outcome.kind === 'result' && args.clientId === state.clientId) {
        const audit = state.events.find(event => event.type === 'approval/asked');
        if (audit) append('approval/decided', { id: audit.data.id, outcome: state.originalWinner ?? args.outcome.value });
        state.stream?.send(JSON.stringify({ type: 'item', streamId: state.streamId, value: { type: 'cancel', eventId: args.eventId } }));
      }
      value = undefined;
    } else throw Error('Unexpected fixture method');
    // Existing bounded readers use this minimal native-history fixture. New
    // operations additionally validate their complete SDK response schemas.
    if (descriptor && !['session/list','session/page'].includes(method)) descriptor.result.create().parse(value);
    response.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }));
  })().catch(error => { response.writeHead(500); response.end(JSON.stringify({ fixtureError: error.message })); }); });
  native.listen(0, '127.0.0.1'); await once(native, 'listening'); const origin = 'http://127.0.0.1:' + native.address().port;
  const sockets = new NodeWS.WebSocketServer({ server: native });
  sockets.on('connection', (socket, request) => {
    assert.equal(request.url, '/api/remote.mux'); assert.equal(request.headers.cookie, 'sid=fixture-cookie'); assert.equal(request.headers.origin, origin);
    state.stream = socket;
    socket.on('message', bytes => {
      const open = wire.parseRemoteStreamClientMessage(bytes.toString()); assert.equal(open.endpoint, '$events');
      state.streamId = open.streamId; state.clientId = 'client-' + (++state.generation);
      socket.send(JSON.stringify({ type: 'item', streamId: open.streamId, value: { type: 'ready', clientId: state.clientId, host: { home: '/fixture' } } }));
    });
  });
  const rpc = new HttpDshSessionRpc(async () => origin + '/?token=fixture-token');
  const host = makeDshHostProtocol(rpc);
  t.after(async () => { rpc.events.close(); for (const socket of sockets.clients) socket.terminate(); sockets.close();
    native.closeAllConnections(); await new Promise(done => native.close(done)); });
  async function frame(eventId, event, request, agentId = 'session-1') {
    await host.retain('session-1');
    state.stream.send(JSON.stringify({ type: 'item', streamId: state.streamId,
      value: { type: 'waterfall', eventId, agentId, event, request } }));
    await new Promise(done => setTimeout(done, 25));
  }
  return { state, host, rpc, append, frame };
}

test('native permission catalog is scoped and unsupported modes never dispatch or upgrade', async t => {
  const f = await fixture(t);
  await f.host.permission('session-1', 'auto-accept-edits');
  assert.equal(f.state.received.filter(call => call.method === 'commands/execute').length, 0);
  await assert.rejects(f.host.permission('session-1', 'approval-required'));
  await assert.rejects(f.host.permission('session-1', 'auto'));
  await f.host.permission('session-1', 'full-access');
  assert.deepEqual(f.state.received.filter(call => call.method === 'commands/execute').map(call => call.args),
    [{ agentId: 'session-1', line: '/permission danger-full-access', submittedAttachments: [] }]);
  assert.equal(f.state.received.some(call => call.method.startsWith('settings')), false);
});

test('long permission history uses stable original pagination beyond sixteen pages', async t => {
  const f = await fixture(t); f.state.pageSize = 6;
  for (let n = 0; n < 120; n++) f.append('tool/call', { name: 'read', callId: 'controlled-' + n });
  await f.host.permission('session-1', 'auto-accept-edits');
  const pages = f.state.received.filter(call => call.method === 'session/page');
  assert(pages.length > 16); assert.equal(f.state.received.some(call => call.method === 'commands/execute'), false);
  assert(pages.every(call => call.args.request.throughSeq === 123));
  assert(pages.slice(1).every((call, n) => call.args.request.beforeSeq < (pages[n].args.request.beforeSeq ?? 124)));
  await f.host.retain('session-1');
  assert.equal((await f.host.observe('session-1', 'request-1')).nativeTurn, 7);
});

test('binary upload and native file/image prompt preserve bytes, receipt scope and frozen command', async t => {
  const f = await fixture(t), bytes = Buffer.from('UTF-8 附件标记 B56');
  const image = Buffer.from('fixture-image');
  await f.host.prompt('session-1', 'request-1', 'inspect original files', [
    { attachment: { type: 'file', name: 'fixture.txt' }, bytes },
    { attachment: { type: 'image', name: 'fixture.png', mimeType: 'image/png' }, bytes: image },
  ]);
  assert.equal(createHash('sha256').update(f.state.uploads[0]).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  const sent = f.state.received.find(call => call.method === 'session/prompt').args.request;
  assert.equal(sent.sessionId, 'session-1'); assert.equal(sent.requestId, 'request-1');
  assert.deepEqual(sent.content, [{ type: 'text', text: 'inspect original files' }, { type: 'file', receiptId: 'upload-1' },
    { type: 'image', mediaType: 'image/png', data: image.toString('base64'), name: 'fixture.png' }]);
});

test('live approval uses gateway identity but only the distinct native audit confirms it', async t => {
  const f = await fixture(t);
  f.append('approval/asked', { id: 'audit-1', toolName: 'bash', callId: 'call-1', reason: 'fixture approval' });
  await f.frame('event-1', 'approval/request', { toolName: 'bash', callId: 'call-1', reason: 'fixture approval' });
  assert.equal((await f.host.observe('session-1', 'request-1')).approvals[0].actionable, true);
  await assert.rejects(f.host.approve('session-1', 'request-1', 'event-1', 'accept'));
  await f.host.approve('session-1', 'request-1', 'audit-1', 'accept');
  const result = f.state.received.find(call => call.method === '$events/result').args;
  assert.equal(result.eventId, 'event-1'); assert.equal(result.clientId, 'client-1');
  assert.equal((await f.host.observe('session-1', 'request-1')).approvals[0].outcome, 'allowed-once');
  await assert.rejects(f.host.approve('session-1', 'request-1', 'audit-1', 'accept'));
});

test('ambiguous audits stay closed and an old connection cannot authorize after reconnect', async t => {
  const f = await fixture(t);
  for (const id of ['audit-1','audit-2']) f.append('approval/asked', { id, toolName: 'bash' });
  await f.frame('event-1', 'approval/request', { toolName: 'bash' });
  assert.equal((await f.host.observe('session-1', 'request-1')).approvals.some(audit => audit.actionable), false);
  await assert.rejects(f.host.approve('session-1', 'request-1', 'audit-1', 'accept'));
  const old = f.rpc.events.list('session-1')[0]; f.state.stream.terminate(); await new Promise(done => setTimeout(done, 25));
  await f.host.retain('session-1');
  await assert.rejects(f.rpc.events.answer(old, 'allowed-once'));
  assert.equal(f.state.received.filter(call => call.method === '$events/result').length, 0);
  await f.frame('foreign', 'approval/request', { toolName: 'bash' }, 'foreign-session');
  assert.deepEqual(f.state.received.at(-1).args.outcome, { kind: 'next' });
});

test('no-op HTTP approval result stays unknown and cannot replay the authorization', async t => {
  const f = await fixture(t); f.state.noOp = true;
  f.append('approval/asked', { id: 'audit-1', toolName: 'bash', callId: 'call-1' });
  await f.frame('event-1', 'approval/request', { toolName: 'bash', callId: 'call-1' });
  await assert.rejects(f.host.approve('session-1', 'request-1', 'audit-1', 'accept'));
  await assert.rejects(f.host.approve('session-1', 'request-1', 'audit-1', 'accept'));
  assert.equal(f.state.received.filter(call => call.method === '$events/result').length, 1);
});

test('exact native active turn and complete continued question are required', async t => {
  const f = await fixture(t);
  await assert.rejects(f.host.interrupt('session-1', 'foreign-request'));
  await f.host.interrupt('session-1', 'request-1');
  f.append('tool/call', { name: 'ask_user_question', callId: 'question-1' });
  f.state.questions = [{ callId: 'question-1', state: 'continued', questions: [{ id: 'q1', question: 'Choice?', options: [{ label: 'yes' }] }] }];
  await assert.rejects(f.host.answer('session-1', 'request-1', 'question-1', {}));
  await f.host.answer('session-1', 'request-1', 'question-1', { q1: { answers: ['yes'] } });
  const answer = f.state.received.find(call => call.method === 'userQuestions/answer');
  assert.deepEqual(answer.args, { agentId: 'session-1', callId: 'question-1', answer: { answers: [{ id: 'q1', selected: ['yes'] }] } });
});

test('continued question follows only its exact native reply lineage in the same SID', async t => {
  const f = await fixture(t); f.state.pageSize = 6;
  await f.host.retain('session-1');
  f.append('tool/call', { name: 'ask_user_question', callId: 'question-1' });
  f.append('turn/end', { turn: 7, reason: { kind: 'completed' } });
  f.state.running = false;
  f.state.questions = [{ callId: 'question-1', state: 'continued', questions: [{ id: 'q1', question: 'Choice?' }] }];
  await f.host.answer('session-1', 'request-1', 'question-1', { q1: 'yes' });
  // An unrelated original-client turn must not be attached to this command.
  f.append('turn/start', { turn: 8 });
  f.append('user/message', { source: { kind: 'user-question-reply', callId: 'foreign-question', outcome: 'answered' } });
  f.append('assistant/message', { turn: 8, message: { content: [{ type: 'text', text: 'foreign reply' }] } });
  f.append('turn/end', { turn: 8, reason: { kind: 'completed' } });
  f.append('turn/start', { turn: 9 });
  f.append('user/message', { source: { kind: 'user-question-reply', callId: 'question-1', outcome: 'answered' } });
  f.append('assistant/message', { turn: 9, message: { content: [{ type: 'text', text: 'exact continued reply' }] } });
  f.append('turn/end', { turn: 9, reason: { kind: 'completed' } }); f.state.questions = [];
  const observed = await f.host.observe('session-1', 'request-1');
  assert.equal(observed.nativeTurn, 7); assert.equal(observed.status, 'completed');
  assert.deepEqual(observed.followUps.map(turn => ({ callId: turn.callId, nativeTurn: turn.nativeTurn, status: turn.status, messages: turn.messages })),
    [{ callId: 'question-1', nativeTurn: 9, status: 'completed', messages: [{ seq: 12, text: 'exact continued reply' }] }]);
  assert.equal(f.state.received.filter(call => call.method === 'session/prompt').length, 0);
  assert.equal(f.state.received.filter(call => call.method === 'userQuestions/answer').length, 1);
  // A second reply admission for the same call is ambiguous, even in this SID.
  f.append('turn/start', { turn: 10 });
  f.append('user/message', { source: { kind: 'user-question-reply', callId: 'question-1', outcome: 'answered' } });
  f.append('turn/end', { turn: 10, reason: { kind: 'completed' } });
  assert.equal((await f.host.observe('session-1', 'request-1')).status, 'unknown');
});

test('another native client decision is reported as its actual outcome and cannot be credited to this client', async t => {
  const f = await fixture(t); f.state.originalWinner = 'rejected';
  f.append('approval/asked', { id: 'audit-1', toolName: 'bash', callId: 'call-1' });
  await f.frame('event-1', 'approval/request', { toolName: 'bash', callId: 'call-1' });
  await assert.rejects(f.host.approve('session-1', 'request-1', 'audit-1', 'accept'));
  assert.equal((await f.host.observe('session-1', 'request-1')).approvals[0].outcome, 'rejected');
});

test('an uncertain authorization remains disabled when the same native event is redelivered', async t => {
  const f = await fixture(t); f.state.noOp = true;
  f.append('approval/asked', { id: 'audit-1', toolName: 'bash', callId: 'call-1' });
  await f.frame('event-1', 'approval/request', { toolName: 'bash', callId: 'call-1' });
  await assert.rejects(f.host.approve('session-1', 'request-1', 'audit-1', 'accept'));
  f.state.stream.terminate(); await new Promise(done => setTimeout(done, 25));
  await f.frame('event-1', 'approval/request', { toolName: 'bash', callId: 'call-1' });
  assert.equal((await f.host.observe('session-1', 'request-1')).approvals[0].actionable, false);
  await assert.rejects(f.host.approve('session-1', 'request-1', 'audit-1', 'accept'));
  assert.equal(f.state.received.filter(call => call.method === '$events/result').length, 1);
});

test('open question response uses the live native waterfall and rejects a foreign question', async t => {
  const f = await fixture(t);
  f.append('tool/call', { name: 'ask_user_question', callId: 'question-1' });
  f.state.questions = [{ callId: 'question-1', state: 'open', questions: [{ id: 'q1', question: 'Choice?', options: [{ label: 'yes' }] }] }];
  await f.frame('event-question', 'user-questions/request', { wait: { callId: 'question-1', timed: true }, questions: f.state.questions[0].questions });
  await assert.rejects(f.host.answer('session-1', 'foreign-request', 'question-1', { q1: 'yes' }));
  await f.host.answer('session-1', 'request-1', 'question-1', { q1: 'yes' });
  assert.deepEqual(f.state.received.find(call => call.method === '$events/result').args.outcome,
    { kind: 'result', value: { answers: [{ id: 'q1', selected: ['yes'] }] } });
  assert.equal(f.state.received.some(call => call.method === 'userQuestions/answer'), false);
});

test('original upload IDs freeze actual byte hashes and refuse missing, changed-size and linked files', async t => {
  const directory = await mkdtemp(join(source, 'uploads-')); t.after(() => rm(directory, { recursive: true }));
  const attachment = { type: 'file', id: 'fixture-attachment', name: 'fixture.txt', mimeType: 'text/plain', sizeBytes: 4 };
  await writeFile(join(directory, attachment.id + '.txt'), 'AAAA');
  const original = readDshAttachments(directory, [attachment]), digest = dshInputDigest('session-1','request-1','text',original);
  await writeFile(join(directory, attachment.id + '.txt'), 'BBBB');
  assert.notEqual(dshInputDigest('session-1','request-1','text',readDshAttachments(directory,[attachment])), digest);
  assert.throws(() => readDshAttachments(directory,[{...attachment,sizeBytes:5}]));
  assert.throws(() => readDshAttachments(directory,[{...attachment,id:'missing'}]));
  await symlink(join(directory, attachment.id + '.txt'),join(directory,'linked.txt'));
  assert.throws(() => readDshAttachments(directory,[{...attachment,id:'linked'}]));
});

test('releasing a session revokes a pending event handshake and cold reads cannot reacquire it', async t => {
  const f = await fixture(t);
  let unlock;
  const events = new f.rpc.events.constructor(() => new Promise(done => { unlock = done; }), async () => {});
  const pending = events.retain('session-1');
  events.release('session-1');
  unlock({ origin: 'http://127.0.0.1:1', cookie: 'fixture-only' });
  await assert.rejects(pending, /expired/);
  await f.host.retain('session-1'); f.host.release('session-1');
  const calls = f.state.received.length;
  await assert.rejects(f.host.observe('session-1', 'request-1'), /expired/);
  assert.equal(f.state.received.length, calls);
});
