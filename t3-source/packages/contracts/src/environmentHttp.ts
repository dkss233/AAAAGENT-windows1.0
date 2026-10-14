import { ModelCapabilities } from "./model.ts";
import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import {
  AuthAccessTokenResult,
  AuthBrowserSessionRequest,
  AuthBrowserSessionResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthEnvironmentScope,
  AuthTokenExchangeRequest,
  AuthSessionState,
  AuthWebSocketTicketResult,
  ServerAuthSessionMethod,
} from "./auth.ts";
import {
  DpopFailureReason,
  AuthSessionId,
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationAggregateKind,
  OrchestrationCommandReceiptStatus,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
} from "./orchestration.ts";
import {
  PullRequestDiffInput,
  PullRequestDiffResult,
  PullRequestOperationError,
  PullRequestUnavailableError,
} from "./pullRequest.ts";
import {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentLinkProof,
  RelayEnvironmentMintResponse,
  RelayLinkProofRequest,
} from "./relay.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const OptionalDpopProofHeaders = Schema.Struct({
  dpop: Schema.optionalKey(Schema.String),
});

export const EnvironmentRequestInvalidReason = Schema.Literals([
  "invalid_scope",
  "scope_not_granted",
  "invalid_command",
]);
export type EnvironmentRequestInvalidReason = typeof EnvironmentRequestInvalidReason.Type;

export const EnvironmentAuthInvalidReason = Schema.Literals([
  "missing_credential",
  "invalid_credential",
]);
export type EnvironmentAuthInvalidReason = typeof EnvironmentAuthInvalidReason.Type;

export const EnvironmentOperationForbiddenReason = Schema.Literals([
  "current_session_revoke_not_allowed",
]);
export type EnvironmentOperationForbiddenReason = typeof EnvironmentOperationForbiddenReason.Type;

export const EnvironmentInternalErrorReason = Schema.Literals([
  "bootstrap_validation_failed",
  "browser_session_issuance_failed",
  "browser_session_cookie_failed",
  "access_token_issuance_failed",
  "websocket_ticket_issuance_failed",
  "pairing_credential_issuance_failed",
  "pairing_links_load_failed",
  "pairing_link_revoke_failed",
  "client_sessions_load_failed",
  "client_session_revoke_failed",
  "orchestration_snapshot_failed",
  "orchestration_command_receipt_failed",
  "orchestration_thread_snapshot_failed",
  "orchestration_dispatch_failed",
  "internal_error",
]);
export type EnvironmentInternalErrorReason = typeof EnvironmentInternalErrorReason.Type;

export class EnvironmentRequestInvalidError extends Schema.TaggedError<EnvironmentRequestInvalidError>()(
  "EnvironmentRequestInvalidError",
  {
    code: Schema.Literal("invalid_request"),
    reason: EnvironmentRequestInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentRequestInvalidError)(this, { status: 400 });
  }

  override get message(): string {
    return `The environment rejected the request (${this.reason}).`;
  }
}

export class EnvironmentAuthInvalidError extends Schema.TaggedError<EnvironmentAuthInvalidError>()(
  "EnvironmentAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: EnvironmentAuthInvalidReason,
    // Older servers do not send a DPoP failure category.
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentAuthInvalidError)(this, { status: 401 });
  }

  override get message(): string {
    return `The environment rejected this client's credentials (${this.reason}).`;
  }
}

export class EnvironmentScopeRequiredError extends Schema.TaggedError<EnvironmentScopeRequiredError>()(
  "EnvironmentScopeRequiredError",
  {
    code: Schema.Literal("insufficient_scope"),
    requiredScope: AuthEnvironmentScope,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentScopeRequiredError)(this, { status: 403 });
  }

  override get message(): string {
    return `This request needs the ${this.requiredScope} scope, which this client does not have.`;
  }
}

export class EnvironmentOperationForbiddenError extends Schema.TaggedError<EnvironmentOperationForbiddenError>()(
  "EnvironmentOperationForbiddenError",
  {
    code: Schema.Literal("operation_forbidden"),
    reason: EnvironmentOperationForbiddenReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentOperationForbiddenError)(this, { status: 403 });
  }

  override get message(): string {
    return `The environment refused this operation (${this.reason}).`;
  }
}

export class EnvironmentInternalError extends Schema.TaggedError<EnvironmentInternalError>()(
  "EnvironmentInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: EnvironmentInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentInternalError)(this, { status: 500 });
  }

  override get message(): string {
    return `The environment failed to answer this request (${this.reason}).`;
  }
}

export const EnvironmentResourceNotFoundReason = Schema.Literals(["thread_not_found"]);
export type EnvironmentResourceNotFoundReason = typeof EnvironmentResourceNotFoundReason.Type;

export class EnvironmentResourceNotFoundError extends Schema.TaggedError<EnvironmentResourceNotFoundError>()(
  "EnvironmentResourceNotFoundError",
  {
    code: Schema.Literal("not_found"),
    reason: EnvironmentResourceNotFoundReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentResourceNotFoundError)(this, { status: 404 });
  }

  override get message(): string {
    return `The environment could not find what this request named (${this.reason}).`;
  }
}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentAuthenticationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;

export class EnvironmentHttpBadRequestError extends Schema.TaggedError<EnvironmentHttpBadRequestError>()(
  "EnvironmentHttpBadRequestError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpBadRequestError)(this, { status: 400 });
  }
}

export class EnvironmentHttpUnauthorizedError extends Schema.TaggedError<EnvironmentHttpUnauthorizedError>()(
  "EnvironmentHttpUnauthorizedError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 401 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpUnauthorizedError)(this, { status: 401 });
  }
}

export class EnvironmentHttpForbiddenError extends Schema.TaggedError<EnvironmentHttpForbiddenError>()(
  "EnvironmentHttpForbiddenError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpForbiddenError)(this, { status: 403 });
  }
}

export class EnvironmentHttpInternalServerError extends Schema.TaggedError<EnvironmentHttpInternalServerError>()(
  "EnvironmentHttpInternalServerError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpInternalServerError)(this, { status: 500 });
  }
}

export class EnvironmentHttpConflictError extends Schema.TaggedError<EnvironmentHttpConflictError>()(
  "EnvironmentHttpConflictError",
  {
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentHttpConflictError)(this, { status: 409 });
  }
}

export class EnvironmentCloudEndpointUnavailableError extends Schema.TaggedError<EnvironmentCloudEndpointUnavailableError>()(
  "EnvironmentCloudEndpointUnavailableError",
  {
    message: Schema.String,
    endpointRuntimeStatus: Schema.Unknown,
  },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(EnvironmentCloudEndpointUnavailableError)(this, {
      status: 503,
    });
  }
}
const EnvironmentSessionCreationErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentTokenExchangeErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
] as const;
const EnvironmentScopedOperationErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentPairingCredentialErrors = [
  EnvironmentRequestInvalidError,
  ...EnvironmentScopedOperationErrors,
] as const;
const EnvironmentSessionRevokeErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentOperationForbiddenError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationThreadSnapshotErrors = [
  EnvironmentScopeRequiredError,
  EnvironmentResourceNotFoundError,
  EnvironmentInternalError,
] as const;
const EnvironmentOrchestrationDispatchErrors = [
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
  EnvironmentInternalError,
] as const;

export interface EnvironmentSessionPrincipalShape {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlySet<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

export class EnvironmentAuthenticatedPrincipal extends Context.Service<
  EnvironmentAuthenticatedPrincipal,
  EnvironmentSessionPrincipalShape
>()("@t3tools/contracts/environmentHttp/EnvironmentAuthenticatedPrincipal") {}

export class EnvironmentAuthenticatedAuth extends HttpApiMiddleware.Service<
  EnvironmentAuthenticatedAuth,
  { provides: EnvironmentAuthenticatedPrincipal }
>()("EnvironmentAuthenticatedAuth", {
  error: EnvironmentAuthenticationErrors,
}) {}

const EnvironmentHttpCloudErrors = [
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentScopeRequiredError,
] as const;

export const EnvironmentCloudRelayConfigResult = Schema.Struct({
  ok: Schema.Boolean,
  endpointRuntimeStatus: Schema.Unknown,
});
export type EnvironmentCloudRelayConfigResult = typeof EnvironmentCloudRelayConfigResult.Type;

export const EnvironmentCloudLinkStateResult = Schema.Struct({
  linked: Schema.Boolean,
  cloudUserId: Schema.NullOr(Schema.String),
  relayUrl: Schema.NullOr(Schema.String),
  relayIssuer: Schema.NullOr(Schema.String),
  // A managed Cloudflare tunnel is provisioned for this link. False for a
  // publish-only link (activity publishing without a relay-managed tunnel), so
  // clients can present the two capabilities as independent settings.
  // Optional so newer clients tolerate older environment servers.
  managedTunnelActive: Schema.optional(Schema.Boolean),
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudLinkStateResult = typeof EnvironmentCloudLinkStateResult.Type;

export const EnvironmentCloudPreferencesRequest = Schema.Struct({
  publishAgentActivity: Schema.Boolean,
});
export type EnvironmentCloudPreferencesRequest = typeof EnvironmentCloudPreferencesRequest.Type;

export const AuthPairingLinkRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthPairingLinkRevokeResult = typeof AuthPairingLinkRevokeResult.Type;

export const AuthClientSessionRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthClientSessionRevokeResult = typeof AuthClientSessionRevokeResult.Type;

export const AuthOtherClientSessionsRevokeResult = Schema.Struct({
  revokedCount: Schema.Number,
});
export type AuthOtherClientSessionsRevokeResult = typeof AuthOtherClientSessionsRevokeResult.Type;

class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/t3/environment", {
    success: ExecutionEnvironmentDescriptor,
  }),
) {}

class EnvironmentAuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
      error: [EnvironmentInternalError],
    }),
  )
  .add(
    HttpApiEndpoint.post("browserSession", "/api/auth/browser-session", {
      payload: AuthBrowserSessionRequest,
      success: AuthBrowserSessionResult,
      error: EnvironmentSessionCreationErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("token", "/oauth/token", {
      headers: OptionalDpopProofHeaders,
      payload: AuthTokenExchangeRequest,
      success: AuthAccessTokenResult,
      error: EnvironmentTokenExchangeErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketTicket", "/api/auth/websocket-ticket", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTicketResult,
      error: [EnvironmentInternalError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("pairingCredential", "/api/auth/pairing-token", {
      headers: OptionalBearerHeaders,
      payload: AuthCreatePairingCredentialInput,
      success: AuthPairingCredentialResult,
      error: EnvironmentPairingCredentialErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("pairingLinks", "/api/auth/pairing-links", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthPairingLink),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokePairingLink", "/api/auth/pairing-links/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokePairingLinkInput,
      success: AuthPairingLinkRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("clients", "/api/auth/clients", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthClientSession),
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeClient", "/api/auth/clients/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeClientSessionInput,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentSessionRevokeErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeOtherClients", "/api/auth/clients/revoke-others", {
      headers: OptionalBearerHeaders,
      success: AuthOtherClientSessionsRevokeResult,
      error: EnvironmentScopedOperationErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

const EnvironmentOrchestrationThreadSnapshotParams = Schema.Struct({
  threadId: ThreadId,
});

// Query-string window for windowed thread snapshots (GET payloads must encode
// to strings). Both fields optional: omitting them keeps the full-snapshot
// behavior, so pagination stays opt-in per request.
const EnvironmentOrchestrationThreadSnapshotQuery = {
  reasoningMessages: Schema.optional(Schema.Literal("true")),
  turnLimit: Schema.optional(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  beforeCursor: Schema.optional(TrimmedNonEmptyString),
};

const EnvironmentOrchestrationReceiptParams = Schema.Struct({ commandId: CommandId });
const EnvironmentOrchestrationReceipt = Schema.NullOr(Schema.Struct({
  commandId: CommandId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  acceptedAt: IsoDateTime,
  resultSequence: NonNegativeInt,
  status: OrchestrationCommandReceiptStatus,
}));

/** A bounded, metadata-only page. Raw messages and tool payloads never leave this route. */
const EnvironmentThreadEventPage = Schema.Struct({
  threadId: ThreadId,
  afterSequence: NonNegativeInt,
  headSequence: NonNegativeInt,
  nextSequence: NonNegativeInt,
  hasMore: Schema.Boolean,
  resetRequired: Schema.Boolean,
  resetReason: Schema.optional(Schema.Literals(["cursor_ahead", "gap_too_large", "payload_too_large"])),
  events: Schema.Array(Schema.Struct({
    eventId: TrimmedNonEmptyString,
    sequence: NonNegativeInt,
    occurredAt: IsoDateTime,
    type: TrimmedNonEmptyString,
    turnId: Schema.optional(TrimmedNonEmptyString),
    activityId: Schema.optional(TrimmedNonEmptyString),
    activityKind: Schema.optional(TrimmedNonEmptyString),
    activityTone: Schema.optional(Schema.Literals(["info", "tool", "approval", "error"])),
    sessionStatus: Schema.optional(TrimmedNonEmptyString),
  })),
});
const EnvironmentThreadEventPageQuery = {
  afterSequence: Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  limit: Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(100)),
};

const EnvironmentProviderModels = Schema.Struct({
  providers: Schema.Array(Schema.Struct({
    instanceId: TrimmedNonEmptyString,
    driver: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
    installed: Schema.Boolean,
    status: Schema.Literals(["ready", "warning", "error", "disabled"]),
    authStatus: Schema.Literals(["authenticated", "unauthenticated", "unknown"]),
    checkedAt: IsoDateTime,
    models: Schema.Array(Schema.Struct({ slug: TrimmedNonEmptyString, name: TrimmedNonEmptyString, capabilities: Schema.optional(Schema.NullOr(ModelCapabilities)) })),
  })),
});

export const NativeChildFlowScope = Schema.Struct({
  environmentId: TrimmedNonEmptyString, projectId: ProjectId, parentThreadId: ThreadId,
  providerInstanceId: TrimmedNonEmptyString, nativeParentThreadId: TrimmedNonEmptyString,
});
export const NativeChildFlowNode = Schema.Struct({
  nativeThreadId: TrimmedNonEmptyString,
  parentNativeThreadId: Schema.NullOr(TrimmedNonEmptyString),
  relationship: Schema.Literals(["verified", "unknown"]),
  spawnTurnId: Schema.NullOr(TrimmedNonEmptyString),
  activityId: TrimmedNonEmptyString,
  agentPath: Schema.NullOr(Schema.String), title: Schema.String,
  model: Schema.NullOr(Schema.String), effort: Schema.NullOr(Schema.String),
  sessionStatus: Schema.NullOr(Schema.String), nativeReadStatus: Schema.NullOr(Schema.String),
  lastTurnStatus: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime, updatedAt: IsoDateTime,
});
export const NativeChildFlowRelations = Schema.Struct({
  apiVersion: Schema.Literal("0.1.0"), scope: NativeChildFlowScope,
  children: Schema.Array(NativeChildFlowNode),
});
export const NativeChildFlowConversation = Schema.Struct({
  apiVersion: Schema.Literal("0.1.0"), scope: NativeChildFlowScope, child: NativeChildFlowNode,
  complete: Schema.Literal(true), source: Schema.Literal("codex-native-thread-read"),
  // Exact native metadata, every turn and item. Display adaptation belongs to the native UI.
  nativeThread: Schema.Unknown,
});
export type NativeChildFlowScope = typeof NativeChildFlowScope.Type;
export type NativeChildFlowNode = typeof NativeChildFlowNode.Type;
export type NativeChildFlowRelations = typeof NativeChildFlowRelations.Type;
export type NativeChildFlowConversation = typeof NativeChildFlowConversation.Type;
const NativeChildFlowQuery = {
  environmentId: TrimmedNonEmptyString, projectId: ProjectId, instanceId: TrimmedNonEmptyString,
};

export const BlackboardScope = Schema.Struct({ environmentId: TrimmedNonEmptyString, projectId: ProjectId });
export const BlackboardParticipant = Schema.Struct({
  actorId: TrimmedNonEmptyString, threadId: ThreadId, providerInstanceId: TrimmedNonEmptyString,
  title: Schema.String, role: Schema.Literals(["coordinator", "executor"]),
  identitySource: Schema.optionalKey(Schema.Literal("t3-original-thread-snapshot")),
  nativeThreadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export const BlackboardEvent = Schema.Struct({
  eventId: TrimmedNonEmptyString, operationId: TrimmedNonEmptyString, revision: Schema.Number,
  actorId: TrimmedNonEmptyString, threadId: ThreadId,
  kind: Schema.Literals(["read", "assign", "start", "report", "summary"]),
  taskIds: Schema.Array(Schema.String), observedAt: Schema.String,
});
export const BlackboardTask = Schema.Struct({
  taskId: TrimmedNonEmptyString, ownerActorId: TrimmedNonEmptyString, title: Schema.String,
  instructions: Schema.String, status: Schema.Literals(["assigned", "running", "reported"]),
  assignedRevision: Schema.Number,
  report: Schema.NullOr(Schema.Struct({ text: Schema.String, revision: Schema.Number,
    eventId: TrimmedNonEmptyString, actorId: TrimmedNonEmptyString, assignmentReadEventId: TrimmedNonEmptyString })),
});
export const BlackboardRelation = Schema.Struct({
  relationId: TrimmedNonEmptyString, kind: Schema.Literals(["assignment", "report"]),
  sourceThreadId: ThreadId, targetThreadId: ThreadId, taskId: TrimmedNonEmptyString,
  eventId: TrimmedNonEmptyString, recordRevision: Schema.Number,
});
export const IndependentBlackboardSnapshot = Schema.Struct({
  apiVersion: Schema.Literal("0.1.0"), source: Schema.Literal("aaaagent-independent-blackboard"),
  boardId: TrimmedNonEmptyString, scope: BlackboardScope, revision: Schema.Number, updatedAt: Schema.String,
  status: Schema.Literals(["in_progress", "summarized"]), participants: Schema.Array(BlackboardParticipant),
  tasks: Schema.Array(BlackboardTask), relations: Schema.Array(BlackboardRelation), events: Schema.Array(BlackboardEvent),
  summary: Schema.NullOr(Schema.Struct({ text: Schema.String, reportEventIds: Schema.Array(Schema.String),
    actorId: TrimmedNonEmptyString, revision: Schema.Number, eventId: TrimmedNonEmptyString })),
});
export type BlackboardScope = typeof BlackboardScope.Type;
export type BlackboardParticipant = typeof BlackboardParticipant.Type;
export type BlackboardEvent = typeof BlackboardEvent.Type;
export type BlackboardTask = typeof BlackboardTask.Type;
export type BlackboardRelation = typeof BlackboardRelation.Type;
export type IndependentBlackboardSnapshot = typeof IndependentBlackboardSnapshot.Type;

export class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(HttpApiEndpoint.get("independentBlackboard", "/api/orchestration/projects/:projectId/independent-blackboard", {
    headers: OptionalBearerHeaders, params: Schema.Struct({ projectId: ProjectId }),
    payload: { environmentId: TrimmedNonEmptyString }, success: IndependentBlackboardSnapshot,
    error: EnvironmentOrchestrationThreadSnapshotErrors,
  }).middleware(EnvironmentAuthenticatedAuth))
  .add(HttpApiEndpoint.get("nativeChildRelations", "/api/orchestration/threads/:threadId/native-children", {
    headers: OptionalBearerHeaders, params: EnvironmentOrchestrationThreadSnapshotParams,
    payload: NativeChildFlowQuery, success: NativeChildFlowRelations,
    error: EnvironmentOrchestrationThreadSnapshotErrors,
  }).middleware(EnvironmentAuthenticatedAuth))
  .add(HttpApiEndpoint.get("nativeChildConversation", "/api/orchestration/threads/:threadId/native-children/:childId", {
    headers: OptionalBearerHeaders, params: Schema.Struct({ threadId: ThreadId, childId: TrimmedNonEmptyString }),
    payload: NativeChildFlowQuery, success: NativeChildFlowConversation,
    error: EnvironmentOrchestrationThreadSnapshotErrors,
  }).middleware(EnvironmentAuthenticatedAuth))
  .add(
    HttpApiEndpoint.get("providerModels", "/api/orchestration/provider-models", {
      headers: OptionalBearerHeaders,
      query: { instanceId: Schema.optional(Schema.Literals(["codex", "dsh"])) },
      success: EnvironmentProviderModels,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("snapshot", "/api/orchestration/snapshot", {
      headers: OptionalBearerHeaders,
      success: OrchestrationReadModel,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("shellSnapshot", "/api/orchestration/shell", {
      headers: OptionalBearerHeaders,
      success: OrchestrationShellSnapshot,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("commandReceipt", "/api/orchestration/commands/:commandId/receipt", {
      headers: OptionalBearerHeaders,
      params: EnvironmentOrchestrationReceiptParams,
      success: EnvironmentOrchestrationReceipt,
      error: EnvironmentOrchestrationSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadSnapshot", "/api/orchestration/threads/:threadId", {
      headers: OptionalBearerHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      payload: EnvironmentOrchestrationThreadSnapshotQuery,
      success: OrchestrationThreadDetailSnapshot,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("threadEventPage", "/api/orchestration/threads/:threadId/events", {
      headers: OptionalBearerHeaders,
      params: EnvironmentOrchestrationThreadSnapshotParams,
      payload: EnvironmentThreadEventPageQuery,
      success: EnvironmentThreadEventPage,
      error: EnvironmentOrchestrationThreadSnapshotErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("dispatch", "/api/orchestration/dispatch", {
      headers: OptionalBearerHeaders,
      payload: ClientOrchestrationCommand,
      success: DispatchResult,
      error: EnvironmentOrchestrationDispatchErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/** Large, compressible pull-request payloads travel over HTTP rather than the RPC socket. */
class EnvironmentPullRequestsHttpApi extends HttpApiGroup.make("pullRequests").add(
  HttpApiEndpoint.post("diff", "/api/pull-requests/diff", {
    headers: OptionalBearerHeaders,
    payload: PullRequestDiffInput,
    success: PullRequestDiffResult,
    error: [
      PullRequestUnavailableError,
      PullRequestOperationError,
      EnvironmentAuthInvalidError,
      EnvironmentScopeRequiredError,
      EnvironmentInternalError,
    ],
  }).middleware(EnvironmentAuthenticatedAuth),
) {}

class EnvironmentConnectHttpApi extends HttpApiGroup.make("connect")
  .add(
    HttpApiEndpoint.post("linkProof", "/api/connect/link-proof", {
      headers: OptionalBearerHeaders,
      payload: RelayLinkProofRequest,
      success: RelayEnvironmentLinkProof,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("relayConfig", "/api/connect/relay-config", {
      headers: OptionalBearerHeaders,
      payload: RelayEnvironmentConfigRequest,
      success: EnvironmentCloudRelayConfigResult,
      error: [...EnvironmentHttpCloudErrors, EnvironmentCloudEndpointUnavailableError],
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.get("linkState", "/api/connect/link-state", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("unlink", "/api/connect/unlink", {
      headers: OptionalBearerHeaders,
      success: EnvironmentCloudRelayConfigResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("preferences", "/api/connect/preferences", {
      headers: OptionalBearerHeaders,
      payload: EnvironmentCloudPreferencesRequest,
      success: EnvironmentCloudLinkStateResult,
      error: EnvironmentHttpCloudErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("health", "/api/t3-connect/health", {
      payload: RelayCloudEnvironmentHealthRequest,
      success: RelayEnvironmentHealthResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("mintCredential", "/api/connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("t3MintCredential", "/api/t3-connect/mint-credential", {
      payload: RelayCloudMintCredentialRequest,
      success: RelayEnvironmentMintResponse,
      error: EnvironmentHttpCloudErrors,
    }),
  ) {}

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi)
  .add(EnvironmentPullRequestsHttpApi)
  .add(EnvironmentConnectHttpApi) {}
