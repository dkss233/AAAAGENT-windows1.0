import { createHash } from 'node:crypto';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const decode = value => { try { return object(JSON.parse(value)); } catch { return null; } };
const expectedDshId = (environmentId, threadId) => 't3_' + createHash('sha256')
  .update(JSON.stringify([environmentId, threadId])).digest('hex').slice(0, 40);

/** Reads original projections and exact native provenance. It never resumes or acquires a writer. */
export function createNativeExecutionBinding({ environmentId, database, codexDatabase, readCodexMetadata, readAdmission, readSharedCodexConnection }) {
  if (!validId(environmentId) || !database?.readonly || codexDatabase && !codexDatabase.readonly)
    throw Error('Readonly original execution databases required');
  const threadQuery = database.prepare(`SELECT t.thread_id,t.project_id,t.worktree_path,t.archived_at,
    t.model_selection_json,p.workspace_root,r.provider_name,r.provider_instance_id,r.resume_cursor_json,
    s.active_turn_id FROM projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
    LEFT JOIN provider_session_runtime r ON r.thread_id=t.thread_id
    LEFT JOIN projection_thread_sessions s ON s.thread_id=t.thread_id
    WHERE t.thread_id=? AND t.deleted_at IS NULL AND p.deleted_at IS NULL`);
  const projectQuery = database.prepare('SELECT project_id FROM projection_projects WHERE project_id=? AND deleted_at IS NULL');
  const turnsQuery = database.prepare('SELECT 1 FROM projection_turns WHERE thread_id=? LIMIT 1');
  const nativeQuery = codexDatabase?.prepare('SELECT * FROM threads WHERE id=? AND archived=0');

  // The desktop launch environment can override originator. A label alone
  // cannot grant an imported App session a writer. Legacy web-created sessions
  // need the original admission, first bootstrap, native creation window and
  // original first input to agree; missing/conflicting facts remain readonly.
  function webCreatedHere(row, native) {
    if (!readAdmission) return false;
    try {
      const admission = readAdmission();
      if (admission?.version !== 1 || admission.environmentId !== environmentId) return false;
      const first = database.prepare(`SELECT * FROM orchestration_events WHERE aggregate_kind='thread'
        AND stream_id=? AND event_type='thread.turn-start-requested' ORDER BY sequence LIMIT 1`).get(row.thread_id);
      const created = database.prepare(`SELECT * FROM orchestration_events WHERE aggregate_kind='thread'
        AND stream_id=? ORDER BY sequence LIMIT 1`).get(row.thread_id);
      const admitted = admission.commands?.[first?.command_id];
      const receipt = database.prepare('SELECT * FROM orchestration_command_receipts WHERE command_id=?').get(first?.command_id);
      const create = decode(created?.payload_json), start = decode(first?.payload_json);
      if (!admitted || admitted.status !== 'accepted' || admitted.threadId !== row.thread_id ||
          admitted.projectId !== row.project_id || !/^[a-f0-9]{64}$/.test(admitted.hash) ||
          receipt?.status !== 'accepted' || receipt.aggregate_kind !== 'thread' || receipt.aggregate_id !== row.thread_id ||
          receipt.result_sequence !== first.sequence || admitted.sequence !== first.sequence ||
          created?.event_type !== 'thread.created' || created.actor_kind !== 'server' ||
          !created.command_id?.startsWith('server:bootstrap-thread-create:') ||
          create?.threadId !== row.thread_id || create.projectId !== row.project_id || create.worktreePath != null ||
          create.modelSelection?.instanceId !== 'codex' || start?.modelSelection?.instanceId !== 'codex' ||
          created.occurred_at !== first.occurred_at) return false;
      const running = database.prepare(`SELECT * FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?
        AND actor_kind='provider' AND event_type='thread.session-set'
        AND json_extract(payload_json,'$.session.status')='running' ORDER BY sequence LIMIT 1`).get(row.thread_id);
      const message = database.prepare(`SELECT * FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=?
        AND event_type='thread.message-sent' AND json_extract(payload_json,'$.messageId')=? ORDER BY sequence LIMIT 1`)
        .get(row.thread_id,start.messageId);
      const original = decode(message?.payload_json);
      const requestedAt = Date.parse(first.occurred_at), startedAt = Date.parse(running?.occurred_at);
      const createdAt = native.created_at_ms;
      return Number.isSafeInteger(createdAt) && Number.isFinite(requestedAt) && Number.isFinite(startedAt) &&
        createdAt >= requestedAt && createdAt <= startedAt && original?.role === 'user' &&
        typeof original.text === 'string' && original.text.length > 0 &&
        typeof native.first_user_message === 'string' && (native.first_user_message === original.text ||
          native.first_user_message.startsWith(original.text+'\n\n[Attached '));
    } catch { return false; }
  }

  function getTarget(threadId) {
    if (!validId(threadId)) return null;
    const row = threadQuery.get(threadId);
    if (!row) return null;
    const selection = decode(row.model_selection_json), cursor = decode(row.resume_cursor_json);
    const providerInstanceId = row.provider_instance_id ?? selection?.instanceId ?? null;
    const nativeSessionId = row.provider_name === 'codex' ? cursor?.threadId ?? null :
      row.provider_name === 'dsh' ? cursor?.sessionId ?? null : null;
    let source = 'unknown', readonly = true, executionOwner = null;
    if (!row.provider_name && !turnsQuery.get(threadId)) { source = 't3'; readonly = false; }
    else if (row.provider_name === 'codex' && validId(nativeSessionId)) {
      const native = readCodexMetadata ? readCodexMetadata(nativeSessionId) : nativeQuery?.get(nativeSessionId);
      if (native?.id === nativeSessionId && native.cwd === (row.worktree_path ?? row.workspace_root)) {
        // The existing T3 client name remains recognized; inherited App labels require positive native creation evidence.
        if (native.originator === 't3code_desktop' || webCreatedHere(row, native)) { source = 't3'; readonly = false; }
        else if (['Codex Desktop', 'codex_work_desktop'].includes(native.originator)) {
          source = 'codex-app';
          // Preserve original provenance and SID while routing both surfaces to
          // the same verified owner. A missing/expired connection stays closed.
          if (readSharedCodexConnection?.(nativeSessionId)) { readonly = false; executionOwner = 'shared-codex'; }
        }
        else if (typeof native.originator === 'string' && native.originator) source = 'external';
      }
    } else if (row.provider_name === 'dsh' && nativeSessionId === expectedDshId(environmentId, threadId)) {
      source = 't3'; readonly = false;
    }
    if (row.archived_at !== null) readonly = true;
    return { environmentId, projectId: row.project_id, threadId, providerInstanceId, nativeSessionId,
      source, readonly, ...(executionOwner ? { executionOwner } : {}), newThread: false, activeTurnId: row.active_turn_id ?? null, modelSelection: selection };
  }
  function prepareCommand(command) {
    const target = getTarget(command?.threadId);
    if (!target) {
      const create = command?.type === 'thread.create' ? command : command?.type === 'thread.turn.start' ? command.bootstrap?.createThread : null;
      if (!create || !validId(create.projectId) || !projectQuery.get(create.projectId) ||
          create.worktreePath != null || !validId(create.modelSelection?.instanceId)) return null;
      return { environmentId, projectId: create.projectId, providerInstanceId: create.modelSelection.instanceId,
        threadId: command.threadId, nativeSessionId: null, source: 't3', readonly: false, newThread: true };
    }
    if (command.bootstrap?.createThread || command.type === 'thread.create') return null;
    if (command.type === 'thread.turn.interrupt' && (!validId(target.activeTurnId) || command.turnId !== target.activeTurnId)) return null;
    if (command.type === 'thread.approval.respond') {
      const request = database.prepare('SELECT turn_id,status,decision FROM projection_pending_approvals WHERE request_id=? AND thread_id=?')
        .get(command.requestId, command.threadId);
      if (!request || request.status !== 'pending' || request.decision != null || !target.activeTurnId || request.turn_id !== target.activeTurnId) return null;
    }
    if (command.type?.startsWith('thread.user-input.')) {
      const request = database.prepare(`SELECT turn_id,kind FROM projection_thread_activities WHERE thread_id=?
        AND kind IN ('user-input.requested','user-input.resolved') AND json_extract(payload_json,'$.requestId')=?
        ORDER BY sequence DESC,created_at DESC,activity_id DESC LIMIT 1`).get(command.threadId, command.requestId);
      if (!request || request.kind !== 'user-input.requested') return null;
      const nativeQuestion = target.providerInstanceId === 'dsh' && target.nativeSessionId &&
        command.requestId?.startsWith('dsh:' + target.nativeSessionId + ':question:') && validId(request.turn_id);
      if ((!target.activeTurnId || request.turn_id !== target.activeTurnId) && !nativeQuestion) return null;
      if (nativeQuestion && database.prepare(`SELECT 1 FROM orchestration_events WHERE aggregate_kind='thread'
        AND stream_id=? AND event_type='thread.user-input-response-requested'
        AND json_extract(payload_json,'$.requestId')=? LIMIT 1`).get(command.threadId, command.requestId)) return null;
    }
    return target;
  }
  return { getTarget, prepareCommand,
    findReceipt: commandId => validId(commandId) ? database.prepare('SELECT command_id FROM orchestration_command_receipts WHERE command_id=?').get(commandId) : null };
}
