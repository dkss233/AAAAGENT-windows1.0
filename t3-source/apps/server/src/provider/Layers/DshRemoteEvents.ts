// @effect-diagnostics globalTimers:off -- Native WS connection deadlines, not provider task scheduling.
// Fixed DSH 0.2.0-rc.2 Gateway $events carrier. No browser or second task queue.
import { NodeWS } from "@effect/platform-node/NodeSocket";
const WebSocket = NodeWS.WebSocket;
import { randomUUID } from "node:crypto";

export interface DshRemoteEvent {
  readonly clientId: string;
  readonly eventId: string;
  readonly agentId: string;
  readonly event: "approval/request" | "user-questions/request";
  readonly request: Record<string, unknown>;
  submitted: boolean;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;

/** One live connection for this original Host. Disconnect revokes every answer;
 * reconnect reads pending native events but never repeats an earlier decision.
 */
export class DshRemoteEvents {
  private readonly owned = new Set<string>();
  private readonly hostListeners = new Set<(type: string, args: readonly unknown[]) => void>();
  async watchHost(changed: (type: string, args: readonly unknown[]) => void): Promise<() => void> {
    this.hostListeners.add(changed); try { await this.ensure(); } catch (error) { this.hostListeners.delete(changed); throw error; }
    return () => { this.hostListeners.delete(changed); if (!this.alive() && !this.hostListeners.size) this.close(); };
  }
  private alive(): boolean { return this.owned.size > 0 || this.hostListeners.size > 0; }

  private readonly listeners = new Map<string, Set<() => void>>();
  subscribe(sessionId: string, changed: () => void): () => void { const listeners = this.listeners.get(sessionId) ?? new Set(); this.listeners.set(sessionId, listeners); listeners.add(changed); return () => { listeners.delete(changed); if (!listeners.size) this.listeners.delete(sessionId); }; }
  private notify(sessionId: string): void { for (const changed of this.listeners.get(sessionId) ?? []) changed(); }
  private readonly submitted = new Set<string>();
  private readonly pending = new Map<string, DshRemoteEvent>();
  private socket: InstanceType<typeof WebSocket> | null = null;
  private connecting: Promise<void> | null = null;
  private clientId: string | null = null;
  private generation = 0;
  private readonly authenticate: () => Promise<{ origin: string; cookie: string }>;
  private readonly result: (args: object) => Promise<unknown>;
  constructor(authenticate: () => Promise<{ origin: string; cookie: string }>, result: (args: object) => Promise<unknown>) {
    this.authenticate = authenticate; this.result = result;
  }

  async retain(sessionId: string): Promise<void> {
    this.owned.add(sessionId);
    try { await this.ensure(); } catch (error) { this.owned.delete(sessionId); throw error; }
  }
  release(sessionId: string): void {
    this.owned.delete(sessionId);
    for (const [key, frame] of this.pending) if (frame.agentId === sessionId) this.pending.delete(key);
    if (!this.alive()) this.close();
  }
  close(): void {
    this.generation++;
    const socket = this.socket; this.socket = null; this.clientId = null; this.pending.clear();
    // Closing delivery leaves the original native request for another client.
    socket?.close();
  }
  list(sessionId: string): readonly DshRemoteEvent[] {
    if (!this.owned.has(sessionId) || !this.clientId || this.socket?.readyState !== WebSocket.OPEN) return [];
    return [...this.pending.values()].filter(frame => frame.agentId === sessionId && frame.clientId === this.clientId);
  }
  async refreshHost(): Promise<void> { if (!this.hostListeners.size) throw Error("dsh_request_expired"); await this.ensure(); }
  async refresh(sessionId: string): Promise<void> {
    if (!this.owned.has(sessionId)) throw Error("dsh_request_expired");
    await this.ensure();
  }
  async answer(frame: DshRemoteEvent, value: unknown): Promise<void> {
    if (this.pending.get(frame.eventId) !== frame || frame.submitted ||
        frame.clientId !== this.clientId || this.socket?.readyState !== WebSocket.OPEN || !this.owned.has(frame.agentId))
      throw Error("dsh_request_expired");
    frame.submitted = true; this.submitted.add(frame.eventId); // An ambiguous result must never repeat this authorization.
    await this.result({ clientId: frame.clientId, eventId: frame.eventId, outcome: { kind: "result", value } });
    // HTTP ok can be a no-op. Only original session audit/projection confirms it.
  }
  private async ensure(): Promise<void> {
    if (this.clientId && this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connect();
    try { await this.connecting; } finally { this.connecting = null; }
  }
  private async connect(): Promise<void> {
    const generation = this.generation;
    const { origin, cookie } = await this.authenticate();
    if (generation !== this.generation || !this.alive()) throw Error("dsh_request_expired");
    const streamId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(origin.replace(/^http:/, "ws:") + "/api/remote.mux", {
        headers: { Cookie: cookie, Origin: origin }, maxPayload: 1024 * 1024, handshakeTimeout: 5000,
      });
      this.socket = socket; this.clientId = null; this.pending.clear();
      let ready = false;
      const timer = setTimeout(() => { socket.close(); reject(Error("dsh_events_unavailable")); }, 5000);
      const revoke = () => {
        clearTimeout(timer);
        if (this.socket === socket) { this.socket = null; this.clientId = null; this.pending.clear(); }
        if (!ready) reject(Error("dsh_events_unavailable"));
      };
      socket.on("error", revoke); socket.on("close", revoke);
      socket.on("open", () => {
        if (generation !== this.generation || !this.alive()) { socket.close(); revoke(); return; }
        socket.send(JSON.stringify({ type: "open", streamId, endpoint: "$events", payload: { args: {} } }));
      });
      socket.on("message", (bytes, binary) => {
        try {
          if (binary || this.socket !== socket || generation !== this.generation || !this.alive()) throw Error("dsh_events_invalid");
          const frame = object(JSON.parse(bytes.toString()));
          if (frame?.streamId !== streamId || frame.type !== "item") throw Error("dsh_events_invalid");
          const value = object(frame.value);
          if (!value) throw Error("dsh_events_invalid");
          if (value.type === "ready" && id(value.clientId) && !ready) {
            this.clientId = value.clientId; ready = true; clearTimeout(timer); for (const id of this.owned) this.notify(id); for (const listener of this.hostListeners) listener("ready", []); resolve(); return;
          }
          if (!ready || !this.clientId) throw Error("dsh_events_invalid");
          if (value.type === "cancel" && id(value.eventId)) { const old = this.pending.get(value.eventId); this.pending.delete(value.eventId); if (old) this.notify(old.agentId); return; }
          if (value.type === "emit") {
            if (typeof value.event !== "string" || !Array.isArray(value.args)) throw Error("dsh_events_invalid");
            for (const listener of this.hostListeners) listener(value.event, value.args);
            if (typeof value.args[0] === "string") this.notify(value.args[0]); return;
          }
          const request = object(value.request);
          if (value.type !== "waterfall" || !id(value.eventId) || !id(value.agentId) || !id(value.event) || !request)
            throw Error("dsh_events_invalid");
          if (!this.owned.has(value.agentId) || !["approval/request", "user-questions/request"].includes(value.event)) {
            // The SDK default listener declines to handle unrelated waterfalls.
            void this.result({ clientId: this.clientId, eventId: value.eventId, outcome: { kind: "next" } }).catch(() => socket.close());
            return;
          }
          if (this.pending.size >= 128 || this.pending.has(value.eventId)) throw Error("dsh_events_invalid");
          this.pending.set(value.eventId, { clientId: this.clientId, eventId: value.eventId,
            agentId: value.agentId, event: value.event as DshRemoteEvent["event"], request, submitted: this.submitted.has(value.eventId) });
          this.notify(value.agentId);
        } catch { socket.close(); revoke(); }
      });
    });
  }
}
