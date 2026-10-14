// @effect-diagnostics nodeBuiltinImport:off
import { createHash, createHmac } from "node:crypto";
import type { OrchestrationCommand } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { providerContextProofPayload, verifyProviderContextProof } from "./ProviderContextProof.ts";

const key = "ab".repeat(32);
function signedCommand(): Extract<OrchestrationCommand, { type: "thread.turn.start" }> {
  const binding = {
    projectId: "logical-project", taskId: "task-1", environmentId: "environment-1",
    threadId: "thread-1", providerInstanceId: "codex", modelId: "model-1",
    branchRef: "main", snapshotSequence: 7, commandId: "command-1", draftId: "draft-1",
    draftVersion: 2, messageId: "message-1",
  };
  const records = [{ version: 1, contextId: "memory-1", label: "项目记忆", kind: "project-memory",
    payload: { status: "accepted", projectId: binding.projectId, id: "memory-1", version: 3,
      kind: "fact", text: "Reviewed project fact", sources: [{ taskId: binding.taskId,
        recordedAt: "2026-09-27T00:00:00.000Z" }] } }];
  const text = "Reviewed command";
  const fingerprint = createHash("sha256").update(JSON.stringify(["0.1.1", binding, text, records])).digest("hex");
  const command = {
    type: "thread.turn.start", commandId: binding.commandId, threadId: binding.threadId,
    message: { messageId: binding.messageId, role: "user", text, attachments: [] },
    runtimeMode: "approval-required", interactionMode: "default",
    createdAt: "2026-09-27T00:00:00.000Z",
    providerOnlyProjectContext: {
      version: 1, commandId: binding.commandId, messageId: binding.messageId,
      threadId: binding.threadId, t3ProjectId: "native-project", providerInstanceId: binding.providerInstanceId,
      modelId: binding.modelId, branchRef: binding.branchRef, snapshotSequence: binding.snapshotSequence,
      draftId: binding.draftId, draftVersion: binding.draftVersion, fingerprint,
      context: { version: 1, records }, proof: { version: 1, projectId: binding.projectId,
        taskId: binding.taskId, environmentId: binding.environmentId, mac: "0".repeat(64) },
    },
  } as unknown as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
  const sidecar = command.providerOnlyProjectContext!;
  return { ...command, providerOnlyProjectContext: { ...sidecar,
    proof: { ...sidecar.proof!, mac: createHmac("sha256", Buffer.from(key, "hex"))
      .update(providerContextProofPayload(command, sidecar)).digest("hex") } } };
}

describe("private project context proof", () => {
  it("accepts the exact committed tuple and leaves ordinary turns unchanged", () => {
    const command = signedCommand();
    expect(verifyProviderContextProof(command, key)).toBe(true);
    expect(verifyProviderContextProof({ ...command, providerOnlyProjectContext: undefined }, undefined)).toBe(true);
  });

  it("rejects missing key/proof and every altered frozen identity or material", () => {
    const command = signedCommand();
    const context = command.providerOnlyProjectContext!;
    expect(verifyProviderContextProof(command, undefined)).toBe(false);
    expect(verifyProviderContextProof({ ...command, providerOnlyProjectContext: { ...context,
      proof: undefined } }, key)).toBe(false);
    for (const altered of [
      { ...command, commandId: "different" },
      { ...command, message: { ...command.message, text: "changed" } },
      { ...command, providerOnlyProjectContext: { ...context, draftVersion: 3 } },
      { ...command, providerOnlyProjectContext: { ...context, branchRef: "other" } },
      { ...command, providerOnlyProjectContext: { ...context, modelId: "other" } },
      { ...command, providerOnlyProjectContext: { ...context, fingerprint: "0".repeat(64) } },
      { ...command, providerOnlyProjectContext: { ...context, proof: { ...context.proof!, taskId: "other" } } },
      { ...command, providerOnlyProjectContext: { ...context, proof: { ...context.proof!, environmentId: "other" } } },
      { ...command, providerOnlyProjectContext: { ...context, proof: { ...context.proof!, projectId: "other" } } },
      { ...command, providerOnlyProjectContext: { ...context, context: { ...context.context,
        records: [{ ...context.context.records[0]!, payload: { text: "changed" } }] } } },
    ] as OrchestrationCommand[]) expect(verifyProviderContextProof(altered, key)).toBe(false);
  });
});
