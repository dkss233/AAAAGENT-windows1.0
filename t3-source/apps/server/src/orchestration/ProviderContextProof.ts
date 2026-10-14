// @effect-diagnostics nodeBuiltinImport:off
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { OrchestrationCommand, ProviderOnlyProjectContext } from "@t3tools/contracts";

type TurnStart = Extract<OrchestrationCommand, { type: "thread.turn.start" }>;

function fingerprint(command: TurnStart, context: ProviderOnlyProjectContext): string {
  const proof = context.proof!;
  const binding = {
    projectId: proof.projectId,
    taskId: proof.taskId,
    environmentId: proof.environmentId,
    threadId: context.threadId,
    providerInstanceId: context.providerInstanceId,
    modelId: context.modelId,
    branchRef: context.branchRef,
    snapshotSequence: context.snapshotSequence,
    commandId: context.commandId,
    draftId: context.draftId,
    draftVersion: context.draftVersion,
    messageId: context.messageId,
  };
  return createHash("sha256").update(JSON.stringify([
    "0.1.1", binding, command.message.text, context.context.records,
  ])).digest("hex");
}

export function providerContextProofPayload(command: TurnStart, context: ProviderOnlyProjectContext): string {
  const proof = context.proof!;
  return JSON.stringify(["AAAAGENT-project-context-proof-v1", proof.projectId, proof.taskId,
    proof.environmentId, context.commandId, context.messageId, context.threadId,
    context.t3ProjectId, context.providerInstanceId, context.modelId, context.branchRef,
    context.snapshotSequence, context.draftId, context.draftVersion, context.fingerprint,
    command.message.text, context.context.records]);
}

/** Called by the one shared engine before queueing a command from HTTP, WS, RPC or server code. */
export function verifyProviderContextProof(command: OrchestrationCommand, keyHex: string | undefined): boolean {
  if (command.type !== "thread.turn.start" || command.providerOnlyProjectContext === undefined) return true;
  const context = command.providerOnlyProjectContext;
  const proof = context.proof;
  if (!proof || proof.version !== 1 || !/^[a-f0-9]{64}$/.test(proof.mac) ||
      context.commandId !== command.commandId || context.threadId !== command.threadId ||
      context.messageId !== command.message.messageId ||
      context.context.records.length === 0 || context.context.records.some((record) =>
        record.kind !== "project-memory" || !("payload" in record) ||
        typeof record.payload !== "object" || record.payload === null ||
        (record.payload as { projectId?: unknown }).projectId !== proof.projectId) ||
      typeof keyHex !== "string" || !/^[a-f0-9]{64}$/.test(keyHex)) return false;
  try {
    if (context.fingerprint !== fingerprint(command, context)) return false;
    const expected = createHmac("sha256", Buffer.from(keyHex, "hex"))
      .update(providerContextProofPayload(command, context)).digest();
    return timingSafeEqual(expected, Buffer.from(proof.mac, "hex"));
  } catch {
    return false;
  }
}
