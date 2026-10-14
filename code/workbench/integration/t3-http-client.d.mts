export interface T3ServiceConnection {
  readonly origin: string;
  readonly accessToken: string;
  readonly expiresAt: string;
}
export interface T3ServicePort { start(): Promise<T3ServiceConnection> }
export class T3TransportError extends Error {
  readonly code: string;
  readonly status?: number;
}
export class T3HttpClient {
  constructor(service: T3ServicePort, options?: { transport?: typeof fetch });
  dispatch(command: unknown): Promise<{ readonly sequence: number }>;
  createCommand(command: { readonly type: 'project.create' | 'thread.create'; readonly [key: string]: unknown }):
    Promise<{ readonly sequence: number }>;
  readReceipt(commandId: string): Promise<null | { readonly status: 'accepted' | 'rejected';
    readonly aggregateKind: 'thread' | 'project'; readonly aggregateId: string; readonly resultSequence: number }>;
  environmentDescriptor(): Promise<{ readonly environmentId: string }>;
  shellSnapshot(): Promise<unknown>;
  providerModels(instanceId?: 'codex' | 'dsh'): Promise<{ readonly providers: readonly { readonly instanceId: string;
    readonly driver: string; readonly enabled: boolean; readonly installed: boolean;
    readonly status: 'ready' | 'warning' | 'error' | 'disabled';
    readonly authStatus: 'authenticated' | 'unauthenticated' | 'unknown'; readonly checkedAt: string;
    readonly models: readonly { readonly id: string; readonly name: string; readonly reasoningEfforts?: readonly { readonly id: string; readonly name: string }[]; readonly defaultReasoningEffort?: string }[] }[] }>;
  threadSnapshot(threadId: string, turnLimit?: number, beforeCursor?: string): Promise<unknown>;
  threadEventPage(threadId: string, afterSequence: number, limit?: number): Promise<{
    readonly threadId: string; readonly afterSequence: number; readonly headSequence: number;
    readonly nextSequence: number; readonly hasMore: boolean; readonly resetRequired: boolean;
    readonly resetReason?: 'cursor_ahead' | 'gap_too_large' | 'payload_too_large';
    readonly events: readonly { readonly eventId: string; readonly sequence: number; readonly occurredAt: string;
      readonly type: string; readonly turnId?: string; readonly activityId?: string;
      readonly activityKind?: string; readonly activityTone?: 'info' | 'tool' | 'approval' | 'error';
      readonly sessionStatus?: string }[];
  }>;
}
