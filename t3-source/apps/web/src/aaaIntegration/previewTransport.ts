import { ENVIRONMENT_ID, TIME, auth, config, descriptor, readModel, shell, threadSnapshot, turnDiff } from './fixtures';

type Audit = { channel: string; operation: string; allowed: boolean };
const audit: Audit[] = [];
export const previewAudit = () => audit.slice();
function record(channel: string, operation: string, allowed: boolean) {
  audit.push({ channel, operation, allowed });
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

// This class follows the pinned upstream RPC session test transport. It has no
// native socket, provider, filesystem or process. Unknown reads and all commands fail closed.
class PreviewWebSocket extends EventTarget {
  static readonly CONNECTING = 0; static readonly OPEN = 1;
  static readonly CLOSING = 2; static readonly CLOSED = 3;
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  readyState = 0;
  binaryType = 'arraybuffer'; readonly bufferedAmount = 0;
  readonly extensions = ''; readonly protocol = '';
  readonly url: string;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  constructor(url: string | URL) {
    super(); this.url = String(url);
    const target = new URL(this.url);
    if (target.host !== window.location.host || target.pathname !== '/ws') throw new Error('Preview external socket rejected');
    setTimeout(() => { this.readyState = 1; const e = new Event('open'); this.dispatchEvent(e); this.onopen?.(e); }, 0);
  }
  private message(value: unknown) {
    queueMicrotask(() => { if (this.readyState !== 1) return; const e = new MessageEvent('message', { data: JSON.stringify(value) }); this.dispatchEvent(e); this.onmessage?.(e); });
  }
  send(data: string) {
    const request = JSON.parse(data) as { _tag: string; id: string; tag: string; payload?: Record<string, unknown> };
    if (request._tag === 'Ping') { this.message({ _tag: 'Pong' }); return; }
    if (request._tag !== 'Request') return;
    const tag = request.tag; const id = request.id; const payload = request.payload ?? {};
    const chunk = (values: unknown[]) => this.message({ _tag: 'Chunk', requestId: id, values });
    const success = (value: unknown) => this.message({ _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value } });
    let allowed = true;
    try {
      switch (tag) {
        case 'subscribeServerConfig': chunk([{ version: 1, type: 'snapshot', config }]); break;
        case 'subscribeServerLifecycle': chunk([{ version: 1, sequence: 1, type: 'welcome', payload: { environment: descriptor, cwd: '/example/aaaagent', projectName: 'AAAAGENT · 原生界面', bootstrapStatus: 'complete' } }]); break;
        case 'orchestration.subscribeShell': chunk([{ kind: 'snapshot', snapshot: shell }, { kind: 'synchronized' }]); break;
        case 'orchestration.subscribeThread': chunk([{ kind: 'snapshot', snapshot: threadSnapshot(String(payload.threadId)) }, { kind: 'synchronized' }]); break;
        case 'orchestration.getArchivedShellSnapshot': success({ ...shell, threads: [] }); break;
        case 'orchestration.getTurnDiff': case 'orchestration.getFullThreadDiff': success(turnDiff(String(payload.threadId))); break;
        case 'server.getConfig': success(config); break;
        case 'server.getSettings': success(config.settings); break;
        case 'subscribeVcsStatus': chunk([{ _tag: 'snapshot', local: { isRepo: true, hasPrimaryRemote: false, isDefaultRef: false, refName: 'example/native-ui', hasWorkingTreeChanges: true, workingTree: { files: [{ path: 'src/flow.ts', insertions: 2, deletions: 1 }], insertions: 2, deletions: 1 } }, remote: null }]); break;
        case 'vcs.listRefs': success({ refs: [], isRepo: true, hasPrimaryRemote: false, nextCursor: null, totalCount: 0 }); break;
        case 'review.getDiffPreview': success({ cwd: '/example/aaaagent', generatedAt: TIME, sources: [{ id: 'example-unstaged', kind: 'working-tree', title: '隔离示例差异', baseRef: null, headRef: null, diff: turnDiff('native-chat-a').diff, diffHash: 'example-fixed-diff', truncated: false }] }); break;
        case 'review.getDiffFileContents': success({ oldContents: 'export const view = "list";\n', newContents: 'export const view = "canvas";\nexport const preserveThreadIdentity = true;\n' }); break;
        case 'subscribeTerminalMetadata': case 'subscribeTerminalEvents': case 'subscribeWorktreeSetup': case 'subscribePreviewEvents': case 'subscribeDiscoveredLocalServers': case 'subscribeProjectClones': break;
        default: allowed = false; throw new Error('隔离界面示例：该操作未启用，未发送任务或调用设备。');
      }
    } catch (error) {
      allowed = false;
      this.message({ _tag: 'Exit', requestId: id, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'EnvironmentAuthorizationError', requiredScope: 'orchestration:operate', message: error instanceof Error ? error.message : 'Preview operation rejected' } }] } });
    }
    record('rpc', tag, allowed);
  }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3; const e = new CloseEvent('close', { code, reason }); this.dispatchEvent(e); this.onclose?.(e);
  }
}

export function installPreviewTransport(): void {
  if (import.meta.env.VITE_AAA_PREVIEW !== '1') return;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), window.location.origin), init);
    const url = new URL(request.url), method = init?.method ?? request.method;
    if (url.origin !== window.location.origin) { record('http', 'external', false); return json({ message: 'Preview external request rejected' }, 403); }
    const path = url.pathname;
    record('http', `${method} ${path}`, true);
    if (method === 'GET') {
      if (path === '/.well-known/t3/environment') return json(descriptor);
      if (path === '/api/auth/session') return json({ authenticated: true, auth, scopes: ['orchestration:read'], sessionMethod: 'browser-session-cookie' });
      if (path === '/api/orchestration/shell') return json(shell);
      if (path === '/api/orchestration/snapshot') return json(readModel);
      if (/^\/api\/orchestration\/threads\/[^/]+$/.test(path)) {
        try { return json(threadSnapshot(decodeURIComponent(path.split('/').at(-1)!))); } catch { return json({ message: 'Unknown example thread' }, 404); }
      }
      if (/^\/(assets|fonts)\//.test(path) || path === '/libghostty.wasm' || path === '/third-party-licenses.json') return originalFetch(request);
    }
    // Synthetic handshake response only: never issues a credential or sends a POST.
    if (method === 'POST' && path === '/api/auth/websocket-ticket') return json({ ticket: 'isolated-no-real-ticket', expiresAt: '2099-01-01T00:00:00.000Z' });
    audit.at(-1)!.allowed = false;
    return json({ message: '隔离界面示例：只读输入；操作未发送。' }, 403);
  };
  window.WebSocket = PreviewWebSocket as unknown as typeof WebSocket;
  // Also close alternate browser transports; the static server has no API proxy.
  window.XMLHttpRequest = class extends XMLHttpRequest {
    override open(): never { throw new Error('Preview XHR rejected'); }
  };
  navigator.sendBeacon = () => false;
  window.EventSource = class {
    constructor() { throw new Error('Preview EventSource rejected'); }
  } as unknown as typeof EventSource;
  Object.defineProperty(window, '__AAA_PREVIEW_TRANSPORT', { value: Object.freeze({ environmentId: ENVIRONMENT_ID, synthetic: true, readonly: true, audit: previewAudit, installedAt: TIME }), configurable: false });
}
