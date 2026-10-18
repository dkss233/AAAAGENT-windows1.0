// Transactional editor for the trial configuration pair (config.json + activation.json).
//
// Living in providers/ rather than tools/ because TWO callers need the exact same transaction: the
// configure-*.mjs CLIs, and the management server applying a change submitted from the console. A
// second implementation would be a second chance to get the lock, the hash pair or the rollback wrong.
//
// The rule "quit the desktop before editing" belongs to the CLI, not here: the console applies its
// change from inside the running backend, so refusing a live backend would make the console path
// impossible. Concurrent editors are still excluded by the exclusive lock file below.
import * as fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface ConfigurationBackup { readonly config: string; readonly activation: string }

/** Applies `transform` to the configuration pair atomically, with backups and rollback.
 *
 *  The activation hash is rewritten in the same transaction, because a config whose recorded
 *  configSha256 no longer matches is refused at startup — so a half-applied edit bricks the launch. */
export async function updateProviderConfiguration(
  configPath: string,
  transform: (config: any) => Promise<any> | any,
  io: Pick<typeof fs, 'open' | 'readFile' | 'writeFile' | 'rename' | 'unlink'> = fs,
): Promise<ConfigurationBackup> {
  const activationPath = resolve(dirname(configPath), 'activation.json'), stamp = randomUUID();
  const lockPath = configPath + '.speech-edit.lock';
  const lock = await io.open(lockPath, 'wx', 0o600);
  const configTemp = configPath + '.' + stamp + '.next', activationTemp = activationPath + '.' + stamp + '.next';
  const rollbackTemp = configPath + '.' + stamp + '.rollback';
  const backup = { config: configPath + '.' + stamp + '.backup', activation: activationPath + '.' + stamp + '.backup' };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, stamp }));
    const original = await io.readFile(configPath, 'utf8'), originalActivation = await io.readFile(activationPath, 'utf8');
    const config = JSON.parse(original), activation = JSON.parse(originalActivation);
    if (activation.configSha256 !== hash(original) || activation.phaseId !== config.phaseId) throw Error('Configuration/activation pair differs; use the matching files.');
    const updated = await transform(config);
    const next = JSON.stringify(updated, null, 2) + '\n';
    await io.writeFile(backup.config, original, { flag: 'wx', mode: 0o600 });
    await io.writeFile(backup.activation, originalActivation, { flag: 'wx', mode: 0o600 });
    await io.writeFile(configTemp, next, { flag: 'wx', mode: 0o600 });
    await io.writeFile(activationTemp, JSON.stringify({ ...activation, configSha256: hash(next) }) + '\n', { flag: 'wx', mode: 0o600 });
    if (await io.readFile(configPath, 'utf8') !== original || await io.readFile(activationPath, 'utf8') !== originalActivation) throw Error('Configuration changed during provider setup; retry after the other editor closes.');
    await io.rename(configTemp, configPath);
    try { await io.rename(activationTemp, activationPath); }
    catch (error) {
      try { await io.writeFile(rollbackTemp, original, { flag: 'wx', mode: 0o600 }); await io.rename(rollbackTemp, configPath); }
      catch { throw Error(`Configuration rollback could not finish. Restore the preserved pair: ${backup.config} and ${backup.activation}`); }
      throw Error(`Activation update failed; the original pair was restored. Backups: ${backup.config} and ${backup.activation}`, { cause: error });
    }
    return backup;
  } finally {
    try { for (const file of [configTemp, activationTemp, rollbackTemp]) await io.unlink(file).catch(() => {}); }
    finally { await lock.close(); await io.unlink(lockPath); }
  }
}

/** Refuses when a desktop backend currently holds the configured lock, for CLI callers only. */
export async function assertDesktopStopped(configPath: string, projectRoot: string, read = fs.readFile): Promise<void> {
  for (const lockPath of [resolve(dirname(configPath), '../../backend.lock'), resolve(projectRoot, '.local/model-evaluation/backend.lock')]) {
    try {
      const lock = JSON.parse(await read(lockPath, 'utf8'));
      if (Number.isSafeInteger(lock.pid) && lock.pid > 0) { process.kill(lock.pid, 0); throw Error('请先退出正在运行的桌宠，再修改语音设置。'); }
    } catch (e) { if (!['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
  }
}
