import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Fixed reviewed release assets, checked before the native loader sees any model. */
export const WAKE_MODEL_FILES = {
  "decoder.onnx": {
    "bytes": 759829,
    "sha256": "63a22dd60f40fff082ac3e09afa507f6787da36df76ded2fbe145fa233e22c21"
  },
  "encoder.onnx": {
    "bytes": 4600657,
    "sha256": "2ca84d6bfe73e1ea3c9c49f600f7cad1c9ddd423c53c906b8bfe802444dd78d5"
  },
  "joiner.onnx": {
    "bytes": 86629,
    "sha256": "190d4067b4cc20b72a42a1916e69d92052000fb7051a427ebb1bc72a69207dc1"
  },
  "tokens.txt": {
    "bytes": 1928,
    "sha256": "2d3f32311f9b692b964da3c90e830258d3e78e013cb0c992dbfb15cd5a1a71b0"
  },
  "silero_vad.onnx": {
    "bytes": 643854,
    "sha256": "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6"
  }
} as const;
export async function verifyWakeModels(directory: string): Promise<void> {
  for (const [name, expected] of Object.entries(WAKE_MODEL_FILES)) {
    const bytes = await readFile(join(directory, name));
    if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw Error('Local wake model fingerprint mismatch');
  }
}
