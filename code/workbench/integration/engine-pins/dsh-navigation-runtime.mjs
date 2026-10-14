import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEngineProfile } from './profile.mjs';
import { readDshHost } from './dsh-service.mjs';
import { sha256 } from './runtime.mjs';
import { navigationSource } from '../dsh-patches/native-session-navigation.mjs';

const unavailable = () => { throw Error('Original DSH navigation capability unavailable'); };
const clientPath = 'dsh/node_modules/' + navigationSource.package + '/lib/client.js';
const controllerPath = 'dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js';
const sourceUrlTrailer = /(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/;
const sourceMapTrailer = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/;

/** The fixed client-modules server removes debug trailers and serves one exact factory registration. */
export function expectedDshNavigationModule(client, rev) {
  if (sha256(client) !== navigationSource.patchedSha256 || !/^[a-f0-9]{12}$/.test(rev)) unavailable();
  let source = client.toString('utf8').replace(sourceUrlTrailer, '').replace(sourceMapTrailer, '');
  if (!source.endsWith('\n')) source += '\n';
  return Buffer.from(source + ';\n//# sourceMappingURL=??' + navigationSource.package + '/client.js.map&rev=' + rev + '\n');
}

async function body(response, bound) {
  if (!response.ok || !response.body) unavailable();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; if (size > bound) unavailable(); chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}
const owner = host => JSON.stringify([host.pid, host.childPid, host.nonce, host.origin, host.home,
  host.dataHome, host.runtimeRoot, host.projectRoot, host.inventorySha256]);

/** Read-only HTTP proof. The production wrapper supplies an already verified engine profile and owner. */
export async function verifyDshNavigationHost({ profile, readHost, launchUrl, expectedOrigin, fetcher = fetch }) {
  try {
    const host = readHost(), client = readFileSync(join(profile.runtimeRoot, clientPath));
    if (host.origin !== expectedOrigin || host.runtimeRoot !== profile.runtimeRoot || host.home !== profile.home ||
        host.dataHome !== profile.dshHome || host.projectRoot !== profile.projectRoot ||
        host.inventorySha256 !== profile.runtime.inventorySha256 || !host.nonce ||
        sha256(client) !== navigationSource.patchedSha256 ||
        sha256(readFileSync(join(profile.runtimeRoot, controllerPath))) !== navigationSource.sessionClientSha256) unavailable();
    const origin = new URL(host.origin), url = new URL(launchUrl);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.pathname !== '/' ||
        origin.search || origin.hash || origin.username || origin.password || url.origin !== host.origin || url.pathname !== '/' ||
        url.hash || url.username || url.password || !url.searchParams.get('token') ||
        [...url.searchParams.keys()].join(',') !== 'token') unavailable();
    const exchanged = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const cookie = exchanged.headers.get('set-cookie')?.split(';')[0]; await exchanged.body?.cancel();
    if (exchanged.status !== 303 || !['/', './'].includes(exchanged.headers.get('location')) ||
        !cookie || !/^[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(cookie)) unavailable();
    const options = () => ({ headers: { Cookie: cookie, Origin: host.origin }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    const index = await fetcher(host.origin + '/', options());
    if (!index.headers.get('content-type')?.startsWith('text/html')) unavailable();
    const html = (await body(index, 1024 * 1024)).toString('utf8');
    const prefix = 'globalThis["__DSH_BOOT__"] = ', start = html.indexOf(prefix), end = html.indexOf('</script>', start);
    if (start < 0 || end < 0 || html.indexOf(prefix, start + prefix.length) !== -1) unavailable();
    const graph = JSON.parse(html.slice(start + prefix.length, end));
    if (!Array.isArray(graph.entries)) unavailable();
    const entries = graph.entries.filter(row => row?.id === navigationSource.package);
    if (entries.length !== 1) unavailable();
    const entry = entries[0], resource = 'plugins/??' + entry.id + '/client.js&rev=' + entry.rev;
    if (entry.url !== resource) unavailable();
    const served = await fetcher(host.origin + '/' + resource, options());
    if (!served.headers.get('content-type')?.startsWith('text/javascript')) unavailable();
    const bytes = await body(served, client.length + 4096), expected = expectedDshNavigationModule(client, entry.rev);
    if (!bytes.equals(expected) || owner(readHost()) !== owner(host) ||
        !readFileSync(join(profile.runtimeRoot, clientPath)).equals(client)) unavailable();
    return { capabilityVersion: 1, origin: host.origin, pid: host.pid, childPid: host.childPid, home: host.home,
      inventorySha256: host.inventorySha256, clientSha256: sha256(client), servedSha256: sha256(bytes),
      moduleRevision: entry.rev, authenticatedIndexVerified: true, actualServedBytesVerified: true };
  } catch { return unavailable(); }
}

/** No cached flag: every navigation rechecks the installed graph, original owner and authenticated served bytes. */
export async function verifyDshNavigationRuntime(projectRoot, expectedOrigin) {
  try {
    const profile = readEngineProfile(projectRoot); if (!profile) unavailable();
    const log = readFileSync(profile.dshWebLog, 'utf8');
    const launchUrl = [...log.matchAll(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/g)].at(-1)?.[1];
    return await verifyDshNavigationHost({ profile, readHost: () => readDshHost(projectRoot, profile), launchUrl, expectedOrigin });
  } catch { return unavailable(); }
}
