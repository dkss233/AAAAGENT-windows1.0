import { ModelError } from './config.mjs';

// Validate in JS before handing untrusted audio to the native recognizer.
export function pcmWave(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new ModelError(400, 'Local ASR expects a PCM16 mono WAV file.');
  }
  const end = buffer.readUInt32LE(4) + 8;
  if (end > buffer.length || end < 44) throw new ModelError(400, 'Truncated WAV file.');
  let format, data;
  for (let offset = 12; offset + 8 <= end;) {
    const name = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const begin = offset + 8;
    if (begin + size > end) throw new ModelError(400, 'Truncated WAV chunk.');
    if (name === 'fmt ' && size >= 16) {
      format = { type: buffer.readUInt16LE(begin), channels: buffer.readUInt16LE(begin + 2),
        sampleRate: buffer.readUInt32LE(begin + 4), blockAlign: buffer.readUInt16LE(begin + 12), bits: buffer.readUInt16LE(begin + 14) };
    }
    if (name === 'data') data = buffer.subarray(begin, begin + size);
    offset = begin + size + (size % 2);
  }
  if (!format || format.type !== 1 || format.channels !== 1 || format.bits !== 16 || format.blockAlign !== 2 ||
      format.sampleRate < 8000 || format.sampleRate > 48000 || !data?.length || data.length % 2) {
    throw new ModelError(400, 'Local ASR expects PCM16 mono WAV, 8–48 kHz.');
  }
  const count = data.length / 2;
  if (count / format.sampleRate > 60) throw new ModelError(400, 'Local ASR accepts at most 60 seconds per request; split using VAD.');
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = data.readInt16LE(i * 2) / 32768;
  return { samples, sampleRate: format.sampleRate };
}

export const audioTypes = { wav: 'audio/wav', pcm: 'audio/pcm', mp3: 'audio/mpeg', ogg: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac' };
