// Confirm the presetId fixes: semantic nulls are absorbed, and no presetId means the emotion's
// face is free to apply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePresentationIntent } from '../../contracts/presentation.ts';

const cases = [
  { name: 'absent', expression: { emotion: 'happy', intensity: 0.7, delivery: '', gesture: null } },
  { name: 'string null', expression: { emotion: 'happy', intensity: 0.7, delivery: '', gesture: null, presetId: 'null' } },
  { name: 'real null', expression: { emotion: 'happy', intensity: 0.7, delivery: '', gesture: null, presetId: null } },
  { name: 'empty string', expression: { emotion: 'happy', intensity: 0.7, delivery: '', gesture: null, presetId: '' } },
];

test('a presetId that means "none" must not suppress the emotion', () => {
  for (const item of cases) {
    const resolved = normalizePresentationIntent(item.expression);
    console.log('  ' + item.name.padEnd(14) + ' -> emotion=' + resolved.emotion
      + '  hasPresetId=' + Object.hasOwn(resolved, 'presetId')
      + (Object.hasOwn(resolved, 'presetId') ? '  presetId=' + JSON.stringify(resolved.presetId) : ''));
    // Whatever the shape, the emotion must survive: the renderer falls back to the emotion's face
    // when a named preset is absent or unusable.
    assert.equal(resolved.emotion, 'happy', item.name + ': 情绪应保留');
    if (Object.hasOwn(resolved, 'presetId')) {
      assert.notEqual(typeof resolved.presetId, 'string', item.name + ': 语义空值不应变成字符串');
    }
  }
});

test('a real preset id is preserved', () => {
  const resolved = normalizePresentationIntent({ emotion: 'happy', intensity: 0.5, delivery: '', gesture: null, presetId: 'exp-zzz' });
  console.log('  真实 id -> ' + JSON.stringify(resolved.presetId));
  assert.equal(resolved.presetId, 'exp-zzz');
});

test('an unknown preset id collapses to explicit neutral, not to a string', () => {
  const resolved = normalizePresentationIntent({ emotion: 'happy', intensity: 0.5, delivery: '', gesture: null, presetId: 'not-a-preset' });
  console.log('  未知 id -> ' + JSON.stringify(resolved.presetId));
  assert.equal(resolved.presetId, null);
});

test('the catalog ships a usable enabled set for this rig', async () => {
  const catalog = JSON.parse(await readFile('desktop/assets/jellyfish/presets.json', 'utf8'));
  const stored = JSON.parse(await readFile('D:\\AAAAGENT\\windows\\.local\\data\\presentation-settings.json', 'utf8')).models['local-model'];
  console.log('  emotions: ' + JSON.stringify(stored.emotions));
  for (const [emotion, id] of Object.entries(stored.emotions)) {
    const item = catalog.items.find((i) => i.id === id);
    assert.ok(item?.expressionName, emotion + ' 应映射到真实表情');
    assert.ok(stored.enabledIds.includes(id), emotion + ' 的条目应在 enabledIds 里');
    console.log('    ' + emotion.padEnd(10) + ' -> ' + item.expressionName);
  }
});
