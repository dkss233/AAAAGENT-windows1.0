import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { T3ChildService } from './t3-child-service.mjs';
import { T3HttpClient } from './t3-http-client.mjs';
import { BrowserTickets, landingHtml, landingScript, nativeTarget } from './t3-browser.mjs';

let bootstrap;
try { bootstrap = JSON.parse(readFileSync(3, 'utf8')); } finally { closeSync(3); }
const { options, nonce } = bootstrap;
const lock = join(options.baseDir, '.aaaagent-t3-host.lock');
const descriptor = join(options.baseDir, '.aaaagent-t3-host.json');
if (JSON.parse(readFileSync(lock, 'utf8')).nonce !== nonce) throw Error('T3 host lease changed');
writeFileSync(lock, JSON.stringify({ nonce, hostPid: process.pid }), { mode: 0o600 });
const child = new T3ChildService(options), client = new T3HttpClient(child), tickets = new BrowserTickets();
const token = randomBytes(32).toString('hex');
let origin, closing = false;
function cleanup() {
  for (const file of [descriptor, lock]) {
    try { if (JSON.parse(readFileSync(file, 'utf8')).nonce === nonce) unlinkSync(file); } catch {}
  }
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8_001_024) throw Error(); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const server = createServer({ requestTimeout: 10000, headersTimeout: 10000 }, (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  void (async () => {
    if (closing || req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin) throw Error();
    if (req.method === 'GET' && ['/open','/open.js'].includes(req.url)) {
      res.setHeader('Content-Type', req.url === '/open' ? 'text/html; charset=utf-8' : 'text/javascript');
      res.end(req.url === '/open' ? landingHtml : landingScript); return;
    }
    if (req.method !== 'POST' || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw Error();
    if (req.url === '/launch') {
      if (req.headers.origin !== origin) throw Error();
      const target = tickets.consume((await body(req)).ticket);
      const path = await nativeTarget(client, target);
      const cookie = await child.browserSession();
      const connection = await child.start();
      res.setHeader('Set-Cookie', cookie); json({ url: connection.origin + path }); return;
    }
    if (req.url !== '/control') throw Error();
    const given = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw Error();
    const { action, payload } = await body(req);
    if (action === 'connection') { json(await child.start()); return; }
    if (action === 'status') { const c = await child.start(); json({ origin: c.origin, pid: c.pid, hostPid: process.pid }); return; }
    if (action === 'proof') { json({ signature: await child.signProviderContextProof(payload) }); return; }
    if (action === 'open') {
      await nativeTarget(client, payload);
      const ticket = tickets.issue(payload); json({ url: origin + '/open#' + ticket.ticket, expiresAt: ticket.expiresAt }); return;
    }
    if (action === 'stop') { json({ status: 'stopping' }); void shutdown(); return; }
    throw Error();
  })().catch(() => { if (!res.headersSent) { res.statusCode = 503; json({ error: 'entry_unavailable_or_expired' }); } else res.end(); });
});
async function shutdown() {
  if (closing) return; closing = true;
  try { await child.stop(); } finally { cleanup(); server.closeAllConnections(); server.close(() => process.exit(0)); }
}
try {
  await child.start();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  origin = 'http://127.0.0.1:' + server.address().port;
  const next = descriptor + '.' + nonce;
  writeFileSync(next, JSON.stringify({ version: 1, nonce, origin, token, hostPid: process.pid,
    sourceDir: options.sourceDir, runtimeSourceDir: options.runtimeSourceDir ?? options.sourceDir,
    runtimePatchSha256: options.runtimePatchSha256, engineProjectRoot: options.engineProjectRoot, baseDir: options.baseDir }) + '\n', { flag: 'wx', mode: 0o600 });
  chmodSync(next, 0o600); renameSync(next, descriptor);
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
} catch {
  await child.stop().catch(() => {}); cleanup(); process.stderr.write('T3 background startup failed.\n'); process.exitCode = 1;
}
