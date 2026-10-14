import { constants } from 'node:fs';
import { isPrivateFileSync } from '../core/platform-files.js';
import { open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { TrialConfiguration } from '../app/trial-config.js';
import type { ProjectTerminalConfiguration } from '../contracts/project-terminal-configuration.js';
import type { ProjectTerminalModelTransport } from '../contracts/project-terminal-processing.js';
import { ManagementError } from '../contracts/management.js';
import { deepseekFlashModel } from '../providers/text-protocol.js';
import { createProjectTerminalModelDeriver } from '../projects/project-terminal-model-deriver.js';
import { createProjectTerminalModelCall } from './project-terminal-processing.js';
import { createDeepSeekProjectTerminalTransport } from './project-terminal-deepseek-transport.js';
import type { ProjectTerminalRuntimeRegistration } from './bootstrap.js';

const invalid = (): never => { throw new ManagementError('unavailable', '项目记忆专用配置暂不可用。'); };
export const projectTerminalConfigurationFile = (root: string): string =>
  resolve(root, '.local/data/project-terminal-processing.json');

/** Metadata only; no file, key, ledger, queue or network access. */
export function defaultProjectTerminalConfiguration(credentialRef: string): ProjectTerminalConfiguration {
  const { credentialFile: _unused, ...model } = deepseekFlashModel('/unused-metadata-only');
  return { version: '0.1.0', enabled: false, maxOutputTokens: 1024,
    selection: { version: '0.1.0', scope: 'project-terminal', adapterId: 'deepseek-summary',
      ...model, credentialRef, timeoutMs: 30000 } };
}

export function validateProjectTerminalConfiguration(value: unknown): ProjectTerminalConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const c = value as ProjectTerminalConfiguration;
  if (Object.keys(c).sort().join(',') !== 'enabled,maxOutputTokens,selection,version' ||
      c.version !== '0.1.0' || typeof c.enabled !== 'boolean' || c.maxOutputTokens !== 1024 ||
      !c.selection || typeof c.selection !== 'object' || Array.isArray(c.selection) ||
      typeof c.selection.credentialRef !== 'string' || !/^deepseek-[a-f0-9]{12}$/u.test(c.selection.credentialRef)) return invalid();
  const expected = defaultProjectTerminalConfiguration(c.selection.credentialRef).selection;
  if (Object.keys(c.selection).sort().join(',') !== Object.keys(expected).sort().join(',') ||
      Object.entries(expected).some(([key, value]) =>
        (c.selection as unknown as Record<string, unknown>)[key] !== value)) return invalid();
  return structuredClone(c);
}

/** Enabling is explicit; bootstrap owns the existing queue and its normal background lifecycle. */
export function projectTerminalRuntimeRegistration(base: TrialConfiguration, value: unknown,
  transport?: ProjectTerminalModelTransport): ProjectTerminalRuntimeRegistration | undefined {
  const config = validateProjectTerminalConfiguration(value);
  if (!config.enabled) return undefined;
  return registration(base, config, transport);
}

/** Dedicated finite runner only. Does not register or enable any bootstrap/background worker. */
export function projectTerminalFiniteRegistration(base: TrialConfiguration, value: unknown,
  transport: ProjectTerminalModelTransport): ProjectTerminalRuntimeRegistration {
  const config = validateProjectTerminalConfiguration(value);
  if (config.enabled) return invalid();
  return registration(base, config, transport);
}

function registration(base: TrialConfiguration, config: ProjectTerminalConfiguration,
  transport?: ProjectTerminalModelTransport): ProjectTerminalRuntimeRegistration {
  const adapter = transport ?? createDeepSeekProjectTerminalTransport();
  // Checks the existing catalog and credential metadata only, without opening key contents or reserving money.
  if (!createProjectTerminalModelCall(base, config.selection, adapter)) return invalid();
  return { selection: config.selection, transport: adapter,
    createDeriver: model => createProjectTerminalModelDeriver({
      complete: request => model.complete({ ...request, maxOutputTokens: config.maxOutputTokens }),
    }) };
}

/** Missing, disabled or invalid settings keep the production worker unavailable. Never writes settings. */
export async function loadProjectTerminalRuntimeRegistration(base: TrialConfiguration,
  transport?: ProjectTerminalModelTransport): Promise<ProjectTerminalRuntimeRegistration | undefined> {
  const file = projectTerminalConfigurationFile(base.projectRoot);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (await realpath(dirname(file)) !== dirname(file)) return invalid();
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (stat.size > 65536 || !isPrivateFileSync(file, stat)) return invalid();
    const bytes = await handle.readFile();
    if (bytes.length > 65536) return invalid();
    return projectTerminalRuntimeRegistration(base, JSON.parse(bytes.toString('utf8')), transport);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      process.stderr.write('Project terminal configuration unavailable; processing remains disabled.\n');
    return undefined;
  } finally { await handle?.close(); }
}
