import type { IncomingMessage } from 'node:http';
import { ManagementError } from '../contracts/management.js';
import type { ProjectMemoryChange, ProjectMemoryItem, ProjectMemoryPort } from '../contracts/project-memory.js';
import type { ProjectIndexPort } from '../contracts/projects.js';

const invalid = (): never => { throw new ManagementError('invalid_request', '项目记忆请求字段无效。'); };
const string = (value: unknown, max: number): string =>
  typeof value === 'string' && value.trim().length > 0 && [...value].length <= max && !value.includes('\0') ? value : invalid();
const integer = (value: unknown, fallback: number, max: number): number => {
  const number = value === null || value === undefined ? fallback : Number(value);
  return Number.isSafeInteger(number) && number >= 1 && number <= max ? number : invalid();
};
const object = (value: unknown, allowed: readonly string[]): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key))
    ? value as Record<string, unknown> : invalid();

/** Called only after the management server has checked its local bearer token and Origin. */
export async function projectMemoryRoute(req: IncomingMessage, url: URL, projects: ProjectIndexPort | undefined,
  memory: ProjectMemoryPort | undefined, processingAvailable: boolean,
  body: () => Promise<Record<string, unknown>>, respond: (value: unknown) => void): Promise<boolean> {
  if (!url.pathname.startsWith('/api/project-memory/')) return false;
  if (!projects || !memory) throw new ManagementError('unavailable', '项目记忆暂时不可用。');
  const readProject = async (projectId: string) => {
    if (!await projects.get(projectId)) throw new ManagementError('not_found', '没有这个项目。');
    return projectId;
  };
  if (req.method === 'GET') {
    const projectId = await readProject(string(url.searchParams.get('projectId'), 250));
    if (url.pathname === '/api/project-memory/items') {
      const items = await memory.list({ projectId, limit: integer(url.searchParams.get('limit'), 50, 100),
        ...(url.searchParams.has('text') ? { text: string(url.searchParams.get('text'), 500) } : {}),
        ...(url.searchParams.has('branchRef') ? { branchRef: string(url.searchParams.get('branchRef'), 250) } : {}) });
      respond({ items, processingAvailable }); return true;
    }
    if (url.pathname === '/api/project-memory/item') {
      const item = await memory.get(projectId, string(url.searchParams.get('id'), 250));
      if (!item) throw new ManagementError('not_found', '没有这个项目记忆条目。');
      respond(item); return true;
    }
    if (url.pathname === '/api/project-memory/jobs') {
      respond({ jobs: await memory.listJobs(projectId, integer(url.searchParams.get('limit'), 50, 100)), processingAvailable }); return true;
    }
    if (url.pathname === '/api/project-memory/job') {
      const job = await memory.getJob(projectId, string(url.searchParams.get('id'), 250));
      if (!job) throw new ManagementError('not_found', '没有这个项目记忆处理任务。');
      respond(job); return true;
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/project-memory/change') {
    const raw = object(await body(), ['projectId', 'operationId', 'recordedAt', 'type', 'kind', 'text', 'status', 'branchRef', 'condition', 'id', 'expectedVersion']);
    const projectId = await readProject(string(raw.projectId, 250));
    const operationId = string(raw.operationId, 250);
    const source = { userInputId: `management:${operationId}`, recordedAt: string(raw.recordedAt, 40) };
    let input: ProjectMemoryChange;
    if (raw.type === 'create') {
      if (!['decision', 'constraint', 'fact', 'open_question'].includes(String(raw.kind)) ||
          !['candidate', 'accepted'].includes(String(raw.status))) return invalid();
      input = { type: 'create', operationId, projectId, kind: raw.kind as ProjectMemoryItem['kind'],
        text: string(raw.text, 4000), status: raw.status as 'candidate' | 'accepted', sources: [source],
        ...(raw.branchRef === undefined ? {} : { branchRef: string(raw.branchRef, 250) }),
        ...(raw.condition === undefined ? {} : { condition: string(raw.condition, 500) }) };
    } else if (raw.type === 'edit') {
      const expectedVersion = integer(raw.expectedVersion, 0, Number.MAX_SAFE_INTEGER);
      if (raw.kind !== undefined &&
          !['decision', 'constraint', 'fact', 'open_question'].includes(String(raw.kind))) return invalid();
      input = { type: 'edit', operationId, projectId, id: string(raw.id, 250), expectedVersion,
        text: string(raw.text, 4000),
        ...(raw.kind === undefined ? {} : { kind: raw.kind as ProjectMemoryItem['kind'] }),
        ...(raw.branchRef === undefined ? {} : { branchRef: raw.branchRef === null ? null : string(raw.branchRef, 250) }),
        ...(raw.condition === undefined ? {} : { condition: raw.condition === null ? null : string(raw.condition, 500) }),
        source };
    } else if (raw.type === 'accept' || raw.type === 'withdraw') {
      input = { type: raw.type, operationId, projectId, id: string(raw.id, 250),
        expectedVersion: integer(raw.expectedVersion, 0, Number.MAX_SAFE_INTEGER), source };
    } else return invalid();
    respond(await memory.change(input)); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/project-memory/jobs/retry') {
    if (!processingAvailable) throw new ManagementError('unavailable', '项目记忆后台整理尚未启用。');
    const raw = object(await body(), ['projectId', 'jobId']);
    const projectId = await readProject(string(raw.projectId, 250));
    respond(await memory.retryJob(projectId, string(raw.jobId, 250))); return true;
  }
  throw new ManagementError('not_found', '没有这个项目记忆操作。');
}
