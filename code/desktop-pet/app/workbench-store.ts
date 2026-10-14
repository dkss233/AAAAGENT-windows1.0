import Database from 'better-sqlite3';
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute } from 'node:path';
import { isPrivateFileSync, restrictPrivatePathSync } from '../core/platform-files.js';
import type { ProjectEntry } from '../contracts/projects.js';
import type { ProjectTerminalEvidence } from '../contracts/project-memory.js';
import { PROJECT_PROVIDER_CONTEXT_VERSION, type ProjectProviderContextPreparation } from '../contracts/project-provider-context.js';
import type { WorkbenchContinuationDraft, WorkbenchInput, WorkbenchInputOrigin, WorkbenchTaskEvent, WorkbenchTaskRef } from '../contracts/workbench.js';
import { ManagementError } from '../contracts/management.js';
import { applyTaskEvent, projectTerminalEvidence, type TaskProjection } from '../workbench/events.js';
import { SqliteCommandLedger, SqliteInteractionLedger } from '../workbench/sqlite-ledger.js';
import { t3ShellToTaskEvent, type T3ThreadShellRead } from '../workbench/t3-read.js';

const DATABASE_ID = 0x57423131; // WB11; separate from the project and companion databases.
const SCHEMA_VERSION = 1;
const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 250 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ManagementError('invalid_request', '工作台标识无效。');
  }
  return value;
};

export interface VerifiedT3ProjectBinding {
  readonly projectId: string;
  readonly environmentId: string;
  readonly t3ProjectId: string;
  readonly workspaceRoot: string;
  readonly verifiedAt: string;
}

interface BindingRow { project_id: string; environment_id: string; t3_project_id: string; workspace_root: string; verified_at: string }
interface TaskRow { task_json: string; projection_json: string | null }
interface WebFocusRow { task_id: string | null; revision: number }
interface ContinuationRow { draft_id: string; command_id: string; task_json: string; input_json: string;
  version: number; state: 'open' | 'claimed' }
export type ProviderContextFreeze = Extract<ProjectProviderContextPreparation, { status: 'ready' }>;
interface ProviderContextFreezeRow { command_id: string; draft_id: string; draft_version: number;
  message_id: string; fingerprint: string; snapshot_json: string; snapshot_sha256: string }
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const providerContextFingerprint = (value: ProviderContextFreeze): string => sha256(JSON.stringify([
  value.version, value.binding, value.durableMessageText, value.records,
]));
const providerProjectionText = (value: ProviderContextFreeze): string => value.records.length === 0
  ? value.durableMessageText : `${value.durableMessageText}\n\n${value.records.map(record =>
    `[项目记忆](t3-context://v1/project-memory/${record.contextId})`).join('\n')}`;
type CreatePhase = 'new' | 'claimed' | 'accepted' | 'rejected' | 'unknown';
export interface NativeCreateIntent {
  readonly operationId: string;
  readonly digest: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly t3ProjectId: string;
  readonly threadId: string;
  readonly projectCommandId: string;
  readonly threadCommandId: string;
  readonly createdAt: string;
  readonly projectPhase: CreatePhase;
  readonly threadPhase: CreatePhase;
}
interface CreateRow {
  operation_id: string; digest: string; environment_id: string; project_id: string; workspace_root: string;
  t3_project_id: string; thread_id: string; project_command_id: string; thread_command_id: string;
  created_at: string; project_phase: CreatePhase; thread_phase: CreatePhase;
}
export interface NativeCreateRecovery {
  readonly provider: 'codex' | 'dsh';
  readonly reasoningEffort: string | null;
  readonly operationId: string;
  readonly projectId: string;
  readonly title: string | null;
  readonly model: string | null;
  readonly createdAt: string;
  readonly projectPhase: CreatePhase;
  readonly threadPhase: CreatePhase;
}
const createIntent = (row: CreateRow): NativeCreateIntent => ({ operationId: row.operation_id,
  digest: row.digest, environmentId: row.environment_id, projectId: row.project_id,
  workspaceRoot: row.workspace_root, t3ProjectId: row.t3_project_id, threadId: row.thread_id,
  projectCommandId: row.project_command_id, threadCommandId: row.thread_command_id,
  createdAt: row.created_at, projectPhase: row.project_phase, threadPhase: row.thread_phase });

function existingDatabase(filename: string): boolean {
  if (!isAbsolute(filename) || filename.includes('\0')) throw new ManagementError('invalid_request', '工作台数据库位置无效。');
  let fd: number;
  try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new ManagementError('invalid_request', '工作台数据库不可读取。');
  }
  try {
    const stat = fstatSync(fd);
    const header = Buffer.alloc(100);
    if (!isPrivateFileSync(filename, stat) || readSync(fd, header, 0, 100, 0) !== 100 ||
        header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
        header.readUInt32BE(68) !== DATABASE_ID || header.readUInt32BE(60) !== SCHEMA_VERSION) {
      throw new ManagementError('invalid_request', '工作台数据库身份或权限不匹配。');
    }
    return true;
  } finally { closeSync(fd); }
}

function binding(row: BindingRow): VerifiedT3ProjectBinding {
  return { projectId: row.project_id, environmentId: row.environment_id, t3ProjectId: row.t3_project_id,
    workspaceRoot: row.workspace_root, verifiedAt: row.verified_at };
}

/** Owns B54 task references, reviewed channel drafts and command receipts; no provider credentials are stored here. */
export class SqliteWorkbenchStore {
  readonly ledger: SqliteCommandLedger;
  readonly interactionLedger: SqliteInteractionLedger;
  private readonly db: Database.Database;

  constructor(filename: string) {
    let existed = existingDatabase(filename);
    if (!existed) {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      let fd: number | undefined;
      try { fd = openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); fchmodSync(fd, 0o600); restrictPrivatePathSync(filename); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        existed = existingDatabase(filename);
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    this.db = new Database(filename, { fileMustExist: true });
    try {
      const applicationId = this.db.pragma('application_id', { simple: true });
      const version = this.db.pragma('user_version', { simple: true });
      if (!existed) {
        if (applicationId !== 0 || version !== 0 ||
            (this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { n: number }).n !== 0) {
          throw new Error('workbench_database_not_empty');
        }
        this.db.transaction(() => {
          this.db.pragma(`application_id = ${DATABASE_ID}`);
          this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
          this.db.exec(`CREATE TABLE project_bindings (
            project_id TEXT NOT NULL, environment_id TEXT NOT NULL, t3_project_id TEXT NOT NULL,
            workspace_root TEXT NOT NULL, verified_at TEXT NOT NULL,
            PRIMARY KEY(project_id, environment_id, t3_project_id),
            UNIQUE(environment_id, t3_project_id));
            CREATE TABLE task_refs (
              task_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, environment_id TEXT NOT NULL,
              t3_project_id TEXT NOT NULL, thread_id TEXT NOT NULL, task_json TEXT NOT NULL,
              projection_json TEXT,
              UNIQUE(environment_id, thread_id),
              FOREIGN KEY(project_id, environment_id, t3_project_id)
                REFERENCES project_bindings(project_id, environment_id, t3_project_id));`);
        }).immediate();
      } else if (applicationId !== DATABASE_ID || version !== SCHEMA_VERSION) {
        throw new Error('workbench_database_identity_mismatch');
      }
      this.db.pragma('foreign_keys = ON');
      this.ledger = new SqliteCommandLedger(this.db);
      this.interactionLedger = new SqliteInteractionLedger(this.db);
      this.db.exec(`CREATE TABLE IF NOT EXISTS native_create_intents (
        operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, environment_id TEXT NOT NULL,
        project_id TEXT NOT NULL, workspace_root TEXT NOT NULL, t3_project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL, project_command_id TEXT NOT NULL, thread_command_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        project_phase TEXT NOT NULL CHECK(project_phase IN ('new','claimed','accepted','rejected','unknown')),
        thread_phase TEXT NOT NULL CHECK(thread_phase IN ('new','claimed','accepted','rejected','unknown'))
      );
      CREATE TABLE IF NOT EXISTS native_create_inputs (
        operation_id TEXT PRIMARY KEY REFERENCES native_create_intents(operation_id),
        title TEXT NOT NULL, model TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS native_create_provider_inputs (
        operation_id TEXT PRIMARY KEY REFERENCES native_create_intents(operation_id),
        provider TEXT NOT NULL CHECK(provider IN ('codex','dsh')), reasoning_effort TEXT
      );
      CREATE TABLE IF NOT EXISTS web_focus_profiles (
        profile_id TEXT PRIMARY KEY, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_task_focus (
        profile_id TEXT NOT NULL REFERENCES web_focus_profiles(profile_id),
        project_id TEXT NOT NULL, task_id TEXT,
        revision INTEGER NOT NULL CHECK(revision>=1),
        PRIMARY KEY(profile_id,project_id)
      );
      CREATE TABLE IF NOT EXISTS desktop_task_focus (
        identity INTEGER PRIMARY KEY CHECK(identity=1),
        project_id TEXT, task_id TEXT,
        revision INTEGER NOT NULL CHECK(revision>=1)
      );
      CREATE TABLE IF NOT EXISTS desktop_coordinator_inputs (
        input_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, profile_json TEXT NOT NULL,
        focus_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS desktop_group_links (
        operation_id TEXT PRIMARY KEY, members_digest TEXT NOT NULL,
        registration_digest TEXT, state TEXT NOT NULL, result_json TEXT
      );
      CREATE TABLE IF NOT EXISTS desktop_first_turn_admissions (
        operation_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, policy_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workbench_continuation_drafts (
        draft_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL, channel_session_id TEXT NOT NULL, message_id TEXT NOT NULL,
        task_json TEXT NOT NULL, input_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK(version>=1),
        state TEXT NOT NULL CHECK(state IN ('open','claimed')),
        UNIQUE(channel,channel_session_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS workbench_continuation_dismissals (
        draft_id TEXT PRIMARY KEY REFERENCES workbench_continuation_drafts(draft_id),
        dismissed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workbench_provider_context_freezes (
        command_id TEXT PRIMARY KEY REFERENCES workbench_continuation_drafts(command_id),
        draft_id TEXT NOT NULL REFERENCES workbench_continuation_drafts(draft_id),
        draft_version INTEGER NOT NULL CHECK(draft_version>=1),
        message_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
        snapshot_json TEXT NOT NULL,
        snapshot_sha256 TEXT NOT NULL CHECK(length(snapshot_sha256)=64)
      );
      CREATE TABLE IF NOT EXISTS workbench_terminal_outbox (
        task_id TEXT NOT NULL REFERENCES task_refs(task_id),
        event_id TEXT NOT NULL, event_json TEXT NOT NULL,
        PRIMARY KEY(task_id,event_id)
      );
      CREATE TABLE IF NOT EXISTS workbench_terminal_delivery (
        task_id TEXT NOT NULL, event_id TEXT NOT NULL, extraction_version TEXT NOT NULL,
        PRIMARY KEY(task_id,event_id,extraction_version),
        FOREIGN KEY(task_id,event_id) REFERENCES workbench_terminal_outbox(task_id,event_id)
      )`);
      // Earlier B54 ledgers may already contain a terminal projection before this outbox existed.
      this.db.transaction(() => {
        const rows = this.db.prepare('SELECT task_id,projection_json FROM task_refs WHERE projection_json IS NOT NULL')
          .all() as { task_id: string; projection_json: string }[];
        for (const row of rows) {
          const projection = JSON.parse(row.projection_json) as TaskProjection;
          if (projection.terminalEvent) this.db.prepare('INSERT OR IGNORE INTO workbench_terminal_outbox VALUES(?,?,?)')
            .run(row.task_id, projection.terminalEvent.eventId, JSON.stringify(projection.terminalEvent));
        }
      }).immediate();
    } catch (error) { this.db.close(); throw error; }
  }

  private continuation(row: ContinuationRow): WorkbenchContinuationDraft {
    return { id: row.draft_id, commandId: row.command_id, version: row.version, state: row.state,
      task: JSON.parse(row.task_json), input: JSON.parse(row.input_json) };
  }

  recordDesktopCoordinatorInput(input: WorkbenchInput, profile: object, focus: object): WorkbenchInput {
    if (input.origin.channel !== 'desktop' || !input.rawText.trim() || input.rawText.length > 120000 || input.rawText.includes('\0')) {
      throw new ManagementError('invalid_request', '协调对话的原始输入无效。');
    }
    const values = [JSON.stringify(input), JSON.stringify(profile), JSON.stringify(focus)];
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT input_json,profile_json,focus_json FROM desktop_coordinator_inputs WHERE input_id=?')
        .get(identifier(input.inputId)) as { input_json: string; profile_json: string; focus_json: string } | undefined;
      const previous = old ? JSON.parse(old.input_json) as WorkbenchInput : undefined;
      if (old && (JSON.stringify({ ...previous, createdAt: input.createdAt }) !== values[0] ||
          old.profile_json !== values[1] || old.focus_json !== values[2])) {
        throw new ManagementError('version_conflict', '协调创建输入已有不同原话、配置或焦点。');
      }
      if (!old) this.db.prepare('INSERT INTO desktop_coordinator_inputs VALUES(?,?,?,?)').run(input.inputId, ...values);
      return previous ?? input;
    }).immediate();
  }

  originalDesktopCoordinatorInput(operationId: string): WorkbenchInput | null {
    const row = this.db.prepare(`SELECT input_json FROM desktop_coordinator_inputs
      WHERE json_extract(profile_json,'$.operationId')=? ORDER BY rowid LIMIT 1`)
      .get(identifier(operationId)) as { input_json: string } | undefined;
    return row ? JSON.parse(row.input_json) as WorkbenchInput : null;
  }

  claimDesktopGroupLink(operationId: string, membersDigest: string, registrationDigest?: string) {
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT members_digest,registration_digest,state,result_json FROM desktop_group_links WHERE operation_id=?')
        .get(identifier(operationId)) as { members_digest: string; registration_digest: string | null;
          state: string; result_json: string | null } | undefined;
      if (old && (old.members_digest !== membersDigest || old.registration_digest && registrationDigest &&
          old.registration_digest !== registrationDigest)) {
        throw new ManagementError('version_conflict', '独立组的原成员或注册授权已变化。');
      }
      if (!old) this.db.prepare('INSERT INTO desktop_group_links VALUES(?,?,?,?,NULL)')
        .run(operationId, membersDigest, registrationDigest ?? null, registrationDigest ? 'registering' : 'prepared');
      const first = !!registrationDigest && (!old || old.state === 'prepared' && !old.registration_digest);
      if (first && old) this.db.prepare('UPDATE desktop_group_links SET registration_digest=?,state=? WHERE operation_id=?')
        .run(registrationDigest, 'registering', operationId);
      return { first, state: old && !first ? old.state : registrationDigest ? 'registering' : 'prepared',
        result: old?.result_json ? JSON.parse(old.result_json) as unknown : null };
    }).immediate();
  }

  hasDesktopFirstTurnAdmission(operationId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM desktop_first_turn_admissions WHERE operation_id=?').get(identifier(operationId));
  }

  desktopFirstTurnConfirmation(operationId: string): { policy: unknown; confirmedAt: string } | null {
    const row = this.db.prepare('SELECT policy_json FROM desktop_first_turn_admissions WHERE operation_id=?')
      .get(identifier(operationId)) as { policy_json: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.policy_json);
    return value.policy && typeof value.confirmedAt === 'string' && Number.isFinite(Date.parse(value.confirmedAt)) ? value : null;
  }

  claimDesktopFirstTurnAdmission(operationId: string, fingerprint: string, policy: unknown) {
    const bytes = JSON.stringify(policy);
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT fingerprint,policy_json FROM desktop_first_turn_admissions WHERE operation_id=?')
        .get(identifier(operationId)) as { fingerprint: string; policy_json: string } | undefined;
      const previous = old ? JSON.parse(old.policy_json) : undefined;
      if (old && (old.fingerprint !== fingerprint || JSON.stringify(previous.policy ?? previous) !== bytes)) {
        throw new ManagementError('version_conflict', '首个协调确认已冻结为另一准确工作卡。');
      }
      if (!old) this.db.prepare('INSERT INTO desktop_first_turn_admissions VALUES(?,?,?)')
        .run(operationId, fingerprint, JSON.stringify({ policy, confirmedAt: new Date().toISOString() }));
    }).immediate();
  }

  settleDesktopGroupLink(operationId: string, state: 'registered' | 'unknown', result: unknown) {
    this.db.prepare('UPDATE desktop_group_links SET state=?,result_json=? WHERE operation_id=?')
      .run(state, JSON.stringify(result), identifier(operationId));
  }

  /** Repeated delivery of one channel message reuses the original draft, never changes its target or raw input. */
  prepareContinuation(task: Extract<WorkbenchTaskRef, { readonly origin: 't3' }>, input: WorkbenchInput): WorkbenchContinuationDraft {
    const channel = input.origin.channel, session = identifier(input.origin.channelSessionId),
      messageId = identifier(input.origin.messageId);
    if (!['desktop', 'web', 'wechat'].includes(channel) || !identifier(input.inputId) ||
        !input.rawText.trim() || !input.dispatchText.trim() ||
        input.rawText.length > 120000 || input.dispatchText.length > 120000 ||
        input.rawText.includes('\0') || input.dispatchText.includes('\0') ||
        !Number.isFinite(Date.parse(input.createdAt))) {
      throw new ManagementError('invalid_request', '工作台原始输入或确认正文无效。');
    }
    return this.db.transaction(() => {
      const old = this.db.prepare(`SELECT * FROM workbench_continuation_drafts
        WHERE channel=? AND channel_session_id=? AND message_id=?`).get(channel, session, messageId) as ContinuationRow | undefined;
      if (old) {
        const previous = this.getContinuation(old.draft_id, channel, session);
        if (JSON.stringify(previous.task) !== JSON.stringify(task) ||
            previous.input.inputId !== input.inputId || previous.input.rawText !== input.rawText ||
            previous.input.origin.channel !== channel || previous.input.origin.channelSessionId !== session ||
            previous.input.origin.messageId !== messageId) {
          throw new ManagementError('version_conflict', '这条渠道消息已有不同的任务目标或原话。');
        }
        return previous;
      }
      const draftId = randomUUID(), commandId = randomUUID();
      this.db.prepare(`INSERT INTO workbench_continuation_drafts VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(draftId, commandId, channel, session, messageId, JSON.stringify(task), JSON.stringify(input), 1, 'open');
      return { id: draftId, commandId, version: 1, state: 'open' as const, task, input };
    }).immediate();
  }

  getContinuation(draftId: string, channel: WorkbenchInputOrigin['channel'], channelSessionId: string): WorkbenchContinuationDraft {
    const row = this.db.prepare(`SELECT * FROM workbench_continuation_drafts
      WHERE draft_id=? AND channel=? AND channel_session_id=?`)
      .get(identifier(draftId), channel, identifier(channelSessionId)) as ContinuationRow | undefined;
    if (!row) throw new ManagementError('not_found', '没有找到这条渠道中的待确认任务。');
    const dismissed = this.db.prepare('SELECT 1 FROM workbench_continuation_dismissals WHERE draft_id=?')
      .get(row.draft_id);
    return dismissed ? { ...this.continuation(row), state: 'dismissed' as const } : this.continuation(row);
  }

  /** Recent active cards for one verified browser focus; callers must report truncation. */
  listContinuations(channel: WorkbenchInputOrigin['channel'], channelSessionId: string,
    projectId: string, taskId: string): { readonly drafts: readonly WorkbenchContinuationDraft[]; readonly truncated: boolean } {
    const rows = this.db.prepare(`SELECT c.* FROM workbench_continuation_drafts c
      LEFT JOIN workbench_continuation_dismissals d ON d.draft_id=c.draft_id
      WHERE c.channel=? AND c.channel_session_id=? AND d.draft_id IS NULL
        AND json_extract(c.task_json,'$.projectId')=? AND json_extract(c.task_json,'$.id')=?
      ORDER BY c.rowid DESC LIMIT 21`).all(channel, identifier(channelSessionId), identifier(projectId), identifier(taskId)) as ContinuationRow[];
    return { drafts: rows.slice(0, 20).map(row => this.continuation(row)), truncated: rows.length > 20 };
  }

  reviseContinuation(draftId: string, expectedVersion: number, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string, dispatchText: string): WorkbenchContinuationDraft {
    if (!dispatchText.trim() || dispatchText.length > 120000 || dispatchText.includes('\0')) {
      throw new ManagementError('invalid_request', '确认正文无效。');
    }
    return this.db.transaction(() => {
      const draft = this.getContinuation(draftId, channel, channelSessionId);
      if (draft.state !== 'open' || draft.version !== expectedVersion) {
        throw new ManagementError('version_conflict', '工作卡已变化，请重新核对。');
      }
      const next = { ...draft.input, dispatchText };
      this.db.prepare(`UPDATE workbench_continuation_drafts SET input_json=?,version=version+1 WHERE draft_id=?`)
        .run(JSON.stringify(next), draft.id);
      return { ...draft, version: draft.version + 1, input: next };
    }).immediate();
  }

  /** Preserve exact task-space turns while keeping the original input and one command identity. */
  appendContinuationInput(draftId: string, expectedVersion: number, input: WorkbenchInput,
    dispatchText?: string, question?: string): WorkbenchContinuationDraft {
    if (!input.rawText.trim() || input.rawText.length > 120000 || input.rawText.includes('\0') ||
        dispatchText !== undefined && (!dispatchText.trim() || dispatchText.length > 120000 || dispatchText.includes('\0'))) {
      throw new ManagementError('invalid_request', '任务补充正文无效。');
    }
    return this.db.transaction(() => {
      const draft = this.getContinuation(draftId, input.origin.channel, input.origin.channelSessionId);
      const conversation = [...(draft.input.conversation ?? [])];
      const old = conversation.find(row => row.role === 'user' && row.origin.messageId === input.origin.messageId);
      if (old) {
        if (old.text !== input.rawText || JSON.stringify(old.origin) !== JSON.stringify(input.origin)) {
          throw new ManagementError('version_conflict', '同一条补充已有不同原话。');
        }
        return draft;
      }
      if (draft.state !== 'open' || draft.version !== expectedVersion) {
        throw new ManagementError('version_conflict', '工作卡已变化，请重新核对。');
      }
      conversation.push({ role: 'user', text: input.rawText, origin: input.origin });
      if (question) conversation.push({ role: 'assistant', text: question, origin: input.origin });
      const next = { ...draft.input, conversation, ...(dispatchText === undefined ? {} : { dispatchText }) };
      // Audit of an attempted confirmation does not change the reviewed provider text/version.
      const advance = dispatchText !== undefined || question !== undefined ? 1 : 0;
      this.db.prepare('UPDATE workbench_continuation_drafts SET input_json=?,version=version+? WHERE draft_id=?')
        .run(JSON.stringify(next), advance, draft.id);
      return { ...draft, version: draft.version + advance, input: next };
    }).immediate();
  }

  /** Dismiss only a still-unsubmitted card; a confirmed or uncertain command is never a cancellation. */
  dismissContinuation(draftId: string, expectedVersion: number, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string): WorkbenchContinuationDraft {
    return this.db.transaction(() => {
      const draft = this.getContinuation(draftId, channel, channelSessionId);
      if (draft.version !== expectedVersion || draft.state !== 'open') {
        throw new ManagementError('version_conflict', '待确认任务已变化或已提交，不能取消旧草稿。');
      }
      this.db.prepare(`UPDATE workbench_continuation_drafts SET version=version+1
        WHERE draft_id=? AND state='open'`).run(draft.id);
      this.db.prepare('INSERT INTO workbench_continuation_dismissals VALUES(?,?)')
        .run(draft.id, new Date().toISOString());
      return { ...draft, version: draft.version + 1, state: 'dismissed' as const };
    }).immediate();
  }

  /** Persist consent before a possible native send; a crash after this claim is read-only unknown. */
  claimContinuation(draftId: string, expectedVersion: number, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string, freeze?: ProviderContextFreeze):
    { readonly draft: WorkbenchContinuationDraft; readonly newClaim: boolean } {
    return this.db.transaction(() => {
      const draft = this.getContinuation(draftId, channel, channelSessionId);
      if (draft.version !== expectedVersion) throw new ManagementError('version_conflict', '工作卡版本已变化。');
      if (freeze && (freeze.version !== PROJECT_PROVIDER_CONTEXT_VERSION ||
          freeze.binding.commandId !== draft.commandId || freeze.binding.draftId !== draft.id ||
          freeze.binding.draftVersion !== draft.version || freeze.binding.messageId !== draft.input.inputId ||
          freeze.durableMessageText !== draft.input.dispatchText ||
          freeze.binding.projectId !== draft.task.projectId || freeze.binding.taskId !== draft.task.id ||
          freeze.binding.environmentId !== (draft.task.origin === 't3' ? draft.task.environmentId : '') ||
          freeze.binding.threadId !== (draft.task.origin === 't3' ? draft.task.threadId : '') ||
          freeze.binding.providerInstanceId !== (draft.task.origin === 't3' ? draft.task.providerInstanceId : '') ||
          !/^[a-f\d]{64}$/u.test(freeze.fingerprint) ||
          freeze.fingerprint !== providerContextFingerprint(freeze) ||
          freeze.providerProjectionText !== providerProjectionText(freeze))) {
        throw new ManagementError('version_conflict', '项目上下文与已确认任务不一致。');
      }
      if (draft.state === 'claimed') {
        if (freeze) {
          const saved = this.readProviderContextFreeze(draft.commandId);
          if (!saved || saved.fingerprint !== freeze.fingerprint ||
              JSON.stringify(saved) !== JSON.stringify(freeze)) {
            throw new ManagementError('version_conflict', '同一任务命令的项目上下文已变化。');
          }
        }
        return { draft, newClaim: false };
      }
      if (draft.state === 'dismissed') throw new ManagementError('version_conflict', '这张待确认卡已取消。');
      if (freeze) {
        const snapshot = JSON.stringify(freeze);
        if (snapshot.length > 8_000_000) throw new ManagementError('invalid_request', '项目上下文快照过大。');
        const snapshotSha256 = sha256(snapshot);
        this.db.prepare(`INSERT INTO workbench_provider_context_freezes
          (command_id,draft_id,draft_version,message_id,fingerprint,snapshot_json,snapshot_sha256)
          VALUES(?,?,?,?,?,?,?)`)
          .run(freeze.binding.commandId, freeze.binding.draftId, freeze.binding.draftVersion,
            freeze.binding.messageId, freeze.fingerprint, snapshot, snapshotSha256);
      }
      this.db.prepare(`UPDATE workbench_continuation_drafts SET state='claimed' WHERE draft_id=? AND state='open'`)
        .run(draft.id);
      return { draft: { ...draft, state: 'claimed' as const }, newClaim: true };
    }).immediate();
  }

  /** Cold recovery reads the exact selected material; no memory query or model call runs here. */
  readProviderContextFreeze(commandId: string): ProviderContextFreeze | null {
    const row = this.db.prepare('SELECT * FROM workbench_provider_context_freezes WHERE command_id=?')
      .get(identifier(commandId)) as ProviderContextFreezeRow | undefined;
    if (!row) return null;
    const actualSha256 = sha256(row.snapshot_json);
    if (actualSha256 !== row.snapshot_sha256) throw new ManagementError('version_conflict', '项目上下文快照已变化。');
    const saved = JSON.parse(row.snapshot_json) as ProviderContextFreeze;
    const draft = this.db.prepare('SELECT * FROM workbench_continuation_drafts WHERE command_id=?')
      .get(row.command_id) as ContinuationRow | undefined;
    const originalTask = draft ? JSON.parse(draft.task_json) as WorkbenchTaskRef : null;
    const originalInput = draft ? JSON.parse(draft.input_json) as WorkbenchInput : null;
    if (!draft || saved.status !== 'ready' || saved.binding.commandId !== row.command_id ||
        saved.version !== PROJECT_PROVIDER_CONTEXT_VERSION || saved.binding.draftId !== draft.draft_id ||
        saved.binding.draftId !== row.draft_id || saved.binding.draftVersion !== row.draft_version ||
        saved.binding.messageId !== row.message_id || saved.binding.messageId !== originalInput?.inputId ||
        saved.binding.projectId !== originalTask?.projectId || saved.binding.taskId !== originalTask?.id ||
        saved.binding.environmentId !== (originalTask?.origin === 't3' ? originalTask.environmentId : '') ||
        saved.binding.threadId !== (originalTask?.origin === 't3' ? originalTask.threadId : '') ||
        saved.binding.providerInstanceId !== (originalTask?.origin === 't3' ? originalTask.providerInstanceId : '') ||
        saved.fingerprint !== row.fingerprint || saved.durableMessageText !== originalInput?.dispatchText ||
        saved.fingerprint !== providerContextFingerprint(saved) ||
        saved.providerProjectionText !== providerProjectionText(saved) ||
        draft.state !== 'claimed') {
      throw new ManagementError('version_conflict', '项目上下文与原确认不一致。');
    }
    return saved;
  }

  /** Claim before any native dispatch. A repeat never gets fresh native IDs or a second send. */
  claimNativeCreate(input: { operationId: string; digest: string; environmentId: string;
    projectId: string; workspaceRoot: string; title: string; model: string; provider?: 'codex' | 'dsh'; reasoningEffort?: string;
    existingT3ProjectId?: string }): NativeCreateIntent {
    const operationId = identifier(input.operationId), environmentId = identifier(input.environmentId),
      projectId = identifier(input.projectId);
    if (!/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(operationId) ||
        !/^[a-f\d]{64}$/iu.test(input.digest) || !isAbsolute(input.workspaceRoot)) {
      throw new ManagementError('invalid_request', '原生创建操作标识或项目位置无效。');
    }
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT * FROM native_create_intents WHERE operation_id=?').get(operationId) as CreateRow | undefined;
      if (old) {
        if (old.digest !== input.digest || old.environment_id !== environmentId || old.project_id !== projectId ||
            old.workspace_root !== input.workspaceRoot || input.existingT3ProjectId &&
            old.t3_project_id !== input.existingT3ProjectId) {
          throw new ManagementError('version_conflict', '创建操作已绑定另一项目或配置。');
        }
        const saved = this.db.prepare('SELECT title,model FROM native_create_inputs WHERE operation_id=?')
          .get(operationId) as { title: string; model: string } | undefined;
        if (saved && (saved.title !== input.title || saved.model !== input.model)) {
          throw new ManagementError('version_conflict', '创建操作的原始输入已变化。');
        }
        if (!saved) this.db.prepare('INSERT INTO native_create_inputs VALUES(?,?,?)').run(operationId,
          identifier(input.title), identifier(input.model));
        return createIntent(old);
      }
      const nativeId = input.existingT3ProjectId ? identifier(input.existingT3ProjectId) : randomUUID();
      const row: CreateRow = { operation_id: operationId, digest: input.digest, environment_id: environmentId,
        project_id: projectId, workspace_root: input.workspaceRoot, t3_project_id: nativeId,
        thread_id: randomUUID(), project_command_id: randomUUID(), thread_command_id: randomUUID(),
        created_at: new Date().toISOString(), project_phase: input.existingT3ProjectId ? 'accepted' : 'new',
        thread_phase: 'new' };
      this.db.prepare(`INSERT INTO native_create_intents VALUES(@operation_id,@digest,@environment_id,@project_id,
        @workspace_root,@t3_project_id,@thread_id,@project_command_id,@thread_command_id,@created_at,
        @project_phase,@thread_phase)`).run(row);
      this.db.prepare('INSERT INTO native_create_inputs VALUES(?,?,?)').run(operationId,
        identifier(input.title), identifier(input.model));
      this.db.prepare('INSERT INTO native_create_provider_inputs VALUES(?,?,?)').run(operationId,
        input.provider ?? 'codex', input.reasoningEffort ?? null);
      return createIntent(row);
    }).immediate();
  }

  /** Local-only discovery after a browser or service restart; this never sends or reconciles a native command. */
  listUnfinishedNativeCreates(projectId: string): NativeCreateRecovery[] {
    return this.db.prepare(`SELECT i.operation_id AS operationId, i.project_id AS projectId,
      r.title, r.model, COALESCE(p.provider,'codex') AS provider, p.reasoning_effort AS reasoningEffort, i.created_at AS createdAt, i.project_phase AS projectPhase,
      i.thread_phase AS threadPhase FROM native_create_intents i
      LEFT JOIN native_create_inputs r ON r.operation_id=i.operation_id
      LEFT JOIN native_create_provider_inputs p ON p.operation_id=i.operation_id
      WHERE i.project_id=? AND (i.thread_phase!='accepted' OR NOT EXISTS (
        SELECT 1 FROM task_refs t WHERE t.environment_id=i.environment_id AND t.thread_id=i.thread_id))
      ORDER BY i.created_at DESC, i.operation_id DESC`).all(identifier(projectId)) as NativeCreateRecovery[];
  }

  getNativeCreate(operationId: string): NativeCreateIntent | null {
    const row = this.db.prepare('SELECT * FROM native_create_intents WHERE operation_id=?')
      .get(identifier(operationId)) as CreateRow | undefined;
    return row ? createIntent(row) : null;
  }

  startNativeCreatePhase(operationId: string, kind: 'project' | 'thread'): boolean {
    const column = kind === 'project' ? 'project_phase' : 'thread_phase';
    return this.db.prepare(`UPDATE native_create_intents SET ${column}='claimed' WHERE operation_id=? AND ${column}='new'`)
      .run(identifier(operationId)).changes === 1;
  }

  setNativeCreatePhase(operationId: string, kind: 'project' | 'thread', phase: 'accepted' | 'rejected' | 'unknown'): void {
    const column = kind === 'project' ? 'project_phase' : 'thread_phase';
    const result = this.db.prepare(`UPDATE native_create_intents SET ${column}=? WHERE operation_id=? AND ${column} IN
      ('claimed','unknown')`).run(phase, identifier(operationId));
    if (result.changes !== 1 && this.getNativeCreate(operationId)?.[kind === 'project' ? 'projectPhase' : 'threadPhase'] !== phase) {
      throw new ManagementError('version_conflict', '创建操作状态已变化。');
    }
  }

  /** Caller must supply the selected local project and a fresh native project shell from the named environment. */
  bindProject(project: ProjectEntry, environmentId: string,
    native: { readonly id: string; readonly workspaceRoot: string }, workspaceRoot: string): VerifiedT3ProjectBinding {
    const localId = identifier(project.id), env = identifier(environmentId), nativeId = identifier(native.id);
    if (!isAbsolute(workspaceRoot) || native.workspaceRoot !== workspaceRoot || workspaceRoot.includes('\0')) {
      throw new ManagementError('invalid_request', '原生项目的工作目录与所选绑定不一致。');
    }
    const candidate: VerifiedT3ProjectBinding = { projectId: localId, environmentId: env, t3ProjectId: nativeId,
      workspaceRoot, verifiedAt: new Date().toISOString() };
    return this.db.transaction(() => {
      const owner = this.db.prepare('SELECT * FROM project_bindings WHERE environment_id=? AND t3_project_id=?')
        .get(env, nativeId) as BindingRow | undefined;
      if (owner && (owner.project_id !== localId || owner.workspace_root !== workspaceRoot)) {
        throw new ManagementError('version_conflict', '这个原生项目已有不同的项目绑定。');
      }
      if (owner) return binding(owner);
      this.db.prepare('INSERT INTO project_bindings VALUES(?,?,?,?,?)')
        .run(localId, env, nativeId, workspaceRoot, candidate.verifiedAt);
      return candidate;
    }).immediate();
  }

  getProjectBinding(projectId: string, environmentId: string, t3ProjectId: string): VerifiedT3ProjectBinding | null {
    const row = this.db.prepare('SELECT * FROM project_bindings WHERE project_id=? AND environment_id=? AND t3_project_id=?')
      .get(identifier(projectId), identifier(environmentId), identifier(t3ProjectId)) as BindingRow | undefined;
    return row ? binding(row) : null;
  }

  listProjectBindings(projectId: string): readonly VerifiedT3ProjectBinding[] {
    return (this.db.prepare('SELECT * FROM project_bindings WHERE project_id=? ORDER BY verified_at,t3_project_id')
      .all(identifier(projectId)) as BindingRow[]).map(binding);
  }

  /** A reference is only admitted after native thread identity and its local-to-native project binding agree. */
  saveVerifiedTask(ref: WorkbenchTaskRef & { readonly origin: 't3' }, shell: T3ThreadShellRead): WorkbenchTaskRef {
    identifier(ref.id); identifier(ref.projectId); identifier(ref.environmentId); identifier(ref.t3ProjectId);
    identifier(ref.threadId); identifier(ref.providerInstanceId);
    if (!this.getProjectBinding(ref.projectId, ref.environmentId, ref.t3ProjectId)) {
      throw new ManagementError('version_conflict', '任务的原生项目绑定尚未核实。');
    }
    t3ShellToTaskEvent(ref, shell, 0, new Date().toISOString());
    return this.db.transaction(() => {
      const byId = this.db.prepare('SELECT * FROM task_refs WHERE task_id=?').get(ref.id) as
        { task_json: string } | undefined;
      const byNative = this.db.prepare('SELECT * FROM task_refs WHERE environment_id=? AND thread_id=?')
        .get(ref.environmentId, ref.threadId) as { task_id: string; task_json: string } | undefined;
      if (byNative && byNative.task_id !== ref.id) throw new ManagementError('version_conflict', '原生线程已属于另一项任务。');
      if (byId) {
        if (JSON.stringify(JSON.parse(byId.task_json)) !== JSON.stringify(ref)) {
          throw new ManagementError('version_conflict', '任务引用已绑定不同的原生身份。');
        }
        return ref;
      }
      this.db.prepare('INSERT INTO task_refs(task_id,project_id,environment_id,t3_project_id,thread_id,task_json) VALUES(?,?,?,?,?,?)')
        .run(ref.id, ref.projectId, ref.environmentId, ref.t3ProjectId, ref.threadId, JSON.stringify(ref));
      return ref;
    }).immediate();
  }

  getTask(taskId: string): { readonly task: WorkbenchTaskRef; readonly projection: TaskProjection | null } | null {
    const row = this.db.prepare('SELECT task_json,projection_json FROM task_refs WHERE task_id=?')
      .get(identifier(taskId)) as TaskRow | undefined;
    return row ? { task: JSON.parse(row.task_json) as WorkbenchTaskRef,
      projection: row.projection_json ? JSON.parse(row.projection_json) as TaskProjection : null } : null;
  }

  getTaskByNative(environmentId: string, threadId: string):
    { readonly task: WorkbenchTaskRef; readonly projection: TaskProjection | null } | null {
    const row = this.db.prepare('SELECT task_json,projection_json FROM task_refs WHERE environment_id=? AND thread_id=?')
      .get(identifier(environmentId), identifier(threadId)) as TaskRow | undefined;
    return row ? { task: JSON.parse(row.task_json) as WorkbenchTaskRef,
      projection: row.projection_json ? JSON.parse(row.projection_json) as TaskProjection : null } : null;
  }

  listTasks(projectId: string): readonly { readonly task: WorkbenchTaskRef; readonly projection: TaskProjection | null }[] {
    const rows = this.db.prepare('SELECT task_json,projection_json FROM task_refs WHERE project_id=? ORDER BY rowid DESC')
      .all(identifier(projectId)) as TaskRow[];
    return rows.map(row => ({ task: JSON.parse(row.task_json) as WorkbenchTaskRef,
      projection: row.projection_json ? JSON.parse(row.projection_json) as TaskProjection : null }));
  }

  /** Read-only startup scan. A returned reference still needs a native identity/status refresh. */
  scanRecoverableTasks(cursor?: string, limit = 100): { readonly tasks: readonly WorkbenchTaskRef[];
    readonly nextCursor: string | null } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ManagementError('invalid_request', '恢复扫描数量无效。');
    const match = cursor === undefined ? null : /^r:([1-9][0-9]*)$/.exec(cursor);
    if (cursor !== undefined && (!match || !Number.isSafeInteger(Number(match[1])))) {
      throw new ManagementError('invalid_request', '恢复扫描游标无效。');
    }
    const after = match ? Number(match[1]) : 0;
    const rows = this.db.prepare(`SELECT rowid AS ordinal,task_json FROM task_refs
      WHERE rowid>? AND (projection_json IS NULL OR
        COALESCE(json_extract(projection_json,'$.phase'),'unknown') NOT IN ('completed','failed','cancelled'))
      ORDER BY rowid ASC LIMIT ?`).all(after, limit + 1) as { ordinal: number; task_json: string }[];
    const page = rows.slice(0, limit);
    return { tasks: page.map(row => JSON.parse(row.task_json) as WorkbenchTaskRef),
      nextCursor: rows.length > limit ? `r:${page[page.length - 1]!.ordinal}` : null };
  }

  createWebFocusProfile(): string {
    const profileId = randomUUID();
    this.db.prepare('INSERT INTO web_focus_profiles VALUES(?,?)').run(profileId, new Date().toISOString());
    return profileId;
  }

  hasWebFocusProfile(profileId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM web_focus_profiles WHERE profile_id=?').get(identifier(profileId));
  }

  getWebFocus(profileId: string, projectId: string): { readonly revision: number; readonly taskId: string | null } {
    const row = this.db.prepare('SELECT task_id,revision FROM web_task_focus WHERE profile_id=? AND project_id=?')
      .get(identifier(profileId), identifier(projectId)) as WebFocusRow | undefined;
    return row ? { revision: row.revision, taskId: row.task_id } : { revision: 0, taskId: null };
  }

  getDesktopFocus(): { readonly revision: number; readonly projectId: string | null;
    readonly taskId: string | null } {
    const row = this.db.prepare('SELECT project_id,task_id,revision FROM desktop_task_focus WHERE identity=1')
      .get() as { project_id: string | null; task_id: string | null; revision: number } | undefined;
    return row ? { revision: row.revision, projectId: row.project_id, taskId: row.task_id }
      : { revision: 0, projectId: null, taskId: null };
  }

  putDesktopFocus(projectId: string | null, taskId: string | null, expectedRevision: number) {
    const project = projectId === null ? null : identifier(projectId);
    const task = taskId === null ? null : identifier(taskId);
    if (task && !project || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ManagementError('invalid_request', '桌宠任务焦点参数无效。');
    }
    return this.db.transaction(() => {
      const prior = this.getDesktopFocus();
      if (prior.revision !== expectedRevision) throw new ManagementError('version_conflict', '桌宠任务焦点已变化。');
      if (task) {
        const selected = this.getTask(task);
        if (!selected || selected.task.projectId !== project || selected.task.origin !== 't3') {
          throw new ManagementError('not_found', '没有这个项目中已核实的原生任务。');
        }
      }
      if (prior.projectId === project && prior.taskId === task) return prior;
      const revision = prior.revision + 1;
      if (!prior.revision) this.db.prepare('INSERT INTO desktop_task_focus VALUES(1,?,?,?)')
        .run(project, task, revision);
      else this.db.prepare('UPDATE desktop_task_focus SET project_id=?,task_id=?,revision=? WHERE identity=1')
        .run(project, task, revision);
      return { revision, projectId: project, taskId: task };
    }).immediate();
  }

  putWebFocus(profileId: string, projectId: string, taskId: string | null, expectedRevision: number):
    { readonly revision: number; readonly taskId: string | null } {
    const profile = identifier(profileId), project = identifier(projectId), task = taskId === null ? null : identifier(taskId);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ManagementError('invalid_request', '焦点版本无效。');
    }
    return this.db.transaction(() => {
      if (!this.hasWebFocusProfile(profile)) throw new ManagementError('version_conflict', '浏览器焦点身份已变化。');
      const prior = this.getWebFocus(profile, project);
      if (prior.revision !== expectedRevision) throw new ManagementError('version_conflict', '焦点已由另一页面更新。');
      if (task) {
        const selected = this.getTask(task);
        if (!selected || selected.task.projectId !== project || selected.task.origin !== 't3') {
          throw new ManagementError('not_found', '没有这个项目中已核实的原生任务。');
        }
      }
      if (task === prior.taskId) return prior;
      const revision = prior.revision + 1;
      if (prior.revision === 0) this.db.prepare('INSERT INTO web_task_focus VALUES(?,?,?,?)').run(profile, project, task, revision);
      else this.db.prepare('UPDATE web_task_focus SET task_id=?,revision=? WHERE profile_id=? AND project_id=?')
        .run(task, revision, profile, project);
      return { revision, taskId: task };
    }).immediate();
  }

  recordEvent(event: WorkbenchTaskEvent): TaskProjection {
    return this.db.transaction(() => {
      const current = this.getTask(event.taskId);
      if (!current) throw new ManagementError('not_found', '没有已核实的任务引用。');
      const projection = applyTaskEvent(current.projection, event);
      if (projection !== current.projection) {
        this.db.prepare('UPDATE task_refs SET projection_json=? WHERE task_id=?')
          .run(JSON.stringify(projection), event.taskId);
        if (projection.terminalEvent?.eventId === event.eventId) {
          this.db.prepare('INSERT OR IGNORE INTO workbench_terminal_outbox VALUES(?,?,?)')
            .run(event.taskId, event.eventId, JSON.stringify(event));
        }
      }
      return projection;
    }).immediate();
  }

  /** Replays after a crash between workbench commit and the separate project-memory queue commit. */
  pendingTerminalEvidence(extractionVersion: string, limit = 100): readonly ProjectTerminalEvidence[] {
    const version = identifier(extractionVersion);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ManagementError('invalid_request', '终态读取数量无效。');
    const rows = this.db.prepare(`SELECT o.task_id,o.event_json,t.task_json FROM workbench_terminal_outbox o
      JOIN task_refs t ON t.task_id=o.task_id
      LEFT JOIN workbench_terminal_delivery d ON d.task_id=o.task_id AND d.event_id=o.event_id
        AND d.extraction_version=?
      WHERE d.task_id IS NULL ORDER BY o.rowid LIMIT ?`).all(version, limit) as
      { task_id: string; event_json: string; task_json: string }[];
    return rows.map(row => {
      const task = JSON.parse(row.task_json) as WorkbenchTaskRef;
      const event = JSON.parse(row.event_json) as WorkbenchTaskEvent;
      const evidence = projectTerminalEvidence(task.projectId, { taskId: row.task_id,
        sequence: event.sequence, eventId: event.eventId, phase: event.phase,
        terminalEvent: event }, version);
      if (!evidence) throw new ManagementError('unavailable', '终态记录待核对。');
      return evidence;
    });
  }

  hasTerminalEvidence(evidence: ProjectTerminalEvidence): boolean {
    const row = this.db.prepare(`SELECT o.event_json,t.task_json FROM workbench_terminal_outbox o
      JOIN task_refs t ON t.task_id=o.task_id WHERE o.task_id=? AND o.event_id=?`)
      .get(identifier(evidence.taskId), identifier(evidence.terminalEventId)) as
      { event_json: string; task_json: string } | undefined;
    if (!row) return false;
    const task = JSON.parse(row.task_json) as WorkbenchTaskRef;
    const event = JSON.parse(row.event_json) as WorkbenchTaskEvent;
    const recorded = projectTerminalEvidence(task.projectId, { taskId: evidence.taskId,
      sequence: event.sequence, eventId: event.eventId, phase: event.phase,
      terminalEvent: event }, evidence.extractionVersion);
    return recorded !== null && recorded.projectId === evidence.projectId &&
      recorded.taskId === evidence.taskId && recorded.nativeTurnId === evidence.nativeTurnId &&
      recorded.terminalEventId === evidence.terminalEventId &&
      recorded.terminalPhase === evidence.terminalPhase && recorded.resultRef === evidence.resultRef &&
      recorded.extractionVersion === evidence.extractionVersion &&
      Number.isFinite(Date.parse(evidence.occurredAt)) &&
      Date.parse(recorded.occurredAt) === Date.parse(evidence.occurredAt);
  }

  markTerminalDelivered(evidence: ProjectTerminalEvidence): void {
    if (!this.hasTerminalEvidence(evidence)) throw new ManagementError('version_conflict', '终态来源已变化。');
    this.db.prepare('INSERT OR IGNORE INTO workbench_terminal_delivery VALUES(?,?,?)')
      .run(evidence.taskId, evidence.terminalEventId, evidence.extractionVersion);
  }

  close(): void { if (this.db.open) this.db.close(); }
}
