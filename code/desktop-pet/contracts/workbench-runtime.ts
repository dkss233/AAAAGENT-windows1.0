import type { WorkbenchContinuationDraft } from './workbench.js';

/** Optional bounded admission; the durable command ledger still owns at-most-once dispatch. */
export interface WorkbenchTurnAuthorization {
  available(): boolean;
  allows(draft: WorkbenchContinuationDraft, nativeThread: unknown): boolean;
}

export interface SingleCodexContinuationAuthorization {
  readonly version: 1;
  readonly kind: 'single-codex-continuation';
  readonly draftId: string;
  readonly draftVersion: number;
  readonly commandId: string;
  readonly task: WorkbenchContinuationDraft['task'];
  readonly inputSha256: string;
  readonly modelId: string;
  readonly expiresAt: string;
  readonly authType: 'chatgpt';
  readonly maxTurns: 1;
  readonly automaticRetries: 0;
}

/** One exact confirmed continuation of an already completed original Codex thread. */
export interface ExistingCodexContinuationAuthorization extends Omit<SingleCodexContinuationAuthorization, 'kind'> {
  readonly kind: 'single-codex-existing-thread';
  readonly expectedLatestTurnId: string;
  readonly runtimeMode: 'approval-required' | 'auto-accept-edits';
  readonly interactionMode: 'default';
  readonly reasoningEffort: string;
}

/** A separate DeepSeek authorization; Codex subscription admission never enables this route. */
export interface SingleDshContinuationAuthorization {
  readonly version: 1;
  readonly kind: 'single-dsh-continuation';
  readonly draftId: string;
  readonly draftVersion: number;
  readonly commandId: string;
  readonly task: WorkbenchContinuationDraft['task'];
  readonly inputSha256: string;
  readonly modelId: string;
  readonly reasoningEffort: string;
  readonly expiresAt: string;
  readonly authType: 'native-deepseek-api';
  readonly sourceRevision: string;
  readonly configurationSha256: string;
  readonly budget: { readonly batchId: string; readonly mode: 'unlimited'; readonly limitMicros: null };
  readonly maxTurns: 1;
  readonly automaticRetries: 0;
}
