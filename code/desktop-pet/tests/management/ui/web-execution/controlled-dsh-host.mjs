import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
// Test-only peer adapted from I's original complete-server fixture. No external model route.
export async function controlledHost(NodeWS, cwd, descriptors, wire) {
  const state = { sessions: new Map(), calls: [], uploads: [], stream: null, streamId: null, errors:[] };
  const append = (session, type, data) => session.events.push({ seq: session.events.length, time: Date.now(), type, data });
  const finish=(session,text)=>{
    append(session,'assistant/message',{turn:session.turn,message:{id:randomUUID(),role:'assistant',content:[{type:'text',text}]}});
    append(session,'turn/end',{turn:session.turn,reason:{kind:'completed'}});session.running=false;
  };
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
    const descriptor=descriptors.get(method);
    if(descriptor){assert.deepEqual(Object.keys(args).sort(),descriptor.parameters.map(p=>p.wire).sort());for(const p of descriptor.parameters)p.codec.create().parse(args[p.wire]);}
    const session = state.sessions.get(args.request?.sessionId ?? args.agentId);
    let value;
    if (method === 'session/modelCatalog') value = { sessionModelSelectionVersion: 1, failures: [],
      routableProviders: ['controlled'], default: { provider: 'controlled', model: 'first' },
      groups: [{ id: 'controlled', name: 'Controlled peer', models: ['first', 'second'].map(id => ({ id, name: id })) }] };
    else if (method === 'session/list') value = { items: [...state.sessions.values()].map(s => ({
      sessionId: s.id, cwd, running: s.running,
      projections: { asOfSeq: s.events.length - 1, values: { agentPreset: 'controlled-preset', title: s.title,
        permissions: { currentValue: s.mode }, userQuestions: { questions: { active: s.questions, settled: [] } } } } })) };
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
      append(session, 'user/message', { id:randomUUID(),role:'user',content:args.request.content,source: { kind: 'user', rpcId: args.request.requestId } });
      if(session.turn===1){
        session.auditId=randomUUID();session.eventId=randomUUID();
        const request={toolName:'bash',callId:'controlled-approval-call',reason:'Controlled approval'};
        append(session,'approval/asked',{id:session.auditId,...request});
        assert(state.stream);state.stream.send(JSON.stringify({type:'item',streamId:state.streamId,value:{type:'waterfall',eventId:session.eventId,agentId:session.id,event:'approval/request',request}}));
      }
      if (session.turn === 2) {
        append(session, 'tool/call', { name: 'ask_user_question', callId: 'controlled-question' });
        session.questions = [{ callId: 'controlled-question', state: 'continued', questions: [{ id: 'q1', question: 'Continue?', options: [{ label: 'yes' }] }] }];
      }
      if(session.turn!==1)finish(session,'controlled reply '+session.turn);
      value = { accepted: true };
    } else if(method==='$events/result'){
      wire.parseRemoteEventResult(args);assert.equal(args.clientId,'controlled-client');
      const s=[...state.sessions.values()].find(s=>s.eventId===args.eventId);assert(s);
      assert.deepEqual(args.outcome,{kind:'result',value:'allowed-once'});s.approvalSubmitted=true;value=undefined;
    } else if (method === 'userQuestions/answer') {
      assert(session); assert.equal(args.callId, 'controlled-question');
      assert.deepEqual(args.answer, { answers: [{ id: 'q1', selected: ['yes'] }] });
      assert.equal(session.turn, 2);
      const questions=session.questions.find(item=>item.callId===args.callId)?.questions;assert(questions);
      // Mirrors the original SDK steer source and admission in the same SID.
      session.turn++; session.running = true; session.questions = [];
      append(session, 'turn/start', { turn: session.turn });
      append(session, 'user/message', { id:randomUUID(),role:'user',content:[{type:'text',text:JSON.stringify({
        kind:'answer_to_pending_question',tool:'ask_user_question',callId:args.callId,questions,answers:args.answer.answers,
      })}],source: { kind: 'user-question-reply', callId: args.callId, outcome: 'answered' } });
      finish(session,'actual question follow-up reply');value=true;
    } else throw Error('Unexpected controlled Host method: ' + method);
    if(descriptor&&!['session/list','session/page'].includes(method))descriptor.result.create().parse(value);
    response.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }));
  })().catch(error => {state.errors.push(error.message); response.statusCode = 500; response.end(JSON.stringify({ fixtureError: error.message })); }); });
  host.listen(0, '127.0.0.1'); await once(host, 'listening'); const origin = 'http://127.0.0.1:' + host.address().port;
  const sockets = new NodeWS.WebSocketServer({ server: host });
  sockets.on('connection', (socket, request) => {
    assert.equal(request.url, '/api/remote.mux'); assert.equal(request.headers.cookie, 'sid=controlled');
    socket.on('message', bytes => {
      const open = wire.parseRemoteStreamClientMessage(bytes.toString()); assert.equal(open.endpoint, '$events'); state.stream = socket; state.streamId = open.streamId;
      socket.send(JSON.stringify({ type: 'item', streamId: open.streamId, value: { type: 'ready', clientId: 'controlled-client', host: { home: '/controlled' } } }));
    });
  });
  const close=async()=>{for(const s of sockets.clients)s.terminate();sockets.close();host.closeAllConnections();await new Promise(done=>host.close(done));};
  const confirmApproval=()=>{
    const session=[...state.sessions.values()][0];assert(session?.approvalSubmitted);
    append(session,'approval/decided',{id:session.auditId,outcome:'allowed-once'});
    state.stream.send(JSON.stringify({type:'item',streamId:state.streamId,value:{type:'cancel',eventId:session.eventId}}));
    finish(session,'controlled reply 1');
  };
  return {state,origin,close,confirmApproval};
}
