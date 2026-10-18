// Prove that a "持续启用" choice fades in instead of snapping, and that it still lands exactly on the
// value the contract requires.
//
// The tests in hidden-parameter-rig.test.mjs settle the parameter over many frames, so they pass
// whether or not a transition exists. This one samples the frames in between.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRig } from './rig-loader.mjs';

const rig = await createRig();
const catalog = JSON.parse(await readFile('desktop/assets/jellyfish/presets.json', 'utf8'));
const expressions = catalog.items.filter((i) => i.category === 'expression');
const idle = { state: 'idle', mouth: 0, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } };

// 30 frames a second, so one frame is 0.0333s and the 0.5s fade should complete in about 15.
const FRAME_MS = 33;
const frame = () => { rig.last = performance.now() - FRAME_MS; rig.updateView(idle); };

const target = [...expressions].sort((a, b) => (a.parameters?.length ?? 0) - (b.parameters?.length ?? 0))[0];
const parameter = target.parameters[0];
const baseline = rig.rigBaseline.get(parameter);
const offset = rig.expressionParameterValues.get(target.expressionName)?.get(parameter) ?? 0;
// What the contract in hidden-parameter-rig.test.mjs requires once the choice is fully applied.
const settled = Number((baseline + offset).toFixed(4));
const at = () => Number(rig.get(parameter).toFixed(4));

// The held value has to differ from the baseline, or "fading" and "not fading" are indistinguishable.
assert.notEqual(settled, Number(baseline.toFixed(4)), '选择的参数值应与基线不同，否则测不出过渡');

test('a held expression reaches its value gradually, not in one frame', () => {
  // Release anything an earlier run left held, then start the choice from a clean state.
  rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 100, enabledIds: [], emotions: {}, hiddenIds: [], hiddenValues: {} });
  frame();
  assert.equal(at(), Number(baseline.toFixed(4)), '未启用时应停在基线');

  assert.equal(rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 101, enabledIds: [], emotions: {}, hiddenIds: [target.id], hiddenValues: {} }), true);

  // First frame: the fade has barely started, so the value must still be near the baseline. This is
  // the assertion that fails if the write is instant.
  frame();
  const first = at();
  assert.notEqual(first, settled, '第一帧不应直接到达目标值');
  const firstProgress = Math.abs(first - baseline) / Math.abs(settled - baseline);
  assert.ok(firstProgress > 0 && firstProgress < 0.2,
    `第一帧应只推进一小部分，实际推进 ${(firstProgress * 100).toFixed(1)}%`);

  // It must move monotonically toward the target rather than overshooting or oscillating.
  let previous = first;
  for (let i = 0; i < 4; i++) {
    frame();
    const now = at();
    const toward = Math.abs(now - settled) <= Math.abs(previous - settled) + 1e-6;
    assert.ok(toward, `第 ${i + 2} 帧应向目标单调推进：${previous} -> ${now}（目标 ${settled}）`);
    previous = now;
  }

  // And it must be complete within the configured window, then stay put.
  for (let i = 0; i < 20; i++) frame();
  assert.equal(at(), settled, '约 0.5 秒后应精确落在目标值');
  console.log(`  ${target.label} / ${parameter}: baseline=${baseline} settled=${settled} ` +
    `firstFrame=${first} (${(firstProgress * 100).toFixed(1)}%)`);
});

test('the fade takes about as long as configured, in frames', () => {
  rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 200, enabledIds: [], emotions: {}, hiddenIds: [], hiddenValues: {} });
  frame();
  rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 201, enabledIds: [], emotions: {}, hiddenIds: [target.id], hiddenValues: {} });

  let framesToSettle = 0;
  for (let i = 0; i < 200; i++) {
    frame();
    framesToSettle = i + 1;
    if (at() === settled) break;
  }
  // 0.5s at 33ms is ~15 frames; allow a frame of slack either way for rounding.
  assert.ok(framesToSettle >= 13 && framesToSettle <= 18,
    `过渡应在约 15 帧内完成（0.5 秒 @33ms），实际 ${framesToSettle} 帧`);
  console.log(`  完成用了 ${framesToSettle} 帧（约 ${(framesToSettle * FRAME_MS / 1000).toFixed(2)} 秒）`);
});

test('unticking releases the expression gradually too', () => {
  // Start from fully held so the release has something to fade out of.
  rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 300, enabledIds: [], emotions: {}, hiddenIds: [target.id], hiddenValues: {} });
  for (let i = 0; i < 20; i++) frame();
  assert.equal(at(), settled, '先完全启用，再测淡出');

  assert.equal(rig.setAutomaticPolicy({ modelId: catalog.modelId, revision: 301, enabledIds: [], emotions: {}, hiddenIds: [], hiddenValues: {} }), true);

  // First frame after the untick: the value must have moved only slightly back toward the baseline.
  frame();
  const first = at();
  assert.notEqual(first, Number(baseline.toFixed(4)), '取消后第一帧不应直接回到基线');
  const released = Math.abs(first - baseline) / Math.abs(settled - baseline);
  assert.ok(released > 0.8 && released < 1,
    `取消后第一帧应只回落一小部分，实际仍保持 ${(released * 100).toFixed(1)}%`);

  // It must walk back monotonically rather than snapping or oscillating.
  let previous = first;
  for (let i = 0; i < 4; i++) {
    frame();
    const now = at();
    const toward = Math.abs(now - baseline) <= Math.abs(previous - baseline) + 1e-6;
    assert.ok(toward, `淡出第 ${i + 2} 帧应单调回到基线：${previous} -> ${now}`);
    previous = now;
  }

  for (let i = 0; i < 20; i++) frame();
  assert.equal(at(), Number(baseline.toFixed(4)), '约 0.5 秒后应精确回到基线');
  // And stop forcing once it has arrived, so the override set does not leak.
  assert.equal(rig.hiddenOverrides.size, 0, '淡出完成后不应再有强制覆盖');
  console.log(`  淡出: settled=${settled} 第一帧=${first} (保持 ${(released * 100).toFixed(1)}%) -> baseline=${baseline}`);
});

test.after(() => { rig.dispose(); });
