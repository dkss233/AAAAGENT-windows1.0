import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import Database from 'better-sqlite3';
import { T3ChildService } from '../../../../workbench/integration/t3-child-service.mjs';
import { T3HttpClient } from '../../../../workbench/integration/t3-http-client.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const wait = ms => new Promise(done => setTimeout(done, ms));
async function until(read, description) {
  for (let n = 0; n < 100; n++) { const value = read(); if (value) return value; await wait(100); }
  throw Error(description);
}

// This Host is an isolated peer. It has no provider credentials or outbound model route.
async function controlledHost(t, NodeWS, cwd) {
  const state = { sessions: new Map(), calls: [], uploads: [], stream: null, streamId: null };
  const append = (session, type, data) => session.events.push({ seq: session.events.length, time: Date.now(), type, data });
  const host = createServer((request, response) => { void (async () => {
    if (request.url === '/?token=controlled-host') {
      response.writeHead(303, { location: './', 'set-cookie': 'sid=controlled; Path=/' }); response.end(); return;
    }
    assert.equal(request.headers.cookie, 'sid=controlled'); assert.equal(request.headers.origin, origin);
    const chunks = []; for await (const chunk of request) chunks.push(chunk); const bytes = Buffer.concat(chunks);
    response.setHeader('Content-Type', 'application/json');
    if (request.url.startsWith('/api/session/uploadFileBinary?')) {
      const query = new URL(request.url, origin).searchParams;
      assert(state.sessions.has(query.get('sessionId')));
      state.uploads.push({ sessionId: query.get('sessionId'), name: query.get('name'), hash: digest(bytes) });
      response.end(JSON.stringify({ ok: true, value: { receiptId: 'controlled-file',
        file: { attachmentId: 'controlled-attachment', bytes: bytes.length } } })); return;
    }
    const envelope = JSON.parse(bytes); assert.equal(envelope.type, 'client-request');
    const { method, rpcId, payload: { args } } = envelope; state.calls.push({ method, args });
    const session = state.sessions.get(args.request?.sessionId ?? args.agentId);
    let value;
    if (method === 'session/modelCatalog') value = { sessionModelSelectionVersion: 1, failures: [],
      routableProviders: ['controlled'], default: { provider: 'controlled', model: 'first' },
      groups: [{ id: 'controlled', name: 'Controlled peer', models: ['first', 'second'].map(id => ({ id, name: id })) }] };
    else if (method === 'session/list') value = { items: [...state.sessions.values()].map(s => ({
      sessionId: s.id, cwd, running: s.running,
      projections: { asOfSeq: s.events.length - 1, values: { agentPreset: 'controlled-preset', title: s.title,
        permissions: { currentValue: s.mode }, userQuestions: { active: s.questions, settled: [] } } } })) };
    else if (method === 'session/create') {
      assert.equal(args.request.cwd, cwd); assert.equal(args.request.agentPreset, 'controlled-preset');
      assert.equal(state.sessions.has(args.request.sessionId), false);
      const s = { id: args.request.sessionId, mode: 'workspace-write', title: '', events: [], running: false, questions: [], turn: 0 };
      append(s, 'sandbox/mode', { mode: s.mode }); append(s, 'approval/policy', { policy: 'ask' }); state.sessions.set(s.id, s);
      value = { sessionId: s.id, agentPreset: 'controlled-preset' };
    } else if (method === 'session/page') {
      assert.equal(args.request.address.kind, 'session'); const s = state.sessions.get(args.request.address.sessionId); assert(s);
      const end = Math.min(args.request.throughSeq + 1, args.request.beforeSeq ?? s.events.length);
      value = { records: s.events.slice(0, end).map(event => ({ type: 'event', event })), hasMore: false };
    } else if (method === 'permissionPresets/catalog') {
      const options = ['workspace-write', 'danger-full-access'].map(value => ({ value, name: value }));
      value = { options, defaultOptions: options, defaultPreset: 'workspace-write' };
    } else if (method === 'commands/execute') {
      assert(session); session.mode = args.line.slice('/permission '.length);
      append(session, 'sandbox/mode', { mode: session.mode }); append(session, 'approval/policy', { policy: session.mode === 'workspace-write' ? 'ask' : 'never' });
      value = { commandId: 'controlled-permission', result: { kind: 'success' } };
    } else if (method === 'session/selectModel') {
      assert.equal(args.request.scope, 'session'); assert.equal(args.request.provider, 'controlled'); assert(session);
      value = { scope: 'session', selected: { provider: 'controlled', model: args.request.model } };
    } else if (method === 'session/rename') {
      assert(session); session.title = args.request.title; value = { title: session.title, seq: session.events.length - 1 };
    } else if (method === 'session/prompt') {
      assert(session); session.running = true; session.turn++;
      append(session, 'turn/start', { turn: session.turn });
      append(session, 'user/message', { id: randomUUID(), role: 'user', content: args.request.content, source: { kind: 'user', rpcId: args.request.requestId } });
      if (session.turn === 2) {
        append(session, 'tool/call', { name: 'ask_user_question', callId: 'controlled-question' });
        session.questions = [{ callId: 'controlled-question', state: 'continued', questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'yes' }] }] }];
      }
      append(session, 'assistant/message', { turn: session.turn, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'controlled reply ' + session.turn }] } });
      append(session, 'turn/end', { turn: session.turn, reason: { kind: 'completed' } }); session.running = false; value = { accepted: true };
    } else if (method === 'userQuestions/answer') {
      assert(session); assert.equal(args.callId, 'controlled-question');
      assert.deepEqual(args.answer, { answers: [{ id: 'q1', selected: ['yes'] }] });
      assert.equal(session.turn, 2);
      // Mirrors the original SDK steer source and admission in the same SID.
      session.turn++; session.running = true; session.questions = [];
      append(session, 'turn/start', { turn: session.turn });
      append(session, 'user/message', { id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'native question answer yes' }], source: { kind: 'user-question-reply', callId: args.callId, outcome: 'answered' } });
      append(session, 'assistant/message', { turn: session.turn, message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text: 'actual question follow-up reply' }] } });
      append(session, 'turn/end', { turn: session.turn, reason: { kind: 'completed' } }); session.running = false; value = true;
    } else throw Error('Unexpected controlled Host method: ' + method);
    response.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }));
  })().catch(error => { response.statusCode = 500; response.end(JSON.stringify({ fixtureError: error.message })); }); });
  host.listen(0, '127.0.0.1'); await once(host, 'listening'); const origin = 'http://127.0.0.1:' + host.address().port;
  const sockets = new NodeWS.WebSocketServer({ server: host });
  sockets.on('connection', (socket, request) => {
    assert.equal(request.url, '/api/remote.mux'); assert.equal(request.headers.cookie, 'sid=controlled');
    socket.on('message', bytes => {
      const open = JSON.parse(bytes); assert.equal(open.endpoint, '$events'); state.stream = socket; state.streamId = open.streamId;
      socket.send(JSON.stringify({ type: 'item', streamId: open.streamId, value: { type: 'ready', clientId: 'controlled-client', host: { home: '/controlled' } } }));
    });
  });
  t.after(async () => { for (const s of sockets.clients) s.terminate(); sockets.close(); host.closeAllConnections(); await new Promise(done => host.close(done)); });
  return { state, origin };
}

test('complete fixed server keeps two DSH prompts and original question follow-up in one SID', async t => {
  const evidence = resolve(process.env.DSH_SERVER_EVIDENCE), runtime = resolve(process.env.DSH_SERVER_RUNTIME),
    source = resolve(process.env.DSH_WEB_SOURCE), node = resolve(process.env.DSH_FIXED_NODE);
  assert(evidence.includes('/artifacts/W0-I/web-execution-56')); assert(runtime.startsWith(evidence + '/artifacts/runtime/'));
  assert.equal(digest(await readFile(join(runtime, 'apps/server/dist/bin.mjs'))), '33f8c0754f019d8fcbca6b2baf052b70d4fb397b0b7bcaab8d7da913a81bde5e');
  const root = await mkdtemp(join(evidence, 'server-chain-')), cwd = join(root, 'project'); await mkdir(cwd);
  const require = createRequire(join(source, 'package.json'));
  const { NodeWS } = await import(pathToFileURL(require.resolve('@effect/platform-node/NodeSocket')));
  const host = await controlledHost(t, NodeWS, cwd), log = join(root, 'controlled-host.log');
  await writeFile(log, 'dsh web: ' + host.origin + '/?token=controlled-host\n', { mode: 0o600 });
  const home = join(root, 't3-home'); await mkdir(join(home, 'userdata'), { recursive: true, mode: 0o700 });
  const instances = Object.fromEntries(['codex','claude-code','cursor','grok','gemini','opencode','dsh']
    .map(driver => [driver, { driver, enabled: false, config: {} }]));
  instances.dsh = { driver: 'dsh', enabled: true, config: { agentPreset: 'controlled-preset' } };
  const settings = { backgroundActivity: { schemaVersion: 1, profile: 'custom', baseProfile: 'battery-saver',
    overrides: { automaticGitFetchInterval: 0, providerHealthRefreshInterval: 0 } }, automaticGitFetchInterval: 0, providerInstances: instances };
  const parser = join(root, 'settings-parser.mjs');
  await build({ stdin: { contents: 'import * as S from "effect/Schema";import {ServerSettings} from ' +
    JSON.stringify(join(source, 'packages/contracts/src/settings.ts')) + ';export const decode=S.decodeUnknownSync(ServerSettings);',
    resolveDir: source, loader: 'ts' }, outfile: parser, bundle: true, platform: 'node', format: 'esm',
    banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' } });
  const { decode } = await import(pathToFileURL(parser)); decode(settings);
  await writeFile(join(home, 'userdata/settings.json'), JSON.stringify(settings), { mode: 0o600 });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'", launcher = join(root, 'test-node'), bin = join(root, 'test-bin'); await mkdir(bin);
  await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 82\n', { mode: 0o700 });
  await writeFile(launcher, '#!/bin/sh\nexec /usr/bin/env -u AAAAGENT_CODEX_READONLY_BINARY ' + quote('CODEX_HOME=' + join(root, 'codex-home')) +
    ' ' + quote('DSH_HOME=' + join(root, 'dsh-home')) + ' ' + quote('PATH=' + bin + ':/usr/bin:/bin') + ' ' + quote(node) + ' "$@"\n', { mode: 0o700 });
  const service = new T3ChildService({ sourceDir: runtime, nodeExecutable: launcher, baseDir: home,
    logFile: join(root, 'original-t3.log'), dshWebLogPath: log });
  t.after(() => service.stop());
  const native = await service.start(), client = new T3HttpClient(service);
  const socket = new NodeWS.WebSocket(native.origin.replace('http:', 'ws:') + '/ws',
    { headers: { Authorization: 'Bearer ' + native.accessToken, Origin: native.origin } });
  await once(socket, 'open'); t.after(() => socket.terminate()); let serial = 0;
  const rpc = (tag, payload = {}) => new Promise((done, reject) => {
    const id = String(++serial), timer = setTimeout(() => { socket.off('message', receive); reject(Error('Original RPC timeout')); }, 10000);
    function receive(bytes) { const values = JSON.parse(bytes.toString()); for (const value of Array.isArray(values) ? values : [values]) {
      if (value._tag !== 'Exit' || String(value.requestId) !== id) continue;
      clearTimeout(timer); socket.off('message', receive); value.exit._tag === 'Success' ? done(value.exit.value) : reject(Error('Original RPC rejected ' + tag));
    } }
    socket.on('message', receive); socket.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
  });
  const config = await rpc('server.getConfig');
  assert.deepEqual(Object.entries(config.settings.providerInstances).filter(([_id, p]) => p.enabled).map(([id]) => id), ['dsh']);
  assert.equal(config.settings.providerInstances.dsh.config.agentPreset, 'controlled-preset');
  assert.equal((await readFile(join(root, 'original-t3.log'), 'utf8')).includes('failed to parse settings.json'), false);
  const projectId = randomUUID(), threadId = randomUUID(), date = new Date().toISOString();
  await client.createCommand({ type: 'project.create', commandId: randomUUID(), projectId, title: 'Controlled DSH chain', workspaceRoot: cwd, createdAt: date });
  const firstSelection = { instanceId: 'dsh', model: 'controlled/first' };
  await client.createCommand({ type: 'thread.create', commandId: randomUUID(), threadId, projectId, title: 'Controlled DSH chain',
    modelSelection: firstSelection, runtimeMode: 'auto-accept-edits', interactionMode: 'default', branch: null, worktreePath: null, createdAt: date });
  const bytes = Buffer.from('controlled original attachment nonce B56'), filename = 'controlled.txt';
  const signed = await rpc('attachments.createUploadUrl', { type: 'file', name: filename, mimeType: 'text/plain', sizeBytes: bytes.length });
  const upload = await fetch(new URL(signed.relativeUrl, native.origin), { method: 'POST', headers: { Authorization: 'Bearer ' + native.accessToken }, body: bytes });
  assert.equal(upload.ok, true);
  const attachment = { type: 'file', id: signed.attachmentId, name: filename, mimeType: 'text/plain', sizeBytes: bytes.length };
  const db = new Database(join(home, 'userdata/state.sqlite'), { readonly: true, fileMustExist: true }); t.after(() => db.close());
  const detailItems = [], detailStreamId = '1000000';
  socket.on('message', bytes => {
    const decoded = JSON.parse(bytes.toString());
    for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
      if (frame._tag !== 'Chunk' || String(frame.requestId) !== detailStreamId) continue;
      detailItems.push(...frame.values);
      socket.send(JSON.stringify({ _tag: 'Ack', requestId: frame.requestId }));
    }
  });
  socket.send(JSON.stringify({ _tag: 'Request', id: detailStreamId, tag: 'orchestration.subscribeThread',
    payload: { threadId, afterSequence: 0, requestCompletionMarker: true, turnLimit: 1 }, headers: [] }));
  await until(() => detailItems.some(item => item.kind === 'synchronized' || item.kind === 'snapshot'), 'Original detail stream did not open');
  const commands = [], sourceMessages = [];
  for (let turn = 1; turn <= 2; turn++) {
    const commandId = randomUUID(), modelSelection = { instanceId: 'dsh', model: 'controlled/' + (turn === 1 ? 'first' : 'second') };
    commands.push(commandId);const messageId=randomUUID();sourceMessages.push(messageId);
    if(turn===2)await client.dispatch({type:'thread.runtime-mode.set',commandId:randomUUID(),threadId,runtimeMode:'full-access',createdAt:new Date().toISOString()});
    await client.dispatch({ type: 'thread.turn.start', commandId, threadId, runtimeMode: turn === 1 ? 'auto-accept-edits' : 'full-access', interactionMode: 'default', modelSelection,
      message: { messageId, role: 'user', text: 'controlled turn ' + turn, attachments: turn === 1 ? [attachment] : [] }, createdAt: new Date().toISOString() });
    await until(() => db.prepare('SELECT 1 FROM projection_thread_messages WHERE thread_id=? AND text=?').get(threadId, 'controlled reply ' + turn), 'Original DSH reply absent');
    await until(() => db.prepare('SELECT 1 FROM projection_turns WHERE thread_id=? AND state=\'completed\'').all(threadId).length === turn, 'Original DSH terminal absent');
    const receipt = await client.readReceipt(commandId); assert.equal(receipt.status, 'accepted'); assert.equal(receipt.aggregateId, threadId);
  }
  assert.equal(host.state.sessions.size, 1);
  const sid = [...host.state.sessions.keys()][0], prompts = host.state.calls.filter(c => c.method === 'session/prompt');
  assert.deepEqual(prompts.map(c => c.args.request.requestId), commands); assert(prompts.every(c => c.args.request.sessionId === sid));
  assert.equal(sid, 't3_' + digest(JSON.stringify([(await client.environmentDescriptor()).environmentId, threadId])).slice(0, 40));
  assert.deepEqual(host.state.calls.filter(c => c.method === 'session/selectModel').map(c => c.args.request.model), ['first','second']);
  const content = prompts[0].args.request.content;
  assert.equal(content[0].type, 'text'); assert(content[0].text.startsWith('controlled turn 1\n\n'));
  const receivedPath = content[0].text.match(/\[Attached file "controlled.txt" is saved at: ([^\]]+)\]/)?.[1];
  assert(receivedPath?.startsWith(join(home, 'userdata/attachments') + '/'));
  assert.equal(digest(await readFile(receivedPath)), digest(bytes));
  assert.deepEqual(content.slice(1), [{ type: 'file', receiptId: 'controlled-file' }]);
  assert.deepEqual(host.state.uploads, [{ sessionId: sid, name: filename, hash: digest(bytes) }]);
  assert.equal(host.state.sessions.get(sid).mode, 'danger-full-access');
  const questionId = 'dsh:' + sid + ':question:controlled-question';
  await until(() => db.prepare('SELECT 1 FROM projection_thread_activities WHERE thread_id=? AND kind=? AND payload_json LIKE ?')
    .get(threadId, 'user-input.requested', '%' + questionId + '%'), 'Original continued question absent');
  assert.equal(db.prepare('SELECT 1 FROM projection_thread_activities WHERE thread_id=? AND kind=? AND payload_json LIKE ?').all(threadId,'user-input.resolved','%'+questionId+'%').length,0,
    'The original continued question must remain answerable after its root terminal');
  await until(()=>{const row=db.prepare('SELECT payload_json FROM projection_thread_activities WHERE thread_id=? AND kind=?').get(threadId,'native.session.sync');return row&&JSON.parse(row.payload_json).observation==='waiting_answer';},'Original native history must report the active question, not ready');
  for(let n=0;n<2;n++){
    const rows=db.prepare('SELECT message_id FROM projection_thread_messages WHERE thread_id=? AND role=? AND text=?').all(threadId,'user','controlled turn '+(n+1));
    assert.deepEqual(rows,[{message_id:sourceMessages[n]}]);
    const saved=db.prepare('SELECT pending_message_id FROM projection_turns WHERE thread_id=? AND turn_id=?').get(threadId,'dsh:'+commands[n]);
    assert.equal(saved.pending_message_id,sourceMessages[n]);
  }
  const answerCommand = randomUUID();
  await client.dispatch({ type: 'thread.user-input.respond', commandId: answerCommand, threadId, requestId: questionId,
    answers: { q1: { answers: ['yes'] } }, createdAt: new Date().toISOString() });
  const responseEvent = await until(() => detailItems.find(item => item.kind === 'event' &&
    item.event.type === 'thread.user-input-response-requested' && item.event.payload.requestId === questionId),
    'Durable original question response was filtered out of the live detail stream');
  assert.equal(responseEvent.event.commandId, answerCommand);
  assert.equal(typeof responseEvent.event.eventId, 'string');
  const detailPage = await client.threadSnapshot(threadId, 1);
  const pageThreadSequence = detailPage.page?.threadSequence;
  assert.ok(Number.isSafeInteger(pageThreadSequence) && pageThreadSequence >= responseEvent.event.sequence,
    'A bounded history page must include the same response event in its live-stream watermark');
  const replayItems = [], replayId = '1000001';
  socket.on('message', bytes => {
    const decoded = JSON.parse(bytes.toString());
    for (const frame of Array.isArray(decoded) ? decoded : [decoded]) {
      if (frame._tag !== 'Chunk' || String(frame.requestId) !== replayId) continue;
      replayItems.push(...frame.values);
      socket.send(JSON.stringify({ _tag: 'Ack', requestId: frame.requestId }));
    }
  });
  socket.send(JSON.stringify({ _tag: 'Request', id: replayId, tag: 'orchestration.subscribeThread',
    payload: { threadId, afterSequence: responseEvent.event.sequence - 1, requestCompletionMarker: true, turnLimit: 1 }, headers: [] }));
  await until(() => replayItems.some(item => item.kind === 'event' && item.event.eventId === responseEvent.event.eventId),
    'Original response event missing from bounded reconnect replay');
  const followUp = await until(() => db.prepare('SELECT turn_id FROM projection_thread_messages WHERE thread_id=? AND text=?')
    .get(threadId, 'actual question follow-up reply'), 'Original question follow-up reply absent');
  assert.equal(followUp.turn_id, 'dsh:' + sid + ':question:controlled-question:3');
  await until(() => db.prepare('SELECT 1 FROM projection_turns WHERE thread_id=? AND state=\'completed\'').all(threadId).length === 3,
    'Original follow-up terminal absent');
  await until(() => db.prepare('SELECT 1 FROM projection_thread_activities WHERE thread_id=? AND kind=? AND payload_json LIKE ?')
    .get(threadId, 'user-input.resolved', '%' + questionId + '%'), 'Original question settlement absent');
  assert.equal(host.state.calls.filter(c => c.method === 'session/prompt').length, 2);
  assert.equal(host.state.calls.filter(c => c.method === 'userQuestions/answer').length, 1);
  assert.equal(host.state.sessions.size, 1); assert.equal((await client.readReceipt(answerCommand)).status, 'accepted');
  await until(()=>{const row=db.prepare('SELECT payload_json FROM projection_thread_activities WHERE thread_id=? AND kind=?').get(threadId,'native.session.sync');return row&&JSON.parse(row.payload_json).checkpoint.native.afterSeq===host.state.sessions.get(sid).events.at(-1).seq;},'Original native follow-up did not sync');
  assert.equal(db.prepare('SELECT count(*) AS n FROM projection_turns WHERE thread_id=?').get(threadId).n,3,
    'The native question follow-up must reuse its exact original adapter turn');
  assert.equal(db.prepare('SELECT count(*) AS n FROM projection_thread_messages WHERE thread_id=? AND text=?').get(threadId,'actual question follow-up reply').n,1);
  const binding = db.prepare('SELECT resume_cursor_json FROM provider_session_runtime WHERE thread_id=?').get(threadId);
  assert.equal(JSON.parse(binding.resume_cursor_json).sessionId, sid);
  await writeFile(join(root, 'receipt.json'), JSON.stringify({ originalServerBundleSha256: digest(await readFile(join(runtime, 'apps/server/dist/bin.mjs'))),
    schemaDecodedBeforeStart: true, originalSoleEnabledProvider: 'dsh', environmentId: (await client.environmentDescriptor()).environmentId,
    projectId, threadId, nativeSessionId: sid, commands, answerCommand, questionId, followUpTurnId: followUp.turn_id,
    replyCount: 3, completedTurns: 3, nativePromptCount: 2, nativeQuestionAnswerCount: 1,
    attachmentSha256: digest(bytes), modelSelections: ['controlled/first','controlled/second'], actualPermission: ['workspace-write/ask','danger-full-access/never'],
    originalPendingSourceIds:sourceMessages, continuedQuestionPreservedUntilNativeSettlement:true, nativeWaitingAnswerObserved:true, exactFollowUpTurnAfterNativeSync:true,
    responseEvent: { eventId: responseEvent.event.eventId, sequence: responseEvent.event.sequence, commandId: answerCommand },
    liveDetailResponseDelivered: true, originalResponseReplayed: true, pageThreadSequence,
    host: 'controlled peer; no real model or credentials', installed: false, realWebAcceptance: false }, null, 2) + '\n');
  if(process.env.DSH_VERIFY_RESTART==='1'){
    await service.stop();
    const restored=new T3ChildService({sourceDir:runtime,nodeExecutable:launcher,baseDir:home,logFile:join(root,'restored-original-t3.log'),dshWebLogPath:log});
    t.after(()=>restored.stop());await restored.start();const next=new T3HttpClient(restored);
    assert.equal((await next.environmentDescriptor()).environmentId,(await readFile(join(root,'receipt.json'),'utf8').then(JSON.parse)).environmentId);
    const fourthCommand=randomUUID(),fourthMessage=randomUUID(),fourthText='after original server restart '+randomUUID();
    await next.dispatch({type:'thread.turn.start',commandId:fourthCommand,threadId,runtimeMode:'full-access',interactionMode:'default',modelSelection:{instanceId:'dsh',model:'controlled/second'},message:{messageId:fourthMessage,role:'user',text:fourthText,attachments:[]},createdAt:new Date().toISOString()});
    await until(()=>db.prepare('SELECT 1 FROM projection_thread_messages WHERE thread_id=? AND text=?').get(threadId,'controlled reply 4'),'Original restored fourth reply absent');
    // The actual original detail read registers the native synchronizer's watch.
    await next.threadSnapshot(threadId,1);
    await until(()=>{const row=db.prepare('SELECT payload_json FROM projection_thread_activities WHERE thread_id=? AND kind=?').get(threadId,'native.session.sync');return row&&JSON.parse(row.payload_json).checkpoint.native.afterSeq===host.state.sessions.get(sid).events.at(-1).seq;},'Restored original native history did not sync');
    const sources=db.prepare('SELECT message_id FROM projection_thread_messages WHERE thread_id=? AND role=? AND text=?').all(threadId,'user',fourthText);
    await writeFile(join(root,'restore-observation.json'),JSON.stringify({fourthCommand,fourthMessage,sources,turns:db.prepare('SELECT turn_id,pending_message_id,state FROM projection_turns WHERE thread_id=?').all(threadId),nativePromptCount:host.state.calls.filter(c=>c.method==='session/prompt').length,nativeSID:sid},null,2)+'\n');
    assert.deepEqual(sources,[{message_id:fourthMessage}]);
    assert.equal(db.prepare('SELECT pending_message_id FROM projection_turns WHERE thread_id=? AND turn_id=?').get(threadId,'dsh:'+fourthCommand).pending_message_id,fourthMessage);
    assert.equal(db.prepare('SELECT count(*) AS n FROM projection_turns WHERE thread_id=?').get(threadId).n,4);
    assert.equal(host.state.sessions.size,1);assert.equal(host.state.calls.filter(c=>c.method==='session/prompt').length,3);
    for(const text of ['controlled reply 1','controlled reply 2','actual question follow-up reply','controlled reply 4'])assert.equal(db.prepare('SELECT count(*) AS n FROM projection_thread_messages WHERE thread_id=? AND role=? AND text=?').get(threadId,'assistant',text).n,1,'Cold recovery must not append already durable original reply text again');
  }
});
