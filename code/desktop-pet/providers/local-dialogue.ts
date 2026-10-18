import type { TurnScope } from '../contracts/index.js';
import { abortable, checkAbort } from '../media/scope.js';
import { countRequestInput, inputBudgetInfo } from './input-count.js';
import { JsonDialogueProvider } from './qwen-dialogue.js';
import { denyPaidCalls, object, ProviderTransport, type EndpointConfig, type JsonRecord, type ProviderOperation } from './transport.js';
import type { hostClock } from './host-clock.js';
import type { SocialContextPort } from '../companion/cloud/protocol.js';

/** Only foreground companion replies. Memory, summary, admission and speech keep their own providers. */
export interface LocalDialogueConfiguration {
  readonly baseUrl: string;
  readonly model: string;
  /** Must match the context configured on the local server/model (for Ollama, num_ctx). */
  readonly contextWindowTokens: number;
  readonly inputTokenLimit: number;
  readonly outputTokenLimit: number;
  readonly timeoutMs?: number;
  readonly temperature?: number;
  /** Ollama accepts none to disable reasoning; omit for servers without this extension. */
  readonly reasoningEffort?: 'none';
}

export function validateLocalDialogue(value: unknown): LocalDialogueConfiguration {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('本地对话配置无效。');
  const c = value as LocalDialogueConfiguration;
  const allowed = new Set(['baseUrl', 'model', 'contextWindowTokens', 'inputTokenLimit', 'outputTokenLimit', 'timeoutMs', 'temperature', 'reasoningEffort']);
  if (Object.keys(c).some(key => !allowed.has(key))) throw Error('本地对话配置含未知字段；不接受云端凭据。');
  let url: URL;
  try { url = new URL(c.baseUrl); } catch { throw Error('本地对话服务地址无效。'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port ||
      url.username || url.password || url.search || url.hash || !['/v1', '/v1/'].includes(url.pathname))
    throw Error('本地对话服务须使用本机回环地址、明确端口和 /v1 接口。');
  if (typeof c.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(c.model)) throw Error('须明确选择已安装的本地对话模型。');
  if (!Number.isSafeInteger(c.contextWindowTokens) || c.contextWindowTokens < 4096 || c.contextWindowTokens > 131072 ||
      !Number.isSafeInteger(c.inputTokenLimit) || c.inputTokenLimit < 1024 ||
      !Number.isSafeInteger(c.outputTokenLimit) || c.outputTokenLimit < 128 || c.outputTokenLimit > 8192 ||
      c.inputTokenLimit + c.outputTokenLimit > c.contextWindowTokens)
    throw Error('本地对话输入与输出须在已配置的 4096–131072 上下文窗口内。');
  if (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 1000 || c.timeoutMs > 180000)) throw Error('本地对话超时须为 1–180 秒。');
  if (c.temperature !== undefined && (!Number.isFinite(c.temperature) || c.temperature < 0 || c.temperature > 2)) throw Error('本地对话温度须为 0–2。');
  if (c.reasoningEffort !== undefined && c.reasoningEffort !== 'none') throw Error('本地对话思考设置只支持 none 或省略。');
  return Object.freeze({ baseUrl: url.origin + '/v1', model: c.model, contextWindowTokens: c.contextWindowTokens,
    inputTokenLimit: c.inputTokenLimit, outputTokenLimit: c.outputTokenLimit, timeoutMs: c.timeoutMs ?? 120000,
    ...(c.temperature === undefined ? {} : { temperature: c.temperature }), ...(c.reasoningEffort === undefined ? {} : { reasoningEffort: c.reasoningEffort }) });
}

export function localDialogueBudget(config: LocalDialogueConfiguration, target = config.inputTokenLimit) {
  const c = validateLocalDialogue(config);
  return inputBudgetInfo({ ...c, endpoint: c.baseUrl + '/chat/completions' }, Math.min(target, c.inputTokenLimit));
}

/** Separate from paid transport: never reads an API key, authorizes a paid call, redirects or retries. */
class LocalDialogueTransport extends ProviderTransport {
  constructor(private readonly local: LocalDialogueConfiguration, private readonly localFetch: typeof fetch) { super(); }
  override async request(config: EndpointConfig, _scope: TurnScope, operation: ProviderOperation, body: JsonRecord, signal: AbortSignal): Promise<JsonRecord> {
    checkAbort(signal);
    if (operation !== 'dialogue' || config.endpoint !== this.local.baseUrl + '/chat/completions' || config.model !== this.local.model)
      throw Error('本地对话传输不接受其他模型或后台操作。');
    const wire = { ...body, model: this.local.model };
    if (countRequestInput(wire) > localDialogueBudget(this.local).effectiveInputTokens) throw Error('required_context_exceeds_budget');
    if (body.stream !== false || body.max_tokens !== this.local.outputTokenLimit) throw Error('本地对话请求边界不一致。');
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.local.timeoutMs!)]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await abortable(this.localFetch(config.endpoint, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wire), signal: deadline }), deadline);
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw Error(`本地对话服务返回 HTTP ${response.status}。`); }
      reader = response.body?.getReader();
      if (!reader) throw Error('本地对话服务未返回内容。');
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) {
        const chunk = await abortable(reader.read(), deadline);
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 1024 * 1024) throw Error('本地对话返回内容超过限制。');
        chunks.push(chunk.value);
      }
      checkAbort(deadline);
      return object(JSON.parse(Buffer.concat(chunks, length).toString('utf8')));
    } catch (error) {
      checkAbort(signal);
      if (deadline.aborted) throw new DOMException('本地对话请求超时。', 'TimeoutError');
      throw error;
    } finally {
      // A stalled transport cleanup must not hold a cancelled or timed-out turn open.
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
}

/** Reuses the cloud adapter's scope, grounding, structured reply and visual-policy validation. */
export class LocalDialogueProvider extends JsonDialogueProvider {
  constructor(config: LocalDialogueConfiguration, visualPolicy?: () => { presets: readonly { id: string; label: string }[] },
    request: typeof fetch = fetch, clock?: () => ReturnType<typeof hostClock>, social?: SocialContextPort) {
    const c = validateLocalDialogue(config);
    // Fail-closed sentinels satisfy the shared provider contract; no cloud credential is captured here.
    const endpoint: EndpointConfig = { endpoint: c.baseUrl + '/chat/completions', model: c.model,
      apiKey: () => { throw Error('Local dialogue has no API credential'); }, authorizer: denyPaidCalls };
    super(endpoint, new LocalDialogueTransport(c, request), visualPolicy, clock,
      { protocol: 'openai-json', outputTokenLimit: c.outputTokenLimit, ...(c.temperature === undefined ? {} : { temperature: c.temperature }),
        ...(c.reasoningEffort === undefined ? {} : { reasoningEffort: c.reasoningEffort }) },social);
  }
}
