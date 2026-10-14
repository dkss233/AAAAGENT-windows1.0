import type { ProjectMemoryItem } from './project-memory.js';

export const PROJECT_PROVIDER_CONTEXT_VERSION = '0.1.1' as const;

/** Private local-service receipt. The MAC is issued only after the matching draft/freeze commit is read back. */
export interface ProjectProviderContextProof {
  readonly version: 1;
  readonly projectId: string;
  readonly taskId: string;
  readonly environmentId: string;
  readonly mac: string;
}

export interface ProjectProviderContextProofSignerPort {
  signProviderContextProof(payload: string): Promise<string>;
}

/** Frozen before one native command is claimed. All fields belong to the same T3 task. */
export interface ProjectProviderContextBinding {
  readonly projectId: string;
  readonly taskId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly branchRef: string | null;
  readonly snapshotSequence: number;
  readonly commandId: string;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly messageId: string;
}

export interface ProjectProviderContextRecord {
  readonly version: 1;
  readonly contextId: string;
  readonly label: '项目记忆';
  readonly kind: 'project-memory';
  readonly payload: {
    readonly status: 'accepted';
    readonly projectId: string;
    readonly id: string;
    readonly version: number;
    readonly kind: ProjectMemoryItem['kind'];
    readonly text: string;
    readonly branchRef?: string;
    readonly condition?: string;
    readonly sources: ProjectMemoryItem['sources'];
  };
}

/** At the native send boundary, project references with T3 and check the full prompt's actual token headroom. */
export interface ProjectProviderContextCapacityPort {
  verify(input: {
    readonly binding: ProjectProviderContextBinding;
    readonly durableMessageText: string;
    readonly providerProjectionText: string;
    readonly records: readonly ProjectProviderContextRecord[];
  }): Promise<'fits' | 'unavailable'>;
}

export type ProjectProviderContextPreparation = {
  readonly status: 'ready';
  readonly version: typeof PROJECT_PROVIDER_CONTEXT_VERSION;
  readonly binding: ProjectProviderContextBinding;
  /** Hash includes command, draft version, exact message and every selected memory payload. */
  readonly fingerprint: string;
  readonly durableMessageText: string;
  /** Server-side provider copy only. Never persist as the user's message.text. */
  readonly providerProjectionText: string;
  readonly records: readonly ProjectProviderContextRecord[];
} | {
  readonly status: 'unavailable';
  readonly reason: 'capacity_unverified' | 'invalid_binding' | 'invalid_memory' | 'record_too_large';
};

/** Optional server-side selector. It may return ready only after a real provider adapter verifies full-prompt capacity. */
export interface ProjectProviderContextPreparationPort {
  prepare(input: { readonly binding: ProjectProviderContextBinding;
    readonly durableMessageText: string }): Promise<ProjectProviderContextPreparation>;
}
