import { createHash } from 'node:crypto';
import type { ProjectMemoryItem } from '../contracts/project-memory.js';
import { PROJECT_PROVIDER_CONTEXT_VERSION, type ProjectProviderContextBinding,
  type ProjectProviderContextCapacityPort, type ProjectProviderContextPreparation,
  type ProjectProviderContextRecord } from '../contracts/project-provider-context.js';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  value.length <= 250 && !/[\u0000-\u001f\u007f]/u.test(value);

function validBinding(binding: ProjectProviderContextBinding, text: string): boolean {
  return !!binding && [binding.projectId, binding.taskId, binding.environmentId, binding.threadId,
    binding.providerInstanceId, binding.modelId, binding.commandId, binding.draftId,
    binding.messageId].every(validId) &&
    (binding.branchRef === null || validId(binding.branchRef)) &&
    Number.isSafeInteger(binding.snapshotSequence) && binding.snapshotSequence >= 0 &&
    Number.isSafeInteger(binding.draftVersion) && binding.draftVersion >= 1 &&
    typeof text === 'string' && text.trim().length > 0 && text.length <= 120000 && !text.includes('\0');
}

/** Only constructs an inert candidate. The capacity port has no production implementation yet. */
export async function prepareProjectProviderContext(input: {
  readonly binding: ProjectProviderContextBinding;
  readonly durableMessageText: string;
  readonly memories: readonly ProjectMemoryItem[];
}, capacity?: ProjectProviderContextCapacityPort): Promise<ProjectProviderContextPreparation> {
  const { binding, durableMessageText, memories } = input;
  if (!validBinding(binding, durableMessageText)) return { status: 'unavailable', reason: 'invalid_binding' };
  if (!capacity) return { status: 'unavailable', reason: 'capacity_unverified' };
  if (!Array.isArray(memories) || memories.length > 100) return { status: 'unavailable', reason: 'invalid_memory' };
  const frozenBinding = Object.freeze({ ...binding });
  const seen = new Set<string>();
  const records: ProjectProviderContextRecord[] = [];
  for (const item of memories) {
    if (!item || !validId(item.id) || seen.has(item.id) || item.projectId !== binding.projectId ||
        item.status !== 'accepted' || item.supersededById ||
        (item.branchRef && item.branchRef !== binding.branchRef) ||
        !['decision', 'constraint', 'fact', 'open_question'].includes(item.kind) ||
        !Number.isSafeInteger(item.version) || item.version < 1 ||
        typeof item.text !== 'string' || !item.text.trim() || item.text.length > 4000 ||
        !Array.isArray(item.sources) || item.sources.length === 0 ||
        item.sources.some((source: ProjectMemoryItem['sources'][number]) => !source || typeof source.recordedAt !== 'string' ||
          !Number.isFinite(Date.parse(source.recordedAt)))) {
      return { status: 'unavailable', reason: 'invalid_memory' };
    }
    seen.add(item.id);
    const payload: ProjectProviderContextRecord['payload'] = Object.freeze({
      status: 'accepted', projectId: item.projectId, id: item.id, version: item.version,
      kind: item.kind, text: item.text,
      ...(item.branchRef ? { branchRef: item.branchRef } : {}),
      ...(item.condition ? { condition: item.condition } : {}),
      sources: Object.freeze(item.sources.map((source: ProjectMemoryItem['sources'][number]) =>
        Object.freeze({ ...source }))),
    });
    let serialized: string;
    try { serialized = JSON.stringify(payload); }
    catch { return { status: 'unavailable', reason: 'invalid_memory' }; }
    if (serialized.length > 64000) return { status: 'unavailable', reason: 'record_too_large' };
    const contextId = digest([frozenBinding.commandId, frozenBinding.messageId, item.id, item.version, payload]);
    records.push(Object.freeze({ version: 1, contextId, label: '项目记忆', kind: 'project-memory', payload }));
  }
  Object.freeze(records);
  const providerProjectionText = records.length === 0 ? durableMessageText :
    `${durableMessageText}\n\n${records.map(record =>
      `[项目记忆](t3-context://v1/project-memory/${record.contextId})`).join('\n')}`;
  let verification: 'fits' | 'unavailable';
  try { verification = await capacity.verify({ binding: frozenBinding, durableMessageText, providerProjectionText, records }); }
  catch { verification = 'unavailable'; }
  if (verification !== 'fits') return { status: 'unavailable', reason: 'capacity_unverified' };
  return { status: 'ready', version: PROJECT_PROVIDER_CONTEXT_VERSION, binding: frozenBinding,
    fingerprint: digest([PROJECT_PROVIDER_CONTEXT_VERSION, frozenBinding, durableMessageText, records]),
    durableMessageText, providerProjectionText, records };
}
