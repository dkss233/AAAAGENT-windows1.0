// Console route for the operator-defined TTS supplier.
//
// The reviewed catalogue is a closed list, so before this route the only way to add a supplier was to
// edit config.json by hand and re-pin. A change here goes through the same transactional editor the
// configure-*.mjs CLIs use (lock + backups + activation hash), because a config whose recorded hash no
// longer matches is refused at startup — a half-applied edit would brick the launch.
//
// The address is the operator's own choice, so the response always echoes the exact URL that will be
// called, and the UI is expected to show it before submitting. validateCustomTts refuses schemes,
// embedded credentials, query strings and paths other than /v1.
import type { IncomingMessage } from 'node:http';
import { ManagementError } from '../contracts/management.js';
import { validateCustomTts, type CustomTtsConfiguration } from '../providers/local-speech.js';
import { updateProviderConfiguration } from '../providers/configuration-edit.js';

export interface CustomTtsManagement {
  /** Current saved block, if any, plus the address the request will actually use. */
  status(): { configured: boolean; provider?: string; baseUrl?: string; requestUrl?: string; model?: string; voice?: string; timeoutMs?: number };
  /** Validates and persists; `null` clears the block and returns to the reviewed suppliers. */
  save(value: unknown): Promise<{ configured: boolean; requestUrl?: string }>;
}

/** Validation failures are this route's normal rejection path, so they must answer 400 with the reason
 *  rather than becoming an opaque 500 — the operator needs to read why the address was refused. */
function validated(value: unknown): CustomTtsConfiguration {
  try { return validateCustomTts(value); }
  catch (error) { throw new ManagementError('invalid_request', (error as Error)?.message ?? '自定义语音设置无效。'); }
}

export function createCustomTtsManagement(configFile: string, initial?: unknown): CustomTtsManagement {
  const describe = (config: CustomTtsConfiguration) => {
    const valid = validateCustomTts(config);
    return { configured: true, provider: valid.provider, baseUrl: valid.baseUrl,
      requestUrl: valid.baseUrl + '/audio/speech', model: valid.model, voice: valid.voice,
      timeoutMs: valid.timeoutMs ?? 120000 } as const;
  };
  let cached: CustomTtsConfiguration | undefined;
  try { if (initial !== undefined) cached = validateCustomTts(initial); } catch { cached = undefined; }
  return {
    status() { return cached ? describe(cached) : { configured: false }; },
    async save(value) {
      if (value === null || value === undefined) {
        await updateProviderConfiguration(configFile, (config) => { delete config.customTts; return config; });
        cached = undefined;
        return { configured: false };
      }
      // Validated before the write so a bad address is refused while the operator is still on the page.
      const accept = validated(value);
      await updateProviderConfiguration(configFile, (config) => { config.customTts = accept; return config; });
      cached = accept;
      return { configured: true, requestUrl: accept.baseUrl + '/audio/speech' };
    },
  };
}

/** Seeds the in-memory view from the configuration the backend actually launched with. */
export function customTtsStatus(value: unknown): ReturnType<CustomTtsManagement['status']> {
  if (!value || typeof value !== 'object') return { configured: false };
  try { const validated = validateCustomTts(value); return { configured: true, provider: validated.provider,
    baseUrl: validated.baseUrl, requestUrl: validated.baseUrl + '/audio/speech', model: validated.model,
    voice: validated.voice, timeoutMs: validated.timeoutMs ?? 120000 }; }
  catch { return { configured: false }; }
}

export async function customTtsRoute(req: IncomingMessage, url: URL, port: CustomTtsManagement | undefined,
  readBody: () => Promise<unknown>, respond: (value: unknown) => void): Promise<boolean> {
  if (url.pathname !== '/api/tts/custom') return false;
  if (!port) throw new ManagementError('unavailable', '当前版本尚未接入自定义语音设置。');
  if (req.method === 'GET') { respond(port.status()); return true; }
  if (req.method === 'PUT') { respond(await port.save(await readBody())); return true; }
  if (req.method === 'DELETE') { respond(await port.save(null)); return true; }
  throw new ManagementError('invalid_request', '自定义语音设置只支持查看、保存和清除。');
}
