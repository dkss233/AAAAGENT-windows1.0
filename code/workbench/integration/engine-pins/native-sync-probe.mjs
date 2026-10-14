import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readEngineProfile } from './profile.mjs';
import { createDshHistoryRpc } from './dsh-native-history.mjs';

/** Zero-model original-history and planner verification. Test thread IDs are resolved by the original T3 database. */
export async function probeNativeSync(root, source, evidence, threadIds) {
  const profile = readEngineProfile(root);
  const helpers = await import(pathToFileURL(join(source, 'apps/server/src/orchestration/NativeSessionHistory.ts')));
  const { readDshHistoryChunk } = await import(pathToFileURL(join(source, 'apps/server/src/provider/Layers/DshNativeHistory.ts')));
  const db = new DatabaseSync(join(root, 'data/desktop-pet/t3-home/userdata/state.sqlite'), { readOnly: true });
  const results = [];
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  try {
    for (const threadId of threadIds) {
      const binding = db.prepare(`SELECT r.*, t.project_id,p.workspace_root,t.deleted_at,p.deleted_at AS project_deleted
        FROM provider_session_runtime r JOIN projection_threads t ON t.thread_id=r.thread_id JOIN projection_projects p ON p.project_id=t.project_id WHERE r.thread_id=?`).get(threadId);
      if (!binding || binding.deleted_at || binding.project_deleted) throw Error('Original test binding unavailable');
      const cursor = JSON.parse(binding.resume_cursor_json), runtime = JSON.parse(binding.runtime_payload_json);
      if (runtime.cwd !== binding.workspace_root || !['codex', 'dsh'].includes(binding.provider_name)) throw Error('Original workspace/provider mismatch');
      const nativeId = binding.provider_name === 'codex' ? cursor.threadId : cursor.sessionId;
      let history;
      if (binding.provider_name === 'codex') {
        const child = spawn(profile.runtime.codexExecutable, ['app-server'], { cwd: runtime.cwd, env: { ...process.env, CODEX_HOME: profile.codexHome }, stdio: ['pipe', 'pipe', 'pipe'] });
        const pending = new Map(); let seq = 0;
        child.stderr.resume(); const lines = createInterface({ input: child.stdout });
        lines.on('line', line => { const v = JSON.parse(line), p = pending.get(v.id); if (p) { pending.delete(v.id); clearTimeout(p.timer); p.resolve(v); } });
        const rpc = (method, params) => {
          if (!['initialize', 'thread/read', 'thread/turns/list'].includes(method)) throw Error('Original history is read only');
          const id = ++seq;
          return new Promise((resolveReply, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(Error('Native history timeout')); }, 20000); pending.set(id, { timer, resolve: resolveReply }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n'); });
        };
        try {
          const init = await rpc('initialize', { clientInfo: { name: 'aaaagent_native_sync_read', version: '1.0.0' }, capabilities: { experimentalApi: true } });
          if (init.error) throw Error('Native readonly initialization failed');
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
          const meta = await rpc('thread/read', { threadId: nativeId, includeTurns: false });
          if (meta.error || meta.result?.thread?.id !== nativeId) throw Error('Original native metadata mismatch');
          let full;
          if (meta.result.thread.historyMode === 'paginated') {
            const turns = [], visited = new Set(); let pageCursor = null;
            do {
              if (visited.has(pageCursor)) throw Error('Native cursor repeated'); visited.add(pageCursor);
              const page = await rpc('thread/turns/list', { threadId: nativeId, cursor: pageCursor, limit: 100, sortDirection: 'asc', itemsView: 'full' });
              if (page.error || !Array.isArray(page.result?.data)) throw Error('Original native page unavailable');
              turns.push(...page.result.data); pageCursor = page.result.nextCursor;
            } while (pageCursor !== null);
            full = { ...meta.result.thread, turns };
          } else {
            const read = await rpc('thread/read', { threadId: nativeId, includeTurns: true });
            if (read.error) throw Error('Original native body unavailable'); full = read.result.thread;
          }
          const items = full.turns.flatMap(turn => (turn.items ?? []).map(item => ({turnId: turn.id, ...item})));
          const forwarded = items.filter(item => item.type === 'functionCallOutput' && item.namespace === 'codex_app' && item.name === 'send_message_to_thread');
          writeFileSync(join(evidence, 'codex-native-item-shapes.json'), JSON.stringify({nativeId, items: items.map(item => ({id:item.id,turnId:item.turnId,type:item.type,namespace:item.namespace,name:item.name})), forwarded}, null, 2)+'\n', {mode:0o600});
          history = helpers.decodeCodexHistory(full, nativeId, runtime.cwd);
        } finally {
          child.stdin.end(); child.kill('SIGTERM');
          if (child.exitCode === null && child.signalCode === null) await new Promise(done => child.once('exit', done));
          lines.close(); for (const p of pending.values()) clearTimeout(p.timer);
        }
      } else history = await readDshHistoryChunk(await createDshHistoryRpc(root), nativeId, runtime.cwd, 'desktop-pet-work-v1');
      const messages = db.prepare('SELECT * FROM projection_thread_messages WHERE thread_id=? ORDER BY created_at,message_id').all(threadId).map(m => ({ id: m.message_id, role: m.role, text: m.text, turnId: m.turn_id, streaming: !!m.is_streaming, createdAt: m.created_at, updatedAt: m.updated_at }));
      const turns = db.prepare('SELECT * FROM projection_turns WHERE thread_id=?').all(threadId).map(t => ({ turnId: t.turn_id, pendingMessageId: t.pending_message_id, assistantMessageId: t.assistant_message_id }));
      const plan = helpers.planNativeHistory(history, binding.provider_name, turns, messages);
      const preserved = messages.filter(m => !plan.messages.some(u => u.id === m.id)), merged = [...preserved, ...plan.messages];
      const again = helpers.planNativeHistory(history, binding.provider_name, turns, merged, plan.aliases);
      if (again.messages.length) throw Error('Repeated original native read is not idempotent');
      const record = { threadId, nativeId, provider: binding.provider_name, originalMessages: messages.length, plannedNewMessages: plan.messages.filter(m => !messages.some(o => o.id === m.id)).length, plannedTurns: plan.turns.length, observation: history.observation, repeatedNewMessages: 0, modelStarts: 0, nativeWrites: 0, originalDatabaseWrites: 0, history, plan };
      writeFileSync(join(evidence, binding.provider_name + '-original-native-plan.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
      results.push({ ...record, history: undefined, plan: undefined });
    }
  } finally { db.close(); }
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, source, evidence, ...ids] = process.argv.slice(2);
  if (!root || !source || !evidence || !ids.length) throw Error('Expected root, owned candidate source, evidence and original test IDs');
  console.log(JSON.stringify(await probeNativeSync(resolve(root), resolve(source), resolve(evidence), ids)));
}
