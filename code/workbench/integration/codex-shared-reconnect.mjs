import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyEngineRuntime } from './engine-pins/runtime.mjs';
import { codexSharedTransport, inspectSharedCodexSocket, sharedCodexConnectionPath } from './codex-shared-connection.mjs';
import { readAppMember, readAppUpdateSources, verifyManagedUpdatePolicy, updatePolicyPorts, UPDATE_ENV } from './codex-update-policy.mjs';

const APP = '/Applications/ChatGPT.app';
const APP_EXEC = APP + '/Contents/MacOS/ChatGPT';
const OLD_CLI = APP + '/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const MAX_NORMAL_EXIT_WAIT_MS = 2 * 60 * 60 * 1000;
const script = fileURLToPath(import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(done => setTimeout(done, ms));
const problem = code => Object.assign(new Error(code), { code });
const exists = async path => { try { await lstat(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

/** The reviewed connection member stays pinned even when a signed App updates unrelated files. */
export async function readAppTransport(asar) {
  try { return await readAppMember(asar, /^application-network-startup-[a-zA-Z0-9_-]+\.js$/u); }
  catch { throw problem('reviewed_App_transport_required'); }
}

/** The App selects a SOCKS proxy for a hostname-less URL, even when ws uses a Unix socket. */
export function originalAppLocalSocketUrl(socketPath) {
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || /[\u0000-\u0020:?#%]/u.test(socketPath))
    throw problem('reviewed_local_socket_path_required');
  return 'ws+unix://localhost' + socketPath + ':/rpc';
}

export async function verifyReviewedAppSources(job, ports, phase) {
  const current = await ports.readSources();
  if (current.scriptSha256 !== job.scriptSha256) throw problem('reviewed_source_changed');
  const exact = current.appAsarSha256 === job.appAsarSha256 && current.appExecutableSha256 === job.appExecutableSha256;
  if (!exact && !(job.version === 2 && phase === 'after_normal_exit')) throw problem('reviewed_source_changed');
  let transport;
  if (job.version === 2) {
    transport = await ports.verifyTrustedApp();
    if (transport.memberSha256 !== job.appTransportSha256) throw problem('reviewed_App_transport_changed');
  }
  return { status: exact ? 'exact_reviewed_App' : 'signed_update_same_reviewed_transport', ...current, ...(transport ?? {}) };
}

async function verifyTrustedOriginalApp() {
  // Apple-anchored OpenAI signatures validate complete sealed resources, including the ASAR.
  for (const [path, identifier] of [[APP, 'com.openai.codex'], [OLD_CLI, 'codex']]) {
    try { execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R',
      '=identifier "' + identifier + '" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"', path], { stdio: 'pipe' }); }
    catch { throw problem('trusted_original_App_required'); }
  }
  return readAppTransport(APP + '/Contents/Resources/app.asar');
}

async function privateFile(path) {
  const owner = process.getuid(), parent = await lstat(dirname(path)), file = await lstat(path);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== owner || parent.mode & 0o077 ||
      !file.isFile() || file.isSymbolicLink() || file.uid !== owner || file.mode & 0o077)
    throw problem('private_operator_file_required');
  return readFile(path);
}

async function record(path, value, exclusive = false) {
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (exclusive) return writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  const temporary = path + '.' + process.pid + '.tmp';
  await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

export function parseReconnectionProcessRows(output) {
  return output.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/u);
    return match && !match[3].startsWith('Z') ? [{ pid: Number(match[1]), ppid: Number(match[2]),
      state: match[3], startedAt: match[4], executable: match[5] }] : [];
  });
}

function processes() {
  return parseReconnectionProcessRows(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,stat=,lstart=,comm='],
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }));
}

function birth(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim(); }
  catch (error) { if (error.status === 1) return undefined; throw error; }
}

/** Identity metadata only; original jobs keep their exact PID and birth pins. */
export function inspectReconnectionOwners(job, rows) {
  const app = rows.find(p => p.pid === job.originalAppPid), cli = rows.find(p => p.pid === job.originalCliPid);
  const otherApps = rows.filter(p => p.executable === APP_EXEC && p.pid !== job.originalAppPid);
  return { originalApp: !!app, originalCli: !!cli, foreignApp: otherApps.length !== 0,
    changedOriginalPid: !!(app && (app.executable !== APP_EXEC || job.version === 2 && app.startedAt !== job.originalAppStartedAt) ||
      cli && (cli.executable !== OLD_CLI ||
        cli.ppid !== job.originalAppPid && !(job.version === 2 && cli.ppid === 1) ||
        job.version === 2 && cli.startedAt !== job.originalCliStartedAt)),
    app: app ?? null, cli: cli ?? null, otherApps: otherApps.slice(0, 5) };
}

/** Never shares the App's process group, terminal, or standard streams. */
export function spawnDetachedOperator(executable, args, environment = process.env) {
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', env: environment });
  child.unref();
  return child;
}

/** Read-only metadata, never turn/resume/tool/approval. Recovery may inspect loaded status. */
export async function probeSharedServer(WebSocket, url, timeoutMs = 5000, inspectIdleThreads = false) {
  const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
  let nextId = 1;
  const requests = new Map();
  const failAll = () => { for (const request of requests.values()) request.reject(problem('shared_probe_failed')); requests.clear(); };
  ws.on('error', failAll);
  ws.on('close', failAll);
  ws.on('message', (bytes, binary) => {
    try {
      if (binary) throw problem('shared_probe_failed');
      const frame = JSON.parse(String(bytes)), request = requests.get(frame.id);
      if (!request) return;
      requests.delete(frame.id);
      frame.error ? request.reject(problem('shared_probe_failed')) : request.resolve(frame.result);
    } catch { failAll(); }
  });
  const request = (method, params) => new Promise((resolveReply, reject) => {
    const id = nextId++, timer = setTimeout(() => { requests.delete(id); reject(problem('shared_probe_timeout')); }, timeoutMs);
    requests.set(id, { resolve: value => { clearTimeout(timer); resolveReply(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    ws.send(JSON.stringify({ id, method, params }), error => { if (error) { requests.get(id)?.reject(problem('shared_probe_failed')); requests.delete(id); } });
  });
  try {
    await new Promise((done, reject) => { ws.once('open', done); ws.once('error', () => reject(problem('shared_probe_failed'))); });
    await request('initialize', { clientInfo: { name: 'aaaagent_reconnect_readonly', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    ws.send(JSON.stringify({ method: 'initialized', params: {} }));
    const result = await request('thread/loaded/list', {});
    if (!Array.isArray(result?.data) || result.data.some(id => typeof id !== 'string')) throw problem('shared_probe_failed');
    if (!inspectIdleThreads) return { loadedThreadsCount: result.data.length };
    let allLoadedThreadsIdle = true;
    for (const threadId of result.data) {
      const read = await request('thread/read', { threadId, includeTurns: false });
      if (read?.thread?.id !== threadId || read.thread.status?.type !== 'idle') allLoadedThreadsIdle = false;
    }
    const final = await request('thread/loaded/list', {});
    if (!Array.isArray(final?.data) || JSON.stringify([...final.data].sort()) !== JSON.stringify([...result.data].sort()))
      allLoadedThreadsIdle = false;
    return { loadedThreadsCount: result.data.length, allLoadedThreadsIdle };
  } finally { failAll(); ws.terminate(); }
}

/** Recovery signals only our exact empty server, after every ownership check. */
export async function recoverOwnedReconnection(server, ports) {
  const owner = await ports.owners();
  if (owner.originalApp || owner.foreignApp || owner.originalCli || owner.changedOriginalPid) return { status: 'live_or_changed_owner_preserved' };
  if (await ports.activated()) return { status: 'activation_requires_I_review' };
  if (server?.reused === true) {
    // A server preserved from the previous operation never becomes this operation's stop target.
    const current = await ports.owners();
    if (current.originalApp || current.foreignApp || current.originalCli || current.changedOriginalPid)
      return { status: 'live_or_changed_owner_preserved' };
    await ports.openOriginalApp();
    return { status: 'reused_server_preserved_original_App_reopen_requested' };
  }
  if (server && await ports.serverAlive(server)) {
    if (!await ports.serverIdentity(server)) return { status: 'server_owner_changed' };
    const proof = await ports.serverProof(server);
    if (!proof.sameSocket) return { status: 'socket_owner_changed' };
    if (proof.loadedThreadsCount !== 0 && proof.allLoadedThreadsIdle !== true) return { status: 'active_or_unknown_server_preserved' };
    if (proof.otherHolder) return { status: 'other_socket_holder_preserved' };
    const beforeStop = await ports.owners();
    if (beforeStop.originalApp || beforeStop.foreignApp || beforeStop.originalCli || beforeStop.changedOriginalPid)
      return { status: 'live_or_changed_owner_preserved' };
    await ports.stopOwnedServer(server);
    if (!await ports.waitOwnedServerExit(server)) return { status: 'owned_server_exit_pending' };
  } else if (await ports.endpointPresent()) return { status: 'unknown_socket_preserved' };
  // Recheck after the server probe/exit; another App must not be redirected.
  const current = await ports.owners();
  if (current.originalApp || current.foreignApp || current.originalCli || current.changedOriginalPid) return { status: 'live_or_changed_owner_preserved' };
  await ports.openOriginalApp();
  return { status: 'original_App_normal_reopen_requested' };
}

/** Reuse only the exact recorded, empty service with no other socket peer. */
export async function verifyReusableServer(server, ports) {
  if (!await ports.serverIdentity(server)) throw problem('reused_server_owner_changed');
  const proof = await ports.serverProof(server);
  if (!proof.sameSocket) throw problem('reused_socket_owner_changed');
  if (proof.otherHolder) throw problem('reused_server_other_peer');
  if (proof.loadedThreadsCount !== 0 || proof.allLoadedThreadsIdle !== true) throw problem('reused_server_not_empty');
  if (!await ports.serverIdentity(server)) throw problem('reused_server_owner_changed');
  return { ...server, reused: true };
}

/** A bounded one-shot handoff. Exiting the App is always the human's action. */
export async function runReconnection(job, ports) {
  let server = job.reusedServer ? { ...job.reusedServer, reused: true } : undefined;
  let phase = 'validate'; const normalExitObservations = [];
  const checkOwners = owners => {
    if (owners.foreignApp || owners.changedOriginalPid)
      throw Object.assign(problem('owner_changed'), { ownerSnapshot: owners });
  };
  try {
    await ports.validate();
    const until = ports.now() + job.waitForExitMs;
    await ports.save({ status: 'waiting_for_normal_App_exit', carrierPid: process.pid,
      waitForExitMs: job.waitForExitMs, normalAppExitDeadline: new Date(until).toISOString() });
    phase = 'wait_normal_exit';
    for (;;) {
      if (await ports.cancelled()) throw problem('cancelled');
      const owners = await ports.owners();
      if (JSON.stringify(normalExitObservations.at(-1)?.owners) !== JSON.stringify(owners)) {
        normalExitObservations.push({ observedAt: new Date(ports.now()).toISOString(), owners });
        if (normalExitObservations.length > 8) normalExitObservations.shift();
      }
      checkOwners(owners);
      if (!owners.originalApp && !owners.originalCli) break;
      if (ports.now() >= until) throw problem('normal_exit_timeout');
      await ports.sleep(Math.min(1000, Math.max(1, until - ports.now())));
    }
    phase = 'validate_after_exit';
    const appSourceReview = await ports.validate('after_normal_exit');
    if (await ports.cancelled()) throw problem('cancelled');
    phase = 'prepare_server';
    if (job.reusedServer) server = await ports.reuseServer(job.reusedServer);
    else { await ports.assertUnused(); server = await ports.startServer(); }
    await ports.save({ status: server.reused ? 'existing_shared_server_reused' : 'owned_shared_server_started',
      carrierPid: process.pid, serverPid: server.pid, server, appSourceReview });
    phase = 'verify_server'; await ports.waitServer(server);
    await ports.save({ status: 'owned_shared_server_idle_verified', carrierPid: process.pid, serverPid: server.pid, server });
    if (await ports.cancelled()) throw problem('cancelled');
    phase = 'before_shared_App_open'; const owners = await ports.owners();
    checkOwners(owners);
    if (owners.originalApp || owners.originalCli)
      throw Object.assign(problem('owner_changed'), { ownerSnapshot: owners });
    await ports.openSharedApp();
    phase = 'wait_shared_App'; const app = await ports.waitApp();
    await ports.save({ status: 'App_reopened_owner_verification_pending', carrierPid: process.pid, serverPid: server.pid,
      server, appSourceReview, observedAppPid: app.pid, normalExitObservations,
      originalAppConnectedVerified: false, activationWritten: false, modelTurns: 0 });
    return { status: 'App_reopened_owner_verification_pending', serverPid: server.pid, appPid: app.pid };
  } catch (error) {
    const code = typeof error.code === 'string' ? error.code : 'reconnection_failed';
    // The recovery port refuses a loaded/changed server or a live App; it never forces a quit.
    const recovery = await ports.recover(server).catch(() => ({ status: 'recovery_requires_cold_read' }));
    await ports.save({ status: 'reconnection_stopped', reason: code, carrierPid: process.pid,
      ...(server ? { serverPid: server.pid, server } : {}), failurePhase: phase,
      ...(error.ownerSnapshot ? { ownerSnapshot: error.ownerSnapshot } : {}), normalExitObservations,
      recovery, activationWritten: false, modelTurns: 0 });
    return { status: 'reconnection_stopped', reason: code, recovery };
  }
}

async function operator(jobFile, requireWindow = false) {
  const bytes = await privateFile(jobFile), job = JSON.parse(bytes), jobHash = digest(bytes), directory = dirname(jobFile);
  if (![1, 2].includes(job.version) || job.kind !== 'original_App_shared_reconnection' || !/^[a-z0-9-]{8,80}$/u.test(job.operationId) ||
      !Number.isSafeInteger(job.originalAppPid) || !Number.isSafeInteger(job.originalCliPid) ||
      job.originalAppPid < 1 || job.originalCliPid < 1 || job.originalAppPid === job.originalCliPid ||
      !Number.isSafeInteger(job.waitForExitMs) || job.waitForExitMs < 100 || job.waitForExitMs > MAX_NORMAL_EXIT_WAIT_MS ||
      ![job.scriptSha256, job.appAsarSha256, job.appExecutableSha256, job.installedConfigSha256, job.originalProviderLaunchArgsSha256,
        ...(job.version === 2 ? [job.appTransportSha256, job.originalHomeConfigSha256] : [])].every(s => /^[a-f0-9]{64}$/u.test(s ?? '')) ||
      job.version === 2 && (![job.originalAppStartedAt, job.originalCliStartedAt].every(s => typeof s === 'string' && s.length > 10)))
    throw problem('invalid_reviewed_job');
  const root = resolve(job.projectRoot), home = resolve(job.codexHome), runtime = verifyEngineRuntime(job.engineRoot);
  if (runtime.inventorySha256 !== job.engineInventorySha256 || process.execPath !== runtime.nodeExecutable ||
      runtime.root !== join(root, 'artifacts/runtime/engines-codex-0.160.0-dsh-0.2.0-rc.2-darwin-arm64')) throw problem('fixed_runtime_required');
  const route = codexSharedTransport(home), statePath = join(directory, 'state.json');
  const WebSocket = (await import(pathToFileURL(join(root, 'artifacts/runtime/engine-pin-54/t3-runtime/apps/server/node_modules/ws/index.js')).href)).default;
  const pidRow = pid => processes().find(p => p.pid === pid);
  const serverIdentity = server => pidRow(server.pid)?.executable === runtime.codexExecutable &&
    typeof server.startedAt === 'string' && birth(server.pid) === server.startedAt;
  const serverProof = async server => {
    const socket = inspectSharedCodexSocket(route.socketPath);
    const sameSocket = !!server.socket && server.socket.device === socket.device && server.socket.inode === socket.inode &&
      server.socket.physicalPath === socket.physicalPath;
    const proof = await probeSharedServer(WebSocket, route.desktopWebsocketUrl, 5000, true);
    const holders = execFileSync('/usr/sbin/lsof', ['-t', '--', socket.physicalPath], { encoding: 'utf8' }).trim().split(/\s+/u).map(Number);
    return { sameSocket, ...proof, otherHolder: holders.some(pid => pid !== server.pid) };
  };
  const owners = async () => {
    // PID, parent, birth and executable come from one ps row, including during normal teardown.
    return inspectReconnectionOwners(job, processes());
  };
  const validate = async phase => {
    if (requireWindow && (job.window?.status !== 'arranged' || !/^[a-f0-9]{64}$/u.test(job.window?.humanEvidenceSha256 ?? '') ||
        !Number.isFinite(Date.parse(job.window?.validUntil)) || Date.parse(job.window.validUntil) <= Date.now()))
      throw problem('arranged_current_window_required');
    if (digest(await privateFile(jobFile)) !== jobHash) throw problem('reviewed_source_changed');
    const appSourceReview = await verifyReviewedAppSources(job, {
      readSources: async () => ({ scriptSha256: await fileDigest(script), appAsarSha256: await fileDigest(APP + '/Contents/Resources/app.asar'),
        appExecutableSha256: await fileDigest(APP_EXEC) }), verifyTrustedApp: verifyTrustedOriginalApp,
    }, phase);
    const { realpath } = await import('node:fs/promises');
    if (await realpath(root) !== root || await realpath(home) !== home) throw problem('canonical_home_required');
    if (job.version === 2 && await fileDigest(join(home, 'config.toml')) !== job.originalHomeConfigSha256)
      throw problem('original_home_config_changed');
    if (job.updatePolicy) {
      if (job.version !== 2 || await fileDigest(new URL('./codex-update-policy.mjs', import.meta.url)) !== job.updatePolicy.sourceSha256)
        throw problem('reviewed_update_policy_changed');
      await verifyManagedUpdatePolicy(job.updatePolicy, {
        sources: () => readAppUpdateSources(APP + '/Contents/Resources/app.asar'), inspect: updatePolicyPorts().inspect,
      });
    } else if (job.version === 2 && job.appUpdatesPaused === true) {
      for (const key of ['SUAutomaticallyUpdate', 'SUEnableAutomaticChecks']) {
        if (execFileSync('/usr/bin/defaults', ['read', 'com.openai.codex', key], { encoding: 'utf8', stdio: 'pipe' }).trim() !== '0')
          throw problem('original_App_updates_not_paused');
      }
    }
    if (job.localSocketProxyBypass) {
      if (job.version !== 2 || job.localSocketProxyBypass !== true || !/^[a-f0-9]{64}$/u.test(job.appProxySelectionSha256 ?? ''))
        throw problem('reviewed_local_proxy_selection_required');
      const source = await readAppMember(APP + '/Contents/Resources/app.asar', /^main-[a-zA-Z0-9_-]+\.js$/u);
      if (source.memberSha256 !== job.appProxySelectionSha256) throw problem('reviewed_App_proxy_selection_changed');
    }
    const config = join(root, 'artifacts/W0-I/model-evaluation/trial/user-trial/config.json');
    const installed = JSON.parse(await readFile(config, 'utf8'));
    const activation = JSON.parse(await readFile(join(dirname(config), 'activation.json'), 'utf8'));
    if (await fileDigest(config) !== job.installedConfigSha256 || activation.status !== 'active' ||
        activation.configSha256 !== job.installedConfigSha256) throw problem('normal_installation_required');
    for (const [name, hash] of Object.entries(installed.runtimeFiles ?? {})) {
      if (resolve(root, name).startsWith(root + '/') !== true || await fileDigest(resolve(root, name)) !== hash)
        throw problem('installed_runtime_changed');
    }
    const settings = JSON.parse(await readFile(join(root, 'data/desktop-pet/t3-home/userdata/settings.json'), 'utf8'));
    const provider = settings.providerInstances?.codex;
    if (provider?.enabled !== true || provider.driver !== 'codex' || provider.config?.homePath !== home ||
        provider.config?.binaryPath !== join(root, 'artifacts/runtime/engine-bindings/codex') ||
        digest(provider.config?.launchArgs ?? '') !== job.originalProviderLaunchArgsSha256) throw problem('original_provider_changed');
    if (await exists(sharedCodexConnectionPath(root))) throw problem('activation_already_present');
    if (job.reusedServer) {
      const s = job.reusedServer;
      if (job.version !== 2 || !Number.isSafeInteger(s.pid) || s.pid < 1 || typeof s.startedAt !== 'string' ||
          !s.socket || !Number.isSafeInteger(s.socket.device) || !Number.isSafeInteger(s.socket.inode) ||
          !/^[a-f0-9]{64}$/u.test(s.provenanceSha256 ?? '')) throw problem('reviewed_reused_server_required');
      const bytes = await privateFile(s.provenanceFile), previous = JSON.parse(bytes);
      if (digest(bytes) !== s.provenanceSha256 || previous.status !== 'reconnection_stopped' || previous.reason !== 'owner_changed' ||
          previous.activationWritten !== false || previous.modelTurns !== 0 || previous.server?.pid !== s.pid ||
          previous.server.startedAt !== s.startedAt || previous.server.socket?.device !== s.socket.device ||
          previous.server.socket?.inode !== s.socket.inode || previous.server.socket?.physicalPath !== s.socket.physicalPath)
        throw problem('reviewed_reused_server_changed');
      await verifyReusableServer(s, { serverIdentity, serverProof });
    }
    return appSourceReview;
  };
  const save = value => record(statePath, { version: 1, operationId: job.operationId, jobSha256: jobHash,
    observedAt: new Date().toISOString(), carrierParentPid: process.ppid,
    carrierProcessGroup: Number(execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pgid='], { encoding: 'utf8' }).trim()), ...value });
  const openApp = environment => new Promise((done, reject) => {
    const args = ['-a', APP];
    if (environment) args.push('--env', 'CODEX_APP_SERVER_WS_URL=' + (job.localSocketProxyBypass ?
      originalAppLocalSocketUrl(route.socketPath) : route.desktopWebsocketUrl), '--env', 'CODEX_APP_SERVER_FORCE_CLI=0');
    if (job.updatePolicy) args.push('--env', UPDATE_ENV + '=false');
    const env = { ...process.env };
    delete env.CODEX_APP_SERVER_WS_URL; delete env.CODEX_APP_SERVER_FORCE_CLI;
    const child = spawn('/usr/bin/open', args, { stdio: 'ignore', env });
    child.once('error', () => reject(problem('App_open_failed')));
    child.once('exit', code => code === 0 ? done() : reject(problem('App_open_failed')));
  });
  const recover = async server => {
    await validate('after_normal_exit');
    return recoverOwnedReconnection(server, {
    owners,
    activated: () => exists(sharedCodexConnectionPath(root)),
    serverAlive: server => !!pidRow(server.pid),
    serverIdentity, serverProof,
    stopOwnedServer: server => {
      if (pidRow(server.pid)?.executable !== runtime.codexExecutable || birth(server.pid) !== server.startedAt)
        throw problem('server_owner_changed');
      process.kill(server.pid, 'SIGTERM');
    },
    waitOwnedServerExit: async server => {
      const until = Date.now() + 10000;
      while (pidRow(server.pid) && Date.now() < until) await pause(100);
      return !pidRow(server.pid);
    },
    endpointPresent: () => exists(route.socketPath),
    openOriginalApp: () => openApp(false),
    });
  };
  const ports = {
    validate, owners, recover, save, now: Date.now, sleep: pause,
    cancelled: () => exists(join(directory, 'cancel')),
    assertUnused: async () => { if (await exists(route.socketPath)) throw problem('shared_endpoint_already_exists'); },
    reuseServer: server => verifyReusableServer(server, { serverIdentity, serverProof }),
    startServer: async () => {
      const env = { ...process.env, CODEX_HOME: home, NODE_PATH: '', NODE_OPTIONS: '', PATH: dirname(runtime.nodeExecutable) + ':/usr/bin:/bin' };
      delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE; delete env.CODEX_APP_SERVER_WS_URL; delete env.CODEX_APP_SERVER_FORCE_CLI;
      const child = spawn(runtime.codexExecutable, ['app-server', '--listen', 'unix://'], { detached: true, stdio: 'ignore', env });
      await new Promise((done, reject) => { child.once('spawn', done); child.once('error', () => reject(problem('shared_start_failed'))); });
      child.unref();
      return { pid: child.pid, startedAt: birth(child.pid) };
    },
    waitServer: async server => {
      if (server.reused) { await verifyReusableServer(server, { serverIdentity, serverProof }); return; }
      const until = Date.now() + 30000;
      while (Date.now() < until) {
        if (!pidRow(server.pid)) throw problem('shared_server_exited');
        if (await exists(route.socketPath)) {
          server.socket = inspectSharedCodexSocket(route.socketPath);
          const proof = await probeSharedServer(WebSocket, route.desktopWebsocketUrl);
          if (proof.loadedThreadsCount !== 0) throw problem('shared_server_already_loaded');
          return;
        }
        await pause(100);
      }
      throw problem('shared_start_timeout');
    },
    openSharedApp: () => openApp(true),
    waitApp: async () => {
      const until = Date.now() + 30000;
      while (Date.now() < until) { const app = processes().find(p => p.executable === APP_EXEC); if (app) return app; await pause(100); }
      throw problem('App_reopen_timeout');
    },
  };
  return { job, jobHash, directory, ports, runtime, route, statePath };
}

async function main(mode, jobFile) {
  if (!['--check', '--arm', '--run', '--cancel', '--recover'].includes(mode) || !jobFile) throw problem('operator_usage');
  const x = await operator(resolve(jobFile), mode === '--arm' || mode === '--run');
  if (mode === '--cancel') { await record(join(x.directory, 'cancel'), { jobSha256: x.jobHash }); return { status: 'cancellation_requested' }; }
  await x.ports.validate(mode === '--recover' ? 'after_normal_exit' : undefined);
  if (mode === '--check') return { status: 'readonly_preflight_passed', ...await x.ports.owners(), mutation: false };
  if (mode === '--recover') {
    if (x.job.window?.status !== 'arranged') throw problem('arranged_window_required');
    const previous = JSON.parse(await privateFile(x.statePath));
    if (previous.jobSha256 !== x.jobHash || previous.operationId !== x.job.operationId) throw problem('recovery_record_changed');
    const arm = JSON.parse(await privateFile(join(x.directory, 'arm.json')));
    if (arm.jobSha256 !== x.jobHash || processes().some(p => p.pid === arm.carrierPid)) throw problem('carrier_still_running');
    const result = await x.ports.recover(previous.server);
    await x.ports.save({ status: 'recovery_review', recovery: result }); return result;
  }
  const armPath = join(x.directory, 'arm.json');
  if (mode === '--arm') {
    const owner = await x.ports.owners();
    if (!owner.originalApp || !owner.originalCli || owner.foreignApp || owner.changedOriginalPid) throw problem('original_running_owner_required');
    await record(armPath, { jobSha256: x.jobHash, carrierPid: null }, true);
    const child = spawnDetachedOperator(process.execPath, [script, '--run', resolve(jobFile)], { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' });
    await new Promise((done, reject) => { child.once('spawn', done); child.once('error', () => reject(problem('carrier_start_failed'))); });
    await record(armPath, { jobSha256: x.jobHash, carrierPid: child.pid });
    return { status: 'armed_waiting_for_human_normal_exit', carrierPid: child.pid, statePath: x.statePath };
  }
  let arm;
  for (let i = 0; i < 100; i++) { arm = JSON.parse(await privateFile(armPath)); if (arm.carrierPid !== null) break; await pause(100); }
  if (arm.jobSha256 !== x.jobHash || arm.carrierPid !== process.pid) throw problem('exact_armed_carrier_required');
  await record(join(x.directory, 'claim.json'), { jobSha256: x.jobHash, carrierPid: process.pid }, true);
  return runReconnection(x.job, x.ports);
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  (process.argv.length === 4 ? main(process.argv[2], process.argv[3]) : Promise.reject(problem('operator_usage')))
    .then(value => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(error => { process.stderr.write(JSON.stringify({ status: 'operator_refused', reason: error.code ?? 'operator_failed' }) + '\n'); process.exitCode = 1; });
}
