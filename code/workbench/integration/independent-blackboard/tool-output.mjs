import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const notFound = () => ({ status: 404, body: { error: 'original_tool_output_not_found' } });
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');

// The gateway supplies the original isolated home and registered identities.
// A browser cannot choose a database, native session, command or file to read.
export function createOriginalToolOutputReader({ database, scope, workspaceRoot, actors }) {
  if (!text(database) || !text(scope?.environmentId) || !text(scope?.projectId) ||
      !text(workspaceRoot) || !Array.isArray(actors) || !actors.length ||
      actors.some(actor => !text(actor.threadId) || !text(actor.nativeThreadId))) throw Error('Registered original tool scope required');
  const nativeBindings = new Map(actors.map(actor => [actor.threadId, actor.nativeThreadId]));
  return query => {
    if (!query || !['environmentId', 'projectId', 'workspaceRoot', 'providerInstanceId', 'threadId', 'turnId', 'toolCallId'].every(key => text(query[key])) ||
        query.environmentId !== scope.environmentId || query.projectId !== scope.projectId ||
        query.workspaceRoot !== workspaceRoot || query.providerInstanceId !== 'codex' || !nativeBindings.has(query.threadId)) return notFound();
    let db;
    try {
      db = new DatabaseSync(database, { readOnly: true });
      db.exec('PRAGMA query_only=ON');
      db.exec('BEGIN');
      const binding = db.prepare(`SELECT t.project_id, t.deleted_at AS thread_deleted, p.workspace_root,
        p.deleted_at AS project_deleted, r.provider_name, r.provider_instance_id, r.resume_cursor_json
        FROM projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
        JOIN provider_session_runtime r ON r.thread_id=t.thread_id WHERE t.thread_id=?`).get(query.threadId);
      if (!binding || binding.project_id !== scope.projectId || binding.workspace_root !== workspaceRoot ||
          binding.thread_deleted !== null || binding.project_deleted !== null || binding.provider_name !== 'codex' ||
          binding.provider_instance_id !== query.providerInstanceId) return notFound();
      const nativeThreadId = JSON.parse(binding.resume_cursor_json).threadId;
      if (!text(nativeThreadId) || nativeThreadId !== nativeBindings.get(query.threadId)) return notFound();
      const identity = db.prepare(`SELECT activity_id, length(CAST(payload_json AS BLOB)) AS payload_bytes
        FROM projection_thread_activities WHERE thread_id=? AND turn_id=? AND kind='tool.completed'
        AND json_extract(payload_json, '$.toolCallId')=?
        ORDER BY sequence DESC, created_at DESC, activity_id DESC LIMIT 1`).get(query.threadId, query.turnId, query.toolCallId);
      if (!identity) return notFound();
      if (identity.payload_bytes > MAX_PAYLOAD_BYTES) return { status: 413, body: { error: 'original_tool_output_too_large' } };
      const row = db.prepare(`SELECT payload_json FROM projection_thread_activities
        WHERE activity_id=? AND thread_id=? AND turn_id=? AND kind='tool.completed'`).get(identity.activity_id, query.threadId, query.turnId);
      if (!row) return notFound();
      const payload = JSON.parse(row.payload_json), item = payload.data?.item;
      if (payload.itemType !== 'command_execution' || payload.status !== 'completed' ||
          payload.toolCallId !== query.toolCallId || item?.id !== query.toolCallId || item.type !== 'commandExecution' ||
          item.status !== 'completed' || typeof item.aggregatedOutput !== 'string' || typeof item.command !== 'string') return notFound();
      const output = item.aggregatedOutput;
      return { status: 200, body: { apiVersion: '0.1.0', source: 't3-original-terminal-activity', complete: true,
        scope: { environmentId: scope.environmentId, projectId: scope.projectId, workspaceRoot,
          providerInstanceId: query.providerInstanceId, threadId: query.threadId },
        nativeThreadId, turnId: query.turnId, toolCallId: query.toolCallId, activityId: identity.activity_id,
        itemType: 'command_execution', command: item.command, output,
        outputBytes: Buffer.byteLength(output), outputSha256: createHash('sha256').update(output).digest('hex'),
        exitCode: Number.isSafeInteger(item.exitCode) ? item.exitCode : null } };
    } catch {
      return { status: 503, body: { error: 'original_tool_output_unavailable' } };
    } finally { db?.close(); }
  };
}
