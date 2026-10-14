const ORIGIN = /^http:\/\/127\.0\.0\.1:(?:[1-9]\d{0,4})$/;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_BYTES = 256 * 1024;

export class T3TransportError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'T3TransportError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

async function boundedJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new T3TransportError('response_too_large');
  }
  if (!response.body) throw new T3TransportError('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new T3TransportError('response_too_large');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof T3TransportError) throw error;
    throw new T3TransportError('invalid_response');
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); }
  catch { throw new T3TransportError('invalid_response'); }
}

function boundedId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 250 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new T3TransportError('invalid_identifier');
  }
  return encodeURIComponent(value);
}

/** Server-only client. A failed dispatch is never retried here; the command ledger decides readback. */
export class T3HttpClient {
  #service;
  #transport;

  constructor(service, { transport = globalThis.fetch } = {}) {
    if (typeof service?.start !== 'function' || typeof transport !== 'function') throw new TypeError('T3 client requires a local service and fetch');
    this.#service = service;
    this.#transport = transport;
  }

  async #request(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    let connection;
    try { connection = await this.#service.start(); }
    catch { throw new T3TransportError('service_unavailable'); }
    if (!ORIGIN.test(connection?.origin) || Number(connection.origin.slice('http://127.0.0.1:'.length)) > 65535 ||
        typeof connection.accessToken !== 'string' || connection.accessToken.length < 32) {
      throw new T3TransportError('invalid_local_service');
    }
    const expiry = Date.parse(connection.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new T3TransportError('access_expired');
    let response;
    try {
      response = await this.#transport(connection.origin + path, {
        method, redirect: 'error', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${connection.accessToken}`, Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body }),
      });
    } catch { throw new T3TransportError('network_unavailable'); }
    if (!response.ok) throw new T3TransportError('http_error', response.status);
    return boundedJson(response);
  }

  async dispatch(command) {
    let body;
    try { body = JSON.stringify(command); } catch { throw new T3TransportError('invalid_command'); }
    if (!body || Buffer.byteLength(body) > MAX_COMMAND_BYTES) throw new T3TransportError('invalid_command');
    const result = await this.#request('/api/orchestration/dispatch', { method: 'POST', body, timeoutMs: 30000 });
    if (!Number.isSafeInteger(result?.sequence) || result.sequence < 0) throw new T3TransportError('invalid_response');
    return { sequence: result.sequence };
  }

  /** Native project/thread creation uses the same durable dispatch transport, without a turn. */
  createCommand(command) {
    if (!['project.create', 'thread.create'].includes(command?.type)) throw new T3TransportError('invalid_command');
    return this.dispatch(command);
  }

  async readReceipt(commandId) {
    const result = await this.#request(`/api/orchestration/commands/${boundedId(commandId)}/receipt`);
    if (result === null) return null;
    if (result?.commandId !== commandId || !['thread', 'project'].includes(result.aggregateKind) ||
        !['accepted', 'rejected'].includes(result.status) || typeof result.aggregateId !== 'string' ||
        !result.aggregateId || !Number.isSafeInteger(result.resultSequence) || result.resultSequence < 0) {
      throw new T3TransportError('invalid_response');
    }
    return { status: result.status, aggregateKind: result.aggregateKind,
      aggregateId: result.aggregateId, resultSequence: result.resultSequence };
  }

  shellSnapshot() { return this.#request('/api/orchestration/shell'); }

  /** Account/provider-backed catalogue; only safe model labels leave this client. */
  async providerModels(instanceId = 'codex') {
    if (!['codex', 'dsh'].includes(instanceId)) throw new T3TransportError('invalid_identifier');
    // A native provider health refresh can consume its own ten-second window.
    // Leave room for that read to finish before validating a new web turn.
    const result = await this.#request('/api/orchestration/provider-models' + (instanceId === 'codex' ? '' : '?instanceId=dsh'),
      { timeoutMs: 30000 });
    if (!Array.isArray(result?.providers) || result.providers.length > 100) throw new T3TransportError('invalid_response');
    return { providers: result.providers.map(provider => {
      if (typeof provider?.instanceId !== 'string' || typeof provider.driver !== 'string' ||
          typeof provider.enabled !== 'boolean' || typeof provider.installed !== 'boolean' ||
          !['ready', 'warning', 'error', 'disabled'].includes(provider.status) ||
          !['authenticated', 'unauthenticated', 'unknown'].includes(provider.authStatus) ||
          !Number.isFinite(Date.parse(provider.checkedAt)) || !Array.isArray(provider.models) ||
          provider.models.length > 500 || provider.models.some(model =>
            typeof model?.slug !== 'string' || !model.slug.trim() || model.slug.length > 250 ||
            typeof model.name !== 'string' || !model.name.trim() || model.name.length > 250)) {
        throw new T3TransportError('invalid_response');
      }
      return { instanceId: provider.instanceId, driver: provider.driver, enabled: provider.enabled,
        installed: provider.installed, status: provider.status, authStatus: provider.authStatus,
        checkedAt: provider.checkedAt,
        models: provider.models.map(model => {
          const descriptors = model.capabilities?.optionDescriptors;
          const matching = Array.isArray(descriptors) ? descriptors.filter(value => value?.id === 'reasoningEffort') : [];
          if (matching.length > 1) throw new T3TransportError('invalid_response');
          const descriptor = matching[0];
          if (!descriptor) return { id: model.slug, name: model.name };
          if (descriptor.type !== 'select' || !Array.isArray(descriptor.options) || descriptor.options.length > 20 ||
              descriptor.options.some(option => typeof option?.id !== 'string' || !option.id.trim() || option.id.length > 250 ||
                typeof option.label !== 'string' || !option.label.trim() || option.label.length > 250) ||
              new Set(descriptor.options.map(option => option.id)).size !== descriptor.options.length ||
              descriptor.currentValue !== undefined && !descriptor.options.some(option => option.id === descriptor.currentValue)) {
            throw new T3TransportError('invalid_response');
          }
          return { id: model.slug, name: model.name,
            reasoningEfforts: descriptor.options.map(option => ({ id: option.id, name: option.label })),
            ...(descriptor.currentValue === undefined ? {} : { defaultReasoningEffort: descriptor.currentValue }) };
        }) };
    }) };
  }

  async environmentDescriptor() {
    const descriptor = await this.#request('/.well-known/t3/environment');
    if (typeof descriptor?.environmentId !== 'string' || !descriptor.environmentId.trim() ||
        descriptor.environmentId.length > 250) throw new T3TransportError('invalid_response');
    return { environmentId: descriptor.environmentId };
  }

  threadSnapshot(threadId, turnLimit = 20, beforeCursor) {
    if (!Number.isSafeInteger(turnLimit) || turnLimit < 1 || turnLimit > 100) throw new T3TransportError('invalid_limit');
    if (beforeCursor !== undefined && (typeof beforeCursor !== 'string' ||
        beforeCursor.length < 1 || beforeCursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(beforeCursor))) {
      throw new T3TransportError('invalid_cursor');
    }
    return this.#request(`/api/orchestration/threads/${boundedId(threadId)}?turnLimit=${turnLimit}`+
      (beforeCursor === undefined ? '' : `&beforeCursor=${encodeURIComponent(beforeCursor)}`));
  }

  /** Fixed T3 0010: bounded, metadata-only thread events. No dispatch or implicit retry. */
  async threadEventPage(threadId, afterSequence, limit = 100) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new T3TransportError('invalid_cursor');
    const result = await this.#request(`/api/orchestration/threads/${boundedId(threadId)}/events?afterSequence=${afterSequence}&limit=${limit}`);
    const safeSequence = value => Number.isSafeInteger(value) && value >= 0;
    const safeText = value => typeof value === 'string' && value.length > 0 && value.length <= 250 &&
      !/[\u0000-\u001f\u007f]/u.test(value);
    if (!result || result.threadId !== threadId || result.afterSequence !== afterSequence ||
        !safeSequence(result.headSequence) || !safeSequence(result.nextSequence) ||
        result.nextSequence > result.headSequence || typeof result.hasMore !== 'boolean' ||
        typeof result.resetRequired !== 'boolean' || !Array.isArray(result.events) || result.events.length > limit) {
      throw new T3TransportError('invalid_response');
    }
    if (result.resetRequired) {
      if (result.events.length || result.hasMore || result.nextSequence !== result.headSequence ||
          !['cursor_ahead', 'gap_too_large', 'payload_too_large'].includes(result.resetReason)) {
        throw new T3TransportError('invalid_response');
      }
    } else if (result.resetReason !== undefined || result.headSequence < afterSequence ||
        result.nextSequence < afterSequence || result.hasMore &&
          (result.events.length !== limit || result.nextSequence >= result.headSequence)) {
      throw new T3TransportError('invalid_response');
    }
    let previous = afterSequence;
    const ids = new Set();
    for (const event of result.events) {
      if (!safeSequence(event?.sequence) || event.sequence <= previous || event.sequence > result.headSequence ||
          !safeText(event.eventId) || ids.has(event.eventId) || !safeText(event.type) ||
          typeof event.occurredAt !== 'string' || !Number.isFinite(Date.parse(event.occurredAt)) ||
          ['turnId', 'activityId', 'activityKind', 'sessionStatus'].some(key => event[key] !== undefined && !safeText(event[key])) ||
          event.activityTone !== undefined && !['info', 'tool', 'approval', 'error'].includes(event.activityTone)) {
        throw new T3TransportError('invalid_response');
      }
      ids.add(event.eventId); previous = event.sequence;
    }
    if (!result.resetRequired && (result.hasMore && previous !== result.nextSequence ||
        !result.hasMore && result.nextSequence !== result.headSequence)) throw new T3TransportError('invalid_response');
    return { threadId, afterSequence, headSequence: result.headSequence, nextSequence: result.nextSequence,
      hasMore: result.hasMore, resetRequired: result.resetRequired,
      ...(result.resetRequired ? { resetReason: result.resetReason } : {}),
      events: result.events.map(event => ({ eventId: event.eventId, sequence: event.sequence,
        occurredAt: event.occurredAt, type: event.type,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        ...(event.activityId ? { activityId: event.activityId } : {}),
        ...(event.activityKind ? { activityKind: event.activityKind } : {}),
        ...(event.activityTone ? { activityTone: event.activityTone } : {}),
        ...(event.sessionStatus ? { sessionStatus: event.sessionStatus } : {}) })) };
  }
}
