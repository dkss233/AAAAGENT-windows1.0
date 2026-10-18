// Run one long, operator-visible task at a time and let the console poll it.
//
// Two console buttons need this: swapping the Live2D rig (a native folder dialog, then a rebuild and
// re-pin) and installing the wake-word models (~33 MB from a mirror). Both take far longer than a
// request, both must not block, and both need to report whether the operator cancelled. Keeping the
// state machine here means the two features cannot drift.
//
// Single-flight: the second start while one is running returns the running state rather than queueing.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TaskStatus {
  readonly running: boolean;
  /** Finished successfully. What "success" means is the caller's marker check. */
  readonly completed: boolean;
  /** The operator backed out, so nothing changed. */
  readonly cancelled: boolean;
  readonly detail?: string;
  readonly logFile: string;
}

export interface TaskSpec {
  /** Absolute path of the script to run. */
  readonly script: string;
  /** Working directory and the owner of `.local/<logName>`. */
  readonly root: string;
  readonly logName: string;
  /** Text that appears in the log when the operator cancelled. Omit when the task has no cancel path. */
  readonly cancelledWhen?: RegExp;
  /** Prefix for the failure detail. */
  readonly failedDetail: string;
}

export interface BackgroundTask {
  start(): TaskStatus;
  status(): TaskStatus;
}

export function createBackgroundTask(spec: TaskSpec): BackgroundTask {
  const logFile = join(spec.root, '.local', spec.logName);
  let child: ReturnType<typeof spawn> | undefined;
  let settled: 'completed' | 'cancelled' | 'failed' | undefined;
  let detail: string | undefined;

  const status = (): TaskStatus => ({
    running: child !== undefined,
    completed: settled === 'completed',
    cancelled: settled === 'cancelled',
    ...(detail === undefined ? {} : { detail }),
    logFile,
  });

  return {
    status,
    start(): TaskStatus {
      if (child) return status();
      // A new run must not report the previous run's outcome.
      settled = undefined;
      detail = undefined;

      const localDir = join(spec.root, '.local');
      try { mkdirSync(localDir, { recursive: true, mode: 0o700 }); } catch { /* the open below reports it */ }
      const fd = openSync(logFile, 'w');
      try {
        child = spawn(process.execPath, [spec.script], {
          cwd: spec.root, detached: false, stdio: ['ignore', fd, fd], windowsHide: true,
        });
      } catch (error) {
        closeSync(fd);
        settled = 'failed';
        detail = spec.failedDetail + '：' + String((error as Error).message).slice(0, 200);
        return status();
      }
      closeSync(fd);

      child.on('error', (error) => {
        detail = spec.failedDetail + '：' + String(error.message).slice(0, 200);
        settled = 'failed'; child = undefined;
      });
      child.on('close', (code) => {
        child = undefined;
        if (code !== 0) { settled = 'failed'; detail = spec.failedDetail + '（退出码 ' + String(code) + '）。'; return; }
        // A cancelled run exits 0 as well, so the script's own output decides which it was.
        let text = '';
        try { text = readFileSync(logFile, 'utf8'); } catch { /* fall through */ }
        settled = spec.cancelledWhen?.test(text) ? 'cancelled' : 'completed';
      });
      return status();
    },
  };
}
