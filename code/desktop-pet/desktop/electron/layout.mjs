const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
export function fitDisplay(width, open, screen, anchor, mode = 'full', collapsed = false, zoomScale = 1, drawerOffset = { x: 0, y: 0 }, artOffset = { x: 0, y: 0 }, characterScale = 1) {
  const sw = Math.max(1, screen.width), sh = Math.max(1, screen.height), aspect = 340 / 360;
  const mw = Math.max(1, Math.min(width, sw - 20, (sh - 36) / aspect)), mh = mw * aspect;
  const pet = { x: clamp(anchor.x - (mw + 20) / 2, screen.x, screen.x + sw - mw - 20),
    y: clamp(anchor.y, screen.y, screen.y + sh - mh - 36), width: mw + 20, height: mh + 36 };
  // Cap the drawer height so it always keeps vertical travel for dragging. A drawer as tall
  // as the work area clamps to a single y and cannot be moved down at all.
  const dw = Math.min(480, sw - 20), dh = Math.max(260, Math.min(460, sh - 120)), gap = 8;
  const right = screen.x + sw - pet.x - pet.width - gap, left = pet.x - screen.x - gap;
  const below = screen.y + sh - pet.y - pet.height - gap, above = pet.y - screen.y - gap;
  // Start beside the pet rather than pinned to the work-area top, so a user drag keeps
  // travel in both directions instead of clamping against an edge immediately.
  const drawer = { x: clamp(pet.x + pet.width / 2 - dw / 2, screen.x, screen.x + sw - dw),
    y: clamp(pet.y, screen.y, screen.y + sh - dh), width: dw, height: dh };
  let placement = 'hidden';
  if (open) {
    if (below >= dh) { drawer.y = pet.y + pet.height + gap; placement = 'below'; }
    else if (Math.max(left, right) >= dw) { placement = right >= left ? 'right' : 'left'; drawer.x = placement === 'right' ? pet.x + pet.width + gap : pet.x - dw - gap; drawer.y = clamp(pet.y, screen.y, screen.y + sh - dh); }
    else if (above >= dh) { drawer.y = pet.y - dh - gap; placement = 'above'; }
    else { placement = 'overlay'; drawer.y = clamp(pet.y, screen.y, screen.y + sh - dh); }
  }
  // A user-dragged drawer keeps the placement that auto-fit chose as its origin, so the
  // offset survives restarts and screen changes. Only the drawer moves; the pet anchor
  // stays where the user put it.
  const baseDrawerX = drawer.x, baseDrawerY = drawer.y;
  if (open && drawerOffset && (drawerOffset.x || drawerOffset.y)) {
    drawer.x = clamp(drawer.x + (Number.isFinite(drawerOffset.x) ? drawerOffset.x : 0), screen.x, screen.x + sw - dw);
    drawer.y = clamp(drawer.y + (Number.isFinite(drawerOffset.y) ? drawerOffset.y : 0), screen.y, screen.y + sh - dh);
    placement = 'custom';
  }
  // Report the offset that actually took effect: a raw value clamped at the screen edge
  // would otherwise behave as a phantom offset the user has to drag back through.
  const appliedOffsetX = open ? drawer.x - baseDrawerX : 0, appliedOffsetY = open ? drawer.y - baseDrawerY : 0;
  const x = Math.floor(open ? Math.min(pet.x, drawer.x) : pet.x), y = Math.floor(open ? Math.min(pet.y, drawer.y) : pet.y);
  const bounds = { x, y, width: Math.ceil((open ? Math.max(pet.x + pet.width, drawer.x + dw) : pet.x + pet.width) - x),
    height: Math.ceil((open ? Math.max(pet.y + pet.height, drawer.y + dh) : pet.y + pet.height) - y) };
  const config = { mode, preferredWidth: width,
    modelWidth: mw, modelHeight: mh, drawerHeight: open ? dh : 0, petLeft: pet.x - x, petTop: pet.y - y, petWidth: pet.width,
    drawerLeft: drawer.x - x, drawerTop: drawer.y - y, drawerWidth: dw, placement, collapsed, zoomScale,
    drawerOffsetX: appliedOffsetX, drawerOffsetY: appliedOffsetY,
    artOffsetX: Number.isFinite(artOffset?.x) ? artOffset.x : 0, artOffsetY: Number.isFinite(artOffset?.y) ? artOffset.y : 0,
    characterScale: Number.isFinite(characterScale) && characterScale > 0 ? characterScale : 1,
    ballLeft:0, ballTop:0, ballSize:54 };
  if (collapsed) return {bounds:{x:Math.round(clamp(anchor.x-27,screen.x,screen.x+sw-54)),y:Math.round(clamp(anchor.y,screen.y,screen.y+sh-54)),width:54,height:54},anchor,config};
  return { bounds, anchor: { x: pet.x + pet.width / 2, y: pet.y }, config };
}
