import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { encode } from 'silk-wasm';
import { inspectPcmWav } from '../dist/media/wav.js';

// Isolated preparation only. No credentials, fetch, database, TTS, disk or playback.
// Wire: Tencent/openclaw-weixin 7c04adc3e95775efd661ab9fba0626d86d237713.
// Outbound native VOICE is experimental: issue 215 reports API success without a visible bubble.
const valid = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !v.includes('\0');
const fail = () => { throw Error('Invalid native voice probe preparation'); };
const check = signal => { if (signal?.aborted) throw Error('Native voice probe cancelled'); };

/**
 * Input WAV remains caller-owned. I must guard one real attempt externally and add the
 * existing base_info/auth headers to these request bodies. Never log returned wire objects.
 * Requires the existing project build (dist/media/wav.js) and pinned silk-wasm 3.7.1.
 */
export async function prepareNativeVoiceProbe({ wav, userId, signal }) {
  let pcm, silk, key, body, tail, encrypted;
  try {
    check(signal);
    if (!(wav instanceof Uint8Array) || wav.length > 1024 * 1024 || !valid(userId, 1000)) fail();
    const audio = inspectPcmWav(wav);
    if (audio.sampleRate !== 24000 || audio.channels !== 1 || audio.bits !== 16 || audio.durationMs < 40 || audio.durationMs > 10000) fail();
    // Preserve a partial last frame instead of letting the encoder truncate speech.
    const frameBytes = 960;
    pcm = new Uint8Array(Math.ceil(audio.data.length / frameBytes) * frameBytes);
    pcm.set(audio.data);
    const playtime = pcm.length / 48;
    const result = await encode(pcm, 24000);
    silk = result.data;
    check(signal);
    if (!silk?.length || silk.length > 128 * 1024 || silk[0] !== 2 || Buffer.from(silk.subarray(1, 10)).toString('ascii') !== '#!SILK_V3') fail();
    key = randomBytes(16);
    const cipher = createCipheriv('aes-128-ecb', key, null);
    body = cipher.update(silk); tail = cipher.final(); encrypted = Buffer.concat([body, tail]);
    const expectedCipherBytes = (Math.floor(silk.length / 16) + 1) * 16;
    if (encrypted.length !== expectedCipherBytes) fail();
    const uploadRequest = {
      filekey: randomBytes(16).toString('hex'), media_type: 4, to_user_id: userId,
      rawsize: silk.length, rawfilemd5: createHash('md5').update(silk).digest('hex'),
      filesize: encrypted.length, no_need_thumb: true, aeskey: key.toString('hex'),
    };
    const metadata = Object.freeze({ codec: 'silk', sampleRate: 24000, bitsPerSample: 16, channels: 1,
      playtime, paddingMs: playtime - audio.durationMs, rawBytes: silk.length, encryptedBytes: encrypted.length,
      nativePlaybackVerified: false });
    const ciphertext = encrypted;
    let disposed = false, built = false, message;
    const dispose = () => {
      disposed = true; ciphertext.fill(0);
      uploadRequest.aeskey = ''; uploadRequest.filekey = ''; uploadRequest.to_user_id = '';
      if (message) {
        message.msg.context_token = ''; message.msg.to_user_id = '';
        message.msg.item_list[0].voice_item.media.aes_key = '';
        message.msg.item_list[0].voice_item.media.encrypt_query_param = '';
      }
    };
    const buildMessage = ({ downloadParam, contextToken, clientId }) => {
      check(signal);
      if (disposed || built || !valid(downloadParam, 8192) || !valid(contextToken, 8192) || !valid(clientId, 256)) fail();
      built = true;
      const hexBytes = Buffer.from(uploadRequest.aeskey, 'ascii');
      try {
        message = { msg: { from_user_id: '', to_user_id: userId, client_id: clientId, message_type: 2,
          message_state: 2, context_token: contextToken, item_list: [{ type: 3, voice_item: {
            media: { encrypt_query_param: downloadParam, aes_key: hexBytes.toString('base64'), encrypt_type: 1 },
            encode_type: 6, sample_rate: 24000, bits_per_sample: 16, playtime,
          } }] } };
      } finally { hexBytes.fill(0); }
      return message;
    };
    encrypted = undefined; // Ownership transfers to the returned disposable preparation.
    return { encrypted: ciphertext, uploadRequest, metadata, buildMessage, dispose };
  } catch {
    check(signal);
    throw Error('Native voice probe preparation failed');
  } finally {
    pcm?.fill(0); silk?.fill(0); key?.fill(0); body?.fill(0); tail?.fill(0); encrypted?.fill(0);
  }
}
