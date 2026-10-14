import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isPrivateFileSync } from '../core/platform-files.js';
import type { WorkbenchInput } from '../contracts/workbench.js';
import type { WorkbenchNativeBrowserPort } from '../contracts/workbench.js';
import type { ExistingCodexContinuationAuthorization, SingleCodexContinuationAuthorization, SingleDshContinuationAuthorization, WorkbenchTurnAuthorization } from '../contracts/workbench-runtime.js';

function privateText(filename: string, maxBytes: number): string {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!isPrivateFileSync(filename, stat) || stat.size > maxBytes) throw Error('Unsafe policy');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}

/** Read existing unlimited accounting policy. This never changes the shared budget or grants execution. */
export function existingDshBudgetPolicy(projectRoot: string, expected: SingleDshContinuationAuthorization): boolean {
  try {
    const raw = privateText(resolve(projectRoot, '.local/model-evaluation/trial/user-trial/config.json'), 2 * 1024 * 1024);
    if (hash(raw) !== expected.configurationSha256) return false;
    const activation = JSON.parse(privateText(resolve(projectRoot, '.local/model-evaluation/trial/user-trial/activation.json'), 8192)) as
      { status?: unknown; configSha256?: unknown };
    if (activation.status !== 'active' || activation.configSha256 !== expected.configurationSha256) return false;
    const config = JSON.parse(raw) as
      { projectRoot?: unknown; sourceRevision?: unknown; purpose?: unknown; budgetMode?: unknown; budgetBatchId?: unknown; budgetFile?: unknown; limitMicros?: unknown };
    const budgetFile = resolve(projectRoot, '.local/model-evaluation/budget.json');
    const ledger = JSON.parse(privateText(budgetFile, 16 * 1024 * 1024)) as { batchId?: unknown; currency?: unknown; budgetMode?: unknown; limitMicros?: unknown };
    return config.projectRoot === resolve(projectRoot) && config.sourceRevision === expected.sourceRevision &&
      config.purpose === 'user-trial' && config.budgetFile === budgetFile && config.budgetBatchId === expected.budget.batchId &&
      config.budgetMode === 'unlimited' && config.limitMicros === null && ledger.batchId === expected.budget.batchId &&
      ledger.currency === 'CNY' && ledger.budgetMode === 'unlimited' && ledger.limitMicros === null;
  } catch { return false; }
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
export function workbenchInputDigest(input: WorkbenchInput): string {
  return hash(JSON.stringify([input.inputId, input.rawText, input.dispatchText,
    input.origin.channel, input.origin.channelSessionId, input.origin.messageId, input.origin.turnScope ?? null, input.createdAt]));
}

/** Re-read exact private admission when an actual input has produced its reviewed card. */
export function reloadingWorkbenchTurnAuthorization(projectRoot: string): WorkbenchTurnAuthorization {
  return { available: () => readWorkbenchTurnAuthorization(projectRoot)?.available() ?? false,
    allows: (draft, native) => readWorkbenchTurnAuthorization(projectRoot)?.allows(draft, native) ?? false };
}

export interface IsolatedWorkbenchEnvironment {
  readonly version: 1;
  readonly kind: 'isolated-existing-t3';
  readonly environmentId: string;
  readonly nativePid: number;
  readonly hostPid: number;
  readonly browserSessionFile: string;
  readonly options: { readonly sourceDir: string; readonly runtimeSourceDir: string; readonly runtimePatchSha256: string;
    readonly nodeExecutable: string; readonly baseDir: string; readonly logFile: string };
}

/** Explicit private isolated attachment; absence preserves the normal project's own T3 home. */
export function readIsolatedWorkbenchEnvironment(projectRoot: string): IsolatedWorkbenchEnvironment | undefined {
  const filename = resolve(projectRoot, '.local/data/workbench-isolated-environment.json');
  try {
    const value = JSON.parse(privateText(filename, 16384)) as IsolatedWorkbenchEnvironment;
    const absolute = (x: unknown) => typeof x === 'string' && isAbsolute(x) && !/[\u0000-\u001f\u007f]/u.test(x);
    if (value.version !== 1 || value.kind !== 'isolated-existing-t3' || typeof value.environmentId !== 'string' ||
        !value.environmentId.trim() || !Number.isSafeInteger(value.nativePid) || value.nativePid < 2 ||
        !Number.isSafeInteger(value.hostPid) || value.hostPid < 2 || !absolute(value.browserSessionFile) ||
        !value.options || !['sourceDir','runtimeSourceDir','nodeExecutable','baseDir','logFile'].every(k =>
          absolute(value.options[k as keyof typeof value.options])) || !/^[a-f0-9]{64}$/.test(value.options.runtimePatchSha256) ||
        value.options.baseDir === resolve(projectRoot, '.local/data/t3-home')) throw Error('Invalid isolated environment');
    process.kill(value.nativePid, 0); process.kill(value.hostPid, 0);
    const host = JSON.parse(privateText(resolve(value.options.baseDir, '.aaaagent-t3-host.json'), 16384)) as
      { version?: unknown; hostPid?: unknown; sourceDir?: unknown; baseDir?: unknown };
    if (host.version !== 1 || host.hostPid !== value.hostPid || host.sourceDir !== value.options.sourceDir ||
        host.baseDir !== value.options.baseDir) throw Error('Isolated host owner changed');
    return value;
  } catch {
    // An explicitly present but invalid attachment must not create a replacement home.
    try { privateText(filename, 16384); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    }
    throw Error('Explicit isolated workbench attachment is unavailable');
  }
}

function isolatedBrowserSession(environment: IsolatedWorkbenchEnvironment) {
    const session = JSON.parse(privateText(environment.browserSessionFile, 16384)) as { pid?: unknown; origin?: unknown; token?: unknown };
    if (!Number.isSafeInteger(session.pid) || Number(session.pid) < 2 || typeof session.origin !== 'string' ||
        !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(session.origin) || typeof session.token !== 'string' || !/^[a-f0-9]{64}$/.test(session.token)) throw Error('Invalid isolated browser owner');
    process.kill(Number(session.pid), 0);
    if (new URL(session.origin).origin !== session.origin) throw Error('Invalid isolated browser origin');
    return { pid: Number(session.pid), origin: session.origin, token: session.token };
}
/** Public frame origin only; no browser ticket, bearer or upstream request is issued. */
export function isolatedNativeFrameOrigin(environment: IsolatedWorkbenchEnvironment): string | undefined {
  try { return isolatedBrowserSession(environment).origin; } catch { return undefined; }
}

export function isolatedNativeBrowser(environment: IsolatedWorkbenchEnvironment): WorkbenchNativeBrowserPort {
  return { async openBrowser(target, options) {
    if (target.environmentId !== environment.environmentId) throw Error('Isolated environment changed');
    const session = isolatedBrowserSession(environment);
    const response = await fetch(session.origin + '/api/native-mount/open-browser', { method: 'POST',
      headers: { Authorization: 'Bearer ' + session.token, Origin: session.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...target, ...(options?.returnToOriginalManagement ? { originalManagementReturn: true } : {}) }),
      redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error('Isolated browser handoff unavailable');
    const value = await response.json() as Awaited<ReturnType<WorkbenchNativeBrowserPort['openBrowser']>>, url = new URL(value.url);
    if (url.origin !== session.origin || url.pathname !== '/open' || url.search || !/^#[A-Za-z0-9_-]{43}$/.test(url.hash) ||
        !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) throw Error('Invalid isolated browser ticket');
    if (options?.returnToOriginalManagement) {
      const relation = value.originalManagementReturn;
      if (!relation || relation.version !== '0.1.1' || relation.path !== '/' || relation.environmentId !== target.environmentId ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(relation.navigationId) ||
          !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(relation.origin) || relation.origin === session.origin ||
          Object.keys(relation).sort().join(',') !== 'environmentId,navigationId,origin,path,version') throw Error('Invalid original management return');
    } else if (value.originalManagementReturn !== undefined) throw Error('Unexpected original management return');
    return value;
  } };
}

/** Missing, invalid, replaced, expired or revoked authorization leaves native dispatch closed. */
export function readWorkbenchTurnAuthorization(projectRoot: string,
  now: () => number = Date.now): WorkbenchTurnAuthorization | undefined {
  const filename = resolve(projectRoot, '.local/data/workbench-execution.json');
  const read = () => {
    const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!isPrivateFileSync(filename, stat) || stat.size > 8192) throw Error('Unsafe authorization');
      return readFileSync(fd, 'utf8');
    } finally { closeSync(fd); }
  };
  try {
    const raw = read(), value = JSON.parse(raw) as SingleCodexContinuationAuthorization | SingleDshContinuationAuthorization | ExistingCodexContinuationAuthorization;
    const uuid = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
    const dsh = value.kind === 'single-dsh-continuation';
    const existing = value.kind === 'single-codex-existing-thread';
    const originalId = (v: unknown) => typeof v === 'string' && v === v.trim() && v.length > 0 && v.length <= 250 && !/[\u0000-\u001f\u007f]/u.test(v);
    if (value.version !== 1 || !['single-codex-continuation','single-dsh-continuation','single-codex-existing-thread'].includes(value.kind) ||
        !uuid(value.commandId) || !uuid(value.draftId) || !Number.isSafeInteger(value.draftVersion) || value.draftVersion < 1 ||
        !value.task || value.task.origin !== 't3' || value.task.provider !== (dsh ? 'dsh' : 'codex') || value.task.providerInstanceId !== (dsh ? 'dsh' : 'codex') ||
        !['id', 'projectId', 'environmentId', 't3ProjectId', 'threadId'].every(key => (existing ? originalId : uuid)(value.task[key as keyof typeof value.task])) ||
        value.authType !== (dsh ? 'native-deepseek-api' : 'chatgpt') || value.maxTurns !== 1 || value.automaticRetries !== 0 ||
        typeof value.modelId !== 'string' || !value.modelId.trim() || !/^[a-f0-9]{64}$/.test(value.inputSha256) ||
        !Number.isFinite(Date.parse(value.expiresAt))) return undefined;
    if (existing && (!uuid(value.expectedLatestTurnId) || !['approval-required', 'auto-accept-edits'].includes(value.runtimeMode) ||
        value.interactionMode !== 'default' || typeof value.reasoningEffort !== 'string' ||
        !value.reasoningEffort.trim() || value.reasoningEffort.length > 64)) return undefined;
    if (dsh && (value.modelId !== 'deepseek-official/deepseek-flash' || !['off','low','high','max'].includes(value.reasoningEffort) ||
        !/^[a-f0-9]{40}$/.test(value.sourceRevision) || !/^[a-f0-9]{64}$/.test(value.configurationSha256) || !value.budget || value.budget.mode !== 'unlimited' ||
        value.budget.limitMicros !== null || typeof value.budget.batchId !== 'string' || !value.budget.batchId.trim())) return undefined;
    const available = () => { try { return Date.parse(value.expiresAt) > now() && read() === raw &&
      (!dsh || existingDshBudgetPolicy(projectRoot, value)); } catch { return false; } };
    if (!available()) return undefined;
    return { available, allows: (draft, nativeThread) => {
      if (!available() || draft.id !== value.draftId || draft.version !== value.draftVersion ||
          draft.commandId !== value.commandId || !same(draft.task, value.task) ||
          workbenchInputDigest(draft.input) !== value.inputSha256) return false;
      const thread = nativeThread as { id?: unknown; projectId?: unknown; modelSelection?: { instanceId?: unknown; model?: unknown; options?: unknown };
        runtimeMode?: unknown; interactionMode?: unknown; latestTurn?: unknown } | null;
      return !!thread && thread.id === value.task.threadId && thread.projectId === value.task.t3ProjectId &&
        thread.modelSelection?.instanceId === (dsh ? 'dsh' : 'codex') && thread.modelSelection.model === value.modelId &&
        (!dsh || same(thread.modelSelection.options, [{ id: 'reasoningEffort', value: value.reasoningEffort }])) &&
        (existing ? thread.runtimeMode === value.runtimeMode && thread.interactionMode === value.interactionMode &&
          same(thread.modelSelection.options, [{ id: 'reasoningEffort', value: value.reasoningEffort }]) &&
          !!thread.latestTurn && typeof thread.latestTurn === 'object' &&
          (thread.latestTurn as { turnId?: unknown }).turnId === value.expectedLatestTurnId &&
          (thread.latestTurn as { state?: unknown }).state === 'completed' :
          thread.runtimeMode === 'approval-required' && thread.interactionMode === 'default' && thread.latestTurn === null);
    } };
  } catch { return undefined; }
}
