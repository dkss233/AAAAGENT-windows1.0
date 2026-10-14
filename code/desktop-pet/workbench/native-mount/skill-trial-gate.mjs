import { createHash, randomUUID } from 'node:crypto';
import { isPrivateFileSync, restrictPrivatePathSync } from '../../dist/core/platform-files.js';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, fstatSync, unlinkSync, constants } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function privateState(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd); if (!isPrivateFileSync(file, s)) throw Error('Invalid trial state descriptor'); return JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
}
function denial(id, message) {
  return { _tag: 'Exit', requestId: id, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'EnvironmentAuthorizationError', requiredScope: 'orchestration:operate', message } }] } };
}

/** A bounded authorization/receipt ledger. Original T3 retains the only task queue. */
export function createSkillTrialGate(config, stateFile, now = Date.now) {
  const syntheticCwd = typeof config?.cwd === 'string' && (process.platform === 'win32'
    ? isAbsolute(config.cwd) && resolve(config.cwd) === config.cwd && dirname(config.cwd) === resolve(tmpdir()) && basename(config.cwd).startsWith('aaaagent-codex-skill-input-54-')
    : config.cwd.startsWith('/private/tmp/aaaagent-codex-skill-input-54-'));
  if (config?.mode !== 'bounded-codex-skill-trial' || config.configurationVerified !== true ||
      typeof config.projectId !== 'string' || !config.projectId ||
      !Array.isArray(config.threadIds) || config.threadIds.length !== 2 || new Set(config.threadIds).size !== 2 ||
      config.threadIds.some(id => typeof id !== 'string' || !id) ||
      typeof config.providerInstanceId !== 'string' || typeof config.model !== 'string' || !config.model || typeof config.reasoningEffort !== 'string' || !config.reasoningEffort ||
      config.accountCategory !== 'chatgpt' || config.parentTurnsMax !== 2 ||
      !Array.isArray(config.automaticCommandIds) || config.automaticCommandIds.length !== 2 || new Set(config.automaticCommandIds).size !== 2 ||
      !Number.isFinite(Date.parse(config.expiresAt)) || !syntheticCwd) throw Error('Trial requires a fixed verified configuration and exact synthetic targets');
  const manifest = structuredClone(config), fingerprint = digest(manifest);
  stateFile = resolve(stateFile);
  let state = existsSync(stateFile) ? privateState(stateFile) : { fingerprint, commands: {} };
  if (state.fingerprint !== fingerprint) throw Error('Existing trial ledger belongs to another configuration; do not reset its budget');
  Object.setPrototypeOf(state.commands, null);
  // One local candidate owns this bounded ledger. Refuse concurrent writers.
  const ownerFile = stateFile + '.owner', owner = { pid: process.pid, id: randomUUID() };
  mkdirSync(dirname(stateFile), { recursive: true });
  if (existsSync(ownerFile)) {
    const previous = privateState(ownerFile); let alive = true;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw Error('A live candidate already owns this trial ledger');
    unlinkSync(ownerFile);
  }
  writeFileSync(ownerFile, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
  restrictPrivatePathSync(ownerFile);
  function persist() {
    mkdirSync(dirname(stateFile), { recursive: true });
    const temp = `${stateFile}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' }); restrictPrivatePathSync(temp); renameSync(temp, stateFile);
  }
  const active = () => Date.parse(manifest.expiresAt) > now();
  const used = role => Object.values(state.commands).filter(row => row.role === role).length;
  const capability = () => active() ? {
    mode: manifest.mode, projectId: manifest.projectId, threadIds: [...manifest.threadIds], cwd: manifest.cwd,
    providerInstanceId: manifest.providerInstanceId, model: manifest.model, reasoningEffort: manifest.reasoningEffort,
    parentTurnsMax: 2, parentTurnsRemaining: Math.max(0, 2 - used('manual')), expiresAt: manifest.expiresAt,
  } : null;
  function reserve(request) {
    const id = request.id, command = request.payload;
    if (!active() || request.tag !== 'orchestration.dispatchCommand' || command?.type !== 'thread.turn.start' ||
        !manifest.threadIds.includes(command.threadId) || command.bootstrap !== undefined || command.providerOnlyProjectContext !== undefined ||
        typeof command.commandId !== 'string' || command.commandId.length > 255 || !command.commandId ||
        command.modelSelection?.instanceId !== manifest.providerInstanceId || command.modelSelection?.model !== manifest.model ||
        command.modelSelection?.options?.reasoningEffort !== manifest.reasoningEffort ||
        command.message?.role !== 'user' || typeof command.message.text !== 'string' || !command.message.text.trim() ||
        !command.message.context?.records?.some(record => record.kind === 'skill' && typeof record.name === 'string' && typeof record.path === 'string')) {
      return { kind: 'deny', response: denial(id, '本轮只允许指定测试对话、固定模型/推理档和明确选择的 Skill；原用户任务保持只读。') };
    }
    const hash = digest(command), old = state.commands[command.commandId];
    if (old) {
      if (old.hash !== hash) return { kind: 'deny', response: denial(id, '该命令已冻结；编辑后的内容需使用新命令，不能覆盖原请求。') };
      if (old.receipt) return { kind: 'replay', response: { _tag: 'Exit', requestId: id, exit: { _tag: 'Success', value: old.receipt } } };
      return { kind: 'deny', response: denial(id, '原命令结果尚不明确，请读取原命令回执；本入口不会重发。') };
    }
    // A lost receipt must be cold-read before another command on the same target.
    if (Object.values(state.commands).some(row => row.threadId === command.threadId && !row.receipt && !row.rejected)) return { kind: 'deny', response: denial(id, '该测试对话有待核原命令，请先读取其回执。') };
    const role = manifest.automaticCommandIds.includes(command.commandId) ? 'automatic' : 'manual';
    if (used(role) >= 2) return { kind: 'deny', response: denial(id, '本轮测试额度已用完；不会自动补发。') };
    state.commands[command.commandId] = { hash, threadId: command.threadId, role, submittedAt: new Date(now()).toISOString() };
    persist(); // Reserve durably before the original service can receive the command.
    return { kind: 'forward', commandId: command.commandId };
  }
  function receive(commandId, exit) {
    const row = state.commands[commandId]; if (!row) return;
    if (exit?._tag === 'Success') {
      // Original dispatch receipts contain metadata only. Do not persist raw error/body values.
      const value = exit.value;
      if (Number.isSafeInteger(value?.sequence)) row.receipt = { sequence: value.sequence };
    } else if (exit?._tag === 'Failure') row.rejected = true;
    persist();
  }
  function reconcile(commandId, receipt) {
    const row = state.commands[commandId]; if (!row) throw Error('Only known test commands may be read');
    if (receipt?.status === 'accepted' && Number.isSafeInteger(receipt?.resultSequence) && receipt.aggregateId === row.threadId && receipt.commandId === commandId) row.receipt = { sequence: receipt.resultSequence };
    else if (receipt?.status === 'rejected') row.rejected = true;
    persist();
  }
  const allowsDiscovery = payload => active() && payload?.instanceId === manifest.providerInstanceId && payload?.cwd === manifest.cwd &&
    Object.keys(payload).every(key => ['instanceId', 'cwd'].includes(key));
  return { capability, reserve, receive, reconcile, allowsDiscovery, allowsReceipt: id => Object.hasOwn(state.commands, id), audit: () => ({ automaticParentTurnsReserved: used('automatic'), manualParentTurnsReserved: used('manual'), unresolvedReceipts: Object.values(state.commands).filter(row => !row.receipt && !row.rejected).length }), close: () => { if (existsSync(ownerFile) && privateState(ownerFile).id === owner.id) unlinkSync(ownerFile); } };
}
