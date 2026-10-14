import * as fs from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
// Speech and dialogue editors deliberately share this existing lock, backup and rollback transaction.
export async function updateProviderConfiguration(configPath, transform, io = fs) {
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
export const updateSpeechConfiguration = updateProviderConfiguration;
