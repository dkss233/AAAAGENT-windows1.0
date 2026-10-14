// Prove the renderer applies runtime emotion assignments on whatever rig is currently installed.
// Nothing here names a specific model, so replacing the model keeps this test valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRig } from './rig-loader.mjs';

const rig = await createRig();
const catalog = JSON.parse(await readFile('desktop/assets/jellyfish/presets.json', 'utf8'));
const expressions = catalog.items.filter((i) => i.category === 'expression');
const [first, second] = expressions;
const view = (emotion) => ({ state: 'speaking', mouth: 0.3,
  expression: { emotion, intensity: 1, delivery: '', gesture: null } });
const frames = (emotion, n = 90) => { const v = view(emotion); for (let i = 0; i < n; i++) { rig.last = performance.now() - 33; rig.updateView(v); } };

test('每个导入的表情都带 expressionName 与 parameters', () => {
  assert.ok(expressions.length >= 2, '当前模型应至少有两个表情可用于配对测试');
  for (const item of expressions) {
    assert.ok(item.expressionName, item.label + ' 缺少 expressionName，情绪编辑器无法使用它');
    assert.ok(Array.isArray(item.parameters) && item.parameters.length, item.label + ' 缺少 parameters');
  }
  console.log(JSON.stringify({ expressions: expressions.map((i) => i.expressionName) }));
});

test('把情绪挂到某个表情后，该情绪会切到那个表情', () => {
  assert.equal(rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 1,
    enabledIds: [first.id], emotions: { warm: first.id }, hiddenIds: [] }), true);
  frames('warm');
  assert.equal(rig.faceKey, first.expressionName, 'warm 应切到「' + first.label + '」');
});

test('把情绪改挂到另一个表情后立即改由新表情生效', () => {
  assert.equal(rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 2,
    enabledIds: [first.id, second.id], emotions: { warm: second.id }, hiddenIds: [] }), true);
  frames('warm');
  assert.equal(rig.faceKey, second.expressionName, 'warm 应改由「' + second.label + '」使用');
});

test('未分配的情绪不触发表情', () => {
  assert.equal(rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 3,
    enabledIds: [first.id], emotions: {}, hiddenIds: [] }), true);
  frames('warm');
  assert.equal(rig.faceKey, '', '没有分配就不该切表情');
});

test('引用未知条目的策略被拒绝（失败关闭）', () => {
  assert.equal(rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 4,
    enabledIds: ['does-not-exist'], emotions: {}, hiddenIds: [] }), false);
});

test('外来模型 ID 被拒绝', () => {
  assert.equal(rig.setAutomaticPolicy({ modelId: 'other-model', revision: 5, enabledIds: [], emotions: {}, hiddenIds: [] }), false);
});

test.after(() => { rig.dispose(); });
