import { createHash } from 'node:crypto';
import type { ProjectProviderContextProof, ProjectProviderContextProofSignerPort } from
  '../contracts/project-provider-context.js';
import type { ProviderContextFreeze } from '../app/workbench-store.js';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** This ordered tuple is shared with the fixed T3 server verifier; it includes every frozen record. */
export function providerContextProofPayload(freeze: ProviderContextFreeze, t3ProjectId: string): string {
  const binding = freeze.binding;
  return JSON.stringify(['AAAAGENT-project-context-proof-v1', binding.projectId, binding.taskId,
    binding.environmentId, binding.commandId, binding.messageId, binding.threadId, t3ProjectId,
    binding.providerInstanceId, binding.modelId, binding.branchRef, binding.snapshotSequence,
    binding.draftId, binding.draftVersion, freeze.fingerprint, freeze.durableMessageText, freeze.records]);
}

/** Called only with a cold read of the committed claim, never with the pre-claim candidate. */
export async function signProviderContextFreeze(freeze: ProviderContextFreeze, t3ProjectId: string,
  signer: ProjectProviderContextProofSignerPort): Promise<ProjectProviderContextProof> {
  const binding = freeze.binding;
  if (freeze.status !== 'ready' || freeze.records.length === 0 ||
      freeze.fingerprint !== digest([freeze.version, binding, freeze.durableMessageText, freeze.records])) {
    throw new Error('Invalid committed project context freeze');
  }
  const mac = await signer.signProviderContextProof(providerContextProofPayload(freeze, t3ProjectId));
  if (!/^[a-f0-9]{64}$/.test(mac)) throw new Error('Invalid project context proof receipt');
  return { version: 1, projectId: binding.projectId, taskId: binding.taskId,
    environmentId: binding.environmentId, mac };
}
