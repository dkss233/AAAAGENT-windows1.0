// The native shell owns saved preferences and screen constraints. These controls
// only express user intent and apply its acknowledgement in logical CSS pixels.
export function installDisplayControls({ get, shell, setFraming }) {
  let config = { mode: 'full', preferredWidth: 360, modelWidth: 360, modelHeight: 340, drawerHeight: 540 };
  let drag = null;
  const handle = get('model-resize');
  const stop = event => { event?.preventDefault?.(); event?.stopPropagation?.(); };
  const release = () => {
    const active = drag; drag = null;
    if (active && handle.hasPointerCapture?.(active.id)) handle.releasePointerCapture(active.id);
    handle.dataset.resizing = 'false';
  };
  function cancel(event) {
    if (!drag) return false;
    stop(event); release(); shell({ type: 'resize_model', phase: 'cancel' }); return true;
  }
  function receive(value) {
    if (!value || !['full', 'half'].includes(value.mode) || !['preferredWidth', 'modelWidth', 'modelHeight', 'drawerHeight'].every(k => Number.isFinite(value[k])) || value.modelWidth <= 0 || value.modelHeight <= 0 || value.drawerHeight < 0) return;
    config = value;
    // The chat panel header carries the character's display name. It is a display preference
    // (windows-display.json) that the panel itself can edit, so it ships without a fixed name.
    if (typeof value.characterName === 'string') {
      const name = value.characterName.trim();
      if (name) {
        const label = document.getElementById('character-name');
        if (label && label.textContent !== name) label.textContent = name;
        const field = document.getElementById('character-name-input');
        // Do not fight the user mid-edit; only fill the box when it is not focused.
        if (field && document.activeElement !== field && field.value !== name) field.value = name;
      }
    }
    const pet = get('pet');
    pet.style.height = `${value.modelHeight + 36}px`;
    const positioned = ['petLeft','petTop','petWidth','drawerLeft','drawerTop','drawerWidth'].every(k => Number.isFinite(value[k]));
    if (positioned) {
      // Coordinates live in a fixed screen-sized WK viewport, not the changing
      // clipped NSPanel. Reapplying a panel acknowledgement never moves the model.
      Object.assign(pet.style, { position:'absolute', left:`${value.petLeft}px`, top:`${value.petTop}px`, width:`${value.petWidth}px` });
      Object.assign(get('drawer').style, { position:'absolute', left:`${value.drawerLeft}px`, top:`${value.drawerTop}px`, width:`${value.drawerWidth}px`, margin:'0' });
      get('drawer').dataset.placement = value.placement ?? '';
    }
    get('character').style.width = `${value.modelWidth}px`;
    get('character').style.height = `${value.modelHeight}px`;
    // Movement-mode zoom scales ONLY the character. The window, the pane and the corner
    // controls keep their size, and because this is a transform about the element's centre
    // the model grows in place instead of drifting with the origin.
    const characterScale = Number.isFinite(value.characterScale) && value.characterScale > 0 ? value.characterScale : 1;
    get('character').style.transform = characterScale === 1 ? 'translateX(-50%)' : 'translateX(-50%) scale(' + characterScale + ')';
    // The status text lives inside #character, so the scale above would enlarge it too and push it
    // past the window edge (measured: a 1.6x model made the indicator 164x66 and put its top at
    // -64px). Publish the factor so those labels can cancel it out; see .scale-invariant in style.css.
    document.documentElement.style.setProperty('--character-scale', String(characterScale));
    handle.style.right = `calc(50% - ${value.modelWidth / 2}px)`;
    get('drawer').style.maxHeight = `${value.drawerHeight}px`;
    get('drawer').style.height = `${value.drawerHeight}px`;
    for (const mode of ['full', 'half']) get(`view-${mode}`).setAttribute('aria-pressed', String(mode === value.mode));
    setFraming(value.mode);
  }
  // The drawer can be dragged anywhere by its header. Offsets are sent to the native shell,
  // which clamps them to the screen and re-fits the window around both panes.
  let drawerDrag = null;
  const drawerHeader = get('drawer')?.querySelector('header');
  if (drawerHeader) {
    drawerHeader.style.cursor = 'grab';
    drawerHeader.style.touchAction = 'none';
    // Controls inside the header (控制台, ×) must keep working, so a drag only starts on the
    // header background. Pointer capture is deliberately deferred until the drag threshold is
    // crossed: capturing on pointerdown would redirect the pointerup to the header and the
    // buttons would never see a completed click.
    const DRAG_THRESHOLD = 3;
    drawerHeader.onpointerdown = event => {
      if (drawerDrag || (event.button !== undefined && event.button !== 0)) return;
      if (event.target instanceof Element && event.target.closest('button, a, input, select, textarea')) return;
      drawerDrag = { id: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
    };
    drawerHeader.onpointermove = event => {
      if (!drawerDrag || drawerDrag.id !== event.pointerId) return;
      const dx = event.screenX - drawerDrag.x, dy = event.screenY - drawerDrag.y;
      if (!drawerDrag.moved) {
        if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
        drawerDrag.moved = true;
        drawerHeader.setPointerCapture(event.pointerId);
        drawerHeader.style.cursor = 'grabbing';
        shell({ type: 'drag_drawer', phase: 'begin' });
      }
      event.preventDefault();
      shell({ type: 'drag_drawer', phase: 'update', dx, dy });
      drawerDrag.x = event.screenX; drawerDrag.y = event.screenY;
    };
    const finishDrawer = (event, cancel) => {
      if (!drawerDrag || drawerDrag.id !== event.pointerId) return;
      const moved = drawerDrag.moved; drawerDrag = null;
      drawerHeader.style.cursor = 'grab';
      if (drawerHeader.hasPointerCapture?.(event.pointerId)) drawerHeader.releasePointerCapture(event.pointerId);
      if (cancel) shell({ type: 'drag_drawer', phase: 'cancel' });
      else if (moved) shell({ type: 'drag_drawer', phase: 'commit' });
      else shell({ type: 'drag_drawer', phase: 'cancel' });
    };
    drawerHeader.onpointerup = event => finishDrawer(event, false);
    drawerHeader.onpointercancel = event => finishDrawer(event, true);
    drawerHeader.onlostpointercapture = event => { if (drawerDrag) finishDrawer(event, true); };
  }
  for (const mode of ['full', 'half']) {
    const button = get(`view-${mode}`);
    button.onpointerdown = event => event.stopPropagation?.();
    button.onclick = event => { stop(event); cancel(); shell({ type: 'set_display', mode }); };
  }
  handle.onpointerdown = event => {
    stop(event);
    if (event.button !== undefined && event.button !== 0 || drag) return;
    drag = { id: event.pointerId, x: event.screenX, y: event.screenY, width: config.modelWidth, ratio: config.modelHeight / config.modelWidth, value: config.modelWidth, moved: false };
    handle.setPointerCapture(event.pointerId); handle.dataset.resizing = 'true';
    shell({ type: 'resize_model', phase: 'begin' });
  };
  handle.onpointermove = event => {
    if (!drag || drag.id !== event.pointerId) return;
    stop(event);
    const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) < 3 && !drag.moved) return;
    drag.moved = true;
    drag.value = Math.min(720, Math.max(220, drag.width + (dx + drag.ratio * dy) / (1 + drag.ratio ** 2)));
    shell({ type: 'resize_model', phase: 'update', width: drag.value });
  };
  handle.onpointerup = event => {
    if (!drag || drag.id !== event.pointerId) return;
    stop(event); const { value, moved } = drag; release();
    shell(moved ? { type: 'resize_model', phase: 'commit', width: value } : { type: 'resize_model', phase: 'cancel' });
  };
  handle.onpointercancel = cancel; handle.onlostpointercapture = cancel;
  handle.onclick = stop;
  handle.onkeydown = event => {
    if (event.key === 'Escape') { cancel(event); return }
    const step = ({ ArrowRight: 20, ArrowUp: 20, ArrowLeft: -20, ArrowDown: -20 })[event.key];
    if (!step || event.metaKey || event.ctrlKey || event.altKey) return;
    stop(event); cancel(); shell({ type: 'resize_model', phase: 'begin' });
    shell({ type: 'resize_model', phase: 'commit', width: config.preferredWidth + step });
  };
  receive(config);
  keepOutsideModelScale(get);
  return { receive, cancel, get mode() { return config.mode } };
}

/**
 * The waiting chip is markup inside #character in index.html, but #character receives a CSS
 * `scale()` for movement-mode zoom, and a transform scales every descendant: measured, a 1.6x model
 * turned the chip from 102x41 into 164x66 and lifted its top edge from 24px to -64px, so it was cut
 * off by the window. Moving it under #pet keeps it in a coordinate space the model scale never
 * touches, which is why the size and the distance from the window edge are now constant instead of
 * being divided back out with a counter-transform. #pet has no transform of its own.
 *
 * Runs once, and is skipped if the markup already places the chip there.
 */
function keepOutsideModelScale(get) {
  const chip = get('thinking-indicator');
  const pet = get('pet');
  if (!chip || !pet || chip.parentElement === pet) return;
  // #pet is position:relative, so the chip's absolute top/right resolve against the window-fitted
  // pet box, exactly as the corner buttons beside it do.
  pet.appendChild(chip);
}
