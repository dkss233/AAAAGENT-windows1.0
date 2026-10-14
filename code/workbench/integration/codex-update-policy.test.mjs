import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { UPDATE_ENV, pauseUpdatePolicy, restoreUpdatePolicy, verifyManagedUpdatePolicy,
  updateLaunchAgent, updateLaunchAgentSha256, readAppUpdateSources } from './codex-update-policy.mjs';

function fixture(before = {}) {
  let state = { environment: null, launchAgentSha256: null, ...before };
  const actions = []; let saved, applied;
  return { actions, before: () => saved, applied: () => applied, ports: {
    inspect: async () => ({ ...state }),
    saveBefore: async value => { actions.push('record-before'); if (saved) throw Object.assign(Error(), { code: 'EEXIST' }); saved = value; },
    createLaunchAgent: async value => { actions.push('login-policy'); assert.equal(value, updateLaunchAgent()); state.launchAgentSha256 = updateLaunchAgentSha256(); },
    setEnvironment: async value => { actions.push('environment:' + value); state.environment = value; },
    saveApplied: async value => { actions.push('record-applied'); applied = value; },
    removeOwnedLaunchAgent: async () => { actions.push('remove-owned-login-policy'); state.launchAgentSha256 = null; },
  } };
}

test('freezes the single updater switch and can recover an originally unset environment', async () => {
  const f = fixture(), result = await pauseUpdatePolicy(f.ports);
  assert.equal(result.status, 'next_launch_policy_installed');
  assert.equal(result.currentAppRuntimeVerified, false);
  assert.deepEqual(f.actions, ['record-before', 'login-policy', 'environment:false', 'record-applied']);
  assert.equal(f.before().before.environment, null);
  assert.equal((await restoreUpdatePolicy(f.before(), f.ports)).status, 'original_update_launch_policy_restored');
  assert.deepEqual(f.actions.slice(4), ['remove-owned-login-policy', 'environment:null']);
  await assert.rejects(pauseUpdatePolicy(f.ports), { code: 'EEXIST' });
});

test('preserves a pre-existing reviewed login policy and restores its previous true value', async () => {
  const f = fixture({ environment: 'true', launchAgentSha256: updateLaunchAgentSha256() });
  await pauseUpdatePolicy(f.ports); await restoreUpdatePolicy(f.before(), f.ports);
  assert.equal(f.actions.includes('login-policy'), false); assert.equal(f.actions.includes('remove-owned-login-policy'), false);
  assert.equal(f.actions.at(-1), 'environment:true');
});

for (const [name, before, reason] of [
  ['an unknown flag value', { environment: 'unknown' }, 'unexpected_update_environment'],
  ['an unrelated LaunchAgent', { launchAgentSha256: 'other-owner' }, 'unknown_update_launch_agent'],
]) test('pause preserves ' + name, async () => {
  const f = fixture(before);
  await assert.rejects(pauseUpdatePolicy(f.ports), { code: reason }); assert.deepEqual(f.actions, []);
});

test('recovery refuses a changed LaunchAgent before touching the environment', async () => {
  const f = fixture(); await pauseUpdatePolicy(f.ports);
  const changed = fixture({ environment: 'false', launchAgentSha256: 'changed' });
  await assert.rejects(restoreUpdatePolicy(f.before(), changed.ports), { code: 'update_policy_owner_changed' });
  assert.deepEqual(changed.actions, []);
});

test('a persisted preference is insufficient and a changed App updater fails before launch', async () => {
  const policy = { version: 1, environmentKey: UPDATE_ENV, value: 'false', launchAgentSha256: updateLaunchAgentSha256(),
    gateSha256: 'gate', initializerSha256: 'initializer' };
  const sources = async () => ({ gate: { memberSha256: 'gate' }, initializer: { memberSha256: 'initializer' } });
  await assert.rejects(verifyManagedUpdatePolicy(policy, { sources,
    inspect: async () => ({ SUAutomaticallyUpdate: false, SUEnableAutomaticChecks: false, environment: null, launchAgentSha256: policy.launchAgentSha256 }) }),
  { code: 'original_App_update_policy_not_installed' });
  const ports = { sources, inspect: async () => ({ environment: 'false', launchAgentSha256: policy.launchAgentSha256 }) };
  assert.equal((await verifyManagedUpdatePolicy(policy, ports)).currentAppRuntimeVerified, false);
  await assert.rejects(verifyManagedUpdatePolicy(policy, { ...ports,
    sources: async () => ({ gate: { memberSha256: 'changed' }, initializer: { memberSha256: 'initializer' } }) }),
  { code: 'reviewed_App_updater_changed' });
});

test('login policy changes only the updater key and has no keepalive, transport or App command', () => {
  const xml = updateLaunchAgent();
  assert.match(xml, /<string>setenv<\/string><string>CODEX_SPARKLE_ENABLED<\/string><string>false<\/string>/u);
  assert.doesNotMatch(xml, /CODEX_HOME|CODEX_APP_SERVER|KeepAlive|StartInterval|ChatGPT\.app/u);
});

test('updater source checks read both actual members and reject an unsealed alias', async t => {
  const directory = await mkdtemp('/private/tmp/aaa-updater-source-');t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'app.asar'), body = Buffer.from('gateinitializer');
  const make = async alias => {
    const header = Buffer.from(JSON.stringify({ files: { '.vite': { files: { build: { files: {
      'build-flavor-current.js': { offset: '0', size: 4, ...(alias ? { link: 'elsewhere' } : {}) },
      'bootstrap-current.js': { offset: '4', size: 11 },
    } } } } } }));
    const prefix = Buffer.alloc(16);prefix.writeUInt32LE(4, 0);prefix.writeUInt32LE(header.length + 8, 4);
    prefix.writeUInt32LE(header.length + 4, 8);prefix.writeUInt32LE(header.length, 12);
    await writeFile(file, Buffer.concat([prefix, header, body]));
  };
  await make(false);
  const read = await readAppUpdateSources(file);
  assert.equal(read.gate.member, '.vite/build/build-flavor-current.js');
  assert.equal(read.initializer.member, '.vite/build/bootstrap-current.js');
  await make(true);await assert.rejects(readAppUpdateSources(file), { code: 'reviewed_App_member_required' });
});
