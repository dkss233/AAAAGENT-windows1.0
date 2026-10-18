// Wheel-zoom state for the pet window.
//
// The wheel drives two different things and they must not share a value:
//   movement mode ON  -> the model scales inside a fixed pane   (shell: set_character_scale)
//   movement mode OFF -> the whole window resizes               (shell: zoom_model)
// The shell keeps these as two independent pieces of state (prefs.characterScale and prefs.width).
// The renderer used to keep ONE accumulator for both and feed it to whichever message the mode
// selected, so a scale chosen in one mode decided the starting point in the other: after resizing the
// window, switching to movement mode snapped the model to the size the window implied, and the other
// way round. Keeping the two numbers here, with each seeded from its own source, is what fixes that.
//
// Pure on purpose: this is the part that can be tested without a window, a canvas or a shell.

export const SCALE_MIN = 0.5, SCALE_MAX = 2.5;
// The shell sizes the window as round(360 * scale) and reports it as petWidth = width + 20, so the
// model box the scale refers to is (petWidth - 20). See electron/layout.mjs and the zoom_model case.
export const BASE_MODEL_WIDTH = 360;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** The model scale the shell currently holds, used to seed movement-mode zoom. */
export function characterScaleOf(displayConfig) {
  return finite(displayConfig?.characterScale) ?? 1;
}

/** The window zoom the shell currently holds, recovered from the pane's own width.
 *  Derived from petWidth rather than from the model scale: those are different quantities, and using
 *  one for the other is the bug this module exists to prevent. */
export function windowZoomOf(displayConfig) {
  const width = finite(displayConfig?.petWidth);
  return width === undefined ? 1 : clamp((width - 20) / BASE_MODEL_WIDTH, SCALE_MIN, SCALE_MAX);
}

export function createWheelZoom(displayConfig) {
  return { characterScale: characterScaleOf(displayConfig), windowZoom: windowZoomOf(displayConfig) };
}

/** One wheel notch. Mutates `state` and reports which message the caller must send, if any. */
export function applyWheel(state, { moveMode, deltaY }) {
  const delta = finite(deltaY);
  if (delta === undefined) return null;
  const factor = Math.exp(-delta / 600);
  if (moveMode) {
    const next = clamp(state.characterScale * factor, SCALE_MIN, SCALE_MAX);
    if (next === state.characterScale) return null;
    state.characterScale = next;
    return { type: 'set_character_scale', scale: next };
  }
  const next = clamp(state.windowZoom * factor, SCALE_MIN, SCALE_MAX);
  if (next === state.windowZoom) return null;
  state.windowZoom = next;
  return { type: 'zoom_model', scale: next };
}

/** Re-seed from the shell's authoritative display config, after a reset or a preference reload. */
export function syncWheelZoom(state, displayConfig) {
  state.characterScale = characterScaleOf(displayConfig);
  state.windowZoom = windowZoomOf(displayConfig);
  return state;
}
