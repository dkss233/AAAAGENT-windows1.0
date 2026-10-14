import { app, BrowserWindow, globalShortcut, ipcMain, nativeImage, protocol, screen, Menu, shell, Tray } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendConnection } from './transport.mjs';
import { fitDisplay } from './layout.mjs';
import { assetResponse } from './assets.mjs';
import { managementUrl } from '../../tools/management-url.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const root = resolve(option('--root') || resolve(here, '..'));
const node = option('--node'), backend = option('--backend');
if (!node || !backend) throw Error('Use npm run dev or npm start to launch the Windows host.');
const preview = process.argv.includes('--preview');
const inspect = process.argv.includes('--inspect');
const smoke = process.argv.includes('--smoke-test');
app.setName('AAAAGENT');
// A portable copy keeps its window state inside its own folder. Without this every copy on the
// machine shares one userData directory, and Electron's single-instance lock then makes the
// second copy exit instantly with no window and no message. `shell.mjs` sets the marker.
const portableRoot = process.env.AAAAGENT_PORTABLE_ROOT;
app.setPath('userData', portableRoot
  ? resolve(portableRoot, '.local', 'userdata')
  : resolve(app.getPath('appData'), 'AAAAGENT', smoke ? 'smoke-test' : preview ? 'preview' : 'desktop'));
if (!app.requestSingleInstanceLock({ root, preview })) { app.quit(); process.exit(0); }
protocol.registerSchemesAsPrivileged([{ scheme: 'pet', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let win, ready = false, voiceRequested = false, wakeRequested = false, panelOpen = false, collapsed = false, beforeResize, beforeDrawer, pointerLocked = false, pointerLockHover = false;
const registeredAccelerators = [];
// characterName mirrors contracts/character.ts COMPANION_LABEL; it is overridable per install via
// windows-display.json so a distributed copy ships no particular name. This file is plain .mjs and
// is not part of the TypeScript build, so the default is spelled out rather than imported.
let prefs = { mode: 'full', width: 360, zoomScale: 1, drawerOffsetX: 0, drawerOffsetY: 0, artOffsetX: 0, artOffsetY: 0, characterScale: 1, characterName: '德克萨斯', hotkey: null, rendererKind:'video' }, anchor, prefsFile, writes = Promise.resolve();
const deliver = (method, ...args) => { if (ready && win && !win.isDestroyed()) win.webContents.send('pet:delivery', method, ...args); };
// Cursor following while the pointer is outside the window. Electron exposes the OS cursor position
// through `screen`, which the page cannot reach, so this polls and delivers a window-relative point.
// Only runs while the operator has look mode on, and the last point is repeated so a paused pointer
// still reaches the renderer.
const LOOK_POLL_MS = 33;
let lookTimer, lookLastReport = '';
const setLookCursor = enabled => {
  if (lookTimer) { clearInterval(lookTimer); lookTimer = undefined; }
  lookLastReport = '';
  if (enabled !== true) return;
  lookTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const point = screen.getCursorScreenPoint();
    // Window-relative normalised coordinates, the same shape the page's own mousemove produces.
    const x = Math.max(-1, Math.min(1, (point.x - (bounds.x + bounds.width / 2)) / Math.max(1, bounds.width / 2)));
    const y = Math.max(-1, Math.min(1, (point.y - (bounds.y + bounds.height / 2)) / Math.max(1, bounds.height / 2)));
    const key = x.toFixed(3) + ',' + y.toFixed(3);
    if (key === lookLastReport) return;
    lookLastReport = key;
    deliverDisplay('lookCursor', { x, y });
  }, LOOK_POLL_MS);
  lookTimer.unref?.();
};
// Display settings must reach the page even when the backend never connects: the initial layout
// runs before `ready`, so a ready-gated delivery of displayConfig can be dropped entirely.
const deliverDisplay = (method, ...args) => { if (win && !win.isDestroyed()) win.webContents.send('pet:delivery', method, ...args); };
const connection = new BackendConnection({
  onState: state => { voiceRequested = wakeRequested = false; deliver('connectionChanged', state); },
  onMessage: (message, generation) => {
    if (message.channel === 'wake_control') wakeRequested = message.enabled === true;
    if (message.channel === 'wake_error') wakeRequested = false;
    if (['capture_finish', 'capture_stop'].includes(message.channel)) voiceRequested = false;
    deliver('receive', message, generation);
  }
});
const validHotkey = code => code === null || /^(Arrow(Up|Down|Left|Right)|Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|20)|Space|Enter|Backspace|Delete|Home|End|PageUp|PageDown|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/.test(code);
function savePreferences() {
  const raw = JSON.stringify({ ...prefs, anchor });
  writes = writes.then(() => writeFile(prefsFile, raw)).catch(() => process.stderr.write('Display preferences could not be saved.\n'));
}
/** Unlock shortcut. A locked window ignores mouse events everywhere, including its own lock
 *  button, so this native accelerator is the only way back. */
// Two accelerators: the first is memorable, the second is deliberately obscure in case the
// first collides with another application.
const UNLOCK_ACCELERATORS = ['Control+Alt+L', 'Control+Alt+Shift+U'];
/** Tray presence while locked. A locked window ignores every click, so an out-of-window
 *  affordance is the only reliable way back when the global shortcuts are taken. */
let tray;
function syncLockTray(locked) {
  if (!locked) { tray?.destroy(); tray = undefined; return; }
  if (tray) return;
  try {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip('AAAAGENT：鼠标穿透已开启');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '解除鼠标穿透', click: () => applyPointerLock(false) },
      { type: 'separator' },
      { label: '退出桌宠', click: () => app.quit() },
    ]));
    tray.on('click', () => applyPointerLock(false));
  } catch (error) {
    tray = undefined;
    process.stderr.write(`Lock tray icon unavailable: ${error?.message ?? error}\n`);
  }
}
function applyPointerLock(locked) {
  pointerLocked = locked === true;
  pointerLockHover = false;
  if (win && !win.isDestroyed()) {
    // forward:true keeps move events flowing to the renderer.
    win.setIgnoreMouseEvents(pointerLocked, { forward: true });
  }
  // Locking only affects pointer delivery: the pet stays always-on-top and fully visible.
  syncLockTray(pointerLocked);
  deliver('pointerLock', { locked: pointerLocked, accelerators: registeredAccelerators });
}
/** Whole-window scale. The wheel outside movement mode changes prefs.width directly, so
 *  the pet pane, the model and the corner controls all scale together. */
const effectiveWidth = () => Math.max(220, Math.min(1400, prefs.width));
function layout() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) });
  const fitted = fitDisplay(effectiveWidth(), panelOpen, display.workArea, anchor, prefs.mode, collapsed, 1,
    { x: prefs.drawerOffsetX, y: prefs.drawerOffsetY }, { x: prefs.artOffsetX, y: prefs.artOffsetY }, prefs.characterScale);
  anchor = fitted.anchor; win.setBounds(fitted.bounds); deliverDisplay('displayConfig', {...fitted.config, rendererKind:prefs.rendererKind, characterName:prefs.characterName});
}
const trusted = event => win && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === 'pet://app/index.html';
const start = () => connection.start(node, [backend], process.env);

ipcMain.on('pet:desktop', (event, value) => {
  if (!trusted(event) || !value || value.generation !== connection.generation || connection.state !== 'ready' || !value.message || typeof value.message !== 'object') return;
  const type = value.message.command?.type;
  if (['start_voice', 'click_invitation'].includes(type)) voiceRequested = true;
  if (['finish_voice', 'cancel', 'submit_text'].includes(type)) voiceRequested = false;
  connection.send(value.message, value.generation);
});
ipcMain.on('pet:shell', (event, value) => {
  if (!trusted(event) || !value || typeof value !== 'object') return;
  switch (value.type) {
    case 'ready':
      if (ready) return;
      ready = true; layout(); deliver('hotkeyConfig', { code: prefs.hotkey }); start(); break;
    // Sent once the page's bridge exists, in case the initial layout was delivered too early.
    case 'request_display_config': layout(); break;
    case 'panel': panelOpen = value.open === true; layout(); if (panelOpen) win.focus(); break;
    case 'focus': win.focus(); break;
    case 'drag':
      if (Number.isFinite(value.dx) && Number.isFinite(value.dy) && Math.abs(value.dx) < 2000 && Math.abs(value.dy) < 2000) {
        anchor.x += value.dx; anchor.y += value.dy; layout(); savePreferences();
      } break;
    case 'zoom_model':
      // Wheel outside movement mode resizes the WHOLE window: the model, the pane and the
      // corner controls scale together because layout() derives every size from this width.
      if (Number.isFinite(value.scale)) {
        prefs.width = Math.max(220, Math.min(1400, Math.round(360 * Math.max(0.5, Math.min(2.5, value.scale)))));
        layout(); savePreferences();
      } break;
    case 'drag_drawer':
      // Offsets accumulate onto the auto-chosen placement; the layout clamps to the screen.
      // Only 'update' carries a delta, so begin/commit/cancel must not require dx/dy.
      if (value.phase === 'begin') { beforeDrawer = { x: prefs.drawerOffsetX, y: prefs.drawerOffsetY }; }
      else if (value.phase === 'cancel') {
        if (beforeDrawer) { prefs.drawerOffsetX = beforeDrawer.x; prefs.drawerOffsetY = beforeDrawer.y; }
        beforeDrawer = undefined; layout();
      } else if (value.phase === 'update' || value.phase === 'commit') {
        if (Number.isFinite(value.dx) && Number.isFinite(value.dy) && Math.abs(value.dx) < 4000 && Math.abs(value.dy) < 4000) {
          prefs.drawerOffsetX += value.dx; prefs.drawerOffsetY += value.dy;
          if (value.phase === 'commit') { beforeDrawer = undefined; savePreferences(); }
          layout();
        }
      } break;
    case 'set_passthrough': applyPointerLock(value.locked === true); break;
    case 'reset_window_framing':
      // Long press while adjust mode is OFF: the gesture belongs to the window. Only the
      // window's own framing is reset - the model keeps whatever pan and scale it has.
      prefs.width = 360; prefs.drawerOffsetX = 0; prefs.drawerOffsetY = 0;
      layout(); savePreferences(); break;
    case 'reset_model_framing':
      // Long press while adjust mode is ON: the gesture belongs to the model. Position and
      // scale reset; the window keeps its size and the drawer keeps its offset.
      prefs.artOffsetX = 0; prefs.artOffsetY = 0; prefs.characterScale = 1;
      layout(); savePreferences(); break;
    case 'set_character_scale':
      // Movement-mode zoom. Only the renderer's character element is scaled; the window and the
      // corner controls keep their size, so this never changes the layout bounds.
      if (Number.isFinite(value.scale)) {
        prefs.characterScale = Math.max(0.5, Math.min(2.5, value.scale));
        layout(); savePreferences();
      } break;
    case 'set_model_offset':
      // Movement mode pans the model; the renderer owns the live value, this only persists it.
      if (Number.isFinite(value.x) && Number.isFinite(value.y)) {
        prefs.artOffsetX = Math.max(-3, Math.min(3, value.x));
        prefs.artOffsetY = Math.max(-3, Math.min(3, value.y));
        savePreferences();
      } break;
    case 'pointer_lock_hover':
      // The renderer forwards pointer position while locked; entering the lock button takes
      // clicks again so the button stays a way out without relying on a global shortcut.
      if (value.hot === true) {
        if (!pointerLockHover && pointerLocked && win && !win.isDestroyed()) {
          pointerLockHover = true;
          win.setIgnoreMouseEvents(false);
        }
      } else if (pointerLockHover && win && !win.isDestroyed()) {
        pointerLockHover = false;
        win.setIgnoreMouseEvents(pointerLocked, { forward: true });
      } break;
    // Cursor following needs the pointer position even when it is outside the pet window, which the
    // page cannot see. The main process can, so it polls and delivers the point; the renderer treats
    // it exactly like its own mousemove, and the window position is re-read each tick so a dragged
    // window keeps the mapping correct. Off by default so an idle pet polls nothing.
    case 'look_cursor': setLookCursor(value.enabled === true); break;
    case 'set_display': if (['full', 'half'].includes(value.mode)) { prefs.mode = value.mode; layout(); savePreferences(); } break;
    case 'set_renderer': if (['live2d','video'].includes(value.rendererKind)) { prefs.rendererKind=value.rendererKind; layout(); savePreferences(); } break;
    // Renaming from the panel: store it and let the resulting layout deliver the new label.
    case 'set_character_name': {
      const name = typeof value.characterName === 'string' ? value.characterName.trim().slice(0, 24) : '';
      if (name && name !== prefs.characterName) { prefs.characterName = name; layout(); savePreferences(); }
      break;
    }
    case 'set_collapsed':
      if (typeof value.collapsed === 'boolean') { collapsed=value.collapsed; if(typeof value.open==='boolean') panelOpen=value.open;
        if(beforeResize!==undefined){prefs.width=beforeResize;beforeResize=undefined;} layout(); } break;
    case 'resize_model':
      if (value.phase === 'begin') beforeResize ??= prefs.width;
      else if (beforeResize !== undefined) {
        if (value.phase === 'cancel') { prefs.width = beforeResize; beforeResize = undefined; }
        else if (['update', 'commit'].includes(value.phase) && Number.isFinite(value.width)) {
          prefs.width = Math.max(220, Math.min(1400, value.width));
          if (value.phase === 'commit') { beforeResize = undefined; savePreferences(); }
        }
        layout();
      } break;
    case 'set_hotkey': if (validHotkey(value.code)) { prefs.hotkey = value.code; savePreferences(); deliver('hotkeyConfig', { code: prefs.hotkey }); } break;
    case 'reconnect': if (['failed', 'disconnected'].includes(connection.state)) start(); break;
    case 'disconnect': if (value.generation === connection.generation) connection.close(); break;
    case 'open_management':
      if (preview) { deliver('managementResult', { ok: false }); break; }
      void managementUrl(process.env.PET_TRIAL_CONFIG).then(url => shell.openExternal(url)).then(() => deliver('managementResult', { ok: true })).catch(() => deliver('managementResult', { ok: false })); break;
    case 'open_workbench':
      if (preview) { deliver('workbenchOpenResult',{ok:false}); break; }
      void openWorkbench(value).then(() => deliver('workbenchOpenResult',{ok:true})).catch(() => deliver('workbenchOpenResult',{ok:false})); break;
    case 'quit': app.quit(); break;
  }
});
async function openWorkbench(value) {
  if (!['home','project','task'].includes(value.target)) throw Error('Invalid target');
  const url = new URL(await managementUrl(process.env.PET_TRIAL_CONFIG));
  const input = {target:value.target};
  for (const key of ['projectId','taskId']) if (typeof value[key] === 'string' && value[key].length < 1024) input[key]=value[key];
  if (Number.isSafeInteger(value.expectedFocusRevision) && value.expectedFocusRevision >= 0) input.expectedFocusRevision=value.expectedFocusRevision;
  const response = await fetch(url.origin+'/api/workbench/native-open/desktop',{method:'POST',headers:{Authorization:'Bearer '+url.hash.slice(7),Origin:url.origin,'Content-Type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(5000)});
  if (!response.ok) throw Error('Workbench unavailable');
  const result=await response.json(),destination=new URL(result.url),relation=result.originalManagementReturn;
  if (result.status!=='ready'||destination.protocol!=='http:'||destination.hostname!=='127.0.0.1'||destination.pathname!=='/open'||destination.search||!/^#[A-Za-z0-9_-]{43}$/.test(destination.hash)||relation?.version!=='0.1.1'||relation.origin!==url.origin||relation.path!=='/'||relation.environmentId!==result.target?.environmentId) throw Error('Invalid workbench entry');
  const fragment=new URLSearchParams(url.hash.slice(1));fragment.set('nativeEntry',JSON.stringify(result));url.hash=fragment.toString();
  await shell.openExternal(url.href);
}
ipcMain.on('pet:diagnostic', (event, value) => {
  if (!trusted(event) || !value) return;
  // Don't copy arbitrary renderer text, chat or media into diagnostic logs.
  if (['model-ready', 'model-error', 'script-error', 'promise-error'].includes(value.type)) process.stderr.write(`Renderer: ${value.type}` + '\n');
  // Fixed-shape operational facts, also written to a file so a support session can inspect what the
  // renderer actually applied without attaching a debugger.
  if (value.type === 'presentation-policy' || value.type === 'hidden-parameters' || value.type === 'expression-emotion' || value.type === 'expression-parameters') {
    const line = JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n';
    process.stderr.write('Renderer: ' + line);
    try { appendFileSync(resolve(app.getPath('userData'), 'presentation-trace.log'), line); } catch { /* diagnostics must never break the pet */ }
  }
});

// Do not await readiness at module scope: Electron must finish loading this ESM
// entry before it can emit ready. Keep initialization in the ready callback.
void app.whenReady().then(async () => {
await mkdir(app.getPath('userData'), { recursive: true });
prefsFile = resolve(app.getPath('userData'), 'windows-display.json');
try {
  const saved = JSON.parse(await readFile(prefsFile, 'utf8'));  if (['full', 'half'].includes(saved.mode)) prefs.mode = saved.mode;
  if (Number.isFinite(saved.width)) prefs.width = Math.max(220, Math.min(1400, saved.width));
  if (validHotkey(saved.hotkey)) prefs.hotkey = saved.hotkey;
  if (['video','live2d'].includes(saved.rendererKind)) prefs.rendererKind = saved.rendererKind;
  if (Number.isFinite(saved.zoomScale)) prefs.zoomScale = Math.max(0.5, Math.min(2.5, saved.zoomScale));
  if (Number.isFinite(saved.artOffsetX)) prefs.artOffsetX = Math.max(-3, Math.min(3, saved.artOffsetX));
  if (Number.isFinite(saved.artOffsetY)) prefs.artOffsetY = Math.max(-3, Math.min(3, saved.artOffsetY));
  if (Number.isFinite(saved.characterScale)) prefs.characterScale = Math.max(0.5, Math.min(2.5, saved.characterScale));
  if (Number.isFinite(saved.drawerOffsetX)) prefs.drawerOffsetX = Math.max(-4000, Math.min(4000, saved.drawerOffsetX));
  if (Number.isFinite(saved.drawerOffsetY)) prefs.drawerOffsetY = Math.max(-4000, Math.min(4000, saved.drawerOffsetY));
  if (Number.isFinite(saved.anchor?.x) && Number.isFinite(saved.anchor?.y)) anchor = saved.anchor;
  // Display name for the character. Kept here so a shipped copy carries no particular name and the
  // operator can change it by editing this file, with no rebuild.
  if (typeof saved.characterName === 'string') {
    const name = saved.characterName.trim();
    if (name) prefs.characterName = name.slice(0, 24);
  }
} catch (error) {
  process.stderr.write('Display preferences could not be read: ' + String(error && error.message || error) + '\n');
}
if (['video','live2d'].includes(option('--renderer'))) prefs.rendererKind=option('--renderer');
const area = screen.getPrimaryDisplay().workArea;
anchor ??= { x: area.x + area.width - 220, y: area.y + Math.max(0, area.height - 430) };
win = new BrowserWindow({ title: preview ? 'AAAAGENT · Offline preview' : 'AAAAGENT', width: 380, height: 376,
  frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true, hasShadow: false, resizable: false, show: !smoke,
  webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    partition: 'aaaagent-desktop', backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'AAAAGENT', submenu: [
  { label: 'Reload', accelerator: 'Ctrl+R', click: () => { connection.close(); ready = false; win.webContents.reload(); } },
  { label: 'Developer tools', accelerator: 'Ctrl+Shift+I', click: () => win.webContents.toggleDevTools() }, { role: 'quit' }
] }, { role: 'editMenu' }]));
await win.webContents.session.protocol.handle('pet', request => assetResponse(root, request.url, request.headers));
// The unlock accelerator stays registered for the whole session: while the window ignores
// mouse events the lock button cannot be clicked, so this is the documented way back.
for (const accelerator of UNLOCK_ACCELERATORS) {
  if (globalShortcut.register(accelerator, () => applyPointerLock(!pointerLocked))) registeredAccelerators.push(accelerator);
  else process.stderr.write(`Pointer-lock unlock shortcut unavailable (in use elsewhere): ${accelerator}\n`);
}
if (registeredAccelerators.length) process.stderr.write(`Pointer-lock unlock shortcuts: ${registeredAccelerators.join(', ')}\n`);
const mediaAllowed = (wc, permission, origin, types, mainFrame) => !preview && wc === win.webContents && permission === 'media'
  && origin?.startsWith('pet://app/') && mainFrame !== false && types.length > 0
  && types.every(type => type === 'audio' ? voiceRequested || wakeRequested : type === 'video' && voiceRequested);
win.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => callback(mediaAllowed(wc, permission, details.requestingUrl, details.mediaTypes || [], details.isMainFrame)));
win.webContents.session.setPermissionCheckHandler((wc, permission, origin, details) => mediaAllowed(wc, permission, origin + '/', [details.mediaType], details.isMainFrame));
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
win.webContents.on('will-navigate', event => event.preventDefault());
win.webContents.on('will-attach-webview', event => event.preventDefault());
win.webContents.on('render-process-gone', () => { ready = false; connection.close(); });
win.on('blur', () => { if (beforeResize !== undefined) { prefs.width = beforeResize; beforeResize = undefined; layout(); } deliver('hotkeyEvent', { type: 'cancel' }); });
screen.on('display-metrics-changed', layout); screen.on('display-removed', layout);
app.on('second-instance', () => { win.show(); win.focus(); });
let quitDrained = false, quitPending = false;
app.on('before-quit', event => {
  if (quitDrained) return;
  event.preventDefault();
  if (quitPending) return;
  quitPending = true;
  // Keep pipes and the Electron event loop alive until backend EOF cleanup
  // finishes. Otherwise Windows can leave backend.lock after the window closes.
  void connection.close().then(() => writes).finally(() => { quitDrained = true; app.quit(); });
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); tray?.destroy(); tray = undefined; if (lookTimer) { clearInterval(lookTimer); lookTimer = undefined; } });
app.on('window-all-closed', () => app.quit());
layout();
await win.loadURL('pet://app/index.html');
if (inspect) win.webContents.openDevTools({ mode: 'detach' });
if (smoke) {
  let smokeExit = 0;
  try {
    // Exercise the real Electron renderer in an offscreen window; no account or device access.
    const deadline = Date.now() + 20000;
    let loaded = false;
    while (Date.now() < deadline) {
      loaded = await win.webContents.executeJavaScript(`!!window.petBridge && document.getElementById('loading').hidden && !document.getElementById('send').disabled && window.WhaleDesktop.snapshot()?.kind === '${prefs.rendererKind}' && window.WhaleDesktop.snapshot()?.ready`);
      if (loaded) break;
      await new Promise(done => setTimeout(done, 200));
    }
    if (!loaded) throw Error('Renderer or offline backend did not become ready: ' + await win.webContents.executeJavaScript("document.getElementById('status').textContent"));
    await win.webContents.executeJavaScript("document.getElementById('open').click();document.getElementById('text').value='Windows bridge smoke test';document.getElementById('form').requestSubmit();");
    await new Promise(done => setTimeout(done, 400));
    const echoed = await win.webContents.executeJavaScript("document.getElementById('reply').textContent.includes('Offline preview received')");
    if (!echoed) throw Error('Text did not complete a backend round trip');
    if(prefs.rendererKind==='video') {
      const media=await win.webContents.executeJavaScript("({count:document.querySelectorAll('video').length,state:window.WhaleDesktop.snapshot()})");
      if(media.count!==1||media.state.readyState<2||media.state.preload!=='none')throw Error('Video renderer exceeded its media bound or failed to decode');
      const alpha=await win.webContents.executeJavaScript("(()=>{const c=document.createElement('canvas');c.width=64;c.height=36;const ctx=c.getContext('2d');ctx.drawImage(document.querySelector('video'),0,0,64,36);const p=ctx.getImageData(0,0,64,36).data;let transparent=0,opaque=0,minAlpha=255;for(let i=3;i<p.length;i+=4){minAlpha=Math.min(minAlpha,p[i]);if(p[i]<=16)transparent++;if(p[i]===255)opaque++;}return {transparent,opaque,minAlpha,cornerAlpha:p[3]};})()");
      console.log('VIDEO_ALPHA_SAMPLE: '+JSON.stringify(alpha));
      if(!alpha.transparent||!alpha.opaque)throw Error('Video alpha transparency is unavailable');
      console.log('VIDEO_ALPHA_OK: '+JSON.stringify(alpha));
      await win.webContents.executeJavaScript("document.getElementById('video-action').value='happy';document.getElementById('video-play').click()");
      await new Promise(done=>setTimeout(done,600));
      if(await win.webContents.executeJavaScript("window.WhaleDesktop.snapshot().action!=='happy'"))throw Error('Video action control failed');
    }
    await win.webContents.executeJavaScript("document.getElementById('pet-collapse').click()");
    await new Promise(done=>setTimeout(done,200));
    if(!await win.webContents.executeJavaScript("document.body.dataset.petCollapsed==='true'"))throw Error('Collapse acknowledgement failed');
    await win.webContents.executeJavaScript("document.getElementById('pet-ball').click()");
    await new Promise(done=>setTimeout(done,300));
    if(!await win.webContents.executeJavaScript("document.body.dataset.petCollapsed==='false'"))throw Error('Restore acknowledgement failed');
    if(process.argv.includes('--smoke-switch')) {
      for(const kind of ['live2d','video','live2d','video']) {
        await win.webContents.executeJavaScript(`document.getElementById('model-kind').value='${kind}';document.getElementById('model-kind').dispatchEvent(new Event('change'));`);
        const until=Date.now()+20000;let switched=false;
        while(Date.now()<until){switched=await win.webContents.executeJavaScript(`window.WhaleDesktop.snapshot()?.kind==='${kind}' && window.WhaleDesktop.snapshot()?.ready === true`);if(switched)break;await new Promise(done=>setTimeout(done,100));}
        if(!switched)throw Error('Renderer switch failed: '+kind);
        const count=await win.webContents.executeJavaScript("document.querySelectorAll('video').length");
        if(count!==(kind==='video'?1:0))throw Error('Switch leaked video elements');
      }
    }
    console.log(`WINDOWS_SMOKE_OK: ${prefs.rendererKind} renderer, isolated preload, backend round trip, collapse/restore, panel layout.`);
    if (option('--screenshot')) {
      win.showInactive();
      await new Promise(done => setTimeout(done, 600));
      const visible = await win.webContents.executeJavaScript("!document.getElementById('drawer').hidden && getComputedStyle(document.getElementById('drawer')).opacity === '1'");
      if (!visible) throw Error('Chat drawer is not visible');
      await writeFile(resolve(option('--screenshot')), (await win.webContents.capturePage()).toPNG());
    }
  } catch (error) { console.error(error.message); smokeExit = 1; }
  await connection.close(); await writes; app.exit(smokeExit);
}
}).catch(error => { console.error(error.message); app.exit(1); });
