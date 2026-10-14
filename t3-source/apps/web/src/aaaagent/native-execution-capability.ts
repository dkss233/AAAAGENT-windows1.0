export interface ProviderExecutionCapability {
  readonly providerInstanceId: string;
  readonly send: boolean;
  readonly continue: boolean;
  readonly modelSelection: boolean;
  readonly runtimeModes: readonly string[];
  readonly attachments: { readonly file: boolean; readonly image: boolean; readonly maxBytes: number };
  readonly interrupt: boolean;
  readonly approval: boolean;
  readonly userInput: boolean;
}

export interface NativeExecutionCapability {
  readonly apiVersion: 1;
  readonly version: "0.2.0";
  readonly environmentId: string;
  readonly expiresAt: string;
  readonly mode: "native-read" | "native-operate";
  readonly commandTypes: readonly string[];
  readonly providers: readonly ProviderExecutionCapability[];
}

export interface NativeTargetCapability {
  readonly apiVersion: 1;
  readonly version: "0.2.0";
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly providerInstanceId: string | null;
  readonly nativeSessionId: string | null;
  readonly source: "t3" | "codex-app" | "external" | "unknown";
  readonly readonly: boolean;
  readonly reason: null | "external_owner_unavailable" | "binding_unverified" | "read_only_mount";
  readonly commandTypes: readonly string[];
  readonly expiresAt: string;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const identifierOrNull = (value: unknown) => value === null || text(value);
const future = (value: unknown, now: number): value is string => text(value) && Date.parse(value) > now;

export function decodeNativeExecutionCapability(
  value: unknown, environmentId: string, now = Date.now(),
): NativeExecutionCapability | null {
  if (!record(value) || value.apiVersion !== 1 || value.version !== "0.2.0" ||
      value.environmentId !== environmentId || !text(environmentId) || !future(value.expiresAt, now) ||
      !["native-read", "native-operate"].includes(String(value.mode)) || !texts(value.commandTypes) ||
      !Array.isArray(value.providers)) return null;
  const instances = new Set<string>();
  for (const provider of value.providers) {
    if (!record(provider) || !text(provider.providerInstanceId) || instances.has(provider.providerInstanceId) ||
        !["send", "continue", "modelSelection", "interrupt", "approval", "userInput"].every(key => typeof provider[key] === "boolean") ||
        !texts(provider.runtimeModes) || !record(provider.attachments) ||
        typeof provider.attachments.file !== "boolean" || typeof provider.attachments.image !== "boolean" ||
        typeof provider.attachments.maxBytes !== "number" || !Number.isSafeInteger(provider.attachments.maxBytes) ||
        provider.attachments.maxBytes < 0) return null;
    instances.add(provider.providerInstanceId);
  }
  return value as unknown as NativeExecutionCapability;
}

export function decodeNativeTargetCapability(
  value: unknown, environmentId: string, threadId: string, now = Date.now(),
): NativeTargetCapability | null {
  if (!record(value) || value.apiVersion !== 1 || value.version !== "0.2.0" ||
      value.environmentId !== environmentId || value.threadId !== threadId || !text(threadId) ||
      !text(value.projectId) || !future(value.expiresAt, now) ||
      !identifierOrNull(value.providerInstanceId) || !identifierOrNull(value.nativeSessionId) ||
      !["t3", "codex-app", "external", "unknown"].includes(String(value.source)) ||
      typeof value.readonly !== "boolean" ||
      value.reason !== null && !["external_owner_unavailable", "binding_unverified", "read_only_mount"].includes(String(value.reason)) ||
      !texts(value.commandTypes)) return null;
  return value as unknown as NativeTargetCapability;
}

export interface NativeExecutionSelection {
  readonly environmentId: string;
  readonly projectId: string | null | undefined;
  readonly threadId: string | null | undefined;
  readonly providerInstanceId: string;
  readonly routeKind: "draft" | "server";
  readonly nativeSessionObservation?: unknown;
}

/** An explicit native observation can block a new turn; it grants no command capability. */
export function nativeTurnObservationReason(
  target: NativeTargetCapability | null, selection: NativeExecutionSelection,
): string | null {
  if (selection.routeKind === "draft" || selection.nativeSessionObservation == null) return null;
  const observation = selection.nativeSessionObservation;
  if (!record(observation) || observation.nativeId !== target?.nativeSessionId ||
      observation.instanceId !== selection.providerInstanceId) {
    return "原生会话状态尚未核定；草稿保留，等待核验";
  }
  switch (observation.status) {
    case "ready": return null;
    case "running": return "原生会话正在执行；草稿保留，等待本轮结束";
    case "waiting_approval": return "原生会话正在等待批准；草稿保留，请处理当前请求";
    case "waiting_answer": return "原生会话正在等待回答；草稿保留，请处理当前问题";
    default: return "原生会话状态尚未核定；草稿保留，等待核验";
  }
}

/** Existing threads need their own verified binding in addition to provider support. */
export function nativeProviderForSelection(
  capability: NativeExecutionCapability | null,
  target: NativeTargetCapability | null,
  selection: NativeExecutionSelection,
  now = Date.now(),
): ProviderExecutionCapability | null {
  if (!capability || capability.mode !== "native-operate" ||
      capability.environmentId !== selection.environmentId || Date.parse(capability.expiresAt) <= now ||
      !text(selection.projectId)) return null;
  const provider = capability.providers.find(item => item.providerInstanceId === selection.providerInstanceId);
  if (!provider) return null;
  if (selection.routeKind === "draft") return provider.send ? provider : null;
  if (!target || target.readonly || target.reason !== null || target.source === "unknown" || !text(target.nativeSessionId) ||
      target.environmentId !== selection.environmentId || target.projectId !== selection.projectId ||
      target.threadId !== selection.threadId || target.providerInstanceId !== selection.providerInstanceId ||
      Date.parse(target.expiresAt) <= now) return null;
  return provider;
}

export function allowsNativeCommand(
  capability: NativeExecutionCapability | null,
  target: NativeTargetCapability | null,
  selection: NativeExecutionSelection,
  command: string,
  now = Date.now(),
): boolean {
  const provider = nativeProviderForSelection(capability, target, selection, now);
  if (!provider || !capability?.commandTypes.includes(command) ||
      selection.routeKind === "server" && !target?.commandTypes.includes(command)) return false;
  switch (command) {
    case "thread.create": return selection.routeKind === "draft" && provider.send;
    case "thread.turn.start": return selection.routeKind === "draft" ? provider.send :
      provider.continue && nativeTurnObservationReason(target, selection) === null;
    case "thread.turn.interrupt": case "thread.session.stop": return selection.routeKind === "server" && provider.interrupt;
    case "thread.runtime-mode.set": return provider.runtimeModes.length > 0;
    case "thread.interaction-mode.set": return true;
    case "thread.approval.respond": return selection.routeKind === "server" && provider.approval;
    case "thread.user-input.respond": case "thread.user-input.dismiss": return selection.routeKind === "server" && provider.userInput;
    case "thread.meta.update": return selection.routeKind === "server";
    default: return false;
  }
}
