// Does the cursor-follow button actually move the eyes, head and body?
// Uses the installed rig, so the assertions are about the real model's parameters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRig } from './rig-loader.mjs';

const rig = await createRig();
const frames = (n = 60) => { for (let i = 0; i < n; i++) { rig.last = performance.now() - 33; rig.updateView({ state: 'idle', mouth: 0, expression: { emotion: 'neutral', intensity: 0, delivery: '', gesture: null } }); } };
const read = (...ids) => Object.fromEntries(ids.map((id) => [id, Number(rig.get(id).toFixed(4))]));
const EYE = ['ParamEyeBallX', 'ParamEyeBallY'];
const HEAD = ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ'];
const BODY = ['ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ'];

test('reports what the rig declares', () => {
  console.log(JSON.stringify({ hasLook: typeof rig.setLookTarget === 'function',
    eyes: EYE.filter((id) => rig.parameterIndices.has(id)),
    head: HEAD.filter((id) => rig.parameterIndices.has(id)),
    body: BODY.filter((id) => rig.parameterIndices.has(id)) }));
  assert.equal(typeof rig.setLookTarget, 'function', '渲染器应提供 setLookTarget');
});

test('look mode drives eyes, head and body toward the cursor', () => {
  // Neutral first, then look hard left/up. The cursor point is -1..1 with y inverted.
  rig.setLookTarget(0, 0, false); frames(40);
  const rest = read(...EYE, ...HEAD, ...BODY);
  console.log('静止: ' + JSON.stringify(rest));

  rig.setLookTarget(-1, -1, true); frames(60);
  const looking = read(...EYE, ...HEAD, ...BODY);
  console.log('注视左上: ' + JSON.stringify(looking));

  const moved = (ids) => ids.filter((id) => Math.abs(looking[id] - rest[id]) > 0.01);
  const eyeMoved = moved(EYE), headMoved = moved(HEAD), bodyMoved = moved(BODY);
  console.log('变化: 眼=' + JSON.stringify(eyeMoved) + ' 头=' + JSON.stringify(headMoved) + ' 身=' + JSON.stringify(bodyMoved));
  assert.ok(eyeMoved.length > 0, '眼睛参数应随鼠标变化');
  assert.ok(headMoved.length > 0, '头部参数应随鼠标变化');
  assert.ok(bodyMoved.length > 0, '身体参数应随鼠标变化');
});

test('the opposite side moves the rig the other way', () => {
  rig.setLookTarget(1, 1, true); frames(60);
  const right = read(...EYE, ...HEAD);
  rig.setLookTarget(-1, -1, true); frames(60);
  const left = read(...EYE, ...HEAD);
  console.log('右=' + JSON.stringify(right) + '\n左=' + JSON.stringify(left));
  // Horizontal gaze and yaw must flip sign; that is what proves the mapping is not one-directional.
  assert.ok(Math.sign(right.ParamEyeBallX) !== Math.sign(left.ParamEyeBallX), '眼珠左右应反向');
  assert.ok(Math.sign(right.ParamAngleX) !== Math.sign(left.ParamAngleX), '头部左右应反向');
});

test('turning look mode off returns the rig to rest', () => {
  rig.setLookTarget(-1, -1, true); frames(60);
  const looking = read(...EYE, ...HEAD);
  rig.setLookTarget(0, 0, false); frames(90);
  const rest = read(...EYE, ...HEAD);
  console.log('关闭前=' + JSON.stringify(looking) + '\n关闭后=' + JSON.stringify(rest));
  const stillLooking = Object.keys(rest).filter((id) => Math.abs(rest[id] - looking[id]) > 0.05);
  assert.ok(stillLooking.length > 0, '关闭后应回到静止姿态');
  assert.ok(Math.abs(rest.ParamEyeBallX) < 0.05 && Math.abs(rest.ParamEyeBallY) < 0.05, '眼珠应回到正中');
});

test('cursor following works without the proc-head / proc-body catalog rows', () => {
  // The regression this guards: an imported model has neither row, so a look that depended on them
  // would do nothing at all. Only proc-blink is enabled here, mirroring a fresh model install.
  const accepted = rig.setAutomaticPolicy({ modelId: rig.catalog?.modelId ?? 'local-model', revision: 9001,
    enabledIds: [], emotions: {}, hiddenIds: [], hiddenValues: {} });
  console.log('策略接受: ' + accepted + '  automaticIds=' + JSON.stringify([...(rig.automaticIds ?? [])]));
  rig.setLookTarget(-0.8, -0.6, true); frames(60);
  const looking = read(...EYE, ...HEAD, ...BODY);
  console.log('无 proc-* 条目时的注视结果: ' + JSON.stringify(looking));
  const moving = [...EYE, ...HEAD, ...BODY].filter((id) => Math.abs(looking[id]) > 0.01);
  assert.ok(moving.length > 0, '没有 proc-head/proc-body 时注视仍应生效');
});
