// Pinned c13f7d93 Effect JSON RPC envelopes. A read scope alone is too broad:
// provider refresh, telemetry, PR/network reads and device calls stay closed.
export const NATIVE_MOUNT_PATH = '/native/';
export const READ_RPC_METHODS = new Set([
  'server.getConfig', 'server.getSettings', 'server.probe',
  'subscribeServerConfig', 'subscribeServerLifecycle',
  'orchestration.subscribeShell', 'orchestration.subscribeThread',
  'orchestration.getArchivedShellSnapshot', 'orchestration.searchThreads',
  'orchestration.getTurnDiff', 'orchestration.getFullThreadDiff',
  'agentSessions.scan',
]);
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const nativeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$/.test(value);
const keysWithin = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));
export function isNativeHttpRead(method, path) {
  return method === 'GET' && (
    ['/.well-known/t3/environment', '/api/auth/session', '/api/orchestration/shell',
      '/api/orchestration/snapshot'].includes(path) ||
    /^\/api\/orchestration\/threads\/[^/]+(?:\/events|\/native-children(?:\/[^/]+)?)?$/.test(path)
  );
}
export function rejectRpc(id) {
  return { _tag: 'Exit', requestId: id, exit: { _tag: 'Failure', cause: [{
    _tag: 'Fail', error: { _tag: 'EnvironmentAuthorizationError',
      requiredScope: 'orchestration:operate', message: '当前入口只读取已有会话；该操作未启用。' },
  }] } };
}
// Each socket owns its request IDs. Controls cannot address any other channel.
export function makeReadRpcFilter(options = {}) {
  const active = new Set();
  const trialCommands = new Map();
  const allowedRead = message => (READ_RPC_METHODS.has(message.tag) &&
    (message.tag !== 'agentSessions.scan' || keysWithin(message.payload, []))) || options.additionalMethods?.has(message.tag) ||
    (message.tag === 'server.refreshProviders' && options.skillTrialGate?.allowsDiscovery(message.payload) === true);
  return {
    assertUnusedId(id) {
      if (!['string', 'number'].includes(typeof id) || String(id).length > 128 || active.has(id) || active.size >= 512)
        throw Error('Invalid request ID');
    },
    filter(data) {
      const input = JSON.parse(data);
      const batch = Array.isArray(input) ? input : [input];
      if (!batch.length || batch.length > 128) throw new Error('Invalid RPC batch');
      // The narrow trial accepts one command at a time; mixed batches stay closed.
      if (batch.length === 1 && batch[0]?._tag === 'Request' && batch[0].tag === 'orchestration.dispatchCommand' && options.skillTrialGate) {
        const m = batch[0];
        if (!['string', 'number'].includes(typeof m.id) || String(m.id).length > 128 || active.has(m.id) || m.isNotification === true || active.size >= 512) throw new Error('Invalid trial RPC envelope');
        const decision = options.skillTrialGate.reserve(m);
        if (decision.kind !== 'forward') return { forward: [], rejected: decision.kind === 'deny' ? [decision.response] : [], replayed: decision.kind === 'replay' ? [decision.response] : [] };
        active.add(m.id); trialCommands.set(m.id, decision.commandId);
        return { forward: [{ _tag: 'Request', id: m.id, tag: m.tag, payload: m.payload, headers: [] }], rejected: [], replayed: [] };
      }
      // Refuse an entire command-bearing batch before mutating channel state.
      if (batch.some(m => m?._tag === 'Request' && !allowedRead(m))) {
        if (batch.some(m => !m || m._tag !== 'Request' || !['string', 'number'].includes(typeof m.id))) throw new Error('Invalid mixed batch');
        return { forward: [], rejected: batch.map(m => rejectRpc(m.id)) };
      }
      const forward = [], rejected = [];
      for (const message of batch) {
        if (!message || typeof message !== 'object') throw new Error('Invalid RPC envelope');
        if (message._tag === 'Request') {
          if (!['string', 'number'].includes(typeof message.id) ||
              String(message.id).length > 128 || active.has(message.id)) throw new Error('Invalid request ID');
          if (allowedRead(message) && message.isNotification !== true) {
            if (active.size >= 512) throw new Error('Too many read requests');
            active.add(message.id);
            // Browser-supplied headers never become trusted native headers.
            forward.push({ _tag: 'Request', id: message.id, tag: message.tag,
              payload: message.payload, headers: [] });
          } else rejected.push(rejectRpc(message.id));
        } else if (message._tag === 'Ping' || message._tag === 'Eof') {
          forward.push({ _tag: message._tag });
        } else if (['Ack', 'Interrupt'].includes(message._tag) && active.has(message.requestId)) {
          forward.push({ _tag: message._tag, requestId: message.requestId });
        } else throw new Error('Invalid RPC control');
      }
      return { forward, rejected };
    },
    receive(data) {
      const input = JSON.parse(data);
      for (const message of Array.isArray(input) ? input : [input]) {
        if (message?._tag === 'Exit') {
          const commandId = trialCommands.get(message.requestId);
          if (commandId) { options.skillTrialGate.receive(commandId, message.exit); trialCommands.delete(message.requestId); }
          active.delete(message.requestId);
        }
      }
    },
  };
}

/** Serial callers await admission before sending; native commands remain original T3 envelopes. */
export function makeExecutionRpcFilter(gate) {
  const methods = new Set(['orchestration.dispatchCommand', 'server.refreshProviders',
    'attachments.createUploadUrl', 'attachments.delete', 'assets.createUrl', 'agentSessions.import']);
  const base = makeReadRpcFilter({ additionalMethods: methods }), commands = new Map();
  // Only original scan replies and original successful creation receipts grant
  // import identities. Browser data cannot choose arbitrary directories/projects.
  const candidates = new Map(), createdProjects = new Map(), historyRequests = new Map();
  const selectedCreate = command => {
    const candidate = candidates.get(command?.workspaceRoot);
    return candidate && candidate.projectId === undefined &&
      keysWithin(command, ['type', 'commandId', 'projectId', 'title', 'workspaceRoot',
        'createWorkspaceRootIfMissing', 'defaultModelSelection', 'createdAt']) &&
      nativeId(command.commandId) && nativeId(command.projectId) && command.title === candidate.title &&
      command.createWorkspaceRootIfMissing === false && command.defaultModelSelection === null &&
      typeof command.createdAt === 'string' && Number.isFinite(Date.parse(command.createdAt));
  };
  const selectedImport = input => {
    const candidate = candidates.get(input?.expectedWorkspaceRoot);
    return candidate && keysWithin(input, ['projectId', 'expectedWorkspaceRoot']) && nativeId(input.projectId) &&
      (candidate.projectId === input.projectId || createdProjects.get(input.projectId) === input.expectedWorkspaceRoot);
  };
  return {
    async filter(data) {
      const input = JSON.parse(data), batch = Array.isArray(input) ? input : [input];
      if (!batch.length || batch.length > 128) throw Error('Invalid RPC batch');
      const operation = batch.find(m => m?._tag === 'Request' && methods.has(m.tag));
      if (operation) {
        // No partial dispatch from mixed read/write batches.
        if (batch.length !== 1) return { forward: [], rejected: batch.map(m => rejectRpc(m.id)) };
        base.assertUnusedId(operation.id);
        if (operation.isNotification === true) throw Error('Operations require receipts');
        if (operation.tag === 'orchestration.dispatchCommand') {
          if (operation.payload?.type === 'project.create') {
            if (!selectedCreate(operation.payload)) return { forward: [], rejected: [rejectRpc(operation.id)] };
          } else {
            const decision = await gate.reserve(operation);
            if (decision.kind !== 'forward') return { forward: [], rejected: [decision.response] };
            commands.set(operation.id, decision.commandId);
          }
        } else if (operation.tag === 'agentSessions.import' && !selectedImport(operation.payload)) {
          return { forward: [], rejected: [rejectRpc(operation.id)] };
        } else if (operation.tag === 'assets.createUrl' && operation.payload?.resource?._tag !== 'attachment') {
          return { forward: [], rejected: [rejectRpc(operation.id)] };
        }
      }
      const result = base.filter(data);
      for (const request of result.forward) {
        if (request._tag === 'Request' && (request.tag === 'agentSessions.scan' ||
          request.tag === 'orchestration.dispatchCommand' && request.payload?.type === 'project.create'))
          historyRequests.set(request.id, request);
      }
      return result;
    },
    receive(data) {
      const input = JSON.parse(data);
      for (const message of Array.isArray(input) ? input : [input]) {
        if (message?._tag === 'Exit' && historyRequests.has(message.requestId)) {
          const request = historyRequests.get(message.requestId); historyRequests.delete(message.requestId);
          if (request.tag === 'agentSessions.scan') {
            candidates.clear();
            if (message.exit?._tag === 'Success' && Array.isArray(message.exit.value?.candidates)) {
              for (const candidate of message.exit.value.candidates) {
                if (typeof candidate?.path === 'string' && candidate.path &&
                  typeof candidate.title === 'string' && candidate.title &&
                  (candidate.projectId === undefined || nativeId(candidate.projectId)))
                  candidates.set(candidate.path, candidate);
              }
            }
          } else if (message.exit?._tag === 'Success' && Number.isSafeInteger(message.exit.value?.sequence) && message.exit.value.sequence >= 0) {
            createdProjects.set(request.payload.projectId, request.payload.workspaceRoot);
          }
        }
        if (message?._tag === 'Exit' && commands.has(message.requestId)) {
          gate.receive(commands.get(message.requestId), message.exit); commands.delete(message.requestId);
        }
      }
      base.receive(data);
    },
  };
}
