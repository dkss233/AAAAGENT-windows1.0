import type Database from 'better-sqlite3';
import type { BindingState, CommandBinding, CommandLedger, InteractionBinding } from './commands.js';
import type { WorkbenchTaskRef } from '../contracts/workbench.js';

interface Row { command_id: string; digest: string; task_json: string; state: BindingState; receipt_sequence: number | null }

interface InteractionRow {
  interaction_id: string; command_id: string; task_json: string; kind: 'approval' | 'question';
  native_request_id: string; request_version: number; answer_digest: string;
  state: BindingState; receipt_sequence: number | null;
}

const interaction = (row: InteractionRow): InteractionBinding => ({
  interactionId: row.interaction_id, commandId: row.command_id,
  task: JSON.parse(row.task_json) as InteractionBinding['task'], kind: row.kind,
  nativeRequestId: row.native_request_id, requestVersion: row.request_version,
  answerDigest: row.answer_digest, state: row.state,
  ...(row.receipt_sequence === null ? {} : { receiptSequence: row.receipt_sequence }),
});

/** One immutable local response per native request, including across lost receipts and restarts. */
export class SqliteInteractionLedger {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_interaction_binding (
      interaction_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE,
      task_json TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('approval','question')),
      native_request_id TEXT NOT NULL, request_version INTEGER NOT NULL,
      answer_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('claimed','accepted','rejected','unknown')),
      receipt_sequence INTEGER
    )`);
  }

  claim(value: InteractionBinding): 'new' | InteractionBinding | 'conflict' {
    return this.db.transaction(() => {
      const result = this.db.prepare(`INSERT OR IGNORE INTO workbench_interaction_binding
        (interaction_id,command_id,task_json,kind,native_request_id,request_version,answer_digest,state)
        VALUES(?,?,?,?,?,?,?,?)`).run(value.interactionId, value.commandId, JSON.stringify(value.task),
        value.kind, value.nativeRequestId, value.requestVersion, value.answerDigest, 'claimed');
      if (result.changes === 1) return 'new';
      const old = this.byInteraction(value.interactionId);
      if (!old || old.answerDigest !== value.answerDigest || old.kind !== value.kind ||
          old.nativeRequestId !== value.nativeRequestId || old.requestVersion !== value.requestVersion ||
          JSON.stringify(old.task) !== JSON.stringify(value.task)) return 'conflict';
      return old;
    }).immediate();
  }

  byInteraction(interactionId: string): InteractionBinding | null {
    const row = this.db.prepare('SELECT * FROM workbench_interaction_binding WHERE interaction_id=?')
      .get(interactionId) as InteractionRow | undefined;
    return row ? interaction(row) : null;
  }

  byCommand(commandId: string): InteractionBinding | null {
    const row = this.db.prepare('SELECT * FROM workbench_interaction_binding WHERE command_id=?')
      .get(commandId) as InteractionRow | undefined;
    return row ? interaction(row) : null;
  }

  listByTask(projectId: string, taskId: string): readonly InteractionBinding[] {
    const rows = this.db.prepare(`SELECT * FROM workbench_interaction_binding
      WHERE json_extract(task_json, '$.projectId')=? AND json_extract(task_json, '$.id')=?
      ORDER BY rowid DESC`).all(projectId, taskId) as InteractionRow[];
    return rows.map(interaction);
  }

  settle(commandId: string, state: Exclude<BindingState, 'claimed'>, receiptSequence?: number): void {
    this.db.prepare(`UPDATE workbench_interaction_binding SET state=?,
      receipt_sequence=COALESCE(?,receipt_sequence) WHERE command_id=? AND state IN ('claimed','unknown')`)
      .run(state, receiptSequence ?? null, commandId);
  }
}

/** Uses the application's existing SQLite connection; this table stores no prompt text. */
export class SqliteCommandLedger implements CommandLedger {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS workbench_command_binding (
      command_id TEXT PRIMARY KEY, digest TEXT NOT NULL, task_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('claimed','accepted','rejected','unknown')),
      receipt_sequence INTEGER
    )`);
  }

  claim(binding: CommandBinding): 'new' | CommandBinding | 'conflict' {
    return this.db.transaction(() => {
      const result = this.db.prepare('INSERT OR IGNORE INTO workbench_command_binding(command_id,digest,task_json,state) VALUES(?,?,?,?)')
        .run(binding.commandId, binding.digest, JSON.stringify(binding.task), 'claimed');
      if (result.changes === 1) return 'new';
      const existing = this.get(binding.commandId);
      if (!existing || existing.digest !== binding.digest) return 'conflict';
      return existing;
    }).immediate();
  }

  get(commandId: string): CommandBinding | null {
    const row = this.db.prepare('SELECT * FROM workbench_command_binding WHERE command_id=?').get(commandId) as Row | undefined;
    if (!row) return null;
    return { commandId: row.command_id, digest: row.digest, task: JSON.parse(row.task_json) as WorkbenchTaskRef,
      state: row.state, ...(row.receipt_sequence === null ? {} : { receiptSequence: row.receipt_sequence }) };
  }

  settle(commandId: string, state: Exclude<BindingState, 'claimed'>, receiptSequence?: number): void {
    this.db.prepare(`UPDATE workbench_command_binding SET state=?, receipt_sequence=COALESCE(?,receipt_sequence)
      WHERE command_id=? AND state IN ('claimed','unknown')`).run(state, receiptSequence ?? null, commandId);
  }
}
