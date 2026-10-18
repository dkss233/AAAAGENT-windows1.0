// Start the pinned DSH host the first time the pet actually needs it.
//
// The host is a ~420 MB background process, and nothing in chat, voice or expressions needs it, so
// keeping it alive for the whole pet session is wasteful. HarnessConnection already resolves its
// endpoint lazily through an async URL provider, so the start can happen exactly there: the first
// Harness use spawns the host and waits for the log, and later uses reuse it.
//
// The lock file makes this safe when several calls race (the relay and the work path both resolve
// the endpoint), and it also lets a host started earlier in the session be adopted, not duplicated.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { restrictPrivatePathSync } from '../core/platform-files.js';

const LOCK_TTL_MS = 180000;
// A first call must not block the caller for the host's whole boot: connection probes run on a timer
// and on page load, and stalling them would make the console look hung. So the first call spawns the
// host and waits only briefly; when it is not up yet the caller reports "unavailable" and the next
// poll (a few seconds later) finds it ready. DSH needs roughly ten to twenty seconds to boot.
const WAIT_MS = 4000;
const POLL_MS = 800;

interface EngineRuntime { nodeExecutable: string; dshEntrypoint: string; inventorySha256?: string }
export interface OnDemandEngineProfile {
  readonly runtime: EngineRuntime;
  readonly home: string;
  readonly dshHome: string;
  readonly dshWebLog: string;
  readonly dshPresetOverlay: string;
  readonly projectRoot?: string;
  readonly runtimeRoot?: string;
}

const readOrigin = (log: string): string | null => {
  try {
    // The newest line wins: an older, still-running host must not shadow the one just started.
    const match = [...readFileSync(log, 'utf8').matchAll(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)(?:\/\?token=[^\s]+)?/g)].at(-1);
    return match && match[1] ? match[1] : null;
  } catch { return null; }
};
const originAlive = async (origin: string | null): Promise<boolean> => {
  if (!origin) return false;
  try {
    const response = await fetch(origin, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return true;
  } catch { return false; }
};

/**
 * Record the Host identity the navigation verifier needs: `dsh-navigation-runtime` reads the same file
 * the T3 worker writes. Without it the verifier cannot vouch for this Host, the deep link is refused,
 * and "view in Harness" falls back to a bare origin the browser cannot authenticate.
 */
const recordHostIdentity = (profile: OnDemandEngineProfile, pid: number, origin: string): void => {
  if (!profile.projectRoot || !profile.runtimeRoot || !profile.runtime.inventorySha256) return;
  const file = join(profile.home, '.aaaagent-dsh-host.json');
  const identity = { version: 1, projectRoot: profile.projectRoot, runtimeRoot: profile.runtimeRoot, home: profile.home,
    dataHome: profile.dshHome, inventorySha256: profile.runtime.inventorySha256, pid, childPid: pid, origin, nonce: randomUUID() };
  writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
  try { restrictPrivatePathSync(file); } catch { /* best effort: the verifier re-checks privacy */ }
};

/** Spawn the host. Detached and logged the same way the standalone starter does it. */
function spawnHost(profile: OnDemandEngineProfile): number | undefined {
  const fd = openSync(profile.dshWebLog, 'w');
  try {
    const child = spawn(profile.runtime.nodeExecutable,
      [profile.runtime.dshEntrypoint, 'web', '--patch', profile.dshPresetOverlay,
        '--no-open', '--host', '127.0.0.1', '--port', '0'],
      { cwd: profile.home, env: { ...process.env, DSH_HOME: profile.dshHome }, stdio: ['ignore', fd, fd],
        detached: true, windowsHide: true });
    child.unref();
    // Remember the pid beside the log so a later run can adopt this host *and* vouch for its identity.
    try { writeFileSync(profile.dshWebLog + '.pid', String(child.pid)); } catch { /* adoption loses only the deep link */ }
    return child.pid;
  } finally { closeSync(fd); }
}

/**
 * Ensure a DSH host is serving the recorded origin, starting one when needed.
 * `waitMs` bounds how long the caller blocks: the status path uses the default short window, while an
 * explicit "start it" action can afford to wait for the whole boot.
 * Never throws for a start failure: the caller reports the Harness as unavailable, exactly as it
 * does today when no host is running.
 */
export async function ensureHarnessHost(profile: OnDemandEngineProfile, log: string, waitMs = WAIT_MS): Promise<boolean> {
  const adoptedOrigin = await originAlive(readOrigin(log)) ? readOrigin(log) : null;
  if (adoptedOrigin) {
    // Reuse a host from an earlier run only when we can also vouch for its identity; the navigation
    // verifier needs that record, and without it "view in Harness" cannot open the exact session.
    // A host we cannot identify is left alone and a fresh one is started below.
    try {
      const pid = Number(readFileSync(log + '.pid', 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 0) {
        process.kill(pid, 0);
        recordHostIdentity(profile, pid, adoptedOrigin);
        return true;
      }
    } catch { /* fall through and start an identifiable host */ }
  }

  const lock = log + '.on-demand.lock';
  const fresh = () => {
    try { return Date.now() - statSync(lock).mtimeMs < LOCK_TTL_MS; } catch { return false; }
  };
  let ownsLock = false;
  let spawnedPid: number | undefined;
  if (!fresh()) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
      ownsLock = true;
    } catch { ownsLock = false; }
  }
  if (ownsLock) {
    try { spawnedPid = spawnHost(profile); }
    catch { try { rmSync(lock, { force: true }); } catch { /* ignore */ } return false; }
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (await originAlive(readOrigin(log))) {
      if (ownsLock) { try { rmSync(lock, { force: true }); } catch { /* ignore */ } }
      if (spawnedPid) {
        recordHarnessHost(spawnedPid, log);
        const origin = readOrigin(log);
        if (origin) { try { recordHostIdentity(profile, spawnedPid, origin); } catch { /* keeps the deep link unavailable */ } }
      }
      return true;
    }
  }
  // Still booting: leave the lock in place so other callers wait instead of spawning a second host,
  // and let the lock's TTL recover the case where this starter died mid-boot.
  return false;
}

/** True once the recorded origin answers; used to report readiness without starting anything. */
export const harnessHostAlive = async (log: string): Promise<boolean> => originAlive(readOrigin(log));

// Status probes must stay cheap: the console polls them, so an HTTP liveness check on every request
// would add seconds to each one. A short cache keeps the answer fresh enough to notice a boot while
// never putting a network round trip on the request path.
const ALIVE_TTL_MS = 2000;
let aliveCache: { at: number; log: string; value: boolean } | null = null;
export async function harnessHostAliveCached(log: string): Promise<boolean> {
  if (aliveCache && aliveCache.log === log && Date.now() - aliveCache.at < ALIVE_TTL_MS) return aliveCache.value;
  const value = await originAlive(readOrigin(log));
  aliveCache = { at: Date.now(), log, value };
  return value;
}

/** Kick a start without waiting for the host to boot. Safe to call repeatedly. */
export function startHarnessHostInBackground(profile: OnDemandEngineProfile, log: string): void {
  void ensureHarnessHost(profile, log).catch(() => { /* reported as unavailable by the next probe */ });
}

// ── Stopping on exit ─────────────────────────────────────────────────────────────────────────────
// The host is deliberately detached, so nothing stops it when the pet exits. That is right for a
// restart but wasteful when the operator is done for the day, so the pet stops the host it started.

let launchedPid: number | undefined;
const recordHarnessHost = (pid: number, log: string): void => {
  launchedPid = pid;
  try { rmSync(log + '.owned.lock', { force: true }); } catch { /* ignore */ }
  try { writeFileSync(log + '.owned.lock', String(pid), { flag: 'wx' }); } catch { /* ignore */ }
};

const processTable = (): { pid: number; parent: number }[] => {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' } | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return out.split(/\r?\n/).map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2 && parts.every((part) => /^\d+$/.test(part)))
      .map(([pid, parent]) => ({ pid: Number(pid), parent: Number(parent) }));
  } catch { return []; }
};

/** Terminate a process tree, children first, so the host cannot leave a relay behind. */
function terminateTree(rootPid: number): number {
  const table = processTable();
  const children = new Map<number, number[]>();
  for (const row of table) children.set(row.parent, [...(children.get(row.parent) ?? []), row.pid]);
  const order: number[] = [];
  const walk = (pid: number, depth: number) => {
    if (depth > 5) return;
    for (const child of children.get(pid) ?? []) walk(child, depth + 1);
    order.push(pid);
  };
  walk(rootPid, 0);
  let stopped = 0;
  for (const pid of order) {
    // The detached host does not live under this process's job object, so a signal works and
    // force-killing is the only reliable fallback for a wedged host.
    try { process.kill(pid, 'SIGKILL'); stopped++; } catch { /* already gone */ }
  }
  return stopped;
}

/**
 * Stop the host this backend started, freeing its memory. A host started by the console's button or an
 * earlier pet run is left alone, because stopping a process this run does not own would be a surprise.
 */
export async function stopOwnedHarnessHost(log: string): Promise<boolean> {
  let pid = launchedPid;
  if (!pid) {
    try { pid = Number(readFileSync(log + '.owned.lock', 'utf8').trim()) || undefined; }
    catch { pid = undefined; }
  }
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  const stopped = terminateTree(pid);
  for (const suffix of ['.owned.lock']) { try { rmSync(log + suffix, { force: true }); } catch { /* ignore */ } }
  aliveCache = null;
  return stopped > 0;
}
