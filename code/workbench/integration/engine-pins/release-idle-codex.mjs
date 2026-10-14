import { randomUUID } from 'node:crypto';

/** Settle only a completed original thread. The original server's conditional stop owns the race guard. */
export async function releaseIdleCodex({ client, target, readBinding, commandId = randomUUID(),
  wait = () => new Promise(resolve => setTimeout(resolve, 100)) }) {
  const env = await client.environmentDescriptor();
  if (env.environmentId !== target.environmentId || target.providerInstanceId !== 'codex')
    throw Error('Original Codex handoff identity changed');
  const shell = await client.shellSnapshot();
  if (shell.projects.filter(p => p.id === target.projectId && p.workspaceRoot === target.workspaceRoot && !p.deletedAt).length !== 1)
    throw Error('Original Codex project changed');
  const original = await client.threadSnapshot(target.threadId, 1), thread = original.thread;
  if (!thread || thread.id !== target.threadId || thread.projectId !== target.projectId || thread.deletedAt ||
      thread.modelSelection?.instanceId !== 'codex' || thread.session?.providerName !== 'codex' ||
      thread.session.providerInstanceId !== 'codex' || thread.session.status !== 'ready' || thread.session.activeTurnId ||
      thread.latestTurn?.state !== 'completed' || thread.settledOverride !== null ||
      !Number.isSafeInteger(original.snapshotSequence)) throw Error('Original Codex thread is not idle');
  if (!Array.isArray(thread.activities)) throw Error('Original Codex request state unavailable');
  const pending = new Set();
  for (const activity of thread.activities) {
    const id = activity.payload?.requestId;
    if (typeof id !== 'string') continue;
    if (['approval.requested', 'user-input.requested'].includes(activity.kind)) pending.add(id);
    if (['approval.resolved', 'user-input.resolved'].includes(activity.kind)) pending.delete(id);
  }
  if (pending.size) throw Error('Original Codex has an open request');
  const binding = await readBinding();
  if (binding.threadId !== target.threadId || binding.nativeThreadId !== target.nativeThreadId ||
      binding.provider !== 'codex' || binding.providerInstanceId !== 'codex') throw Error('Original Codex native binding changed');
  // auto-settle is server-internal and rejected by the public dispatch schema.
  // The public settle decider also rejects active sessions and queued starts;
  // its reactor uses onlyIfSettled for the eventual single-session stop.
  const command = { type: 'thread.settle', commandId, threadId: target.threadId };
  // No dispatch retry: an unknown reply must be investigated through this command ID.
  const dispatched = await client.dispatch(command), receipt = await client.readReceipt(commandId);
  if (receipt?.status !== 'accepted' || receipt.aggregateId !== target.threadId) throw Error('Original Codex settle not confirmed; do not redispatch');
  for (let index = 0; index < 20; index++) {
    const current = await client.threadSnapshot(target.threadId, 1);
    if (current.thread?.session?.status === 'stopped' && current.thread.session.activeTurnId === null &&
        current.thread.latestTurn?.turnId === thread.latestTurn.turnId && current.thread.latestTurn.state === 'completed' &&
        current.thread.settledOverride === 'settled') {
      const after = await readBinding();
      if (JSON.stringify(after) !== JSON.stringify(binding)) throw Error('Original Codex native binding changed after release');
      return { command, dispatched, receipt, before: original, after: current, nativeBinding: binding,
        modelCalls: 0, providerTurnStarts: 0, onlyOriginalThreadReleased: true };
    }
    if (current.thread?.session?.activeTurnId || ['starting', 'running'].includes(current.thread?.session?.status))
      throw Error('Original Codex thread re-engaged; handoff not confirmed');
    await wait();
  }
  throw Error('Original Codex release not confirmed; inspect same command');
}
