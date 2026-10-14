import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from './ui-harness.mjs';
const shell = a => structuredClone(a.messages.filter(m => m.name === 'shell').map(m => m.value));
const event = (extra = {}) => ({ pointerId: 7, button: 0, screenX: 100, screenY: 100, ...extra });
const config = collapsed => ({ mode: 'half', preferredWidth: 500, modelWidth: 500, modelHeight: 500 * 340 / 360,
  drawerHeight: 540, petLeft: 100, petTop: 50, petWidth: 520, drawerLeft: 700, drawerTop: 50, drawerWidth: 480,
  collapsed, ballLeft: 338, ballTop: 50, ballSize: 44 });
const collapse = a => { a.node('pet-collapse').onclick(); a.bridge.displayConfig(config(true)); };
const restore = a => { a.node('pet-ball').onclick(); a.bridge.displayConfig(config(false)); };

test('engineering overview remains open while character drag sends only finite deltas and releases capture', async () => {
  const a = await app(), pet = a.node('character'); a.node('open').onclick(); a.node('workbench-open').onclick();
  const before = shell(a).length;
  pet.onpointerdown(event()); pet.onpointermove(event({ pointerId: 8, screenX: 900 }));
  pet.onpointermove(event({ screenX: 130, screenY: 120 })); pet.onpointerup(event());
  assert.deepEqual(shell(a).slice(before), [{ type: 'drag', dx: 30, dy: 20 }]);
  assert.equal(a.node('workbench-dialog').open, true); assert.equal(pet.captured, null);
  pet.onpointerdown(event()); pet.onlostpointercapture(event()); pet.onpointerup(event());
  assert.equal(a.node('workbench-dialog').open, true); assert.equal(shell(a).length, before + 1);
  pet.onpointerdown(event({ button: 2 })); pet.onpointermove(event({ screenX: 200 }));
  assert.equal(shell(a).length, before + 1);
});

test('collapse awaits the native frame acknowledgement, keeps the drawer draft and restores previous open state', async () => {
  for (const open of [false, true]) {
    const a = await app(); if (open) a.node('open').onclick(); a.bridge.displayConfig(config(false));
    a.node('text').value = '保留尚未提交的输入'; a.node('text').oninput();
    a.node('pet-collapse').onclick(); a.node('pet-collapse').onclick();
    assert.equal(shell(a).filter(x => x.type === 'set_collapsed').length, 1);
    assert.deepEqual(shell(a).at(-1), { type: 'set_collapsed', collapsed: true, open });
    a.bridge.displayConfig(config(true));
    assert.equal(a.document.body.dataset.petCollapsed, 'true'); assert.equal(a.node('pet').inert, true);
    assert.equal(a.node('drawer').inert, true); assert.equal(a.node('pet-ball').hidden, false);
    assert.equal(a.node('character').style.width, '500px'); assert.equal(a.harness.framing, 'half');
    a.node('open').onclick(); // Hidden/background open requests cannot change the saved panel state.
    restore(a);
    assert.equal(a.node('drawer').hidden, !open); assert.equal(a.node('drawer').inert, !open);
    assert.equal(a.node('text').value, '保留尚未提交的输入'); assert.equal(a.wire().length, 0);
    assert.ok(!shell(a).some(x => ['set_display', 'resize_model'].includes(x.type)));
  }
});

test('a dragged ball stays collapsed, then a separate click restores; blur cancels further movement', async () => {
  const a = await app(); collapse(a); const ball = a.node('pet-ball');
  ball.onpointerdown(event()); ball.onpointermove(event({ screenX: 150, screenY: 85 })); ball.onpointerup(event()); ball.onclick();
  assert.equal(shell(a).at(-1).type, 'drag'); assert.equal(a.document.body.dataset.petCollapsed, 'true');
  ball.onpointerdown(event()); a.listeners.get('window:blur')(); ball.onpointermove(event({ screenX: 700 }));
  assert.equal(shell(a).at(-1).type, 'drag'); assert.equal(ball.captured, null);
  ball.onpointerdown(event()); ball.onpointerup(event()); ball.onclick();
  assert.deepEqual(shell(a).at(-1), { type: 'set_collapsed', collapsed: false, open: false });
});

test('collapse suspends and restores engineering dialogs without writing task commands or stealing hidden input focus', async () => {
  for (const name of ['workbench', 'work-records']) {
    const a = await app(); a.node('open').onclick(); a.node(`${name}-dialog`).showModal();
    a.node(`${name}-content`).scrollTop = 83; a.node(`${name}-collapse`).focus();
    a.node(`${name}-collapse`).onclick(); a.bridge.displayConfig(config(true));
    assert.equal(a.node(`${name}-dialog`).open, false); a.frame();
    assert.equal(a.document.activeElement.id, 'pet-ball');
    restore(a); assert.equal(a.node(`${name}-dialog`).open, true);
    assert.equal(a.node(`${name}-content`).scrollTop, 83); assert.equal(a.wire().length, 0);
  }
});

test('collapse preserves actual playback, hidden amplitude updates and end reset; Space cannot start a hidden turn', async () => {
  const a = await app(); a.changed(1); await a.ready(); a.bridge.hotkeyConfig('Space');
  const scope = { characterId: 'companion', sessionId: 's1', turnId: 'output', generation: 1 };
  a.node('text').value = '受控输入'; a.node('form').onsubmit({ preventDefault() {} });
  await a.bridge.receive({ channel: 'event', event: { type: 'turn', input: { scope, kind: 'text', startedAt: '' } } }, 1);
  const tts = { scope, audio: { id: 'silent-audio', uri: 'test://audio', mimeType: 'audio/wav', temporary: true },
    expression: { emotion: 'warm', intensity: .7, delivery: '', gesture: 'heart' }, durationMs: null, synchronization: 'amplitude' };
  const playing = a.bridge.receive({ channel: 'play', requestId: 'controlled-play', tts, audioBase64: 'AQI=' }, 1);
  await Promise.resolve(); a.harness.playback.emit({ type: 'started', audioId: 'silent-audio', at: '' });
  const before = a.wire().length, resets = a.harness.resets; collapse(a);
  a.bridge.hotkeyEvent({ type: 'down', code: 'Space', repeat: false });
  a.listeners.get('keydown')({ target: a.node('pet-ball'), code: 'Space', key: ' ', preventDefault() {}, stopPropagation() {} });
  a.harness.playback.emit({ type: 'amplitude', value: .6, at: '' }); a.frame(performance.now() + 80);
  assert.equal(a.harness.presented.state, 'speaking'); assert.equal(a.harness.presented.mouth, .6);
  assert.equal(a.harness.playback.signal.aborted, false); assert.equal(a.harness.playStops, 0);
  assert.equal(a.harness.captureOpens, 0); assert.equal(a.harness.resets, resets);
  assert.ok(!a.wire().slice(before).some(x => x.value.message.channel === 'command'));
  restore(a); assert.equal(a.harness.playOpens, 1); assert.equal(a.harness.playStops, 0);
  a.harness.playback.emit({ type: 'ended', at: '' }); a.harness.playback.session.stop(); await playing;
  a.frame(performance.now() + 160); assert.equal(a.harness.presented.mouth, 0);
});

test('a held voice keeps its existing capture through collapse and accepts its original release without a new hidden start', async () => {
  for (const phase of ['preparing', 'listening']) {
    const a = await app(); a.changed(1); await a.ready(); a.bridge.hotkeyConfig('Space');
    a.bridge.hotkeyEvent({ type: 'down', code: 'Space', repeat: false });
    const scope = { characterId: 'companion', sessionId: 's1', turnId: phase, generation: 1 };
    await a.bridge.receive({ channel: 'event', event: { type: 'turn', input: { scope, kind: 'voice', startedAt: '' } } }, 1);
    const opening = a.bridge.receive({ channel: 'capture_start', requestId: phase, scope }, 1);
    let stops = 0;
    if (phase === 'listening') { a.harness.openCapture({ stop() { stops++; } }); await opening; }
    const before = a.wire().length;
    a.listeners.get('focusin')({ target: a.node('pet-collapse') }); collapse(a);
    a.listeners.get('focusin')({ target: a.node('pet-ball') });
    a.bridge.hotkeyEvent({ type: 'down', code: 'Space', repeat: true });
    assert.equal(a.wire().length, before, phase); assert.equal(stops, 0);
    assert.equal(a.harness.captureSignal.aborted, false); assert.equal(a.harness.captureOpens, 1);
    a.bridge.hotkeyEvent({ type: 'up', code: 'Space' });
    assert.equal(a.wire().at(-1).value.message.command.type, phase === 'listening' ? 'finish_voice' : 'cancel');
    assert.equal(a.wire().filter(x => x.value.message.command?.type === 'start_voice').length, 1);
    if (phase === 'preparing') { a.harness.openCapture({ stop() { stops++; } }); await opening; }
    else a.node('stop').onclick(); // End this isolated fixture through the existing explicit Stop action.
  }
});
