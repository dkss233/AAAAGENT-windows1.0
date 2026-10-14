export interface NativeToolOutputScope {
  environmentId: string;
  projectId: string;
  workspaceRoot: string;
  providerInstanceId: string;
  threadId: string;
}
export interface NativeToolOutputTarget extends NativeToolOutputScope {
  turnId: string;
  toolCallId: string;
}
export interface NativeToolOutput {
  apiVersion: "0.1.0";
  source: "t3-original-terminal-activity";
  complete: true;
  scope: NativeToolOutputScope;
  nativeThreadId: string;
  turnId: string;
  toolCallId: string;
  activityId: string;
  itemType: "command_execution";
  command: string;
  output: string;
  outputBytes: number;
  outputSha256: string;
  exitCode: number | null;
}
export const nativeToolOutputKey = (target: NativeToolOutputTarget) => JSON.stringify([
  target.environmentId, target.projectId, target.workspaceRoot, target.providerInstanceId,
  target.threadId, target.turnId, target.toolCallId,
]);
export function nativeToolOutputEndpoint(target: NativeToolOutputTarget) {
  const { threadId, ...query } = target;
  return `/api/orchestration/threads/${encodeURIComponent(threadId)}/tool-output?${new URLSearchParams(query)}`;
}
export async function readNativeToolOutput(target: NativeToolOutputTarget, options: { signal?: AbortSignal } = {}): Promise<NativeToolOutput> {
  const response = await fetch(nativeToolOutputEndpoint(target), { credentials: "same-origin", cache: "no-store",
    ...(options.signal === undefined ? {} : { signal: options.signal }) });
  if (!response.ok) throw Error("原工具全文暂不可读取。");
  const value = await response.json() as NativeToolOutput;
  if (!value || value.apiVersion !== "0.1.0" || value.source !== "t3-original-terminal-activity" || value.complete !== true ||
      !value.scope || !["environmentId", "projectId", "workspaceRoot", "providerInstanceId", "threadId"].every(key =>
        value.scope[key as keyof NativeToolOutputScope] === target[key as keyof NativeToolOutputScope]) ||
      value.turnId !== target.turnId || value.toolCallId !== target.toolCallId || value.itemType !== "command_execution" ||
      typeof value.nativeThreadId !== "string" || !value.nativeThreadId || typeof value.activityId !== "string" || !value.activityId ||
      typeof value.command !== "string" || typeof value.output !== "string" ||
      value.outputBytes !== new TextEncoder().encode(value.output).length || !/^[a-f0-9]{64}$/.test(value.outputSha256) ||
      !(value.exitCode === null || Number.isSafeInteger(value.exitCode))) throw Error("原工具全文的身份或完整性不一致。");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value.output))),
    byte => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== value.outputSha256) throw Error("原工具全文的完整性不一致。");
  return value;
}
