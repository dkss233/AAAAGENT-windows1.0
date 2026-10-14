import { DatabaseSync } from 'node:sqlite';
import { createOriginalToolOutputReader } from '../independent-blackboard/tool-output.mjs';

// Runs on the fixed project Node. The backend supplies the database; browser input
// carries only IDs and must match the current original SQLite binding.
let database;
try {
  const [file, raw] = process.argv.slice(2), query = JSON.parse(raw);
  database = new DatabaseSync(file, { readOnly: true });
  database.exec('PRAGMA query_only=ON');
  const row = database.prepare(`SELECT t.project_id, p.workspace_root,
    r.provider_instance_id, r.resume_cursor_json FROM projection_threads t
    JOIN projection_projects p ON p.project_id=t.project_id
    JOIN provider_session_runtime r ON r.thread_id=t.thread_id
    WHERE t.thread_id=? AND t.deleted_at IS NULL AND p.deleted_at IS NULL`).get(query.threadId);
  if (!row || row.project_id !== query.projectId || row.workspace_root !== query.workspaceRoot ||
      row.provider_instance_id !== query.providerInstanceId) throw Error('Native tool identity changed');
  const nativeThreadId = JSON.parse(row.resume_cursor_json).threadId;
  const reader = createOriginalToolOutputReader({ database: file,
    scope: { environmentId: query.environmentId, projectId: row.project_id },
    workspaceRoot: row.workspace_root, actors: [{ threadId: query.threadId, nativeThreadId }] });
  process.stdout.write(JSON.stringify(reader(query)));
} catch { process.stdout.write(JSON.stringify({ status: 404, body: { error: 'original_tool_output_not_found' } })); }
finally { database?.close(); }
