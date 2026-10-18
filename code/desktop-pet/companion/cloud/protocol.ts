export class CloudError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CloudError('invalid_object');
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new CloudError('unexpected_field');
}
export function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new CloudError('invalid_text');
  return value.trim();
}
export function id(value: unknown): string {
  const result = text(value, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:@-]*$/.test(result)) throw new CloudError('invalid_id');
  return result;
}
export function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new CloudError('invalid_version');
  return Number(value);
}
export interface Persona { roleId: string; name: string; persona: string; revision: number }
export interface GroupPolicy { groupId: string; enabled: boolean; shareWithOwner: boolean; replyMode: 'addressed' | 'all'; revision: number }
export interface SocialEvent {
  eventId: string; roleId: string; scope: 'group'; groupId: string;
  actorId: string; actorName: string; text: string; occurredAt: string; addressed: boolean;
}
export function parseEvent(raw: unknown): SocialEvent {
  const v = record(raw);
  fields(v, ['eventId','roleId','scope','groupId','actorId','actorName','text','occurredAt','addressed']);
  if (v.scope !== 'group' || typeof v.addressed !== 'boolean') throw new CloudError('group_events_only');
  const occurredAt = text(v.occurredAt, 32);
  if (!/^\d{4}-\d\d-\d\dT/.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) throw new CloudError('invalid_time');
  return { eventId:id(v.eventId),roleId:id(v.roleId),scope:'group',groupId:id(v.groupId),actorId:id(v.actorId),
    actorName:text(v.actorName,80),text:text(v.text,6000),occurredAt:new Date(occurredAt).toISOString(),addressed:v.addressed };
}
export interface Experience {
  id: string; roleId: string; groupId: string; summary: string; sourceEventIds: string[];
  participants: { id: string; name: string }[]; occurredAt: string; perspective: 'participated';
}
export interface SyncPage {
  version: 1; roleId: string; epoch: string; cursor: number; more: boolean;
  persona: Persona; allowedGroups: string[];
  changes: { sequence: number; kind: 'upsert' | 'delete'; id: string; experience?: Experience }[];
}
export interface SocialModelInput { persona: Persona; event: SocialEvent; history: {actorId:string;actorName:string;text:string;role:'user'|'assistant';sourceEventId?:string}[]; experiences?: Experience[]; confirmedParticipation?:{reply:string;receipt:string} }
export interface ConfirmedParticipation { event:SocialEvent; reply:string; receipt:string }
export function parseParticipation(raw:unknown):ConfirmedParticipation {
  const value=record(raw);fields(value,['event','reply','receipt']);
  return{event:parseEvent(value.event),reply:text(value.reply,1200),receipt:id(value.receipt)};
}
export interface SocialModelReply { text: string; summary: string }
export interface SocialModel { reply(input: SocialModelInput, signal: AbortSignal): Promise<SocialModelReply> }
export interface SocialReference {
  roleId: string; persona: Persona; experiences: Experience[];
  /** Locally issued revision; never accepted from an inbound social message. */
  cacheRevision: number;
}
export interface SocialContextPort {
  capture(characterId: string): SocialReference | undefined;
  assertCurrent(reference: SocialReference): void;
}
