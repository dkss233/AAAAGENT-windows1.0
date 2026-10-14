import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runReconnection, recoverOwnedReconnection, probeSharedServer, verifyReusableServer } from './codex-shared-reconnect.mjs';
import * as reconnect from './codex-shared-reconnect.mjs';

const none = () => ({ originalApp: false, originalCli: false, foreignApp: false, changedOriginalPid: false });

test('App local address names localhost while preserving the exact Unix path and rejects ambiguous paths', () => {
  const socket = '/private/tmp/aaa-local.sock';
  const url = new URL(reconnect.originalAppLocalSocketUrl(socket));
  assert.equal(url.protocol, 'ws+unix:');assert.equal(url.hostname, 'localhost');assert.equal(url.pathname, socket + ':/rpc');
  for (const invalid of ['', 'ws://localhost:1080', '/tmp/with space.sock', '/tmp/a:b.sock', '/tmp/a%20b.sock', '/tmp/a?b.sock'])
    assert.throws(() => reconnect.originalAppLocalSocketUrl(invalid), { code: 'reviewed_local_socket_path_required' });
});

test('the actual reviewed App selector sends a hostname-less Unix URL to1080 and bypasses it for localhost',
  { skip: !process.env.NATIVE_APP_PROXY_SELECTOR_MODULE }, async () => {
    const select = (await import(pathToFileURL(process.env.NATIVE_APP_PROXY_SELECTOR_MODULE).href)).default;
    const socket = '/private/tmp/aaa-local.sock';
    assert.equal(select('ws+unix://' + socket + ':/rpc'), 'socks5h://127.0.0.1:1080');
    assert.equal(select(reconnect.originalAppLocalSocketUrl(socket)), undefined);
  });

test('the actual bundled App WebSocket connects to the same private Unix socket with a localhost authority',
  { skip: !process.env.NATIVE_APP_WS_MODULE || !process.env.NATIVE_MOUNT_WS_MODULE }, async t => {
    const AppWebSocket = (await import(pathToFileURL(process.env.NATIVE_APP_WS_MODULE).href)).default;
    const WebSocket = (await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href)).default;
    const home = await mkdtemp('/private/tmp/aaa-app-local-');await chmod(home, 0o700);
    const socket = join(home, 'local.sock'), http = createServer(), ws = new WebSocket.WebSocketServer({ server: http });
    const methods = [];let host, tcpPeer;
    ws.on('connection', (peer, request) => {
      host = request.headers.host;tcpPeer = request.socket.remoteAddress;
      peer.on('message', bytes => { const frame = JSON.parse(String(bytes));methods.push(frame.method);
        if (frame.id !== undefined) peer.send(JSON.stringify({ id: frame.id,
          result: frame.method === 'thread/loaded/list' ? { data: [] } : {} }));
      });
    });
    t.after(async () => { for (const peer of ws.clients) peer.terminate();await new Promise(done => http.close(done));
      ws.close();await rm(home, { recursive: true, force: true }); });
    http.listen(socket);await once(http, 'listening');await chmod(socket, 0o600);
    assert.deepEqual(await probeSharedServer(AppWebSocket, reconnect.originalAppLocalSocketUrl(socket)), { loadedThreadsCount: 0 });
    assert.equal(host, 'localhost');assert.equal(tcpPeer, undefined);
    assert.deepEqual(methods, ['initialize', 'initialized', 'thread/loaded/list']);
  });
function scenario(overrides = {}) {
  const events = [], states = []; let clock = 0;
  const ports = {
    validate: async () => events.push('validate'), now: () => clock,
    sleep: async ms => { clock += ms; events.push('wait'); },
    cancelled: async () => false, owners: async () => none(),
    assertUnused: async () => events.push('unused'),
    startServer: async () => { events.push('server'); return { pid: 991, startedAt: 'fixture' }; },
    waitServer: async () => events.push('server-ready'),
    openSharedApp: async () => events.push('open-shared'),
    waitApp: async () => ({ pid: 992 }),
    save: async value => states.push(value),
    recover: async () => { events.push('recover'); return { status: 'fixture_preserved' }; },
    ...overrides,
  };
  return { ports, events, states };
}

test('an exact original CLI reparented to launchd during normal quit waits for exit and opens the shared App', async () => {
  const job = { version: 2, originalAppPid: 991, originalCliPid: 992, originalAppStartedAt: 'original-App-birth',
    originalCliStartedAt: 'original-CLI-birth', waitForExitMs: 3000, reusedServer: { pid: 993 } };
  const cli = { pid: 992, ppid: 1, executable: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    startedAt: job.originalCliStartedAt };
  const app = { pid: 991, ppid: 1, executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', startedAt: job.originalAppStartedAt };
  let observations = 0;
  const f = scenario({ owners: async () => reconnect.inspectReconnectionOwners(job, ++observations === 1 ? [app, cli] : observations === 2 ? [cli] : []),
    reuseServer: async s => ({ ...s, reused: true }) });
  const result = await runReconnection(job, f.ports);
  assert.equal(result.status, 'App_reopened_owner_verification_pending');
  assert.ok(f.events.indexOf('wait') < f.events.indexOf('open-shared'));
  assert.equal(f.events.includes('server'), false);
  assert.equal(f.states.at(-1).activationWritten, false);
  assert.equal(f.states.at(-1).normalExitObservations[0].owners.cli.ppid, 1);
});

test('one process snapshot preserves exact births and paths with spaces and ignores exited zombies', () => {
  const output = ' 991 1 S Thu Oct  8 11:19:18 2026 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n' +
    ' 992 991 S Thu Oct  8 11:19:23 2026 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex\n' +
    ' 995 1 Z Thu Oct  8 11:19:24 2026 (codex)\n';
  const rows = reconnect.parseReconnectionProcessRows(output);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].startedAt, 'Thu Oct  8 11:19:18 2026');
  assert.equal(rows[1].executable, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  const owner = reconnect.inspectReconnectionOwners({ version: 2, originalAppPid: 991, originalCliPid: 992,
    originalAppStartedAt: rows[0].startedAt, originalCliStartedAt: rows[1].startedAt }, rows);
  assert.equal(owner.changedOriginalPid, false);
});

test('normal quit exception refuses changed births, executables, unrelated parents and another App and records exact failure fields', async () => {
  const job = { version: 2, originalAppPid: 991, originalCliPid: 992, originalAppStartedAt: 'app-birth',
    originalCliStartedAt: 'cli-birth', waitForExitMs: 3000 };
  const cli = { pid: 992, ppid: 1, startedAt: 'cli-birth', executable: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex' };
  for (const rows of [[{ ...cli, startedAt: 'reused-PID-birth' }], [{ ...cli, executable: '/tmp/unknown' }],
    [{ ...cli, ppid: 999 }], [{ pid: 999, ppid: 1, startedAt: 'other-app', executable: '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT' }]]) {
    const owners = reconnect.inspectReconnectionOwners(job, rows);
    const f = scenario({ owners: async () => owners });
    assert.equal((await runReconnection(job, f.ports)).reason, 'owner_changed');
    assert.equal(f.states.at(-1).failurePhase, 'wait_normal_exit');
    assert.deepEqual(f.states.at(-1).ownerSnapshot, owners);
    assert.equal(f.events.includes('open-shared'), false);
  }
});

test('waits for both original processes and stops at owner verification, without activating', async () => {
  let observations = 0;
  const f = scenario({ owners: async () => ++observations === 1 ? { ...none(), originalApp: true, originalCli: true } :
    observations === 2 ? { ...none(), originalCli: true } : none() });
  const result = await runReconnection({ waitForExitMs: 3000 }, f.ports);
  assert.equal(result.status, 'App_reopened_owner_verification_pending');
  assert.deepEqual(f.events, ['validate', 'wait', 'wait', 'validate', 'unused', 'server', 'server-ready', 'open-shared']);
  assert.equal(f.states.at(-1).activationWritten, false);
  assert.equal(f.states.at(-1).originalAppConnectedVerified, false);
});

test('a human normal exit after twelve minutes still reconnects inside the reviewed thirty-minute window', async () => {
  let elapsed = 0;
  const f = scenario({ now: () => elapsed, sleep: async ms => { elapsed += ms; },
    owners: async () => ({ ...none(), originalApp: elapsed < 720000, originalCli: elapsed < 720000 }) });
  const result = await runReconnection({ waitForExitMs: 1800000 }, f.ports);
  assert.equal(result.status, 'App_reopened_owner_verification_pending');
  assert.equal(f.states[0].waitForExitMs, 1800000);
  assert.equal(f.states[0].normalAppExitDeadline, '1970-01-01T00:30:00.000Z');
  assert.ok(elapsed >= 720000 && elapsed < 1800000);
  assert.equal(f.states.at(-1).activationWritten, false);
  assert.equal(f.states.at(-1).modelTurns, 0);
});

test('the explicitly extended two-hour job waits for a human exit after ninety minutes', async () => {
  let elapsed = 0;
  const f = scenario({ now: () => elapsed, sleep: async ms => { elapsed += ms; },
    owners: async () => ({ ...none(), originalApp: elapsed < 5400000, originalCli: elapsed < 5400000 }) });
  const result = await runReconnection({ waitForExitMs: 7200000 }, f.ports);
  assert.equal(result.status, 'App_reopened_owner_verification_pending');
  assert.equal(f.states[0].waitForExitMs, 7200000);
  assert.equal(f.states[0].normalAppExitDeadline, '1970-01-01T02:00:00.000Z');
  assert.ok(elapsed >= 5400000 && elapsed < 7200000);
  assert.equal(f.states.at(-1).activationWritten, false); assert.equal(f.states.at(-1).modelTurns, 0);
});

test('a signed App update on normal exit preserves the reviewed transport and reaches only owner verification', async () => {
  const job = { version: 2, waitForExitMs: 1000, scriptSha256: 'helper', appAsarSha256: 'old-bundle',
    appExecutableSha256: 'old-executable', appTransportSha256: 'reviewed-transport' };
  let signedChecks = 0; const phases = [];
  const f = scenario({ validate: async phase => {
    phases.push(phase);
    return reconnect.verifyReviewedAppSources(job, {
      readSources: async () => ({ scriptSha256: 'helper', appAsarSha256: phase ? 'updated-bundle' : 'old-bundle',
        appExecutableSha256: phase ? 'updated-executable' : 'old-executable' }),
      verifyTrustedApp: async () => { signedChecks++; return { memberSha256: 'reviewed-transport' }; },
    }, phase);
  } });
  const result = await runReconnection(job, f.ports);
  assert.equal(result.status, 'App_reopened_owner_verification_pending');
  assert.deepEqual(phases, [undefined, 'after_normal_exit']);
  assert.equal(signedChecks, 2);
  assert.equal(f.states.at(-1).appSourceReview.status, 'signed_update_same_reviewed_transport');
  assert.equal(f.states.at(-1).activationWritten, false); assert.equal(f.states.at(-1).modelTurns, 0);
});

for (const [name, phase, version, sources, trusted, reason] of [
  ['whole App drift before the human exit', undefined, 2, { appAsarSha256: 'new' }, 'transport', 'reviewed_source_changed'],
  ['legacy job cannot admit a new App', 'after_normal_exit', 1, { appAsarSha256: 'new' }, 'transport', 'reviewed_source_changed'],
  ['changed connection code after exit', 'after_normal_exit', 2, { appAsarSha256: 'new' }, 'unreviewed', 'reviewed_App_transport_changed'],
  ['invalid App signature after exit', 'after_normal_exit', 2, { appAsarSha256: 'new' }, null, 'trusted_original_App_required'],
  ['changed helper after exit', 'after_normal_exit', 2, { scriptSha256: 'other-helper' }, 'transport', 'reviewed_source_changed'],
]) test('source review refuses ' + name + ' before starting a server', async () => {
  const job = { version, waitForExitMs: 1000, scriptSha256: 'helper', appAsarSha256: 'bundle',
    appExecutableSha256: 'executable', appTransportSha256: 'transport' };
  const f = scenario({ validate: async () => reconnect.verifyReviewedAppSources(job, {
    readSources: async () => ({ scriptSha256: 'helper', appAsarSha256: 'bundle', appExecutableSha256: 'executable', ...sources }),
    verifyTrustedApp: async () => { if (trusted === null) throw Object.assign(Error(), { code: 'trusted_original_App_required' }); return { memberSha256: trusted }; },
  }, phase) });
  const result = await runReconnection(job, f.ports);
  assert.equal(result.reason, reason); assert.equal(f.events.includes('server'), false);
  assert.equal(f.events.includes('open-shared'), false);
});

test('transport review reads the actual ASAR member and refuses a second or unpacked candidate', async t => {
  const directory = await mkdtemp('/private/tmp/aaa-app-transport-');t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'app.asar'), body = Buffer.from('reviewed transport source');
  const make = async files => {
    const header = Buffer.from(JSON.stringify({ files: { '.vite': { files: { build: { files } } } } }));
    const prefix = Buffer.alloc(16);prefix.writeUInt32LE(4, 0);prefix.writeUInt32LE(header.length + 8, 4);
    prefix.writeUInt32LE(header.length + 4, 8);prefix.writeUInt32LE(header.length, 12);
    await writeFile(file, Buffer.concat([prefix, header, body]));
  };
  const member = { size: body.length, offset: '0' };await make({ 'application-network-startup-current.js': member });
  const review = await reconnect.readAppTransport(file);
  assert.equal(review.member, '.vite/build/application-network-startup-current.js');
  assert.equal(review.memberSha256, (await import('node:crypto')).createHash('sha256').update(body).digest('hex'));
  await make({ 'application-network-startup-current.js': member, 'application-network-startup-other.js': member });
  await assert.rejects(reconnect.readAppTransport(file), { code: 'reviewed_App_transport_required' });
  await make({ 'application-network-startup-current.js': { ...member, unpacked: true } });
  await assert.rejects(reconnect.readAppTransport(file), { code: 'reviewed_App_transport_required' });
});

test('the actual operator accepts two hours and preserves thirty-minute jobs, rejecting unknown runtimes and excessive waits', async t => {
  const home = await mkdtemp('/private/tmp/aaa-reconnect-window-'); await chmod(home, 0o700);
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = join(home, 'job.json'), sha = '0'.repeat(64);
  const job = { version: 1, kind: 'original_App_shared_reconnection', operationId: 'window-guard-fixture',
    originalAppPid: 991, originalCliPid: 992, waitForExitMs: 1800000, projectRoot: home, codexHome: home,
    engineRoot: join(home, 'unknown-runtime'), scriptSha256: sha, appAsarSha256: sha, appExecutableSha256: sha,
    installedConfigSha256: sha, originalProviderLaunchArgsSha256: sha };
  const invoke = async waitForExitMs => {
    await writeFile(file, JSON.stringify({ ...job, waitForExitMs }), { mode: 0o600 });
    try { execFileSync(process.execPath, [fileURLToPath(new URL('./codex-shared-reconnect.mjs', import.meta.url)), '--check', file], { stdio: 'pipe' }); }
    catch (error) { return JSON.parse(String(error.stderr)); }
    assert.fail('unknown runtime must remain refused');
  };
  for (const wait of [1800000, 1800001, 7200000]) {
    const admitted = await invoke(wait);
    assert.equal(admitted.status, 'operator_refused');
    assert.equal(admitted.reason, 'ENOENT', 'the bounded parser must admit an authorized human delay and reach the exact runtime guard');
  }
  for (const wait of [7200001, 99, -1, 7200000.5])
    assert.deepEqual(await invoke(wait), { status: 'operator_refused', reason: 'invalid_reviewed_job' });
});

for (const [name, overrides, reason] of [
  ['timeout never signals the original owner', { owners: async () => ({ ...none(), originalApp: true }) }, 'normal_exit_timeout'],
  ['cancel does not start a service', { cancelled: async () => true }, 'cancelled'],
  ['a different live App is preserved', { owners: async () => ({ ...none(), foreignApp: true }) }, 'owner_changed'],
  ['PID reuse is rejected', { owners: async () => ({ ...none(), changedOriginalPid: true }) }, 'owner_changed'],
  ['a pre-existing endpoint is preserved', { assertUnused: async () => { throw Object.assign(Error(), { code: 'shared_endpoint_already_exists' }); } }, 'shared_endpoint_already_exists'],
]) test(name, async () => {
  const f = scenario(overrides), result = await runReconnection({ waitForExitMs: 200 }, f.ports);
  assert.equal(result.reason, reason);
  assert.equal(f.events.includes('server'), false);
  assert.equal(f.events.includes('open-shared'), false);
});

test('rechecks the running owners before reopening after service startup', async () => {
  let calls = 0;
  const f = scenario({ owners: async () => ++calls === 1 ? none() : { ...none(), foreignApp: true } });
  const result = await runReconnection({ waitForExitMs: 1000 }, f.ports);
  assert.equal(result.reason, 'owner_changed');
  assert.equal(f.events.includes('open-shared'), false);
  assert.equal(result.recovery.status, 'fixture_preserved');
});

test('reuses the recorded idle server without starting another one or claiming activation', async () => {
  const server = { pid: 991, startedAt: 'recorded', socket: { device: 1, inode: 2 } };
  const f = scenario({ reuseServer: async value => {
    assert.deepEqual(value, server); f.events.push('reuse');return { ...value, reused: true };
  } });
  const result = await runReconnection({ waitForExitMs: 1000, reusedServer: server }, f.ports);
  assert.equal(result.status, 'App_reopened_owner_verification_pending');
  assert.deepEqual(f.events, ['validate', 'validate', 'reuse', 'server-ready', 'open-shared']);
  assert.equal(f.states.at(-1).server.reused, true); assert.equal(f.states.at(-1).activationWritten, false);
});

for (const [name, identity, proof, reason] of [
  ['changed PID birth', false, {}, 'reused_server_owner_changed'],
  ['replaced socket', true, { sameSocket: false }, 'reused_socket_owner_changed'],
  ['another client', true, { otherHolder: true }, 'reused_server_other_peer'],
  ['an idle loaded thread', true, { loadedThreadsCount: 1 }, 'reused_server_not_empty'],
  ['unknown activity', true, { allLoadedThreadsIdle: false }, 'reused_server_not_empty'],
]) test('reuse preserves ' + name + ' and never launches the App', async () => {
  const f = scenario({ reuseServer: server => verifyReusableServer(server, { serverIdentity: async () => identity,
    serverProof: async () => ({ sameSocket: true, otherHolder: false, loadedThreadsCount: 0, allLoadedThreadsIdle: true, ...proof }) }) });
  const result = await runReconnection({ waitForExitMs: 1000, reusedServer: { pid: 991 } }, f.ports);
  assert.equal(result.reason, reason); assert.equal(f.events.includes('server'), false);assert.equal(f.events.includes('open-shared'), false);
});

test('a server identity change during the reuse probe is rejected', async () => {
  let checks = 0;
  await assert.rejects(verifyReusableServer({ pid: 991 }, { serverIdentity: async () => ++checks === 1,
    serverProof: async () => ({ sameSocket: true, otherHolder: false, loadedThreadsCount: 0, allLoadedThreadsIdle: true }) }),
  { code: 'reused_server_owner_changed' });
});

function recovery(overrides = {}) {
  const actions = [];
  return { actions, ports: {
    owners: async () => none(), activated: async () => false,
    serverAlive: async () => true, serverIdentity: async () => true,
    serverProof: async () => ({ sameSocket: true, loadedThreadsCount: 0, otherHolder: false }),
    stopOwnedServer: async () => actions.push('SIGTERM-owned'),
    waitOwnedServerExit: async () => true, endpointPresent: async () => false,
    openOriginalApp: async () => actions.push('open-original'), ...overrides,
  } };
}

test('failure recovery stops only an exact empty owned server and opens the original App normally', async () => {
  const f = recovery();
  const result = await recoverOwnedReconnection({ pid: 991, startedAt: 'fixture' }, f.ports);
  assert.equal(result.status, 'original_App_normal_reopen_requested');
  assert.deepEqual(f.actions, ['SIGTERM-owned', 'open-original']);
});

test('failure preserves a server reused from an earlier operation and reopens the original App normally', async () => {
  const f = recovery();
  assert.equal((await recoverOwnedReconnection({ pid: 991, reused: true }, f.ports)).status,
    'reused_server_preserved_original_App_reopen_requested');
  assert.deepEqual(f.actions, ['open-original']);
});

test('an App appearing during reuse recovery preserves both owners without reopening', async () => {
  let observations = 0;
  const f = recovery({ owners: async () => ++observations === 1 ? none() : { ...none(), foreignApp: true } });
  assert.equal((await recoverOwnedReconnection({ pid: 991, reused: true }, f.ports)).status, 'live_or_changed_owner_preserved');
  assert.deepEqual(f.actions, []);
});

for (const [name, overrides, status] of [
  ['live App', { owners: async () => ({ ...none(), foreignApp: true }) }, 'live_or_changed_owner_preserved'],
  ['activation receipt', { activated: async () => true }, 'activation_requires_I_review'],
  ['changed PID birth/identity', { serverIdentity: async () => false }, 'server_owner_changed'],
  ['changed socket', { serverProof: async () => ({ sameSocket: false, loadedThreadsCount: 0, otherHolder: false }) }, 'socket_owner_changed'],
  ['active or unknown native thread', { serverProof: async () => ({ sameSocket: true, loadedThreadsCount: 1, otherHolder: false }) }, 'active_or_unknown_server_preserved'],
  ['another peer', { serverProof: async () => ({ sameSocket: true, loadedThreadsCount: 0, otherHolder: true }) }, 'other_socket_holder_preserved'],
  ['unknown surviving endpoint', { serverAlive: async () => false, endpointPresent: async () => true }, 'unknown_socket_preserved'],
]) test('recovery preserves ' + name, async () => {
  const f = recovery(overrides), result = await recoverOwnedReconnection({ pid: 991 }, f.ports);
  assert.equal(result.status, status); assert.deepEqual(f.actions, []);
});

test('recovery does not reopen until the exact server actually exits', async () => {
  const f = recovery({ waitOwnedServerExit: async () => false });
  assert.equal((await recoverOwnedReconnection({ pid: 991 }, f.ports)).status, 'owned_server_exit_pending');
  assert.deepEqual(f.actions, ['SIGTERM-owned']);
});

test('known idle loaded threads can recover after their App and every other peer exit', async () => {
  const f = recovery({ serverProof: async () => ({ sameSocket: true, loadedThreadsCount: 2, allLoadedThreadsIdle: true, otherHolder: false }) });
  assert.equal((await recoverOwnedReconnection({ pid: 991 }, f.ports)).status, 'original_App_normal_reopen_requested');
  assert.deepEqual(f.actions, ['SIGTERM-owned', 'open-original']);
});

test('an App appearing during recovery is preserved', async () => {
  let observations = 0;
  const f = recovery({ owners: async () => ++observations === 1 ? none() : { ...none(), foreignApp: true } });
  assert.equal((await recoverOwnedReconnection({ pid: 991 }, f.ports)).status, 'live_or_changed_owner_preserved');
  assert.deepEqual(f.actions, []);
});

test('the readonly native probe sends only initialization and loaded-list', { skip: !process.env.NATIVE_MOUNT_WS_MODULE }, async t => {
  const WebSocket = (await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href)).default;
  const home = await mkdtemp('/private/tmp/aaa-reconnect-probe-'); await chmod(home, 0o700);
  const socket = join(home, 'fixture.sock'), http = createServer(), ws = new WebSocket.WebSocketServer({ server: http }), methods = [];
  ws.on('connection', peer => peer.on('message', bytes => {
    const frame = JSON.parse(String(bytes)); methods.push(frame.method);
    if (frame.id !== undefined) peer.send(JSON.stringify({ id: frame.id, result: frame.method === 'thread/loaded/list' ? { data: [] } : {} }));
  }));
  t.after(async () => { for (const peer of ws.clients) peer.terminate(); await new Promise(done => http.close(done)); ws.close(); await rm(home, { recursive: true, force: true }); });
  http.listen(socket); await once(http, 'listening'); await chmod(socket, 0o600);
  assert.deepEqual(await probeSharedServer(WebSocket, 'ws+unix://' + socket + ':/rpc'), { loadedThreadsCount: 0 });
  assert.deepEqual(methods, ['initialize', 'initialized', 'thread/loaded/list']);
});

for (const [name, status, changedList, idle] of [
  ['known idle', { type: 'idle' }, false, true],
  ['pending approval', { type: 'active', activeFlags: ['waitingOnApproval'] }, false, false],
  ['missing status', undefined, false, false],
  ['loaded identity changed during read', { type: 'idle' }, true, false],
]) test('recovery probe handles ' + name, { skip: !process.env.NATIVE_MOUNT_WS_MODULE }, async t => {
  const WebSocket = (await import(pathToFileURL(process.env.NATIVE_MOUNT_WS_MODULE).href)).default;
  const home = await mkdtemp('/private/tmp/aaa-reconnect-status-'), socket = join(home, 'fixture.sock');
  const http = createServer(), ws = new WebSocket.WebSocketServer({ server: http }); let lists = 0;
  const reads = [];
  ws.on('connection', peer => peer.on('message', bytes => {
    const frame = JSON.parse(String(bytes)); if (frame.id === undefined) return;
    let result = {};
    if (frame.method === 'thread/loaded/list') result = { data: ++lists > 1 && changedList ? ['different'] : ['fixture'] };
    if (frame.method === 'thread/read') { reads.push(frame.params); result = { thread: { id: 'fixture', status } }; }
    peer.send(JSON.stringify({ id: frame.id, result }));
  }));
  t.after(async () => { for (const peer of ws.clients) peer.terminate(); await new Promise(done => http.close(done)); ws.close(); await rm(home, { recursive: true, force: true }); });
  http.listen(socket); await once(http, 'listening');
  const proof = await probeSharedServer(WebSocket, 'ws+unix://' + socket + ':/rpc', 5000, true);
  assert.deepEqual(proof, { loadedThreadsCount: 1, allLoadedThreadsIdle: idle });
  assert.deepEqual(reads, [{ threadId: 'fixture', includeTurns: false }]);
});

test('detached carrier survives its real host exit with a separate process group', { timeout: 20000 }, async t => {
  const home = await mkdtemp('/private/tmp/aaa-reconnect-host-'); await chmod(home, 0o700);
  const moduleUrl = new URL('./codex-shared-reconnect.mjs', import.meta.url).href;
  const ready = join(home, 'ready.json'), done = join(home, 'done.json'), parentInfo = join(home, 'parent.json');
  let parent, carrierPid;
  const waitFile = async path => { const until = Date.now() + 12000; for (;;) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; if (Date.now() >= until) throw Error('fixture timeout'); await new Promise(done => setTimeout(done, 30)); } } };
  t.after(async () => {
    parent?.stdin.end();
    if (carrierPid) { try { process.kill(carrierPid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
    await rm(home, { recursive: true, force: true });
  });
  const childSource = `
    import {runReconnection} from ${JSON.stringify(moduleUrl)};
    import {writeFile} from 'node:fs/promises';
    const host=Number(process.env.FIXTURE_HOST_PID), alive=()=>{try{process.kill(host,0);return true}catch{return false}};
    const actions=[];
    const result=await runReconnection({waitForExitMs:10000},{
      validate:async()=>{},now:Date.now,sleep:ms=>new Promise(r=>setTimeout(r,ms)),cancelled:async()=>false,
      owners:async()=>({originalApp:alive(),originalCli:false,foreignApp:false,changedOriginalPid:false}),
      assertUnused:async()=>{},startServer:async()=>{actions.push('fixture-server');return {pid:777}},
      waitServer:async()=>{},openSharedApp:async()=>{if(alive())throw Error('host still alive');actions.push('fixture-App')},
      waitApp:async()=>({pid:778}),recover:async()=>({status:'fixture-only'}),
      save:async state=>{if(state.status==='waiting_for_normal_App_exit')await writeFile(${JSON.stringify(ready)},JSON.stringify({carrierPid:process.pid,hostAlive:alive()}),{mode:384})}
    });
    await writeFile(${JSON.stringify(done)},JSON.stringify({result,actions,carrierPid:process.pid,parentPid:process.ppid,hostAlive:alive()}),{mode:384});
  `;
  const parentSource = `
    import {spawnDetachedOperator} from ${JSON.stringify(moduleUrl)};
    import {writeFile} from 'node:fs/promises';
    const child=spawnDetachedOperator(process.execPath,['--input-type=module','-e',${JSON.stringify(childSource)}],{...process.env,FIXTURE_HOST_PID:String(process.pid)});
    await writeFile(${JSON.stringify(parentInfo)},JSON.stringify({parentPid:process.pid,carrierPid:child.pid}),{mode:384});
    process.stdin.resume();process.stdin.once('end',()=>process.exit(0));
  `;
  parent = spawn(process.execPath, ['--input-type=module', '-e', parentSource], { stdio: ['pipe', 'ignore', 'ignore'] });
  const info = await waitFile(parentInfo); carrierPid = info.carrierPid;
  assert.equal((await waitFile(ready)).hostAlive, true);
  const rows = execFileSync('/bin/ps', ['-p', info.parentPid + ',' + carrierPid, '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/u).map(Number));
  const carrier = rows.find(row => row[0] === carrierPid), host = rows.find(row => row[0] === info.parentPid);
  assert.equal(carrier[2], carrierPid); assert.notEqual(carrier[2], host[2]);
  const exited = once(parent, 'exit'); parent.stdin.end(); await exited;
  const receipt = await waitFile(done);
  assert.equal(receipt.hostAlive, false); assert.equal(receipt.parentPid, 1);
  assert.equal(receipt.result.status, 'App_reopened_owner_verification_pending');
  assert.deepEqual(receipt.actions, ['fixture-server', 'fixture-App']);
  const until = Date.now() + 3000;
  while (Date.now() < until) { try { process.kill(carrierPid, 0); } catch (e) { if (e.code === 'ESRCH') { carrierPid = undefined; break; } throw e; } await new Promise(r => setTimeout(r, 30)); }
  assert.equal(carrierPid, undefined, 'owned carrier must exit after one handoff');
});
