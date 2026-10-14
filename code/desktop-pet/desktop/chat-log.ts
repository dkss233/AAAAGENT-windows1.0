import { scopeEquals } from './view-state.js';
import type { CharacterId, TurnScope } from '../contracts/index.js';
import { isProductCharacter } from '../contracts/character.js';
import { COMPANION_CHAT_HISTORY_VERSION, COMPANION_CHAT_HISTORY_MAX_ROWS, COMPANION_CHAT_HISTORY_MAX_TEXT_BYTES, type CompanionChatHistoryRow } from '../contracts/companion-chat-history.js';
type Row = { id: number; kind: 'user' | 'assistant'; text: string; status?: 'sending' | 'sent' | 'failed'; scope?: TurnScope; voice?: boolean; deferred?: boolean; routed?: boolean; transcribed?: boolean; sourceDraftId?:string; sourceLabel?:string; recordId?:string; recordVersion?:number; sourceScope?:TurnScope|null; createdAt?:string; logicalOrder?:number; restored?:boolean };
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && !value.includes('\0');
function historyRows(role: CharacterId, value: unknown): CompanionChatHistoryRow[] | null {
  if (!isProductCharacter(role) || !value || typeof value !== 'object') return null;
  const history = value as Record<string, unknown>;
  if (history.version !== COMPANION_CHAT_HISTORY_VERSION || history.characterId !== role || history.status !== 'ready' ||
    typeof history.hasMore !== 'boolean' || !Array.isArray(history.rows) || history.rows.length > COMPANION_CHAT_HISTORY_MAX_ROWS) return null;
  const rows: CompanionChatHistoryRow[] = [], ids = new Set<string>();
  let bytes = 0, order = 0;
  for (const value of history.rows) {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>, source = row.sourceScope;
    if (row.characterId !== role || !identifier(row.recordId) || ids.has(row.recordId) ||
      !Number.isSafeInteger(row.recordVersion) || Number(row.recordVersion) < 1 || (row.role !== 'user' && row.role !== 'assistant') ||
      typeof row.text !== 'string' || !row.text.trim() || row.text.includes('\0') ||
      typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) ||
      !Number.isSafeInteger(row.logicalOrder) || Number(row.logicalOrder) < 1 || Number(row.logicalOrder) < order) return null;
    let scope: TurnScope | null = null;
    if (source !== null) {
      if (!source || typeof source !== 'object') return null;
      const s = source as Record<string, unknown>;
      if (s.characterId !== role || !identifier(s.sessionId) || !identifier(s.turnId) ||
        !Number.isSafeInteger(s.generation) || Number(s.generation) < 0) return null;
      scope = { characterId: role, sessionId: s.sessionId, turnId: s.turnId, generation: Number(s.generation) };
    }
    bytes += new TextEncoder().encode(row.text).length;
    if (bytes > COMPANION_CHAT_HISTORY_MAX_TEXT_BYTES) return null;
    order = Number(row.logicalOrder); ids.add(row.recordId);
    rows.push({ characterId: role, recordId: row.recordId, recordVersion: Number(row.recordVersion), role: row.role as 'user' | 'assistant',
      text: row.text, createdAt: row.createdAt, logicalOrder: order, sourceScope: scope });
  }
  return rows;
}
/** Ephemeral display only: both routes retain verbatim user input. No backend memory writes. */
export class DesktopChatLog {
  revision = 0;
  private nextId = 0;
  private logs = new Map<CharacterId, Row[]>();
  private drafts = new Map<CharacterId, string>();
  private waiting = new Map<CharacterId, Row>();
  private voices = new Map<CharacterId, Row>();
  rows(role: CharacterId): readonly Row[] { return this.logs.get(role) ?? []; }
  draft(role: CharacterId): string { return this.drafts.get(role) ?? ''; }
  setDraft(role: CharacterId, text: string): void { this.drafts.set(role, text); }
  pending(role: CharacterId): boolean { return this.waiting.has(role); }
  /** Restore display records atomically; keep their original identities separate from the live session. */
  restoreHistory(role: CharacterId, history: unknown): boolean {
    const saved = historyRows(role, history);
    if (!saved) return false;
    const current = this.rows(role), restored: Row[] = [], updates: Array<{ row: Row; saved: CompanionChatHistoryRow }> = [];
    for (const value of saved) {
      const byRecord = current.find(row => row.recordId === value.recordId);
      if (byRecord && (byRecord.kind !== value.role || value.recordVersion < byRecord.recordVersion! ||
        value.recordVersion === byRecord.recordVersion && (byRecord.text !== value.text || byRecord.createdAt !== value.createdAt || byRecord.logicalOrder !== value.logicalOrder ||
          JSON.stringify(byRecord.sourceScope) !== JSON.stringify(value.sourceScope)))) return false;
      const live = value.sourceScope ? current.find(row => !row.recordId && row.kind === value.role &&
        scopeEquals(row.scope ?? null, value.sourceScope!) && row.text === value.text && !restored.includes(row)) : undefined;
      const row = byRecord ?? live ?? { id: 0, kind: value.role, text: value.text, restored: true };
      updates.push({ row, saved: value }); restored.push(row);
    }
    // Retain live and pending rows. A valid fresh snapshot replaces only previously restored display rows.
    const next = [...restored, ...current.filter(row => !row.restored && !restored.includes(row))].slice(-COMPANION_CHAT_HISTORY_MAX_ROWS);
    let changed = next.length !== current.length || next.some((row, index) => row !== current[index]);
    for (const { row, saved } of updates) {
      if (!row.id) row.id = ++this.nextId;
      changed ||= row.recordId !== saved.recordId || row.recordVersion !== saved.recordVersion || row.text !== saved.text ||
        row.createdAt !== saved.createdAt || row.logicalOrder !== saved.logicalOrder || JSON.stringify(row.sourceScope) !== JSON.stringify(saved.sourceScope);
      row.recordId = saved.recordId; row.recordVersion = saved.recordVersion; row.sourceScope = saved.sourceScope;
      row.createdAt = saved.createdAt; row.logicalOrder = saved.logicalOrder; row.text = saved.text;
      if (row.restored) { if (saved.sourceScope) row.scope = saved.sourceScope; else delete row.scope; }
    }
    if (changed) { this.logs.set(role, next); this.revision++; }
    return true;
  }
  submit(role: CharacterId, text: string, deferred = false): boolean {
    if (this.pending(role)) return false;
    const row: Row = { id: ++this.nextId, kind: 'user', text, status: 'sending', deferred };
    if (!deferred) this.append(role, row); this.waiting.set(role, row); this.setDraft(role, ''); return true;
  }
  acknowledge(scope: TurnScope, deferred = false): void {
    const row = this.waiting.get(scope.characterId);
    if (!row) return;
    row.scope = scope; if (deferred) return;
    row.status = 'sent'; this.waiting.delete(scope.characterId); this.revision++;
  }
  failPending(role: CharacterId): void {
    const row = this.waiting.get(role);
    if (!row) return;
    row.status = 'failed'; this.waiting.delete(role);
    if (!this.draft(role)) this.setDraft(role, row.text);
    this.revision++;
  }
  beginVoice(role: CharacterId, deferred = false): void {
    this.cancelVoice(role);
    const row: Row = { id: ++this.nextId, kind: 'user', text: '语音输入 · 准备中', voice: true, status: 'sending', deferred };
    if (!deferred) this.append(role, row); this.voices.set(role, row);
  }
  bindVoice(scope: TurnScope): void { const row = this.voices.get(scope.characterId); if (row) row.scope = scope; }
  cancelVoice(role: CharacterId): void {
    const row = this.voices.get(role);
    if (!row) return;
    row.text = '语音未发送'; row.status = 'failed'; this.voices.delete(role); this.revision++;
  }
  transcript(scope: TurnScope, text: string): void {
    const row = this.voices.get(scope.characterId);
    if (!row?.scope || row.scope.sessionId !== scope.sessionId || row.scope.turnId !== scope.turnId || row.scope.generation !== scope.generation) return;
    if(!text.trim()){this.voices.delete(scope.characterId);this.revision++;return;}
    row.text = text; row.transcribed = true;
    row.status = 'sent'; if (row.deferred) this.append(scope.characterId, row); this.voices.delete(scope.characterId); this.revision++;
  }
  route(scope: TurnScope, route: 'companion' | 'work'): void {
    const role = scope.characterId;
    const row = this.waiting.get(role);
    if (row && scopeEquals(row.scope ?? null, scope)) {
      this.waiting.delete(role);
      row.status = 'sent'; row.routed = true; if (row.deferred) this.append(role, row);
      this.revision++;
    }
    const voice = this.voices.get(role);
    if (!voice || !scopeEquals(voice.scope ?? null, scope)) return;
    voice.routed = true;
    if (voice.transcribed) this.transcript(scope, voice.text);
  }
  restoreSource(input: import('../contracts/desktop-work.js').WorkSourceInput): void {
    const role=input.scope.characterId,existing=this.rows(role).find(row=>row.sourceDraftId===input.draftId);
    if(existing)return;
    const voice=this.voices.get(role);
    if(input.provenance==='original_input'&&voice&&scopeEquals(voice.scope??null,input.scope)){voice.text=input.text;voice.transcribed=true;voice.status='sent';voice.sourceDraftId=input.draftId;voice.deferred=false;this.append(role,voice);this.voices.delete(role);return;}
    const live=this.rows(role).find(row=>row.kind==='user'&&!row.sourceDraftId&&scopeEquals(row.scope??null,input.scope)&&row.text===input.text);
    if(live){live.sourceDraftId=input.draftId;if(input.provenance==='legacy_saved_input')live.sourceLabel='已保存的任务输入';this.revision++;return;}
    this.append(role,{id:++this.nextId,kind:'user',text:input.text,status:'sent',scope:input.scope,sourceDraftId:input.draftId,sourceLabel:input.provenance==='legacy_saved_input'?'已保存的任务输入':'你的原话'});
  }
  sourceRowId(role:CharacterId,draftId?:string):number|undefined {return draftId?this.rows(role).find(row=>row.sourceDraftId===draftId)?.id:undefined;}
  reply(scope: TurnScope, text: string): void {
    const row = this.rows(scope.characterId).find(r => r.kind === 'assistant' && r.scope?.sessionId === scope.sessionId && r.scope?.turnId === scope.turnId && r.scope?.generation === scope.generation);
    if (row) { row.text = text; this.revision++; }
    else this.append(scope.characterId, { id: ++this.nextId, kind: 'assistant', text, scope });
  }
  private append(role: CharacterId, row: Row): void {
    const rows = [...this.rows(role), row];
    // A bounded session-only panel; backend history and retention are untouched.
    this.logs.set(role, rows.slice(-50)); this.revision++;
  }
}
