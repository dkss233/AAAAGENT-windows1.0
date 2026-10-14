import type { IncomingMessage } from 'node:http';
import { ManagementError } from '../contracts/management.js';
import type { WorkbenchService } from './workbench-service.js';

const invalid = (): never => { throw new ManagementError('invalid_request', '工作台请求字段无效。'); };
const text = (value: unknown, max = 250): string => typeof value === 'string' && value.trim() &&
  value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : invalid();
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
};
const query = (url: URL, key: string): string => text(url.searchParams.get(key));
const version = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : invalid();
const message = (value: unknown): string => typeof value === 'string' && value.trim() &&
  value.length <= 120000 && !value.includes('\0') ? value : invalid();

/** All routes run behind the management server's Bearer and same-origin checks. */
export async function workbenchRoute(req: IncomingMessage, url: URL, service: WorkbenchService | undefined,
  body: () => Promise<Record<string, unknown>>, respond: (value: unknown, setCookie?: string) => void): Promise<boolean> {
  if (!url.pathname.startsWith('/api/workbench/')) return false;
  if (req.method === 'GET' && url.pathname === '/api/workbench/status') {
    respond(await service?.status() ?? { version: '0.1.1', readAvailable: false, dispatchEnabled: false,
      sourceOpening: 'unavailable', preciseTurnJump: false }); return true;
  }
  if (!service) throw new ManagementError('unavailable', '工作台尚未连接本机原生服务。');
  if (req.method === 'POST' && ['/api/workbench/native-open', '/api/workbench/native-open/desktop'].includes(url.pathname)) {
    const b = object(await body(), ['target', 'projectId', 'taskId', 'expectedFocusRevision']);
    if (b.target !== 'home' && b.target !== 'project' && b.target !== 'task') return invalid();
    respond(await service.openNativeBrowser({ target: b.target,
      ...(b.projectId === undefined ? {} : { projectId: text(b.projectId) }),
      ...(b.taskId === undefined ? {} : { taskId: text(b.taskId) }),
      ...(b.expectedFocusRevision === undefined ? {} : { expectedFocusRevision: version(b.expectedFocusRevision) }) },
      url.pathname.endsWith('/desktop') ? 'desktop' : 'web', req.headers.cookie)); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/focus') {
    const result = await service.readWebFocus(query(url, 'projectId'), req.headers.cookie);
    respond(result.focus, result.setCookie); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/continuation') {
    respond(await service.readWebContinuation(query(url, 'draftId'), req.headers.cookie)); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/continuation/draft') {
    respond(service.readWebContinuationDraft(query(url, 'draftId'), req.headers.cookie)); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/continuations') {
    respond(await service.listWebContinuationDrafts(query(url, 'projectId'), req.headers.cookie)); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/provider-models') {
    const provider = url.searchParams.get('provider') ?? 'codex';
    if (provider !== 'codex' && provider !== 'dsh') return invalid();
    respond(await service.modelCatalog(provider)); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/project-bindings') {
    respond(await service.listProjectBindings(query(url, 'projectId'))); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/tasks') {
    respond(await service.listTasks(query(url, 'projectId'))); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/interactions') {
    respond(await service.listNativeInteractions(query(url, 'projectId'), query(url, 'taskId'))); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/interactions/bindings') {
    respond(await service.listNativeInteractionBindings(query(url, 'projectId'), query(url, 'taskId'))); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/interactions/commands') {
    if (url.searchParams.has('interactionId')) {
      if (url.searchParams.has('commandId')) return invalid();
      respond(await service.readNativeInteractionCommandForTask(query(url, 'projectId'),
        query(url, 'taskId'), query(url, 'interactionId'))); return true;
    }
    if (url.searchParams.has('projectId') || url.searchParams.has('taskId')) return invalid();
    respond(await service.readNativeInteractionCommand(query(url, 'commandId'))); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/tasks/creations') {
    respond(await service.unfinishedNativeCreations(query(url, 'projectId'))); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/source') {
    const ids = Object.fromEntries(['nativeTurnId', 'nativeEventId', 'artifactRef']
      .flatMap(key => url.searchParams.has(key) ? [[key, text(url.searchParams.get(key), 1000)]] : []));
    respond(service.sourceTarget(query(url, 'projectId'), query(url, 'taskId'), ids)); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/workbench/task-detail') {
    respond(await service.detail(query(url, 'projectId'), query(url, 'taskId'))); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/project-bindings') {
    const b = object(await body(), ['projectId', 't3ProjectId', 'workspaceRoot']);
    respond(await service.bindProject(text(b.projectId), text(b.t3ProjectId), text(b.workspaceRoot, 4096))); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/tasks') {
    const b = object(await body(), ['projectId', 't3ProjectId', 'threadId', 'provider']);
    const provider = text(b.provider);
    if (provider !== 'codex' && provider !== 'dsh') return invalid();
    respond(await service.bindTask(text(b.projectId), text(b.t3ProjectId), text(b.threadId), provider)); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/tasks/create') {
    const b = object(await body(), ['operationId', 'projectId', 'title', 'provider', 'modelSelection']);
    const selection = object(b.modelSelection, ['instanceId', 'model', 'reasoningEffort']);
    if (b.provider !== 'codex' && b.provider !== 'dsh') return invalid();
    respond(await service.createNativeTask({ operationId: text(b.operationId), projectId: text(b.projectId),
      title: text(b.title), provider: b.provider, modelSelection: { instanceId: text(selection.instanceId),
        model: text(selection.model), ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: text(selection.reasoningEffort) }) } })); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/tasks/refresh') {
    const b = object(await body(), ['taskId']); respond(await service.refreshTask(text(b.taskId))); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/interactions/respond') {
    const b = object(await body(), ['projectId', 'taskId', 'interactionId', 'expectedVersion', 'response']);
    const response = object(b.response, ['type', 'choiceId', 'answers']);
    if (response.type === 'decide_approval') {
      if (Object.hasOwn(response, 'answers')) return invalid();
      respond(await service.respondNativeInteraction(text(b.projectId), text(b.taskId),
        text(b.interactionId), version(b.expectedVersion),
        { type: 'decide_approval', choiceId: text(response.choiceId, 50) })); return true;
    }
    if (response.type !== 'answer_question' || Object.hasOwn(response, 'choiceId') ||
        !Array.isArray(response.answers) || response.answers.length > 20) return invalid();
    const answers = response.answers.map(item => {
      const answer = object(item, ['questionId', 'selectedOptionIds', 'customText']);
      if (!Array.isArray(answer.selectedOptionIds) || answer.selectedOptionIds.length > 30) return invalid();
      return { questionId: text(answer.questionId), selectedOptionIds: answer.selectedOptionIds.map(value => text(value, 1000)),
        ...(answer.customText === undefined ? {} : { customText: message(answer.customText) }) };
    });
    respond(await service.respondNativeInteraction(text(b.projectId), text(b.taskId),
      text(b.interactionId), version(b.expectedVersion), { type: 'answer_question', answers })); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/focus') {
    const b = object(await body(), ['projectId', 'taskId', 'expectedRevision']);
    if (!Number.isSafeInteger(b.expectedRevision) || Number(b.expectedRevision) < 0 ||
        b.taskId !== null && typeof b.taskId !== 'string') return invalid();
    respond(await service.saveWebFocus(text(b.projectId), req.headers.cookie,
      b.taskId === null ? null : text(b.taskId), Number(b.expectedRevision))); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/continuation/prepare') {
    const b = object(await body(), ['projectId', 'taskId', 'expectedFocusRevision', 'messageId', 'rawText', 'dispatchText']);
    respond(await service.prepareWebContinuation(text(b.projectId), text(b.taskId), version(b.expectedFocusRevision),
      req.headers.cookie, text(b.messageId), message(b.rawText), message(b.dispatchText))); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/continuation/revise') {
    const b = object(await body(), ['draftId', 'expectedVersion', 'dispatchText']);
    respond(service.reviseWebContinuation(text(b.draftId), version(b.expectedVersion), req.headers.cookie,
      message(b.dispatchText))); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/continuation/dismiss') {
    const b = object(await body(), ['draftId', 'expectedVersion']);
    respond(service.dismissWebContinuation(text(b.draftId), version(b.expectedVersion), req.headers.cookie)); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/continuation/confirm') {
    const b = object(await body(), ['draftId', 'expectedVersion']);
    respond(await service.confirmWebContinuation(text(b.draftId), version(b.expectedVersion), req.headers.cookie)); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/workbench/commands/continue') {
    const b = object(await body(), ['commandId', 'taskId', 'input']);
    // This old direct route cannot prove reviewed draft/version consent. Keep it inert until the web UI uses that flow.
    respond({ commandId: text(b.commandId), state: 'unsupported',
      detail: '网页续接须先绑定已核实任务与确认草稿。' }); return true;
  }
  throw new ManagementError('not_found', '没有这个工作台操作。');
}
