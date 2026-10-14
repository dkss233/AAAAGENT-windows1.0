import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byteSafeWhisperVocabulary, decodeWhisperBytes } from '../src/whisper-vocabulary.mjs';

test('Chinese and emoji bytes split across BPE tokens survive native UTF-8 filtering', () => {
  const text = '测试语音 🌊 abc';
  const bytes = Buffer.from(text, 'utf8');
  // Every byte is its own BPE token; most Chinese/emoji fragments alone are
  // invalid UTF-8 and were discarded by the native normalizer.
  const original = [...bytes].map((byte, id) => `${Buffer.from([byte]).toString('base64')} ${id}`).join('\n');
  const prepared = byteSafeWhisperVocabulary(original);
  const transported = prepared.trim().split('\n').map((line, id) => {
    const [encoded, tokenId] = line.split(' ');
    assert.equal(Number(tokenId), id);
    const nativeToken = Buffer.from(encoded, 'base64').toString('utf8');
    assert.match(nativeToken, /^[0-9a-f]+$/);
    return nativeToken;
  }).join('');
  assert.equal(decodeWhisperBytes(transported), text);
});

test('Invalid vocabularies and malformed native transport fail instead of silently dropping text', () => {
  for (const value of ['', 'not-base64 1', 'IQ== 1\nIg== 1', 'A=== 0']) assert.throws(() => byteSafeWhisperVocabulary(value), error => error.code === 'model_not_ready');
  assert.throws(() => decodeWhisperBytes('e6b58'), /invalid byte-safe/);
  assert.throws(() => decodeWhisperBytes('plain native text'), /invalid byte-safe/);
  assert.equal(decodeWhisperBytes(''), '');
  assert.equal(byteSafeWhisperVocabulary('= 50256'), '= 50256\n');
});
