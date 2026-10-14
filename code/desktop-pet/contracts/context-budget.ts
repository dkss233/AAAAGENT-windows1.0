/** B55 additive public contract. Local prediction is separate from provider billed usage. */
export const CONTEXT_BUDGET_VERSION = '0.1.0' as const;
export interface TokenCountingMethod {
  readonly method: 'model_tokenizer' | 'utf8_upper_bound';
  readonly estimated: boolean;
  readonly model: string;
  readonly version: string;
}
export interface InputBudgetInfo {
  readonly targetInputTokens: number;
  readonly apiInputLimit: number;
  readonly contextWindowTokens: number | null;
  readonly reservedOutputTokens: number;
  readonly effectiveInputTokens: number;
  readonly constrainedBy: readonly ('target' | 'api_input' | 'context_window')[];
  readonly counting: TokenCountingMethod;
}
export type ContextLayer = 'required' | 'current_emotion' | 'recent' | 'summary' | 'memory' | 'historical_emotion';
export interface ContextBudgetReport extends InputBudgetInfo {
  readonly version: typeof CONTEXT_BUDGET_VERSION;
  readonly countedInputTokens: number;
  readonly selected: { readonly messages: number; readonly turns: number; readonly summaries: number; readonly memories: number; readonly historicalEmotions: number };
  readonly layers: Readonly<Record<ContextLayer, number>>;
  readonly omissions: readonly { readonly id?: string; readonly layer: ContextLayer; readonly reason: string }[];
  /** Unread rows are never assigned invented per-record recall judgments. */
  readonly unreadRecent?: boolean;
}
