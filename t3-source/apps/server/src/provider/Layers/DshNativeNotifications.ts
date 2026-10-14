// @effect-diagnostics nodeBuiltinImport:off -- Filesystem subscriptions belong to this imperative original-source transport.
// @effect-diagnostics globalTimers:off -- Filesystem event coalescing and disconnected-carrier backoff only.
import { watch, existsSync, realpathSync, readdirSync, lstatSync, type FSWatcher } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { NodeWS } from "@effect/platform-node/NodeSocket";
const WebSocket = NodeWS.WebSocket;
const object = (value: unknown): Record<string, any> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
const nativeId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const seq = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= -1;

/** Notification cursor is separate from the durable history checkpoint. Opening snapshots repair gaps. */
export class DshFollowCursor {
  private next: number | null = null;
  private maximum = -1;
  readonly sessionId: string;
  readonly cwd: string;
  constructor(sessionId: string, cwd: string) { this.sessionId = sessionId; this.cwd = cwd; }
  accept(value: unknown): boolean {
    const frame = object(value); if (!frame) throw Error("Invalid original DSH follow frame");
    if (frame.type === "snapshot") {
      if (this.next !== null || frame.header?.id !== this.sessionId || frame.header?.cwd !== this.cwd ||
          frame.header?.parentSession != null || frame.header?.origin === "subagent" || !seq(frame.cursor) || frame.cursor < this.maximum)
        throw Error("Original DSH follow scope changed");
      this.next = frame.cursor + 1; const changed = frame.cursor > this.maximum; this.maximum = frame.cursor; return changed;
    }
    if (this.next === null || frame.type !== "event" || !seq(frame.event?.seq)) throw Error("Original DSH follow opening unavailable");
    const cursor = frame.event.seq;
    if (cursor < this.next) return false;
    if (cursor !== this.next) throw Error("Original DSH follow sequence gap");
    this.next++; this.maximum = cursor; return true;
  }
  reconnect(): void { this.next = null; }
}
interface Entry { cwd: string; listeners: Set<() => void>; ownedFollowers: number; cursor: DshFollowCursor; files: Map<string, string>; filesInitialized: boolean }
const historyFiles = ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd"];

/** Cold native history uses file notifications and control; follow is limited to an already-live owned turn. */
export class DshNativeNotifications {
  private readonly entries = new Map<string, Entry>();
  private readonly streams = new Map<string, { sessionId?: string; control?: true }>();
  private readonly projections = new Map<string, string>();
  private socket: InstanceType<typeof WebSocket> | null = null;
  private fileWatch: FSWatcher | undefined;
  private connecting: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private burst: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Set<string>();
  private generation = 0;
  private retryMs = 1000;
  private closed = false;
  private readonly authenticate: () => Promise<{ origin: string; cookie: string }>;
  private readonly home: string | undefined;
  constructor(authenticate: () => Promise<{ origin: string; cookie: string }>, home?: string) { this.authenticate = authenticate; this.home = home; }
  async watch(sessionId: string, cwd: string, changed: () => void, ownedFollow = false): Promise<() => void> {
    if (this.closed || !nativeId(sessionId) || !isAbsolute(cwd)) throw Error("Original DSH watch scope unavailable");
    let entry = this.entries.get(sessionId);
    if (entry && entry.cwd !== cwd) throw Error("Original DSH watch workspace conflict");
    if (!entry) { entry = { cwd, listeners: new Set(), ownedFollowers: 0, cursor: new DshFollowCursor(sessionId, cwd), files: new Map(), filesInitialized: false }; this.entries.set(sessionId, entry); }
    entry.listeners.add(changed); if (ownedFollow) entry.ownedFollowers++;
    try { this.ensureFiles(sessionId, entry); }
    catch (error) { entry.listeners.delete(changed); if (ownedFollow) entry.ownedFollowers--; if (!entry.listeners.size) this.entries.delete(sessionId); if (!this.entries.size) this.release(); throw error; }
    // A temporary carrier/authentication outage keeps the exact file subscription alive.
    await this.ensure().catch(() => this.reconnectLater()); this.openFollow(sessionId, entry);
    let disposed = false;
    return () => {
      if (disposed) return; disposed = true; entry!.listeners.delete(changed); if (ownedFollow) entry!.ownedFollowers--;
      if (!entry!.ownedFollowers) for (const [streamId, stream] of this.streams) if (stream.sessionId === sessionId) { this.send({ type: "cancel", streamId }); this.streams.delete(streamId); }
      if (!entry!.listeners.size) { this.entries.delete(sessionId); for (const [streamId, stream] of this.streams) if (stream.sessionId === sessionId) { this.send({ type: "cancel", streamId }); this.streams.delete(streamId); } }
      if (!this.entries.size) this.release();
    };
  }
  close(): void { this.closed = true; this.entries.clear(); this.release(); }
  private fileSignature(file: string): string {
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== file) return "unavailable";
      return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    } catch { return "unavailable"; }
  }
  private refreshFiles(id: string, workspace?: string): void {
    const entry = this.entries.get(id); if (!entry || !this.home) return;
    if (workspace) for (const name of historyFiles) {
      const file = join(this.home, "sessions", workspace, id, name);
      if (!entry.files.has(file)) entry.files.set(file, "unavailable");
    }
    let changed = false;
    for (const [file, prior] of entry.files) {
      const next = this.fileSignature(file);
      if (next !== prior) { entry.files.set(file, next); changed = true; }
    }
    if (changed) this.schedule(id);
  }
  private ensureFiles(id: string, entry: Entry): void {
    if (!this.home) return;
    if (!isAbsolute(this.home) || realpathSync(this.home) !== resolve(this.home)) throw Error("Original DSH data home unavailable");
    const directory = join(this.home, "sessions"); if (!existsSync(directory)) throw Error("Original DSH history directory unavailable");
    if (!this.fileWatch) {
      this.fileWatch = watch(directory, { recursive: true }, (_kind, name) => {
        if (name === null) { for (const key of this.entries.keys()) this.refreshFiles(key); return; }
        const parts = String(name).split(/[\\/]/);
        if (parts.some(part => !part || part === "." || part === "..") || parts.length < 2) return;
        if (parts.length === 2 || (parts.length === 3 && historyFiles.includes(parts[2]!))) this.refreshFiles(parts[1]!, parts[0]);
      });
      this.fileWatch.on("error", () => { for (const key of this.entries.keys()) this.schedule(key); });
    }
    if (entry.filesInitialized) return;
    // One opening metadata reconciliation; subsequent callbacks stat only the exact SID files.
    for (const folder of readdirSync(directory, { withFileTypes: true })) {
      if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
      for (const name of historyFiles) {
        const file = join(directory, folder.name, id, name); entry.files.set(file, this.fileSignature(file));
      }
    }
    entry.filesInitialized = true;
  }
  private schedule(id: string): void {
    this.pending.add(id); if (this.burst !== undefined) return;
    this.burst = setTimeout(() => { this.burst = undefined; const ids = [...this.pending]; this.pending.clear(); for (const id of ids) this.notify(id); }, 60); this.burst.unref();
  }
  private notify(id: string): void { for (const listener of this.entries.get(id)?.listeners ?? []) listener(); }
  private send(value: object): void { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(value)); }
  private reconnectLater(): void {
    if (!this.entries.size || this.closed || this.retry !== undefined) return;
    const generation = this.generation, delay = this.retryMs; this.retryMs = Math.min(30000, delay * 2);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (generation === this.generation) void this.ensure().catch(() => this.reconnectLater());
    }, delay); this.retry.unref();
  }
  private openFollow(id: string, entry: Entry): void {
    if (!entry.ownedFollowers || this.socket?.readyState !== WebSocket.OPEN || [...this.streams.values()].some(s => s.sessionId === id)) return;
    const streamId = randomUUID(); this.streams.set(streamId, { sessionId: id }); entry.cursor.reconnect();
    this.send({ type: "open", streamId, endpoint: "session/follow", payload: { args: { request: { address: { kind: "session", sessionId: id }, maxMessages: 1 } } } });
  }
  private async ensure(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect(); try { await this.connecting; } finally { this.connecting = undefined; }
  }
  private async connect(): Promise<void> {
    const generation = this.generation, auth = await this.authenticate();
    if (generation !== this.generation || !this.entries.size) throw Error("Original DSH watch expired");
    await new Promise<void>((ready, reject) => {
      const socket = new WebSocket(auth.origin.replace(/^http:/, "ws:") + "/api/remote.mux", {
        headers: { Cookie: auth.cookie, Origin: auth.origin }, maxPayload: 4 * 1024 * 1024, handshakeTimeout: 5000,
      });
      this.socket = socket; this.streams.clear(); let opened = false, revoked = false;
      const deadline = setTimeout(() => { socket.close(); reject(Error("Original DSH control opening unavailable")); }, 5000);
      const revoke = () => {
        if (revoked) return; revoked = true; clearTimeout(deadline);
        if (this.socket === socket) { this.socket = null; this.streams.clear(); }
        if (!opened) reject(Error("Original DSH event carrier unavailable"));
        if (generation === this.generation && this.entries.size && !this.closed && this.retry === undefined) {
          for (const id of this.entries.keys()) this.notify(id);
          this.reconnectLater();
        }
      };
      socket.on("error", revoke); socket.on("close", revoke);
      socket.on("open", () => {
        if (generation !== this.generation || !this.entries.size) { socket.close(); return; }
        const streamId = randomUUID(); this.streams.set(streamId, { control: true });
        this.send({ type: "open", streamId, endpoint: "session/control", payload: { args: {} } });
      });
      socket.on("message", (bytes, binary) => {
        try {
          if (binary || this.socket !== socket || generation !== this.generation) throw Error("Invalid original DSH carrier");
          const frame = object(JSON.parse(bytes.toString())), stream = this.streams.get(frame?.streamId);
          if (!stream) return;
          if (frame?.type !== "item") throw Error("Original DSH event stream ended");
          const value = object(frame.value); if (!value) throw Error("Invalid original DSH notification");
          if (stream.control) {
            if (value.type === "baseline" && !opened && object(value.value?.projections)) {
              opened = true; this.retryMs = 1000; clearTimeout(deadline);
              for (const [id, entry] of this.entries) { this.notify(id); this.openFollow(id, entry); }
              ready(); return;
            }
            if (!opened || value.type !== "projection" || !nativeId(value.sessionId) || !seq(value.seq) || typeof value.key !== "string") throw Error("Invalid original DSH control frame");
            const key = JSON.stringify([value.sessionId, value.key]), signature = JSON.stringify([value.seq, value.value]);
            if (this.projections.get(key) !== signature) { this.projections.set(key, signature); this.schedule(value.sessionId); }
          } else if (stream.sessionId && this.entries.get(stream.sessionId)?.cursor.accept(value)) this.schedule(stream.sessionId);
        } catch { socket.close(); revoke(); }
      });
    });
  }
  private release(): void {
    this.generation++; const socket = this.socket; this.socket = null; socket?.close(); this.streams.clear(); this.projections.clear();
    this.fileWatch?.close(); this.fileWatch = undefined;
    if (this.retry !== undefined) clearTimeout(this.retry); this.retry = undefined;
    if (this.burst !== undefined) clearTimeout(this.burst); this.burst = undefined; this.pending.clear();
  }
}
