import type { IncomingMessage } from 'node:http';
import { ManagementError } from '../contracts/management.js';
import type { ForwardingPort, ForwardPrepare, ForwardRequest } from '../contracts/harness.js';

export interface TaskManagement extends ForwardingPort { sendConfirmed(id: string): Promise<ForwardRequest>; toolStatus(id: string): Promise<ForwardRequest>;
  /** Start the Harness host on the operator's explicit request. Absent when no engine profile exists. */
  startHarness?(): Promise<boolean> }
const invalid = (): never => { throw new ManagementError('invalid_request', '任务字段无效，请重新核对。'); };
const text = (value: unknown, max: number): string => typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : invalid();
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const version = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid();
export async function taskRoute(req: IncomingMessage, url: URL, tasks: TaskManagement | undefined,
  body: () => Promise<Record<string, unknown>>, respond: (value: unknown) => void): Promise<boolean> {
  if (url.pathname !== '/api/tasks' && !url.pathname.startsWith('/api/tasks/') && !url.pathname.startsWith('/api/harness-tools/')) return false;
  if (!tasks) throw new ManagementError('unavailable', '任务连接暂时不可用，陪伴聊天仍可继续。');
  if (req.method === 'GET' && url.pathname === '/api/tasks') { respond(await tasks.snapshot()); return true; }
  if (req.method === 'GET' && url.pathname === '/api/tasks/targets') { respond(await tasks.targets(text(url.searchParams.get('query') ?? '', 200))); return true; }
  if (req.method !== 'POST') throw new ManagementError('not_found', '没有这个任务操作。');
  const b = await body();
  // Explicit start, so the operator can warm the host without sending work. ID-free, so it is
  // handled before the shared `id` read below.
  if (url.pathname === '/api/tasks/harness/start') {
    if (!tasks.startHarness) throw new ManagementError('unavailable', '当前配置没有可启动的 Harness 引擎。');
    const ready = await tasks.startHarness();
    if (!ready) throw new ManagementError('unavailable', 'Harness 主机未能在规定时间内就绪，请稍后重试。');
    respond(await tasks.snapshot()); return true;
  }
  if (url.pathname === '/api/tasks/prepare') {
    // The executor decides the shape: a Harness task has no native target, and a Codex task must have
    // one. Forcing a target here made every Harness prepare fail validation as "任务字段无效".
    const executor = b.executor === 'harness' ? 'harness' : 'codex';
    // A Harness task has no native target at all, so it must not even parse one.
    const target = executor === 'codex' ? object(b.target) : undefined;
    const input: ForwardPrepare = { text: text(b.text, 20000), executor,
      ...(target ? { target: { threadId: text(target.threadId, 200), hostId: text(target.hostId, 200) } } : {}),
      ...(b.projectId === undefined ? {} : { projectId: text(b.projectId, 200), projectVersion: version(b.projectVersion) }) };
    if (b.projectId === undefined && b.projectVersion !== undefined) return invalid();
    respond(await tasks.prepare(input)); return true;
  }
  const id = text(b.id, 200);
  if (url.pathname === '/api/tasks/confirm') { respond(await tasks.confirm(id, version(b.expectedVersion))); return true; }
  if (url.pathname === '/api/tasks/refresh') { respond(await tasks.refresh(id)); return true; }
  if (url.pathname === '/api/harness-tools/send-confirmed') { respond(await tasks.sendConfirmed(id)); return true; }
  if (url.pathname === '/api/harness-tools/status') { respond(await tasks.toolStatus(id)); return true; }
  throw new ManagementError('not_found', '没有这个任务操作。');
}
