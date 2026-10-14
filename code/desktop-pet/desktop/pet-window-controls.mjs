// Private display controls. No backend, media or model state is changed here.
export function installPetWindowControls({ get, shell, panelOpen, onCollapse, onRestore, onPetClick }) {
  let collapsed = false, requested = null, saved, pointer = null, suppressBallClick = false;
  function release() {
    const active = pointer; pointer = null;
    if (active?.node.hasPointerCapture?.(active.id)) active.node.releasePointerCapture(active.id);
  }
  function apply(value) {
    if (collapsed === value) return;
    collapsed = value; release();
    if (value) saved = onCollapse();
    document.body.dataset.petCollapsed = String(value);
    get('pet').inert = value;
    get('pet-ball').hidden = !value;
    if (value) { get('drawer').inert = true; get('pet-ball').focus({ preventScroll: true }); }
    else { onRestore(saved); saved = undefined; }
  }
  function request(value) {
    if (collapsed === value || requested === value) return;
    requested = value;
    shell({ type: 'set_collapsed', collapsed: value, open: panelOpen() });
  }
  for (const id of ['pet-collapse', 'workbench-collapse', 'work-records-collapse']) {
    get(id).onclick = () => request(true);
  }
  for (const id of ['character', 'pet-ball']) {
    const node = get(id);
    node.onpointerdown = event => {
      if (pointer || event.button !== undefined && event.button !== 0) return;
      suppressBallClick = false;
      pointer = { node, id: event.pointerId, x: event.screenX, y: event.screenY, moved: false };
      node.setPointerCapture(event.pointerId);
    };
    node.onpointermove = event => {
      if (pointer?.node !== node || pointer.id !== event.pointerId) return;
      const dx = event.screenX - pointer.x, dy = event.screenY - pointer.y;
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) + Math.abs(dy) <= 3 && !pointer.moved) return;
      pointer.moved = true;
      shell({ type: 'drag', dx, dy }); pointer.x = event.screenX; pointer.y = event.screenY;
    };
    node.onpointerup = event => {
      if (pointer?.node !== node || pointer.id !== event.pointerId) return;
      const moved = pointer.moved; release();
      if (id === 'pet-ball') suppressBallClick = moved;
      else if (!moved) onPetClick();
    };
    node.onpointercancel = node.onlostpointercapture = event => {
      if (pointer?.node === node && (event?.pointerId === undefined || pointer.id === event.pointerId)) pointer = null;
    };
  }
  get('pet-ball').onclick = () => {
    if (suppressBallClick) { suppressBallClick = false; return; }
    request(false);
  };
  return {
    get collapsed() { return collapsed; },
    cancel: release,
    receive(config) {
      if ([config?.ballLeft, config?.ballTop, config?.ballSize].every(Number.isFinite) && config.ballSize > 0) {
        Object.assign(get('pet-ball').style, { left: `${config.ballLeft}px`, top: `${config.ballTop}px`, width: `${config.ballSize}px`, height: `${config.ballSize}px` });
      }
      if (typeof config?.collapsed === 'boolean') {
        if (requested === config.collapsed) requested = null;
        apply(config.collapsed);
      }
    }
  };
}
