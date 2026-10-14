import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngineProfile, verifyT3EngineSettings } from './engine-pins/profile.mjs';
import { ensureDshHost, readDshHost, stopDshHost } from './engine-pins/dsh-service.mjs';
import { verifyT3EngineAdapter } from './engine-pins/prepare-t3-adapter.mjs';
import { isPrivateFileSync, restrictPrivatePathSync } from '../../desktop-pet/dist/core/platform-files.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const originPattern = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/;
/** The private host owns the child. Closing any caller only detaches that caller. */
export class T3LocalService {
  constructor(options) {
    for (const path of [options.sourceDir, options.nodeExecutable, options.baseDir, options.logFile]) {
      if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw Error('Invalid T3 host path');
    }
    this.options = options;
    this.file = join(options.baseDir, '.aaaagent-t3-host.json');
    this.lock = join(options.baseDir, '.aaaagent-t3-host.lock');
  }
  readHost() {
    const stat = lstatSync(this.file);
    if (!stat.isFile() || !isPrivateFileSync(this.file)) throw Error('Unsafe T3 host descriptor');
    const d = JSON.parse(readFileSync(this.file, 'utf8'));
    if (d.version !== 1 || !originPattern.test(d.origin) || Number(new URL(d.origin).port) > 65535 ||
        !/^[a-f0-9]{64}$/.test(d.token) || !Number.isSafeInteger(d.hostPid) || d.hostPid < 1 ||
        d.sourceDir !== this.options.sourceDir || d.baseDir !== this.options.baseDir ||
        d.engineProjectRoot !== this.options.engineProjectRoot) throw Error('T3 host mismatch');
    process.kill(d.hostPid, 0);
    return d;
  }
  async request(host, action, payload) {
    const r = await fetch(host.origin + '/control', { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(35000), headers: { Authorization: 'Bearer ' + host.token, 'Content-Type': 'application/json',
        // Full file verification can block this caller past the host's idle timeout.
        // Keep private control reads off stale pooled sockets; never replay commands.
        Connection: 'close' },
      body: JSON.stringify({ action, payload }) });
    if (!r.ok) throw Error('T3 host operation unavailable');
    return r.json();
  }
  async ensureHost() {
    // A live, already verified host keeps its loaded engine snapshot. Each new host
    // validates the complete graph; each Codex child also validates at launch.
    let existing;
    try { existing = this.readHost(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && this.verifiedEngineHostPid === existing.hostPid) {
      verifyT3EngineSettings(this.options.baseDir, this.verifiedEngineProfile);
      try { readDshHost(this.options.engineProjectRoot, this.verifiedEngineProfile); }
      catch (error) {
        // A missing registered DSH host may restart through the complete guard.
        // Unknown owners or a partly exited descriptor remain explicit errors.
        if (error.code !== 'ENOENT') throw error;
        await ensureDshHost(this.options.engineProjectRoot);
      }
      return existing;
    }
    if (this.options.engineProjectRoot) {
      const profile = readEngineProfile(this.options.engineProjectRoot);
      if (!profile || this.options.nodeExecutable !== profile.runtime.nodeExecutable ||
          this.options.dshWebLogPath !== profile.dshWebLog) throw Error('Project engine binding unavailable');
      verifyT3EngineSettings(this.options.baseDir, profile);
      verifyT3EngineAdapter(this.options.runtimeSourceDir ?? this.options.sourceDir);
      await ensureDshHost(this.options.engineProjectRoot);
      this.verifiedEngineProfile = profile;
    }
    if (existing) {
      if (this.verifiedEngineProfile) this.verifiedEngineHostPid = existing.hostPid;
      return existing;
    }
    mkdirSync(this.options.baseDir, { recursive: true, mode: 0o700 });
    restrictPrivatePathSync(this.options.baseDir);
    mkdirSync(dirname(this.options.logFile), { recursive: true, mode: 0o700 });
    const nonce = randomBytes(24).toString('hex');
    let acquired = false;
    try {
      const fd = openSync(this.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, JSON.stringify({ nonce, launcherPid: process.pid })); acquired = true; } finally { closeSync(fd); }
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (acquired) {
      let fd;
      try {
        fd = openSync(this.options.logFile, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        const child = spawn(this.options.nodeExecutable, [fileURLToPath(new URL('./t3-host.mjs', import.meta.url))], {
          detached: true, stdio: ['ignore', fd, fd, 'pipe'], windowsHide: true,
        });
        await new Promise((done, reject) => { child.once('spawn', done); child.once('error', reject); });
        child.stdio[3].end(JSON.stringify({ options: this.options, nonce }) + '\n');
        child.unref();
      } catch (e) {
        try { if (JSON.parse(readFileSync(this.lock, 'utf8')).nonce === nonce) unlinkSync(this.lock); } catch {}
        throw e;
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    const deadline = Date.now() + 40000;
    while (Date.now() < deadline) {
      try { const host = this.readHost();
        if (this.verifiedEngineProfile) this.verifiedEngineHostPid = host.hostPid;
        return host;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await sleep(100);
    }
    throw Error('T3 host startup incomplete; reconcile its registered owner before retrying');
  }
  async start() { return this.request(await this.ensureHost(), 'connection'); }
  async openBrowser(target) { return this.request(await this.ensureHost(), 'open', target); }
  async signProviderContextProof(payload) { return (await this.request(await this.ensureHost(), 'proof', payload)).signature; }
  async status() { return this.request(this.readHost(), 'status'); }
  async stop() { /* Caller shutdown deliberately leaves engineering work running. */ }
  async stopBackground() {
    await this.request(this.readHost(), 'stop');
    if (this.options.engineProjectRoot) await stopDshHost(this.options.engineProjectRoot);
  }
}
