import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const UPDATE_ENV = 'CODEX_SPARKLE_ENABLED';
export const UPDATE_LABEL = 'local.aaaagent.codex-update-policy';
const problem = code => Object.assign(new Error(code), { code });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** Read a single sealed ASAR member without executing App code. */
export async function readAppMember(asar, pattern) {
  const metadata = await lstat(asar);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw problem('reviewed_App_member_required');
  const file = await open(asar, 'r');
  const read = async (size, at) => {
    const bytes = Buffer.alloc(size);
    if ((await file.read(bytes, 0, size, at)).bytesRead !== size) throw problem('reviewed_App_member_required');
    return bytes;
  };
  try {
    const prefix = await read(16, 0), headerSize = prefix.readUInt32LE(4), jsonSize = prefix.readUInt32LE(12);
    if (prefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > 16 * 1024 * 1024 ||
        !jsonSize || jsonSize > headerSize - 8) throw problem('reviewed_App_member_required');
    const header = JSON.parse(String(await read(jsonSize, 16)));
    const files = header.files?.['.vite']?.files?.build?.files;
    const members = Object.keys(files ?? {}).filter(name => pattern.test(name));
    if (members.length !== 1) throw problem('reviewed_App_member_required');
    const entry = files[members[0]], offset = Number(entry.offset), size = entry.size;
    if (entry.unpacked || entry.link || !/^\d+$/u.test(entry.offset ?? '') || !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(size) || size < 1 || size > 8 * 1024 * 1024 || headerSize + 8 + offset + size > metadata.size)
      throw problem('reviewed_App_member_required');
    const body = await read(size, headerSize + 8 + offset);
    return { member: '.vite/build/' + members[0], memberSha256: digest(body) };
  } catch (error) { throw error.code === 'reviewed_App_member_required' ? error : problem('reviewed_App_member_required'); }
  finally { await file.close(); }
}

export async function readAppUpdateSources(asar) {
  return {
    gate: await readAppMember(asar, /^build-flavor-[a-zA-Z0-9_-]+\.js$/u),
    initializer: await readAppMember(asar, /^bootstrap-[a-zA-Z0-9_-]+\.js$/u),
  };
}

export function updateLaunchAgent() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><dict>\n' +
    '<key>Label</key><string>' + UPDATE_LABEL + '</string>\n' +
    '<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string>' +
    '<string>' + UPDATE_ENV + '</string><string>false</string></array>\n' +
    '<key>RunAtLoad</key><true/>\n</dict></plist>\n';
}

export const updateLaunchAgentSha256 = () => digest(updateLaunchAgent());

/** A preference alone cannot establish a disabled updater; the App resets it at startup. */
export async function verifyManagedUpdatePolicy(policy, ports) {
  if (policy?.version !== 1 || policy.environmentKey !== UPDATE_ENV || policy.value !== 'false' ||
      policy.launchAgentSha256 !== updateLaunchAgentSha256()) throw problem('reviewed_update_policy_required');
  const sources = await ports.sources();
  if (sources.gate.memberSha256 !== policy.gateSha256 || sources.initializer.memberSha256 !== policy.initializerSha256)
    throw problem('reviewed_App_updater_changed');
  const current = await ports.inspect();
  if (current.environment !== 'false' || current.launchAgentSha256 !== policy.launchAgentSha256)
    throw problem('original_App_update_policy_not_installed');
  return { status: 'reviewed_update_launch_policy', ...sources, currentAppRuntimeVerified: false };
}

/** Save the previous single-key environment before making the reversible user-session change. */
export async function pauseUpdatePolicy(ports) {
  const before = await ports.inspect();
  if (![null, 'true', 'false'].includes(before.environment)) throw problem('unexpected_update_environment');
  if (before.launchAgentSha256 !== null && before.launchAgentSha256 !== updateLaunchAgentSha256())
    throw problem('unknown_update_launch_agent');
  const record = { version: 1, kind: 'Codex_updater_launch_policy', environmentKey: UPDATE_ENV,
    launchAgentSha256: updateLaunchAgentSha256(), before, recordedAt: new Date().toISOString() };
  await ports.saveBefore(record);
  if (before.launchAgentSha256 === null) await ports.createLaunchAgent(updateLaunchAgent());
  await ports.setEnvironment('false');
  const after = await ports.inspect();
  if (after.environment !== 'false' || after.launchAgentSha256 !== updateLaunchAgentSha256())
    throw problem('update_policy_readback_failed');
  const receipt = { ...record, status: 'next_launch_policy_installed', after, currentAppRuntimeVerified: false };
  await ports.saveApplied(receipt);
  return receipt;
}

export async function restoreUpdatePolicy(record, ports) {
  if (record?.version !== 1 || record.kind !== 'Codex_updater_launch_policy' || record.environmentKey !== UPDATE_ENV ||
      record.launchAgentSha256 !== updateLaunchAgentSha256() || ![null, 'true', 'false'].includes(record.before?.environment) ||
      ![null, updateLaunchAgentSha256()].includes(record.before?.launchAgentSha256)) throw problem('reviewed_update_record_required');
  const current = await ports.inspect();
  if (![record.before.environment, 'false'].includes(current.environment) ||
      ![null, record.launchAgentSha256].includes(current.launchAgentSha256)) throw problem('update_policy_owner_changed');
  if (record.before.launchAgentSha256 === null && current.launchAgentSha256 !== null) await ports.removeOwnedLaunchAgent();
  await ports.setEnvironment(record.before.environment);
  const after = await ports.inspect();
  if (after.environment !== record.before.environment || after.launchAgentSha256 !== record.before.launchAgentSha256)
    throw problem('update_policy_restore_readback_failed');
  return { status: 'original_update_launch_policy_restored', after, currentAppRuntimeVerified: false };
}

export function updatePolicyPorts() {
  if (process.platform !== 'darwin' || execFileSync('/bin/launchctl', ['managername'], { encoding: 'utf8' }).trim() !== 'Aqua' ||
      Number(execFileSync('/bin/launchctl', ['manageruid'], { encoding: 'utf8' }).trim()) !== process.getuid())
    throw problem('original_user_GUI_session_required');
  const file = join(homedir(), 'Library/LaunchAgents', UPDATE_LABEL + '.plist');
  const inspect = async () => {
    const parent = await lstat(dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid()) throw problem('owned_launch_agents_required');
    let bytes = null;
    try {
      const s = await lstat(file);
      if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || s.mode & 0o022) throw problem('owned_update_launch_agent_required');
      bytes = await readFile(file);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Never expose unrelated process environments or launchd values.
    let value;
    try { value = execFileSync('/bin/launchctl', ['getenv', UPDATE_ENV], { encoding: 'utf8', stdio: 'pipe' }).trim() || null; }
    catch (error) { if (error.status !== 1) throw problem('update_environment_read_failed'); value = null; }
    if (![null, 'true', 'false'].includes(value)) throw problem('unexpected_update_environment');
    return { environment: value, launchAgentSha256: bytes === null ? null : digest(bytes), launchAgentPath: file, uid: process.getuid() };
  };
  return {
    inspect,
    createLaunchAgent: bytes => writeFile(file, bytes, { flag: 'wx', mode: 0o600 }),
    setEnvironment: value => execFileSync('/bin/launchctl', value === null ? ['unsetenv', UPDATE_ENV] : ['setenv', UPDATE_ENV, value], { stdio: 'pipe' }),
    removeOwnedLaunchAgent: async () => {
      if ((await inspect()).launchAgentSha256 !== updateLaunchAgentSha256()) throw problem('update_policy_owner_changed');
      // It may have run at login; bootout names only our reviewed user LaunchAgent.
      let registered = true;
      try { execFileSync('/bin/launchctl', ['print', 'gui/' + process.getuid() + '/' + UPDATE_LABEL], { stdio: 'pipe' }); }
      catch (error) { if (error.status !== 113) throw problem('update_policy_job_read_failed'); registered = false; }
      if (registered) {
        try { execFileSync('/bin/launchctl', ['bootout', 'gui/' + process.getuid(), file], { stdio: 'pipe' }); }
        catch { throw problem('update_policy_bootout_failed'); }
      }
      await unlink(file);
    },
  };
}

async function privateRecord(path) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid() || parent.mode & 0o077)
    throw problem('private_update_record_required');
  const read = async () => {
    const file = await lstat(path);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid() || file.mode & 0o077) throw problem('private_update_record_required');
    return JSON.parse(await readFile(path, 'utf8'));
  };
  return { read, saveBefore: value => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }),
    saveApplied: value => writeFile(path + '.applied.json', JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) };
}

async function main(mode, file) {
  const ports = updatePolicyPorts();
  if (mode === '--inspect' && !file) return { ...await ports.inspect(), mutation: false, currentAppRuntimeVerified: false };
  if (!['--pause', '--restore'].includes(mode) || !file) throw problem('update_policy_usage');
  const records = await privateRecord(resolve(file));
  return mode === '--pause' ? pauseUpdatePolicy({ ...ports, ...records }) : restoreUpdatePolicy(await records.read(), ports);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.argv[3]).then(value => process.stdout.write(JSON.stringify(value) + '\n'))
    .catch(error => { process.stderr.write(JSON.stringify({ status: 'update_policy_refused', reason: error.code ?? 'update_policy_failed' }) + '\n'); process.exitCode = 1; });
}
