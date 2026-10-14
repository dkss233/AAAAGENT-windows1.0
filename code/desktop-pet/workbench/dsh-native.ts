import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { WorkbenchTaskEvent } from '../contracts/workbench.js';

export type DshMethod = 'session/list' | 'session/page' | 'session/create' | 'session/prompt';
export interface DshSessionRpc { call(method: DshMethod, args: object): Promise<unknown> }

type NativeEvent = { readonly seq: number; readonly type: string; readonly data: unknown };
type Summary = { readonly sessionId: string; readonly running: boolean; readonly parentSessionId?: string;
  readonly origin?: string; readonly projections?: { readonly asOfSeq: number; readonly values?: Record<string, unknown> } };
const nativeId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Stable new-session identity for a T3 thread; never infer from its title or cwd. */
export function dshSessionIdForThread(environmentId: string, threadId: string): string {
  return 't3_' + createHash('sha256').update(JSON.stringify([environmentId, threadId])).digest('hex').slice(0, 40);
}

/** Must be called only after the workbench command ID and text were durably bound. */
export async function dispatchDshPrompt(rpc: DshSessionRpc, sessionId: string, requestId: string, text: string): Promise<void> {
  if (!nativeId(sessionId) || !nativeId(requestId) || !text.trim()) throw new Error('invalid_dsh_prompt');
  const value = record(await rpc.call('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] } }));
  if (value?.accepted !== true) throw new Error('dsh_prompt_unverified');
}

export async function createDshSession(rpc: DshSessionRpc, sessionId: string, cwd: string, agentPreset: string): Promise<void> {
  if (!nativeId(sessionId) || !isAbsolute(cwd) || /[\0\r\n]/.test(cwd) || !agentPreset.trim()) throw new Error('invalid_dsh_session');
  const value = record(await rpc.call('session/create', { request: { sessionId, cwd, agentPreset } }));
  if (value?.sessionId !== sessionId || value.agentPreset !== agentPreset) throw new Error('dsh_session_unverified');
}

function unknown(taskId: string, sessionId: string, requestId: string, observedAt: string, sequence = 0): WorkbenchTaskEvent {
  return { taskId, eventId: `dsh-read:${sessionId}:${requestId}:${sequence}:unknown`, sequence,
    phase: 'unknown', observedAt, nativeSessionId: sessionId, evidence: 'native_read' };
}

/** Bounded cold list/page read. No prompt, session resume, approval or cancel occurs here. */
export async function readDshPromptEvent(rpc: DshSessionRpc, taskId: string, sessionId: string, requestId: string, observedAt: string): Promise<WorkbenchTaskEvent> {
  if (!taskId || !nativeId(sessionId) || !nativeId(requestId)) return unknown(taskId, sessionId, requestId, observedAt);
  try {
    const list = record(await rpc.call('session/list', { _request: {} }));
    const items = list?.items;
    if (!Array.isArray(items)) return unknown(taskId, sessionId, requestId, observedAt);
    const matches = items.filter(item => record(item)?.sessionId === sessionId);
    if (matches.length !== 1) return unknown(taskId, sessionId, requestId, observedAt);
    const row = matches[0] as Summary;
    const throughSeq = row.projections?.asOfSeq;
    if (typeof row.running !== 'boolean' || row.parentSessionId || row.origin === 'subagent' || !integer(throughSeq)) return unknown(taskId, sessionId, requestId, observedAt);

    const inbox = record(row.projections?.values?.inbox);
    const queued = ['next-turn', 'next-step'].some(key => Array.isArray(inbox?.[key]) && (inbox[key] as unknown[]).some(item => record(record(item)?.source)?.rpcId === requestId));
    const events: NativeEvent[] = [];
    let beforeSeq: number | undefined;
    let exhausted = false;
    for (let pageIndex = 0; pageIndex < 16; pageIndex++) {
      const page = record(await rpc.call('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq, maxMessages: 6,
        ...(beforeSeq === undefined ? {} : { beforeSeq }) } }));
      const records = page?.records;
      if (!Array.isArray(records) || typeof page?.hasMore !== 'boolean' || records.length === 0) return unknown(taskId, sessionId, requestId, observedAt, throughSeq);
      const current = records.map(item => record(record(item)?.event)).filter((item): item is Record<string, unknown> => item !== null);
      if (current.length !== records.length || current.some((item, index) => !integer(item.seq) || (item.seq as number) > throughSeq ||
          (beforeSeq !== undefined && (item.seq as number) >= beforeSeq) ||
          (index > 0 && (item.seq as number) !== (current[index - 1]?.seq as number) + 1))) {
        return unknown(taskId, sessionId, requestId, observedAt, throughSeq);
      }
      if (current.at(-1)?.seq !== (beforeSeq ?? throughSeq + 1) - 1) return unknown(taskId, sessionId, requestId, observedAt, throughSeq);
      for (const item of current) events.push({ seq: item.seq as number, type: item.type as string, data: item.data });
      if (!page.hasMore) { exhausted = true; break; }
      beforeSeq = current[0]?.seq as number;
    }
    let activeTurn: number | null = null;
    let boundTurn: number | null = null;
    let end: { seq: number; reason: string } | null = null;
    let duplicate = false;
    const foreignTurns = new Set<number>();
    const pending = new Set<string>();
    for (const event of events.sort((a, b) => a.seq - b.seq)) {
      const data = record(event.data);
      const turn = data?.turn;
      if (event.type === 'turn/start' && integer(turn)) activeTurn = turn;
      if (event.type === 'user/message' && activeTurn !== null) {
        const source = record(data?.source);
        if (source?.kind === 'user' && source.rpcId === requestId) {
          if (boundTurn !== null) duplicate = true;
          boundTurn = activeTurn;
        } else foreignTurns.add(activeTurn);
      }
      if (boundTurn !== null && activeTurn === boundTurn) {
        if (event.type === 'approval/asked' && typeof data?.id === 'string') pending.add(data.id);
        if (event.type === 'approval/decided' && typeof data?.id === 'string') pending.delete(data.id);
      }
      if (event.type === 'turn/end' && integer(turn)) {
        if (boundTurn === turn) end = { seq: event.seq, reason: String(record(data?.reason)?.kind ?? '') };
        if (activeTurn === turn) activeTurn = null;
      }
    }
    if (duplicate || boundTurn !== null && foreignTurns.has(boundTurn) || queued && end) return unknown(taskId, sessionId, requestId, observedAt, throughSeq);
    if (boundTurn === null) {
      return queued ? { taskId, eventId: `dsh-read:${sessionId}:${requestId}:${throughSeq}:queued`, sequence: throughSeq,
        phase: 'accepted', observedAt, nativeSessionId: sessionId, evidence: 'native_read' }
        : unknown(taskId, sessionId, requestId, observedAt, throughSeq);
    }
    if (end) {
      const phase = end.reason === 'completed' && pending.size === 0 ? 'completed'
        : ['aborted', 'interrupted'].includes(end.reason) ? 'cancelled'
        : ['error', 'blocked', 'max-tokens'].includes(end.reason) ? 'failed' : 'unknown';
      return { taskId, eventId: `dsh:${sessionId}:${end.seq}`, sequence: throughSeq, phase, observedAt,
        nativeSessionId: sessionId, nativeTurnId: String(boundTurn), nativeEventId: `dsh:${sessionId}:${end.seq}`,
        ...(phase === 'completed' ? { resultRef: `dsh:${sessionId}:turn:${boundTurn}:end:${end.seq}` } : {}), evidence: 'native_read' };
    }
    if (!row.running || activeTurn !== boundTurn || !exhausted) return unknown(taskId, sessionId, requestId, observedAt, throughSeq);
    return { taskId, eventId: `dsh-read:${sessionId}:${requestId}:${throughSeq}`, sequence: throughSeq,
      phase: pending.size ? 'waiting_approval' : 'running', observedAt, nativeSessionId: sessionId,
      nativeTurnId: String(boundTurn), evidence: 'native_read' };
  } catch { return unknown(taskId, sessionId, requestId, observedAt); }
}
