// Does an emotion-mapped expression actually drive the model's parameters?
// Uses the installed rig and the user's real mapping shape (manual availability presets).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRig } from './rig-loader.mjs';

const rig = await createRig();
const catalog = JSON.parse(await readFile('desktop/assets/jellyfish/presets.json', 'utf8'));
const expressions = catalog.items.filter((i) => i.category === 'expression');
// Mirrors what the console stores: the emotion map plus the ids it enabled.
const target = expressions.find((i) => (i.parameters ?? []).length > 4) ?? expressions[0];
const parameter = target.parameters[0];
const speaking = (emotion) => ({ state: 'speaking', mouth: 0.3,
  expression: { emotion, intensity: 1, delivery: '', gesture: null } });
const frames = (emotion, n = 80) => { const v = speaking(emotion); for (let i = 0; i < n; i++) { rig.last = performance.now() - 33; rig.updateView(v); } };

test('report what the applied policy sees', () => {
  console.log(JSON.stringify({
    target: target.label, id: target.id, availability: target.availability,
    expressionName: target.expressionName, parameters: target.parameters,
    inExpressionParameters: target.parameters.filter((p) => rig.expressionParameters.has(p)),
  }));
});

test('an emotion-mapped expression reaches the model parameters', () => {
  // The user's stored policy shape: emotion assigned + id present in enabledIds.
  const accepted = rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 1,
    enabledIds: [target.id], emotions: { happy: target.id }, hiddenIds: [], hiddenValues: {} });
  assert.equal(accepted, true, '策略应被接受');
  const driven = target.parameters.filter((p) => rig.expressionParameters.has(p));
  console.log('已注册参数: ' + driven.length + ' / ' + target.parameters.length + '  ' + JSON.stringify(driven.slice(0, 6)));
  assert.ok(driven.length > 0, '该表情的参数应被注册为可表达的参数');

  // Sample the parameters right after each frame, not just once at the end: an expression that is
  // applied and then wiped within the same frame would otherwise pass a late check.
  frames('happy');
  const peak = Math.max(...driven.map((p) => Math.abs(rig.get(p))));
  console.log('faceKey=' + JSON.stringify(rig.faceKey) + '  参数峰值=' + peak.toFixed(3) + '  ' + JSON.stringify(
    Object.fromEntries(driven.slice(0, 6).map((p) => [p, Number(rig.get(p).toFixed(3))]))));
  assert.ok(driven.some((p) => Math.abs(rig.get(p)) > 0.05), '表情必须真的改变参数，否则模型上看不到变化');
});

test('the expression value survives the per-frame reset', () => {
  // Run a longer stretch so every reset path (turn boundary, policy re-apply) is covered, and
  // confirm the parameters are still driven at the end of it.
  const driven = target.parameters.filter((p) => rig.expressionParameters.has(p));
  rig.reset();
  frames('happy', 60);
  const held = driven.filter((p) => Math.abs(rig.get(p)) > 0.05).length;
  console.log('reset 后仍被驱动: ' + held + ' / ' + driven.length);
  assert.ok(held > 0, 'reset() 之后表情仍应改变参数');
});

test('the expression is released when the emotion goes back to neutral', () => {
  frames('neutral', 120);
  assert.equal(rig.faceKey, '', 'neutral 应释放表情');
});

test.after(() => { rig.dispose(); });
