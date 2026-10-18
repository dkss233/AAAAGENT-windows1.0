import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWheel, createWheelZoom, syncWheelZoom, windowZoomOf, BASE_MODEL_WIDTH, SCALE_MAX, SCALE_MIN } from '../zoom-wheel.mjs';

// A wheel notch of -100 zooms in by exp(1/6) ~= 1.181; +100 zooms out by the same factor.
const IN = -100, OUT = 100;
const zoomIn = (state, moveMode, times = 1) => {
  let last = null;
  for (let i = 0; i < times; i++) last = applyWheel(state, { moveMode, deltaY: IN });
  return last;
};

test('each mode seeds from its own source, never from the other mode', () => {
  // The shell has a resized window and an unzoomed model.
  const state = createWheelZoom({ characterScale: 1, petWidth: 360 * 2 + 20 });
  assert.equal(state.characterScale, 1);
  assert.equal(state.windowZoom, 2);

  // ...and the reverse: a zoomed model inside the default window.
  const other = createWheelZoom({ characterScale: 2.5, petWidth: 360 + 20 });
  assert.equal(other.characterScale, 2.5);
  assert.equal(other.windowZoom, 1);
});

test('zooming the window does not move the model zoom', () => {
  const state = createWheelZoom({ characterScale: 1, petWidth: 360 + 20 });
  zoomIn(state, false, 3);
  assert.ok(state.windowZoom > 1, '窗口缩放应该变大');
  assert.equal(state.characterScale, 1, '模型缩放必须保持 1');
});

test('zooming the model does not move the window zoom', () => {
  const state = createWheelZoom({ characterScale: 1, petWidth: 360 + 20 });
  zoomIn(state, true, 3);
  assert.ok(state.characterScale > 1, '模型缩放应该变大');
  assert.equal(state.windowZoom, 1, '窗口缩放必须保持 1');
});

test('window resize then model zoom continues from the model scale, not the window scale', () => {
  // This is the reported sequence: resize the window first, then zoom the model.
  const state = createWheelZoom({ characterScale: 1, petWidth: 360 + 20 });
  zoomIn(state, false, 20);                       // window driven to its maximum
  assert.equal(state.windowZoom, SCALE_MAX);
  assert.equal(state.characterScale, 1, '放大窗口不应改动模型缩放');

  const action = zoomIn(state, true);
  assert.equal(action.type, 'set_character_scale');
  // One notch from 1, nowhere near the window's 2.5 — the old shared accumulator jumped straight there.
  assert.ok(action.scale > 1 && action.scale < 1.3, '模型应从 1 开始缩放，实际 ' + action.scale);
});

test('model zoom then window resize continues from the window zoom, not the model scale', () => {
  // The reverse reported sequence.
  const state = createWheelZoom({ characterScale: 1, petWidth: 360 + 20 });
  zoomIn(state, true, 20);                        // model driven to its maximum
  assert.equal(state.characterScale, SCALE_MAX);
  assert.equal(state.windowZoom, 1, '放大模型不应改动窗口缩放');

  const action = zoomIn(state, false);
  assert.equal(action.type, 'zoom_model');
  assert.ok(action.scale > 1 && action.scale < 1.3, '窗口应从 1 开始缩放，实际 ' + action.scale);
});

test('both accumulators clamp to the shell bounds and report when nothing changes', () => {
  const state = createWheelZoom({ characterScale: 1, petWidth: 360 + 20 });
  zoomIn(state, true, 50);
  assert.equal(state.characterScale, SCALE_MAX);
  assert.equal(applyWheel(state, { moveMode: true, deltaY: IN }), null, '到顶后不应再发消息');

  for (let i = 0; i < 50; i++) applyWheel(state, { moveMode: true, deltaY: OUT });
  assert.equal(state.characterScale, SCALE_MIN);

  zoomIn(state, false, 50);
  assert.equal(state.windowZoom, SCALE_MAX);
  assert.equal(applyWheel(state, { moveMode: false, deltaY: IN }), null);
});

test('a reset re-seeds both values from the shell', () => {
  const state = createWheelZoom({ characterScale: 2, petWidth: 360 * 2 + 20 });
  applyWheel(state, { moveMode: true, deltaY: IN });
  syncWheelZoom(state, { characterScale: 1, petWidth: 360 + 20 });
  assert.equal(state.characterScale, 1);
  assert.equal(state.windowZoom, 1);
});

test('window zoom is recovered from the reported pane width, and stays in range', () => {
  assert.equal(windowZoomOf({ petWidth: 360 + 20 }), 1);
  assert.equal(windowZoomOf({ petWidth: 720 + 20 }), 2);
  assert.equal(windowZoomOf({}), 1, '缺少宽度时回退到 1');
  assert.equal(windowZoomOf({ petWidth: 1e9 }), SCALE_MAX, '异常宽度要被夹住');
  assert.equal(windowZoomOf({ petWidth: 0 }), SCALE_MIN);
  assert.equal(BASE_MODEL_WIDTH, 360);
});
