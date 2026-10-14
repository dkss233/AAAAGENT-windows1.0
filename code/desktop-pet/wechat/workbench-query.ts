import type { WorkbenchChannelReadPort, WorkbenchTaskPhase, WorkbenchTaskRef } from '../contracts/workbench.js';
import type { WeChatStore } from './store.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const selectPattern = new RegExp(`^(?:选择|查询|查看)任务(?:编号)?[：:\\s]*(${UUID})$`, 'i');
const phaseLabels: Record<WorkbenchTaskPhase, string> = {
  recorded: '已记录', accepted: '已接收', running: '进行中',
  waiting_approval: '等待原生工具批准', waiting_answer: '等待原生问题回答',
  completed: '已完成', failed: '失败', cancelled: '已取消', unknown: '状态待核',
};

type Focus = { readonly task: WorkbenchTaskRef };
type T3Task = Extract<WorkbenchTaskRef, { readonly origin: 't3' }>;
export interface WorkbenchQueryOptions {
  readonly read: WorkbenchChannelReadPort | undefined;
  readonly store: Pick<WeChatStore, 'get' | 'set'>;
  readonly channelKey: string;
}
export type WorkbenchQueryResult = { readonly handled: true; readonly text: string | undefined; readonly current: () => boolean } | { readonly handled: false };

/** Explicit UUID readback supplies the project and native binding; channel focus is local only. */
export class WorkbenchQuery {
  private generation = 0;
  constructor(private readonly options: WorkbenchQueryOptions) {}

  focusTask(): T3Task | undefined {
    try { const task=this.options.store.get<Focus>('workbench-focus:' + this.options.channelKey)?.task;
      return task?.origin==='t3'?task:undefined; }
    catch { return undefined; }
  }

  selectTask(task: T3Task): void {
    this.options.store.set('workbench-focus:' + this.options.channelKey, {task} satisfies Focus);
  }

  async handle(rawText: string, signal: AbortSignal, defaultQuery?: 'latest' | 'all'): Promise<WorkbenchQueryResult> {
    const text = rawText.normalize('NFKC').trim().replace(/[。？！?!\s]+$/g, '');
    const selected = selectPattern.exec(text)?.[1]?.toLowerCase();
    const mode = defaultQuery ?? (text === '查询任务' ? 'latest' : undefined);
    if (!selected && !mode) { ++this.generation; return { handled: false }; }
    // Explicit all belongs to the bound WeChat receipt history, even with an external T3 focus.
    if (mode === 'all') { ++this.generation; return { handled: false }; }
    const generation = ++this.generation;
    const current = () => !signal.aborted && generation === this.generation;
    const pending = '任务项目或状态待核，请在工作台核对；本次没有新建或转发任务。';
    const answer = (text?: string): WorkbenchQueryResult => ({ handled: true, text, current });
    let focus: Focus | undefined;
    try { focus = selected ? undefined : this.options.store.get<Focus>('workbench-focus:' + this.options.channelKey); }
    catch { return answer(pending); }
    if (!selected && !focus) return { handled: false }; // Existing same-channel forward receipt query.
    if (!this.options.read) return answer(pending);
    try {
      signal.throwIfAborted();
      const taskId = selected ?? focus!.task.id;
      if (!new RegExp('^' + UUID + '$', 'i').test(taskId)) return answer(pending);
      const refreshed = await this.options.read.refreshTask(taskId);
      if (!current()) return answer();
      if (!refreshed?.projection || refreshed.projection.taskId !== taskId || !refreshed.task.projectId ||
          refreshed.task.id !== taskId || refreshed.task.origin !== 't3' ||
          focus && !sameTask(focus.task, refreshed.task))
        return answer(pending);
      if (!Object.hasOwn(phaseLabels, refreshed.projection.phase)) return answer(pending);
      if (selected) this.options.store.set('workbench-focus:' + this.options.channelKey, { task: refreshed.task } satisfies Focus);
      const phase = refreshed.projection.phase;
      return answer('任务 ' + taskId + '：' + phaseLabels[phase] + (refreshed.projection.resultRef ? '，结果已可在工作台查看。' : '。'));
    } catch (error) {
      if (signal.aborted) throw error;
      return answer(current() ? pending : undefined);
    }
  }
}

export function sameTask(a: WorkbenchTaskRef, b: WorkbenchTaskRef): boolean {
  if (a.id !== b.id || a.projectId !== b.projectId || a.provider !== b.provider || a.origin !== b.origin) return false;
  if (a.origin === 't3' && b.origin === 't3') return a.environmentId === b.environmentId && a.t3ProjectId === b.t3ProjectId && a.threadId === b.threadId && a.providerInstanceId === b.providerInstanceId && a.nativeSessionId === b.nativeSessionId;
  if (a.origin === 'legacy_codex_app' && b.origin === 'legacy_codex_app') return a.hostId === b.hostId && a.nativeSessionId === b.nativeSessionId;
  if (a.origin === 'legacy_dsh' && b.origin === 'legacy_dsh') return a.profileId === b.profileId && a.nativeSessionId === b.nativeSessionId;
  return false;
}
