// @effect-diagnostics globalTimers:off cryptoRandomUUID:off -- This bounded native HTTP client owns its deadline and wire request IDs.
import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { isAbsolute } from "node:path";
import type { DshHostPort, DshTurnObservation } from "./DshAdapter.ts";
import { readDshHistoryChunk } from "./DshNativeHistory.ts";
import { discoverDshHistory } from "./DshHistoryDiscovery.ts";
import { DshNativeNotifications } from "./DshNativeNotifications.ts";
import { DshRemoteEvents } from "./DshRemoteEvents.ts";

import type { ChatAttachment, RuntimeMode } from "@t3tools/contracts";

type DshMethod = "session/projections" | "session/list" | "session/page" | "session/create" | "session/prompt" | "session/modelCatalog" | "session/selectModel" | "session/rename" | "permissionPresets/catalog" | "commands/execute" | "session/cancel" | "userQuestions/answer" | "$events/result";
export interface DshSessionRpc { call(method: DshMethod, args: object): Promise<unknown>; readonly events?: DshRemoteEvents; readonly notifications?: DshNativeNotifications; nativeSummary?(sessionId: string): Promise<unknown>; uploadFile?(sessionId: string, name: string, bytes: Uint8Array): Promise<unknown> }

export class DshTransportError extends Error {
  readonly code: "unavailable" | "authentication_required" | "incompatible";
  constructor(code: DshTransportError["code"]) { super(code); this.code = code; }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const nativeId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

/** I supplies the resolver inside the T3 server; the URL and cookie never leave this transport. */
export class HttpDshSessionRpc implements DshSessionRpc {
  private readonly resolveGatewayUrl: () => Promise<string>;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  readonly events: DshRemoteEvents;
  readonly notifications: DshNativeNotifications;
  private readonly summaries = new Map<string, SessionRow>();
  private summarySubscribed: Promise<void> | undefined;
  private closeSummary: (() => void) | undefined;
  private summaryInitialized = false;
  private summaryOpening: Promise<unknown> | undefined;
  close(): void { this.closeSummary?.(); this.events.close(); this.notifications.close(); this.summaries.clear(); }
  async nativeSummary(sessionId: string): Promise<unknown> {
    if (!nativeId(sessionId)) throw new DshTransportError("incompatible");
    this.summarySubscribed ??= this.events.watchHost((type, args) => {
      if (type === "ready") { this.summaryInitialized = false; return; }
      const first = args[0];
      if (type === "api-session/added" && record(first) && typeof record(first)!.sessionId === "string") { const row = first as SessionRow; this.summaries.set(row.sessionId, row); }
      if (typeof first !== "string" || !this.summaries.has(first)) return;
      const row = this.summaries.get(first)!;
      if (type === "api-session/status" && typeof args[1] === "boolean") this.summaries.set(first, { ...row, running: args[1], agentAvailable: true });
      if (type === "api-session/removed") this.summaries.set(first, { ...row, running: false, agentAvailable: false });
    }).then(close => { this.closeSummary = close; }).catch(error => { this.summarySubscribed = undefined; throw error; });
    await this.summarySubscribed;
    await this.events.refreshHost();
    if (!this.summaryInitialized) {
      this.summaryOpening ??= this.call("session/list", { _request: {} });
      try { await this.summaryOpening; } finally { this.summaryOpening = undefined; }
    }
    const row = this.summaries.get(sessionId); if (!row) throw new DshTransportError("incompatible");
    const projections = record(await this.call("session/projections", { request: { sessionId } }));
    if (!projections || !integer(projections.asOfSeq) || !record(projections.values)) throw new DshTransportError("incompatible");
    return { ...this.summaries.get(sessionId), projections };
  }

  constructor(resolveGatewayUrl: () => Promise<string>, fetcher: typeof fetch = fetch, timeoutMs = process.platform === "win32" ? 15000 : 5000) {
    this.resolveGatewayUrl = resolveGatewayUrl;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.events = new DshRemoteEvents(() => this.authenticate(), args => this.call("$events/result", args));
    this.notifications = new DshNativeNotifications(() => this.authenticate(), process.env.DSH_HOME);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new DshTransportError("incompatible");
  }

  private async gateway(): Promise<URL> {
    try {
      const url = new URL(await this.resolveGatewayUrl());
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" ||
          url.hash || url.username || url.password || url.searchParams.getAll("token").length !== 1 ||
          !url.searchParams.get("token") || [...url.searchParams.keys()].some(key => key !== "token")) {
        throw new DshTransportError("authentication_required");
      }
      return url;
    } catch { throw new DshTransportError("authentication_required"); }
  }

  async authenticate(signal: AbortSignal = AbortSignal.timeout(this.timeoutMs)): Promise<{ origin: string; cookie: string }> {
    try {
      const gateway = await this.gateway();
      const exchange = await this.fetcher(gateway, { redirect: "manual", signal });
      const cookie = exchange.headers.get("set-cookie")?.split(";")[0];
      await exchange.body?.cancel();
      if (exchange.status !== 303 || !["/", "./"].includes(exchange.headers.get("location") ?? "") || !cookie ||
          !/^[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(cookie)) throw new DshTransportError("authentication_required");
      return { origin: gateway.origin, cookie };
    } catch (error) { if (error instanceof DshTransportError) throw error; throw new DshTransportError("unavailable"); }
  }
  async uploadFile(sessionId: string, name: string, bytes: Uint8Array): Promise<unknown> {
    if (!nativeId(sessionId) || !name || bytes.byteLength < 1 || bytes.byteLength > 50 * 1024 * 1024)
      throw new DshTransportError("incompatible");
    try {
      const signal = AbortSignal.timeout(this.timeoutMs), { origin, cookie } = await this.authenticate(signal);
      const query = new URLSearchParams({ sessionId, name });
      const response = await this.fetcher(`${origin}/api/session/uploadFileBinary?${query}`, {
        method: "POST", redirect: "manual", signal, headers: { Cookie: cookie, Origin: origin,
          "Content-Type": "application/octet-stream" }, body: Buffer.from(bytes),
      });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 4096)
        throw new DshTransportError("unavailable");
      const reader = response.body?.getReader(); if (!reader) throw new DshTransportError("incompatible");
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength;
        if (size > 4096) { await reader.cancel(); throw new DshTransportError("incompatible"); } chunks.push(part.value); }
      const result = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (result?.ok !== true) throw new DshTransportError("incompatible");
      return result.value;
    } catch (error) { if (error instanceof DshTransportError) throw error; throw new DshTransportError("unavailable"); }
  }

  async call(method: DshMethod, args: object): Promise<unknown> {
    if (!["session/projections", "session/list", "session/page", "session/create", "session/prompt", "session/modelCatalog", "session/selectModel", "session/rename", "permissionPresets/catalog", "commands/execute", "session/cancel", "userQuestions/answer", "$events/result"].includes(method)) {
      throw new DshTransportError("incompatible");
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.timeoutMs);
    try {
      const { origin, cookie } = await this.authenticate(abort.signal);
      const rpcId = crypto.randomUUID();
      const response = await this.fetcher(`${origin}/api/${method}`, {
        method: "POST", redirect: "manual", signal: abort.signal,
        headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args } }),
      });
      if (response.status === 401 || response.status === 403) throw new DshTransportError("authentication_required");
      if (!response.ok || !response.body) throw new DshTransportError("unavailable");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw new DshTransportError("incompatible"); }
        chunks.push(part.value);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      const result = record(body);
      const payload = record(result?.result);
      if (result?.type !== "server-response" || result.rpcId !== rpcId || payload?.ok !== true) {
        throw new DshTransportError("incompatible");
      }
      if (method === "session/list") {
        const listed = record(payload.value);
        if (!Array.isArray(listed?.items)) throw new DshTransportError("incompatible");
        this.summaries.clear(); for (const candidate of listed.items) { const row = record(candidate); if (row && typeof row.sessionId === "string") this.summaries.set(row.sessionId, candidate as SessionRow); }
        this.summaryInitialized = true;
      }
      return payload.value;
    } catch (error) {
      // Native and fetch errors can contain the bearer URL or private task content.
      if (error instanceof DshTransportError) throw error;
      throw new DshTransportError("unavailable");
    } finally { clearTimeout(timer); }
  }
}

interface NativeEvent { readonly seq: number; readonly type: string; readonly data: unknown }
interface SessionRow { readonly sessionId: string; readonly running: boolean; readonly agentAvailable?: boolean; readonly cwd?: string;
  readonly parentSessionId?: string; readonly origin?: string;
  readonly projections?: { readonly asOfSeq: number; readonly values?: Record<string, unknown> } }

async function exactRow(rpc: DshSessionRpc, sessionId: string): Promise<SessionRow | undefined> {
  if (rpc.nativeSummary) return await rpc.nativeSummary(sessionId) as SessionRow;
  const rows = (await listRows(rpc)).filter(row => row.sessionId === sessionId);
  if (rows.length !== 1) throw new DshTransportError("incompatible"); return rows[0];
}
async function listRows(rpc: DshSessionRpc): Promise<SessionRow[]> {
  const value = record(await rpc.call("session/list", { _request: {} }));
  if (!Array.isArray(value?.items)) throw new DshTransportError("incompatible");
  return value.items as SessionRow[];
}

interface NativeSelection { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0;
const modelSlug = (provider: string, model: string) => `${encodeURIComponent(provider)}/${encodeURIComponent(model)}`;

async function readCatalog(rpc: DshSessionRpc) {
  const catalog = record(await rpc.call("session/modelCatalog", {}));
  if (!catalog || !Array.isArray(catalog.groups) || !Array.isArray(catalog.routableProviders) ||
      !Array.isArray(catalog.failures)) throw new DshTransportError("incompatible");
  const safe = catalog.sessionModelSelectionVersion === 1;
  const defaultSelection = record(catalog.default);
  const routes = new Map<string, { selection: NativeSelection; efforts: string[] }>();
  const models: ServerProviderModel[] = [];
  for (const rawGroup of catalog.groups) {
    const group = record(rawGroup);
    if (!nonempty(group?.id) || !nonempty(group.name) || !Array.isArray(group.models)) throw new DshTransportError("incompatible");
    if (!catalog.routableProviders.includes(group.id)) continue;
    for (const rawModel of group.models) {
      const model = record(rawModel);
      if (!nonempty(model?.id) || !nonempty(model.name)) throw new DshTransportError("incompatible");
      const slug = modelSlug(group.id, model.id), reasoning = record(model.reasoning);
      if (routes.has(slug) || model.reasoning !== undefined && (!reasoning || !Array.isArray(reasoning.efforts))) {
        throw new DshTransportError("incompatible");
      }
      const efforts: { id: string; label: string; isDefault: boolean }[] = [];
      for (const raw of (reasoning?.efforts ?? []) as unknown[]) {
        const effort = record(raw);
        if (!nonempty(effort?.id) || !nonempty(effort.name) || efforts.some(item => item.id === effort.id)) {
          throw new DshTransportError("incompatible");
        }
        efforts.push({ id: effort.id, label: effort.name, isDefault: reasoning?.defaultEffort === effort.id });
      }
      if (reasoning?.defaultEffort !== undefined && !efforts.some(effort => effort.id === reasoning.defaultEffort)) {
        throw new DshTransportError("incompatible");
      }
      routes.set(slug, { selection: { provider: group.id, model: model.id }, efforts: efforts.map(effort => effort.id) });
      models.push({ slug, name: model.name, subProvider: group.name, isCustom: false,
        isDefault: defaultSelection?.provider === group.id && defaultSelection.model === model.id,
        capabilities: { optionDescriptors: efforts.length ? [{ id: "reasoningEffort", label: "Reasoning effort",
          type: "select", options: efforts,
          ...(nonempty(reasoning?.defaultEffort) ? { currentValue: reasoning.defaultEffort } : {}) }] : [] } });
    }
  }
  return { safe, routes, models };
}

/** Native catalog capability must survive both wire schemas before any scoped selection. */
export function makeDshHostProtocol(rpc: DshSessionRpc, options: { attachmentsDir?: string } = {}): DshHostPort {
  return {
    ...(options.attachmentsDir ? { attachmentsDir: options.attachmentsDir } : {}),
    discoverHistory: () => { if (!process.env.DSH_HOME) throw new DshTransportError("incompatible"); return discoverDshHistory(rpc, process.env.DSH_HOME); },
    watchHistory: async (sessionId, cwd, changed) => {
      if (!rpc.notifications) throw new DshTransportError("incompatible");
      const matches = (await listRows(rpc)).filter(row => row.sessionId === sessionId);
      if (matches.length !== 1 || matches[0]?.cwd !== cwd || matches[0]?.parentSessionId || matches[0]?.origin === "subagent") throw new DshTransportError("incompatible");
      const close = await rpc.notifications.watch(sessionId, cwd, changed); // No cold-session follow/promotion.
      const closeRequests = rpc.events?.subscribe(sessionId, changed);
      return () => { close(); closeRequests?.(); };
    },
    watchTurn: async (sessionId, cwd, changed) => {
      if (!rpc.notifications) throw new DshTransportError("incompatible");
      const matches = (await listRows(rpc)).filter(row => row.sessionId === sessionId);
      if (matches.length !== 1 || matches[0]?.cwd !== cwd || matches[0]?.parentSessionId || matches[0]?.origin === "subagent") throw new DshTransportError("incompatible");
      const close = await rpc.notifications.watch(sessionId, cwd, changed, matches[0]?.agentAvailable === true);
      const closeRequests = rpc.events?.subscribe(sessionId, changed);
      return () => { close(); closeRequests?.(); };
    },
    retain: async sessionId => { if (!rpc.events) throw new DshTransportError("incompatible"); await rpc.events.retain(sessionId); },
    release: sessionId => rpc.events?.release(sessionId),
    permission: async (sessionId: string, mode: RuntimeMode) => {
      if (!nativeId(sessionId)) throw new DshTransportError("incompatible");
      const preset = mode === "approval-required" ? "read-only" : mode === "auto-accept-edits" ? "workspace-write" : mode === "full-access" ? "danger-full-access" : null;
      const catalog = record(await rpc.call("permissionPresets/catalog", {}));
      if (!preset || !Array.isArray(catalog?.options) || !catalog.options.some(option => record(option)?.value === preset))
        throw new DshTransportError("incompatible");
      const rows = (await listRows(rpc)).filter(row => row.sessionId === sessionId);
      if (rows.length !== 1) throw new DshTransportError("incompatible");
      if (record(rows[0]?.projections?.values?.permissions)?.currentValue !== preset) {
        const executed = record(await rpc.call("commands/execute", { agentId: sessionId, line: `/permission ${preset}`, submittedAttachments: [] }));
        if (record(executed?.result)?.kind !== "success") throw new DshTransportError("incompatible");
      }
      const current = (await listRows(rpc)).filter(row => row.sessionId === sessionId);
      if (current.length !== 1 || record(current[0]?.projections?.values?.permissions)?.currentValue !== preset)
        throw new DshTransportError("incompatible");
      const knobs = await readPermissionKnobs(rpc, sessionId, current[0]!.projections!.asOfSeq);
      if (knobs.sandbox !== preset || knobs.approval !== (preset === "danger-full-access" ? "never" : "ask"))
        throw new DshTransportError("incompatible");
    },
    interrupt: async (sessionId, requestId) => {
      const observed = await readExactPrompt(rpc, sessionId, requestId);
      if (!["running", "waiting_approval", "waiting_answer"].includes(observed.status) || observed.nativeTurn === undefined)
        throw new DshTransportError("incompatible");
      const response = record(await rpc.call("session/cancel", { request: { sessionId } }));
      if (response?.accepted !== true) throw new DshTransportError("incompatible");
    },
    readHistory: (sessionId, cwd, preset, checkpoint) => readDshHistoryChunk(rpc, sessionId, cwd, preset, checkpoint),
    describe: async () => {
      await listRows(rpc);
      const catalog = await readCatalog(rpc);
      return { installed: true, authenticated: true, version: null, models: catalog.safe ? catalog.models : [] };
    },
    hasSession: async (sessionId, cwd, preset) => {
      if (!nativeId(sessionId) || !isAbsolute(cwd)) throw new DshTransportError("incompatible");
      const matches = (await listRows(rpc)).filter(row => row.sessionId === sessionId);
      if (matches.length === 0) return false;
      if (matches.length !== 1 || matches[0]?.cwd !== cwd || matches[0]?.projections?.values?.agentPreset !== preset ||
          matches[0]?.parentSessionId || matches[0]?.origin === "subagent") throw new DshTransportError("incompatible");
      return true;
    },
    create: async (sessionId, cwd, preset) => {
      if (!nativeId(sessionId) || !isAbsolute(cwd) || /[\0\r\n]/.test(cwd) || !preset.trim()) {
        throw new DshTransportError("incompatible");
      }
      const value = record(await rpc.call("session/create", { request: { sessionId, cwd, agentPreset: preset } }));
      if (value?.sessionId !== sessionId || value.agentPreset !== preset) throw new DshTransportError("incompatible");
    },
    selectModel: async (sessionId: string, requested: ModelSelection) => {
      if (!nativeId(sessionId)) throw new DshTransportError("incompatible");
      const catalog = await readCatalog(rpc), route = catalog.routes.get(requested.model);
      if (!catalog.safe || !route) throw new DshTransportError("incompatible");
      const options = requested.options ?? [];
      if (route.efforts.length ? (options.length !== 1 || options[0]?.id !== "reasoningEffort" ||
          typeof options[0].value !== "string" || !route.efforts.includes(options[0].value)) : options.length !== 0) {
        throw new DshTransportError("incompatible");
      }
      const selection = { ...route.selection, ...(options[0] ? { reasoningEffort: String(options[0].value) } : {}) };
      const value = record(await rpc.call("session/selectModel", { request: { sessionId, ...selection, scope: "session" } }));
      const selected = record(value?.selected);
      if (value?.scope !== "session" || selected?.provider !== selection.provider || selected.model !== selection.model ||
          selected.reasoningEffort !== selection.reasoningEffort) throw new DshTransportError("incompatible");
    },
    pinTitle: async (sessionId) => {
      if (!nativeId(sessionId)) throw new DshTransportError("incompatible");
      const rows = (await listRows(rpc)).filter(row => row.sessionId === sessionId);
      if (rows.length !== 1) throw new DshTransportError("incompatible");
      // Preserve a title already set in the original Host; new blank tasks receive a pinned title.
      if (nonempty(rows[0]?.projections?.values?.title)) return;
      const title = `T3 ${sessionId}`;
      const value = record(await rpc.call("session/rename", { request: { sessionId, title } }));
      if (value?.title !== title || !integer(value.seq)) throw new DshTransportError("incompatible");
    },
    prompt: async (sessionId, requestId, text, files = []) => {
      if (!nativeId(sessionId) || !nativeId(requestId) || (!text.trim() && !files.length)) throw new DshTransportError("incompatible");
      if (rpc.events) await rpc.events.retain(sessionId);
      const content: object[] = text ? [{ type: "text", text }] : [];
      for (const { attachment, bytes } of files) {
        if (attachment.type === "image") {
          if (!["image/png","image/jpeg","image/webp","image/gif"].includes(attachment.mimeType)) throw new DshTransportError("incompatible");
          content.push({ type: "image", mediaType: attachment.mimeType, data: bytes.toString("base64"), name: attachment.name });
        } else if (attachment.type === "file") {
          if (!rpc.uploadFile) throw new DshTransportError("incompatible");
          const uploaded = record(await rpc.uploadFile(sessionId, attachment.name, bytes)), file = record(uploaded?.file);
          if (!nonempty(uploaded?.receiptId) || file?.bytes !== bytes.byteLength || !nonempty(file?.attachmentId))
            throw new DshTransportError("incompatible");
          content.push({ type: "file", receiptId: uploaded.receiptId });
        } else throw new DshTransportError("incompatible");
      }
      const value = record(await rpc.call("session/prompt", { request: { sessionId, requestId, mode: "queue", content } }));
      if (value?.accepted !== true) throw new DshTransportError("incompatible");
    },
    approve: async (sessionId, requestId, auditId, decision) => {
      if (!["accept", "decline", "cancel"].includes(decision) || !rpc.events) throw new DshTransportError("incompatible");
      const before = await readExactPrompt(rpc, sessionId, requestId);
      const allApprovals = [before, ...(before.followUps ?? [])].flatMap(turn => turn.approvals ?? []);
      const audits = allApprovals.filter(item => item.id === auditId), audit = audits[0];
      if (audits.length !== 1 || !audit || audit.outcome) throw new DshTransportError("incompatible");
      const matches = rpc.events.list(sessionId).filter(frame => frame.event === "approval/request" &&
        frame.request.toolName === audit.toolName && frame.request.callId === audit.callId && frame.request.reason === audit.reason);
      const duplicate = allApprovals.filter(item => !item.outcome && item.toolName === audit.toolName &&
        item.callId === audit.callId && item.reason === audit.reason);
      if (matches.length !== 1 || duplicate.length !== 1 || matches[0]!.submitted) throw new DshTransportError("incompatible");
      const desired = decision === "accept" ? "allowed-once" : "rejected";
      await rpc.events.answer(matches[0]!, desired);
      // Another original client may have won. Read the exact audit, never HTTP ok/cancel alone.
      for (let attempt = 0; attempt < 10; attempt++) {
        const current = await readExactPrompt(rpc, sessionId, requestId);
        const outcome = [current, ...(current.followUps ?? [])].flatMap(turn => turn.approvals ?? []).find(item => item.id === auditId)?.outcome;
        if (outcome) { if (outcome !== desired) throw new DshTransportError("incompatible"); return; }
        await new Promise(done => setTimeout(done, 100));
      }
      throw new DshTransportError("unavailable");
    },
    answer: async (sessionId, requestId, callId, answers) => {
      const observed = await readExactPrompt(rpc, sessionId, requestId);
      const matches = [observed, ...(observed.followUps ?? [])].flatMap(turn => turn.questions ?? []).filter(item => item.callId === callId);
      const question = matches[0];
      if (matches.length !== 1 || !question) throw new DshTransportError("incompatible");
      const batch = question.questions.map(item => {
        const raw = answers[item.id];
        const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : record(raw)?.answers;
        if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new DshTransportError("incompatible");
        const labels = (item.options ?? []).map(option => option.label);
        const selected = values.filter((value: string) => labels.includes(value)), custom = values.filter((value: string) => !labels.includes(value));
        if (!item.multiSelect && selected.length > 1) throw new DshTransportError("incompatible");
        return { id: item.id, selected, ...(custom.length ? { custom: custom.join("\n") } : {}) };
      });
      if (Object.keys(answers).length !== batch.length) throw new DshTransportError("incompatible");
      if (question.state === "open") {
        if (!rpc.events) throw new DshTransportError("incompatible");
        const pending = rpc.events.list(sessionId).filter(frame => frame.event === "user-questions/request" &&
          record(frame.request.wait)?.callId === callId);
        if (pending.length !== 1) throw new DshTransportError("incompatible");
        await rpc.events.answer(pending[0]!, { answers: batch });
      } else {
        const accepted = await rpc.call("userQuestions/answer", { agentId: sessionId, callId, answer: { answers: batch } });
        if (accepted !== true) throw new DshTransportError("incompatible");
        // True is queued submission; the native projection closes only on admission.
      }
    },
    observe: async (sessionId, requestId) => {
      if (rpc.events) await rpc.events.refresh(sessionId);
      const observed = await readExactPrompt(rpc, sessionId, requestId);
      const frames = rpc.events?.list(sessionId) ?? [];
      const allApprovals = [observed, ...(observed.followUps ?? [])].flatMap(turn => turn.approvals ?? []);
      const decorate = (turn: DshTurnObservation) => turn.approvals?.map(audit => ({ ...audit,
        actionable: !audit.outcome && frames.filter(frame => frame.event === "approval/request" &&
          frame.request.toolName === audit.toolName && frame.request.callId === audit.callId && frame.request.reason === audit.reason && !frame.submitted).length === 1 &&
          allApprovals.filter(item => !item.outcome && item.toolName === audit.toolName && item.callId === audit.callId && item.reason === audit.reason).length === 1,
      }));
      const approvals = decorate(observed);
      return { ...observed, ...(approvals ? { approvals } : {}), ...(observed.followUps ? {
        followUps: observed.followUps.map(turn => ({ ...turn, approvals: decorate(turn) ?? [] })) } : {}) };
    },
  };
}

async function readExactPrompt(rpc: DshSessionRpc, sessionId: string, requestId: string): ReturnType<DshHostPort["observe"]> {
  const unknown = { status: "unknown" as const };
  if (!nativeId(sessionId) || !nativeId(requestId)) return unknown;
  try {
    const row = await exactRow(rpc, sessionId);
    if (!row) return unknown;
    const throughSeq = row.projections?.asOfSeq;
    if (typeof row.running !== "boolean" || row.parentSessionId || row.origin === "subagent" || !integer(throughSeq)) return unknown;
    const inbox = record(row.projections?.values?.inbox);
    const queued = ["next-turn", "next-step"].some(key => Array.isArray(inbox?.[key]) &&
      (inbox[key] as unknown[]).some(item => record(record(item)?.source)?.rpcId === requestId));
    const events: NativeEvent[] = [];
    let beforeSeq: number | undefined;
    let exhausted = false;
    // The frozen upper sequence and strictly decreasing cursor make this finite
    // without discarding older commands in long original sessions.
    for (;;) {
      const page = record(await rpc.call("session/page", { request: { address: { kind: "session", sessionId }, throughSeq,
        maxMessages: 6, ...(beforeSeq === undefined ? {} : { beforeSeq }) } }));
      const records = page?.records;
      if (!Array.isArray(records) || typeof page?.hasMore !== "boolean" || records.length === 0) return unknown;
      const current = records.map(item => record(record(item)?.event)).filter((item): item is Record<string, unknown> => item !== null);
      if (current.length !== records.length || current.some((item, index) => !integer(item.seq) || (item.seq as number) > throughSeq ||
          (beforeSeq !== undefined && (item.seq as number) >= beforeSeq) ||
          (index > 0 && (item.seq as number) !== (current[index - 1]?.seq as number) + 1))) return unknown;
      if (current.at(-1)?.seq !== (beforeSeq ?? throughSeq + 1) - 1) return unknown;
      for (const item of current) events.push({ seq: item.seq as number, type: item.type as string, data: item.data });
      if (!page.hasMore) { exhausted = true; break; }
      beforeSeq = current[0]?.seq as number;
    }
    let activeTurn: number | null = null, boundTurn: number | null = null;
    const foreignTurns = new Set<number>();
    type Turn = { nativeTurn: number; callId?: string; end?: { seq: number; reason: string };
      messages: { seq: number; text: string }[]; pending: Set<string>; calls: Set<string>;
      approvals: NonNullable<DshTurnObservation["approvals"]>[number][] };
    const turns = new Map<number, Turn>(), questionOwners = new Map<string, number>(), replies = new Set<string>();
    const addTurn = (nativeTurn: number, callId?: string): Turn => {
      const value: Turn = { nativeTurn, ...(callId ? { callId } : {}), messages: [], pending: new Set(), calls: new Set(), approvals: [] };
      turns.set(nativeTurn, value); return value;
    };
    for (const event of events.sort((a, b) => a.seq - b.seq)) {
      const data = record(event.data);
      const turn = data?.turn;
      if (event.type === "turn/start" && integer(turn)) activeTurn = turn;
      if (event.type === "user/message" && activeTurn !== null) {
        const source = record(data?.source);
        if (source?.kind === "user" && source.rpcId === requestId) {
          if (boundTurn !== null) return unknown;
          boundTurn = activeTurn; addTurn(activeTurn);
        } else if (source?.kind === "user") foreignTurns.add(activeTurn);
        else if (source?.kind === "user-question-reply" && source.outcome === "answered" &&
            nonempty(source.callId) && questionOwners.has(source.callId)) {
          if (replies.has(source.callId)) return unknown;
          replies.add(source.callId);
          if (!turns.has(activeTurn)) addTurn(activeTurn, source.callId);
        } else if (source?.kind === "user-question-reply") foreignTurns.add(activeTurn);
      }
      const current: Turn | undefined = activeTurn === null ? undefined : turns.get(activeTurn);
      if (current) {
        const questionCall = data?.name === "ask_user_question" ?
          event.type === "tool/call" ? data.callId : event.type === "tool/ptc-dispatch" ? data.subCallId : null : null;
        if (nonempty(questionCall)) {
          if (questionOwners.has(questionCall)) return unknown;
          current.calls.add(questionCall); questionOwners.set(questionCall, current.nativeTurn);
        }
        if (event.type === "assistant/message" && turn === current.nativeTurn) {
          const content = record(data?.message)?.content;
          if (!Array.isArray(content)) return unknown;
          const texts: string[] = [];
          for (const part of content) {
            const block = record(part);
            if (!block || typeof block.type !== "string") return unknown;
            if (block.type === "text") {
              if (typeof block.text !== "string") return unknown;
              texts.push(block.text);
            }
          }
          const text = texts.join("");
          if (text.trim()) current.messages.push({ seq: event.seq, text });
        }
        if (event.type === "approval/asked" && typeof data?.id === "string" && typeof data.toolName === "string") {
          if (current.approvals.some(item => item.id === data.id)) return unknown;
          current.pending.add(data.id); current.approvals.push({ id: data.id, toolName: data.toolName,
            ...(typeof data.callId === "string" ? { callId: data.callId } : {}),
            ...(typeof data.reason === "string" ? { reason: data.reason } : {}) });
        }
        if (event.type === "approval/decided" && typeof data?.id === "string") {
          current.pending.delete(data.id); const audit = current.approvals.find(item => item.id === data.id);
          if (audit && typeof data.outcome === "string") audit.outcome = data.outcome;
        }
      }
      if (event.type === "turn/end" && integer(turn)) {
        const ended = turns.get(turn);
        if (ended) {
          if (ended.end) return unknown;
          ended.end = { seq: event.seq, reason: String(record(data?.reason)?.kind ?? "") };
        }
        if (activeTurn === turn) activeTurn = null;
      }
    }
    if (!exhausted || [...turns.keys()].some(turn => foreignTurns.has(turn)) || queued && boundTurn !== null) return unknown;
    if (boundTurn === null) return queued ? { status: "queued" } : unknown;
    const questionView = record(row.projections?.values?.userQuestions);
    if (!Array.isArray(questionView?.active) || !Array.isArray(questionView?.settled)) return unknown;
    const activeQuestions = questionView.active;
    const questions: NonNullable<DshTurnObservation["questions"]> = Array.isArray(activeQuestions)
      ? activeQuestions.filter(item => questionOwners.has(String(record(item)?.callId)) && (record(item)?.state === "open" || record(item)?.state === "continued"))
          .map(item => item as NonNullable<DshTurnObservation["questions"]>[number]) : [];
    if (questions.some(question => !nonempty(question.callId) || !Array.isArray(question.questions) ||
        !question.questions.length || question.questions.some(item => !nonempty(item.id) || !nonempty(item.question)))) return unknown;
    if (new Set(questions.map(question => question.callId)).size !== questions.length) return unknown;
    const observations: (DshTurnObservation & { nativeTurn: number; callId?: string })[] = [];
    for (const current of turns.values()) {
      const ownedQuestions = questions.filter(question => current.calls.has(question.callId));
      const status: DshTurnObservation["status"] = current.end ?
        current.end.reason === "completed" && current.pending.size === 0 ? "completed" :
        ["aborted", "interrupted"].includes(current.end.reason) ? "cancelled" :
        ["error", "blocked", "max-tokens"].includes(current.end.reason) ? "failed" : "unknown" :
        row.running && activeTurn === current.nativeTurn ?
          current.pending.size ? "waiting_approval" : ownedQuestions.length ? "waiting_answer" : "running" : "unknown";
      if (status === "unknown") return unknown;
      observations.push({ status, nativeTurn: current.nativeTurn, ...(current.callId ? { callId: current.callId } : {}),
        ...(current.end ? { terminalSeq: current.end.seq } : {}), messages: current.messages, approvals: current.approvals, questions: ownedQuestions });
    }
    const root = observations[0]!;
    return { ...root, followUps: observations.slice(1) as (DshTurnObservation & { nativeTurn: number; callId: string })[] };
  } catch { return unknown; }
}

/** The catalog advertises names. Native audit verifies the actual knob values,
 * including a configured preset reusing a familiar name with different policy. */
async function readPermissionKnobs(rpc: DshSessionRpc, sessionId: string, throughSeq: number) {
  if (!integer(throughSeq)) throw new DshTransportError("incompatible");
  let beforeSeq: number | undefined;
  const knobs: { sandbox?: string; approval?: string } = {};
  for (;;) {
    const page = record(await rpc.call("session/page", { request: { address: { kind: "session", sessionId },
      throughSeq, maxMessages: 6, ...(beforeSeq === undefined ? {} : { beforeSeq }) } }));
    if (!Array.isArray(page?.records) || !page.records.length || typeof page.hasMore !== "boolean") break;
    const events = page.records.map(item => record(record(item)?.event));
    if (events.some(event => !event || !integer(event.seq) || Number(event.seq) >= (beforeSeq ?? throughSeq + 1)))
      throw new DshTransportError("incompatible");
    if (events.at(-1)?.seq !== (beforeSeq ?? throughSeq + 1) - 1 ||
        events.some((event, index) => index > 0 && Number(event?.seq) !== Number(events[index - 1]?.seq) + 1))
      throw new DshTransportError("incompatible");
    for (const event of [...events].reverse()) {
      const data = record(event?.data);
      if (!knobs.sandbox && event?.type === "sandbox/mode" && nonempty(data?.mode)) knobs.sandbox = data.mode;
      if (!knobs.approval && event?.type === "approval/policy" && nonempty(data?.policy)) knobs.approval = data.policy;
    }
    if (knobs.sandbox && knobs.approval) return knobs;
    if (!page.hasMore) break;
    beforeSeq = Number(events[0]?.seq);
  }
  throw new DshTransportError("incompatible");
}
