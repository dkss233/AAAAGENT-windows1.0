import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// A test-only protocol peer. The binary selected in the isolated T3 home points here.
const wire = JSON.parse(readFileSync(process.env.T3_P1_FIXTURE, 'utf8'));
const captureFile = process.env.T3_P1_CAPTURE;
if (!captureFile) throw new Error('T3_P1_CAPTURE missing');
const write = message => process.stdout.write(JSON.stringify(message) + '\n');
const reply = (id, result) => write({ id, result });
let nativeThreadId = randomUUID();
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const { id, method, params } = message;
  if (!method) return;
  appendFileSync(captureFile, JSON.stringify({ method, params }) + '\n');
  switch (method) {
    case 'initialize':
      reply(id, { userAgent: 'aaaagent-p1-mock/0.0.1', codexHome: process.env.CODEX_HOME,
        platformFamily: 'unix', platformOs: 'macos' });
      break;
    case 'initialized': break;
    case 'account/read': reply(id, { account: { type: 'apiKey' }, requiresOpenaiAuth: false }); break;
    case 'account/rateLimits/read':
      write({ id, error: { code: -32000, message: 'synthetic usage unavailable' } }); break;
    case 'skills/list': reply(id, { data: [] }); break;
    case 'model/list': reply(id, { data: [{ id: 'synthetic-only', model: 'synthetic-only',
      displayName: 'Synthetic Only', description: 'No remote model', hidden: false,
      isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [] }],
      nextCursor: null }); break;
    case 'thread/start': {
      nativeThreadId = randomUUID();
      const source = wire.responses.threadStart;
      reply(id, { ...source, cwd: params.cwd, model: params.model ?? 'synthetic-only',
        approvalPolicy: 'untrusted', approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        runtimeWorkspaceRoots: [params.cwd], instructionSources: [],
        thread: { ...source.thread, id: nativeThreadId, sessionId: nativeThreadId, cwd: params.cwd,
          path: null, turns: [] } });
      break;
    }
    case 'thread/resume': {
      const source = wire.responses.threadStart;
      nativeThreadId = params.threadId;
      reply(id, { ...source, cwd: params.cwd, model: params.model ?? 'synthetic-only',
        approvalPolicy: 'untrusted', approvalsReviewer: 'user',
        sandbox: { type: 'readOnly', networkAccess: false },
        runtimeWorkspaceRoots: [params.cwd], instructionSources: [],
        thread: { ...source.thread, id: nativeThreadId, sessionId: nativeThreadId, cwd: params.cwd,
          path: null, turns: [] } });
      break;
    }
    case 'turn/start': {
      const turn = { ...wire.responses.turnStart.turn, id: randomUUID() };
      reply(id, { turn });
      setTimeout(() => {
        write({ method: 'turn/started', params: { threadId: nativeThreadId, turn } });
        write({ method: 'turn/completed', params: { threadId: nativeThreadId,
          turn: { ...turn, status: 'completed' } } });
      }, 20);
      break;
    }
    case 'thread/read':
      reply(id, { thread: { id: nativeThreadId, turns: [] } }); break;
    default:
      if (id !== undefined) write({ id, error: { code: -32601, message: `Test peer did not implement ${method}` } });
  }
});
