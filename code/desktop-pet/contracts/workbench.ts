/** B54 bridge vocabulary. T3 remains the authority for its threads, turns and events. */
export const WORKBENCH_CONTRACT_VERSION = '0.1.13' as const;

export type WorkProvider = 'codex' | 'dsh';

/** Stable local reference. Titles and matching directory names never identify a task. */
export type WorkbenchTaskRef = {
  readonly id: string;
  /** Stable AAAAGENT project-index ID. */
  readonly projectId: string;
  readonly provider: WorkProvider;
  readonly origin: 't3';
  readonly environmentId: string;
  /** Native T3 project ID; it may differ from the AAAAGENT project-index ID. */
  readonly t3ProjectId: string;
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly nativeSessionId?: string;
} | {
  readonly id: string;
  readonly projectId: string;
  readonly provider: 'codex';
  readonly origin: 'legacy_codex_app';
  readonly hostId: string;
  readonly nativeSessionId: string;
} | {
  readonly id: string;
  readonly projectId: string;
  readonly provider: 'dsh';
  readonly origin: 'legacy_dsh';
  readonly profileId: string;
  readonly nativeSessionId: string;
};

export interface WorkbenchInputOrigin {
  readonly channel: 'desktop' | 'web' | 'wechat';
  readonly channelSessionId: string;
  readonly messageId: string;
  /** Bind to the existing companion turn when the desktop owns this input. */
  readonly turnScope?: import('./index.js').TurnScope;
}

export interface WorkbenchInput {
  readonly inputId: string;
  readonly origin: WorkbenchInputOrigin;
  readonly rawText: string;
  /** The exact reviewed text sent to a provider; never replace rawText. */
  readonly dispatchText: string;
  readonly createdAt: string;
  /** Ordered task-space dialogue; rawText and the originating input remain immutable. */
  readonly conversation?: readonly { readonly role: 'user' | 'assistant'; readonly text: string;
    readonly origin: WorkbenchInputOrigin }[];
}

/** Echo only after the exact native card was fully presented; captured before text/ASR work. */
export interface WorkbenchVoiceBinding {
  readonly version: '0.1.0';
  readonly projectId: string;
  readonly taskId: string;
  readonly focusRevision: number;
  readonly draftId: string;
  readonly draftVersion: number;
  readonly commandId: string;
}

/** Host-owned exact project/model choice; never synthesized by the renderer or an interpretation model. */
export interface DesktopCoordinatorProfile {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly operationId: string;
  readonly title: string;
  readonly modelSelection: { readonly instanceId: 'codex'; readonly model: string; readonly reasoningEffort: string };
  readonly existingTaskId?: string;
  readonly confirmedFirstTurn?: {
    readonly authorizationId: string;
    readonly authType: 'chatgpt'; readonly maxTurns: 1; readonly automaticRetries: 0;
  };
  readonly independentGroup?: DesktopIndependentGroupProfile;
}

/** Explicit host configuration. Missing execution choice or grant leaves the original board unopened. */
export interface DesktopIndependentGroupProfile {
  readonly operationId: string;
  readonly coordinatorBranch: string | null;
  readonly members: readonly {
    readonly actorId: 'A' | 'B'; readonly taskId: string; readonly title: string;
    readonly workspaceRoot: string; readonly branch: string;
    readonly model: string; readonly reasoningEffort: string;
    readonly writablePaths: readonly string[];
  }[];
  readonly coordinatorExecution: null | {
    readonly model: string; readonly reasoningEffort: string;
    readonly runtimeMode: 'approval-required' | 'auto-accept-edits';
  };
  readonly dispatchAuthorization: null | {
    readonly authorizationId: string; readonly maxDispatches: number;
  } & ({ readonly expiresAt: string } | { readonly validityFromFirstConfirmationMs: number });
}
export interface DesktopIndependentGroupState {
  readonly operationId: string;
  readonly stage: 'metadata_ready' | 'waiting_coordinator_mode' | 'waiting_coordinator_idle' | 'waiting_first_confirmation' | 'unavailable' | 'registered' | 'unknown';
  readonly boardId?: string;
  readonly coordinatorContextFile?: string;
  readonly coordinatorClientPath?: string;
}
export interface DesktopIndependentGroupPort {
  available(): boolean;
  register(input: unknown): Promise<unknown>;
  readRegistration(scope: { readonly environmentId: string; readonly projectId: string }): Promise<unknown>;
}

/** Each channel keeps its own focus. The backend checks version before an action. */
export interface WorkbenchFocus {
  readonly ownerId: string;
  readonly channel: WorkbenchInputOrigin['channel'];
  readonly channelSessionId: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly pendingInteractionId?: string;
  readonly version: number;
  readonly updatedAt: string;
}

export type WorkbenchInteraction = {
  readonly id: string;
  readonly taskId: string;
  /** Native durable ID when the provider has one; DSH gateway event IDs are not durable IDs. */
  readonly nativeRequestId?: string;
  readonly liveEventId?: string;
  readonly transportGeneration?: string;
  readonly answerLifetime: 'durable' | 'live_only';
  readonly nativeTurnId?: string;
  readonly version: number;
  readonly state: 'pending' | 'answered' | 'expired' | 'unknown';
  readonly kind: 'approval';
  readonly summary: string;
  /** T3's own fallback is used only when no provider choices were supplied. */
  readonly choiceSource?: 'provider' | 't3_default';
  readonly choices: readonly { readonly id: string; readonly label: string; readonly warning?: string }[];
} | {
  readonly id: string;
  readonly taskId: string;
  readonly nativeRequestId?: string;
  readonly liveEventId?: string;
  readonly transportGeneration?: string;
  readonly answerLifetime: 'durable' | 'live_only';
  readonly nativeTurnId?: string;
  readonly version: number;
  readonly state: 'pending' | 'answered' | 'expired' | 'unknown';
  readonly kind: 'question';
  readonly questions: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
    readonly allowMultiple?: boolean;
    readonly allowCustomAnswer?: boolean;
  }[];
};

/** Command ID is stable across transport retries; a timeout never authorizes a second action. */
export type WorkbenchCommand = {
  readonly commandId: string;
  readonly type: 'start';
  readonly projectId: string;
  readonly provider: WorkProvider;
  readonly input: WorkbenchInput;
  readonly draftId: string;
  readonly expectedDraftVersion: number;
} | {
  readonly commandId: string;
  readonly type: 'continue';
  readonly taskId: string;
  readonly input: WorkbenchInput;
} | {
  readonly commandId: string;
  readonly type: 'answer_question';
  readonly taskId: string;
  readonly interactionId: string;
  readonly expectedVersion: number;
  readonly answers: readonly { readonly questionId: string; readonly selectedOptionIds: readonly string[]; readonly customText?: string }[];
} | {
  readonly commandId: string;
  readonly type: 'decide_approval';
  readonly taskId: string;
  readonly interactionId: string;
  readonly expectedVersion: number;
  readonly choiceId: string;
} | {
  readonly commandId: string;
  readonly type: 'stop_turn';
  readonly taskId: string;
  readonly nativeTurnId: string;
};

export type WorkbenchTaskPhase =
  | 'recorded' | 'accepted' | 'running' | 'waiting_approval' | 'waiting_answer'
  | 'completed' | 'failed' | 'cancelled' | 'unknown';

/** Read-only channel view. A null projection is not proof that a task has not run. */
export interface WorkbenchChannelProjection {
  readonly taskId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly phase: WorkbenchTaskPhase;
  readonly nativeTurnId?: string;
  readonly resultRef?: string;
}

export interface WorkbenchChannelTaskRead {
  readonly task: WorkbenchTaskRef;
  readonly projection: WorkbenchChannelProjection | null;
  /** Bounded plain text from this exact completed turn's final assistant message; never a command receipt. */
  readonly resultPreview?: { readonly nativeTurnId: string; readonly messageId: string;
    readonly text: string; readonly truncated: boolean };
}

/** Existing management service satisfies this port; no command or provider turn is exposed. */
export interface WorkbenchChannelReadPort {
  listTasks(projectId: string): Promise<{ readonly tasks: readonly WorkbenchChannelTaskRead[] }>;
  refreshTask(taskId: string): Promise<WorkbenchChannelTaskRead & { readonly projection: WorkbenchChannelProjection }>;
}

/** Fixed T3 event metadata only. It never contains message, approval or tool body text. */
export interface WorkbenchNativeEventMeta {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: string;
  readonly turnId?: string;
  readonly activityId?: string;
  readonly activityKind?: string;
  readonly activityTone?: 'info' | 'tool' | 'approval' | 'error';
  readonly sessionStatus?: string;
}

/** A reset means events were not completely replayed; refresh the native task before notifying. */
export interface WorkbenchTaskEventPage {
  readonly status: 'supported' | 'unsupported';
  readonly task: WorkbenchTaskRef;
  readonly afterSequence: number;
  readonly headSequence: number;
  readonly nextSequence: number;
  readonly hasMore: boolean;
  readonly resetRequired: boolean;
  readonly resetReason?: 'cursor_ahead' | 'gap_too_large' | 'payload_too_large';
  readonly events: readonly WorkbenchNativeEventMeta[];
}

/** Persisted task references requiring a cold native refresh; scan does not execute or send. */
export interface WorkbenchRecoverableTaskPage {
  readonly tasks: readonly WorkbenchTaskRef[];
  readonly nextCursor: string | null;
}

/** Channel cursors and delivery ledgers remain channel-owned. */
export interface WorkbenchChannelEventReadPort {
  readTaskEventPage(taskId: string, afterSequence: number, limit?: number): Promise<WorkbenchTaskEventPage>;
  scanRecoverableTasks(cursor?: string, limit?: number): WorkbenchRecoverableTaskPage;
}

/** A reviewed continuation keeps the original message and the exact native target. */
export interface WorkbenchContinuationDraft {
  readonly id: string;
  readonly version: number;
  readonly state: 'open' | 'claimed' | 'dismissed';
  readonly task: Extract<WorkbenchTaskRef, { readonly origin: 't3' }>;
  readonly input: WorkbenchInput;
  readonly commandId: string;
}

/** Channel adapters provide their own same-session focus and call this port only for a selected task. */
export interface WorkbenchChannelCommandPort extends WorkbenchChannelReadPort {
  prepareContinuation(taskId: string, input: WorkbenchInput): Promise<WorkbenchContinuationDraft>;
  /** Read the original and reviewed text for the exact channel session without sending a command. */
  readContinuationDraft(draftId: string, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string): WorkbenchContinuationDraft;
  reviseContinuation(draftId: string, expectedVersion: number, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string, dispatchText: string): WorkbenchContinuationDraft;
  dismissContinuation(draftId: string, expectedVersion: number, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string): WorkbenchContinuationDraft;
  confirmContinuation(draftId: string, expectedVersion: number, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string): Promise<WorkbenchCommandResult>;
  readContinuation(draftId: string, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string): Promise<WorkbenchCommandResult>;
}

/** Management browser focus is scoped by a server-issued profile cookie and exact local project ID. */
export interface WorkbenchWebFocus {
  readonly version: '0.1.0';
  readonly projectId: string;
  readonly revision: number;
  readonly task: WorkbenchTaskRef | null;
}

/** One local desktop selection, independent of the browser profile and WeChat session. */
export interface WorkbenchDesktopFocus {
  readonly version: '0.1.0';
  readonly revision: number;
  readonly projectId: string | null;
  readonly task: WorkbenchTaskRef | null;
}

/** Native-shell input uses this read/confirm surface; command identity stays in workbench.sqlite. */
export type WorkbenchDesktopAction =
  | { readonly type: 'select'; readonly projectId: string | null;
      readonly taskId: string | null; readonly expectedRevision: number }
  | { readonly type: 'prepare'; readonly projectId: string; readonly taskId: string;
      readonly expectedFocusRevision: number; readonly messageId: string;
      readonly rawText: string; readonly dispatchText: string }
  | { readonly type: 'revise'; readonly draftId: string; readonly expectedVersion: number;
      readonly dispatchText: string }
  | { readonly type: 'dismiss'; readonly draftId: string; readonly expectedVersion: number }
  | { readonly type: 'confirm'; readonly draftId: string;
      readonly expectedVersion: number }
  | { readonly type: 'select_draft'; readonly draftId: string }
  | { readonly type: 'respond_interaction'; readonly projectId: string; readonly taskId: string;
      readonly expectedFocusRevision: number; readonly interactionId: string;
      readonly expectedVersion: number; readonly response: WorkbenchInteractionResponse }
  | { readonly type: 'read_interaction'; readonly projectId: string; readonly taskId: string;
      readonly expectedFocusRevision: number; readonly interactionId: string }
  | { readonly type: 'refresh'; readonly projectQuery?: string };

/** Additive desktop projection; response content never enters the receipt or persisted state. */
export interface WorkbenchDesktopNativeState {
  readonly status: 'no_target' | 'supported' | 'unsupported' | 'unverified' | 'unavailable';
  readonly task: WorkbenchTaskRef | null;
  readonly interactions: readonly WorkbenchInteraction[];
  readonly bindingsStatus: 'unavailable' | 'supported' | 'unsupported';
  readonly bindings: readonly WorkbenchInteractionBindingSummary[];
  readonly selectedInteractionId: string | null;
  readonly command?: WorkbenchInteractionCommandRead;
  readonly error?: string;
}

export interface WorkbenchDesktopState {
  readonly version: '0.1.0';
  readonly sequence: number;
  readonly readAvailable: boolean;
  readonly dispatchEnabled: boolean;
  readonly focus: WorkbenchDesktopFocus;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly projectsTruncated: boolean;
  readonly tasks: readonly WorkbenchChannelTaskRead[];
  readonly drafts: readonly WorkbenchContinuationDraft[];
  readonly draftsTruncated: boolean;
  readonly selectedDraftId: string | null;
  /** A candidate binding; the renderer may echo it only after presenting the complete selected card. */
  readonly voiceBinding?: WorkbenchVoiceBinding;
  readonly independentGroup?: DesktopIndependentGroupState;
  /** A command is a receipt readback, never permission to retry the send. */
  readonly command?: WorkbenchCommandResult;
  /** Older desktop renderers ignore this optional field until their native-interaction UI is installed. */
  readonly native?: WorkbenchDesktopNativeState;
  readonly error?: string;
}

export interface WorkbenchTaskEvent {
  readonly eventId: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly phase: WorkbenchTaskPhase;
  readonly observedAt: string;
  readonly nativeSessionId?: string;
  readonly nativeTurnId?: string;
  readonly nativeEventId?: string;
  readonly interactionId?: string;
  readonly resultRef?: string;
  readonly detail?: string;
  readonly evidence: 't3_event' | 'native_read' | 'legacy_receipt';
}

/** Only protocol- or live-verified operations may become actionable in the UI. */
export interface WorkbenchCapability {
  readonly operation: 'create' | 'resume' | 'read' | 'continue' | 'answer_question' | 'decide_approval' | 'stop_turn';
  readonly status: 'supported' | 'unsupported' | 'unverified';
  readonly evidence: 'source_only' | 'isolated_protocol' | 'live_verified';
  readonly version: string;
  readonly detail?: string;
}

export interface WorkbenchCommandResult {
  readonly commandId: string;
  readonly state: 'recorded' | 'accepted' | 'conflict' | 'unsupported' | 'unknown';
  readonly task?: WorkbenchTaskRef;
  readonly event?: WorkbenchTaskEvent;
  readonly detail?: string;
}

/** Command acceptance and provider resolution are separate facts. */
export interface WorkbenchInteractionCommandRead {
  readonly command: WorkbenchCommandResult;
  readonly resolution: 'pending' | 'answered' | 'expired' | 'unknown';
  readonly interaction?: WorkbenchInteraction;
}

/** Server-persisted locator for a response already claimed; it contains no answer text. */
export interface WorkbenchInteractionBindingSummary {
  readonly interactionId: string;
  readonly commandId: string;
  readonly kind: 'approval' | 'question';
  readonly requestVersion: number;
}

export type WorkbenchInteractionResponse = {
  readonly type: 'decide_approval';
  readonly choiceId: string;
} | {
  readonly type: 'answer_question';
  readonly answers: readonly { readonly questionId: string;
    readonly selectedOptionIds: readonly string[]; readonly customText?: string }[];
};

/** Only exact T3 Codex requests are actionable; legacy/DSH and exact-turn stop stay gated. */
export interface WorkbenchNativeInteractionPort {
  listNativeInteractions(projectId: string, taskId: string): Promise<{
    readonly status: 'supported' | 'unsupported' | 'unverified';
    readonly task: WorkbenchTaskRef;
    readonly interactions: readonly WorkbenchInteraction[];
  }>;
  respondNativeInteraction(projectId: string, taskId: string, interactionId: string,
    expectedVersion: number, response: WorkbenchInteractionResponse): Promise<WorkbenchInteractionCommandRead>;
  readNativeInteractionCommand(commandId: string): Promise<WorkbenchInteractionCommandRead>;
  listNativeInteractionBindings(projectId: string, taskId: string): Promise<{
    readonly status: 'supported' | 'unsupported';
    readonly task: WorkbenchTaskRef;
    readonly bindings: readonly WorkbenchInteractionBindingSummary[];
  }>;
  readNativeInteractionCommandForTask(projectId: string, taskId: string,
    interactionId: string): Promise<WorkbenchInteractionCommandRead>;
}

/** Full native UI navigation; never dispatches or approves a task. */
export type WorkbenchNativeOpenInput = {
  readonly target: 'home' | 'project' | 'task';
  readonly projectId?: string;
  readonly taskId?: string;
  readonly expectedFocusRevision?: number;
};
export interface WorkbenchNativeBrowserPort {
  openBrowser(target: { readonly kind: 'home' | 'project' | 'task'; readonly environmentId: string;
    readonly t3ProjectId?: string; readonly workspaceRoot?: string; readonly threadId?: string;
    readonly providerInstanceId?: string }, options?: { readonly returnToOriginalManagement: true }):
    Promise<{ readonly url: string; readonly expiresAt: string;
      readonly originalManagementReturn?: { readonly version: '0.1.1'; readonly origin: string; readonly environmentId: string;
        readonly path: '/'; readonly navigationId: string } }>;
}
