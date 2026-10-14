import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);

// The authenticated mount supplies this exact registered project; no arbitrary
// path or global Codex history is accepted from the browser.
export function createIndependentBlackboardReader({ database, scope, readThread, python = process.env.AAAAGENT_BOARD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }) {
  if (!database || !scope?.environmentId || !scope?.projectId || typeof readThread !== 'function') throw Error('Registered board required');
  return async query => {
    if (query.environmentId !== scope.environmentId || query.projectId !== scope.projectId) return { status: 404, body: { error: 'board_scope_mismatch' } };
    try {
      const { stdout } = await run(python, ['-X', 'utf8', '-I', fileURLToPath(new URL('./store.py', import.meta.url)), '--database', database, '--snapshot'], { timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
      const value = JSON.parse(stdout);
      if (value.scope.environmentId !== scope.environmentId || value.scope.projectId !== scope.projectId) throw Error('Stored scope changed');
      // Every route identity is checked against the original service, not a
      // title/cwd guess or the native parent-child relation endpoint.
      const participants = await Promise.all(value.participants.map(async actor => {
        const snapshot = await readThread(actor.threadId);
        const thread = snapshot?.thread;
        if (!thread || thread.id !== actor.threadId || thread.projectId !== scope.projectId || thread.modelSelection?.instanceId !== actor.providerInstanceId) throw Error('Original conversation binding changed');
        return { ...actor, identitySource: 't3-original-thread-snapshot', nativeThreadId: thread.session?.resume?.threadId ?? thread.session?.nativeThreadId ?? null };
      }));
      return { status: 200, body: { ...value, participants } };
    } catch { return { status: 503, body: { error: 'board_read_unavailable' } }; }
  };
}
