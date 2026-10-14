/** A dirty identity is retained while its read is in flight. There is no timer or idle read. */
export class NativeRealtimeQueue<Key> {
  private readonly dirty = new Set<Key>();
  private wake: (() => void) | undefined;
  private closed = false;
  mark(key: Key): void {
    if (this.closed) return;
    this.dirty.add(key);
    this.wake?.();
  }
  async take(signal?: AbortSignal): Promise<Key | undefined> {
    while (!this.closed && !signal?.aborted) {
      const key = this.dirty.values().next();
      if (!key.done) { this.dirty.delete(key.value); return key.value; }
      await new Promise<void>((resolve) => {
        const finish = () => { signal?.removeEventListener("abort", finish); if (this.wake === finish) this.wake = undefined; resolve(); };
        this.wake = finish;
        signal?.addEventListener("abort", finish, { once: true });
        if (this.closed || signal?.aborted || this.dirty.size) finish();
      });
    }
    return undefined;
  }
  close(): void { this.closed = true; this.dirty.clear(); this.wake?.(); }
}
