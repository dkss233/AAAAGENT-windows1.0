import { randomUUID } from 'node:crypto';
import type { DshMethod, DshSessionRpc } from './dsh-native.js';

export class DshTransportError extends Error {
  constructor(readonly code: 'unavailable' | 'authentication_required' | 'incompatible') { super(code); }
}

/** A launcher URL is a bearer credential; only the injected local resolver may supply it. */
export class HttpDshSessionRpc implements DshSessionRpc {
  constructor(private readonly resolveGatewayUrl: () => Promise<string>,
    private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 5000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new DshTransportError('incompatible');
  }

  private async gateway(): Promise<URL> {
    try {
      const url = new URL(await this.resolveGatewayUrl());
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.hash ||
          url.username || url.password || url.searchParams.getAll('token').length !== 1 || !url.searchParams.get('token') ||
          [...url.searchParams.keys()].some(key => key !== 'token')) throw new DshTransportError('authentication_required');
      return url;
    } catch { throw new DshTransportError('authentication_required'); }
  }

  async call(method: DshMethod, args: object): Promise<unknown> {
    if (!['session/list', 'session/page', 'session/create', 'session/prompt'].includes(method)) throw new DshTransportError('incompatible');
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const gateway = await this.gateway();
      const exchange = await this.fetcher(gateway, { redirect: 'manual', signal: abort.signal });
      const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
      await exchange.body?.cancel();
      if (exchange.status !== 303 || exchange.headers.get('location') !== '/' || !cookie ||
          !/^[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(cookie)) throw new DshTransportError('authentication_required');
      const rpcId = randomUUID();
      const response = await this.fetcher(`${gateway.origin}/api/${method}`, {
        method: 'POST', redirect: 'manual', signal: abort.signal,
        headers: { Cookie: cookie, Origin: gateway.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
      });
      if (response.status === 401 || response.status === 403) throw new DshTransportError('authentication_required');
      if (!response.ok || !response.body) throw new DshTransportError('unavailable');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new DshTransportError('incompatible'); }
        chunks.push(part.value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      if (!body || typeof body !== 'object') throw new DshTransportError('incompatible');
      const result = body as { type?: unknown; rpcId?: unknown; result?: { ok?: unknown; value?: unknown } };
      if (result.type !== 'server-response' || result.rpcId !== rpcId || result.result?.ok !== true) throw new DshTransportError('incompatible');
      return result.result.value;
    } catch (error) {
      // Fetch and JSON exceptions can contain the credential URL or private native content.
      if (error instanceof DshTransportError) throw error;
      throw new DshTransportError('unavailable');
    } finally { clearTimeout(timer); }
  }
}
