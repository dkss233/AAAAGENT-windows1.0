export interface NativeSubmissionIdentity {
  readonly environmentId: string;
  readonly threadId: string;
  readonly commandId: string;
}
export const nativeSubmissionChanged = "aaa-native-submission-changed";
const key = (identity: Pick<NativeSubmissionIdentity, "environmentId" | "threadId">) =>
  `aaa-native-submission:${JSON.stringify([identity.environmentId, identity.threadId])}`;
const notify = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(nativeSubmissionChanged)); };

/** Only an unresolved command identity is retained, never its prompt or attachments. */
export function readNativeSubmission(environmentId: string, threadId: string, storage: Storage = localStorage): NativeSubmissionIdentity | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(key({ environmentId, threadId })) ?? "null");
    if (!value || typeof value !== "object") return null;
    const identity = value as NativeSubmissionIdentity;
    return identity.environmentId === environmentId && identity.threadId === threadId &&
      typeof identity.commandId === "string" && identity.commandId.trim().length > 0 ? identity : null;
  } catch { return null; }
}

export function rememberNativeSubmission(identity: NativeSubmissionIdentity, storage: Storage = localStorage): boolean {
  try {
    if (storage.getItem(key(identity)) !== null) return false;
    storage.setItem(key(identity), JSON.stringify(identity));
    notify();
    return true;
  } catch { return false; }
}

export function clearNativeSubmission(identity: NativeSubmissionIdentity, storage: Storage = localStorage): void {
  if (readNativeSubmission(identity.environmentId, identity.threadId, storage)?.commandId !== identity.commandId) return;
  try { storage.removeItem(key(identity)); notify(); } catch { /* Keep the unresolved identity when storage is unavailable. */ }
}
