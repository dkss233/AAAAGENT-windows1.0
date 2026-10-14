/** B54 project knowledge is separate from companion memory and T3 raw event storage. */
import type { WorkbenchTaskRef } from './workbench.js';

export const PROJECT_MEMORY_CONTRACT_VERSION = '0.1.6' as const;
/** Queue identity for the first bounded T3 terminal-material extraction path. */
export const PROJECT_TERMINAL_EXTRACTION_VERSION = 'b54-t3-terminal-v1' as const;

/** Fixed T3 read-only metadata, produced with the message window in one SQL snapshot. */
export interface ProjectTurnMessageBindings {
  readonly version: 1;
  readonly snapshotSequence: number;
  readonly threadId: string;
  readonly projectId: string;
  readonly providerInstanceId: string;
  readonly turns: readonly {
    readonly turnId: string;
    readonly userMessageId: string | null;
    readonly assistantMessageId: string | null;
    readonly state: 'running' | 'completed' | 'error' | 'interrupted';
    readonly completedAt: string | null;
    /** Every user/assistant message linked by turn_id or the exact pending_message_id. */
    readonly messageIds: readonly string[];
  }[];
}

export interface ProjectMemorySource {
  readonly taskId?: string;
  readonly nativeTurnId?: string;
  readonly terminalEventId?: string;
  readonly artifactRef?: string;
  readonly userInputId?: string;
  readonly recordedAt: string;
}

export interface ProjectMemoryItem {
  readonly id: string;
  readonly projectId: string;
  readonly kind: 'decision' | 'constraint' | 'fact' | 'open_question';
  readonly text: string;
  /** Model suggestions begin as candidates; only evidence or an explicit user decision may promote them. */
  readonly status: 'candidate' | 'accepted' | 'withdrawn';
  readonly version: number;
  readonly sources: readonly ProjectMemorySource[];
  readonly branchRef?: string;
  readonly condition?: string;
  readonly supersededById?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectMemoryQuery {
  readonly projectId: string;
  readonly text?: string;
  readonly branchRef?: string;
  readonly limit: number;
  readonly includeCandidates?: boolean;
  /** Optional context ranking over all eligible project rows, before applying limit. */
  readonly relevance?: {
    readonly currentText: string;
    readonly newestUserText: string;
  };
}

export type ProjectMemoryChange = {
  readonly operationId: string;
  readonly type: 'create';
  readonly projectId: string;
  readonly kind: ProjectMemoryItem['kind'];
  readonly text: string;
  readonly status: 'candidate' | 'accepted';
  readonly sources: readonly ProjectMemorySource[];
  readonly branchRef?: string;
  readonly condition?: string;
} | {
  readonly operationId: string;
  readonly type: 'edit';
  readonly projectId: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly text: string;
  /** Null clears an optional scope field. */
  readonly kind?: ProjectMemoryItem['kind'];
  readonly branchRef?: string | null;
  readonly condition?: string | null;
  readonly source?: ProjectMemorySource;
} | {
  readonly operationId: string;
  readonly type: 'accept' | 'withdraw';
  readonly projectId: string;
  readonly id: string;
  readonly expectedVersion: number;
  readonly source?: ProjectMemorySource;
};

export interface ProjectMemoryChangeResult {
  readonly operationId: string;
  readonly state: 'applied' | 'conflict' | 'rejected';
  readonly item?: ProjectMemoryItem;
  readonly detail?: string;
}

/** Processing runs after the engineering result is available and is idempotent by event/version. */
export interface ProjectTerminalEvidence {
  readonly projectId: string;
  readonly taskId: string;
  readonly nativeTurnId: string;
  readonly terminalEventId: string;
  readonly terminalPhase: 'completed' | 'failed' | 'cancelled';
  readonly resultRef?: string;
  readonly occurredAt: string;
  readonly extractionVersion: string;
}

/** Exact native turn text, read only after its persisted terminal identity is verified. */
export interface ProjectTerminalMaterial {
  readonly version: '0.1.0';
  readonly evidence: ProjectTerminalEvidence;
  readonly userMessages: readonly { readonly id: string; readonly text: string }[];
  /** Provider output is source text, never proof that a claimed action happened. */
  readonly assistantMessage?: { readonly id: string; readonly text: string };
  readonly source: 't3_thread_detail';
}

export interface ProjectTerminalMaterialPort {
  readTerminalMaterial(evidence: ProjectTerminalEvidence): Promise<ProjectTerminalMaterial>;
}

/** Complete, non-streaming user/assistant text from the selected native task, in turn order. */
export interface ProjectRecentTurn {
  readonly nativeTurnId: string;
  readonly messages: readonly { readonly id: string; readonly role: 'user' | 'assistant';
    readonly text: string; readonly createdAt: string }[];
}

export interface ProjectRecentWindow {
  readonly version: '0.1.0';
  readonly projectId: string;
  readonly taskId: string;
  readonly environmentId: string;
  readonly threadId: string;
  /** Derived from the verified native thread; callers cannot choose another branch. */
  readonly branchRef: string | null;
  readonly snapshotSequence: number;
  readonly turns: readonly ProjectRecentTurn[];
  /** T3 has older pages; their content has not been read or silently summarized. */
  readonly hasOlder: boolean;
}

export interface ProjectRecentTurnPort {
  readRecentProjectTurns(projectId: string, taskId: string): Promise<ProjectRecentWindow>;
}

/** Supplied by a configured provider adapter, not guessed from a model name or T3 connection. */
export interface ProjectProviderInputBudget {
  readonly source: 'verified_provider_configuration';
  readonly providerInstanceId: string;
  readonly modelId: string;
  readonly maxInputUtf8Bytes: number;
  /** System instructions, tool definitions and framing already consume this space. */
  readonly fixedOverheadUtf8Bytes: number;
}

export interface ProjectContextInput {
  readonly projectId: string;
  readonly taskId: string;
  readonly task: WorkbenchTaskRef & { readonly origin: 't3' };
  readonly current: { readonly messageId: string; readonly text: string };
  readonly recent: ProjectRecentWindow;
  readonly budget: ProjectProviderInputBudget;
  readonly branchRef?: string;
}

export type ProjectContextResult = {
  readonly status: 'ready';
  readonly projectId: string;
  readonly taskId: string;
  readonly currentMessageId: string;
  readonly recentTurns: readonly ProjectRecentTurn[];
  readonly memories: readonly ProjectMemoryItem[];
  readonly usedUtf8Bytes: number;
  readonly hasOlderNativeHistory: boolean;
  /** Number omitted from the already read recent window, not unknown older pages. */
  readonly omittedOlderTurns: number;
  readonly omittedMemories: number;
} | {
  readonly status: 'over_budget';
  readonly reason: 'current_input' | 'newest_complete_turn';
  readonly projectId: string;
  readonly taskId: string;
  readonly currentMessageId: string;
};

/** Assembler runs only after current input, exact task and consecutive recent turns are fixed. */
export interface ProjectContextAssemblerPort {
  assemble(input: ProjectContextInput): Promise<ProjectContextResult>;
}

export interface ProjectMemoryJob {
  readonly id: string;
  readonly projectId: string;
  readonly evidence: ProjectTerminalEvidence;
  readonly state: 'queued' | 'running' | 'failed' | 'done';
  readonly attempts: number;
  readonly errorCode: 'extraction_failed' | 'interrupted' | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProjectMemoryPort {
  list(query: ProjectMemoryQuery): Promise<readonly ProjectMemoryItem[]>;
  get(projectId: string, id: string): Promise<ProjectMemoryItem | null>;
  /** Returns retrieval-eligible entries for the selected project only. */
  recall(query: ProjectMemoryQuery): Promise<readonly ProjectMemoryItem[]>;
  change(input: ProjectMemoryChange): Promise<ProjectMemoryChangeResult>;
  /** Schedules or identifies one background extraction; it does not delay the task result. */
  enqueueTerminal(input: ProjectTerminalEvidence): Promise<{ readonly jobId: string; readonly state: 'queued' | 'already_queued' }>;
  getJob(projectId: string, jobId: string): Promise<ProjectMemoryJob | null>;
  listJobs(projectId: string, limit?: number): Promise<readonly ProjectMemoryJob[]>;
  retryJob(projectId: string, jobId: string): Promise<ProjectMemoryJob>;
  /** Call only after the old worker is stopped. */
  recoverInterruptedJobs(): Promise<number>;
  close(): Promise<void>;
}
