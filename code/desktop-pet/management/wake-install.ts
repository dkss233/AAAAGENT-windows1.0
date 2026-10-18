// Install the wake-word models from the console.
//
// The five model files cannot ship with the repository (size and third-party licence), so the wake
// feature stays off until they are downloaded and verified. tools/prepare-wake-models.mjs does the
// download, the hash check and the install, and it needs a few minutes and a mirror, so it runs as a
// background task the console polls — the same shape as the Live2D swap.
//
// There is no cancel path: the script either installs all five verified files or exits non-zero.
import { createBackgroundTask, type TaskStatus } from './background-task.js';
import { join } from 'node:path';

export type WakeInstallStatus = TaskStatus;

/** What the console drives. */
export interface WakeInstallPort {
  start(): WakeInstallStatus;
  status(): WakeInstallStatus;
}

export function wakeInstallPort(root: string): WakeInstallPort {
  const task = createBackgroundTask({
    script: join(root, 'tools', 'prepare-wake-models.mjs'),
    root,
    logName: 'wake-install.log',
    failedDetail: '唤醒模型准备未完成',
  });
  return { start: () => task.start(), status: () => task.status() };
}
