// End-to-end check of the custom TTS path against a real HTTP server speaking the OpenAI shape.
//
// The unit tests prove the address policy and the settings validator; this proves the request that
// actually leaves the process — path, body fields and the stored audio — so the feature is verified
// rather than assumed. The server is a throwaway loopback listener, so nothing external is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createCustomTtsProvider } from '../../providers/local-speech.js';

/** Minimal PCM16 mono WAV of `samples` samples, so inspectPcmWav accepts it. */
function wav(samples: number, rate = 24000): Buffer {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / 12) * 8000), 44 + i * 2);
  return bytes;
}

test('a custom supplier receives the OpenAI speech request and its audio reaches the media store', async () => {
  const seen: { method?: string | undefined; url?: string | undefined; contentType?: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, contentType: req.headers['content-type'], body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'audio/wav' });
      res.end(wav(24000));  // one second at 24 kHz
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const scope = { characterId: 'companion', sessionId: 's', turnId: 't', generation: 1 };
  const stored: { bytes: Buffer; mimeType: string }[] = [];
  const store = {
    async put(_scope: unknown, bytes: Uint8Array, mimeType: string) { stored.push({ bytes: Buffer.from(bytes), mimeType }); return { id: 'a1', mimeType, bytes: bytes.length }; },
    async read() { throw Error('unused'); }, async releaseScope() {},
  };

  try {
    const provider = createCustomTtsProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'my-tts-1',
      voice: 'xiaorou', provider: 'myprovider', credentialRef: 'ref-1' }, store as never);
    const result = await provider.synthesize({ scope, text: '你好呀，今天过得开心吗？',
      expression: { emotion: 'happy', intensity: 0.5, delivery: '', gesture: null } }, new AbortController().signal);

    assert.equal(seen.length, 1, '自定义服务商应恰好收到一次请求');
    const request = seen[0]!;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/audio/speech', '请求路径必须是 {baseUrl}/audio/speech');
    assert.equal(request.body.model, 'my-tts-1');
    assert.equal(request.body.voice, 'xiaorou');
    assert.equal(request.body.input, '你好呀，今天过得开心吗？', '中文必须原样送达（UTF-8），不能被编码破坏');
    assert.equal(request.body.response_format, 'wav');
    assert.equal(stored.length, 1, '合成音频必须写入媒体存储');
    assert.equal(stored[0]!.mimeType, 'audio/wav');
    assert.ok(result.durationMs! > 900 && result.durationMs! < 1100, '时长应来自真实 WAV，实际 ' + result.durationMs);
    console.log(`  请求: POST ${request.url}  model=${request.body.model} voice=${request.body.voice}`);
    console.log(`  中文往返完整: "${request.body.input}"`);
    console.log(`  音频: ${stored[0]!.bytes.length} 字节, ${Math.round(result.durationMs!)} ms`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the endpoint refuses a supplier whose address is not a bare /v1 origin', async () => {
  const store = { async put() { throw Error('unused'); }, async read() { throw Error('unused'); }, async releaseScope() {} };
  for (const baseUrl of ['http://127.0.0.1:1/v1?x=1', 'http://user:pw@127.0.0.1:1/v1', 'file:///v1', 'http://127.0.0.1:1/other'])
    assert.throws(() => createCustomTtsProvider({ baseUrl, model: 'm', voice: 'v', provider: 'p1', credentialRef: 'r' }, store as never), baseUrl);
  console.log('  4 种非法地址在建 provider 时即被拒绝');
});
