import test from 'node:test';
import assert from 'node:assert/strict';
import { firstUseCost } from '../../tools/minimax-first-synthesis.mjs';
test('first formal use includes the unlock only with complete successful business response and usable billing usage', () => {
  const valid = { output: { base_resp: { status_code: 0 }, data: { status: 2 } }, usage: { characters: 51 } };
  assert.equal(firstUseCost(valid), 9910200);
  assert.equal(firstUseCost({ ...valid, output: { ...valid.output, base_resp: { status_code: 1000 } } }), null);
  assert.equal(firstUseCost({ ...valid, output: { ...valid.output, data: { status: 1 } } }), null);
  for (const characters of [undefined, -1, 1.1, '51', Number.MAX_SAFE_INTEGER])
    assert.equal(firstUseCost({ ...valid, usage: { characters } }), null);
});
