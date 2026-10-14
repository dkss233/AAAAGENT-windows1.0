import { isPrivateFileSync, restrictPrivatePathSync } from '../core/platform-files.js';
import { isAbsolute as isAbsolutePath } from 'node:path';
import type { ProjectIndexPort } from '../contracts/projects.js';
import { existsSync, lstatSync, readFileSync, realpathSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { TurnScope } from '../contracts/index.js';
import type { PendingWorkContext, WorkContinuationIntent } from '../contracts/desktop-work.js';
import type { WorkStatusNotice } from '../core/work-speech.js';
import type { WorkbenchDesktopAction, WorkbenchDesktopFocus, WorkbenchDesktopNativeState,
  WorkbenchDesktopState, WorkbenchInput, WorkbenchInteractionResponse,
  WorkbenchTaskRef, WorkbenchVoiceBinding, DesktopCoordinatorProfile, DesktopIndependentGroupProfile,
  DesktopIndependentGroupState } from '../contracts/workbench.js';
import { ManagementError } from '../contracts/management.js';
import { DESKTOP_WORKBENCH_SESSION, WorkbenchService } from './workbench-service.js';

const identifier = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 250 ||
      /[\u0000-\u001f\u007f]/u.test(value)) throw new ManagementError('invalid_request', '工作台标识无效。');
  return value;
};
const revision = (value: unknown, zero = false): number => {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1)) {
    throw new ManagementError('invalid_request', '工作台版本无效。');
  }
  return Number(value);
};
const body = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 120000 || value.includes('\0')) {
    throw new ManagementError('invalid_request', '请填写有效的任务正文。');
  }
  return value;
};
const fields = (value: unknown, allowed: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ManagementError('invalid_request', '工作台操作格式无效。');
  }
  return value as Record<string, unknown>;
};
const nativeResponse = (value: unknown): WorkbenchInteractionResponse => {
  const response = fields(value, ['type', 'choiceId', 'answers']);
  if (response.type === 'decide_approval') {
    if (Object.hasOwn(response, 'answers')) throw new ManagementError('invalid_request', '审批选项格式无效。');
    return { type: 'decide_approval', choiceId: identifier(response.choiceId) };
  }
  if (response.type !== 'answer_question' || Object.hasOwn(response, 'choiceId') ||
      !Array.isArray(response.answers) || response.answers.length > 20) {
    throw new ManagementError('invalid_request', '提问回答格式无效。');
  }
  return { type: 'answer_question', answers: response.answers.map(value => {
    const answer = fields(value, ['questionId', 'selectedOptionIds', 'customText']);
    if (!Array.isArray(answer.selectedOptionIds) || answer.selectedOptionIds.length > 30) {
      throw new ManagementError('invalid_request', '提问选项格式无效。');
    }
    return { questionId: identifier(answer.questionId),
      selectedOptionIds: answer.selectedOptionIds.map(identifier),
      ...(answer.customText === undefined ? {} : { customText: body(answer.customText) }) };
  }) };
};
const taskIdentity = (value: WorkbenchTaskRef | null): string | null => value && value.origin === 't3' ?
  JSON.stringify([value.id, value.projectId, value.provider, value.environmentId,
    value.t3ProjectId, value.threadId, value.providerInstanceId]) : null;
const exactNativeConfirm = (text: string) => /^(?:确认|确认发送|确认执行|按这个执行|可以开始)[。.!！]?$/u.test(text.trim());

function independentGroupProfile(value: unknown): DesktopIndependentGroupProfile {
  const g = fields(value, ['operationId', 'coordinatorBranch', 'members', 'coordinatorExecution', 'dispatchAuthorization']);
  if (typeof g.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(g.operationId) ||
      !Array.isArray(g.members) || g.members.length !== 2) throw new ManagementError('invalid_request', '独立组配置无效。');
  const members = g.members.map(value => {
    const m = fields(value, ['actorId', 'taskId', 'title', 'workspaceRoot', 'branch', 'model', 'reasoningEffort', 'writablePaths']);
    if (!['A', 'B'].includes(String(m.actorId)) || typeof m.workspaceRoot !== 'string' || !isAbsolutePath(m.workspaceRoot) ||
        m.workspaceRoot.length > 4096 || /[\0\r\n]/u.test(m.workspaceRoot) || !Array.isArray(m.writablePaths) || !m.writablePaths.length ||
        m.writablePaths.length > 20 || m.writablePaths.some(p => typeof p !== 'string' || isAbsolutePath(p) || /[\0\r\n\\]/u.test(p) ||
          p.split('/').some((s: string) => !s || s === '.' || s === '..'))) throw new ManagementError('invalid_request', '独立成员写域无效。');
    return { actorId: m.actorId as 'A' | 'B', taskId: identifier(m.taskId), title: identifier(m.title),
      workspaceRoot: m.workspaceRoot, branch: identifier(m.branch), model: identifier(m.model),
      reasoningEffort: identifier(m.reasoningEffort), writablePaths: m.writablePaths as string[] };
  });
  if (new Set(members.map(m => m.actorId)).size !== 2 || new Set(members.map(m => m.taskId)).size !== 2) {
    throw new ManagementError('invalid_request', '独立成员不能重复。');
  }
  const rawExecution = g.coordinatorExecution === null ? null : fields(g.coordinatorExecution, ['model', 'reasoningEffort', 'runtimeMode']);
  if (rawExecution && !['approval-required', 'auto-accept-edits'].includes(String(rawExecution.runtimeMode))) {
    throw new ManagementError('invalid_request', '协调权限须由宿主明确配置。');
  }
  const execution = rawExecution ? { model: identifier(rawExecution.model), reasoningEffort: identifier(rawExecution.reasoningEffort),
    runtimeMode: rawExecution.runtimeMode as 'approval-required' | 'auto-accept-edits' } : null;
  const rawGrant = g.dispatchAuthorization === null ? null : fields(g.dispatchAuthorization,
    ['authorizationId', 'maxDispatches', 'expiresAt', 'validityFromFirstConfirmationMs']);
  if (rawGrant && (revision(rawGrant.maxDispatches) > 100 ||
      (rawGrant.expiresAt !== undefined ? rawGrant.validityFromFirstConfirmationMs !== undefined ||
        typeof rawGrant.expiresAt !== 'string' || !Number.isFinite(Date.parse(rawGrant.expiresAt)) :
        !Number.isSafeInteger(rawGrant.validityFromFirstConfirmationMs) || Number(rawGrant.validityFromFirstConfirmationMs) <= 0))) {
    throw new ManagementError('invalid_request', '独立授权须有准确额度与一种明确起算方式。');
  }
  return { operationId: g.operationId, coordinatorBranch: g.coordinatorBranch === null ? null : identifier(g.coordinatorBranch), members,
    coordinatorExecution: execution, dispatchAuthorization: rawGrant ? { authorizationId: identifier(rawGrant.authorizationId),
      maxDispatches: Number(rawGrant.maxDispatches),
      ...(rawGrant.expiresAt === undefined ? { validityFromFirstConfirmationMs: Number(rawGrant.validityFromFirstConfirmationMs) } :
        { expiresAt: rawGrant.expiresAt as string }) } : null };
}

/** Host configuration stays optional; absence never supplies a guessed project/model. */
export function readDesktopCoordinatorProfile(root: string, projectId: string | null): DesktopCoordinatorProfile | undefined {
  const file = resolve(root, '.local/data/desktop-coordinator-profiles.json');
  let stat;
  try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (!isPrivateFileSync(file) || stat.size > 256000) {
    throw new ManagementError('invalid_request', '协调创建配置的本机归属或文件权限无效。');
  }
  const cfg = fields(JSON.parse(readFileSync(file, 'utf8')), ['version', 'activeProjectId', 'profiles']);
  if (cfg.version !== '0.1.0' || !Array.isArray(cfg.profiles) || cfg.profiles.length > 100) {
    throw new ManagementError('invalid_request', '协调创建配置格式无效。');
  }
  const selected = projectId ?? (cfg.activeProjectId === null ? null : identifier(cfg.activeProjectId));
  const matches = cfg.profiles.map(value => fields(value, ['projectId', 'workspaceRoot', 'operationId', 'title', 'modelSelection', 'existingTaskId', 'independentGroup', 'confirmedFirstTurn']))
    .filter(value => value.projectId === selected);
  if (!matches.length) return;
  if (matches.length !== 1) throw new ManagementError('version_conflict', '协调创建项目有多个配置。');
  const p = matches[0]!, model = fields(p.modelSelection, ['instanceId', 'model', 'reasoningEffort']);
  if (model.instanceId !== 'codex' || typeof p.operationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(p.operationId) ||
      typeof p.workspaceRoot !== 'string' || !isAbsolutePath(p.workspaceRoot) ||
      p.workspaceRoot.length > 4096 || p.workspaceRoot.includes('\0')) throw new ManagementError('invalid_request', '协调创建目标无效。');
  const first = p.confirmedFirstTurn === undefined ? undefined : fields(p.confirmedFirstTurn,
    ['authorizationId', 'authType', 'maxTurns', 'automaticRetries']);
  if (first && (first.authType !== 'chatgpt' || first.maxTurns !== 1 || first.automaticRetries !== 0)) {
    throw new ManagementError('invalid_request', '首个协调确认只能使用明确的原Codex单次授权。');
  }
  return { projectId: identifier(p.projectId), workspaceRoot: p.workspaceRoot, operationId: identifier(p.operationId),
    title: identifier(p.title), modelSelection: { instanceId: 'codex', model: identifier(model.model), reasoningEffort: identifier(model.reasoningEffort) },
    ...(p.existingTaskId === undefined ? {} : { existingTaskId: identifier(p.existingTaskId) }),
    ...(first ? { confirmedFirstTurn: { authorizationId: identifier(first.authorizationId),
      authType: 'chatgpt', maxTurns: 1, automaticRetries: 0 } as const } : {}),
    ...(p.independentGroup === undefined ? {} : { independentGroup: independentGroupProfile(p.independentGroup) }) };
}

/** Renderer input is parsed at the backend boundary; no channel identity or command ID is renderer-controlled. */
export function parseWorkbenchDesktopAction(value: unknown): WorkbenchDesktopAction {
  const action = fields(value, ['type', 'projectId', 'taskId', 'expectedRevision',
    'expectedFocusRevision', 'messageId', 'rawText', 'dispatchText', 'draftId', 'expectedVersion',
    'projectQuery', 'interactionId', 'response']);
  switch (action.type) {
    case 'select':
      return { type: 'select', projectId: action.projectId === null ? null : identifier(action.projectId),
        taskId: action.taskId === null ? null : identifier(action.taskId),
        expectedRevision: revision(action.expectedRevision, true) };
    case 'prepare':
      return { type: 'prepare', projectId: identifier(action.projectId), taskId: identifier(action.taskId),
        expectedFocusRevision: revision(action.expectedFocusRevision, true), messageId: identifier(action.messageId),
        rawText: body(action.rawText), dispatchText: body(action.dispatchText) };
    case 'revise':
      return { type: 'revise', draftId: identifier(action.draftId),
        expectedVersion: revision(action.expectedVersion), dispatchText: body(action.dispatchText) };
    case 'dismiss': case 'confirm':
      return { type: action.type, draftId: identifier(action.draftId),
        expectedVersion: revision(action.expectedVersion) };
    case 'select_draft':
      return { type: 'select_draft', draftId: identifier(action.draftId) };
    case 'respond_interaction':
      return { type: 'respond_interaction', projectId: identifier(action.projectId),
        taskId: identifier(action.taskId), expectedFocusRevision: revision(action.expectedFocusRevision, true),
        interactionId: identifier(action.interactionId), expectedVersion: revision(action.expectedVersion, true),
        response: nativeResponse(action.response) };
    case 'read_interaction':
      return { type: 'read_interaction', projectId: identifier(action.projectId),
        taskId: identifier(action.taskId), expectedFocusRevision: revision(action.expectedFocusRevision, true),
        interactionId: identifier(action.interactionId) };
    case 'refresh':
      if (action.projectQuery !== undefined && (typeof action.projectQuery !== 'string' ||
          action.projectQuery.length > 250 || /[\u0000-\u001f\u007f]/u.test(action.projectQuery))) {
        throw new ManagementError('invalid_request', '项目搜索内容无效。');
      }
      return { type: 'refresh', ...(action.projectQuery === undefined ? {} : { projectQuery: action.projectQuery as string }) };
    default:
      throw new ManagementError('invalid_request', '未知工作台操作。');
  }
}

const emptyFocus: WorkbenchDesktopFocus = { version: '0.1.0', revision: 0, projectId: null, task: null };

/** A project-local discovery record contains references, never the private actor credential. */
export function writeDesktopIndependentGroupStatus(profile: DesktopCoordinatorProfile, coordinatorId: string,
  state: DesktopIndependentGroupState): string {
  const group = profile.independentGroup;
  if (!group || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(group.operationId) || state.operationId !== group.operationId ||
      realpathSync(profile.workspaceRoot) !== profile.workspaceRoot) {
    throw new ManagementError('version_conflict', '独立组结果目录与原项目不同。');
  }
  let folder = profile.workspaceRoot;
  for (const part of ['artifacts', 'integration', 'desktop-native-group']) {
    folder = resolve(folder, part);
    if (!existsSync(folder)) mkdirSync(folder, { mode: 0o700 });
    if (realpathSync(folder) !== folder || !lstatSync(folder).isDirectory()) {
      throw new ManagementError('version_conflict', '独立组结果目录须为原项目实际目录。');
    }
  }
  const file = resolve(folder, group.operationId + '.json');
  const identity = { coordinatorTaskId: coordinatorId, members: group.members };
  const value = { version: '0.1.0', projectId: profile.projectId,
    workspaceRoot: profile.workspaceRoot, identity, ...state,
    instruction: state.stage === 'registered' ?
      'C使用coordinatorClientPath的原client，通过--context coordinatorContextFile snapshot读取实际板，再按准确revision及operationId操作。不要打印或复制私有context内容；派发unknown仅查询原回执。A/B沿实际派发正文读取各自context；分配与汇报保留原对话Flow。' :
      '三个准确任务的元数据已核对；尚未完成实际板登记，不推测SID、私有context或派发许可。C的后续模型/权限和准确授权齐备后自动复核。' };
  const bytes = JSON.stringify(value, null, 2) + '\n';
  if (existsSync(file)) {
    const stat = lstatSync(file);
    if (!isPrivateFileSync(file) || stat.size > 256000) {
      throw new ManagementError('version_conflict', '独立组结果文件归属待核。');
    }
    const previous = readFileSync(file, 'utf8'), old = JSON.parse(previous);
    if (old.version !== '0.1.0' || old.operationId !== group.operationId ||
        old.projectId !== profile.projectId || old.workspaceRoot !== profile.workspaceRoot ||
        JSON.stringify(old.identity) !== JSON.stringify(identity)) throw new ManagementError('version_conflict', '独立组结果已有不同成员。');
    if (previous === bytes) return file;
  }
  const temporary = resolve(folder, '.group-write-' + randomUUID());
  try { writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); restrictPrivatePathSync(temporary); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return file;
}

/** Thin native-shell presentation bridge; T3 and workbench.sqlite remain the task/draft authorities. */
export class DesktopWorkbench {
  private sequence = 0;
  private selectedDraftId: string | null = null;
  private projectQuery = '';
  private lastCommand: WorkbenchDesktopState['command'];
  private selectedInteractionId: string | null = null;
  private selectedInteractionTask: string | null = null;
  private nativeError: string | undefined;
  private error: string | undefined;
  private actions: Promise<void> = Promise.resolve();
  private group: DesktopIndependentGroupState | undefined;
  private groupFocus: { revision: number; projectId: string | null; taskId: string | null } | undefined;
  private groupError: string | undefined;
  private groupTimer: NodeJS.Timeout | undefined;
  private groupRefreshRunning = false;
  private closed = false;
  private capturedInput?: { scope: TurnScope; selected: { revision: number; projectId: string | null; taskId: string | null };
    binding?: WorkbenchVoiceBinding };
  constructor(private readonly projects: ProjectIndexPort, private readonly service: WorkbenchService,
    private readonly emit: (state: WorkbenchDesktopState) => void,
    private readonly notify?: (notice: WorkStatusNotice) => void,
    private readonly creationProfile?: (projectId: string | null) => DesktopCoordinatorProfile | undefined) {}

  async start(): Promise<void> {
    await this.publish();
    if (this.creationProfile) {
      this.groupTimer = setInterval(() => { void this.refreshIndependentGroup().catch(() => {}); }, 2000);
      this.groupTimer.unref();
    }
  }
  async close() { this.closed = true; clearInterval(this.groupTimer); await this.actions.catch(() => {}); }
  async refreshIndependentGroup(): Promise<void> {
    if (this.closed || this.groupRefreshRunning) return;
    const selected = this.service.desktopFocusSnapshot();
    this.groupRefreshRunning = true;
    try {
      const job = this.actions.then(async () => {
        if (this.closed) return;
        let profile: DesktopCoordinatorProfile | undefined;
        try { profile = this.creationProfile?.(selected.projectId); }
        catch { this.group = undefined; this.groupFocus = undefined; this.groupError = '独立组宿主配置待核对，没有登记或派发。';
          this.error = this.groupError; await this.publish(); return; }
        if (!selected.taskId || !profile?.independentGroup) {
          if (this.group) { this.group = undefined; this.groupFocus = undefined; await this.publish(); } return;
        }
        const frozen = JSON.stringify(profile);
        const guard = () => {
          const current = this.service.desktopFocusSnapshot();
          if (this.closed || current.revision !== selected.revision || current.taskId !== selected.taskId ||
              current.projectId !== selected.projectId || JSON.stringify(this.creationProfile?.(selected.projectId)) !== frozen) {
            throw new ManagementError('version_conflict', '独立组的宿主配置或焦点已变化。');
          }
        };
        try {
          guard();
          const group = await this.service.ensureDesktopIndependentGroup(profile, selected.taskId!, guard);
          guard();
          const clearedError = !!this.groupError && this.error === this.groupError;
          if (clearedError) this.error = undefined;
          this.groupError = undefined;
          if (group?.stage !== 'unavailable') {
            if (group) writeDesktopIndependentGroupStatus(profile, selected.taskId!, group);
            this.groupFocus = selected;
          } else this.groupFocus = undefined;
          if (clearedError || JSON.stringify(group) !== JSON.stringify(this.group)) { this.group = group; await this.publish(); }
        } catch (error) {
          if (!this.closed) { this.group = undefined; this.groupFocus = undefined;
            this.groupError = error instanceof ManagementError ? error.message : '独立组登记待核对，保留原操作编号。';
            this.error = this.groupError;
            await this.publish(); }
        }
      });
      this.actions = job.catch(() => undefined); await job;
    } finally { this.groupRefreshRunning = false; }
  }

  beginInput(scope: TurnScope, binding?: WorkbenchVoiceBinding) {
    this.capturedInput = { scope: { ...scope }, selected: { ...this.service.desktopFocusSnapshot() },
      ...(binding ? { binding: { ...binding } } : {}) };
  }

  focusSnapshot(scope?: TurnScope) {
    return scope && this.capturedInput && JSON.stringify(scope) === JSON.stringify(this.capturedInput.scope) ?
      this.capturedInput.selected : this.service.desktopFocusSnapshot();
  }

  /** Interpretation cannot create identities or inherit execution consent from a supplement. */
  async continueInput(scope: TurnScope, rawText: string, signal: AbortSignal, assertCurrent: () => void,
    interpret?: (scope: TurnScope, text: string, context: PendingWorkContext, signal: AbortSignal) => Promise<WorkContinuationIntent>):
    Promise<'unbound' | 'companion' | 'handled'> {
    const capture = this.capturedInput;
    if (!capture || JSON.stringify(capture.scope) !== JSON.stringify(scope)) return 'unbound';
    if (!capture.binding) {
      if (capture.selected.taskId && this.selectedDraftId && exactNativeConfirm(rawText)) {
        this.error = '请先核对已展示的工程卡片，再确认发送；本次没有发送。'; await this.publish(); return 'handled';
      }
      return 'unbound';
    }
    const binding = capture.binding;
    let result: 'unbound' | 'companion' | 'handled' = 'handled';
    const job = this.actions.then(async () => {
      this.error = undefined; this.lastCommand = undefined;
      try {
        const inputId = identifier(scope.turnId);
        const input: WorkbenchInput = { inputId, origin: { channel: 'desktop', channelSessionId: DESKTOP_WORKBENCH_SESSION,
          messageId: inputId, turnScope: scope }, rawText: body(rawText), dispatchText: rawText, createdAt: new Date().toISOString() };
        const check = async () => {
          signal.throwIfAborted(); assertCurrent();
          if (this.capturedInput !== capture || capture.selected.revision !== binding.focusRevision ||
              capture.selected.projectId !== binding.projectId || capture.selected.taskId !== binding.taskId ||
              this.selectedDraftId !== binding.draftId) throw new ManagementError('version_conflict', '已展示的工程卡片已变化，请重新核对。');
          const focus = await this.service.readDesktopFocus();
          signal.throwIfAborted(); assertCurrent();
          const draft = this.service.readContinuationDraft(binding.draftId, 'desktop', DESKTOP_WORKBENCH_SESSION);
          if (focus.revision !== binding.focusRevision || focus.projectId !== binding.projectId ||
              focus.task?.id !== binding.taskId || focus.task.origin !== 't3' || focus.task.provider !== 'codex' ||
              JSON.stringify(focus.task) !== JSON.stringify(draft.task) || draft.version !== binding.draftVersion ||
              draft.commandId !== binding.commandId || draft.state === 'dismissed') {
            throw new ManagementError('version_conflict', '工程卡片版本或原任务已变化，请重新核对。');
          }
          return draft;
        };
        const draft = await check();
        if (draft.state === 'claimed') {
          this.lastCommand = await this.service.readContinuation(draft.id, 'desktop', DESKTOP_WORKBENCH_SESSION);
        } else {
          const exactConfirm = exactNativeConfirm(rawText);
          const intent: WorkContinuationIntent = exactConfirm ? { kind: 'confirm' } : interpret ? await interpret(scope, rawText,
            { stage: 'confirming', originalRequest: draft.input.rawText, currentRequest: draft.input.dispatchText,
              conversation: (draft.input.conversation ?? []).map(({ role, text }) => ({ role, text })) }, signal) :
            { kind: 'supplement', text: rawText, executionAuthorized: false };
          await check();
          if (intent.kind === 'companion') result = 'companion';
          else if (intent.kind === 'new_work') result = 'unbound';
          else if (intent.kind === 'confirm' && exactConfirm) {
            this.service.appendDesktopContinuationInput(draft.id, draft.version, input);
            this.lastCommand = await this.service.confirmDesktopContinuation(draft.id, draft.version,
              { focusRevision: binding.focusRevision, assertCurrent: () => {
                signal.throwIfAborted(); assertCurrent();
                if (this.capturedInput !== capture) throw new ManagementError('version_conflict', '工程输入已变化。');
              } });
            this.notify?.({ id: inputId + ':native-confirm', kind: this.lastCommand.state === 'accepted' ? 'transferred' :
              this.lastCommand.state === 'unknown' ? 'unknown' : 'failed', executor: 'codex' });
          } else if (intent.kind === 'cancel') {
            this.service.appendDesktopContinuationInput(draft.id, draft.version, input);
            await this.service.dismissContinuation(draft.id, draft.version, 'desktop', DESKTOP_WORKBENCH_SESSION);
            this.selectedDraftId = null;
            this.notify?.({ id: inputId + ':native-cancel', kind: 'cancelled', executor: 'codex' });
          } else {
            const supplement = intent.kind === 'supplement' && intent.routing !== 'changed';
            this.service.appendDesktopContinuationInput(draft.id, draft.version, input,
              supplement ? draft.input.dispatchText + '\n后续补充（按顺序应用）：\n' + rawText : undefined,
              supplement ? undefined : intent.kind === 'clarify' ? intent.question : '请核对当前卡片；说“确认”才发送，修改目标须另选任务。');
            this.selectedDraftId = draft.id;
            this.notify?.({ id: inputId + ':native-amend', kind: 'arrangement', executor: 'codex',
              spokenText: supplement ? '补充已保存在同一张工程卡片里，请核对后说确认。' : '请先核对工程卡片，没有发送。' });
          }
        }
      } catch (error) {
        this.error = error instanceof ManagementError ? error.message : '这次工程输入未发送，请核对原卡片。';
      }
      await this.publish();
    });
    this.actions = job.catch(() => undefined); await job; return result;
  }

  private async exactNativeFocus(projectId: string, taskId: string, expectedRevision: number) {
    const focus = await this.service.readDesktopFocus();
    if (focus.revision !== expectedRevision || focus.projectId !== projectId ||
        focus.task?.id !== taskId || focus.task.origin !== 't3' || focus.task.provider !== 'codex') {
      throw new ManagementError('version_conflict', '桌宠原生任务焦点已变化，请重新核对。');
    }
    return focus.task;
  }

  /** An engineering text/ASR turn enters the selected T3 task as a draft, never as execution consent. */
  async routeInput(scope: TurnScope, rawText: string, signal: AbortSignal,
    assertCurrent: () => void, selected: ReturnType<DesktopWorkbench['focusSnapshot']>): Promise<boolean> {
    const projectId = selected.projectId, taskId = selected.taskId;
    let profile: DesktopCoordinatorProfile | undefined;
    try { if (!taskId) profile = this.creationProfile?.(projectId); }
    catch { this.error = '协调创建配置待核对，没有创建或发送。'; await this.publish(); return true; }
    if ((!taskId || !projectId) && !profile) return false;
    if (exactNativeConfirm(rawText)) {
      this.error = '没有与本次输入绑定的已展示卡片；本次没有创建或发送。'; await this.publish(); return true;
    }
    const job = this.actions.then(async () => {
      this.error = undefined; this.lastCommand = undefined;
      try {
        signal.throwIfAborted(); assertCurrent();
        const focus = await this.service.readDesktopFocus();
        if (focus.projectId !== projectId || (focus.task?.id ?? null) !== taskId ||
            focus.revision !== selected.revision) {
          throw new ManagementError('version_conflict', '所选原生任务已变化，请重新选择。');
        }
        const messageId = identifier(scope.turnId);
        const input: WorkbenchInput = { inputId: messageId,
          origin: { channel: 'desktop', channelSessionId: DESKTOP_WORKBENCH_SESSION,
            messageId, turnScope: scope }, rawText: body(rawText), dispatchText: rawText,
          createdAt: new Date().toISOString() };
        let draft;
        if (profile && !taskId) {
          const frozen = JSON.stringify(profile);
          const guard = () => { signal.throwIfAborted(); assertCurrent();
            if (JSON.stringify(this.creationProfile?.(projectId)) !== frozen) {
              throw new ManagementError('version_conflict', '协调创建配置已变化，请按原操作核对。');
            } };
          const created = await this.service.ensureDesktopCoordinator(profile, input, selected, guard);
          if (created.state !== 'accepted' || !('draft' in created) || !created.draft) {
            throw new ManagementError('unavailable', '协调对话创建结果待按原操作核对，不会重新创建。');
          }
          draft = created.draft;
        } else {
          draft = await this.service.prepareDesktopContinuation(projectId!, taskId!,
            selected.revision, input, () => { signal.throwIfAborted(); assertCurrent(); });
        }
        this.selectedDraftId = draft.id;
        this.notify?.({ id: messageId + ':native-ready', kind: 'arrangement', executor: 'codex',
          spokenText: '任务已整理为工程卡片，你可以继续补充，核对后说确认。' });
      } catch (error) {
        this.error = error instanceof ManagementError ? error.message : '原生任务草稿未保存，请刷新后重试。';
      }
      await this.publish();
    });
    this.actions = job.catch(() => undefined);
    await job;
    return true;
  }

  async action(raw: unknown): Promise<void> {
    const job = this.actions.then(async () => {
      this.error = undefined;
      this.nativeError = undefined;
      this.lastCommand = undefined;
      let nativeAction = false;
      try {
        const action = parseWorkbenchDesktopAction(raw);
        nativeAction = action.type === 'respond_interaction' || action.type === 'read_interaction';
        if (action.type === 'select') {
          await this.service.saveDesktopFocus(action.projectId, action.taskId, action.expectedRevision);
          this.selectedDraftId = null; this.lastCommand = undefined;
          this.selectedInteractionId = null; this.selectedInteractionTask = null;
        } else if (action.type === 'prepare') {
          const input: WorkbenchInput = { inputId: action.messageId,
            origin: { channel: 'desktop', channelSessionId: DESKTOP_WORKBENCH_SESSION,
              messageId: action.messageId }, rawText: action.rawText, dispatchText: action.dispatchText,
            createdAt: new Date().toISOString() };
          const draft = await this.service.prepareDesktopContinuation(action.projectId, action.taskId,
            action.expectedFocusRevision, input);
          this.selectedDraftId = draft.id; this.lastCommand = undefined;
        } else if (action.type === 'revise') {
          await this.service.reviseContinuation(action.draftId, action.expectedVersion,
            'desktop', DESKTOP_WORKBENCH_SESSION, action.dispatchText);
          this.selectedDraftId = action.draftId; this.lastCommand = undefined;
        } else if (action.type === 'dismiss') {
          await this.service.dismissContinuation(action.draftId, action.expectedVersion,
            'desktop', DESKTOP_WORKBENCH_SESSION);
          this.selectedDraftId = null; this.lastCommand = undefined;
        } else if (action.type === 'confirm') {
          this.lastCommand = await this.service.confirmDesktopContinuation(action.draftId, action.expectedVersion);
          this.selectedDraftId = action.draftId;
        } else if (action.type === 'select_draft') {
          const listed = await this.service.listDesktopContinuationDrafts();
          if (!listed.drafts.some(draft => draft.id === action.draftId)) {
            throw new ManagementError('not_found', '没有当前桌宠焦点下的任务草稿。');
          }
          this.selectedDraftId = action.draftId; this.lastCommand = undefined;
        } else if (action.type === 'respond_interaction') {
          const task = await this.exactNativeFocus(action.projectId, action.taskId,
            action.expectedFocusRevision);
          this.selectedInteractionId = action.interactionId;
          this.selectedInteractionTask = taskIdentity(task);
          const [listed, bound, status] = await Promise.all([
            this.service.listNativeInteractions(action.projectId, action.taskId),
            this.service.listNativeInteractionBindings(action.projectId, action.taskId),
            this.service.status(),
          ]);
          if (!status.dispatchEnabled || listed.status !== 'supported' || bound.status !== 'supported' ||
              taskIdentity(listed.task) !== taskIdentity(task) ||
              taskIdentity(bound.task) !== taskIdentity(task) ||
              bound.bindings.some(row => row.interactionId === action.interactionId)) {
            throw new ManagementError('version_conflict', '原生请求或已认领命令待核对，不能再次提交。');
          }
          const interaction = listed.interactions.find(row => row.id === action.interactionId);
          if (!interaction || interaction.version !== action.expectedVersion ||
              interaction.state !== 'pending' ||
              interaction.kind !== (action.response.type === 'decide_approval' ? 'approval' : 'question')) {
            throw new ManagementError('version_conflict', '原生请求版本或类型已变化。');
          }
          await this.exactNativeFocus(action.projectId, action.taskId, action.expectedFocusRevision);
          const result = await this.service.respondNativeInteraction(action.projectId, action.taskId,
            action.interactionId, action.expectedVersion, action.response);
          if (result.command.state === 'unsupported') this.nativeError = '原生派发未启用，没有发送。';
        } else if (action.type === 'read_interaction') {
          const task = await this.exactNativeFocus(action.projectId, action.taskId,
            action.expectedFocusRevision);
          this.selectedInteractionId = action.interactionId;
          this.selectedInteractionTask = taskIdentity(task);
          const bound = await this.service.listNativeInteractionBindings(action.projectId, action.taskId);
          if (bound.status !== 'supported' || taskIdentity(bound.task) !== taskIdentity(task) ||
              !bound.bindings.some(row => row.interactionId === action.interactionId)) {
            throw new ManagementError('not_found', '当前准确任务没有这条原命令绑定。');
          }
        } else {
          this.projectQuery = action.projectQuery ?? this.projectQuery;
          this.lastCommand = undefined;
        }
      } catch (error) {
        if (nativeAction) this.nativeError = error instanceof ManagementError ? error.message :
          '原生请求结果待核对，请只读刷新原命令。';
        else this.error = error instanceof ManagementError ? error.message : '工作台暂不可读取，请稍后刷新。';
      }
      await this.publish();
    });
    this.actions = job.catch(() => undefined);
    return job;
  }

  private async publish(): Promise<void> {
    const status = await this.service.status(true);
    let focus = emptyFocus;
    let tasks: WorkbenchDesktopState['tasks'] = [];
    let drafts: WorkbenchDesktopState['drafts'] = [];
    let draftsTruncated = false;
    let command = this.lastCommand;
    try {
      const listed = await this.service.listDesktopContinuationDrafts();
      focus = listed.focus; drafts = listed.drafts; draftsTruncated = listed.truncated;
      if (focus.projectId) tasks = (await this.service.listTasks(focus.projectId)).tasks;
      if (!this.selectedDraftId || !drafts.some(draft => draft.id === this.selectedDraftId)) {
        this.selectedDraftId = drafts[0]?.id ?? null; command = undefined;
      }
      if (this.selectedDraftId && !command) command = await this.service.readContinuation(this.selectedDraftId,
        'desktop', DESKTOP_WORKBENCH_SESSION);
    } catch (error) {
      this.error ??= error instanceof ManagementError ? error.message : '工作台暂不可读取，请稍后刷新。';
      command = undefined; drafts = []; tasks = []; this.selectedDraftId = null;
    }
    let projects: WorkbenchDesktopState['projects'] = [];
    let projectsTruncated = false;
    try {
      const page = await this.projects.list({ query: this.projectQuery, limit: 100 });
      projects = page.items.map(({ id, name }) => ({ id, name }));
      projectsTruncated = page.total > page.items.length;
    } catch { this.error ??= '项目目录暂不可读取。'; }
    let native: WorkbenchDesktopNativeState = { status: 'no_target', task: null, interactions: [],
      bindingsStatus: 'unavailable', bindings: [], selectedInteractionId: null };
    const target = taskIdentity(focus.task);
    if (target !== this.selectedInteractionTask) {
      this.selectedInteractionId = null; this.selectedInteractionTask = target;
    }
    if (focus.projectId && focus.task) {
      native = { ...native, status: focus.task.origin === 't3' && focus.task.provider === 'codex' ?
        'unavailable' : 'unsupported', task: focus.task,
        selectedInteractionId: this.selectedInteractionId };
      if (target) {
        const [listed, bound] = await Promise.allSettled([
          this.service.listNativeInteractions(focus.projectId, focus.task.id),
          this.service.listNativeInteractionBindings(focus.projectId, focus.task.id),
        ]);
        if (listed.status === 'fulfilled' && taskIdentity(listed.value.task) === target) {
          native = { ...native, status: listed.value.status, interactions: listed.value.interactions };
        }
        if (bound.status === 'fulfilled' && taskIdentity(bound.value.task) === target) {
          native = { ...native, bindingsStatus: bound.value.status, bindings: bound.value.bindings };
        }
        if (this.selectedInteractionId && native.bindings.some(row => row.interactionId === this.selectedInteractionId)) {
          try {
            const command = await this.service.readNativeInteractionCommandForTask(focus.projectId,
              focus.task.id, this.selectedInteractionId);
            native = { ...native, command };
          } catch { native = { ...native, error: '原命令暂不可读取；保留请求编号，稍后只读核对。' }; }
        }
        if (listed.status === 'rejected' || bound.status === 'rejected') {
          native = { ...native, error: '原生请求或已认领绑定暂不可读取；不能提交回答。' };
        }
      }
    }
    if (this.nativeError) native = { ...native, error: this.nativeError };
    const selectedDraft = drafts.find(draft => draft.id === this.selectedDraftId);
    const voiceBinding: WorkbenchVoiceBinding | undefined = !this.error && focus.task?.origin === 't3' &&
      focus.task.provider === 'codex' && focus.projectId && selectedDraft?.state === 'open' &&
      JSON.stringify(selectedDraft.task) === JSON.stringify(focus.task) ? {
        version: '0.1.0', projectId: focus.projectId, taskId: focus.task.id, focusRevision: focus.revision,
        draftId: selectedDraft.id, draftVersion: selectedDraft.version, commandId: selectedDraft.commandId,
      } : undefined;
    this.emit({ version: '0.1.0', sequence: ++this.sequence, readAvailable: status.readAvailable,
      dispatchEnabled: status.dispatchEnabled, focus, projects, projectsTruncated, tasks, drafts,
      draftsTruncated, selectedDraftId: this.selectedDraftId, native, ...(command ? { command } : {}),
      ...(this.error ? { error: this.error } : {}), ...(voiceBinding ? { voiceBinding } : {}),
      ...(this.group && this.groupFocus?.revision === focus.revision && this.groupFocus.projectId === focus.projectId &&
        this.groupFocus.taskId === focus.task?.id ? { independentGroup: { operationId: this.group.operationId,
          stage: this.group.stage, ...(this.group.boardId ? { boardId: this.group.boardId } : {}) } } : {}) });
  }
}
