import { ManagementError } from '../contracts/management.js';
import type {
  ProjectMemoryItem, ProjectTerminalEvidence, ProjectTerminalMaterial, ProjectTerminalMaterialPort,
} from '../contracts/project-memory.js';
import type { ProjectMemoryProposal } from './project-memory-sqlite.js';

/** A derivation can name only message IDs in the verified terminal turn, never invent source references. */
export interface ProjectTerminalClaim {
  readonly stableKey: string;
  readonly kind: ProjectMemoryItem['kind'];
  readonly text: string;
  readonly basis: ProjectMemoryProposal['basis'];
  readonly sourceMessageIds: readonly string[];
  readonly branchRef?: string;
  readonly condition?: string;
}

export type ProjectTerminalDerivation =
  | { readonly outcome: 'proposals'; readonly claims: readonly ProjectTerminalClaim[] }
  | { readonly outcome: 'no_change' };

export type ProjectTerminalDeriver = (material: ProjectTerminalMaterial) => Promise<ProjectTerminalDerivation>;

const unavailable = (): never => { throw new ManagementError('unavailable', '终态材料不完整或来源不匹配。'); };
const invalid = (): never => { throw new ManagementError('invalid_request', '终态提案缺少可核对的消息来源。'); };
const plain = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) return unavailable();
  return value as Record<string, unknown>;
};
const id = (value: unknown): value is string => typeof value === 'string' &&
  value.length > 0 && value.length <= 250 && !/[\u0000-\u001f\u007f]/u.test(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' &&
  value.trim().length > 0 && value.length <= max && !value.includes('\0');
const sameEvidence = (left: ProjectTerminalEvidence, right: Record<string, unknown>): boolean =>
  right.projectId === left.projectId && right.taskId === left.taskId &&
  right.nativeTurnId === left.nativeTurnId && right.terminalEventId === left.terminalEventId &&
  right.terminalPhase === left.terminalPhase && right.resultRef === left.resultRef &&
  right.occurredAt === left.occurredAt && right.extractionVersion === left.extractionVersion;

function verifiedMaterial(evidence: ProjectTerminalEvidence, value: unknown): ProjectTerminalMaterial {
  const material = plain(value, ['version', 'evidence', 'userMessages', 'assistantMessage', 'source']);
  if (material.version !== '0.1.0' || material.source !== 't3_thread_detail' ||
      !sameEvidence(evidence, plain(material.evidence,
        ['projectId', 'taskId', 'nativeTurnId', 'terminalEventId', 'terminalPhase', 'resultRef', 'occurredAt', 'extractionVersion'])) ||
      !Array.isArray(material.userMessages) || material.userMessages.length < 1 ||
      material.userMessages.length > 2000) return unavailable();
  const seen = new Set<string>();
  const users: { readonly id: string; readonly text: string }[] = [];
  let total = 0;
  for (const raw of material.userMessages) {
    const message = plain(raw, ['id', 'text']);
    if (!id(message.id) || seen.has(message.id) || !text(message.text, 240000)) return unavailable();
    seen.add(message.id);
    total += message.text.length;
    users.push(Object.freeze({ id: message.id, text: message.text }));
  }
  let assistantMessage: { readonly id: string; readonly text: string } | undefined;
  if (evidence.terminalPhase === 'completed') {
    const assistant = plain(material.assistantMessage, ['id', 'text']);
    if (!id(assistant.id) || seen.has(assistant.id) || !text(assistant.text, 240000) ||
        !evidence.resultRef?.startsWith('t3:') ||
        !evidence.resultRef.endsWith(`:message:${assistant.id}`)) return unavailable();
    total += assistant.text.length;
    assistantMessage = Object.freeze({ id: assistant.id, text: assistant.text });
  } else if (material.assistantMessage !== undefined || evidence.resultRef !== undefined) return unavailable();
  if (total > 240000) return unavailable();
  return Object.freeze({ version: '0.1.0', source: 't3_thread_detail', evidence,
    userMessages: Object.freeze(users), ...(assistantMessage ? { assistantMessage } : {}) });
}

function claimsFrom(material: ProjectTerminalMaterial, value: unknown): readonly ProjectMemoryProposal[] {
  const result = plain(value, ['outcome', 'claims']);
  if (result.outcome === 'no_change' && result.claims === undefined) return [];
  if (result.outcome !== 'proposals' || !Array.isArray(result.claims) ||
      result.claims.length < 1 || result.claims.length > 100) return invalid();
  const userIds = new Set(material.userMessages.map(message => message.id));
  const assistantId = material.assistantMessage?.id;
  const keys = new Set<string>();
  return result.claims.map(raw => {
    const claim = plain(raw, ['stableKey', 'kind', 'text', 'basis', 'sourceMessageIds', 'branchRef', 'condition']);
    if (!id(claim.stableKey) || keys.has(claim.stableKey) ||
        !['decision', 'constraint', 'fact', 'open_question'].includes(String(claim.kind)) ||
        !text(claim.text, 4000) ||
        !['model_suggestion', 'explicit_user', 'verified_execution'].includes(String(claim.basis)) ||
        !Array.isArray(claim.sourceMessageIds) || claim.sourceMessageIds.length < 1 ||
        claim.sourceMessageIds.length > 20 ||
        claim.branchRef !== undefined && !text(claim.branchRef, 250) ||
        claim.condition !== undefined && !text(claim.condition, 500)) return invalid();
    keys.add(claim.stableKey);
    const sourceIds = new Set<string>();
    const sources = claim.sourceMessageIds.map(sourceId => {
      if (!id(sourceId) || sourceIds.has(sourceId)) return invalid();
      sourceIds.add(sourceId);
      const common = {
        taskId: material.evidence.taskId, nativeTurnId: material.evidence.nativeTurnId,
        terminalEventId: material.evidence.terminalEventId, recordedAt: material.evidence.occurredAt,
      };
      if (userIds.has(sourceId)) return { ...common, userInputId: sourceId };
      if (sourceId === assistantId && material.evidence.resultRef) {
        return { ...common, artifactRef: material.evidence.resultRef };
      }
      return invalid();
    });
    if (claim.basis === 'explicit_user' && !claim.sourceMessageIds.some(sourceId => userIds.has(sourceId)) ||
        claim.basis === 'verified_execution' && !claim.sourceMessageIds.includes(assistantId)) return invalid();
    return {
      stableKey: claim.stableKey, kind: claim.kind as ProjectMemoryItem['kind'],
      text: claim.text, basis: claim.basis as ProjectMemoryProposal['basis'], sources,
      ...(claim.branchRef === undefined ? {} : { branchRef: claim.branchRef as string }),
      ...(claim.condition === undefined ? {} : { condition: claim.condition as string }),
    };
  });
}

/** The worker reads one exact, persisted turn, then converts bounded claims into immutable source links. */
export function createProjectTerminalExtractor(materialPort: ProjectTerminalMaterialPort, derive: ProjectTerminalDeriver):
  (evidence: ProjectTerminalEvidence) => Promise<readonly ProjectMemoryProposal[]> {
  return async evidence => {
    const frozenEvidence = Object.freeze({ ...evidence });
    const material = verifiedMaterial(frozenEvidence, await materialPort.readTerminalMaterial(frozenEvidence));
    return claimsFrom(material, await derive(material));
  };
}
