import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { OrchestrationShellSnapshot, OrchestrationThreadDetailSnapshot } from '@t3tools/contracts';
import * as Schema from 'effect/Schema';
import { ENVIRONMENT_ID, shell, threadSnapshot } from './fixtures';
import { installPreviewTransport, previewAudit } from './previewTransport';

afterEach(() => vi.unstubAllGlobals());
function install() {
  const outbound = vi.fn(async () => new Response('unexpected outbound'));
  const nativeSocket = vi.fn();
  class XHR { open() { outbound(); } }
  const view = { location: { origin: 'http://127.0.0.1:59911', host: '127.0.0.1:59911' }, fetch: outbound, WebSocket: nativeSocket, XMLHttpRequest: XHR };
  vi.stubGlobal('window', view); vi.stubGlobal('XMLHttpRequest', XHR);
  vi.stubGlobal('navigator', { sendBeacon: outbound });
  installPreviewTransport();
  return { view: view as unknown as Window & typeof globalThis, outbound, nativeSocket };
}

describe('isolated original-client preview input', () => {
  it('decodes original schemas and retains same-title identities across projects', () => {
    const decoded = Schema.decodeUnknownSync(OrchestrationShellSnapshot)(shell);
    expect(decoded.projects).toHaveLength(3); expect(decoded.threads).toHaveLength(4);
    const same = decoded.threads.filter(t => t.title === '实现对话节点总览');
    expect(new Set(same.map(t => t.id)).size).toBe(3);
    expect(new Set(same.map(t => t.projectId)).size).toBe(2);
    expect(Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot)(threadSnapshot('native-chat-a')).thread.id).toBe('native-chat-a');
    expect(() => threadSnapshot('missing')).toThrow();
  });
  it('serves only isolated snapshots, never forwards HTTP commands or external requests', async () => {
    const { view, outbound } = install();
    const data = await (await view.fetch('/api/orchestration/shell')).json();
    expect(data.threads[0].id).toBe('native-chat-a');
    for (const [url, method] of [['/api/orchestration/commands', 'POST'], ['/api/auth/browser-session', 'POST'], ['http://127.0.0.1:56050/api/orchestration/shell', 'GET']] as const) {
      expect((await view.fetch(url!, { method })).status).toBe(403);
    }
    expect(outbound).not.toHaveBeenCalled();
  });
  it('rejects RPC dispatch for every command type without opening a native socket', async () => {
    const { view, nativeSocket } = install();
    const socket = new view.WebSocket('ws://127.0.0.1:59911/ws');
    const replies: Array<{ exit: { cause: Array<{ _tag: string; error: { _tag: string } }> } }> = [];
    socket.addEventListener('message', event => replies.push(JSON.parse((event as MessageEvent).data)));
    await new Promise<void>(resolve => socket.addEventListener('open', () => resolve(), { once: true }));
    for (const type of ['thread.turn.start', 'thread.approval.respond', 'thread.user-input.respond', 'thread.turn.interrupt', 'thread.create']) {
      socket.send(JSON.stringify({ _tag: 'Request', id: type, tag: 'orchestration.dispatchCommand', payload: { type, environmentId: ENVIRONMENT_ID, threadId: 'native-chat-a' } }));
    }
    await Promise.resolve();
    const dispatches = previewAudit().filter(a => a.operation === 'orchestration.dispatchCommand');
    expect(dispatches.length).toBeGreaterThanOrEqual(5); expect(dispatches.every(a => !a.allowed)).toBe(true);
    expect(replies).toHaveLength(5);
    expect(replies.every(r => r.exit.cause[0]?._tag === 'Fail' && r.exit.cause[0].error._tag === 'EnvironmentAuthorizationError')).toBe(true);
    expect(nativeSocket).not.toHaveBeenCalled();
    expect(() => new view.WebSocket('ws://127.0.0.1:56050/ws')).toThrow();
  });
});
