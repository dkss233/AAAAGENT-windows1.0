import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const taskRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const root = realpathSync(join(taskRoot, 'artifacts/runtime/t3-native-ui-54/apps/web/dist'));
const port = Number(process.argv[2] ?? 59911);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg' };
const server = createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.host !== `127.0.0.1:${port}` || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(403); res.end('Read-only local UI preview'); return; }
  let path;
  try { path = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname); } catch { res.writeHead(400); res.end(); return; }
  if (/^\/(api|\.well-known|ws)(\/|$)/.test(path)) { res.writeHead(403); res.end('No API, backend or dispatch proxy'); return; }
  let file = resolve(root, '.' + path);
  if (file !== root && !file.startsWith(root + '/')) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
  if (!realpathSync(file).startsWith(root + '/')) { res.writeHead(403); res.end(); return; }
  res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
  res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
});
server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/`, pid: process.pid, root, fixture_only: true, backend_proxy: false })));
