import { isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readEngineProfile } from './profile.mjs';
import { readDshHost } from './dsh-service.mjs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const threadIdentity = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

/** The backend supplies the original DB and live environment. No native ID or file is accepted from the browser. */
export function resolveDshHistoryBinding(database, environmentId, query) {
  const fields = ['environmentId', 'projectId', 'workspaceRoot', 'providerInstanceId', 'threadId'];
  if (!identity(environmentId) || !record(query) || Object.keys(query).some(key => !fields.includes(key)) ||
      !fields.every(key => typeof query[key] === 'string' && query[key].length > 0 && query[key].length <= 4096 &&
        !/[\0\r\n]/.test(query[key])) || query.environmentId !== environmentId ||
      !identity(query.projectId) || !threadIdentity(query.threadId) || query.providerInstanceId !== 'dsh')
    throw Error('Original native history identity unavailable');
  const row = database.prepare(`SELECT t.project_id, t.deleted_at AS thread_deleted, p.workspace_root,
    p.deleted_at AS project_deleted, r.provider_name, r.provider_instance_id, r.resume_cursor_json, r.runtime_payload_json
    FROM projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
    JOIN provider_session_runtime r ON r.thread_id=t.thread_id WHERE t.thread_id=?`).get(query.threadId);
  if (!row || row.project_id !== query.projectId || row.workspace_root !== query.workspaceRoot ||
      row.thread_deleted !== null || row.project_deleted !== null || row.provider_name !== 'dsh' ||
      row.provider_instance_id !== query.providerInstanceId) throw Error('Original native history identity unavailable');
  let saved; try { saved = JSON.parse(row.resume_cursor_json); } catch { throw Error('Original native history identity unavailable'); }
  const sessionId = 't3_' + createHash('sha256').update(JSON.stringify([environmentId, query.threadId])).digest('hex').slice(0, 40);
  if (!record(saved) || !identity(saved.sessionId)) throw Error('Original native history identity unavailable');
  if (saved.sessionId === sessionId) return { sessionId, cwd: row.workspace_root, preset: 'desktop-pet-work-v1' };
  let runtime; try { runtime = JSON.parse(row.runtime_payload_json); } catch { throw Error('Original native history identity unavailable'); }
  const imported = runtime?.nativeImport;
  if (!record(imported) || imported.kind !== 'dsh' || imported.readonly !== true || imported.sessionId !== saved.sessionId ||
      runtime.cwd !== row.workspace_root || typeof imported.preset !== 'string' || !imported.preset.trim() || imported.preset.length > 256 || /[\0\r\n]/.test(imported.preset) ||
      query.threadId !== `import:${query.providerInstanceId}:${saved.sessionId}`) throw Error('Original native history identity unavailable');
  return { sessionId: saved.sessionId, cwd: row.workspace_root, preset: imported.preset };
}

/** Only original native metadata and history reads; never prompt/create/model operations. */
export async function createDshHistoryRpc(projectRoot) {
  const profile = readEngineProfile(projectRoot), host = readDshHost(projectRoot, profile);
  const log = readFileSync(profile.dshWebLog, 'utf8');
  const entries = [...log.matchAll(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/g)];
  const url = new URL(entries.at(-1)?.[1] ?? 'about:blank');
  if (url.origin !== host.origin || url.pathname !== '/' || !url.searchParams.get('token') ||
      url.hash || url.username || url.password || [...url.searchParams.keys()].some(key => key !== 'token'))
    throw Error('Original DSH history authentication unavailable');
  const exchanged = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const cookie = exchanged.headers.get('set-cookie')?.split(';')[0]; await exchanged.body?.cancel();
  if (exchanged.status !== 303 || !['/', './'].includes(exchanged.headers.get('location')) ||
      !cookie || !/^[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(cookie)) throw Error('Original DSH history authentication unavailable');
  return {
    async call(method, args) {
      if (!['session/list', 'session/page', 'session/projections'].includes(method)) throw Error('Native history is read only');
      const rpcId = randomUUID();
      const response = await fetch(host.origin + '/api/' + method, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(10000), headers: { Cookie: cookie, Origin: host.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
      if (!response.ok || !response.body) throw Error('Original native history unavailable');
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw Error('Native history page exceeds bound'); }
        chunks.push(part.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value.type !== 'server-response' || value.rpcId !== rpcId || value.result?.ok !== true)
        throw Error('Original native history unavailable');
      return value.result.value;
    },
  };
}

export async function readDshNativeHistory(rpc, { sessionId, cwd, preset }) {
  if (!identity(sessionId) || typeof cwd !== 'string' || !isAbsolute(cwd) || /[\0\r\n]/.test(cwd) ||
      typeof preset !== 'string' || !preset.trim()) throw Error('Native history scope invalid');
  const listed = await rpc.call('session/list', { _request: {} });
  if (!Array.isArray(listed?.items)) throw Error('Native session list invalid');
  const matches = listed.items.filter(row => row.sessionId === sessionId);
  if (matches.length !== 1) throw Error('Exact native history session unavailable');
  const row = matches[0], throughSeq = row.projections?.asOfSeq;
  if (row.cwd !== cwd || row.projections?.values?.agentPreset !== preset || row.parentSessionId ||
      row.origin === 'subagent' || !integer(throughSeq) || typeof row.running !== 'boolean')
    throw Error('Native history identity changed');
  const events = [], visited = new Set(); let beforeSeq, complete = false;
  for (let index = 0; index < 32; index++) {
    const page = await rpc.call('session/page', { request: { address: { kind: 'session', sessionId }, throughSeq,
      maxMessages: 16, ...(beforeSeq === undefined ? {} : { beforeSeq }) } });
    if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean' || !page.records.length)
      throw Error('Native history page invalid');
    const current = page.records.map(item => item?.type === 'event' ? item.event : null);
    if (current.some((event, index) => !record(event) || !integer(event.seq) || event.seq > throughSeq ||
        (beforeSeq !== undefined && event.seq >= beforeSeq) || visited.has(event.seq) ||
        (index > 0 && event.seq !== current[index - 1].seq + 1)) ||
        current.at(-1).seq !== (beforeSeq ?? throughSeq + 1) - 1) throw Error('Native history page sequence invalid');
    for (const event of current) { visited.add(event.seq); events.push(event); }
    if (!page.hasMore) {
      if (current[0].seq !== 0) throw Error('Native history beginning unavailable');
      complete = true; break;
    }
    beforeSeq = current[0].seq;
  }
  if (!complete) throw Error('Native history pagination exceeds bound');
  return { version: '0.1.0', sessionId, cwd, preset, throughSeq, running: row.running,
    events: events.sort((a, b) => a.seq - b.seq) };
}

/** Human messages and native lifecycle only; instructions, reasoning and model internals stay private. */
export function decodeDshNativeHistory(history) {
  if (!record(history) || !identity(history.sessionId) || !integer(history.throughSeq) ||
      typeof history.running !== 'boolean' || !Array.isArray(history.events) ||
      history.events.length !== history.throughSeq + 1 || history.events.some((event, index) =>
        !record(event) || event.seq !== index)) throw Error('Native history sequence invalid');
  const turns = [], rows = [], messageIds = new Set(), requestIds = new Set(); let active = null, textBytes = 0;
  const timestamp = event => {
    if (!integer(event.time)) throw Error('Native history timestamp invalid');
    const time = new Date(event.time); if (!Number.isFinite(time.getTime())) throw Error('Native history timestamp invalid');
    return time.toISOString();
  };
  const text = content => {
    if (!Array.isArray(content)) throw Error('Native history message content invalid');
    const parts = [];
    for (const part of content) {
      if (!record(part) || typeof part.type !== 'string') throw Error('Native history message content invalid');
      if (part.type === 'reasoning') continue;
      if (part.type !== 'text' || typeof part.text !== 'string' || part.text.includes('\0'))
        throw Error('Native history content requires original session');
      parts.push(part.text);
    }
    const value = parts.join(''); textBytes += Buffer.byteLength(value);
    if (textBytes > 256 * 1024) throw Error('Native history text exceeds bound');
    return value;
  };
  for (const event of history.events) {
    const data = event.data;
    if (event.type === 'turn/start') {
      if (active || !integer(data?.turn) || data.turn < 1 || turns.some(turn => turn.nativeTurn === data.turn))
        throw Error('Native history turn sequence invalid');
      active = { id: `dsh:${history.sessionId}:turn:${data.turn}`, nativeTurn: data.turn,
        state: 'running', startedAt: timestamp(event), completedAt: null, startSeq: event.seq, terminalSeq: null };
      turns.push(active); continue;
    }
    if (event.type === 'turn/end') {
      if (!active || data?.turn !== active.nativeTurn) throw Error('Native history completion identity invalid');
      active.state = data.reason?.kind === 'completed' ? 'completed' :
        ['aborted', 'interrupted'].includes(data.reason?.kind) ? 'cancelled' :
          ['error', 'blocked', 'max-tokens'].includes(data.reason?.kind) ? 'failed' : 'unknown';
      active.completedAt = timestamp(event); active.terminalSeq = event.seq; active = null; continue;
    }
    if (event.type === 'user/message' && data?.source?.kind === 'user') {
      if (!active || data.role !== 'user' || !identity(data.source.rpcId) || !identity(data.id))
        throw Error('Native history user identity invalid');
      if (messageIds.has(data.id) || requestIds.has(data.source.rpcId)) throw Error('Native history duplicate user identity');
      messageIds.add(data.id); requestIds.add(data.source.rpcId);
      rows.push({ id: `dsh:${history.sessionId}:${event.seq}`, nativeMessageId: data.id,
        turnId: active.id, nativeTurn: active.nativeTurn, seq: event.seq, role: 'user', text: text(data.content),
        sourceRpcId: data.source.rpcId, createdAt: timestamp(event) });
    }
    if (event.type === 'assistant/message') {
      if (!active || data?.turn !== active.nativeTurn || data.message?.role !== 'assistant' || !identity(data.message.id))
        throw Error('Native history assistant identity invalid');
      if (messageIds.has(data.message.id)) throw Error('Native history duplicate assistant identity');
      messageIds.add(data.message.id);
      const body = text(data.message.content);
      if (body) rows.push({ id: `dsh:${history.sessionId}:${event.seq}`, nativeMessageId: data.message.id,
        turnId: active.id, nativeTurn: active.nativeTurn, seq: event.seq, role: 'assistant', text: body,
        createdAt: timestamp(event) });
    }
  }
  if (!!active !== history.running || rows.length > 200) throw Error('Native history state or row bound invalid');
  return { version: '0.1.0', provider: 'dsh', nativeSessionId: history.sessionId, throughSeq: history.throughSeq,
    status: active ? 'running' : 'ready', rows, turns, readonly: true, source: 'original-native-session',
    observedAt: new Date().toISOString() };
}
