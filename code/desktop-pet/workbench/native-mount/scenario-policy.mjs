import { existsSync } from 'node:fs';
import { readPrivateBoardJson, boardId, boardDigest } from '../independent-blackboard/registry.mjs';

/** Optional project-scoped limits use the original gate journal, never another executor. */
export function createScenarioPolicy({ file, environmentId, sourceRevision, now = Date.now }) {
  let frozen = null;
  const replies = new Set(['thread.approval.respond', 'thread.user-input.respond']);
  return (command, target, commands) => {
    if (!existsSync(file)) {
      if (frozen && target.projectId === frozen.value.projectId || Object.values(commands).some(x => x.projectId === target.projectId && x.scenarioAuthorizationId)) throw Error('场景授权已变化，请保留原命令并核对。');
      return {};
    }
    const value = readPrivateBoardJson(file), fingerprint = boardDigest(value);
    if (value.version !== 1 || value.kind !== 'web-scenario-turn-budget' || value.environmentId !== environmentId ||
        value.sourceRevision !== sourceRevision || !boardId(value.projectId) || !boardId(value.authorizationId) ||
        !Array.isArray(value.threads) || !value.threads.length || value.threads.length > 16 ||
        new Set(value.threads.map(x => x.threadId)).size !== value.threads.length ||
        value.threads.some(x => !boardId(x.threadId) || !boardId(x.providerInstanceId) || !Number.isSafeInteger(x.maxTurnStarts) || x.maxTurnStarts < 1 || x.maxTurnStarts > 100 ||
          !Array.isArray(x.runtimeModes) || !x.runtimeModes.length || x.runtimeModes.some(m => !['approval-required','auto-accept-edits'].includes(m)) ||
          !Array.isArray(x.modelSelections) || !x.modelSelections.length || x.modelSelections.some(m => m?.instanceId !== x.providerInstanceId || !boardId(m.model))) ||
        !Number.isSafeInteger(value.maxTurnStarts) || value.maxTurnStarts !== value.threads.reduce((n,x) => n+x.maxTurnStarts,0) ||
        !Number.isSafeInteger(value.maxResponseCommands) || value.maxResponseCommands < 0 || value.maxResponseCommands > 20 ||
        !Number.isFinite(Date.parse(value.startsAt)) || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.startsAt) >= Date.parse(value.expiresAt))
      throw Error('本次场景的准确范围和次数尚未核定。');
    if (frozen && frozen.fingerprint !== fingerprint) throw Error('场景授权已冻结，不能覆盖或自动增额。');
    frozen ??= { fingerprint, value };
    if (target.projectId !== value.projectId) {
      if (Object.values(commands).some(x => x.projectId === target.projectId && x.scenarioAuthorizationId)) throw Error('原场景授权已变化，请保留原回执。');
      return {};
    }
    if (now() < Date.parse(value.startsAt) || now() >= Date.parse(value.expiresAt)) throw Error('本次场景的执行窗口未开放。');
    const thread = value.threads.find(x => x.threadId === command.threadId);
    if (!thread || thread.providerInstanceId !== target.providerInstanceId) throw Error('该对话不在本次准确场景范围。');
    if (command.runtimeMode && !thread.runtimeModes.includes(command.runtimeMode)) throw Error('本次场景不使用该权限模式。');
    const selection = command.modelSelection ?? target.modelSelection;
    const modelKey = m => boardDigest([m?.instanceId,m?.model,(Array.isArray(m?.options) ? m.options : Object.entries(m?.options ?? {}).map(([id,value]) => ({id,value}))).slice().sort((a,b) => a.id.localeCompare(b.id))]);
    if ((command.type === 'thread.turn.start' || command.modelSelection) && !thread.modelSelections.some(m => modelKey(m) === modelKey(selection))) throw Error('模型与推理档不在本次准确场景范围。');
    const rows = Object.values(commands).filter(x => x.projectId === value.projectId);
    if (rows.some(x => !x.commandType || x.scenarioAuthorizationId !== value.authorizationId || x.scenarioPolicySha256 !== fingerprint)) throw Error('原场景记录来源尚不可核对。');
    if (rows.some(x => x.status === 'submitted')) throw Error('本场景有结果未明的原命令，请先冷读准确回执。');
    if (command.type === 'thread.turn.start') {
      const starts = rows.filter(x => x.commandType === command.type);
      if (starts.length >= value.maxTurnStarts || starts.filter(x => x.threadId === command.threadId).length >= thread.maxTurnStarts)
        throw Error('本次场景的工程输入次数已用完。');
    } else if (replies.has(command.type)) {
      if (rows.filter(x => replies.has(x.commandType)).length >= value.maxResponseCommands) throw Error('本次场景的原请求回答次数已用完。');
    } else if (!['thread.runtime-mode.set','thread.interaction-mode.set','thread.meta.update'].includes(command.type)) {
      throw Error('此操作未进入本次场景安排。');
    }
    return { scenarioAuthorizationId:value.authorizationId, scenarioPolicySha256:fingerprint };
  };
}
