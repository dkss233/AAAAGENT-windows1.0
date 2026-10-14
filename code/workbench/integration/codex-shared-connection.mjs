import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';

export const sharedCodexConnectionPath = root => join(root, 'data/desktop-pet/codex-shared-connection.json');
export function codexSharedTransport(homePath) {
  if (typeof homePath !== 'string' || !isAbsolute(homePath) || /[\u0000-\u001f:]/u.test(homePath))
    throw Error('Canonical local Codex home required');
  const socketPath = join(homePath, 'app-server-control/app-server-control.sock');
  if (Buffer.byteLength(socketPath) >= 104) throw Error('Codex shared Unix socket path too long');
  const quotedSocket = "'" + socketPath.replaceAll("'", "'\\''") + "'";
  return { socketPath, desktopWebsocketUrl: 'ws+unix://' + socketPath + ':/rpc',
    providerLaunchArgs: '--aaaagent-shared-unix ' + quotedSocket };
}

/** Codex0.160 publishes an alias to this exact protected socket, rather than a socket at the alias. */
export function inspectSharedCodexSocket(socketPath, {
  stat = lstatSync, realpath = realpathSync, uid = process.getuid?.(),
} = {}) {
  const parent = dirname(socketPath), parentStat = stat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== uid || parentStat.mode & 0o077)
    throw Error('Private Codex socket parent required');
  const alias = stat(socketPath);
  if (alias.uid !== uid) throw Error('Codex socket owner changed');
  let physicalPath = socketPath;
  if (alias.isSymbolicLink()) {
    const daemonDirectory = join(realpath('/tmp'), 'codex-daemon-' + uid);
    const protectedDir = stat(daemonDirectory);
    if (!protectedDir.isDirectory() || protectedDir.isSymbolicLink() || protectedDir.uid !== uid ||
        (protectedDir.mode & 0o777) !== 0o700) throw Error('Codex protected socket directory changed');
    const canonicalAlias = join(realpath(parent), basename(socketPath));
    const expected = join(daemonDirectory, createHash('sha256').update(canonicalAlias).digest('hex'));
    physicalPath = realpath(socketPath);
    if (physicalPath !== expected) throw Error('Codex socket alias points to a different owner');
  }
  const socket = stat(physicalPath);
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== uid || socket.mode & 0o077)
    throw Error('Private Codex socket required');
  return { physicalPath, device: socket.dev, inode: socket.ino };
}

/** A source label never grants access: only an installed, private, live activation receipt does. */
export function readCodexSharedConnection(root, codexHome, {
  stat = lstatSync, read = readFileSync, realpath = realpathSync,
  alive = pid => { process.kill(pid, 0); return true; }, uid = process.getuid?.(),
  nativeSessionId,
} = {}) {
  try {
    const file = sharedCodexConnectionPath(root), fileStat = stat(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.uid !== uid || fileStat.mode & 0o077) return null;
    const receipt = JSON.parse(read(file, 'utf8'));
    const transport = codexSharedTransport(codexHome);
    if (receipt.version !== 1 || receipt.status !== 'active' || receipt.transport !== 'shared-unix' ||
        receipt.codexHome !== codexHome || realpath(codexHome) !== codexHome ||
        receipt.socketPath !== transport.socketPath || receipt.desktopWebsocketUrl !== transport.desktopWebsocketUrl ||
        receipt.providerLaunchArgs !== transport.providerLaunchArgs ||
        !Number.isFinite(Date.parse(receipt.activatedAt)) ||
        !/^[a-f0-9]{64}$/.test(receipt.originalAppTransportSha256 ?? '') ||
        receipt.proof?.originalAppConnected !== true || receipt.proof?.sameServerObserved !== true ||
        receipt.proof?.originalMcpPreserved !== true || receipt.proof?.originalSkillsPreserved !== true ||
        receipt.proof?.providerTransportVerified !== true ||
        !Number.isSafeInteger(receipt.originalAppPid) || receipt.originalAppPid < 1 ||
        !Number.isSafeInteger(receipt.serverPid) || receipt.serverPid < 1 ||
        receipt.originalAppPid === receipt.serverPid ||
        !alive(receipt.originalAppPid) || !alive(receipt.serverPid)) return null;
    if (nativeSessionId !== undefined) {
      const original = receipt.sharedSessions?.[nativeSessionId];
      if (!original || original.nativeSessionId !== nativeSessionId || original.sameOwnerObserved !== true ||
          original.originalMcpPreserved !== true || original.originalSkillsPreserved !== true ||
          !/^[a-f0-9]{64}$/.test(original.ownerConfigurationSha256 ?? '')) return null;
    }
    const socket = inspectSharedCodexSocket(transport.socketPath, { stat, realpath, uid });
    if (socket.device !== receipt.socketDevice || socket.inode !== receipt.socketInode) return null;
    const settings = JSON.parse(read(join(root, 'data/desktop-pet/t3-home/userdata/settings.json'), 'utf8'));
    const config = settings.providerInstances?.codex?.config;
    if (settings.providerInstances?.codex?.enabled !== true ||
        settings.providerInstances?.codex?.driver !== 'codex' ||
        config?.homePath !== codexHome || config?.binaryPath !== join(root, 'artifacts/runtime/engine-bindings/codex') ||
        createHash('sha256').update(config?.launchArgs ?? '').digest('hex') !== receipt.originalProviderLaunchArgsSha256) return null;
    return { ...transport, codexHome, serverPid: receipt.serverPid, originalAppPid: receipt.originalAppPid };
  } catch { return null; }
}

/** Resolve only original imported App sessions; ordinary T3 sessions retain their native configuration. */
export async function originalAppSharedSession(input) {
  if (typeof input.binaryPath !== 'string' || !input.binaryPath.endsWith('/artifacts/runtime/engine-bindings/codex') ||
      typeof input.threadId !== 'string' || !input.threadId.startsWith('import:codex:')) return { kind: 'native' };
  const cursor = input.resumeCursor;
  const sid = cursor?.threadId;
  if (typeof sid !== 'string' || input.threadId !== 'import:codex:' + sid || !input.homePath) return { kind: 'unavailable' };
  try {
    const root = dirname(dirname(dirname(dirname(input.binaryPath))));
    if (realpathSync(root) !== root || realpathSync(input.homePath) !== input.homePath) return { kind: "unavailable" };
    const file = join(input.homePath, "state_5.sqlite"), info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) return { kind: "unavailable" };
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(file, { readOnly: true });
    let metadata;
    try { metadata = database.prepare("SELECT id,cwd,originator FROM threads WHERE id=? AND archived=0").get(sid); }
    finally { database.close(); }
    if (metadata?.id !== sid || metadata.cwd !== input.cwd) return { kind: "unavailable" };
    if (!["Codex Desktop", "codex_work_desktop"].includes(String(metadata.originator))) return { kind: "native" };
    const connection = readCodexSharedConnection(root, input.homePath, { nativeSessionId: sid });
    return connection ? { kind: "shared", launchArgs: connection.providerLaunchArgs } : { kind: "unavailable" };
  } catch { return { kind: "unavailable" }; }
}
