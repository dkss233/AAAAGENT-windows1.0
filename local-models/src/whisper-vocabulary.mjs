import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelError } from './config.mjs';

// sherpa 1.13.8 applies RemoveInvalidUtf8Sequences to each Whisper BPE token.
// Chinese characters can span tokens, so this deletes correctly predicted
// bytes. Keep token IDs and model weights untouched, encode token bytes as
// ASCII hex for native transport, then decode once after concatenation.
// Source: sherpa-onnx v1.13.8 offline-recognizer-whisper-impl.h Convert().
const cache = fileURLToPath(new URL('../../.local/local-models/cache/whisper-utf8/', import.meta.url));

export function byteSafeWhisperVocabulary(source) {
  const ids = new Set();
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).map(line => {
    const match = /^([A-Za-z0-9+/]+={0,2}|=)\s+(\d+)$/.exec(line);
    if (!match || ids.has(match[2])) throw new ModelError(503, 'Whisper requires an unmodified base64 token vocabulary.', 'model_not_ready');
    ids.add(match[2]);
    // The official export represents the empty token as '=' (ID 50256).
    if (match[1] === '=') return `= ${match[2]}`;
    const bytes = Buffer.from(match[1], 'base64');
    if (!bytes.length || bytes.toString('base64') !== match[1]) throw new ModelError(503, 'Whisper token vocabulary contains invalid base64.', 'model_not_ready');
    return `${Buffer.from(bytes.toString('hex'), 'ascii').toString('base64')} ${match[2]}`;
  });
  if (!lines.length) throw new ModelError(503, 'Whisper token vocabulary is empty.', 'model_not_ready');
  return lines.join('\n') + '\n';
}

export function decodeWhisperBytes(text) {
  if (typeof text !== 'string' || text.length % 2 || /[^0-9a-f]/i.test(text)) {
    throw new ModelError(502, 'Whisper returned invalid byte-safe text.', 'native_result_invalid');
  }
  return Buffer.from(text, 'hex').toString('utf8');
}

export async function whisperVocabulary(tokensPath) {
  const source = await readFile(tokensPath, 'utf8');
  const hash = createHash('sha256').update('whisper-byte-safe-v1\n').update(source).digest('hex');
  const path = resolve(cache, `${hash}.tokens.txt`);
  const prepared = byteSafeWhisperVocabulary(source);
  await mkdir(cache, { recursive: true });
  try { if (await readFile(path, 'utf8') === prepared) return path; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const partial = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(partial, prepared, { flag: 'wx' });
    await rename(partial, path);
  } finally { await unlink(partial).catch(() => {}); }
  return path;
}
