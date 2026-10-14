import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import { ManagementError } from '../contracts/management.js';
import type {
  ProjectMemoryChange, ProjectMemoryChangeResult, ProjectMemoryItem, ProjectMemoryJob, ProjectMemoryPort,
  ProjectMemoryQuery, ProjectMemorySource, ProjectTerminalEvidence,
} from '../contracts/project-memory.js';
import { projectMemoryRelevanceScore, projectMemoryTerms } from './project-memory-relevance.js';

const APPLICATION_ID = 0x504d4d31; // PMM1: separate from PET and project-index SQLite files.
const SCHEMA_VERSION = 1;
const MAX_ITEMS = 100;
type JobState = ProjectMemoryJob['state'];

export interface ProjectMemoryProposal {
  /** Stable claim identity across extraction versions and retries for this terminal event. */
  readonly stableKey: string;
  readonly kind: ProjectMemoryItem['kind'];
  readonly text: string;
  readonly sources: readonly ProjectMemorySource[];
  readonly branchRef?: string;
  readonly condition?: string;
  readonly basis: 'model_suggestion' | 'explicit_user' | 'verified_execution';
}

export interface ProjectMemoryOptions {
  readonly extractor?: (evidence: ProjectTerminalEvidence, attemptOrdinal: number) => Promise<readonly ProjectMemoryProposal[]>;
  /** Check paid-operation status before a user's explicit failed-job retry is queued. */
  readonly retryGate?: (job: ProjectMemoryJob, nextAttempt: number) => Promise<void>;
  /** Separate trusted checks; never populate these from a model's JSON response. */
  readonly verifyUserDecision?: (evidence: ProjectTerminalEvidence, proposal: ProjectMemoryProposal) => boolean;
  readonly verifyExecution?: (evidence: ProjectTerminalEvidence, proposal: ProjectMemoryProposal) => boolean;
  readonly now?: () => string;
  /** Tests and batch integrations may drive runPending explicitly. */
  readonly autoProcess?: boolean;
}

interface ItemRow {
  id: string; project_id: string; kind: ProjectMemoryItem['kind']; text: string;
  status: ProjectMemoryItem['status']; version: number; sources_json: string;
  branch_ref: string | null; condition: string | null; superseded_by_id: string | null;
  created_at: string; updated_at: string;
}
interface JobRow {
  id: string; project_id: string; evidence_json: string; state: JobState;
  attempts: number; error_code: ProjectMemoryJob['errorCode']; created_at: string; updated_at: string;
}
const fail = (detail = '项目记忆请求无效。'): never => { throw new ManagementError('invalid_request', detail); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return fail();
  return value as Record<string, unknown>;
}
function str(value: unknown, max: number, nonempty = true): string {
  if (typeof value !== 'string' || [...value].length > max || value.includes('\0') || (nonempty && !value.trim())) return fail();
  return value;
}
function identifier(value: unknown): string {
  const result = str(value, 250);
  if (/[\u0000-\u001f\u007f]/u.test(result)) return fail();
  return result;
}
function optional(value: unknown, max: number): string | undefined {
  return value === undefined ? undefined : str(value, max);
}
function timestamp(value: unknown): string {
  const result = str(value, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(result) ||
      Number.isNaN(Date.parse(result))) return fail();
  return new Date(result).toISOString();
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) return fail();
  return value;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value, (_key, part: unknown) =>
  part && typeof part === 'object' && !Array.isArray(part)
    ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : part);
const item = (row: ItemRow): ProjectMemoryItem => ({
  id: row.id, projectId: row.project_id, kind: row.kind, text: row.text, status: row.status,
  version: row.version, sources: JSON.parse(row.sources_json) as ProjectMemorySource[],
  ...(row.branch_ref === null ? {} : { branchRef: row.branch_ref }),
  ...(row.condition === null ? {} : { condition: row.condition }),
  ...(row.superseded_by_id === null ? {} : { supersededById: row.superseded_by_id }),
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const job = (row: JobRow): ProjectMemoryJob => ({
  id: row.id, projectId: row.project_id, evidence: JSON.parse(row.evidence_json) as ProjectTerminalEvidence,
  state: row.state, attempts: row.attempts, errorCode: row.error_code,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
function source(value: unknown): ProjectMemorySource {
  const v = object(value, ['taskId', 'nativeTurnId', 'terminalEventId', 'artifactRef', 'userInputId', 'recordedAt']);
  const result = {
    ...(v.taskId === undefined ? {} : { taskId: identifier(v.taskId) }),
    ...(v.nativeTurnId === undefined ? {} : { nativeTurnId: identifier(v.nativeTurnId) }),
    ...(v.terminalEventId === undefined ? {} : { terminalEventId: identifier(v.terminalEventId) }),
    ...(v.artifactRef === undefined ? {} : { artifactRef: str(v.artifactRef, 2048) }),
    ...(v.userInputId === undefined ? {} : { userInputId: identifier(v.userInputId) }),
    recordedAt: timestamp(v.recordedAt),
  };
  if (Object.keys(result).length === 1) return fail();
  return result;
}
function sources(value: unknown): ProjectMemorySource[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return fail();
  return value.map(source);
}
function evidence(value: unknown): ProjectTerminalEvidence {
  const v = object(value, ['projectId', 'taskId', 'nativeTurnId', 'terminalEventId', 'terminalPhase', 'resultRef', 'occurredAt', 'extractionVersion']);
  if (!['completed', 'failed', 'cancelled'].includes(String(v.terminalPhase))) return fail();
  return {
    projectId: identifier(v.projectId), taskId: identifier(v.taskId), nativeTurnId: identifier(v.nativeTurnId),
    terminalEventId: identifier(v.terminalEventId), terminalPhase: v.terminalPhase as ProjectTerminalEvidence['terminalPhase'],
    ...(v.resultRef === undefined ? {} : { resultRef: str(v.resultRef, 2048) }),
    occurredAt: timestamp(v.occurredAt), extractionVersion: identifier(v.extractionVersion),
  };
}
function proposal(value: unknown): ProjectMemoryProposal {
  const v = object(value, ['stableKey', 'kind', 'text', 'sources', 'branchRef', 'condition', 'basis']);
  if (!['decision', 'constraint', 'fact', 'open_question'].includes(String(v.kind))) return fail();
  if (!['model_suggestion', 'explicit_user', 'verified_execution'].includes(String(v.basis))) return fail();
  return {
    stableKey: identifier(v.stableKey), kind: v.kind as ProjectMemoryItem['kind'], text: str(v.text, 4000),
    sources: sources(v.sources), basis: v.basis as ProjectMemoryProposal['basis'],
    ...(v.branchRef === undefined ? {} : { branchRef: str(v.branchRef, 250) }),
    ...(v.condition === undefined ? {} : { condition: str(v.condition, 500) }),
  };
}
function assertDatabase(filename: string): boolean {
  if (typeof filename !== 'string' || !isAbsolute(filename) || filename.includes('\0') ||
      /^(?:companion|project-index)(?:\.sqlite)?(?:-(?:wal|shm))?$/i.test(basename(filename))) return fail('项目记忆数据库路径无效。');
  let fd: number;
  try { fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; return fail('项目记忆数据库不可读取。'); }
  try {
    if (!fstatSync(fd).isFile()) return fail();
    const header = Buffer.alloc(100), length = readSync(fd, header, 0, 100, 0);
    if (length !== 100 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0' ||
        header.readUInt32BE(68) !== APPLICATION_ID || header.readUInt32BE(60) !== SCHEMA_VERSION) return fail('项目记忆数据库身份或版本不匹配。');
    return true;
  } finally { closeSync(fd); }
}

/** Independent knowledge store; the engineering event log and companion SQLite are never opened here. */
export class SqliteProjectMemory implements ProjectMemoryPort {
  private readonly db: Database.Database;
  private readonly now: () => string;
  private readonly extractor?: ProjectMemoryOptions['extractor'];
  private readonly retryGate?: ProjectMemoryOptions['retryGate'];
  private readonly verifyUserDecision?: ProjectMemoryOptions['verifyUserDecision'];
  private readonly verifyExecution?: ProjectMemoryOptions['verifyExecution'];
  private autoProcess: boolean;
  private draining: Promise<number> | null = null;
  private selected: Promise<readonly ProjectMemoryJob[]> | null = null;
  private closed = false;

  constructor(filename: string, options: ProjectMemoryOptions = {}) {
    const existed = assertDatabase(filename);
    let created = false;
    if (!existed) {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      let fd: number | undefined;
      try { fd = openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); fchmodSync(fd, 0o600); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; assertDatabase(filename); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    this.db = new Database(filename, { fileMustExist: true });
    this.now = options.now ?? (() => new Date().toISOString());
    this.extractor = options.extractor;
    this.retryGate = options.retryGate;
    this.verifyUserDecision = options.verifyUserDecision;
    this.verifyExecution = options.verifyExecution;
    this.autoProcess = options.autoProcess ?? true;
    try {
      this.db.pragma('busy_timeout = 2000');
      if (created) {
        if (this.db.pragma('application_id', { simple: true }) !== 0 || this.db.pragma('user_version', { simple: true }) !== 0 ||
            (this.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { n: number }).n) return fail();
        this.db.transaction(() => {
          this.db.exec(`
            CREATE TABLE project_memory_items (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
              status TEXT NOT NULL, version INTEGER NOT NULL, sources_json TEXT NOT NULL,
              branch_ref TEXT, condition TEXT, superseded_by_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX project_memory_project ON project_memory_items(project_id,status,updated_at,id);
            CREATE TABLE project_memory_operations (
              operation_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL
            );
            CREATE TABLE project_memory_event_fences (
              project_id TEXT NOT NULL, task_id TEXT NOT NULL, native_turn_id TEXT NOT NULL,
              terminal_event_id TEXT NOT NULL,
              PRIMARY KEY(project_id,task_id,native_turn_id,terminal_event_id)
            );
            CREATE TABLE project_memory_jobs (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL, evidence_json TEXT NOT NULL,
              state TEXT NOT NULL, attempts INTEGER NOT NULL, error_code TEXT,
              created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX project_memory_jobs_project ON project_memory_jobs(project_id,state,created_at,id);
          `);
          this.db.pragma(`application_id = ${APPLICATION_ID}`);
          this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
        }).immediate();
      } else {
        const names = new Set((this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
        if (['project_memory_items', 'project_memory_operations', 'project_memory_event_fences', 'project_memory_jobs']
          .some(name => !names.has(name))) return fail('项目记忆数据库结构不完整。');
      }
    } catch (error) { this.db.close(); throw error; }
    if (this.autoProcess && this.extractor) this.schedule();
  }

  private open(): void { if (this.closed || !this.db.open) throw new ManagementError('unavailable', '项目记忆库已关闭。'); }
  /** Bootstrap calls this only after recovering interrupted jobs and binding the exact T3 reader. */
  startProcessing(): void {
    this.open();
    if (this.selected) return fail('有限整理进行中。');
    if (!this.extractor) throw new ManagementError('unavailable', '项目记忆后台整理尚未配置。');
    if (this.autoProcess) return;
    this.autoProcess = true;
    this.schedule();
  }
  private clock(): string { return timestamp(this.now()); }
  private row(projectId: string, id: string): ItemRow | undefined {
    return this.db.prepare('SELECT * FROM project_memory_items WHERE project_id=? AND id=?').get(projectId, id) as ItemRow | undefined;
  }

  async list(query: ProjectMemoryQuery): Promise<readonly ProjectMemoryItem[]> {
    this.open(); const v = object(query, ['projectId', 'text', 'branchRef', 'limit', 'includeCandidates']);
    const projectId = identifier(v.projectId), text = v.text === undefined ? '' : str(v.text, 500, false);
    const branch = optional(v.branchRef, 250), limit = positive(v.limit, MAX_ITEMS);
    if (v.includeCandidates !== undefined && typeof v.includeCandidates !== 'boolean') return fail();
    const rows = this.db.prepare(`SELECT * FROM project_memory_items WHERE project_id=?
      AND (?='' OR instr(lower(text),lower(?))>0)
      AND (? IS NULL OR branch_ref IS NULL OR branch_ref=?)
      ORDER BY updated_at DESC,id LIMIT ?`).all(projectId, text, text, branch ?? null, branch ?? '', limit) as ItemRow[];
    return rows.map(item);
  }

  async get(projectId: string, id: string): Promise<ProjectMemoryItem | null> {
    this.open(); const row = this.row(identifier(projectId), identifier(id)); return row ? item(row) : null;
  }

  async recall(query: ProjectMemoryQuery): Promise<readonly ProjectMemoryItem[]> {
    this.open(); const v = object(query, ['projectId', 'text', 'branchRef', 'limit', 'includeCandidates', 'relevance']);
    const projectId = identifier(v.projectId), text = v.text === undefined ? '' : str(v.text, 500, false);
    const branch = optional(v.branchRef, 250), limit = positive(v.limit, MAX_ITEMS);
    if (v.includeCandidates !== undefined && typeof v.includeCandidates !== 'boolean') return fail();
    if (v.relevance !== undefined) {
      const relevance = object(v.relevance, ['currentText', 'newestUserText']);
      const current = projectMemoryTerms(str(relevance.currentText, 240000, false));
      const newest = projectMemoryTerms(str(relevance.newestUserText, 240000, false));
      type Ranked = { value: ProjectMemoryItem; score: number };
      const ranked: Ranked[] = [];
      const compare = (a: Ranked, b: Ranked): number =>
        (a.value.status === 'accepted' ? 0 : 1) - (b.value.status === 'accepted' ? 0 : 1) ||
        b.score - a.score || b.value.updatedAt.localeCompare(a.value.updatedAt) ||
        a.value.id.localeCompare(b.value.id);
      // Iterate the full eligible project set, retaining only the best `limit` rows in memory.
      const rows = this.db.prepare(`SELECT * FROM project_memory_items WHERE project_id=?
        AND (status='accepted' OR (?=1 AND status='candidate'))
        AND superseded_by_id IS NULL
        AND (?='' OR instr(lower(text),lower(?))>0)
        AND (branch_ref IS NULL OR branch_ref=?)`)
        .iterate(projectId, v.includeCandidates ? 1 : 0, text, text, branch ?? '') as IterableIterator<ItemRow>;
      for (const row of rows) {
        const value = item(row), entry = { value, score: projectMemoryRelevanceScore(row.text, current, newest) };
        let index = 0;
        while (index < ranked.length && compare(ranked[index]!, entry) <= 0) index++;
        ranked.splice(index, 0, entry);
        if (ranked.length > limit) ranked.pop();
      }
      return ranked.map(entry => entry.value);
    }
    const rows = this.db.prepare(`SELECT * FROM project_memory_items WHERE project_id=?
      AND (status='accepted' OR (?=1 AND status='candidate'))
      AND (?='' OR instr(lower(text),lower(?))>0)
      AND (branch_ref IS NULL OR branch_ref=?)
      ORDER BY CASE WHEN status='accepted' THEN 0 ELSE 1 END,updated_at DESC,id LIMIT ?`)
      .all(projectId, v.includeCandidates ? 1 : 0, text, text, branch ?? '', limit) as ItemRow[];
    return rows.map(item);
  }

  async change(input: ProjectMemoryChange): Promise<ProjectMemoryChangeResult> {
    this.open(); const v = object(input, ['operationId', 'type', 'projectId', 'kind', 'text', 'status', 'sources', 'branchRef', 'condition', 'id', 'expectedVersion', 'source']);
    const operationId = identifier(v.operationId), projectId = identifier(v.projectId);
    const signature = hash(canonical(v));
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT payload_hash,result_json FROM project_memory_operations WHERE operation_id=?')
        .get(operationId) as { payload_hash: string; result_json: string } | undefined;
      if (prior) {
        if (prior.payload_hash !== signature) return fail('同一操作编号的内容不一致。');
        return JSON.parse(prior.result_json) as ProjectMemoryChangeResult;
      }
      let result: ProjectMemoryChangeResult;
      const now = this.clock();
      if (v.type === 'create') {
        if (!['decision', 'constraint', 'fact', 'open_question'].includes(String(v.kind)) || !['candidate', 'accepted'].includes(String(v.status))) return fail();
        const refs = sources(v.sources), status = v.status as ProjectMemoryItem['status'];
        if (status === 'accepted' && !refs.some(ref => ref.userInputId)) {
          result = { operationId, state: 'rejected', detail: 'accepted_requires_explicit_user_source' };
        } else {
          const id = `pm_${randomUUID()}`;
          this.db.prepare('INSERT INTO project_memory_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
            id, projectId, v.kind, str(v.text, 4000), status, 1, JSON.stringify(refs),
            optional(v.branchRef, 250) ?? null, optional(v.condition, 500) ?? null, null, now, now,
          );
          result = { operationId, state: 'applied', item: item(this.row(projectId, id)!) };
        }
      } else if (v.type === 'edit' || v.type === 'accept' || v.type === 'withdraw') {
        const id = identifier(v.id), expectedVersion = positive(v.expectedVersion), current = this.row(projectId, id);
        if (!current) result = { operationId, state: 'rejected', detail: 'not_found' };
        else if (current.version !== expectedVersion) result = { operationId, state: 'conflict', item: item(current), detail: 'version_conflict' };
        else if (current.status === 'withdrawn') result = { operationId, state: 'rejected', item: item(current), detail: 'withdrawn_is_final' };
        else {
          const editSource = v.source === undefined ? undefined : source(v.source);
          if (v.type === 'accept' && !editSource?.userInputId) result = { operationId, state: 'rejected', item: item(current), detail: 'accept_requires_explicit_user_source' };
          else if (v.type === 'edit' && (v.text === undefined || !editSource?.userInputId)) result = { operationId, state: 'rejected', item: item(current), detail: 'edit_requires_user_source' };
          else {
            const nextText = v.type === 'edit' ? str(v.text, 4000) : current.text;
            let nextKind = current.kind;
            let nextBranch = current.branch_ref;
            let nextCondition = current.condition;
            if (v.type === 'edit') {
              if (v.kind !== undefined) {
                if (!['decision', 'constraint', 'fact', 'open_question'].includes(String(v.kind))) return fail();
                nextKind = v.kind as ProjectMemoryItem['kind'];
              }
              if (v.branchRef !== undefined) nextBranch = v.branchRef === null ? null : str(v.branchRef, 250);
              if (v.condition !== undefined) nextCondition = v.condition === null ? null : str(v.condition, 500);
            }
            const nextStatus = v.type === 'withdraw' ? 'withdrawn' : v.type === 'accept' ? 'accepted' : current.status;
            const refs = editSource ? [...(JSON.parse(current.sources_json) as ProjectMemorySource[]), editSource] : JSON.parse(current.sources_json) as ProjectMemorySource[];
            this.db.prepare(`UPDATE project_memory_items
              SET kind=?,text=?,branch_ref=?,condition=?,status=?,version=version+1,sources_json=?,updated_at=?
              WHERE project_id=? AND id=? AND version=?`).run(
                nextKind, nextText, nextBranch, nextCondition, nextStatus, JSON.stringify(refs), now, projectId, id, expectedVersion,
              );
            if (v.type === 'withdraw') {
              for (const ref of refs) {
                if (ref.taskId && ref.nativeTurnId && ref.terminalEventId) {
                  this.db.prepare('INSERT OR IGNORE INTO project_memory_event_fences VALUES(?,?,?,?)')
                    .run(projectId, ref.taskId, ref.nativeTurnId, ref.terminalEventId);
                }
              }
            }
            result = { operationId, state: 'applied', item: item(this.row(projectId, id)!) };
          }
        }
      } else return fail();
      this.db.prepare('INSERT INTO project_memory_operations VALUES(?,?,?)').run(operationId, signature, JSON.stringify(result));
      return result;
    }).immediate();
  }

  async enqueueTerminal(input: ProjectTerminalEvidence): Promise<{ readonly jobId: string; readonly state: 'queued' | 'already_queued' }> {
    this.open(); const frozen = evidence(input);
    const id = `pmj_${hash([frozen.projectId, frozen.taskId, frozen.nativeTurnId, frozen.terminalEventId, frozen.extractionVersion].join('\0')).slice(0, 40)}`;
    const result = this.db.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM project_memory_jobs WHERE id=?').get(id) as JobRow | undefined;
      if (prior) {
        if (JSON.stringify(frozen) !== prior.evidence_json) return fail('同一终态事件的证据不一致。');
        return { jobId: id, state: 'already_queued' as const };
      }
      const now = this.clock();
      this.db.prepare('INSERT INTO project_memory_jobs VALUES(?,?,?,?,?,?,?,?)').run(id, frozen.projectId, JSON.stringify(frozen), 'queued', 0, null, now, now);
      return { jobId: id, state: 'queued' as const };
    }).immediate();
    if (result.state === 'queued' && this.autoProcess && this.extractor) this.schedule();
    return result;
  }

  async getJob(projectId: string, jobId: string): Promise<ProjectMemoryJob | null> {
    this.open(); const row = this.db.prepare('SELECT * FROM project_memory_jobs WHERE project_id=? AND id=?')
      .get(identifier(projectId), identifier(jobId)) as JobRow | undefined;
    return row ? job(row) : null;
  }

  async listJobs(projectId: string, limit = 50): Promise<readonly ProjectMemoryJob[]> {
    this.open(); const rows = this.db.prepare('SELECT * FROM project_memory_jobs WHERE project_id=? ORDER BY created_at DESC,id LIMIT ?')
      .all(identifier(projectId), positive(limit, MAX_ITEMS)) as JobRow[];
    return rows.map(job);
  }

  async retryJob(projectId: string, jobId: string): Promise<ProjectMemoryJob> {
    this.open();
    const initial = this.db.prepare('SELECT * FROM project_memory_jobs WHERE project_id=? AND id=?')
      .get(identifier(projectId), identifier(jobId)) as JobRow | undefined;
    if (!initial) throw new ManagementError('not_found', '没有这个项目记忆处理任务。');
    if (initial.state !== 'failed') return job(initial);
    await this.retryGate?.(job(initial), initial.attempts + 1);
    this.open(); const result = this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM project_memory_jobs WHERE project_id=? AND id=?')
        .get(identifier(projectId), identifier(jobId)) as JobRow | undefined;
      if (!row) throw new ManagementError('not_found', '没有这个项目记忆处理任务。');
      if (row.state !== 'failed') return job(row);
      if (row.attempts !== initial.attempts) throw new ManagementError('version_conflict', '项目记忆处理任务已更新，请刷新后重试。');
      this.db.prepare("UPDATE project_memory_jobs SET state='queued',error_code=NULL,updated_at=? WHERE id=?").run(this.clock(), row.id);
      return job(this.db.prepare('SELECT * FROM project_memory_jobs WHERE id=?').get(row.id) as JobRow);
    }).immediate();
    if (result.state === 'queued' && this.autoProcess && this.extractor) this.schedule();
    return result;
  }

  /** Call once the former worker is known stopped; a second live reader must not steal its running job. */
  async recoverInterruptedJobs(): Promise<number> {
    this.open();
    if (this.selected || this.draining) return fail('整理进程尚未停止。');
    const updated = this.db.prepare("UPDATE project_memory_jobs SET state='failed',error_code='interrupted',updated_at=? WHERE state='running'")
      .run(this.clock());
    return updated.changes;
  }

  private schedule(): void {
    setImmediate(() => { if (!this.closed) void this.runPending().catch(() => undefined); }).unref();
  }

  /** Runs only queued work. No raw terminal transcript or model output is stored in this queue. */
  async runPending(): Promise<number> {
    this.open();
    if (this.selected) return fail('有限整理进行中。');
    if (!this.extractor) return 0;
    if (this.draining) return this.draining;
    this.draining = this.drain();
    try { return await this.draining; } finally { this.draining = null; }
  }

  /** One ordered first-attempt batch on the original queue. No recovery, retry or global scheduling. */
  async runSelectedFirstAttempts(inputs: readonly Pick<ProjectMemoryJob, 'id' | 'projectId' | 'evidence'>[]):
    Promise<readonly ProjectMemoryJob[]> {
    this.open();
    if (this.autoProcess || this.draining || this.selected || !this.extractor || inputs.length !== 2) return fail();
    const targets = inputs.map(input => ({ id: identifier(input.id), projectId: identifier(input.projectId),
      evidence: evidence(input.evidence) }));
    // Every caller must use the same order; no runner may skip the first row and take the second.
    if (targets[0]!.id >= targets[1]!.id || targets.some(t => t.projectId !== t.evidence.projectId)) return fail();
    const claim = (index: number): JobRow => this.db.transaction(() => {
      this.open();
      if (this.autoProcess || this.db.prepare("SELECT 1 FROM project_memory_jobs WHERE state='running' LIMIT 1").get()) return fail();
      const rows = targets.map((target, i) => {
        const row = this.db.prepare('SELECT * FROM project_memory_jobs WHERE id=? AND project_id=?')
          .get(target.id, target.projectId) as JobRow | undefined;
        if (!row || canonical(JSON.parse(row.evidence_json)) !== canonical(target.evidence) ||
            row.state !== (i < index ? 'done' : 'queued') || row.attempts !== (i < index ? 1 : 0)) return fail();
        return row;
      });
      const row = rows[index]!, updatedAt = this.clock();
      const result = this.db.prepare("UPDATE project_memory_jobs SET state='running',attempts=1,updated_at=? WHERE id=? AND project_id=? AND state='queued' AND attempts=0 AND evidence_json=?")
        .run(updatedAt, row.id, row.project_id, row.evidence_json);
      if (result.changes !== 1) return fail();
      return { ...row, state: 'running' as const, attempts: 1, updated_at: updatedAt };
    }).immediate();
    // Initial all-row preflight and the first claim are one synchronous transaction, before any await.
    const first = claim(0);
    this.selected = Promise.resolve().then(async () => {
      const results: ProjectMemoryJob[] = [];
      for (let index = 0; index < targets.length; index++) {
        const row = index === 0 ? first : claim(index);
        const committed = await this.processClaimed(row);
        const current = await this.getJob(row.project_id, row.id);
        if (current) results.push(current);
        if (!committed || current?.state !== 'done' || current.attempts !== 1) break;
      }
      return results;
    });
    try { return await this.selected; } finally { this.selected = null; }
  }

  private async drain(): Promise<number> {
    let processed = 0;
    while (!this.closed) {
      const row = this.db.transaction(() => {
        const next = this.db.prepare("SELECT * FROM project_memory_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1").get() as JobRow | undefined;
        if (!next) return null;
        const updatedAt = this.clock();
        this.db.prepare("UPDATE project_memory_jobs SET state='running',attempts=attempts+1,updated_at=? WHERE id=?").run(updatedAt, next.id);
        return { ...next, state: 'running' as const, attempts: next.attempts + 1, updated_at: updatedAt };
      }).immediate();
      if (!row) break;
      await this.processClaimed(row);
      processed++;
    }
    return processed;
  }

  /** Both entries use this body; a late callback must prove ownership before any proposal write. */
  private async processClaimed(row: JobRow): Promise<boolean> {
    const owns = (): boolean => !!this.db.prepare(`SELECT 1 FROM project_memory_jobs WHERE id=? AND project_id=?
      AND state='running' AND attempts=? AND evidence_json=? AND updated_at=?`)
      .get(row.id, row.project_id, row.attempts, row.evidence_json, row.updated_at);
    try {
      const frozen = Object.freeze(evidence(JSON.parse(row.evidence_json)));
      const proposals = await this.extractor!(frozen, row.attempts);
      if (!Array.isArray(proposals) || proposals.length > MAX_ITEMS) return fail();
      return this.db.transaction(() => {
        if (!owns()) return false;
        for (const raw of proposals) this.applyProposal(frozen, proposal(raw));
        this.db.prepare("UPDATE project_memory_jobs SET state='done',error_code=NULL,updated_at=? WHERE id=?")
          .run(this.clock(), row.id);
        return true;
      }).immediate();
    } catch {
      // Provider errors may contain secrets or transcript text. Never overwrite a newer owner/state.
      this.db.transaction(() => {
        if (owns()) this.db.prepare("UPDATE project_memory_jobs SET state='failed',error_code='extraction_failed',updated_at=? WHERE id=?")
          .run(this.clock(), row.id);
      }).immediate();
      return false;
    }
  }

  private applyProposal(terminal: ProjectTerminalEvidence, value: ProjectMemoryProposal): void {
    const fenced = this.db.prepare(`SELECT 1 FROM project_memory_event_fences
      WHERE project_id=? AND task_id=? AND native_turn_id=? AND terminal_event_id=?`)
      .get(terminal.projectId, terminal.taskId, terminal.nativeTurnId, terminal.terminalEventId);
    if (fenced) return;
    const linked = value.sources.some(ref => ref.taskId === terminal.taskId && ref.nativeTurnId === terminal.nativeTurnId &&
      ref.terminalEventId === terminal.terminalEventId);
    if (!linked) return fail('项目记忆来源与终态事件不一致。');
    const acceptedUser = value.basis === 'explicit_user' && value.sources.some(ref => ref.userInputId) &&
      this.verifyUserDecision?.(terminal, value) === true;
    const acceptedFact = value.basis === 'verified_execution' &&
      terminal.terminalPhase === 'completed' && !!terminal.resultRef &&
      value.sources.some(ref => ref.artifactRef === terminal.resultRef) &&
      this.verifyExecution?.(terminal, value) === true;
    const status = acceptedUser || acceptedFact ? 'accepted' : 'candidate';
    const id = `pm_${hash([terminal.projectId, terminal.taskId, terminal.nativeTurnId, terminal.terminalEventId, value.stableKey].join('\0')).slice(0, 40)}`;
    // An existing ID includes user edits and withdrawal tombstones. New extraction versions may not overwrite it.
    if (this.row(terminal.projectId, id)) return;
    const now = this.clock();
    this.db.prepare('INSERT INTO project_memory_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, terminal.projectId, value.kind, value.text, status, 1, JSON.stringify(value.sources),
      value.branchRef ?? null, value.condition ?? null, null, now, now,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.draining) await this.draining;
    if (this.selected) await this.selected.catch(() => undefined);
    if (this.db.open) this.db.close();
  }
}
