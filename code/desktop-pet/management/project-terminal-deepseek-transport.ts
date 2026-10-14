import { constants } from 'node:fs';
import { isPrivateFileSync } from '../core/platform-files.js';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { MAX_API_KEY_FILE_BYTES, normalizeApiKey } from '../core/api-key.js';
import { ProjectTerminalTransportError, type ProjectTerminalModelTransport } from
  '../contracts/project-terminal-processing.js';
export { ProjectTerminalTransportError } from '../contracts/project-terminal-processing.js';
import { DEEPSEEK_ENDPOINT, DEEPSEEK_FLASH_MODEL } from '../providers/text-protocol.js';

const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_OUTPUT_TOKENS = 393216;

/** Shared exact serialization for capture-only review and the actual provider transport. */
export function projectTerminalDeepSeekBody(input: { readonly model: string; readonly systemText: string;
  readonly userText: string; readonly maxOutputTokens: number }): string {
  if (input.model !== DEEPSEEK_FLASH_MODEL || typeof input.systemText !== 'string' || !input.systemText.trim() ||
      typeof input.userText !== 'string' || !input.userText.trim() ||
      input.systemText.includes('\0') || input.userText.includes('\0') ||
      Buffer.byteLength(input.systemText, 'utf8') + Buffer.byteLength(input.userText, 'utf8') > 240000 ||
      !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 ||
      input.maxOutputTokens > MAX_OUTPUT_TOKENS) return invalid();
  return JSON.stringify({ model: input.model,
    messages: [{ role: 'system', content: input.systemText }, { role: 'user', content: input.userText }],
    stream: false, thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
    max_tokens: input.maxOutputTokens });
}

const invalid = (): never => { throw new ProjectTerminalTransportError('invalid_request', false); };
const credentialError = (): never => { throw new ProjectTerminalTransportError('credential_unavailable', false); };
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const tokens = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function active(signal: AbortSignal, started: boolean): void {
  if (signal.aborted) throw new ProjectTerminalTransportError('aborted', started);
}

function waitFor<T>(pending: Promise<T>, signal: AbortSignal, started: boolean): Promise<T> {
  active(signal, started);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(new ProjectTerminalTransportError('aborted', started)); };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) onAbort();
  });
}

async function readRestrictedKey(file: string): Promise<string> {
  if (!isAbsolute(file) || file.includes('\0')) return credentialError();
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return credentialError(); }
  try {
    const info = await handle.stat();
    if (info.size < 1 || info.size > MAX_API_KEY_FILE_BYTES || !isPrivateFileSync(file, info)) return credentialError();
    const bytes = await handle.readFile();
    try {
      if (bytes.byteLength > MAX_API_KEY_FILE_BYTES) return credentialError();
      const key = normalizeApiKey(bytes.toString('utf8'));
      if (!key) return credentialError();
      return key;
    } finally { bytes.fill(0); }
  } catch { return credentialError(); }
  finally { try { await handle.close(); } catch { return credentialError(); } }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new ProjectTerminalTransportError('invalid_response', true);
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > MAX_RESPONSE_BYTES)
    throw new ProjectTerminalTransportError('response_too_large', true);
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await waitFor(reader.read(), signal, true);
      active(signal, true);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new ProjectTerminalTransportError('response_too_large', true);
      parts.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts, total));
}

function decode(raw: string): Awaited<ReturnType<ProjectTerminalModelTransport['complete']>> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; } catch {
    throw new ProjectTerminalTransportError('invalid_response', true);
  }
  const result = record(parsed);
  if (!result || !Array.isArray(result.choices) || result.choices.length !== 1) {
    throw new ProjectTerminalTransportError('invalid_response', true);
  }
  const choice = record(result.choices[0]), message = record(choice?.message);
  if (!choice || !message || typeof message.content !== 'string') {
    throw new ProjectTerminalTransportError('invalid_response', true);
  }
  const finishReason = choice.finish_reason === 'stop' ? 'stop' :
    choice.finish_reason === 'length' ? 'length' : 'unknown';
  const usage = record(result.usage);
  return {
    text: message.content, finishReason,
    usage: usage && tokens(usage.prompt_tokens) && tokens(usage.completion_tokens)
      ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } : null,
  };
}

/** A dedicated non-streaming DeepSeek Flash adapter; the shared project call port owns reservation/settlement. */
export function createDeepSeekProjectTerminalTransport(fetcher: typeof fetch = fetch): ProjectTerminalModelTransport {
  return { async complete(input) {
    if (input.scope !== 'project-terminal' || input.provider !== 'deepseek' ||
        input.model !== DEEPSEEK_FLASH_MODEL || input.endpoint !== DEEPSEEK_ENDPOINT ||
        input.thinking !== undefined || !/^project-terminal:[a-f0-9]{64}$/u.test(input.operationId) ||
        typeof input.projectId !== 'string' || !input.projectId.trim() ||
        typeof input.systemText !== 'string' || !input.systemText.trim() ||
        typeof input.userText !== 'string' || !input.userText.trim() ||
        input.systemText.includes('\0') || input.userText.includes('\0') ||
        Buffer.byteLength(input.systemText, 'utf8') + Buffer.byteLength(input.userText, 'utf8') > 240000 ||
        !Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 ||
        input.maxOutputTokens > MAX_OUTPUT_TOKENS ||
        !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 300000 ||
        !(input.signal instanceof AbortSignal)) return invalid();
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), input.timeoutMs);
    const signal = AbortSignal.any([input.signal, timeoutController.signal]);
    try {
      active(signal, false);
      const key = await readRestrictedKey(input.credentialFile);
      active(signal, false);
      let requestStarted = false;
      try {
        const body = projectTerminalDeepSeekBody(input);
        requestStarted = true;
        const response = await waitFor(fetcher(DEEPSEEK_ENDPOINT, {
          method: 'POST', redirect: 'error', signal,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body,
        }), signal, true);
        active(signal, true);
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new ProjectTerminalTransportError('http_error', true,
            Number.isSafeInteger(response.status) ? response.status : undefined);
        }
        return decode(await readBounded(response, signal));
      } catch (error) {
        if (error instanceof ProjectTerminalTransportError) throw error;
        throw new ProjectTerminalTransportError(signal.aborted ? 'aborted' : 'transport_unknown', requestStarted);
      }
    } finally { clearTimeout(timer); }
  } };
}
