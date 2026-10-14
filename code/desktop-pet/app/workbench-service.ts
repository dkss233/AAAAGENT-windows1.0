import type { WorkbenchNativeOpenInput, WorkbenchNativeBrowserPort } from '../contracts/workbench.js';
import type { DesktopCoordinatorProfile, DesktopIndependentGroupState, DesktopIndependentGroupPort } from '../contracts/workbench.js';
import type { WorkbenchContinuationDraft } from '../contracts/workbench.js';
import type { WorkbenchTurnAuthorization } from '../contracts/workbench-runtime.js';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ProjectIndexPort } from '../contracts/projects.js';
import type { ProjectProviderContextBinding, ProjectProviderContextPreparationPort,
  ProjectProviderContextProof, ProjectProviderContextProofSignerPort } from '../contracts/project-provider-context.js';
import { PROJECT_TERMINAL_EXTRACTION_VERSION, type ProjectMemoryPort,
  type ProjectTerminalEvidence, type ProjectTerminalMaterialPort, type ProjectRecentTurnPort,
  type ProjectContextAssemblerPort, type ProjectProviderInputBudget } from '../contracts/project-memory.js';
import type { WorkbenchChannelCommandPort, WorkbenchChannelTaskRead, WorkbenchCommand, WorkbenchCommandResult, WorkbenchDesktopFocus,
  WorkbenchInput, WorkbenchInputOrigin, WorkbenchInteraction, WorkbenchInteractionCommandRead,
  WorkbenchInteractionResponse, WorkbenchNativeInteractionPort, WorkbenchTaskRef, WorkbenchWebFocus } from '../contracts/workbench.js';
import type { WorkbenchChannelEventReadPort, WorkbenchNativeEventMeta, WorkbenchTaskEventPage } from '../contracts/workbench.js';
import { ManagementError } from '../contracts/management.js';
import { WorkbenchInteractionGateway, WorkbenchTurnGateway, type PreparedT3Turn,
  type T3TurnPort } from '../workbench/commands.js';
import { t3ShellToTaskEvent, type T3ThreadShellRead } from '../workbench/t3-read.js';
import { signProviderContextFreeze } from '../workbench/project-provider-context-proof.js';
import { t3TerminalMaterial } from './terminal-material.js';
import { normalizeProjectRecentTurns, validateProjectProviderBudget } from './project-context.js';
import type { NativeCreateIntent, ProviderContextFreeze, SqliteWorkbenchStore } from './workbench-store.js';

type NativeCreateCommand = {
  readonly type: 'project.create' | 'thread.create'; readonly commandId: string;
  readonly projectId: string; readonly createdAt: string; readonly [key: string]: unknown;
};
type ConfirmedDesktopAdmission = ((draft: WorkbenchContinuationDraft, native: unknown) => boolean) &
  { readonly modelSelection: unknown };
export interface CreateNativeTaskInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly title: string;
  readonly provider: 'codex' | 'dsh';
  readonly modelSelection: { readonly instanceId: string; readonly model: string; readonly reasoningEffort?: string };
}

export interface T3WorkbenchClient extends T3TurnPort {
  environmentDescriptor(): Promise<{ readonly environmentId: string }>;
  shellSnapshot(): Promise<unknown>;
  threadSnapshot(threadId: string, turnLimit?: number, beforeCursor?: string): Promise<unknown>;
  threadEventPage?(threadId: string, afterSequence: number, limit?: number): Promise<unknown>;
  providerModels?(instanceId?: 'codex' | 'dsh'): Promise<{ readonly providers: readonly { readonly instanceId: string;
    readonly driver: string; readonly enabled: boolean; readonly installed: boolean;
    readonly status: string; readonly authStatus: string; readonly checkedAt: string;
    readonly models: readonly { readonly id: string; readonly name: string; readonly reasoningEfforts?: readonly { readonly id: string; readonly name: string }[]; readonly defaultReasoningEffort?: string }[] }[] }>;
  createCommand?(command: NativeCreateCommand): Promise<{ readonly sequence: number }>;
}

interface T3ShellSnapshot {
  readonly snapshotSequence: number;
  readonly updatedAt: string;
  readonly projects: readonly { readonly id: string; readonly workspaceRoot: string }[];
  readonly threads: readonly T3ThreadShellRead[];
}

type NativeRuntimeMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access';
type NativeInteractionMode = 'default' | 'plan';
interface NativeTurnModes { readonly runtimeMode: NativeRuntimeMode; readonly interactionMode: NativeInteractionMode }
function nativeTurnModes(value: unknown): NativeTurnModes | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { runtimeMode?: unknown; interactionMode?: unknown };
  const runtimeMode = candidate.runtimeMode, interactionMode = candidate.interactionMode;
  if (runtimeMode !== 'approval-required' && runtimeMode !== 'auto-accept-edits' &&
      runtimeMode !== 'auto' && runtimeMode !== 'full-access') return null;
  if (interactionMode !== 'default' && interactionMode !== 'plan') return null;
  return { runtimeMode, interactionMode };
}

const id = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 250 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ManagementError('invalid_request', '工作台标识无效。');
  }
  return value;
};
const sourceLabel = (value: string): string => {
  if (!value.trim() || value.length > 1000 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ManagementError('invalid_request', '来源标识无效。');
  }
  return value;
};
/** One native desktop shell owns this local focus; the renderer cannot choose its session identity. */
export const DESKTOP_WORKBENCH_SESSION = 'desktop-primary' as const;

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nativeText = (value: unknown, max = 1000): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
const nativeAnswerValue = (value: unknown, max = 1000): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0') ? value : null;
const decisionIds = new Set(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel']);
/** Matches the fixed T3 ComposerPendingApprovalActions fallback for older approval activities. */
const t3DefaultApprovalChoices = [
  { id: 'cancel', label: 'Cancel' }, { id: 'decline', label: 'Decline' },
  { id: 'acceptForSession', label: 'Always allow this session' }, { id: 'accept', label: 'Approve' },
] as const;
type InteractionRead = { readonly status: 'supported' | 'unverified';
  readonly interactions: readonly WorkbenchInteraction[]; readonly activities: readonly Record<string, unknown>[];
  readonly session: Record<string, unknown> | null };

function nativeInteractions(task: Extract<WorkbenchTaskRef, { readonly origin: 't3' }>, native: unknown): InteractionRead {
  const thread = objectValue(objectValue(native)?.thread);
  if (!thread || !Array.isArray(thread.activities) || thread.activities.length > 10000) {
    return { status: 'unverified', interactions: [], activities: [], session: null };
  }
  const activities = thread.activities.map(objectValue);
  if (activities.some(value => !value)) return { status: 'unverified', interactions: [], activities: [], session: null };
  const rows = activities as Record<string, unknown>[];
  const closed = new Set<string>();
  const pending = new Map<string, WorkbenchInteraction>();
  let malformed = false;
  for (const row of rows) {
    const kind = row.kind;
    if (kind !== 'approval.requested' && kind !== 'approval.resolved' &&
        kind !== 'user-input.requested' && kind !== 'user-input.resolved' &&
        kind !== 'provider.approval.respond.failed' && kind !== 'provider.user-input.respond.failed') continue;
    const payload = objectValue(row.payload);
    const requestId = nativeText(payload?.requestId, 250);
    if (!requestId) { malformed = true; continue; }
    const approval = kind.startsWith('approval.') || kind === 'provider.approval.respond.failed';
    const key = `${approval ? 'approval' : 'question'}:${requestId}`;
    const failure = kind.endsWith('.failed');
    const detail = typeof payload?.detail === 'string' ? payload.detail.toLowerCase() : '';
    const stale = failure && (detail.includes('stale pending') || detail.includes('unknown pending'));
    if (kind.endsWith('.resolved') || stale) { closed.add(key); pending.delete(key); continue; }
    if (failure || closed.has(key)) continue;
    if (payload?.requestType === 'tool_user_input' || payload?.requestType === 'auth_tokens_refresh') continue;
    const eventId = nativeText(row.id, 250);
    const sequence = row.sequence;
    if (!eventId || !Number.isSafeInteger(sequence) || Number(sequence) < 0) { malformed = true; continue; }
    const turnId = row.turnId === null ? undefined : nativeText(row.turnId, 250);
    if (row.turnId !== null && !turnId) { malformed = true; continue; }
    const common = { id: createHash('sha256').update(JSON.stringify([task.id, key])).digest('hex'),
      taskId: task.id, nativeRequestId: requestId, liveEventId: eventId,
      ...(turnId ? { nativeTurnId: turnId } : {}), version: Number(sequence), state: 'pending' as const };
    if (approval) {
      const raw = payload?.options;
      if (raw !== undefined && (!Array.isArray(raw) || raw.length > 8)) { malformed = true; continue; }
      const providerChoices = Array.isArray(raw) && raw.length > 0;
      const choices = (providerChoices ? raw : t3DefaultApprovalChoices.map(value =>
        ({ decision: value.id, label: value.label }))).map(option => {
        const value = objectValue(option);
        const choiceId = nativeText(value?.decision, 50), label = nativeAnswerValue(value?.label, 500);
        return choiceId && decisionIds.has(choiceId) && label ? { id: choiceId, label,
          ...(nativeAnswerValue(value?.warning, 1000) ? { warning: value!.warning as string } : {}) } : null;
      });
      if (choices.some(value => !value) || new Set(choices.map(value => value!.id)).size !== choices.length) {
        malformed = true; continue;
      }
      pending.set(key, { ...common, kind: 'approval', summary: nativeAnswerValue(row.summary, 2000) ?? '原生审批请求',
        answerLifetime: 'live_only', choiceSource: providerChoices ? 'provider' : 't3_default',
        choices: choices as NonNullable<typeof choices[number]>[] });
      continue;
    }
    const raw = payload?.questions;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) { malformed = true; continue; }
    const questions = raw.map(question => {
      const value = objectValue(question);
      const questionId = nativeAnswerValue(value?.id, 250), prompt = nativeAnswerValue(value?.question, 4000);
      const rawOptions = value?.options;
      if (!questionId || !prompt || !Array.isArray(rawOptions) || rawOptions.length > 30) return null;
      const options = rawOptions.map(option => {
        const item = objectValue(option);
        const label = nativeAnswerValue(item?.label, 1000);
        const optionId = item?.value === undefined ? label : nativeAnswerValue(item.value, 1000);
        return label && optionId ? { id: optionId, label,
          ...(nativeAnswerValue(item?.description, 2000) ? { description: item!.description as string } : {}) } : null;
      });
      if (options.some(option => !option) || new Set(options.map(option => option!.id)).size !== options.length ||
          options.length === 0 && value!.allowCustomAnswer === false) return null;
      return { id: questionId, prompt, options: options as NonNullable<typeof options[number]>[],
        allowMultiple: value!.multiSelect === true, allowCustomAnswer: value!.allowCustomAnswer !== false };
    });
    if (questions.some(value => !value) || new Set(questions.map(value => value!.id)).size !== questions.length) {
      malformed = true; continue;
    }
    pending.set(key, { ...common, kind: 'question', answerLifetime: payload?.responseMode === 'message' ? 'durable' : 'live_only',
      questions: questions as NonNullable<typeof questions[number]>[] });
  }
  return { status: malformed ? 'unverified' : 'supported', interactions: malformed ? [] : [...pending.values()],
    activities: rows, session: objectValue(thread.session) };
}

function shell(value: unknown): T3ShellSnapshot {
  if (!value || typeof value !== 'object') throw new ManagementError('unavailable', '原生任务列表尚不可读取。');
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.snapshotSequence) || Number(candidate.snapshotSequence) < 0 ||
      typeof candidate.updatedAt !== 'string' || !Array.isArray(candidate.projects) || !Array.isArray(candidate.threads)) {
    throw new ManagementError('unavailable', '原生任务列表格式不匹配。');
  }
  return candidate as unknown as T3ShellSnapshot;
}

/** Same-origin workbench facade. It never returns the T3 origin, bearer credential or an artifact URL. */
export class WorkbenchService implements WorkbenchChannelCommandPort, WorkbenchNativeInteractionPort,
  WorkbenchChannelEventReadPort, ProjectTerminalMaterialPort, ProjectRecentTurnPort {
  private readonly gateway: WorkbenchTurnGateway;
  private readonly interactionGateway: WorkbenchInteractionGateway;
  private terminalRecovery: Promise<number> | null = null;
  constructor(private readonly projects: ProjectIndexPort, private readonly store: SqliteWorkbenchStore,
    private readonly t3: T3WorkbenchClient, private readonly dispatchEnabled = false,
    private readonly projectMemory?: ProjectMemoryPort,
    private readonly projectContext?: ProjectContextAssemblerPort,
    private readonly providerContext?: ProjectProviderContextPreparationPort,
    private readonly projectContextProofSigner?: ProjectProviderContextProofSignerPort,
    private readonly nativeBrowser?: WorkbenchNativeBrowserPort,
    private readonly turnAuthorization?: WorkbenchTurnAuthorization,
    private readonly independentGroup?: DesktopIndependentGroupPort,
    private readonly desktopCoordinatorProfile?: (projectId: string | null) => DesktopCoordinatorProfile | undefined) {
    this.gateway = new WorkbenchTurnGateway(store.ledger, t3);
    this.interactionGateway = new WorkbenchInteractionGateway(store.interactionLedger, {
      // The HTTP client accepts the same T3 command envelope for turn and response commands.
      dispatch: command => t3.dispatch(command as unknown as PreparedT3Turn['command']),
      ...(t3.readReceipt ? { readReceipt: commandId => t3.readReceipt!(commandId) } : {}),
    });
  }

  async status(desktop = false) {
    try { const { snapshot } = await this.snapshot();
      const focus = this.store.getDesktopFocus(), task = focus.taskId ? this.store.getTask(focus.taskId)?.task : undefined;
      let firstReady = false;
      try {
        if (desktop && task?.origin === 't3') {
          const profile = this.firstDesktopCoordinator(task, snapshot.threads.find(t => t.id === task.threadId));
          firstReady = !!profile && !this.store.hasDesktopFirstTurnAdmission(profile.operationId);
        }
      } catch { /* Invalid or unavailable optional host configuration grants nothing. */ }
      return { version: '0.1.1', readAvailable: true, dispatchEnabled: this.dispatchEnabled && ((this.turnAuthorization?.available() ?? true) || firstReady),
        sourceOpening: 'verified_same_origin_task_detail', preciseTurnJump: false } as const;
    } catch {
      return { version: '0.1.1', readAvailable: false, dispatchEnabled: false,
        sourceOpening: 'unavailable', preciseTurnJump: false } as const;
    }
  }

  async openNativeBrowser(input: WorkbenchNativeOpenInput, channel: 'web' | 'desktop' = 'web', cookie?: string) {
    if (!this.nativeBrowser) throw new ManagementError('unavailable', '完整工作台入口尚未就绪。');
    if (!['home', 'project', 'task'].includes(input.target) ||
        input.target === 'home' && (input.projectId !== undefined || input.taskId !== undefined || input.expectedFocusRevision !== undefined) ||
        input.target === 'project' && input.taskId !== undefined) throw new ManagementError('invalid_request', '打开目标无效。');
    const projectId = input.target === 'home' ? undefined : id(input.projectId);
    if (input.target !== 'home' && (channel === 'desktop' || input.expectedFocusRevision !== undefined)) {
      const focus = channel === 'desktop' ? await this.readDesktopFocus() : (await this.readWebFocus(projectId!, cookie)).focus;
      if (focus.revision !== input.expectedFocusRevision || focus.projectId !== projectId ||
          input.target === 'task' && focus.task?.id !== input.taskId) throw new ManagementError('version_conflict', '当前任务已变化，请刷新后重新打开。');
    }
    const { environmentId, snapshot } = await this.snapshot();
    let target: Parameters<WorkbenchNativeBrowserPort['openBrowser']>[0] = { kind: input.target, environmentId };
    if (input.target === 'project') {
      const bindings = this.store.listProjectBindings(projectId!).filter(b => b.environmentId === environmentId);
      if (bindings.length !== 1) throw new ManagementError('version_conflict', '项目尚无唯一原生绑定，请在完整工作台核对。');
      const binding = bindings[0]!;
      this.verifyProjectLocation(projectId!, environmentId, binding.t3ProjectId, snapshot);
      target = { ...target, t3ProjectId: binding.t3ProjectId, workspaceRoot: binding.workspaceRoot };
    } else if (input.target === 'task') {
      const { task } = await this.detail(projectId!, id(input.taskId));
      const binding = this.store.getProjectBinding(projectId!, environmentId, task.t3ProjectId)!;
      target = { ...target, t3ProjectId: task.t3ProjectId, workspaceRoot: binding.workspaceRoot,
        threadId: task.threadId, providerInstanceId: task.providerInstanceId };
    }
    try {
      const entry = await this.nativeBrowser.openBrowser(target, { returnToOriginalManagement: true });
      return { version: '0.1.0', status: 'ready', ...entry, target: { ...target, projectId,
        ...(input.target === 'task' ? { taskId: input.taskId } : {}) } } as const;
    } catch { throw new ManagementError('unavailable', '完整工作台暂不可打开，请稍后重新打开。任务不会重发。'); }
  }

  private async snapshot(): Promise<{ readonly environmentId: string; readonly snapshot: T3ShellSnapshot }> {
    try {
      const [descriptor, native] = await Promise.all([this.t3.environmentDescriptor(), this.t3.shellSnapshot()]);
      return { environmentId: id(descriptor.environmentId), snapshot: shell(native) };
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      throw new ManagementError('unavailable', '原生工作服务暂不可读取，请稍后核对。');
    }
  }

  /** Only a live T3 provider snapshot may populate the creation selector. */
  async modelCatalog(provider: 'codex' | 'dsh' = 'codex') {
    if (provider !== 'codex' && provider !== 'dsh') throw new ManagementError('invalid_request', '执行器无效。');
    const unavailable = { version: '0.1.0', available: false, provider, instanceId: provider,
      checkedAt: null, models: [] } as const;
    if (!this.t3.providerModels) return unavailable;
    try {
      const catalog = await this.t3.providerModels(provider);
      const matches = catalog.providers.filter(value => value.instanceId === provider && value.driver === provider);
      if (matches.length !== 1) return unavailable;
      const selected = matches[0]!;
      const age = Date.now() - Date.parse(selected.checkedAt);
      if (!selected.enabled || !selected.installed || selected.status !== 'ready' ||
          selected.authStatus !== 'authenticated' || !Number.isFinite(age) || age < -60000 ||
          age > 15 * 60000 || selected.models.length === 0 || selected.models.length > 500 ||
          selected.models.some(model => !id(model.id) || !id(model.name)) ||
          new Set(selected.models.map(model => model.id)).size !== selected.models.length) return unavailable;
      return { version: '0.1.0', available: true, provider, instanceId: provider,
        checkedAt: selected.checkedAt, models: selected.models.map(model => ({ id: model.id, name: model.name,
          ...(model.reasoningEfforts ? { reasoningEfforts: model.reasoningEfforts, defaultReasoningEffort: model.defaultReasoningEffort } : {}) })) } as const;
    } catch { return unavailable; }
  }

  /** Recover the original request after a page restart without reading T3 or dispatching work. */
  async unfinishedNativeCreations(projectId: string) {
    const selectedProject = id(projectId);
    if (!await this.projects.get(selectedProject)) throw new ManagementError('not_found', '没有找到所选项目。');
    return { version: '0.1.0', projectId: selectedProject,
      creations: this.store.listUnfinishedNativeCreates(selectedProject).map(row => ({
        operationId: row.operationId, createdAt: row.createdAt,
        state: row.projectPhase === 'rejected' || row.threadPhase === 'rejected' ? 'conflict' : 'unknown',
        stage: row.projectPhase !== 'accepted' ? 'project' :
          row.threadPhase === 'accepted' ? 'thread_readback' : 'thread',
        request: row.title !== null && row.model !== null ? {
          operationId: row.operationId, projectId: selectedProject, title: row.title,
          provider: row.provider, modelSelection: { instanceId: row.provider, model: row.model,
            ...(row.reasoningEffort === null ? {} : { reasoningEffort: row.reasoningEffort }) },
        } : null,
      })) } as const;
  }

  private verifyProjectLocation(projectId: string, environmentId: string, t3ProjectId: string,
    snapshot: T3ShellSnapshot): void {
    const mapped = this.store.getProjectBinding(projectId, environmentId, t3ProjectId);
    const native = snapshot.projects.find(item => item.id === t3ProjectId);
    if (!mapped || !native || native.workspaceRoot !== mapped.workspaceRoot) {
      throw new ManagementError('version_conflict', '原生项目位置或绑定已变化，请核对来源。');
    }
  }

  private async nativeCreatePhase(intent: NativeCreateIntent, kind: 'project' | 'thread',
    command: NativeCreateCommand): Promise<'accepted' | 'rejected' | 'unknown'> {
    if (this.store.startNativeCreatePhase(intent.operationId, kind)) {
      try { await this.t3.createCommand!(command); }
      catch { /* The persistent claim forbids a second send after an uncertain response. */ }
    }
    try {
      const receipt = await this.t3.readReceipt?.(command.commandId);
      const expectedKind = kind === 'project' ? 'project' : 'thread';
      const expectedId = kind === 'project' ? intent.t3ProjectId : intent.threadId;
      if (receipt && receipt.aggregateKind === expectedKind && receipt.aggregateId === expectedId) {
        const phase = receipt.status === 'accepted' ? 'accepted' : 'rejected';
        this.store.setNativeCreatePhase(intent.operationId, kind, phase);
        return phase;
      }
    } catch { /* A read outage remains unknown; never retry the dispatch. */ }
    const latest = this.store.getNativeCreate(intent.operationId)?.[kind === 'project' ? 'projectPhase' : 'threadPhase'];
    if (latest === 'accepted' || latest === 'rejected') return latest;
    try { this.store.setNativeCreatePhase(intent.operationId, kind, 'unknown'); }
    catch {
      const settled = this.store.getNativeCreate(intent.operationId)?.[kind === 'project' ? 'projectPhase' : 'threadPhase'];
      if (settled === 'accepted' || settled === 'rejected') return settled;
      throw new ManagementError('version_conflict', '创建操作状态已变化。');
    }
    return 'unknown';
  }

  /** No turn or model request is sent. Both native commands have durable local claims and receipt readback. */
  async createNativeTask(input: CreateNativeTaskInput) {
    if (!this.t3.createCommand || !this.t3.readReceipt) throw new ManagementError('unavailable', '原生创建服务尚不可用。');
    const projectId = id(input.projectId), title = id(input.title);
    if (!['codex', 'dsh'].includes(input.provider) || input.modelSelection?.instanceId !== input.provider) {
      throw new ManagementError('invalid_request', '执行器配置尚未核实。');
    }
    const model = id(input.modelSelection.model);
    const reasoningEffort = input.modelSelection.reasoningEffort === undefined ? undefined : id(input.modelSelection.reasoningEffort);
    if (input.provider === 'dsh' && reasoningEffort === undefined) {
      throw new ManagementError('invalid_request', '执行器推理配置须明确核实。');
    }
    if (!this.store.getNativeCreate(input.operationId)) {
      const catalog = await this.modelCatalog(input.provider);
      if (!catalog.available) throw new ManagementError('unavailable', '当前账号模型目录暂不可核实。');
      if (!catalog.models.some(value => value.id === model && (reasoningEffort === undefined ||
          value.reasoningEfforts?.some(effort => effort.id === reasoningEffort)))) {
        throw new ManagementError('invalid_request', '所选模型不在当前账号目录中。');
      }
    }
    const project = await this.projects.get(projectId);
    if (!project) throw new ManagementError('not_found', '没有找到所选项目。');
    const workspaceRoot = project.detailRef.rootPath;
    try {
      if (realpathSync(workspaceRoot) !== workspaceRoot || !statSync(workspaceRoot).isDirectory()) throw Error('not_exact_directory');
    } catch { throw new ManagementError('invalid_request', '项目工作目录须是已存在的准确目录。'); }
    const { environmentId, snapshot } = await this.snapshot();
    const existing = this.store.listProjectBindings(projectId).filter(value => value.environmentId === environmentId);
    if (existing.length > 1 || existing.length === 1 && existing[0]!.workspaceRoot !== workspaceRoot) {
      throw new ManagementError('version_conflict', '项目有多个或已变化的原生工作区，请先选择准确目标。');
    }
    if (existing.length) this.verifyProjectLocation(projectId, environmentId, existing[0]!.t3ProjectId, snapshot);
    const digest = createHash('sha256').update(JSON.stringify([projectId, workspaceRoot,
      title, input.provider, input.modelSelection.instanceId, model, 'approval-required',
      ...(reasoningEffort === undefined ? [] : [reasoningEffort])])).digest('hex');
    const intent = this.store.claimNativeCreate({ operationId: input.operationId, digest, environmentId,
      projectId, workspaceRoot, title, model, provider: input.provider, ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(existing.length ? { existingT3ProjectId: existing[0]!.t3ProjectId } : {}) });
    if (intent.projectPhase !== 'accepted') {
      const phase = await this.nativeCreatePhase(intent, 'project', { type: 'project.create',
        commandId: intent.projectCommandId, projectId: intent.t3ProjectId, title: project.name,
        workspaceRoot, createdAt: intent.createdAt });
      if (phase !== 'accepted') return { operationId: intent.operationId, state: phase === 'rejected' ? 'conflict' : 'unknown', stage: 'project' };
    }
    const afterProject = await this.snapshot();
    if (afterProject.environmentId !== environmentId) return { operationId: intent.operationId, state: 'unknown', stage: 'environment' };
    const nativeProject = afterProject.snapshot.projects.find(value => value.id === intent.t3ProjectId);
    if (!nativeProject || nativeProject.workspaceRoot !== workspaceRoot) return { operationId: intent.operationId, state: 'unknown', stage: 'project_readback' };
    this.store.bindProject(project, environmentId, nativeProject, workspaceRoot);
    const phase = await this.nativeCreatePhase(intent, 'thread', { type: 'thread.create',
      commandId: intent.threadCommandId, threadId: intent.threadId, projectId: intent.t3ProjectId, title,
      modelSelection: { instanceId: input.provider, model,
        ...(reasoningEffort === undefined ? {} : { options: [{ id: 'reasoningEffort', value: reasoningEffort }] }) }, interactionMode: 'default', runtimeMode: 'approval-required',
      branch: null, worktreePath: null, createdAt: intent.createdAt });
    if (phase !== 'accepted') return { operationId: intent.operationId, state: phase === 'rejected' ? 'conflict' : 'unknown', stage: 'thread' };
    try {
      const task = await this.bindTask(projectId, intent.t3ProjectId, intent.threadId, input.provider);
      return { operationId: intent.operationId, state: 'accepted', task };
    } catch (error) {
      if (error instanceof ManagementError && error.code === 'version_conflict') throw error;
      return { operationId: intent.operationId, state: 'unknown', stage: 'thread_readback' };
    }
  }

  async bindProject(projectId: string, t3ProjectId: string, workspaceRoot: string) {
    const project = await this.projects.get(id(projectId));
    if (!project) throw new ManagementError('not_found', '没有找到所选项目。');
    if (typeof workspaceRoot !== 'string' || workspaceRoot.length > 4096) {
      throw new ManagementError('invalid_request', '工作目录无效。');
    }
    const nativeId = id(t3ProjectId);
    const { environmentId, snapshot } = await this.snapshot();
    const native = snapshot.projects.find(item => item.id === nativeId);
    if (!native) throw new ManagementError('not_found', '原生项目尚未出现，不能建立绑定。');
    return this.store.bindProject(project, environmentId, native, workspaceRoot);
  }

  async bindTask(projectId: string, t3ProjectId: string, threadId: string, provider: 'codex' | 'dsh') {
    if (provider !== 'codex' && provider !== 'dsh') throw new ManagementError('invalid_request', '执行器无效。');
    const localId = id(projectId), nativeProjectId = id(t3ProjectId), nativeThreadId = id(threadId);
    if (!await this.projects.get(localId)) throw new ManagementError('not_found', '没有找到所选项目。');
    const { environmentId, snapshot } = await this.snapshot();
    this.verifyProjectLocation(localId, environmentId, nativeProjectId, snapshot);
    const native = snapshot.threads.find(item => item.id === nativeThreadId);
    if (!native || native.projectId !== nativeProjectId) throw new ManagementError('not_found', '原生任务与所选项目不符。');
    const existing = this.store.getTaskByNative(environmentId, nativeThreadId);
    if (existing) {
      const ref = existing.task;
      if (ref.origin !== 't3' || ref.projectId !== localId || ref.t3ProjectId !== nativeProjectId ||
          ref.provider !== provider || ref.providerInstanceId !== native.modelSelection.instanceId) {
        throw new ManagementError('version_conflict', '原生线程已有不同的任务归属。');
      }
      return ref;
    }
    const ref: WorkbenchTaskRef & { readonly origin: 't3' } = { id: randomUUID(), projectId: localId,
      provider, origin: 't3', environmentId, t3ProjectId: nativeProjectId,
      threadId: nativeThreadId, providerInstanceId: id(native.modelSelection.instanceId) };
    return this.store.saveVerifiedTask(ref, native);
  }

  async listTasks(projectId: string): Promise<{ readonly tasks: readonly WorkbenchChannelTaskRead[] }> {
    if (!await this.projects.get(id(projectId))) throw new ManagementError('not_found', '没有找到所选项目。');
    const rows = this.store.listTasks(projectId);
    if (!rows.some(row => row.task.origin === 't3')) return { tasks: rows };
    let current: Awaited<ReturnType<WorkbenchService['snapshot']>>;
    try { current = await this.snapshot(); }
    catch { return { tasks: rows.map(row => row.task.origin === 't3' ? { task: row.task, projection: null } : row) }; }
    // One shell read per list. A failed exact read never presents a cached terminal as current.
    const tasks = await Promise.all(rows.map(async row => {
      if (row.task.origin !== 't3') return row;
      try { return await this.readTaskState(row.task.id, current); }
      catch { return { task: row.task, projection: null }; }
    }));
    return { tasks };
  }

  private webProfile(cookieHeader: string | undefined, create: boolean): { readonly profileId: string; readonly setCookie?: string } {
    const name = 'aaaagent_wb_web_v1';
    const values = (cookieHeader ?? '').slice(0, 8192).split(';').map(part => part.trim())
      .filter(part => part.startsWith(name + '=')).map(part => part.slice(name.length + 1));
    const candidate = values.length === 1 ? values[0] : undefined;
    if (candidate && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(candidate) &&
        this.store.hasWebFocusProfile(candidate)) return { profileId: candidate };
    if (!create) throw new ManagementError('version_conflict', '浏览器焦点身份待核对，请刷新本项目。');
    const profileId = this.store.createWebFocusProfile();
    return { profileId, setCookie: `${name}=${profileId}; HttpOnly; SameSite=Strict; Path=/api/workbench; Max-Age=31536000` };
  }

  /** The browser profile is issued by the service and scoped to the workbench routes. */
  private webSession(cookieHeader: string | undefined): string {
    return this.webProfile(cookieHeader, false).profileId;
  }

  /** A web draft may target only the exact task saved in this browser's project focus. */
  async prepareWebContinuation(projectId: string, taskId: string, expectedFocusRevision: number,
    cookieHeader: string | undefined, messageId: string, rawText: string, dispatchText: string) {
    const selectedProject = id(projectId), selectedTask = id(taskId);
    if (!Number.isSafeInteger(expectedFocusRevision) || expectedFocusRevision < 0) {
      throw new ManagementError('invalid_request', '任务选择版本无效。');
    }
    const session = this.webSession(cookieHeader);
    const focus = this.store.getWebFocus(session, selectedProject);
    if (focus.revision !== expectedFocusRevision || focus.taskId !== selectedTask) {
      throw new ManagementError('version_conflict', '本页所选任务已变化，请重新核对。');
    }
    const input: WorkbenchInput = { inputId: id(messageId),
      origin: { channel: 'web', channelSessionId: session, messageId: id(messageId) },
      rawText, dispatchText, createdAt: new Date().toISOString() };
    return this.prepareContinuation(selectedTask, input);
  }

  reviseWebContinuation(draftId: string, expectedVersion: number, cookieHeader: string | undefined,
    dispatchText: string) {
    return this.reviseContinuation(draftId, expectedVersion, 'web', this.webSession(cookieHeader), dispatchText);
  }

  dismissWebContinuation(draftId: string, expectedVersion: number, cookieHeader: string | undefined) {
    return this.dismissContinuation(draftId, expectedVersion, 'web', this.webSession(cookieHeader));
  }

  confirmWebContinuation(draftId: string, expectedVersion: number, cookieHeader: string | undefined) {
    return this.confirmContinuation(draftId, expectedVersion, 'web', this.webSession(cookieHeader));
  }

  readWebContinuation(draftId: string, cookieHeader: string | undefined) {
    return this.readContinuation(draftId, 'web', this.webSession(cookieHeader));
  }

  readWebContinuationDraft(draftId: string, cookieHeader: string | undefined) {
    return this.readContinuationDraft(draftId, 'web', this.webSession(cookieHeader));
  }

  /** Discover cards after a port change or lost prepare reply using the durable browser profile. */
  async listWebContinuationDrafts(projectId: string, cookieHeader: string | undefined) {
    const session = this.webSession(cookieHeader);
    const focus = (await this.readWebFocus(projectId, cookieHeader)).focus;
    if (!focus.task) return { version: '0.1.0', projectId: focus.projectId, taskId: null,
      focusRevision: focus.revision, drafts: [], truncated: false } as const;
    const cards = this.store.listContinuations('web', session, focus.projectId, focus.task.id);
    return { version: '0.1.0', projectId: focus.projectId, taskId: focus.task.id,
      focusRevision: focus.revision, ...cards } as const;
  }

  /** A server-issued browser profile survives loopback port changes; the cookie never authorizes a request. */
  async readWebFocus(projectId: string, cookieHeader: string | undefined):
    Promise<{ readonly focus: WorkbenchWebFocus; readonly setCookie?: string }> {
    const selectedProject = id(projectId);
    if (!await this.projects.get(selectedProject)) throw new ManagementError('not_found', '没有找到所选项目。');
    const profile = this.webProfile(cookieHeader, true);
    const current = this.store.getWebFocus(profile.profileId, selectedProject);
    let task: WorkbenchTaskRef | null = null;
    let revision = current.revision;
    if (current.taskId) {
      const saved = this.store.getTask(current.taskId);
      if (!saved || saved.task.projectId !== selectedProject || saved.task.origin !== 't3') {
        revision = this.store.putWebFocus(profile.profileId, selectedProject, null, revision).revision;
      } else {
        try { await this.detail(selectedProject, current.taskId); task = saved.task; }
        catch (error) {
          if (!(error instanceof ManagementError) || !['not_found', 'version_conflict'].includes(error.code)) throw error;
          revision = this.store.putWebFocus(profile.profileId, selectedProject, null, revision).revision;
        }
      }
    }
    return { focus: { version: '0.1.0', projectId: selectedProject, revision, task },
      ...(profile.setCookie ? { setCookie: profile.setCookie } : {}) };
  }

  async saveWebFocus(projectId: string, cookieHeader: string | undefined, taskId: string | null,
    expectedRevision: number): Promise<WorkbenchWebFocus> {
    const selectedProject = id(projectId);
    if (!await this.projects.get(selectedProject)) throw new ManagementError('not_found', '没有找到所选项目。');
    const profile = this.webProfile(cookieHeader, false);
    const selectedTask = taskId === null ? null : id(taskId);
    if (selectedTask) await this.detail(selectedProject, selectedTask);
    const saved = this.store.putWebFocus(profile.profileId, selectedProject, selectedTask, expectedRevision);
    return { version: '0.1.0', projectId: selectedProject, revision: saved.revision,
      task: saved.taskId ? this.store.getTask(saved.taskId)!.task : null };
  }

  async readDesktopFocus(): Promise<WorkbenchDesktopFocus> {
    const current = this.store.getDesktopFocus();
    if (!current.projectId) return { version: '0.1.0', revision: current.revision,
      projectId: null, task: null };
    if (!await this.projects.get(current.projectId)) {
      const cleared = this.store.putDesktopFocus(null, null, current.revision);
      return { version: '0.1.0', revision: cleared.revision, projectId: null, task: null };
    }
    let task: WorkbenchTaskRef | null = null;
    if (current.taskId) {
      try { task = (await this.detail(current.projectId, current.taskId)).task; }
      catch (error) {
        if (!(error instanceof ManagementError) || !['not_found', 'version_conflict'].includes(error.code)) throw error;
        const cleared = this.store.putDesktopFocus(current.projectId, null, current.revision);
        return { version: '0.1.0', revision: cleared.revision, projectId: current.projectId, task: null };
      }
    }
    return { version: '0.1.0', revision: current.revision, projectId: current.projectId, task };
  }

  /** Routing hint only; the selected task must still pass readDesktopFocus before a draft is saved. */
  desktopFocusSnapshot() { return this.store.getDesktopFocus(); }

  async saveDesktopFocus(projectId: string | null, taskId: string | null,
    expectedRevision: number): Promise<WorkbenchDesktopFocus> {
    const selectedProject = projectId === null ? null : id(projectId);
    if (selectedProject && !await this.projects.get(selectedProject)) {
      throw new ManagementError('not_found', '没有找到所选项目。');
    }
    if (taskId && !selectedProject) throw new ManagementError('invalid_request', '请先选择项目。');
    if (taskId && selectedProject) await this.detail(selectedProject, id(taskId));
    const saved = this.store.putDesktopFocus(selectedProject, taskId, expectedRevision);
    return { version: '0.1.0', revision: saved.revision, projectId: saved.projectId,
      task: saved.taskId ? this.store.getTask(saved.taskId)!.task : null };
  }

  async listDesktopContinuationDrafts() {
    const focus = await this.readDesktopFocus();
    if (!focus.projectId || !focus.task) return { focus, drafts: [], truncated: false } as const;
    return { focus, ...this.store.listContinuations('desktop', DESKTOP_WORKBENCH_SESSION,
      focus.projectId, focus.task.id) } as const;
  }

  async prepareDesktopContinuation(projectId: string, taskId: string, expectedFocusRevision: number,
    input: WorkbenchInput, assertCurrent: () => void = () => {}) {
    if (input.origin.channel !== 'desktop' || input.origin.channelSessionId !== DESKTOP_WORKBENCH_SESSION) {
      throw new ManagementError('invalid_request', '桌宠输入来源无效。');
    }
    const focus = await this.readDesktopFocus();
    if (focus.revision !== expectedFocusRevision || focus.projectId !== projectId ||
        focus.task?.id !== taskId) throw new ManagementError('version_conflict', '桌宠任务焦点已变化。');
    assertCurrent();
    return this.store.prepareContinuation(focus.task as Extract<WorkbenchTaskRef, { origin: 't3' }>, input);
  }

  async confirmDesktopContinuation(draftId: string, expectedVersion: number,
    inputGuard?: { readonly focusRevision: number; readonly assertCurrent: () => void }) {
    const draft = this.store.getContinuation(draftId, 'desktop', DESKTOP_WORKBENCH_SESSION);
    const focus = await this.readDesktopFocus();
    if (!focus.task || JSON.stringify(focus.task) !== JSON.stringify(draft.task)) {
      throw new ManagementError('version_conflict', '桌宠任务焦点已变化，请重新核对原任务。');
    }
    const guard = () => {
      inputGuard?.assertCurrent();
      const current = this.store.getDesktopFocus();
      if (current.revision !== (inputGuard?.focusRevision ?? focus.revision) || current.projectId !== draft.task.projectId ||
          current.taskId !== draft.task.id) throw new ManagementError('version_conflict', '桌宠输入时的任务焦点已变化。');
    };
    guard();
    let confirmedAdmission: ConfirmedDesktopAdmission | undefined;
    if (draft.state === 'open' && draft.version === expectedVersion) {
      const current = await this.detail(draft.task.projectId, draft.task.id); guard();
      const native = objectValue(objectValue(current.native)?.thread);
      if (this.turnAuthorization && !this.turnAuthorization.allows(draft, native)) {
        const profile = this.firstDesktopCoordinator(draft.task, native);
        if (profile) {
          const frozenProfile = JSON.stringify(profile);
          const proof = (candidate: WorkbenchContinuationDraft, thread: unknown) => {
            const value = objectValue(thread);
            return JSON.stringify([candidate, value && { id: value.id, projectId: value.projectId,
              worktreePath: value.worktreePath ?? null, branch: value.branch ?? null,
              modelSelection: value.modelSelection, runtimeMode: value.runtimeMode, interactionMode: value.interactionMode,
              latestTurn: value.latestTurn }]);
          };
          const frozen = proof(draft, native), fingerprint = createHash('sha256').update(frozenProfile + frozen).digest('hex');
          this.store.claimDesktopFirstTurnAdmission(profile.operationId, fingerprint,
            { version: 1, kind: 'confirmed-first-desktop-codex', authorization: profile.confirmedFirstTurn,
              profile, draftId: draft.id, draftVersion: draft.version, commandId: draft.commandId, fingerprint });
          confirmedAdmission = Object.assign((candidate: WorkbenchContinuationDraft, thread: unknown) => {
            guard();
            return candidate.input.origin.channel === 'desktop' && candidate.input.origin.channelSessionId === DESKTOP_WORKBENCH_SESSION &&
              JSON.stringify(this.desktopCoordinatorProfile?.(candidate.task.projectId)) === frozenProfile &&
              !!this.firstDesktopCoordinator(candidate.task, thread) && proof(candidate, thread) === frozen;
          }, { modelSelection: structuredClone(native?.modelSelection) });
        }
      }
    }
    return this.confirmContinuation(draftId, expectedVersion, 'desktop', DESKTOP_WORKBENCH_SESSION, guard, confirmedAdmission);
  }

  /** An explicit host choice authorizes only the untouched original Codex coordinator's first user-confirmed turn. */
  private firstDesktopCoordinator(task: Extract<WorkbenchTaskRef, { origin: 't3' }>, native: unknown): DesktopCoordinatorProfile | undefined {
    const profile = this.desktopCoordinatorProfile?.(task.projectId), thread = objectValue(native), model = objectValue(thread?.modelSelection);
    const options = Array.isArray(model?.options) ? model.options : [];
    const auth = profile?.confirmedFirstTurn, session = objectValue(thread?.session);
    if (!profile || !auth || auth.authType !== 'chatgpt' || auth.maxTurns !== 1 || auth.automaticRetries !== 0 ||
        !auth.authorizationId || profile.projectId !== task.projectId || task.provider !== 'codex' ||
        (profile.existingTaskId ? profile.existingTaskId !== task.id :
          this.store.getNativeCreate(profile.operationId)?.threadId !== task.threadId) ||
        this.store.getProjectBinding(task.projectId, task.environmentId, task.t3ProjectId)?.workspaceRoot !== profile.workspaceRoot ||
        thread?.id !== task.threadId || thread.projectId !== task.t3ProjectId || thread.deletedAt != null || thread.archivedAt != null ||
        (thread.worktreePath ?? profile.workspaceRoot) !== profile.workspaceRoot || thread.latestTurn !== null ||
        profile.independentGroup && (thread.branch ?? null) !== profile.independentGroup.coordinatorBranch ||
        session?.activeTurnId || session && !['ready', 'stopped', 'error'].includes(String(session.status)) ||
        thread.runtimeMode !== 'approval-required' || thread.interactionMode !== 'default' ||
        model?.instanceId !== 'codex' || model.model !== profile.modelSelection.model ||
        options.length !== 1 || options.filter(o => objectValue(o)?.id === 'reasoningEffort').length !== 1 ||
        !options.some(o => objectValue(o)?.id === 'reasoningEffort' && objectValue(o)?.value === profile.modelSelection.reasoningEffort)) return;
    return profile;
  }

  appendDesktopContinuationInput(draftId: string, expectedVersion: number, input: WorkbenchInput,
    dispatchText?: string, question?: string) {
    if (input.origin.channel !== 'desktop' || input.origin.channelSessionId !== DESKTOP_WORKBENCH_SESSION) {
      throw new ManagementError('invalid_request', '桌宠输入来源无效。');
    }
    return this.store.appendContinuationInput(draftId, expectedVersion, input, dispatchText, question);
  }

  /** Metadata only; the caller supplies the existing host-owned profile, never a model-planned identity. */
  async ensureDesktopCoordinator(profile: DesktopCoordinatorProfile, input: WorkbenchInput,
    selected: { readonly revision: number; readonly projectId: string | null; readonly taskId: string | null },
    assertCurrent: () => void) {
    const project = await this.projects.get(id(profile.projectId));
    if (!project || project.detailRef.rootPath !== profile.workspaceRoot || selected.taskId ||
        selected.projectId !== null && selected.projectId !== profile.projectId ||
        profile.modelSelection.instanceId !== 'codex' || !profile.modelSelection.reasoningEffort) {
      throw new ManagementError('version_conflict', '协调创建的原项目或明确配置已变化。');
    }
    const guard = () => {
      assertCurrent();
      const current = this.store.getDesktopFocus();
      if (current.revision !== selected.revision || current.projectId !== selected.projectId || current.taskId !== selected.taskId) {
        throw new ManagementError('version_conflict', '创建前的桌宠焦点已变化。');
      }
    };
    guard(); input = this.store.recordDesktopCoordinatorInput(input, profile, selected);
    input = this.store.originalDesktopCoordinatorInput(profile.operationId) ?? input;
    let task: WorkbenchTaskRef | undefined;
    if (profile.existingTaskId) {
      const detail = await this.detail(profile.projectId, profile.existingTaskId);
      const native = objectValue(objectValue(detail.native)?.thread);
      const selection = objectValue(native?.modelSelection);
      const options = Array.isArray(selection?.options) ? selection.options : [];
      if (detail.task.origin !== 't3' || detail.task.provider !== 'codex' || selection?.instanceId !== 'codex' ||
          selection.model !== profile.modelSelection.model || !options.some(o => objectValue(o)?.id === 'reasoningEffort' &&
            objectValue(o)?.value === profile.modelSelection.reasoningEffort) || native?.runtimeMode !== 'approval-required') {
        throw new ManagementError('version_conflict', '已有协调对话的模型、推理或权限与固定配置不同。');
      }
      task = detail.task;
    } else {
      const created = await this.createNativeTask({ operationId: profile.operationId, projectId: profile.projectId,
        title: profile.title, provider: 'codex', modelSelection: profile.modelSelection });
      if (created.state !== 'accepted' || !created.task) return created;
      task = created.task;
    }
    guard();
    const focus = await this.saveDesktopFocus(profile.projectId, task.id, selected.revision);
    assertCurrent();
    const draft = await this.prepareDesktopContinuation(profile.projectId, task.id, focus.revision, input, assertCurrent);
    return { state: 'accepted' as const, task, draft };
  }

  async listProjectBindings(projectId: string) {
    if (!await this.projects.get(id(projectId))) throw new ManagementError('not_found', '没有找到所选项目。');
    return { bindings: this.store.listProjectBindings(projectId) };
  }

  /** Link only explicit original independent members. A mode/grant absence creates no board or turn. */
  async ensureDesktopIndependentGroup(profile: DesktopCoordinatorProfile, coordinatorId: string,
    assertCurrent: () => void = () => {}): Promise<DesktopIndependentGroupState | undefined> {
    const group = profile.independentGroup;
    if (!group) return;
    const digest = (value: unknown): string => {
      const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) :
        v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .map(([k, item]) => [k, canonical(item)])) : v;
      return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
    };
    const state = (stage: DesktopIndependentGroupState['stage']): DesktopIndependentGroupState => ({ operationId: group.operationId, stage });
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(group.operationId) ||
        group.members.length !== 2 || new Set(group.members.map(m => m.actorId)).size !== 2 ||
        group.members.some(m => !['A', 'B'].includes(m.actorId)) ||
        new Set([coordinatorId, ...group.members.map(m => m.taskId)]).size !== 3) {
      throw new ManagementError('invalid_request', '独立组须为三个准确且不同的原C/A/B任务。');
    }
    const coordinator = this.boundTask(coordinatorId, profile.projectId).ref;
    if (profile.existingTaskId ? profile.existingTaskId !== coordinatorId :
        this.store.getNativeCreate(profile.operationId)?.threadId !== coordinator.threadId) return state('unavailable');
    if (coordinator.provider !== 'codex') throw new ManagementError('version_conflict', '独立协调来源不符。');
    const { environmentId, snapshot } = await this.snapshot();
    assertCurrent();
    this.verifyProjectLocation(coordinator.projectId, coordinator.environmentId, coordinator.t3ProjectId, snapshot);
    if (environmentId !== coordinator.environmentId ||
        snapshot.projects.find(p => p.id === coordinator.t3ProjectId)?.workspaceRoot !== profile.workspaceRoot) {
      throw new ManagementError('version_conflict', '独立组的原环境或项目目录已变化。');
    }
    const coordinatorThread = objectValue(snapshot.threads.find(t => t.id === coordinator.threadId));
    if ((coordinatorThread?.worktreePath ?? profile.workspaceRoot) !== profile.workspaceRoot ||
        (coordinatorThread?.branch ?? null) !== group.coordinatorBranch || coordinatorThread?.projectId !== coordinator.t3ProjectId) {
      throw new ManagementError('version_conflict', '独立协调的原分支或工作目录已变化。');
    }
    const participants = [{ actorId: 'C', threadId: coordinator.threadId, providerInstanceId: 'codex',
      role: 'coordinator', title: profile.title }];
    for (const member of [...group.members].sort((a, b) => a.actorId.localeCompare(b.actorId))) {
      const ref = this.boundTask(member.taskId, profile.projectId).ref;
      const thread = objectValue(snapshot.threads.find(t => t.id === ref.threadId));
      const model = objectValue(thread?.modelSelection);
      const options = Array.isArray(model?.options) ? model.options : [];
      if (ref.provider !== 'codex' || ref.environmentId !== environmentId || ref.t3ProjectId !== coordinator.t3ProjectId ||
          thread?.projectId !== coordinator.t3ProjectId || thread.worktreePath !== member.workspaceRoot ||
          thread.branch !== member.branch || thread.runtimeMode !== 'auto-accept-edits' || thread.interactionMode !== 'default' ||
          model?.instanceId !== 'codex' || model.model !== member.model ||
          options.filter(o => objectValue(o)?.id === 'reasoningEffort').length !== 1 ||
          !options.some(o => objectValue(o)?.id === 'reasoningEffort' && objectValue(o)?.value === member.reasoningEffort)) {
        throw new ManagementError('version_conflict', '独立执行任务的模型、分支、工作区或权限与登记不同。');
      }
      participants.push({ actorId: member.actorId, threadId: ref.threadId, providerInstanceId: 'codex', role: 'executor', title: member.title });
    }
    const scope = { environmentId, projectId: coordinator.t3ProjectId };
    const membersDigest = digest([scope, coordinator, profile.workspaceRoot, group.coordinatorBranch, group.members]);
    this.store.claimDesktopGroupLink(group.operationId, membersDigest);
    const execution = group.coordinatorExecution, rawGrant = group.dispatchAuthorization;
    if (!execution || !rawGrant) return state('metadata_ready');
    const native = objectValue(snapshot.threads.find(t => t.id === coordinator.threadId));
    const model = objectValue(native?.modelSelection);
    const options = Array.isArray(model?.options) ? model.options : [];
    if (native?.runtimeMode !== execution.runtimeMode || native.interactionMode !== 'default' ||
        model?.model !== execution.model || model.instanceId !== 'codex' ||
        options.filter(o => objectValue(o)?.id === 'reasoningEffort').length !== 1 ||
        !options.some(o => objectValue(o)?.id === 'reasoningEffort' && objectValue(o)?.value === execution.reasoningEffort)) {
      return state('waiting_coordinator_mode');
    }
    const session = objectValue(native.session), turn = objectValue(native.latestTurn);
    if (session?.activeTurnId || session && !['ready', 'stopped', 'error'].includes(String(session.status)) ||
        turn && ['running', 'queued', 'pending', 'inProgress'].includes(String(turn.state ?? turn.status))) return state('waiting_coordinator_idle');
    let grant: { authorizationId: string; maxDispatches: number; expiresAt: string };
    if ('expiresAt' in rawGrant) grant = rawGrant;
    else {
      const confirmation = this.store.desktopFirstTurnConfirmation(profile.operationId), policy = objectValue(confirmation?.policy);
      const originalProfile = objectValue(policy?.profile);
      if (!confirmation || policy?.kind !== 'confirmed-first-desktop-codex' ||
          originalProfile?.operationId !== profile.operationId || originalProfile.projectId !== profile.projectId ||
          originalProfile.workspaceRoot !== profile.workspaceRoot) return state('waiting_first_confirmation');
      if (!Number.isSafeInteger(rawGrant.validityFromFirstConfirmationMs) || rawGrant.validityFromFirstConfirmationMs <= 0) {
        throw new ManagementError('invalid_request', '独立授权须明确真实确认后的有效时长。');
      }
      grant = { authorizationId: rawGrant.authorizationId, maxDispatches: rawGrant.maxDispatches,
        expiresAt: new Date(Date.parse(confirmation.confirmedAt) + rawGrant.validityFromFirstConfirmationMs).toISOString() };
    }
    if (!Number.isSafeInteger(grant.maxDispatches) || grant.maxDispatches < 1 || grant.maxDispatches > 100 ||
        !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) {
      throw new ManagementError('invalid_request', '独立派发须有准确且有效的宿主授权。');
    }
    if (!this.independentGroup?.available()) return state('unavailable');
    assertCurrent();
    const registration = { scope, participants, dispatchAuthorization: grant }, registrationDigest = digest(registration);
    const claim = this.store.claimDesktopGroupLink(group.operationId, membersDigest, registrationDigest);
    if (claim.first) {
      try { await this.independentGroup.register(registration); }
      catch { /* Original registration may have committed. Read only the same original scope below. */ }
    }
    let original: Record<string, unknown> | null = null;
    try { original = objectValue(await this.independentGroup.readRegistration(scope)); }
    catch { /* Partial/unknown never invokes register again. */ }
    assertCurrent();
    const actors = Array.isArray(original?.participants) ? original.participants : [];
    const c = objectValue(actors.find(a => objectValue(a)?.actorId === 'C'));
    const expectedOriginals = new Map(participants.map(p => {
      const thread = objectValue(snapshot.threads.find(t => t.id === p.threadId))!;
      return [p.actorId, { projectRoot: profile.workspaceRoot, workspaceRoot: thread.worktreePath ?? profile.workspaceRoot,
        branch: thread.branch ?? null, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode }];
    }));
    if (original?.registrationDigest !== registrationDigest || !original.boardId || actors.length !== 3 ||
        !participants.every(p => actors.some(a => { const actor = objectValue(a);
          const frozen = objectValue(actor?.original);
          return actor?.actorId === p.actorId && actor.threadId === p.threadId && actor.role === p.role &&
            frozen && digest(Object.fromEntries(Object.keys(expectedOriginals.get(p.actorId)!).map(k => [k, frozen[k]]))) ===
              digest(expectedOriginals.get(p.actorId)); })) ||
        c?.threadId !== coordinator.threadId || typeof c.contextFile !== 'string' || !isAbsolute(c.contextFile) ||
        typeof original.coordinatorClientPath !== 'string' || !isAbsolute(original.coordinatorClientPath)) {
      this.store.settleDesktopGroupLink(group.operationId, 'unknown', null);
      return state('unknown');
    }
    const result: DesktopIndependentGroupState = { operationId: group.operationId, stage: 'registered',
      boardId: id(original.boardId), coordinatorContextFile: c.contextFile, coordinatorClientPath: original.coordinatorClientPath };
    this.store.settleDesktopGroupLink(group.operationId, 'registered', result);
    return result;
  }

  private boundTask(taskId: string, projectId?: string) {
    const value = this.store.getTask(id(taskId));
    if (!value || projectId && value.task.projectId !== projectId) {
      throw new ManagementError('not_found', '没有找到这个项目中的任务。');
    }
    const ref = value.task;
    if (ref.origin !== 't3' || typeof ref.t3ProjectId !== 'string' ||
        !this.store.getProjectBinding(ref.projectId, ref.environmentId, ref.t3ProjectId)) {
      throw new ManagementError('version_conflict', '任务来源绑定待核对，不能打开原生详情。');
    }
    return { ref, projection: value.projection };
  }

  /** Source text and artifactRef never enter the navigation target. */
  sourceTarget(projectId: string, taskId: string, ids: {
    readonly nativeTurnId?: string; readonly nativeEventId?: string; readonly artifactRef?: string } = {}) {
    const { ref } = this.boundTask(taskId, id(projectId));
    return { status: 'verified_task' as const, projectId: ref.projectId, taskId: ref.id,
      environmentId: ref.environmentId, threadId: ref.threadId,
      detailApi: `/api/workbench/task-detail?projectId=${encodeURIComponent(ref.projectId)}&taskId=${encodeURIComponent(ref.id)}`,
      sourceIds: { ...(ids.nativeTurnId ? { nativeTurnId: sourceLabel(ids.nativeTurnId) } : {}),
        ...(ids.nativeEventId ? { nativeEventId: sourceLabel(ids.nativeEventId) } : {}),
        ...(ids.artifactRef ? { artifactRef: sourceLabel(ids.artifactRef) } : {}) },
      sourceIdsVerified: false, preciseTurnJump: false };
  }

  async detail(projectId: string, taskId: string) {
    const { ref } = this.boundTask(taskId, id(projectId));
    const { environmentId, snapshot } = await this.snapshot();
    if (environmentId !== ref.environmentId) throw new ManagementError('version_conflict', '原生环境已变化，任务来源待核对。');
    this.verifyProjectLocation(ref.projectId, ref.environmentId, ref.t3ProjectId, snapshot);
    let native: unknown;
    try { native = await this.t3.threadSnapshot(ref.threadId, 50); }
    catch { throw new ManagementError('unavailable', '原生任务详情暂不可读取。'); }
    const data = native as { thread?: T3ThreadShellRead };
    if (!data?.thread || data.thread.id !== ref.threadId || data.thread.projectId !== ref.t3ProjectId ||
        data.thread.modelSelection?.instanceId !== ref.providerInstanceId) {
      throw new ManagementError('version_conflict', '原生任务身份已变化，请核对来源。');
    }
    return { task: ref, native, preciseTurnJump: false };
  }

  /** The native thread detail is authoritative; a shell pending bit alone never creates an action. */
  async listNativeInteractions(projectId: string, taskId: string) {
    const { task, native } = await this.detail(id(projectId), id(taskId));
    if (task.provider !== 'codex' || task.origin !== 't3') {
      return { status: 'unsupported' as const, task, interactions: [] };
    }
    const read = nativeInteractions(task, native);
    return { status: read.status, task, interactions: read.interactions };
  }

  async respondNativeInteraction(projectId: string, taskId: string, interactionId: string,
    expectedVersion: number, response: WorkbenchInteractionResponse): Promise<WorkbenchInteractionCommandRead> {
    const task = this.boundTask(id(taskId), id(projectId)).ref;
    const selectedId = id(interactionId);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
        !response || response.type !== 'decide_approval' && response.type !== 'answer_question') {
      throw new ManagementError('invalid_request', '原生请求版本或回答无效。');
    }
    const answerDigest = createHash('sha256').update(JSON.stringify([response.type, response])).digest('hex');
    const existing = this.store.interactionLedger.byInteraction(selectedId);
    if (existing) {
      if (existing.task.id !== task.id || existing.task.projectId !== projectId ||
          existing.requestVersion !== expectedVersion || existing.answerDigest !== answerDigest ||
          existing.kind !== (response.type === 'decide_approval' ? 'approval' : 'question')) {
        throw new ManagementError('version_conflict', '原生请求已绑定另一项回答。');
      }
      return this.readNativeInteractionCommand(existing.commandId);
    }
    if (!this.dispatchEnabled || this.turnAuthorization || task.provider !== 'codex') return { command: { commandId: selectedId,
      state: 'unsupported', task, detail: '原生请求派发尚未启用。' }, resolution: 'unknown' };
    const { native } = await this.detail(projectId, taskId);
    const read = nativeInteractions(task, native);
    if (read.status !== 'supported') throw new ManagementError('unavailable', '原生请求来源待核实。');
    const interaction = read.interactions.find(value => value.id === selectedId);
    if (!interaction || interaction.version !== expectedVersion || interaction.state !== 'pending' ||
        !interaction.nativeRequestId) throw new ManagementError('version_conflict', '原生请求已变化，请刷新后核对。');
    // T3 can report a live provider callback with both activity.turnId and activeTurnId null.
    // The stable request ID and current running thread remain the native response target.
    if (interaction.answerLifetime === 'live_only' &&
        (read.session?.status !== 'running' || read.session.threadId !== task.threadId ||
          read.session.providerInstanceId !== undefined &&
            read.session.providerInstanceId !== task.providerInstanceId ||
          interaction.nativeTurnId && typeof read.session.activeTurnId === 'string' &&
            read.session.activeTurnId !== interaction.nativeTurnId)) {
      throw new ManagementError('version_conflict', '原生会话或轮次已变化，不能回答旧请求。');
    }
    const commandId = randomUUID();
    const createdAt = new Date().toISOString();
    let command: Parameters<WorkbenchInteractionGateway['submit']>[1];
    if (response.type === 'decide_approval') {
      if (interaction.kind !== 'approval' || !interaction.choices.some(value => value.id === response.choiceId)) {
        throw new ManagementError('invalid_request', '审批选择不属于当前原生请求。');
      }
      command = { type: 'thread.approval.respond', commandId, threadId: task.threadId,
        requestId: interaction.nativeRequestId,
        decision: response.choiceId as Extract<typeof command, { type: 'thread.approval.respond' }>['decision'], createdAt };
    } else {
      if (interaction.kind !== 'question' || !Array.isArray(response.answers) ||
          response.answers.length !== interaction.questions.length) {
        throw new ManagementError('invalid_request', '提问回答与当前原生请求不符。');
      }
      const answers: Record<string, string | readonly string[]> = {};
      for (const question of interaction.questions) {
        const matches = response.answers.filter(value => value.questionId === question.id);
        if (matches.length !== 1) throw new ManagementError('invalid_request', '提问编号重复或缺失。');
        const answer = matches[0]!;
        if (!Array.isArray(answer.selectedOptionIds) || answer.selectedOptionIds.length > 30 ||
            answer.selectedOptionIds.some((value: unknown) => typeof value !== 'string') ||
            new Set(answer.selectedOptionIds).size !== answer.selectedOptionIds.length) {
          throw new ManagementError('invalid_request', '提问选项无效。');
        }
        const custom = answer.customText;
        if (custom !== undefined && (typeof custom !== 'string' || !custom.trim() ||
            custom.length > 120000 || custom.includes('\0') || !question.allowCustomAnswer ||
            answer.selectedOptionIds.length > 0)) {
          throw new ManagementError('invalid_request', '自定义回答无效。');
        }
        if (custom === undefined && (answer.selectedOptionIds.length === 0 ||
            !question.allowMultiple && answer.selectedOptionIds.length !== 1 ||
            answer.selectedOptionIds.some((value: string) => !question.options?.some(option => option.id === value)))) {
          throw new ManagementError('invalid_request', '提问选项不属于当前原生请求。');
        }
        answers[question.id] = custom ?? (question.allowMultiple ? answer.selectedOptionIds : answer.selectedOptionIds[0]!);
      }
      command = { type: 'thread.user-input.respond', commandId, threadId: task.threadId,
        requestId: interaction.nativeRequestId, answers, createdAt };
    }
    const binding = { interactionId: selectedId, commandId, task, kind: interaction.kind,
      nativeRequestId: interaction.nativeRequestId, requestVersion: interaction.version,
      answerDigest, state: 'claimed' as const };
    const result = await this.interactionGateway.submit(binding, command);
    return { command: result, resolution: 'pending', interaction };
  }

  /** Cold read uses the same immutable command ID; it never replays an answer. */
  async readNativeInteractionCommand(commandId: string): Promise<WorkbenchInteractionCommandRead> {
    const binding = this.store.interactionLedger.byCommand(id(commandId));
    if (!binding) throw new ManagementError('not_found', '没有找到这条原生请求回执。');
    const command = await this.interactionGateway.readback(binding);
    try {
      const { native } = await this.detail(binding.task.projectId, binding.task.id);
      const read = nativeInteractions(binding.task, native);
      if (read.status !== 'supported') return { command, resolution: 'unknown' };
      const interaction = read.interactions.find(value => value.id === binding.interactionId);
      if (interaction) return { command, resolution: 'pending', interaction };
      const terminal = read.activities.find(row => {
        const payload = objectValue(row.payload);
        if (payload?.requestId !== binding.nativeRequestId) return false;
        return row.kind === (binding.kind === 'approval' ? 'approval.resolved' : 'user-input.resolved');
      });
      if (terminal) return { command, resolution: 'answered' };
      const expired = read.activities.find(row => {
        const payload = objectValue(row.payload);
        const detail = typeof payload?.detail === 'string' ? payload.detail.toLowerCase() : '';
        return payload?.requestId === binding.nativeRequestId &&
          row.kind === (binding.kind === 'approval' ? 'provider.approval.respond.failed' : 'provider.user-input.respond.failed') &&
          (detail.includes('stale pending') || detail.includes('unknown pending'));
      });
      return { command, resolution: expired ? 'expired' : 'unknown' };
    } catch { return { command, resolution: 'unknown' }; }
  }

  /** Recover the original server command after a lost POST reply, without submitting an answer again. */
  async listNativeInteractionBindings(projectId: string, taskId: string) {
    const task = this.boundTask(id(taskId), id(projectId)).ref;
    if (task.provider !== 'codex' || task.origin !== 't3') {
      return { status: 'unsupported' as const, task, bindings: [] };
    }
    const bindings = this.store.interactionLedger.listByTask(projectId, taskId).map(binding => ({
      interactionId: binding.interactionId, commandId: binding.commandId,
      kind: binding.kind, requestVersion: binding.requestVersion,
    }));
    return { status: 'supported' as const, task, bindings };
  }

  async readNativeInteractionCommandForTask(projectId: string, taskId: string,
    interactionId: string): Promise<WorkbenchInteractionCommandRead> {
    const task = this.boundTask(id(taskId), id(projectId)).ref;
    const binding = this.store.interactionLedger.byInteraction(id(interactionId));
    if (!binding || binding.task.id !== task.id || binding.task.projectId !== task.projectId) {
      throw new ManagementError('not_found', '没有找到这条原生请求回执。');
    }
    return this.readNativeInteractionCommand(binding.commandId);
  }

  /** Distinct from terminal-event extraction: this reads the selected task's recent conversation. */
  async readRecentProjectTurns(projectId: string, taskId: string) {
    const { task, native } = await this.detail(projectId, taskId);
    return normalizeProjectRecentTurns(task, native);
  }

  /** A pre-dispatch input seam. A provider adapter must still verify its real prompt budget. */
  async prepareProjectContext(projectId: string, taskId: string,
    current: { readonly messageId: string; readonly text: string },
    budget: ProjectProviderInputBudget) {
    if (!this.projectContext) throw new ManagementError('unavailable', '项目上下文装配尚未接入。');
    if (!current || !id(current.messageId) || typeof current.text !== 'string' ||
        !current.text.trim() || current.text.length > 120000 || current.text.includes('\0')) {
      throw new ManagementError('invalid_request', '当前任务原文无效。');
    }
    const task = this.boundTask(taskId, projectId).ref;
    validateProjectProviderBudget(budget, task.providerInstanceId);
    const recent = await this.readRecentProjectTurns(projectId, taskId);
    const available = budget.maxInputUtf8Bytes - budget.fixedOverheadUtf8Bytes;
    if (Buffer.byteLength(current.text) > available) {
      return { status: 'over_budget' as const, reason: 'current_input' as const,
        projectId: task.projectId, taskId: task.id, currentMessageId: current.messageId };
    }
    const newest = recent.turns.at(-1);
    if (newest && Buffer.byteLength(current.text) + newest.messages.reduce((sum, message) =>
        sum + Buffer.byteLength(message.text), 0) > available) {
      return { status: 'over_budget' as const, reason: 'newest_complete_turn' as const,
        projectId: task.projectId, taskId: task.id, currentMessageId: current.messageId };
    }
    const context = await this.projectContext.assemble({ projectId: task.projectId, taskId: task.id,
      task: task as Extract<WorkbenchTaskRef, { origin: 't3' }>, current, recent, budget,
      ...(recent.branchRef ? { branchRef: recent.branchRef } : {}) });
    if (context.projectId !== task.projectId || context.taskId !== task.id ||
        context.currentMessageId !== current.messageId) {
      throw new ManagementError('version_conflict', '项目上下文身份已变化。');
    }
    if (context.status === 'ready') {
      const offset = recent.turns.length - context.recentTurns.length;
      if (offset < 0 || recent.turns.length > 0 && context.recentTurns.length === 0 ||
          context.hasOlderNativeHistory !== recent.hasOlder ||
          context.omittedOlderTurns !== offset || context.recentTurns.some((turn, index) =>
          JSON.stringify(turn) !== JSON.stringify(recent.turns[offset + index])) ||
          context.memories.some(item => item.projectId !== task.projectId || item.status !== 'accepted' ||
            item.branchRef !== undefined && item.branchRef !== recent.branchRef) ||
          !Number.isSafeInteger(context.usedUtf8Bytes) || context.usedUtf8Bytes < 0 ||
          context.usedUtf8Bytes > budget.maxInputUtf8Bytes ||
          !Number.isSafeInteger(context.omittedOlderTurns) || context.omittedOlderTurns < 0 ||
          !Number.isSafeInteger(context.omittedMemories) || context.omittedMemories < 0) {
        throw new ManagementError('version_conflict', '项目上下文来源或预算已变化。');
      }
      const actualTextBytes = Buffer.byteLength(current.text) +
        context.recentTurns.reduce((sum, turn) => sum + turn.messages.reduce((n, message) =>
          n + Buffer.byteLength(message.text), 0), 0) +
        context.memories.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
      if (actualTextBytes > context.usedUtf8Bytes) {
        throw new ManagementError('version_conflict', '项目上下文预算计量不足。');
      }
      const latest = await this.readRecentProjectTurns(projectId, taskId);
      if (latest.snapshotSequence !== recent.snapshotSequence ||
          latest.environmentId !== recent.environmentId || latest.threadId !== recent.threadId ||
          latest.branchRef !== recent.branchRef) {
        throw new ManagementError('version_conflict', '原生任务在上下文装配期间已变化。');
      }
    }
    return context;
  }

  private async readTaskState(taskId: string,
    current: Awaited<ReturnType<WorkbenchService['snapshot']>>): Promise<WorkbenchChannelTaskRead & {
      readonly projection: NonNullable<WorkbenchChannelTaskRead['projection']> }> {
    const { ref } = this.boundTask(taskId);
    const { environmentId, snapshot } = current;
    if (environmentId !== ref.environmentId) throw new ManagementError('version_conflict', '原生环境已变化，任务状态待核对。');
    this.verifyProjectLocation(ref.projectId, ref.environmentId, ref.t3ProjectId, snapshot);
    const native = snapshot.threads.find(item => item.id === ref.threadId);
    if (!native) throw new ManagementError('unavailable', '原生任务暂未出现在列表，状态待核对。');
    let event;
    try { event = t3ShellToTaskEvent(ref, native, snapshot.snapshotSequence, snapshot.updatedAt); }
    catch { throw new ManagementError('version_conflict', '原生任务身份已变化，状态待核对。'); }
    const projection = this.store.recordEvent(event);
    if (projection.nativeTurnId !== event.nativeTurnId || projection.phase !== event.phase) {
      throw new ManagementError('version_conflict', '原生轮次状态已变化，请重新核对。');
    }
    let resultPreview: WorkbenchChannelTaskRead['resultPreview'];
    if (projection.phase === 'completed' && native.latestTurn?.assistantMessageId) {
      try {
        const detail = await this.t3.threadSnapshot(ref.threadId, 1) as {
          snapshotSequence?: number; thread?: T3ThreadShellRead & { messages?: readonly {
            id?: string; role?: string; turnId?: string; streaming?: boolean; text?: string }[] } };
        const thread = detail?.thread, turn = thread?.latestTurn;
        if (thread?.id !== ref.threadId || thread.projectId !== ref.t3ProjectId ||
            thread.modelSelection?.instanceId !== ref.providerInstanceId ||
            !Number.isSafeInteger(detail.snapshotSequence) || detail.snapshotSequence! < snapshot.snapshotSequence ||
            !turn || turn.turnId !== projection.nativeTurnId || turn.state !== 'completed' ||
            turn.completedAt !== native.latestTurn.completedAt ||
            turn.assistantMessageId !== native.latestTurn.assistantMessageId) {
          throw new ManagementError('version_conflict', '原生轮次已变化，结果待核对。');
        }
        const matches = Array.isArray(thread.messages) ? thread.messages.filter(message =>
          message?.id === turn.assistantMessageId && message.role === 'assistant' &&
          message.turnId === turn.turnId && message.streaming === false && typeof message.text === 'string') : [];
        if (matches.length === 1 && matches[0]!.text!.trim()) {
          const text = matches[0]!.text!.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').trim();
          const chars = [...text];
          resultPreview = { nativeTurnId: turn.turnId, messageId: turn.assistantMessageId!,
            text: chars.slice(0, 320).join(''), truncated: chars.length > 320 };
        }
      } catch (error) {
        if (error instanceof ManagementError) throw error;
        // A missing message window does not invalidate a verified shell status.
      }
    }
    return { task: ref, projection, ...(resultPreview ? { resultPreview } : {}) };
  }

  async refreshTask(taskId: string) {
    const result = await this.readTaskState(taskId, await this.snapshot());
    // Keep the existing durable terminal handoff; it cannot dispatch a native turn.
    if (result.projection.phase === 'completed' || result.projection.phase === 'failed' ||
        result.projection.phase === 'cancelled') {
      if (this.projectMemory) setImmediate(() => { void this.recoverTerminalDelivery().catch(() => undefined); }).unref();
    }
    return result;
  }

  /** B54 0.1.11: no tool bodies and no channel delivery state cross this public read. */
  async readTaskEventPage(taskId: string, afterSequence: number, limit = 100): Promise<WorkbenchTaskEventPage> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ManagementError('invalid_request', '任务事件游标或页大小无效。');
    }
    const { ref } = this.boundTask(taskId);
    if (!this.t3.threadEventPage) return { status: 'unsupported', task: ref, afterSequence,
      headSequence: afterSequence, nextSequence: afterSequence, hasMore: false, resetRequired: false, events: [] };
    const verify = async () => {
      const { environmentId, snapshot } = await this.snapshot();
      if (environmentId !== ref.environmentId) throw new ManagementError('version_conflict', '原生环境已变化，不能读取任务事件。');
      this.verifyProjectLocation(ref.projectId, ref.environmentId, ref.t3ProjectId, snapshot);
      const native = snapshot.threads.find(item => item.id === ref.threadId);
      if (!native || native.projectId !== ref.t3ProjectId ||
          native.modelSelection.instanceId !== ref.providerInstanceId) {
        throw new ManagementError('version_conflict', '原生任务身份已变化，不能读取任务事件。');
      }
    };
    await verify();
    let raw: unknown;
    try { raw = await this.t3.threadEventPage(ref.threadId, afterSequence, limit); }
    catch { throw new ManagementError('unavailable', '原生任务事件页暂不可读取。'); }
    await verify();
    const page = objectValue(raw);
    const seq = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
    if (!page || page.threadId !== ref.threadId || page.afterSequence !== afterSequence ||
        !seq(page.headSequence) || !seq(page.nextSequence) || (page.nextSequence as number) > (page.headSequence as number) ||
        typeof page.hasMore !== 'boolean' || typeof page.resetRequired !== 'boolean' ||
        !Array.isArray(page.events) || page.events.length > limit) {
      throw new ManagementError('unavailable', '原生任务事件页格式待核。');
    }
    const resetReason = page.resetReason;
    if (page.resetRequired ? page.events.length > 0 || page.hasMore || page.nextSequence !== page.headSequence ||
          !['cursor_ahead', 'gap_too_large', 'payload_too_large'].includes(resetReason as string)
        : resetReason !== undefined || (page.headSequence as number) < afterSequence ||
          (page.nextSequence as number) < afterSequence || page.hasMore &&
          (page.events.length !== limit || page.nextSequence === page.headSequence)) {
      throw new ManagementError('unavailable', '原生任务事件断点待核。');
    }
    let previous = afterSequence;
    const ids = new Set<string>();
    const events: WorkbenchNativeEventMeta[] = [];
    for (const item of page.events) {
      const event = objectValue(item);
      if (!event || !seq(event.sequence) || (event.sequence as number) <= previous ||
          (event.sequence as number) > (page.headSequence as number) ||
          !nativeText(event.eventId, 250) || ids.has(event.eventId as string) ||
          !nativeText(event.type, 250) || typeof event.occurredAt !== 'string' ||
          !Number.isFinite(Date.parse(event.occurredAt)) ||
          ['turnId', 'activityId', 'activityKind', 'sessionStatus'].some(key =>
            event[key] !== undefined && !nativeText(event[key], 250)) ||
          event.activityTone !== undefined && !['info', 'tool', 'approval', 'error'].includes(event.activityTone as string)) {
        throw new ManagementError('unavailable', '原生任务事件身份待核。');
      }
      previous = event.sequence as number;
      ids.add(event.eventId as string);
      events.push({ eventId: event.eventId as string, sequence: previous, occurredAt: event.occurredAt,
        type: event.type as string,
        ...(event.turnId ? { turnId: event.turnId as string } : {}),
        ...(event.activityId ? { activityId: event.activityId as string } : {}),
        ...(event.activityKind ? { activityKind: event.activityKind as string } : {}),
        ...(event.activityTone ? { activityTone: event.activityTone as NonNullable<WorkbenchNativeEventMeta['activityTone']> } : {}),
        ...(event.sessionStatus ? { sessionStatus: event.sessionStatus as string } : {}) });
    }
    if (!page.resetRequired && (page.hasMore && previous !== page.nextSequence ||
        !page.hasMore && page.nextSequence !== page.headSequence)) {
      throw new ManagementError('unavailable', '原生任务事件页连续性待核。');
    }
    return { status: 'supported', task: ref, afterSequence, headSequence: page.headSequence as number,
      nextSequence: page.nextSequence as number, hasMore: page.hasMore, resetRequired: page.resetRequired,
      ...(page.resetRequired ? { resetReason: resetReason as NonNullable<WorkbenchTaskEventPage['resetReason']> } : {}), events };
  }

  scanRecoverableTasks(cursor?: string, limit = 100) {
    return this.store.scanRecoverableTasks(cursor, limit);
  }

  /** Native text is never read from resultRef; a cold read must match the exact durable event. */
  async readTerminalMaterial(evidence: ProjectTerminalEvidence) {
    if (!this.store.hasTerminalEvidence(evidence)) {
      throw new ManagementError('unavailable', '终态来源暂不可核对。');
    }
    const { native } = await this.detail(evidence.projectId, evidence.taskId);
    const ref = this.boundTask(evidence.taskId, evidence.projectId).ref;
    let page: unknown = native;
    let sequence: number | undefined;
    const cursors = new Set<string>();
    for (let count = 0; count < 4; count++) {
      const result = t3TerminalMaterial(ref, evidence, page);
      if (sequence !== undefined && result.snapshotSequence !== sequence) {
        throw new ManagementError('unavailable', '原生轮次分页快照已变化，请稍后重试。');
      }
      sequence = result.snapshotSequence;
      if (result.material) return result.material;
      if (!result.beforeCursor || count === 3 || cursors.has(result.beforeCursor)) break;
      cursors.add(result.beforeCursor);
      try {
        const descriptor = await this.t3.environmentDescriptor();
        if (descriptor.environmentId !== ref.environmentId) {
          throw new ManagementError('version_conflict', '原生环境已变化，轮次正文待核对。');
        }
        page = await this.t3.threadSnapshot(ref.threadId, 50, result.beforeCursor);
      } catch (error) {
        if (error instanceof ManagementError) throw error;
        throw new ManagementError('unavailable', '原生轮次历史页暂不可读取。');
      }
    }
    throw new ManagementError('unavailable', '准确原生轮次不在本次有界历史页中。');
  }

  /** Idempotent cross-database delivery; no project-memory extraction runs without an extractor. */
  recoverTerminalDelivery(): Promise<number> {
    if (!this.projectMemory) return Promise.resolve(0);
    if (this.terminalRecovery) return this.terminalRecovery;
    this.terminalRecovery = (async () => {
      let delivered = 0;
      for (;;) {
        const pending = this.store.pendingTerminalEvidence(PROJECT_TERMINAL_EXTRACTION_VERSION);
        if (!pending.length) break;
        for (const evidence of pending) {
          await this.projectMemory!.enqueueTerminal(evidence);
          this.store.markTerminalDelivered(evidence);
          delivered++;
        }
        if (pending.length < 100) break;
      }
      return delivered;
    })();
    return this.terminalRecovery.finally(() => { this.terminalRecovery = null; });
  }

  /** Channel adapters choose an exact task; the server verifies its native identity before saving raw/reviewed input. */
  async prepareContinuation(taskId: string, input: WorkbenchInput) {
    const { task } = await this.detail(this.boundTask(taskId).ref.projectId, taskId);
    if (task.origin !== 't3') throw new ManagementError('version_conflict', '任务不是已核实的原生任务。');
    return this.store.prepareContinuation(task, input);
  }

  readContinuationDraft(draftId: string, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string) {
    return this.store.getContinuation(draftId, channel, channelSessionId);
  }

  reviseContinuation(draftId: string, expectedVersion: number, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string, dispatchText: string) {
    return this.store.reviseContinuation(draftId, expectedVersion, channel, channelSessionId, dispatchText);
  }

  dismissContinuation(draftId: string, expectedVersion: number, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string) {
    return this.store.dismissContinuation(draftId, expectedVersion, channel, channelSessionId);
  }

  /** No retry after a durable confirmation claim; a crash before dispatch stays unknown until inspected. */
  async confirmContinuation(draftId: string, expectedVersion: number, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string, beforeCommit?: () => void,
    confirmedDesktopAdmission?: ConfirmedDesktopAdmission): Promise<WorkbenchCommandResult> {
    const draft = this.store.getContinuation(draftId, channel, channelSessionId);
    if (draft.version !== expectedVersion) throw new ManagementError('version_conflict', '工作卡版本已变化。');
    if (draft.state === 'dismissed') return { commandId: draft.commandId, state: 'conflict', task: draft.task,
      detail: '这张待确认卡已取消，未发送任务。' };
    if (draft.state === 'claimed') return this.readContinuation(draftId, channel, channelSessionId);
    if (!this.dispatchEnabled) return { commandId: draft.commandId, state: 'unsupported', task: draft.task,
      detail: '原生派发尚未启用。' };
    const current = await this.detail(draft.task.projectId, draft.task.id);
    if (JSON.stringify(current.task) !== JSON.stringify(draft.task)) {
      throw new ManagementError('version_conflict', '原生任务绑定已变化，旧确认不能发送。');
    }
    const modes = nativeTurnModes((current.native as { thread?: unknown }).thread);
    if (!modes) throw new ManagementError('unavailable', '原生任务运行与批准模式未核实，未发送。');
    if (this.turnAuthorization && !this.turnAuthorization.allows(draft, (current.native as { thread?: unknown }).thread) &&
        !(channel === 'desktop' && confirmedDesktopAdmission?.(draft, (current.native as { thread?: unknown }).thread))) {
      throw new ManagementError('unavailable', '当前授权不包含此工作卡或原生任务已变化，未发送。');
    }
    let freeze: ProviderContextFreeze | undefined;
    if (this.providerContext) {
      const native = current.native as { snapshotSequence?: unknown;
        thread?: { modelSelection?: { model?: unknown }; branch?: unknown } };
      const modelId = native.thread?.modelSelection?.model;
      const branchRef = native.thread?.branch;
      if (typeof modelId === 'string' && modelId.trim() &&
          (branchRef === null || typeof branchRef === 'string') &&
          Number.isSafeInteger(native.snapshotSequence) && Number(native.snapshotSequence) >= 0) {
        const binding: ProjectProviderContextBinding = {
          projectId: draft.task.projectId, taskId: draft.task.id,
          environmentId: draft.task.environmentId, threadId: draft.task.threadId,
          providerInstanceId: draft.task.providerInstanceId, modelId, branchRef,
          snapshotSequence: Number(native.snapshotSequence), commandId: draft.commandId,
          draftId: draft.id, draftVersion: draft.version, messageId: draft.input.inputId,
        };
        const prepared = await this.providerContext.prepare({ binding, durableMessageText: draft.input.dispatchText });
        if (prepared.status === 'ready') {
          if (JSON.stringify(prepared.binding) !== JSON.stringify(binding)) {
            throw new ManagementError('version_conflict', '项目上下文与原生任务身份不一致。');
          }
          if (prepared.records.length > 0) freeze = prepared;
        }
      }
    }
    beforeCommit?.();
    const claim = this.store.claimContinuation(draftId, expectedVersion, channel, channelSessionId, freeze);
    if (!claim.newClaim) return this.readContinuation(draftId, channel, channelSessionId);
    const command: WorkbenchCommand = { type: 'continue', commandId: draft.commandId,
      taskId: draft.task.id, input: draft.input };
    try { return await this.submit(command, modes, freeze, draft, beforeCommit, confirmedDesktopAdmission); }
    catch { return { commandId: draft.commandId, state: 'unknown', task: draft.task,
      detail: '发送结果待按原命令核对；不会重新派发。' }; }
  }

  async readContinuation(draftId: string, channel: WorkbenchInputOrigin['channel'],
    channelSessionId: string): Promise<WorkbenchCommandResult> {
    const draft = this.store.getContinuation(draftId, channel, channelSessionId);
    if (draft.state === 'dismissed') return { commandId: draft.commandId, state: 'conflict', task: draft.task,
      detail: '这张待确认卡已取消，未发送任务。' };
    if (draft.state !== 'claimed') return { commandId: draft.commandId, state: 'recorded', task: draft.task,
      detail: '任务仍待用户确认。' };
    const binding = this.store.ledger.get(draft.commandId);
    if (!binding) return { commandId: draft.commandId, state: 'unknown', task: draft.task,
      detail: '确认已记录，原生命令回执待核；不会重新派发。' };
    if (JSON.stringify(binding.task) !== JSON.stringify(draft.task)) {
      return { commandId: draft.commandId, state: 'conflict', task: draft.task,
        detail: '命令回执的任务绑定与原确认不一致。' };
    }
    return this.gateway.readback(binding);
  }

  private async submit(command: WorkbenchCommand, expectedModes: NativeTurnModes,
    freeze?: ProviderContextFreeze, draft?: WorkbenchContinuationDraft, beforeCommit?: () => void,
    confirmedDesktopAdmission?: ConfirmedDesktopAdmission): Promise<WorkbenchCommandResult> {
    if (!this.dispatchEnabled) return { commandId: id(command.commandId), state: 'unsupported', detail: '原生派发尚未启用。' };
    if (command.type !== 'continue') return this.gateway.submit(command);
    const { ref } = this.boundTask(command.taskId);
    if (!command.input.dispatchText.trim() || command.input.dispatchText.length > 120000 ||
        command.input.rawText.length > 120000) throw new ManagementError('invalid_request', '任务内容无效。');
    const { environmentId, snapshot } = await this.snapshot();
    if (environmentId !== ref.environmentId) return { commandId: command.commandId, state: 'unknown', task: ref,
      detail: '原生环境已变化，命令未发送。' };
    try { this.verifyProjectLocation(ref.projectId, ref.environmentId, ref.t3ProjectId, snapshot); }
    catch { return { commandId: command.commandId, state: 'unknown', task: ref,
      detail: '原生项目位置或绑定待核对，命令未发送。' }; }
    const native = snapshot.threads.find(item => item.id === ref.threadId);
    try { if (!native) throw new Error('missing_native_thread');
      t3ShellToTaskEvent(ref, native, snapshot.snapshotSequence, snapshot.updatedAt);
    } catch { return { commandId: command.commandId, state: 'unknown', task: ref,
      detail: '原生线程身份尚未核实，命令未发送。' }; }
    const modes = nativeTurnModes(native);
    if (this.turnAuthorization && (!draft || !this.turnAuthorization.allows(draft, native) &&
        !confirmedDesktopAdmission?.(draft, native))) {
      return { commandId: command.commandId, state: 'unknown', task: ref,
        detail: '当前授权或原生任务已变化，命令未发送；请按原命令核对。' };
    }
    if (!modes || modes.runtimeMode !== expectedModes.runtimeMode ||
        modes.interactionMode !== expectedModes.interactionMode) {
      return { commandId: command.commandId, state: 'unknown', task: ref,
        detail: '原生任务运行或批准模式已变化，命令未发送。' };
    }
    if (freeze && (freeze.binding.snapshotSequence !== snapshot.snapshotSequence ||
        freeze.binding.modelId !== (native.modelSelection as { model?: string }).model ||
        freeze.binding.branchRef !== (native as { branch?: string | null }).branch ||
        freeze.binding.commandId !== command.commandId ||
        freeze.binding.messageId !== command.input.inputId ||
        freeze.binding.threadId !== ref.threadId ||
        freeze.binding.providerInstanceId !== ref.providerInstanceId ||
        freeze.binding.projectId !== ref.projectId ||
        freeze.durableMessageText !== command.input.dispatchText)) {
      return { commandId: command.commandId, state: 'unknown', task: ref,
        detail: '原生任务模型、分支或版本已变化，冻结内容未发送。' };
    }
    let committedFreeze: ProviderContextFreeze | undefined;
    let proof: ProjectProviderContextProof | undefined;
    if (freeze) {
      if (!this.projectContextProofSigner) return { commandId: command.commandId, state: 'unknown', task: ref,
        detail: '项目资料来源证明未配置，命令未发送。' };
      committedFreeze = this.store.readProviderContextFreeze(command.commandId) ?? undefined;
      if (!committedFreeze || committedFreeze.fingerprint !== freeze.fingerprint) {
        return { commandId: command.commandId, state: 'unknown', task: ref,
          detail: '已提交的项目资料冻结不可核实，命令未发送。' };
      }
      proof = await signProviderContextFreeze(committedFreeze, ref.t3ProjectId, this.projectContextProofSigner);
    }
    const prepared: PreparedT3Turn = { task: ref, command: {
      type: 'thread.turn.start', commandId: command.commandId, threadId: ref.threadId,
      message: { messageId: command.input.inputId, role: 'user', text: command.input.dispatchText, attachments: [] },
      runtimeMode: modes.runtimeMode, interactionMode: modes.interactionMode,
      ...(confirmedDesktopAdmission ? { modelSelection: confirmedDesktopAdmission.modelSelection } : {}),
      ...(committedFreeze && proof ? { providerOnlyProjectContext: {
        version: 1, commandId: command.commandId, messageId: command.input.inputId,
        threadId: ref.threadId, t3ProjectId: ref.t3ProjectId,
        providerInstanceId: ref.providerInstanceId, modelId: committedFreeze.binding.modelId,
        branchRef: committedFreeze.binding.branchRef, snapshotSequence: committedFreeze.binding.snapshotSequence,
        draftId: committedFreeze.binding.draftId, draftVersion: committedFreeze.binding.draftVersion,
        fingerprint: committedFreeze.fingerprint, context: { version: 1, records: committedFreeze.records },
        proof,
      } } : {}),
      createdAt: command.input.createdAt,
    } };
    beforeCommit?.();
    return this.gateway.submit(command, prepared);
  }
}
