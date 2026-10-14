import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { HarnessConnection } from '../../dist/harness/connection.js';
import { harnessLaunchUrl } from '../../dist/harness/preset.js';
import { readEngineProfile } from '../../../workbench/integration/engine-pins/profile.mjs';
import { readDshHost } from '../../../workbench/integration/engine-pins/dsh-service.mjs';
import { resolveDshHistoryBinding } from '../../../workbench/integration/engine-pins/dsh-native-history.mjs';
import { verifyDshNavigationRuntime } from '../../../workbench/integration/engine-pins/dsh-navigation-runtime.mjs';
import { dshSessionEntryUrl } from '../../../workbench/integration/engine-pins/dsh-native-entry.mjs';

const handoffUnavailable = () => { throw Error('Original DSH manual handoff unavailable'); };

/** Private URL travels only over stdin, never process arguments, a shell command, files or captured output. */
export function dshBrowserRequest(privateUrl) {
  return { executable: '/usr/bin/osascript', args: ['-l', 'JavaScript'], stdio: ['pipe', 'ignore', 'ignore'],
    input: 'ObjC.import("AppKit");if(!$.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(' +
      JSON.stringify(privateUrl) + ')))throw Error("Browser handoff unavailable");\n' };
}
async function openOriginalBrowser(privateUrl) {
  if (process.platform !== 'darwin') handoffUnavailable();
  const request = dshBrowserRequest(privateUrl);
  await new Promise((done, reject) => {
    const child = spawn(request.executable, request.args, { stdio: request.stdio });
    child.once('error', () => reject(Error('Original DSH manual handoff unavailable')));
    child.once('close', code => code === 0 ? done() : reject(Error('Original DSH manual handoff unavailable')));
    child.stdin.on('error', () => {}); child.stdin.end(request.input);
  });
}

/** Caller must explicitly opt in. The default CLI remains read-only; this creates no service/session/model. */
export async function manualDshHandoff({ manual, entry, currentOrigin, readLaunchUrl, ownerStillCurrent, open = openOriginalBrowser }) {
  try {
    if (manual !== true || entry?.capabilityVersion !== 1 || entry.url !== dshSessionEntryUrl(currentOrigin, entry.binding, 1) ||
        !await ownerStillCurrent()) handoffUnavailable();
    const launcher = new URL(await readLaunchUrl()), clean = new URL(entry.url);
    if (launcher.origin !== currentOrigin || launcher.pathname !== '/' || launcher.hash || launcher.username || launcher.password ||
        [...launcher.searchParams.keys()].join(',') !== 'token' || !launcher.searchParams.get('token') ||
        !await ownerStillCurrent()) handoffUnavailable();
    // Original BrowserAuth issues a cookie and redirects './'. A redirect without a fragment inherits this target (RFC 9110 10.2.2).
    launcher.hash = clean.hash;
    await open(launcher.href);
    return { status: 'browser_handoff_requested', cleanUrl: entry.url };
  } catch { return handoffUnavailable(); }
}

/** Existing original T3 binding -> verified public connection caller. Reads only; never opens a browser or submits. */
export async function originalDshNavigationEntry(database, environmentId, query, connection) {
  const binding = resolveDshHistoryBinding(database, environmentId, query);
  const url = await connection.workSessionUrl(binding);
  if (JSON.stringify(binding) !== JSON.stringify(resolveDshHistoryBinding(database, environmentId, query)))
    throw Error('Original DSH task binding changed');
  return { version: '0.1.0', capabilityVersion: 1, url, binding };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [projectRoot, queryFile, nativeOrigin, mode, ...extra] = process.argv.slice(2);
  if (!projectRoot || !queryFile || extra.length || resolve(projectRoot) !== projectRoot ||
      mode !== undefined && mode !== '--manual-open' ||
      !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(nativeOrigin) || Number(new URL(nativeOrigin).port) > 65535)
    throw Error('Expected original project root, original binding query and registered native origin');
  const { DatabaseSync } = await import('node:sqlite');
  const profile = readEngineProfile(projectRoot), host = readDshHost(projectRoot, profile);
  const query = JSON.parse(readFileSync(queryFile, 'utf8'));
  const environment = async () => {
    const response = await fetch(nativeOrigin + '/.well-known/t3/environment', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw Error('Original T3 environment unavailable');
    const value = await response.json();
    if (typeof value.environmentId !== 'string' || value.environmentId !== query.environmentId) throw Error('Original T3 environment changed');
    return value.environmentId;
  };
  const environmentId = await environment();
  const database = new DatabaseSync(join(projectRoot, 'data/desktop-pet/t3-home/userdata/state.sqlite'), { readOnly: true });
  database.exec('PRAGMA query_only=ON');
  let proof;
  const connection = new HarnessConnection(() => harnessLaunchUrl(profile.dshWebLog), 10000, true,
    async origin => { proof = await verifyDshNavigationRuntime(projectRoot, origin); return proof.capabilityVersion; });
  try {
    const result = await originalDshNavigationEntry(database, environmentId, query, connection);
    if (await environment() !== environmentId) throw Error('Original T3 environment changed');
    if (proof.origin !== host.origin || proof.pid !== host.pid || proof.childPid !== host.childPid) throw Error('Original DSH owner changed');
    if (mode === '--manual-open') {
      await manualDshHandoff({ manual: true, entry: result, currentOrigin: host.origin,
        readLaunchUrl: () => harnessLaunchUrl(profile.dshWebLog), ownerStillCurrent: async () => {
          const current = readDshHost(projectRoot, profile);
          return current.pid === host.pid && current.childPid === host.childPid && current.nonce === host.nonce && current.origin === host.origin;
        } });
      console.log('已请求打开原 Harness 会话。请查看既有两轮；没有发送新消息。');
    } else console.log(JSON.stringify({ ...result, proof, models: 0, GUI: 0, databaseReadOnly: true }));
  } finally { database.close(); }
}
