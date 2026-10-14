import type { WorkbenchTaskRef } from '../contracts/workbench.js';
import type { ForwardRequest } from '../contracts/harness.js';

/** These keys contain only native identity. Names and paths are never identity evidence. */
export function nativeTaskKey(ref: WorkbenchTaskRef): string {
  switch (ref.origin) {
    case 't3':
      if (!hasNativeProjectBinding(ref)) throw new Error('t3_project_binding_unverified');
      return JSON.stringify(['t3', ref.provider, ref.environmentId, ref.t3ProjectId,
        ref.threadId, ref.providerInstanceId]);
    case 'legacy_codex_app':
      return JSON.stringify(['legacy_codex_app', ref.hostId, ref.nativeSessionId]);
    case 'legacy_dsh':
      return JSON.stringify(['legacy_dsh', ref.profileId, ref.nativeSessionId]);
  }
}

/** A T3 thread has one local owner across provider, instance and project changes. */
function nativeOwnerKey(ref: WorkbenchTaskRef): string {
  return ref.origin === 't3'
    ? JSON.stringify(['t3', ref.environmentId, ref.threadId])
    : nativeTaskKey(ref);
}

function hasNativeProjectBinding(ref: WorkbenchTaskRef): boolean {
  return ref.origin !== 't3' || typeof ref.t3ProjectId === 'string' && ref.t3ProjectId.trim().length > 0;
}

function sameTaskBinding(left: WorkbenchTaskRef, right: WorkbenchTaskRef): boolean {
  if (left.origin !== right.origin || left.provider !== right.provider) return false;
  if (left.origin === 't3' && right.origin === 't3') {
    return left.environmentId === right.environmentId && left.threadId === right.threadId &&
      left.t3ProjectId === right.t3ProjectId && left.providerInstanceId === right.providerInstanceId;
  }
  return nativeTaskKey(left) === nativeTaskKey(right);
}

/** A caller can show this entry when native continuation is not verified. */
export function originalSessionEntry(ref: WorkbenchTaskRef):
  | { readonly kind: 'codex_app'; readonly hostId: string; readonly nativeSessionId: string }
  | { readonly kind: 'dsh_host'; readonly profileId: string; readonly nativeSessionId: string }
  | null {
  if (ref.origin === 'legacy_codex_app') return { kind: 'codex_app', hostId: ref.hostId, nativeSessionId: ref.nativeSessionId };
  if (ref.origin === 'legacy_dsh') return { kind: 'dsh_host', profileId: ref.profileId, nativeSessionId: ref.nativeSessionId };
  return null;
}

/** Index hydrated from the caller's durable task table. It rejects identity drift. */
export class TaskReferenceIndex {
  private readonly byId = new Map<string, WorkbenchTaskRef>();
  private readonly byNative = new Map<string, string>();

  add(ref: WorkbenchTaskRef): void {
    const key = nativeOwnerKey(ref);
    const previous = this.byId.get(ref.id);
    if (previous && (previous.projectId !== ref.projectId || !sameTaskBinding(previous, ref))) {
      throw new Error('task_id_rebound');
    }
    const nativeOwner = this.byNative.get(key);
    if (nativeOwner && nativeOwner !== ref.id) throw new Error('native_identity_rebound');
    this.byId.set(ref.id, ref);
    // Pending old refs reserve the thread, but cannot be used for native lookup.
    this.byNative.set(key, ref.id);
  }

  get(id: string): WorkbenchTaskRef | null { return this.byId.get(id) ?? null; }
  getByNative(ref: WorkbenchTaskRef): WorkbenchTaskRef | null {
    if (!hasNativeProjectBinding(ref)) return null;
    const id = this.byNative.get(nativeOwnerKey(ref));
    const registered = id ? this.byId.get(id) : null;
    return registered && hasNativeProjectBinding(registered) && registered.projectId === ref.projectId && nativeTaskKey(registered) === nativeTaskKey(ref)
      ? registered : null;
  }
}

/** Old forwarding receipts remain in their original system. This creates only a read-only reference. */
export function legacyForwardReference(receipt: ForwardRequest, dshProfileId?: string): WorkbenchTaskRef | null {
  const projectId = receipt.project?.id;
  if (!projectId) return null;
  if (receipt.executor === 'harness') {
    if (!receipt.harnessSessionId || !dshProfileId) return null;
    return { id: `legacy-forward:${receipt.id}`, projectId, provider: 'dsh', origin: 'legacy_dsh',
      profileId: dshProfileId, nativeSessionId: receipt.harnessSessionId };
  }
  if (!receipt.target?.hostId || !receipt.target.threadId) return null;
  return { id: `legacy-forward:${receipt.id}`, projectId, provider: 'codex', origin: 'legacy_codex_app',
    hostId: receipt.target.hostId, nativeSessionId: receipt.target.threadId };
}
