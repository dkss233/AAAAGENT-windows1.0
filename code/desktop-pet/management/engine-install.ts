// Install the pinned DSH engine runtime from the console.
//
// The runtime is ~1 GB of downloads plus an npm install, so this is a background task the console
// starts and polls, exactly like the Live2D rig swap and the wake-word models. The engine directory
// name is fixed by the reviewed lock, so "installed" is simply whether the loader's profile exists:
// validity is still decided by readEngineProfile, never by this file.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createBackgroundTask, type TaskStatus } from './background-task.js';

export interface EngineInstallStatus extends TaskStatus {
  /** True once the loader can find a profile; a completed task without this needs a restart to apply. */
  readonly installed: boolean;
}

export interface EngineInstallPort {
  start(): EngineInstallStatus;
  status(): EngineInstallStatus;
}

export function engineInstallPort(root: string, script = join(root, 'tools', 'engine-prepare-host.mjs')): EngineInstallPort {
  const task = createBackgroundTask({
    script,
    root,
    logName: 'engine-prepare.log',
    failedDetail: '引擎运行时准备未完成',
  });
  const profile = join(root, 'artifacts', 'runtime', 'engine-profile.json');
  const installed = () => existsSync(profile);
  return {
    start: () => ({ ...task.start(), installed: installed() }),
    status: () => ({ ...task.status(), installed: installed() }),
  };
}
