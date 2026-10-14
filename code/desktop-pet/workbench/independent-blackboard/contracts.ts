export interface BlackboardScope { environmentId: string; projectId: string }
export interface BlackboardParticipant {
  actorId: string; threadId: string; providerInstanceId: string; title: string;
  role: "coordinator" | "executor";
  identitySource?: "t3-original-thread-snapshot";
  nativeThreadId?: string | null;
}
export interface BlackboardEvent {
  eventId: string; operationId: string; revision: number; actorId: string;
  threadId: string; kind: "read" | "assign" | "start" | "report" | "summary";
  taskIds: string[]; observedAt: string;
}
export interface BlackboardTask {
  taskId: string; ownerActorId: string; title: string; instructions: string;
  status: "assigned" | "running" | "reported"; assignedRevision: number;
  report: { text: string; revision: number; eventId: string; actorId: string; assignmentReadEventId: string } | null;
}
export interface BlackboardRelation {
  relationId: string; kind: "assignment" | "report";
  sourceThreadId: string; targetThreadId: string; taskId: string;
  eventId: string; recordRevision: number;
}
export interface IndependentBlackboardSnapshot {
  apiVersion: "0.1.0"; source: "aaaagent-independent-blackboard";
  boardId: string; scope: BlackboardScope; revision: number; updatedAt: string;
  status: "in_progress" | "summarized"; participants: BlackboardParticipant[];
  tasks: BlackboardTask[]; relations: BlackboardRelation[]; events: BlackboardEvent[];
  summary: { text: string; reportEventIds: string[]; actorId: string; revision: number; eventId: string } | null;
}
