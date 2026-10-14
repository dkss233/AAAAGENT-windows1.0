import { mkdir, writeFile, realpath, lstat, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { T3ChildService } from '../../../../workbench/integration/t3-child-service.mjs';
import { T3HttpClient } from '../../../../workbench/integration/t3-http-client.mjs';
import { createNativeExecutionBinding } from '../../../workbench/native-mount/execution-binding.mjs';
import { createNativeExecutionGate } from '../../../workbench/native-mount/execution-gate.mjs';
import { startNativeReadMount } from '../../../workbench/native-mount/server.mjs';
import { createEngineeringVoiceService } from '../../../workbench/engineering-voice/service.mjs';

/** Run the original T3 SQLite/event engine with an explicit test-owned fake CLI.
 * This does not use daily homes, engine profiles, accounts or a model endpoint.
 * The caller owns the fake's wire responses and records their actual scope.
 */
export async function startBrowserFixture({ runtimeSourceDir, nodeExecutable, directory,
  rendererDist, fakeCodexExecutable, providers, readCodexMetadata,
  dependencySourceDir = runtimeSourceDir, controlledDshHost, readOnlySnapshot, engineeringAsr }) {
  const root = resolve(directory);
  if (!root.includes('/artifacts/') || root.includes('/data/') ||
      relative(root, resolve(fakeCodexExecutable)).startsWith('..') || existsSync(join(root, 't3-home')))
    throw Error('Fresh owned artifact home and test CLI required');
  if (await realpath(fakeCodexExecutable) !== resolve(fakeCodexExecutable) || !(await lstat(fakeCodexExecutable)).isFile())
    throw Error('Test CLI must be a regular owned file');
  const home = join(root, 't3-home'), codexHome = join(root, 'codex-home');
  await mkdir(join(home, 'userdata'), { recursive: true, mode: 0o700 });
  await mkdir(codexHome, { mode: 0o700 });
  let snapshot;
  if (readOnlySnapshot) {
    const source = resolve(readOnlySnapshot.sourceHome), file = join(source, 'userdata/state.sqlite');
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    if (controlledDshHost || providers.length || !source.includes('/artifacts/') || source.includes('/data/') ||
        await realpath(source) !== source || await realpath(file) !== file ||
        !(await lstat(file)).isFile() || hash(await readFile(file)) !== readOnlySnapshot.sqliteSha256)
      throw Error('Exact original artifact SQLite and no writable providers required');
    const environment = await readFile(join(source, 'userdata/environment-id'), 'utf8');
    if (!/^[a-f0-9-]{36}\s*$/.test(environment)) throw Error('Original artifact environment identity unavailable');
    const original = new Database(file, { readonly: true, fileMustExist: true });
    try { await original.backup(join(home, 'userdata/state.sqlite')); }
    finally { original.close(); }
    if (hash(await readFile(file)) !== readOnlySnapshot.sqliteSha256) throw Error('Original artifact changed during backup');
    await writeFile(join(home, 'userdata/environment-id'), environment, { mode: 0o600 });
    snapshot = { sourceHome: source, sqliteSha256: readOnlySnapshot.sqliteSha256,
      originalUnchanged: true, copiedDatabaseSha256: hash(await readFile(join(home, 'userdata/state.sqlite'))) };
  }
  if (controlledDshHost) {
    const log = resolve(controlledDshHost.webLogPath);
    if (relative(root, log).startsWith('..') || await realpath(log) !== log ||
        !(await lstat(log)).isFile() || controlledDshHost.agentPreset !== 'controlled-preset' ||
        !/^dsh web: http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/\?token=controlled-host\n$/.test(await readFile(log, 'utf8')))
      throw Error('Explicit owned controlled DSH Host log required');
  }
  const providerInstances = Object.fromEntries(['codex','claude-code','cursor','grok','gemini','opencode','dsh']
    .map(driver => [driver, { driver, enabled: false, config: {} }]));
  const driver = controlledDshHost ? 'dsh' : 'codex';
  if (!readOnlySnapshot) providerInstances[driver] = { driver, enabled: true, config: controlledDshHost ?
    { agentPreset: controlledDshHost.agentPreset } :
    { binaryPath: resolve(fakeCodexExecutable), homePath: codexHome } };
  const settings = {
    backgroundActivity: { schemaVersion: 1, profile: 'custom', baseProfile: 'battery-saver',
      overrides: { automaticGitFetchInterval: 0, providerHealthRefreshInterval: 0 } },
    automaticGitFetchInterval: 0,
    providers: { codex: { enabled: false } }, providerInstances,
  };
  const settingsSource = join(dependencySourceDir, 'packages/contracts/src/settings.ts');
  const parser = join(root, 'original-settings-parser.mjs');
  await build({ stdin: { contents: 'import * as Schema from "effect/Schema";import {ServerSettings} from ' +
      JSON.stringify(settingsSource) + ';export const decode=Schema.decodeUnknownSync(ServerSettings);',
      resolveDir: join(dependencySourceDir, 'apps/server'), loader: 'ts' },
    outfile: parser, bundle: true, platform: 'node', format: 'esm',
    banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' } });
  const { decode } = await import(pathToFileURL(parser));
  decode(settings); // Invalid settings must fail before a process can load defaults.
  await writeFile(join(home, 'userdata/settings.json'), JSON.stringify(settings), { mode: 0o600 });
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  const bin = join(root, 'test-bin'); await mkdir(bin, { mode: 0o700 });
  await copyFile(fakeCodexExecutable, join(bin, 'codex'));
  const launcher = join(root, 'test-node');
  await writeFile(launcher, '#!/bin/sh\nexec /usr/bin/env -u AAAAGENT_CODEX_READONLY_BINARY ' +
    quote('CODEX_HOME=' + codexHome) + ' ' + quote('DSH_HOME=' + join(root, 'dsh-home')) + ' ' +
    quote('PATH=' + bin + ':/usr/bin:/bin') + ' ' + quote(resolve(nodeExecutable)) + ' "$@"\n', { mode: 0o700 });
  const service = new T3ChildService({ sourceDir: resolve(runtimeSourceDir), nodeExecutable: launcher,
    baseDir: home, logFile: join(root, 'original-t3.log'),
    ...(controlledDshHost ? { dshWebLogPath: resolve(controlledDshHost.webLogPath) } : {}) });
  let mount, db, management;
  try {
    const native = await service.start(), client = new T3HttpClient(service);
    const { environmentId } = await client.environmentDescriptor();
    const require = createRequire(join(dependencySourceDir, 'apps/server/package.json'));
    const { NodeWS } = await import(pathToFileURL(require.resolve('@effect/platform-node/NodeSocket')).href);
    const effective = await new Promise((resolveConfig, reject) => {
      const socket = new NodeWS.WebSocket(native.origin.replace('http:', 'ws:') + '/ws',
        { headers: { Authorization: 'Bearer ' + native.accessToken, Origin: native.origin } });
      const timer = setTimeout(() => { socket.close(); reject(Error('Original test settings read timed out')); }, 10000);
      const finish = error => { clearTimeout(timer); socket.close(); reject(error); };
      socket.on('error', () => finish(Error('Original test settings unavailable')));
      socket.on('open', () => socket.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'server.getConfig', payload: {}, headers: [] })));
      socket.on('message', bytes => {
        try {
          const messages = JSON.parse(bytes.toString());
          for (const item of Array.isArray(messages) ? messages : [messages]) {
            if (item._tag !== 'Exit' || String(item.requestId) !== '1') continue;
            if (item.exit?._tag !== 'Success') { finish(Error('Original test settings rejected')); return; }
            clearTimeout(timer); socket.close(); resolveConfig(item.exit.value.settings);
          }
        } catch { finish(Error('Original test settings invalid')); }
      });
    });
    const enabled = Object.entries(effective?.providerInstances ?? {}).filter(([_id, instance]) => instance.enabled);
    const exactConfig = controlledDshHost ? enabled[0]?.[1].config.agentPreset === controlledDshHost.agentPreset :
      enabled[0]?.[1].config.binaryPath === resolve(fakeCodexExecutable) && enabled[0]?.[1].config.homePath === codexHome;
    if ((readOnlySnapshot ? enabled.length !== 0 : enabled.length !== 1 || enabled[0][0] !== driver || enabled[0][1].driver !== driver || !exactConfig) ||
        (await readFile(join(root, 'original-t3.log'), 'utf8')).includes('failed to parse settings.json'))
      throw Error('Original service did not retain the exact test binary and home');
    await writeFile(join(root, 'fixture-configuration.json'), JSON.stringify({
      settingsSchemaSha256: createHash('sha256').update(await readFile(settingsSource)).digest('hex'),
      schemaDecodedBeforeStart: true, effectiveOriginalSettingsMatched: true,
      enabledProviders: readOnlySnapshot ? [] : [driver], binaryPath: resolve(fakeCodexExecutable), codexHome,
      ...(snapshot ? { readOnlySnapshot: snapshot } : {}),
      ...(controlledDshHost ? { controlledDshHost: { agentPreset: controlledDshHost.agentPreset,
        ownedWebLog: resolve(controlledDshHost.webLogPath) } } : {}),
      pathFallback: join(bin, 'codex'), realModelTurns: 0,
    }, null, 2) + '\n');
    db = new Database(join(home, 'userdata/state.sqlite'), { readonly: true, fileMustExist: true });
    const binding = createNativeExecutionBinding({ environmentId, database: db,
      readCodexMetadata: readCodexMetadata ?? (nativeId => {
        const file = join(codexHome, 'state_5.sqlite');
        if (!existsSync(file)) return null;
        const original = new Database(file, { readonly: true, fileMustExist: true });
        try { return original.prepare('SELECT id,cwd,originator FROM threads WHERE id=? AND archived=0').get(nativeId); }
        finally { original.close(); }
      }) });
    const gate = readOnlySnapshot ? undefined : createNativeExecutionGate({ environmentId, providers, ...binding,
      file: join(root, 'web-admission.json') });
    if (engineeringAsr && (engineeringAsr.model !== 'controlled-engineering-asr' || readOnlySnapshot)) throw Error('Explicit controlled ASR and writable fixture required');
    const engineeringVoiceService=engineeringAsr ? createEngineeringVoiceService({directory:join(root,'voice-receipts'),client,gate,asr:engineeringAsr}) : undefined;
    // A prepared deployment has its own immutable server bundles and marker;
    // development-only websocket exports can come from the recorded cache.
    management = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/snapshot' &&
          request.headers.authorization === 'Bearer ' + 'm'.repeat(64)) {
        response.end(JSON.stringify({ fixture: true })); return;
      }
      response.statusCode = 404; response.end('{}');
    });
    management.listen(0, '127.0.0.1'); await once(management, 'listening');
    mount = await startNativeReadMount({ nativeOrigin: native.origin, nativeToken: native.accessToken,
      managementOrigin: 'http://127.0.0.1:' + management.address().port, managementToken: 'm'.repeat(64),
      nativeDist: resolve(rendererDist), uiRoot: resolve(rendererDist),
      webSocket: { WebSocket: NodeWS.WebSocket, WebSocketServer: NodeWS.WebSocketServer }, executionGate: gate,
      ...(engineeringVoiceService ? {engineeringVoiceService} : {}) });
    // Credentials remain in memory; the test opens the browser by issuing its cookie.
    return { origin: mount.origin, environmentId, client, database: db, home, codexHome,
      async issueSession() {
        const response = await fetch(mount.origin + '/api/native-mount/session', {
          method: 'POST', headers: { Authorization: 'Bearer ' + mount.token, Origin: mount.origin,
            'Content-Type': 'application/json' }, body: '{}' });
        if (!response.ok) {
          let code = 'unavailable';
          try { const value = await response.json(); if (/^[a-z_]{1,64}$/.test(value.error)) code = value.error; } catch { /* Preserve only the safe original status. */ }
          throw Error('Fixture mount session unavailable: HTTP ' + response.status + ' ' + code);
        }
        return { session: await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] };
      }, async close() { await mount.close(); management.closeAllConnections();
        await new Promise(done => management.close(done)); db.close(); await service.stop(); } };
  } catch (error) {
    if (mount) await mount.close();
    if (management) { management.closeAllConnections(); await new Promise(done => management.close(done)); }
    db?.close(); await service.stop(); throw error;
  }
}
