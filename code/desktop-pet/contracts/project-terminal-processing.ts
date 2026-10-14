import type { ProjectTerminalEvidence } from './project-memory.js';

/** Provider adapters expose only a local phase: false is a proved pre-send failure. */
export class ProjectTerminalTransportError extends Error {
  constructor(readonly code: 'invalid_request' | 'credential_unavailable' | 'aborted' |
    'http_error' | 'response_too_large' | 'invalid_response' | 'transport_unknown',
  readonly requestStarted: boolean, readonly httpStatus?: number) {
    super(`project_terminal_${code}`);
    this.name = 'ProjectTerminalTransportError';
  }
}

/** Dedicated project-memory model selection. It never inherits the companion memory_turn prompt or scope. */
export interface ProjectTerminalModelSelection {
  readonly version: '0.1.0';
  readonly scope: 'project-terminal';
  readonly adapterId: string;
  readonly provider: 'deepseek' | 'dashscope';
  readonly model: string;
  readonly endpoint: string;
  readonly credentialRef: string;
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly inputMicrosPerToken: number;
  readonly outputMicrosPerToken: number;
  readonly reservationMicros: number;
  readonly timeoutMs: number;
  readonly thinking?: 'high';
}

export interface ProjectTerminalModelRequest {
  readonly evidence: ProjectTerminalEvidence;
  readonly systemText: string;
  readonly userText: string;
  /** Optional limit for one reviewed call; it cannot exceed the fixed model selection. */
  readonly maxOutputTokens?: number;
}

/** Low-level provider adapter; called only after a stable ledger reservation. It must honor signal
 * and report the supplier's finish reason rather than infer completion from parseable JSON. */
export interface ProjectTerminalModelTransport {
  complete(input: {
    readonly scope: 'project-terminal';
    readonly operationId: string;
    readonly projectId: string;
    readonly provider: 'deepseek' | 'dashscope';
    readonly model: string;
    readonly endpoint: string;
    readonly credentialFile: string;
    readonly systemText: string;
    readonly userText: string;
    readonly maxOutputTokens: number;
    readonly timeoutMs: number;
    readonly thinking?: 'high';
    readonly signal: AbortSignal;
  }): Promise<{ readonly text: string; readonly finishReason: 'stop' | 'length' | 'unknown';
    readonly usage: { readonly inputTokens: number;
    readonly outputTokens: number } | null }>;
}

export interface ProjectTerminalModelCallPort {
  /** Returns text only after an explicit supplier stop and a non-aborted response. */
  complete(input: ProjectTerminalModelRequest): Promise<string>;
}
