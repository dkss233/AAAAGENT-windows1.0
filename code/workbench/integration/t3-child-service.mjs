import { createHmac, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { closeSync, constants, fchmodSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngineProfile, verifyT3EngineSettings } from './engine-pins/profile.mjs';
import { engineEnvironment } from './engine-pins/runtime.mjs';
import { verifyT3EngineAdapter } from './engine-pins/prepare-t3-adapter.mjs';
import { restrictPrivatePathSync } from '../../desktop-pet/dist/core/platform-files.js';

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const BOOTSTRAP_TOKEN_TYPE = 'urn:t3:params:oauth:token-type:environment-bootstrap';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return probe.close(() => reject(new Error('Loopback port unavailable')));
      probe.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function exited(child) {
  return child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
}

async function stopCaptured(child) {
  if (exited(child)) return;
  const exit = new Promise(resolve => child.once('exit', resolve));
  if (process.platform === 'win32') {
    // SIGTERM on Windows terminates only the parent. Stop the exact process tree
    // rooted at this still-live ChildProcess, including its engine subprocesses.
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw Error('Invalid owned T3 child');
    await new Promise((resolve, reject) => {
      execFile(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 },
        error => error ? reject(Error('Owned T3 process tree termination failed')) : resolve());
    });
    let timer;
    try { await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); }
    if (!exited(child)) throw Error('T3 child exit not confirmed');
    return;
  }
  child.kill('SIGTERM');
  let timer;
  await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
  if (!exited(child)) {
    child.kill('SIGKILL');
    await Promise.race([exit, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
    if (!exited(child)) throw Error('T3 child exit not confirmed');
  }
}

/** Owns only the child it spawned. The caller keeps this instance for the backend lifetime. */
export class T3ChildService {
  #options;
  #pending = null;
  #active = null;
  #owner = null;

  constructor({ sourceDir, runtimeSourceDir, runtimePatchSha256, nodeExecutable, baseDir, logFile, dshWebLogPath, engineProjectRoot }) {
    for (const path of [sourceDir, nodeExecutable, baseDir, logFile, ...(runtimeSourceDir ? [runtimeSourceDir] : []), ...(dshWebLogPath ? [dshWebLogPath] : [])]) {
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw new Error('T3 paths must be absolute');
    }
    if (runtimeSourceDir && !/^[a-f0-9]{64}$/.test(runtimePatchSha256 ?? '')) throw new Error('Runtime source requires an exact patch fingerprint');
    if (engineProjectRoot && (!isAbsolute(engineProjectRoot) || engineProjectRoot.includes('\0'))) throw Error('Invalid project engine path');
    this.#options = { sourceDir, runtimeSourceDir, runtimePatchSha256, nodeExecutable, baseDir, logFile, dshWebLogPath, engineProjectRoot };
  }

  async start() {
    if (this.#active && !exited(this.#active.child)) {
      if (Date.parse(this.#active.public.expiresAt) > Date.now() + 60000) return this.#active.public;
      if (this.#pending) return this.#pending;
      const active = this.#active;
      this.#pending = this.#exchange(active.public.origin, active.bootstrapToken).then(access => {
        if (this.#active !== active || exited(active.child)) throw new Error('T3 service changed during token refresh');
        active.public = Object.freeze({ ...active.public, ...access });
        return active.public;
      });
      try { return await this.#pending; } finally { this.#pending = null; }
    }
    if (this.#active && exited(this.#active.child)) {
      this.#active.proofKey.fill(0);
      this.#active = null;
      this.#releaseOwner();
    }
    if (this.#pending) return this.#pending;
    this.#pending = this.#launch();
    try { return await this.#pending; } finally { this.#pending = null; }
  }

  async #launch() {
    const { nodeExecutable, baseDir, logFile, dshWebLogPath, runtimePatchSha256 } = this.#options;
    // Keep the installed client's logical source identity while a bounded candidate
    // runs a separately prepared public source against the same original home.
    const sourceDir = this.#options.runtimeSourceDir ?? this.#options.sourceDir;
    let lockedEnvironment;
    if (this.#options.engineProjectRoot) {
      const profile = readEngineProfile(this.#options.engineProjectRoot);
      if (!profile || nodeExecutable !== profile.runtime.nodeExecutable || dshWebLogPath !== profile.dshWebLog)
        throw Error('Project engine binding unavailable');
      verifyT3EngineSettings(baseDir, profile);
      verifyT3EngineAdapter(sourceDir);
      lockedEnvironment = { ...engineEnvironment(profile.runtime, profile.home), CODEX_HOME: profile.codexHome, DSH_HOME: profile.dshHome };
      lockedEnvironment.AAAAGENT_CODEX_READONLY_BINARY = profile.runtime.codexExecutable;
      lockedEnvironment.PATH = dirname(profile.codexLauncher) + delimiter + lockedEnvironment.PATH;
    }
    const marker = JSON.parse(readFileSync(join(sourceDir, '.aaaagent-prepared.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 't3-source.json'), 'utf8'));
    if (marker.commit !== lock.commit || marker.licenseSha256 !== lock.licenseSha256) throw new Error('T3 source lock mismatch');
    if (this.#options.runtimeSourceDir && marker.patchSha256 !== runtimePatchSha256) throw new Error('T3 runtime patch mismatch');
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    restrictPrivatePathSync(baseDir);
    mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
    // An exclusive per-home lease prevents a second backend process from launching
    // another T3 against the same persistent state. An orphan is left for explicit
    // reconciliation; it is never replaced by guessing from a PID or a port.
    const ownerFile = join(baseDir, '.aaaagent-t3-owner.json');
    const nonce = randomBytes(16).toString('hex');
    let ownerFd;
    try {
      ownerFd = openSync(ownerFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      fchmodSync(ownerFd, 0o600);
      writeFileSync(ownerFd, JSON.stringify({ version: 1, ownerPid: process.pid, nonce,
        sourceCommit: lock.commit, createdAt: new Date().toISOString() }) + '\n');
      this.#owner = { file: ownerFile, nonce };
    } catch (error) {
      if (ownerFd !== undefined) {
        try { unlinkSync(ownerFile); } catch { /* Leave an uncertain lease for inspection. */ }
      }
      if (error?.code === 'EEXIST') throw new Error('T3 home already has an owner; reconcile before another launch');
      throw error;
    } finally { if (ownerFd !== undefined) closeSync(ownerFd); }
    let logFd;
    let port;
    try {
      logFd = openSync(logFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      fchmodSync(logFd, 0o600);
      port = await freeLoopbackPort();
    } catch (error) {
      if (logFd !== undefined) closeSync(logFd);
      this.#releaseOwner();
      throw error;
    }
    const bootstrapToken = randomBytes(32).toString('base64url');
    const proofKey = randomBytes(32);
    let child;
    try {
      const { AAAAGENT_DSH_WEB_LOG: _inheritedDshLog,
        AAAAGENT_T3_PROJECT_CONTEXT_HMAC: _inheritedProofKey, ...inheritedEnvironment } = process.env;
      child = spawn(nodeExecutable, [join(sourceDir, 'apps/server/dist/bin.mjs'), 'start', '--bootstrap-fd', '3', '--no-browser'], {
        cwd: sourceDir, stdio: ['ignore', logFd, logFd, 'pipe'], windowsHide: true,
        env: { ...inheritedEnvironment, ...lockedEnvironment, AAAAGENT_T3_PROJECT_CONTEXT_HMAC: proofKey.toString('hex'),
          ...(dshWebLogPath ? { AAAAGENT_DSH_WEB_LOG: dshWebLogPath } : {}) },
      });
    } catch (error) { proofKey.fill(0); this.#releaseOwner(); throw error; }
    finally { closeSync(logFd); }
    let spawnError;
    child.once('error', error => { spawnError = error; });
    const bootstrap = { mode: 'desktop', noBrowser: true, port, t3Home: baseDir, host: '127.0.0.1',
      desktopBootstrapToken: bootstrapToken, tailscaleServeEnabled: false, tailscaleServePort: 443 };
    const origin = `http://127.0.0.1:${port}`;
    try {
      if (!child.stdio[3]) throw new Error('T3 bootstrap pipe unavailable');
      child.stdio[3].end(JSON.stringify(bootstrap) + '\n');
      const deadline = Date.now() + 30000;
      let ready = false;
      while (Date.now() < deadline && !exited(child)) {
        if (spawnError) throw new Error('T3 process could not start', { cause: spawnError });
        try {
          const response = await fetch(origin + '/.well-known/t3/environment', { signal: AbortSignal.timeout(600) });
          if (response.status >= 200 && response.status < 500) { ready = true; break; }
        } catch { /* The listener is still starting. */ }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (!ready) throw new Error('T3 listener did not become ready');
      const access = await this.#exchange(origin, bootstrapToken);
      const result = Object.freeze({ origin, ...access, sourceCommit: lock.commit, sourceDir, patchSha256: marker.patchSha256, pid: child.pid });
      this.#active = { child, public: result, bootstrapToken, proofKey };
      return result;
    } catch (error) {
      try { await stopCaptured(child); } finally { proofKey.fill(0); if (exited(child)) this.#releaseOwner(); }
      throw error;
    }
  }

  /** The child and this owner share a per-launch key; no HTTP or renderer API exposes it. */
  async signProviderContextProof(payload) {
    if (typeof payload !== 'string' || !payload || Buffer.byteLength(payload) > 8_000_000) {
      throw new Error('Invalid project context proof payload');
    }
    await this.start();
    const active = this.#active;
    if (!active || exited(active.child)) throw new Error('T3 proof owner unavailable');
    return createHmac('sha256', active.proofKey).update(payload).digest('hex');
  }

  async browserSession() {
    await this.start();
    const { origin } = this.#active.public;
    // T3 replaces the existing bearer for the same desktop-bootstrap subject.
    // Reuse the host's current token instead of exchanging a competing bearer.
    const admin = this.#active.public;
    const pairing = await fetch(origin + '/api/auth/pairing-token', { method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + admin.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'AAAAGENT native browser' }), signal: AbortSignal.timeout(5000) });
    if (!pairing.ok) throw new Error('Native browser pairing unavailable');
    const { credential } = await pairing.json();
    if (typeof credential !== 'string' || !credential) throw new Error('Invalid native pairing');
    const session = await fetch(origin + '/api/auth/browser-session', { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ credential }),
      signal: AbortSignal.timeout(5000) });
    if (!session.ok) throw new Error('Native browser session unavailable');
    const cookies = session.headers.getSetCookie();
    if (cookies.length !== 1 || !/^[A-Za-z0-9_-]+=[^;\r\n]+;/.test(cookies[0]) ||
        !/;\s*HttpOnly/i.test(cookies[0]) || /;\s*Domain=/i.test(cookies[0])) throw new Error('Invalid native session cookie');
    return cookies[0];
  }

  async #exchange(origin, bootstrapToken, scope = 'orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write') {
    const form = new URLSearchParams({ grant_type: TOKEN_EXCHANGE_GRANT, subject_token: bootstrapToken,
      subject_token_type: BOOTSTRAP_TOKEN_TYPE, requested_token_type: ACCESS_TOKEN_TYPE,
      scope, client_label: 'AAAAGENT local bridge',
      client_device_type: 'desktop' });
    const exchange = await fetch(origin + '/oauth/token', { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form,
      signal: AbortSignal.timeout(5000) });
    if (!exchange.ok) throw new Error(`T3 token exchange returned HTTP ${exchange.status}`);
    const token = await exchange.json();
    if (typeof token.access_token !== 'string' || token.token_type !== 'Bearer' ||
        typeof token.expires_in !== 'number' || token.expires_in <= 0) throw new Error('T3 token exchange response invalid');
    return { accessToken: token.access_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString() };
  }

  #releaseOwner() {
    if (!this.#owner) return;
    const { file, nonce } = this.#owner;
    this.#owner = null;
    try {
      const current = JSON.parse(readFileSync(file, 'utf8'));
      if (current.nonce === nonce && current.ownerPid === process.pid) unlinkSync(file);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  async stop() {
    if (this.#pending) await this.#pending.catch(() => undefined);
    if (!this.#active) { this.#releaseOwner(); return; }
    const { child, proofKey } = this.#active;
    this.#active = null;
    try { await stopCaptured(child); } finally { proofKey.fill(0); if (exited(child)) this.#releaseOwner(); }
  }
}
