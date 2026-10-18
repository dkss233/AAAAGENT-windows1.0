import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { engineDirectory, sha256, verifyEngineRuntime } from './runtime.mjs';
import { nativePresetHostOverlay } from '../../../desktop-pet/dist/harness/preset.js';
import { isPrivateDirectorySync, isPrivateFileSync, restrictPrivatePathSync } from '../../../desktop-pet/dist/core/platform-files.js';

const quoted = s => "'" + s.replaceAll("'", "'\\''") + "'";
const launcherName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
export const profilePath = root => join(root, 'artifacts/runtime/engine-profile.json');
export function readEngineProfile(projectRoot) {
  let value;
  try { const file = profilePath(projectRoot); if (lstatSync(file).isSymbolicLink()) throw Error('Engine profile link refused');
    value = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
  if (value.version !== 1 || value.projectRoot !== projectRoot || value.runtimeRoot !== join(projectRoot, engineDirectory) ||
      value.home !== join(projectRoot, '.local/data/engine-home') || value.dshWebLog !== join(value.home, 'dsh-web.log') ||
      value.codexLauncher !== join(projectRoot, 'artifacts/runtime/engine-bindings', launcherName))
    throw Error('Project engine profile changed');
  const userHome = userInfo().homedir;
  value.codexHome ??= join(value.home, '.codex');
  value.dshHome ??= join(value.home, '.dsh');
  for (const [path, allowed] of [[value.codexHome,[join(value.home,'.codex'),join(userHome,'.codex')]],
      [value.dshHome,[join(value.home,'.dsh'),join(userHome,'.dsh')]]]) {
    if (!allowed.includes(path) || realpathSync(path) !== path || !isPrivateDirectorySync(path))
      throw Error('Explicit project engine data home changed');
  }
  const runtime = verifyEngineRuntime(value.runtimeRoot);
  if (process.platform === 'win32' && !isPrivateFileSync(profilePath(projectRoot))) throw Error('Private engine profile required');
  if (sha256(readFileSync(value.codexLauncher)) !== sha256(codexLauncher(runtime, value.home, value.codexHome))) throw Error('Project Codex launcher changed');
  if (value.dshPresetOverlay !== join(projectRoot, 'artifacts/runtime/engine-bindings/dsh-presets.patch.yml') ||
      readFileSync(value.dshPresetOverlay, 'utf8') !== presetOverlay(projectRoot, value.home, runtime.nodeExecutable, value.dshHome))
    throw Error('Project DSH preset overlay changed');
  return { ...value, runtime };
}

export function presetOverlay(root, home, nodeExecutable, dshHome = join(home,'.dsh')) {
  return nativePresetHostOverlay({ dshHome, projectRoot: root, nodeExecutable,
    managementDescriptor: join(root,'.local/model-evaluation/trial/user-trial/management-session.json') });
}

export function codexLauncher(runtime, home, codexHome = join(home, '.codex')) {
  if (process.platform === 'win32') {
    const values = [home, codexHome, join(home, '.dsh'), runtime.nodeExecutable,
      resolve(runtime.root, '../../..', 'code/workbench/integration/engine-pins/launch.mjs'), runtime.root];
    if (values.some(value => /[%!"\r\n]/.test(value))) throw Error('Unsupported Windows launcher path');
    return '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' +
      `set "HOME=${values[0]}"\r\nset "CODEX_HOME=${values[1]}"\r\nset "DSH_HOME=${values[2]}"\r\n` +
      `"${values[3]}" "${values[4]}" "${values[5]}" codex %*\r\n`;
  }
  return '#!/bin/sh\nexec /usr/bin/env ' + quoted('HOME=' + home) + ' ' + quoted('CODEX_HOME=' + codexHome) + ' ' + quoted('DSH_HOME=' + join(home, '.dsh')) + ' ' + quoted(runtime.nodeExecutable) + ' ' +
    quoted(resolve(runtime.root, '../../..', 'code/workbench/integration/engine-pins/launch.mjs')) + ' ' + quoted(runtime.root) + ' codex "$@"\n';
}

/** Only for an empty new deployment home; migration of an existing home is a separate explicit step. */
export function projectT3EngineSettings(original, profile) {
  return { ...original, providers: { ...Object.fromEntries(['claudeAgent','cursor','grok','opencode','antigravity'].map(id => [id,{enabled:false}])), ...original.providers,
      codex: { ...original.providers?.codex, enabled: false } },
    providerInstances: { ...original.providerInstances,
      codex: { ...original.providerInstances?.codex, driver: 'codex', enabled: true,
        config: { ...original.providerInstances?.codex?.config, binaryPath: profile.codexLauncher, homePath: profile.codexHome } },
      dsh: { ...original.providerInstances?.dsh, driver: 'dsh', enabled: true,
        config: { ...original.providerInstances?.dsh?.config, agentPreset: 'desktop-pet-work-v1' } } } };
}

export function installEngineProfile(projectRoot, runtimeRoot, t3Home, { codexHome, dshHome, preserveSettings = false } = {}) {
  const runtime = verifyEngineRuntime(runtimeRoot), home = join(projectRoot, '.local/data/engine-home');
  if (runtimeRoot !== join(projectRoot, engineDirectory)) throw Error('Project-owned runtime required');
  // Existing homes must be explicitly idle. Unknown/stale owner records also need reconciliation.
  for (const name of ['.aaaagent-t3-host.json','.aaaagent-t3-host.lock','.aaaagent-t3-owner.json']) {
    try { lstatSync(join(t3Home,name)); throw Error('Stop the registered T3 background before binding an existing home'); }
    catch(e) { if(e.code !== 'ENOENT') throw e; }
  }
  const launcher = join(projectRoot, 'artifacts/runtime/engine-bindings', launcherName);
  mkdirSync(dirname(launcher), { recursive: true, mode: 0o700 });
  writeFileSync(launcher, codexLauncher(runtime, home, codexHome ?? join(home,'.codex')), { flag: 'wx', mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  restrictPrivatePathSync(home);
  // Idempotent on purpose: repairing an install whose engine was rebuilt must not fail just because
  // these data homes already exist. Nothing inside them is touched.
  for (const name of ['.codex', '.dsh']) mkdirSync(join(home, name), { recursive: true, mode: 0o700 });
  // The session-entry client plugin belongs to the WEB PROFILE, not to the engine: the Loader anchors
  // baseUrl at the profile directory and resolves plugin names from there, so a package that is only
  // in the engine's node_modules fails to import. The engine ships the bytes; this places them.
  const pluginSource = join(runtime.root, 'dsh/node_modules/@aaaagent/dsh-session-entry');
  if (existsSync(pluginSource)) {
    const pluginTarget = join(home, '.dsh/profiles/web/node_modules/@aaaagent/dsh-session-entry');
    mkdirSync(dirname(pluginTarget), { recursive: true, mode: 0o700 });
    cpSync(pluginSource, pluginTarget, { recursive: true });
  }
  const dshPresetOverlay=join(projectRoot,'artifacts/runtime/engine-bindings/dsh-presets.patch.yml');
  writeFileSync(dshPresetOverlay,presetOverlay(projectRoot,home,runtime.nodeExecutable,dshHome ?? join(home,'.dsh')),{flag:'wx',mode:0o600});
  const profile = { version: 1, projectRoot, runtimeRoot, home, dshWebLog: join(home, 'dsh-web.log'), codexLauncher: launcher, dshPresetOverlay, codexHome: codexHome ?? join(home,'.codex'), dshHome: dshHome ?? join(home,'.dsh') };
  const settings = join(t3Home, 'userdata/settings.json'); mkdirSync(dirname(settings), { recursive: true, mode: 0o700 });
  const original = preserveSettings ? JSON.parse(readFileSync(settings,'utf8')) : {};
  writeFileSync(settings, JSON.stringify(projectT3EngineSettings(original,profile),null,2)+'\n',
    { ...(preserveSettings ? {} : {flag:'wx'}), mode:0o600 });
  writeFileSync(profilePath(projectRoot), JSON.stringify(profile, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  for (const file of [profilePath(projectRoot), dshPresetOverlay, launcher, settings]) restrictPrivatePathSync(file);
  return readEngineProfile(projectRoot);
}

export function verifyT3EngineSettings(t3Home, profile) {
  const settings = JSON.parse(readFileSync(join(t3Home, 'userdata/settings.json'), 'utf8'));
  for (const [id, provider] of Object.entries(settings.providerInstances ?? {})) {
    if (provider.driver !== 'codex' || provider.enabled === false) continue;
    if (provider.config?.binaryPath !== profile.codexLauncher || provider.config?.homePath !== profile.codexHome)
      throw Error('T3 project engine binding changed: ' + id);
  }
  if (settings.providers?.codex?.enabled !== false) throw Error('Legacy Codex fallback must be disabled');
  if (settings.providerInstances?.dsh?.driver !== 'dsh' || settings.providerInstances.dsh.enabled !== true ||
      settings.providerInstances.dsh.config?.agentPreset !== 'desktop-pet-work-v1') throw Error('Project DSH preset binding changed');
}
