import { createHash, randomUUID } from 'node:crypto';
import { isPrivateFileSync, restrictPrivatePathSync } from '../../dist/core/platform-files.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const EXECUTION_COMMANDS = Object.freeze([
  'thread.create', 'thread.turn.start', 'thread.turn.interrupt', 'thread.runtime-mode.set',
  'thread.interaction-mode.set', 'thread.approval.respond', 'thread.user-input.respond',
  'thread.user-input.dismiss', 'thread.session.stop', 'thread.meta.update',
]);
export const EXECUTION_RPC_METHODS = Object.freeze([
  'orchestration.dispatchCommand', 'server.refreshProviders', 'attachments.createUploadUrl',
  'attachments.delete', 'assets.createUrl',
]);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(value);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function failure(requestId, message) {
  return { _tag: 'Exit', requestId, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail',
    error: { _tag: 'EnvironmentAuthorizationError', requiredScope: 'orchestration:operate', message } }] } };
}

/** Admission metadata only. The original T3 commands, events and driver remain the execution queue. */
export function createNativeExecutionGate({ environmentId, file, providers, prepareCommand, getTarget = async () => null, findReceipt = () => null, admissionPolicy }) {
  if (!id(environmentId) || typeof prepareCommand !== 'function' || !Array.isArray(providers)) throw Error('Execution binding required');
  const providerIds = new Set(providers.map(p => p.providerInstanceId));
  if (providerIds.size !== providers.length || providers.some(p => !id(p.providerInstanceId) ||
      !['send', 'continue', 'modelSelection', 'interrupt', 'approval', 'userInput'].every(k => typeof p[k] === 'boolean') ||
      !Array.isArray(p.runtimeModes) || !record(p.attachments) || typeof p.attachments.file !== 'boolean' ||
      typeof p.attachments.image !== 'boolean' || !Number.isSafeInteger(p.attachments.maxBytes) || p.attachments.maxBytes < 0))
    throw Error('Explicit provider capabilities required');
  let state = { version: 1, environmentId, commands: {} };
  if (file) {
    if (resolve(file) !== file) throw Error('Canonical admission file required');
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!isPrivateFileSync(file, stat)) throw Error('Unsafe admission file');
      state = JSON.parse(readFileSync(file, 'utf8'));
      if (state.version !== 1 || state.environmentId !== environmentId || !record(state.commands) ||
          Object.entries(state.commands).some(([key, row]) => !id(key) || !record(row) ||
            !id(row.threadId) || !/^[a-f0-9]{64}$/.test(row.hash) || !['submitted', 'accepted', 'rejected'].includes(row.status)))
        throw Error('Admission identity changed');
    }
  }
  const inflight = new Set();
  function persist() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(file)).isSymbolicLink()) throw Error('Admission directory cannot be a link');
    const temp = file + '.' + randomUUID() + '.tmp';
    try { writeFileSync(temp, JSON.stringify(state) + '\n', { flag: 'wx', mode: 0o600 }); restrictPrivatePathSync(temp); renameSync(temp, file); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
  function validate(command, scope) {
    if (!record(command) || !EXECUTION_COMMANDS.includes(command.type) || !id(command.commandId) || !id(command.threadId))
      throw Error('命令或准确对话标识无效。');
    if (command.providerOnlyProjectContext !== undefined || command.bootstrap?.prepareWorktree || command.bootstrap?.runSetupScript)
      throw Error('该私有工程上下文或工作目录操作没有从网页开放。');
    if (!scope || scope.environmentId !== environmentId || !id(scope.projectId)) throw Error('当前项目与原生环境不匹配。');
    if (scope.validationError) throw Error({
      model_selection_unavailable: '所选模型已变化或不受当前执行器支持；请刷新模型目录并保留草稿。',
      provider_unavailable: '当前执行器或登录尚不可用；请检查准确原服务并保留草稿。',
      reasoning_unavailable: '所选推理档不受当前模型支持；请重新选择。',
    }[scope.validationError] ?? '当前执行配置不可核对；请保留草稿。');
    if (scope.readonly !== false || !(scope.source === 't3' ||
        scope.source === 'codex-app' && scope.executionOwner === 'shared-codex'))
      throw Error('原会话写入通道尚未核定；请在准确原会话中处理。');
    const selected = command.modelSelection?.instanceId ?? command.bootstrap?.createThread?.modelSelection?.instanceId ?? scope.providerInstanceId;
    const capability = providers.find(p => p.providerInstanceId === selected);
    if (!capability) throw Error('当前执行器没有可用能力。');
    if (scope.providerInstanceId && selected !== scope.providerInstanceId) throw Error('原会话不能静默切换执行器；请选择明确的新对话。');
    const runtimeMode = command.runtimeMode ?? command.bootstrap?.createThread?.runtimeMode;
    if (['thread.create', 'thread.turn.start', 'thread.runtime-mode.set'].includes(command.type) && typeof runtimeMode !== 'string')
      throw Error('请选择明确的权限模式；本入口不使用原服务的默认权限。');
    if (runtimeMode !== undefined && !capability.runtimeModes.includes(runtimeMode)) throw Error('执行器不支持这个权限模式。');
    if (command.modelSelection && !capability.modelSelection) throw Error('当前执行器模型选择尚未接通。');
    if (command.type === 'thread.turn.start') {
      if (!(scope.newThread ? capability.send : capability.continue)) throw Error('当前执行器不能从此入口发送或续聊。');
      if (command.message?.role !== 'user' || typeof command.message.text !== 'string' ||
          !Array.isArray(command.message.attachments) || (!command.message.text.trim() && !command.message.attachments.length))
        throw Error('请填写正文或选择可支持的附件。');
      for (const item of command.message.attachments) {
        if (!record(item) || !['file', 'image'].includes(item.type) || !capability.attachments[item.type] ||
            !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 || item.sizeBytes > capability.attachments.maxBytes ||
            item.type === 'image' && item.sizeBytes > 10 * 1024 * 1024)
          throw Error('附件类型或尺寸不受支持；附件没有被省略发送。');
      }
    }
    if (command.type === 'thread.create' && !capability.send) throw Error('当前执行器不能创建可执行对话。');
    if (['thread.turn.interrupt', 'thread.session.stop'].includes(command.type) && !capability.interrupt)
      throw Error('当前执行器中止能力尚未接通。');
    if (command.type === 'thread.approval.respond' && (!capability.approval || !id(command.requestId))) throw Error('批准请求不可回答。');
    if (command.type.startsWith('thread.user-input.') && (!capability.userInput || !id(command.requestId))) throw Error('追问请求不可回答。');
    if (selected === 'dsh' && command.type === 'thread.user-input.dismiss')
      throw Error('当前执行器不支持从网页关闭这个追问；请在原会话处理。');
    if (command.type === 'thread.meta.update' && ['branch', 'worktreePath', 'linkedPullRequest'].some(k => command[k] !== undefined))
      throw Error('该项目或Git配置操作没有从网页开放。');
  }
  return {
    capability(mode = 'native-operate') { return { apiVersion: 1, version: '0.2.0', environmentId, mode,
      commandTypes: mode === 'native-operate' ? [...EXECUTION_COMMANDS] : [],
      providers: mode === 'native-operate' ? structuredClone(providers) : [] }; },
    async targetCapability(threadId, mode = 'native-operate') {
      if (!id(threadId)) return null;
      const target = await getTarget(threadId);
      if (!target) return null;
      if (target.environmentId !== environmentId || target.threadId !== threadId || !id(target.projectId) ||
          !['t3', 'codex-app', 'external', 'unknown'].includes(target.source) ||
          target.providerInstanceId !== null && !id(target.providerInstanceId) ||
          target.nativeSessionId !== null && !id(target.nativeSessionId)) throw Error('Unverified native target');
      const provider = providers.find(p => p.providerInstanceId === target.providerInstanceId);
      const readonly = mode !== 'native-operate' || target.readonly !== false ||
        !(target.source === 't3' || target.source === 'codex-app' && target.executionOwner === 'shared-codex') || !provider?.continue;
      return { apiVersion: 1, version: '0.2.0', environmentId, projectId: target.projectId, threadId,
        providerInstanceId: target.providerInstanceId, nativeSessionId: target.nativeSessionId, source: target.source,
        readonly, reason: mode !== 'native-operate' ? 'read_only_mount' : readonly
          ? target.source === 'codex-app' || target.source === 'external' ? 'external_owner_unavailable' : 'binding_unverified' : null,
        commandTypes: readonly ? [] : EXECUTION_COMMANDS.filter(type =>
          target.providerInstanceId !== 'dsh' || type !== 'thread.user-input.dismiss') };
    },
    async reserve(request) {
      const command = request.payload, key = command?.commandId;
      const deny = message => ({ kind: 'deny', response: failure(request.id, message) });
      if (!id(key)) return deny('准确命令标识无效。');
      if (inflight.has(key)) return deny('原命令仍在核对；请查询原回执，不要重发。');
      inflight.add(key);
      try {
        const hash = digest(command), old = state.commands[key];
        if (old) {
          if (old.hash !== hash) return deny('原命令已冻结，编辑后的内容不能覆盖原请求。');
          return deny('原命令已经提交；请查询准确回执和会话状态，不要重发。');
        }
        const existing = await findReceipt(key);
        if (existing) return deny('原服务已经记录这个命令；请查询原回执。');
        const scope = await prepareCommand(command);
        try { validate(command, scope); } catch (error) { return deny(error.message); }
        if (Object.values(state.commands).some(row => row.threadId === command.threadId && row.status === 'submitted'))
          return deny('此对话有结果未明的命令；请先查询原回执。');
        // Synchronous policy + journal claim stay in one process boundary after all transport awaits.
        let policyProof;
        try { policyProof = admissionPolicy?.(command, scope, state.commands) ?? {}; }
        catch (error) { return deny(error.message); }
        state.commands[key] = { hash, threadId: command.threadId, projectId: scope.projectId, commandType:command.type, ...policyProof,
          status: 'submitted', submittedAt: new Date().toISOString() };
        try { persist(); } catch (error) { delete state.commands[key]; throw error; }
        return { kind: 'forward', commandId: key };
      } catch { return deny('原命令尚未发送，当前服务或提交记录不可核对；请保留草稿并重新连接。'); }
      finally { inflight.delete(key); }
    },
    receive(commandId, exit) {
      const row = state.commands[commandId];
      if (!row) return;
      if (exit?._tag === 'Success' && Number.isSafeInteger(exit.value?.sequence) && exit.value.sequence >= 0) {
        row.status = 'accepted'; row.sequence = exit.value.sequence;
      }
      // A transport/RPC failure can arrive after a durable native acceptance. Only its original receipt settles rejection.
      persist();
    },
    allowsReceipt(commandId) { return id(commandId); },
    reconcile(commandId, receipt) {
      const row = state.commands[commandId];
      if (!row || receipt?.commandId !== commandId || receipt.aggregateKind !== 'thread' || receipt.aggregateId !== row.threadId) return;
      if (receipt.status === 'accepted' && Number.isSafeInteger(receipt.resultSequence) && receipt.resultSequence >= 0) {
        row.status = 'accepted'; row.sequence = receipt.resultSequence;
      } else if (receipt.status === 'rejected') row.status = 'rejected';
      persist();
    },
  };
}
