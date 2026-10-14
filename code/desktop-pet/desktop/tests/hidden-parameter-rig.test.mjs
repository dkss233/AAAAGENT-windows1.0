// Prove that a "持续启用" choice really holds a rig parameter across frames, on whatever model is
// currently installed. Nothing here names a specific model, so replacing the rig keeps this valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRig } from './rig-loader.mjs';

const rig = await createRig();
const catalog = JSON.parse(await readFile('desktop/assets/jellyfish/presets.json', 'utf8'));
const expressions = catalog.items.filter((i) => i.category === 'expression');
const policy = (revision, hiddenIds, hiddenValues) => rig.setAutomaticPolicy({ modelId: catalog.modelId, revision, enabledIds: [], emotions: {}, hiddenIds, hiddenValues });
const idle = { state: 'idle', mouth: 0, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };
const frames = (n = 30) => { for (let i = 0; i < n; i++) { rig.last = performance.now() - 33; rig.updateView(idle); } };

// A preset to exercise: the one whose expression drives the fewest parameters keeps the assertions
// readable, and the first such preset is stable across rigs.
const target = [...expressions].sort((a, b) => (a.parameters?.length ?? 0) - (b.parameters?.length ?? 0))[0];
const targetParameter = target.parameters[0];
const baseline = rig.rigBaseline.get(targetParameter);
// The value the installed expression itself writes, read from the expression file.
const expressionValue = (() => {
  const values = rig.expressionParameterValues.get(target.expressionName);
  return values?.get(targetParameter);
})();

test('the installed catalog names a parameter for every expression', () => {
  assert.ok(expressions.length > 0, '当前模型应至少有一个表情');
  for (const item of expressions) {
    assert.ok(item.expressionName, item.label + ' 缺少 expressionName');
    assert.ok(Array.isArray(item.parameters) && item.parameters.length, item.label + ' 缺少 parameters');
  }
  console.log(JSON.stringify({ expressions: expressions.length, target: target.label, targetParameter, baseline, expressionValue }));
});

test('holding an expression keeps its parameter at the expression value across frames', () => {
  // One write is not enough: the render loop restores parameters every frame and reset() restores
  // them at each turn boundary, so the value has to be re-applied continuously.
  assert.ok(Number.isFinite(expressionValue), '应能从表情文件读出参数值');
  assert.equal(policy(1, [target.id], {}), true);
  frames(30);
  assert.equal(Number(rig.get(targetParameter).toFixed(4)), Number((baseline + expressionValue).toFixed(4)),
    '渲染若干帧后参数应保持在表情的值');
  rig.reset();
  frames(5);
  assert.equal(Number(rig.get(targetParameter).toFixed(4)), Number((baseline + expressionValue).toFixed(4)),
    'reset() 之后仍应保持');
});

test('an explicit hidden value overrides the expression value', () => {
  const explicit = Number((baseline + 0.6).toFixed(4));
  assert.equal(policy(2, [target.id], { [target.id]: 0.6 }), true);
  frames(20);
  assert.equal(Number(rig.get(targetParameter).toFixed(4)), explicit, '显式值应生效');
});

test('unticking stops holding the parameter', () => {
  assert.equal(policy(3, [], {}), true);
  frames(5);
  assert.equal(rig.hiddenOverrides.size, 0, '取消后不应再有强制覆盖');
  rig.reset();
  frames(5);
  assert.equal(Number(rig.get(targetParameter).toFixed(4)), Number(baseline.toFixed(4)), '取消后回到模型基线');
});

test('a held expression is not applied by emotion either', () => {
  const item = expressions[0];
  assert.equal(rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 4, enabledIds: [item.id],
    emotions: { warm: item.id }, hiddenIds: [item.id], hiddenValues: {} }), true);
  const speaking = { state: 'speaking', mouth: 0.3, expression: { emotion: 'warm', intensity: 1, delivery: '', gesture: null } };
  for (let i = 0; i < 60; i++) { rig.last = performance.now() - 33; rig.updateView(speaking); }
  assert.equal(rig.faceKey, '', '被持续启用的表情不应被情绪触发');
});

test('a policy referencing an unknown preset is refused', () => {
  assert.equal(rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 5, enabledIds: ['does-not-exist'], emotions: {}, hiddenIds: [] }), false);
});

test('a foreign model id is refused', () => {
  assert.equal(rig.setAutomaticPolicy({ modelId: 'other-model', revision: 6, enabledIds: [], emotions: {}, hiddenIds: [] }), false);
});

test.after(() => { rig.dispose(); });
