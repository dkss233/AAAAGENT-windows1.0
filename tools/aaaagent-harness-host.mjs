// The pinned DSH host, used by both the pet launcher and the standalone Harness starter.
//
// DSH prints an origin plus a per-process authentication token to its own log, and that token is the
// only way to talk to it, so a host has to be running before anything can connect. Nothing in the
// pet's chat path needs it, so starting it is a deliberate step rather than a launch side effect.
import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { readEngineProfile } from '../code/workbench/integration/engine-pins/profile.mjs';
import { engineEnvironment } from '../code/workbench/integration/engine-pins/runtime.mjs';

export const readOrigin = (logPath) => {
  try {
    const match = readFileSync(logPath, 'utf8').match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)/);
    return match ? match[1] : null;
  } catch { return null; }
};

export const originAlive = async (origin) => {
  if (!origin) return false;
  try {
    const response = await fetch(origin, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    await response.body?.cancel();
    return true;
  } catch { return false; }
};

/** A token-bearing URL for the operator's browser; the pet itself opens a token-free address. */
export const readTokenUrl = (logPath) => {
  try {
    const match = readFileSync(logPath, 'utf8').match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
    return match ? match[1] : null;
  } catch { return null; }
};

export function loadProfile(root) {
  const profile = readEngineProfile(root);
  if (!profile) throw Error('引擎档案无效，无法启动 Harness 主机。');
  return profile;
}

/**
 * Start the pinned DSH host if one is not already serving the recorded origin.
 * Returns { started, origin } — `started` is false when an existing host was reused.
 */
export async function startHarnessHost({ profile, root, log, waitMs = 120000, onNote = () => {} }) {
  const existing = readOrigin(profile.dshWebLog);
  if (await originAlive(existing)) return { started: false, origin: existing };

  const environment = {
    ...engineEnvironment(profile.runtime, profile.home),
    DSH_HOME: profile.dshHome,
    CODEX_HOME: profile.codexHome,
  };
  // Redirect the host's own output straight into the log the pet reads, so the log stays accurate
  // for the life of the process without this launcher having to stay alive.
  const fd = openSync(profile.dshWebLog, 'w');
  const child = spawn(profile.runtime.nodeExecutable,
    [profile.runtime.dshEntrypoint, 'web', '--patch', profile.dshPresetOverlay,
      '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { cwd: profile.home, env: environment, stdio: ['ignore', fd, fd], detached: true, windowsHide: true });
  child.unref();
  closeSync(fd);
  onNote('已启动 Harness 主机（pid ' + child.pid + '），等待就绪…');

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const current = readOrigin(profile.dshWebLog);
    if (current && await originAlive(current)) return { started: true, origin: current };
  }
  return { started: true, origin: null, timedOut: true };
}
