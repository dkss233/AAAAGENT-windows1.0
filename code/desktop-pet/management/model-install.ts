// Start a Live2D model swap from the console.
//
// The swap needs a folder chosen by the operator, and tools/aaaagent-pick-model.mjs opens a real
// Windows folder dialog for that (PowerShell -STA). A browser page cannot open that dialog, but the
// backend is a desktop Node process, so it can — which is why this is a background task the console
// starts and polls rather than something the page drives itself.
//
// aaaagent-pick-model.mjs exits 0 both when it installed a model and when the operator dismissed the
// dialog, and it says which in its own output, so createBackgroundTask reads the log to tell them apart.
import { createBackgroundTask, type TaskStatus } from './background-task.js';
import { join } from 'node:path';

export type ModelInstallStatus = TaskStatus;

/** What the console drives. Kept narrow so server.ts does not know how the install is performed. */
export interface ModelInstallPort {
  start(): ModelInstallStatus;
  status(): ModelInstallStatus;
}

/** The port server.ts talks to. Bound to one project root because the picker script needs it. */
export function modelInstallPort(root: string): ModelInstallPort {
  const task = createBackgroundTask({
    script: join(root, 'tools', 'aaaagent-pick-model.mjs'),
    root,
    logName: 'model-install.log',
    cancelledWhen: /已取消，未做任何改动/,
    failedDetail: '更换模型未完成',
  });
  return { start: () => task.start(), status: () => task.status() };
}
