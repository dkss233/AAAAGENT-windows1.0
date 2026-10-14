import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { codexSharedTransport, inspectSharedCodexSocket } from './codex-shared-connection.mjs';

/** Relay JSON-RPC transparently; the original server owns identities, queues, requests and turns. */
export async function bridgeCodexSharedStdio({ home, WebSocket, input, output, signal }) {
  const route = codexSharedTransport(home);
  inspectSharedCodexSocket(route.socketPath);
  const ws = new WebSocket(route.desktopWebsocketUrl, { handshakeTimeout: 10000 });
  let ended = false, inputEnded = false, finish, fail;
  const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const close = () => { if (!ended) { ended = true; ws.terminate(); } };
  const abort = () => { close(); finish(); };
  signal?.addEventListener('abort', abort, { once: true });
  ws.on('error', () => { close(); fail(Error('Shared Codex connection unavailable')); });
  ws.on('close', () => { ended = true; inputEnded ? finish() : fail(Error('Shared Codex connection closed')); });
  let outputQueue = Promise.resolve();
  ws.on('message', (bytes, binary) => {
    outputQueue = outputQueue.then(async () => {
      if (binary) throw Error('Unexpected shared Codex binary frame');
      const text = String(bytes); const frame = JSON.parse(text);
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw Error('Invalid shared Codex frame');
      // Normalize optional whitespace without changing fields, IDs or server requests.
      if (!output.write(JSON.stringify(frame) + '\n')) await once(output, 'drain');
    }).catch(() => { close(); fail(Error('Shared Codex output unavailable')); });
  });
  output.on('error', abort);
  try {
    await Promise.race([once(ws, 'open'), done]);
    if (ended) return;
    const pump = async () => {
      const decoder = new StringDecoder('utf8'); let buffer = '';
      const send = async line => {
        if (!line.trim()) return;
        const frame = JSON.parse(line);
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw Error('Invalid shared Codex request');
        if (ended || ws.readyState !== WebSocket.OPEN) throw Error('Shared Codex connection closed');
        await new Promise((resolve, reject) => ws.send(JSON.stringify(frame), error => error ? reject(error) : resolve()));
      };
      for await (const bytes of input) {
        buffer += decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
        let offset;
        while ((offset = buffer.indexOf('\n')) >= 0) { await send(buffer.slice(0, offset)); buffer = buffer.slice(offset + 1); }
      }
      buffer += decoder.end(); await send(buffer);
      inputEnded = true; ws.close();
    };
    pump().catch(() => { close(); fail(Error('Shared Codex input unavailable')); });
    await done; await outputQueue;
  } finally {
    signal?.removeEventListener('abort', abort); output.removeListener('error', abort); close();
    // Release a waiting input iterator without terminating the shared server.
    if (!inputEnded) input.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [home, wsModule] = process.argv.slice(2);
  if (!home || !wsModule) throw Error('Explicit native home and pinned WebSocket module required');
  const WebSocket = (await import(pathToFileURL(wsModule).href)).default;
  const controller = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => controller.abort());
  try { await bridgeCodexSharedStdio({ home, WebSocket, input: process.stdin, output: process.stdout, signal: controller.signal }); }
  catch { process.stderr.write('Shared Codex transport failed; no independent writer started\n'); process.exitCode = 1; }
}
