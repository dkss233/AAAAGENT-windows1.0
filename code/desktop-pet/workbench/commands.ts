import { createHash } from 'node:crypto';
import type { WorkbenchCommand, WorkbenchCommandResult, WorkbenchTaskRef } from '../contracts/workbench.js';
import { nativeTaskKey, originalSessionEntry } from './identity.js';

export type DispatchableCommand = Extract<WorkbenchCommand, { readonly type: 'start' | 'continue' }>;
export type BindingState = 'claimed' | 'accepted' | 'rejected' | 'unknown';
export interface CommandBinding {
  readonly commandId: string;
  readonly digest: string;
  readonly task: WorkbenchTaskRef;
  readonly state: BindingState;
  readonly receiptSequence?: number;
}
export interface CommandLedger {
  /** Atomic insert or read. An existing ID with a different digest is a conflict. */
  claim(binding: CommandBinding): 'new' | CommandBinding | 'conflict';
  get(commandId: string): CommandBinding | null;
  settle(commandId: string, state: Exclude<BindingState, 'claimed'>, receiptSequence?: number): void;
}

export interface InteractionBinding {
  readonly interactionId: string;
  readonly commandId: string;
  readonly task: Extract<WorkbenchTaskRef, { readonly origin: 't3' }>;
  readonly kind: 'approval' | 'question';
  readonly nativeRequestId: string;
  readonly requestVersion: number;
  /** Digest of the explicit selection; question answer text is never stored here. */
  readonly answerDigest: string;
  readonly state: BindingState;
  readonly receiptSequence?: number;
}

export interface InteractionLedger {
  claim(value: InteractionBinding): 'new' | InteractionBinding | 'conflict';
  byInteraction(interactionId: string): InteractionBinding | null;
  byCommand(commandId: string): InteractionBinding | null;
  listByTask(projectId: string, taskId: string): readonly InteractionBinding[];
  settle(commandId: string, state: Exclude<BindingState, 'claimed'>, receiptSequence?: number): void;
}

export type NativeInteractionCommand = {
  readonly type: 'thread.approval.respond'; readonly commandId: string; readonly threadId: string;
  readonly requestId: string; readonly decision: 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline' | 'cancel';
  readonly createdAt: string;
} | {
  readonly type: 'thread.user-input.respond'; readonly commandId: string; readonly threadId: string;
  readonly requestId: string; readonly answers: Readonly<Record<string, string | readonly string[]>>;
  readonly createdAt: string;
};

/** Prepared by I after draft/version and project/provider selection are checked. */
export interface PreparedT3Turn {
  readonly task: WorkbenchTaskRef & { readonly origin: 't3' };
  readonly command: {
    readonly type: 'thread.turn.start';
    readonly commandId: string;
    readonly threadId: string;
    readonly message: { readonly messageId: string; readonly role: 'user'; readonly text: string; readonly attachments: readonly unknown[] };
    readonly createdAt: string;
    readonly [key: string]: unknown;
  };
}

export interface T3TurnPort {
  dispatch(command: PreparedT3Turn['command']): Promise<{ readonly sequence: number }>;
  /** Null means absent or unavailable; never infer it means safe to send again. */
  readReceipt?(commandId: string): Promise<null | {
    readonly status: 'accepted' | 'rejected';
    readonly aggregateKind: 'thread' | 'project';
    readonly aggregateId: string;
    readonly resultSequence: number;
  }>;
}

export interface T3InteractionPort {
  dispatch(command: NativeInteractionCommand): Promise<{ readonly sequence: number }>;
  readReceipt?: T3TurnPort['readReceipt'];
}

/** Command receipt is a transport fact; it never asserts that the provider resolved the request. */
export class WorkbenchInteractionGateway {
  constructor(private readonly ledger: InteractionLedger, private readonly t3: T3InteractionPort) {}

  async submit(binding: InteractionBinding, command: NativeInteractionCommand): Promise<WorkbenchCommandResult> {
    if (command.commandId !== binding.commandId || command.threadId !== binding.task.threadId ||
        command.requestId !== binding.nativeRequestId ||
        (binding.kind === 'approval') !== (command.type === 'thread.approval.respond')) {
      return { commandId: binding.commandId, state: 'conflict', task: binding.task };
    }
    const claimed = this.ledger.claim(binding);
    if (claimed === 'conflict') return { commandId: binding.commandId, state: 'conflict', task: binding.task,
      detail: '同一原生请求已绑定另一项选择，不能再次发送。' };
    if (claimed !== 'new') return this.readback(claimed);
    try {
      const receipt = await this.t3.dispatch(command);
      if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 0) throw Error('invalid_t3_receipt');
      this.ledger.settle(binding.commandId, 'accepted', receipt.sequence);
      return { commandId: binding.commandId, state: 'accepted', task: binding.task,
        detail: '原生命令已接收；请求是否解决仍须读取原生状态。' };
    } catch {
      this.ledger.settle(binding.commandId, 'unknown');
      return this.readback(this.ledger.byCommand(binding.commandId) ?? binding);
    }
  }

  async readback(binding: InteractionBinding): Promise<WorkbenchCommandResult> {
    if (binding.state === 'accepted') return { commandId: binding.commandId, state: 'accepted', task: binding.task,
      detail: '原生命令已接收；请求是否解决仍须读取原生状态。' };
    if (binding.state === 'rejected') return { commandId: binding.commandId, state: 'conflict', task: binding.task,
      detail: '原生命令已拒绝。' };
    try {
      const receipt = await this.t3.readReceipt?.(binding.commandId);
      if (receipt && receipt.aggregateKind === 'thread' && receipt.aggregateId === binding.task.threadId) {
        const state = receipt.status === 'accepted' ? 'accepted' : 'rejected';
        this.ledger.settle(binding.commandId, state, receipt.resultSequence);
        return { commandId: binding.commandId, state: state === 'accepted' ? 'accepted' : 'conflict',
          task: binding.task, detail: state === 'accepted' ? '原生命令已接收；请求是否解决仍须读取原生状态。' : '原生命令已拒绝。' };
      }
    } catch { /* A read outage cannot authorize another response. */ }
    return { commandId: binding.commandId, state: 'unknown', task: binding.task,
      detail: '发送回执待按原命令核对；不会再次发送。' };
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

function digest(command: DispatchableCommand, prepared: PreparedT3Turn): string {
  return createHash('sha256').update(JSON.stringify(canonical([
    command, prepared.task.id, prepared.task.projectId, nativeTaskKey(prepared.task), prepared.command,
  ]))).digest('hex');
}

function validatePrepared(command: DispatchableCommand, prepared: PreparedT3Turn): boolean {
  const target = prepared.task;
  if (command.type === 'start' && (command.projectId !== target.projectId || command.provider !== target.provider)) return false;
  if (command.type === 'continue' && command.taskId !== target.id) return false;
  return prepared.command.type === 'thread.turn.start' && prepared.command.commandId === command.commandId &&
    prepared.command.threadId === target.threadId && prepared.command.message.messageId === command.input.inputId &&
    prepared.command.message.role === 'user' && prepared.command.message.text === command.input.dispatchText &&
    prepared.command.message.attachments.length === 0 && prepared.command.createdAt === command.input.createdAt &&
    command.input.dispatchText.trim().length > 0;
}

/** Exactly one local dispatch attempt per command ID. A lost response is read back, never resent. */
export class WorkbenchTurnGateway {
  constructor(private readonly ledger: CommandLedger, private readonly t3: T3TurnPort) {}

  async submit(command: WorkbenchCommand, prepared?: PreparedT3Turn): Promise<WorkbenchCommandResult> {
    if (command.type !== 'start' && command.type !== 'continue') {
      return { commandId: command.commandId, state: 'unsupported', detail: `${command.type}: native request or exact-turn evidence unverified` };
    }
    if (!prepared || !validatePrepared(command, prepared)) {
      return { commandId: command.commandId, state: 'conflict', detail: 'prepared target or immutable input differs' };
    }
    const task = prepared.task;
    const binding: CommandBinding = { commandId: command.commandId, digest: digest(command, prepared), task, state: 'claimed' };
    const claim = this.ledger.claim(binding);
    if (claim === 'conflict') return { commandId: command.commandId, state: 'conflict', detail: 'command ID already bound to another target or text' };
    if (claim !== 'new') return this.readback(claim);
    try {
      const receipt = await this.t3.dispatch(prepared.command);
      if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 0) throw new Error('invalid_t3_receipt');
      this.ledger.settle(command.commandId, 'accepted', receipt.sequence);
      return { commandId: command.commandId, state: 'accepted', task };
    } catch {
      this.ledger.settle(command.commandId, 'unknown');
      return this.readback(this.ledger.get(command.commandId) ?? binding);
    }
  }

  async readback(binding: CommandBinding): Promise<WorkbenchCommandResult> {
    if (binding.state === 'accepted') return { commandId: binding.commandId, state: 'accepted', task: binding.task };
    if (binding.state === 'rejected') return { commandId: binding.commandId, state: 'conflict', task: binding.task, detail: 'native command rejected' };
    try {
      const receipt = await this.t3.readReceipt?.(binding.commandId);
      if (receipt && receipt.aggregateKind === 'thread' && binding.task.origin === 't3' && receipt.aggregateId === binding.task.threadId) {
        const state = receipt.status === 'accepted' ? 'accepted' : 'rejected';
        this.ledger.settle(binding.commandId, state, receipt.resultSequence);
        return { commandId: binding.commandId, state: state === 'accepted' ? 'accepted' : 'conflict', task: binding.task };
      }
    } catch { /* A read outage never grants a second dispatch. */ }
    const entry = originalSessionEntry(binding.task);
    return { commandId: binding.commandId, state: 'unknown', task: binding.task,
      detail: entry ? `Use original ${entry.kind} session ${entry.nativeSessionId} to inspect this command` : 'Await native receipt readback; do not resubmit' };
  }
}
