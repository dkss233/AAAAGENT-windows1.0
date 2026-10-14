// @effect-diagnostics nodeBuiltinImport:off -- Filesystem subscriptions belong to this imperative original-source transport.
// @effect-diagnostics globalTimers:off -- One event burst is coalesced; there is no periodic scan.
import { watch, existsSync, lstatSync, realpathSync, type FSWatcher } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CodexNativeWatchInput { readonly threadId: string; readonly cwd: string }
interface Entry { input: CodexNativeWatchInput; listeners: Set<() => void>; file: string | null; signature: string | null }
const id = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** One configured original home, one filesystem subscription, exact indexed SID queries. */
export class CodexNativeNotifications {
  private readonly entries = new Map<string, Entry>();
  private readonly watchers: FSWatcher[] = [];
  private readonly pending = new Set<string>();
  private readonly indexes = new Map<string, { identity: string; watcher: FSWatcher }>();
  private databaseIdentity: string | undefined;
  private burst: ReturnType<typeof setTimeout> | undefined;
  private database: DatabaseSync | undefined;
  private disposed = false;
  readonly home: string;
  constructor(home: string) {
    if (!isAbsolute(home) || realpathSync(home) !== resolve(home)) throw Error("Original Codex home identity unavailable");
    this.home = resolve(home);
  }
  watch(input: CodexNativeWatchInput, changed: () => void): () => void {
    if (this.disposed || !id(input.threadId) || !isAbsolute(input.cwd)) throw Error("Original Codex watch scope unavailable");
    let entry = this.entries.get(input.threadId);
    if (entry && entry.input.cwd !== input.cwd) throw Error("Original Codex watch workspace conflict");
    if (!entry) {
      entry = { input, listeners: new Set(), file: null, signature: null };
      this.entries.set(input.threadId, entry);
      try { this.ensure(); this.refresh(input.threadId, false); }
      catch (error) { this.entries.delete(input.threadId); if (!this.entries.size) this.release(); throw error; }
    }
    entry.listeners.add(changed);
    let closed = false;
    return () => { if (closed) return; closed = true; entry!.listeners.delete(changed); if (!entry!.listeners.size) this.entries.delete(input.threadId); if (!this.entries.size) this.release(); };
  }
  close(): void { this.disposed = true; this.entries.clear(); this.release(); }
  private ensure(): void {
    if (this.watchers.length) return;
    const databaseFile = join(this.home, "state_5.sqlite");
    const stat = lstatSync(databaseFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Original Codex index unavailable");
    this.openDatabase(); this.watchIndexes();
    const root = watch(this.home, (_kind, name) => {
      if (name === null || /^state_5\.sqlite(?:-wal|-shm)?$/.test(String(name))) {
        this.watchIndexes(); for (const key of this.entries.keys()) this.schedule(key);
      }
    });
    root.on("error", () => { for (const entry of this.entries.values()) for (const listener of entry.listeners) listener(); });
    this.watchers.push(root);
    for (const folder of ["sessions", "archived_sessions"]) {
      const path = join(this.home, folder); if (!existsSync(path)) continue;
      const watcher = watch(path, { recursive: true }, (_kind, name) => {
        if (name === null) { for (const key of this.entries.keys()) this.schedule(key); return; }
        const file = resolve(path, String(name));
        for (const [key, entry] of this.entries) if (file === entry.file || String(name).includes(key)) this.schedule(key);
      });
      watcher.on("error", () => { for (const entry of this.entries.values()) for (const listener of entry.listeners) listener(); });
      this.watchers.push(watcher);
    }
  }
  private openDatabase(): void {
    const file = join(this.home, "state_5.sqlite"), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Original Codex index unavailable");
    const identity = JSON.stringify([stat.dev, stat.ino]);
    if (this.database && this.databaseIdentity === identity) return;
    this.database?.close(); this.database = new DatabaseSync(file, { readOnly: true }); this.databaseIdentity = identity;
  }
  private watchIndexes(): void {
    for (const name of ["state_5.sqlite", "state_5.sqlite-wal"]) {
      const path = join(this.home, name);
      try {
        const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const identity = JSON.stringify([stat.dev, stat.ino]), current = this.indexes.get(name);
        if (current?.identity === identity) continue;
        current?.watcher.close();
        const watcher = watch(path, () => { for (const key of this.entries.keys()) this.schedule(key); });
        watcher.on("error", () => { watcher.close(); this.indexes.delete(name); });
        this.indexes.set(name, { identity, watcher });
      } catch { /* New WAL files are attached when the home directory reports their creation. */ }
    }
  }
  private schedule(key: string): void {
    this.pending.add(key);
    if (this.burst !== undefined) return;
    this.burst = setTimeout(() => { this.burst = undefined; const batch = [...this.pending]; this.pending.clear(); for (const id of batch) this.refresh(id, true); }, 60);
    this.burst.unref();
  }
  private refresh(key: string, emit: boolean): void {
    const entry = this.entries.get(key); if (!entry) return;
    let signature = "unavailable", file: string | null = null;
    try {
      this.openDatabase();
      const row = this.database!.prepare("SELECT id,cwd,rollout_path,archived FROM threads WHERE id=?").get(key);
      if (!row || row.id !== key || row.cwd !== entry.input.cwd || row.archived !== 0 || typeof row.rollout_path !== "string") throw Error("Original Codex index scope changed");
      const selected = resolve(row.rollout_path), part = relative(this.home, selected);
      if (part.startsWith("../") || isAbsolute(part) || !/^(sessions|archived_sessions)\//.test(part) || realpathSync(selected) !== selected) throw Error("Original Codex rollout scope changed");
      const stat = lstatSync(selected);
      if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Original Codex rollout unavailable");
      file = selected; signature = JSON.stringify([selected, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    } catch { /* A transient/missing original never advances a history checkpoint. */ }
    entry.file = file;
    if (signature === entry.signature) return;
    entry.signature = signature;
    if (emit) for (const listener of entry.listeners) listener();
  }
  private release(): void {
    for (const watcher of this.watchers.splice(0)) watcher.close();
    for (const { watcher } of this.indexes.values()) watcher.close(); this.indexes.clear();
    if (this.burst !== undefined) clearTimeout(this.burst);
    this.burst = undefined; this.pending.clear(); this.database?.close(); this.database = undefined; this.databaseIdentity = undefined;
  }
}
