import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// Minimal MCP stdio tools surface; no shell, file, task-creation or arbitrary HTTP tool.
const descriptor = process.argv[2];
if (!descriptor || !isAbsolute(descriptor)) process.exit(2);
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const schema = { type: 'object', properties: { operationId: { type: 'string', pattern: '^[0-9a-f-]{36}$' } }, required: ['operationId'], additionalProperties: false };
const tools = [
  { name: 'send_confirmed', description: 'Send the immutable request already confirmed by the user. The operation owns its target and exact text. Repeat calls never resend.', inputSchema: schema },
  { name: 'status', description: 'Read the exact Codex turn receipt for a confirmed operation. Does not submit, cancel or retry any task.', inputSchema: schema, annotations: { readOnlyHint: true } },
];
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const failure = id => send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Forwarding operation unavailable or not confirmed. No automatic retry.' }] } });
async function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || message.id === undefined) return;
  const { id, method, params } = message;
  if (method === 'initialize') { send({ jsonrpc: '2.0', id, result: { protocolVersion: versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: 'desktop-pet-confirmed-relay', version: '0.1.0' } } }); return; }
  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools } }); return; }
  if (method !== 'tools/call') { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }); return; }
  const args = params?.arguments;
  if (!tools.some(t => t.name === params?.name) || !args || Object.keys(args).length !== 1 || !/^[0-9a-f-]{36}$/.test(args.operationId)) { failure(id); return; }
  try {
    const info = await lstat(descriptor);
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 16384) throw Error();
    const value = JSON.parse(await readFile(descriptor, 'utf8')), url = new URL(value.url);
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || !token || token.length < 32) throw Error();
    const response = await fetch(url.origin + '/api/harness-tools/' + (params.name === 'send_confirmed' ? 'send-confirmed' : 'status'), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Authorization: 'Bearer ' + token, Origin: url.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: args.operationId }),
    });
    if (!response.ok) throw Error();
    const receipt = await response.json();
    if (receipt.id !== args.operationId || typeof receipt.phase !== 'string') throw Error();
    // Never echo the full stored prompt, project location, credentials or unrelated task history.
    const result = { operationId: receipt.id, status: receipt.phase, ...(receipt.appTurnId ? { turnId: receipt.appTurnId } : {}),
      ...(params.name === 'status' && typeof receipt.result === 'string' ? { result: receipt.result.slice(0, 4000) } : {}) };
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
  } catch { failure(id); }
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk; if (Buffer.byteLength(buffer) > 128 * 1024) { process.exitCode = 2; process.stdin.destroy(); return; }
  while (buffer.includes('\n')) { const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    try { void handle(JSON.parse(line)).catch(() => {}); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  }
});
