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
