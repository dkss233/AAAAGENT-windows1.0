import {WakeController} from './wake-controller.mjs';
import { COMPANION_LABEL, isProductCharacter } from '../contracts/character.ts';
import { CaptureFeedback } from './capture-feedback.mjs';
import { WorkRecords } from './work-records.mjs';
import { WorkCard } from './work-card.mjs';
import { DesktopWorkbenchCard } from './workbench-card.mjs';
import { installDisplayControls } from './display-controls.mjs';
import { installPetWindowControls } from './pet-window-controls.mjs';
import { applyWheel, createWheelZoom, syncWheelZoom } from './zoom-wheel.mjs';
import { toDeviceFailure, deviceFailureMessage } from '../media/capture-errors.ts';
import { PressToTalk, validVoiceKey } from './press-to-talk.ts';
import { DesktopChatLog } from './chat-log.ts';
import { DesktopViewState, DesktopConnectionState, scopeEquals } from './view-state.ts';
import { JellyfishRenderer } from './cubism-renderer.mjs';
import { VideoPetRenderer } from './video-pet-renderer.mjs';
import { BrowserPlaybackDriver } from '../media/browser-playback.ts';
import { DesktopPlaybackController } from './playback-controller.ts';
import { BrowserCaptureDriver } from '../media/browser-capture.ts';
import { DESKTOP_BRIDGE_VERSION } from '../contracts/desktop-bridge.ts';
const $ = id => document.getElementById(id);
const native = (name, value) => window.desktopHost ? window.desktopHost.postMessage(name, value) : window.webkit?.messageHandlers[name]?.postMessage(value);
const report = value => native('diagnostic', value);
const connection = new DesktopConnectionState();
const send = (value, generation = connection.generation) => {
  if (connection.current(generation) && connection.connected) native('desktop', { generation, message: value });
};
const view = new DesktopViewState();
const workSpeechView=new DesktopViewState();
let workNotice=null,workSpeechBlocked=false,backendSessionId=null;
const spokenNotices=new Set();
const chat = new DesktopChatLog();
const captureFeedback=new CaptureFeedback($);let captureFeedbackToken;
let wakeFeedbackToken,wakeRequestId=null,wakeUI={phase:'off',enabled:false};
const wakeLabels={connecting:'连接中',waiting:'等待唤醒',listening:'正在听',submitting:'正在提交',replying:'等待唤醒'};
const wake=new WakeController({
 createCapture:async options=>{const module=await import('../media/wake/browser-capture.ts');return new module.BrowserWakeCapture({...options,workletModuleUrl:new URL('./wake-recorder-worklet.js',import.meta.url)});},send,
 onState:state=>{wakeUI=state;const label=wakeLabels[state.phase];if(state.enabled&&label){const mode={label,phase:state.phase,keepLabel:true};if(wakeFeedbackToken===undefined||!captureFeedback.active)wakeFeedbackToken=captureFeedback.start(mode);else captureFeedback.configure(wakeFeedbackToken,mode);}else{if(wakeFeedbackToken!==undefined)captureFeedback.stop(wakeFeedbackToken);wakeFeedbackToken=undefined;}Promise.resolve().then(()=>renderUI());},
 onLevel:level=>{if(wakeFeedbackToken!==undefined)captureFeedback.level(wakeFeedbackToken,level);},
 onWake:wakeHit=>command({type:'start_voice',wakeHit},{wakeInput:true}),
 onFinish:()=>command({type:'finish_voice'},{wakeInput:true}),
 onCancel:()=>{if(wakeRequestId){wakeRequestId=null;command({type:'cancel'},{wakeInput:true});}}
});
let workInputSource='generic';
const records=new WorkRecords({get:$,action:a=>work.action(a),onClose:()=>markVisibleWork(),onSelect:id=>{workInputSource='generic';workbench.forgetBinding();work.focusRecord(id);}});
const work = new WorkCard({get:$,send,open:()=>panel(true),onState:s=>records.receive(s),onRecords:origin=>records.show(origin),onToggle:()=>{
 if(work.expanded){workInputSource='generic';workbench.forgetBinding();workbench.close(false);}markVisibleWork();restoreSelectedSource();requestedSourceFocus=true;lastUI='';renderUI();}});
const workbench=new DesktopWorkbenchCard({get:$,send:action=>send({channel:'workbench_action',action}),
 online:()=>connection.connected,openNative:command=>native('shell',command),
 visible:()=>workInputSource==='native'&&!petWindow.collapsed&&!records.isOpen&&panelOpen&&!$('drawer').hidden&&!$('drawer').inert,
 onOpen:()=>{workInputSource='native';work.forgetBinding();},voice:()=>$('voice').onclick()});
let companionRoute = null;
let inputScope = null, awaitingTranscript = false;
let lastInputRow = null, lastWorkOpen = false, preserveReading = false, requestedSourceFocus=false,lastSourceId=null;
const expandedInputs=new Set();
let textRequestId = null;
let inputFocusEpoch=0, interactionFocusEpoch=0, routeFocusEpoch=0;
let composing = false;
let presentationPolicy=null;
function applyPresentationPolicy(){
  if(!renderer?.ready)return;
  const policy=presentationPolicy??{modelId:'disconnected',revision:0,enabledIds:[]};
  const applied=renderer.setAutomaticPolicy(policy);
  if(presentationPolicy)report({type:'presentation-policy',modelId:policy.modelId,revision:policy.revision,enabledCount:policy.enabledIds.length,hidden:policy.hiddenIds??[],applied:applied===true});
}
let renderer, capturing, captureAllowed = false, voicePhase = 'idle';
let rendererKind = 'video', rendererBooted = false, rendererSwitch = Promise.resolve();
let initialDisplayResolve, lastDisplayConfig;
// Live framing values mirrored from the latest display config. The shell owns the
// persisted copies; these mirror them so a reset is reflected immediately by the wheel
// handler and the pan handler, which otherwise keep their own closure state.
const liveFraming = { zoomScale: 1, artOffsetX: 0, artOffsetY: 0 };
const initialDisplay = window.desktopHost ? new Promise(resolve => { initialDisplayResolve=resolve; }) : Promise.resolve();
function selectRenderer(kind) {
  if (!['video', 'live2d'].includes(kind)) return rendererSwitch;
  rendererKind = kind; $('model-kind').value = kind;
  rendererSwitch = rendererSwitch.then(async () => {
    if (renderer?.kind === rendererKind && renderer.ready) return;
    const selected = rendererKind;
    renderer?.dispose(); renderer = undefined; $('model').hidden = false; $('loading').hidden = false;
    $('loading').textContent = 'AAAAGENT正在过来…';
    $('video-controls').hidden = selected !== 'video';
    try {
      renderer = selected === 'video' ? new VideoPetRenderer($('model'), report) : new JellyfishRenderer($('model'), report, {assetBase:'assets/local-model/'});
      renderer.kind = selected; await renderer.load(); applyPresentationPolicy(); renderer.setFraming(display.mode);
      renderer.setSuspended?.(petWindow.collapsed || document.hidden); $('loading').hidden = true;
      console.error('[diag] model loaded OK, kind=' + selected);
      if (selected === 'video') {
        $('video-action').replaceChildren(...[...renderer.entries.values()].map(action => { const option = document.createElement('option'); option.value = action.id; option.textContent = action.label; return option; }));
      }
    } catch (error) {
      console.error('[diag] model load failed:', error && error.stack ? error.stack : error);
      renderer?.dispose(); renderer = undefined; $('loading').textContent = error.code === 'LIVE2D_RESOURCES_MISSING' ? error.message : '角色加载失败，请在面板中切换角色';
      view.error = error.message; report({type:'model-error'}); panel(true); renderUI();
    }
  });
  return rendererSwitch;
}
let voiceRequestId = null, invitationPending = false, voiceRequestAt = 0, inputEventTiming=null;
function timedVoiceInput(at,source,run){const previous=inputEventTiming;inputEventTiming={at,source};try{return run();}finally{inputEventTiming=previous;}}
let introduction = null, introductionEpoch = 0, introductionFramePending = false;
let panelOpen = false, panelEpoch = 0, panelAnimation, panelCloseTimer;
let lastUI = '';
let awaitingTextTurn = false;
let bindingKey = false;
let managementOpening = false;
function managementResult(result) {
  if (!managementOpening || typeof result?.ok !== 'boolean') return;
  managementOpening = false; $('management').disabled = false; $('management').textContent = '控制台';
  $('management-notice').hidden = result.ok;
  $('management-notice').textContent = result.ok ? '' : '暂时无法打开控制台，请确认桌宠服务已启动后重试。';
}
$('management').onclick = () => {
  if (managementOpening) return;
  managementOpening = true; $('management').disabled = true; $('management').textContent = '打开中…';
  $('management-notice').hidden = true;
  native('shell', { type:'open_management' });
};
const display = installDisplayControls({ get: $, shell: value => native('shell', value), setFraming: mode => renderer?.setFraming(mode) });
const hold = new PressToTalk({
  start() {
    // A fresh physical hold supersedes pending generation, output or capture cleanup.
    if (!connection.connected) return false;
    command({ type: 'start_voice' }); return true;
  },
  finish() { command({ type: 'finish_voice' }); },
  cancel(early) {
    command({ type: 'cancel' });
    view.error = early ? '录音尚未开始，已取消，未发送。请按住直到提示正在听。' : '按键录音已取消，未发送。'; renderUI();
  }
});
const petWindow = installPetWindowControls({ get: $, shell: value => native('shell', value),
  panelOpen: () => panelOpen,
  onPetClick: () => { renderer?.pat?.(); if (!workbench.isOpen) panel(!panelOpen); },
  onCollapse() {
    const focused = document.activeElement;
    const saved = { panel: panelOpen, workbench: workbench.isOpen, records: records.isOpen,
      recordOrigin: records.returnFocus, focusId: focused?.id,
      selection: typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null };
    ++panelEpoch; ++inputFocusEpoch; ++interactionFocusEpoch; ++introductionEpoch;
    introductionFramePending = false; panelAnimation?.cancel(); panelAnimation = null; clearTimeout(panelCloseTimer);
    // Finish only the display transition. The drawer DOM, drafts and playback stay alive.
    $('drawer').hidden = !panelOpen;
    workbench.close(false); records.close(false); display.cancel();
    bindingKey = false; $('hotkey-bind').textContent = '设置按键'; focused?.blur?.();
    return saved;
  },
  onRestore(saved) {
    $('drawer').inert = !panelOpen;
    if (saved?.workbench && panelOpen) workbench.open();
    if (saved?.records && panelOpen) records.show(saved.recordOrigin);
    const focused = saved?.focusId && $(saved.focusId);
    if (focused && !focused.hidden && !focused.disabled && panelOpen) {
      focused.focus({ preventScroll: true });
      if (saved.selection) focused.setSelectionRange?.(...saved.selection);
    }
    if (panelOpen) { fitComposer(); markVisibleWork(); presentNativeWork(); scheduleIntroductionAck(); }
  }
});
function hotkeyConfig(value) {
  const code = value && typeof value === 'object' ? value.code ?? null : value;
  if (!hold.configure(code)) return;
  $('hotkey-value').textContent = code ? ({ ArrowUp:'↑', ArrowDown:'↓', ArrowLeft:'←', ArrowRight:'→', Space:'空格', Enter:'回车' }[code] ?? code.replace(/^Key|^Digit/,'')) : '未绑定';
}
function hotkeyEvent(event) {
  const receivedAt=performance.now();
  if (event.type === 'cancel') { hold.cancel(); return; }
  if (bindingKey || composing) return;
  if (event.type === 'down' && !petWindow.collapsed) timedVoiceInput(receivedAt,'native-hotkey',()=>hold.down(event.code,event.repeat));
  else if (event.type === 'up') hold.up(event.code);
}
$('hotkey-bind').onclick = () => { hold.cancel(); bindingKey = true; $('hotkey-bind').textContent = '请按一个键…'; $('hotkey-bind').focus(); };
$('hotkey-bind').onkeydown = event => {
  if (!bindingKey) return;
  event.preventDefault(); event.stopPropagation?.();
  if (event.key === 'Escape') { bindingKey = false; $('hotkey-bind').textContent = '设置按键'; return; }
  if (event.isComposing || event.repeat || event.metaKey || event.ctrlKey || event.altKey || !validVoiceKey(event.code)) return;
  bindingKey = false; $('hotkey-bind').textContent = '更换按键'; hotkeyConfig(event.code);
  native('shell', { type: 'set_hotkey', code: event.code });
};
$('hotkey-clear').onclick = () => { bindingKey = false; hotkeyConfig(null); $('hotkey-bind').textContent = '设置按键'; native('shell', { type: 'set_hotkey', code: null }); };

const reconnect = document.createElement('button'); reconnect.id = 'reconnect'; reconnect.type = 'button'; reconnect.textContent = '重新连接'; reconnect.hidden = true;
$('status').after(reconnect);
reconnect.onclick = () => { if (connection.canRetry && !connection.active) { reconnect.disabled = true; native('shell', { type: 'reconnect' }); } };
const connectionText = () => ({ connecting: '正在连接对话服务…', disconnected: '对话服务已断开', failed: connection.reason === 'version' ? '对话服务版本不一致，请退出后重新启动' : '对话服务连接失败' }[connection.state]);
const features = { type: 'features', secureContext: isSecureContext, mediaDevices: !!navigator.mediaDevices?.getUserMedia, audioWorklet: typeof AudioWorkletNode !== 'undefined', userAgent: navigator.userAgent, origin: location.origin };
report(features);
function renderUI() {
  wake.observe({busy:!!capturing||voicePhase!=='idle'||awaitingTextTurn||awaitingTranscript||['listening','thinking','speaking'].includes(view.state)||workSpeechView.state==='speaking',playing:playback.busy});
  const uiKey = JSON.stringify([wakeUI.phase,wakeUI.detail,awaitingTextTurn, awaitingTranscript, work.expanded,work.state?.sourceInput?.draftId,workSpeechView.state, voicePhase, chat.revision, view.reply, view.error, view.state, view.characterId, view.invitation?.id, view.invitation?.text, connection.state, connection.reason, connection.canRetry, introduction?.id, introduction?.text]);
  if (uiKey === lastUI) return;
  lastUI = uiKey;
  const rows = chat.rows(view.characterId).map(row => {
    const item = document.createElement('div'); item.className = `chat-row ${row.kind}`;item.dataset.rowId=String(row.id);
    if(row.recordId){item.dataset.recordId=row.recordId;item.dataset.recordVersion=String(row.recordVersion);item.dataset.sourceScope=JSON.stringify(row.sourceScope);}
    const label = document.createElement('span'); label.className = 'chat-label';
    label.textContent = row.kind === 'user' ? `${row.sourceLabel??'你'}${row.status === 'sending' ? ' · 发送中' : row.status === 'failed' ? ' · 未送达' : ''}` : COMPANION_LABEL;
    const text = document.createElement('div'); text.textContent = row.text;
    item.append(label, text);
    if(row.kind==='user'&&row.text.length>140){const expanded=expandedInputs.has(row.id);text.className=expanded?'input-original':'input-original input-original-preview';const more=document.createElement('button');more.type='button';more.className='input-full-toggle';more.textContent=expanded?'收起全文':'查看输入全文';more.setAttribute('aria-expanded',String(expanded));more.onclick=()=>{if(expanded)expandedInputs.delete(row.id);else expandedInputs.add(row.id);preserveReading=true;lastUI='';renderUI();};item.append(more);}
    return item;
  });
  if (introduction) {
    const opening = document.createElement('section'); opening.id = 'introduction'; opening.className = 'introduction';
    const label = document.createElement('span'); label.className = 'introduction-label'; label.textContent = '开场 · 虚构设定';
    const text = document.createElement('div'); text.textContent = introduction.text; opening.append(label, text); rows.unshift(opening);
  }
  const log = $('reply'),scroller=$('conversation'), nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 36;
  const oldScroll = scroller.scrollTop, latestInput = chat.rows(view.characterId).filter(row=>row.kind==='user').at(-1)?.id;
  const sourceId=work.state?.sourceInput?.draftId;
  const sourceFocus=requestedSourceFocus||work.expanded&&(!lastWorkOpen||sourceId!==lastSourceId);
  const focusInput=sourceFocus?chat.sourceRowId(view.characterId,sourceId)??latestInput:latestInput;
  const showInput = requestedSourceFocus||latestInput!==lastInputRow||work.expanded!==lastWorkOpen||work.expanded&&sourceId!==lastSourceId;lastSourceId=sourceId;requestedSourceFocus=false;
  lastInputRow=latestInput;lastWorkOpen=work.expanded;
  log.replaceChildren(...rows);
  const inputRow=showInput?rows.find(row=>row.dataset?.rowId===String(focusInput)):null;
  if(preserveReading){scroller.scrollTop=oldScroll;preserveReading=false;}
  else if(inputRow)scroller.scrollTop=Math.max(0,(scroller.scrollTop||0)+inputRow.getBoundingClientRect().top-scroller.getBoundingClientRect().top);
  else scroller.scrollTop=nearBottom?scroller.scrollHeight:oldScroll;
  $('status').textContent = connectionText() || view.error || (workSpeechView.state==='speaking'?'正在播报任务状态…':'') || (awaitingTranscript ? '正在转写…' : '') || (voicePhase === 'preparing' ? '正在准备麦克风…' : '') || ({ idle: wakeLabels[wakeUI.phase]||(wakeUI.phase==='error'?'唤醒已停止，请在网页重新开启':'我在这里'), listening: voicePhase === 'recording' ? '正在听你说 · 再点一次结束' : '正在准备麦克风…', thinking: '正在想怎么回应你…', speaking: '正在说话…', error: '这一轮没有完成' }[view.state]);
  $('thinking-indicator').hidden = !connection.connected || !!view.error || awaitingTranscript || !(awaitingTextTurn || view.state === 'thinking');
  reconnect.hidden = connection.active || !connection.canRetry; reconnect.disabled = connection.active;
  $('invitation').disabled = !connection.connected;
  $('voice').textContent = voicePhase === 'preparing' ? '取消准备' : voicePhase === 'recording' ? '说完了' : '开始语音';
  $('stop').hidden = (view.state === 'idle' || view.state === 'error')&&!workNotice;
  $('voice').disabled = !connection.connected || (voicePhase === 'idle' && !['idle', 'error'].includes(view.state));
  workbench.updateInputControls();
  $('send').disabled = !connection.connected || chat.pending(view.characterId);
  $('invitation').hidden = !view.invitation; $('invitation').textContent = view.invitation?.text ?? '';
  if (panelOpen) fitComposer();
  scheduleIntroductionAck();
}
// This presentation is never appended to chat or submitted as user/model text.
function scheduleIntroductionAck() {
  const current = introduction, epoch = introductionEpoch;
  if (!current || current.acknowledged || introductionFramePending || !connection.connected || !panelOpen || petWindow.collapsed || document.hidden) return;
  const visible = () => {
    if (epoch !== introductionEpoch || introduction !== current || !connection.current(current.generation) || !connection.connected || !panelOpen || petWindow.collapsed || document.hidden) return false;
    const node = $('introduction');
    if (!node || !node.getClientRects().length || $('drawer').hidden) return false;
    const rect = node.getBoundingClientRect(), clip = $('conversation').getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right;
  };
  introductionFramePending = true;
  requestAnimationFrame(() => {
    if (!visible()) { if (epoch === introductionEpoch) introductionFramePending = false; return; }
    // Give the visible content a paint opportunity before acknowledging it.
    requestAnimationFrame(() => {
      if (epoch === introductionEpoch) introductionFramePending = false;
      if (!visible() || current.acknowledged) return;
      send({ channel: 'command', command: { type: 'acknowledge_introduction', introductionId: current.id } }, current.generation);
      current.acknowledged = true;
    });
  });
}
$('conversation').addEventListener('scroll', scheduleIntroductionAck);
function panel(open) {
  if(petWindow.collapsed)return;
  if(open&&panelOpen&&!$('drawer').hidden){workbench.schedulePresentation();scheduleIntroductionAck();return;}
  const epoch = ++panelEpoch;
  panelAnimation?.cancel(); panelAnimation = null;
  clearTimeout(panelCloseTimer);
  if (!open) {
    records.close(false);document.activeElement?.blur?.();
    bindingKey = false; $('hotkey-bind').textContent = '设置按键';
  }
  const drawer = $('drawer');
  panelOpen = open; drawer.inert = !open || petWindow.collapsed; $('open').hidden = open;
  $('open').setAttribute('aria-expanded', String(open));
  const animate = drawer.animate && !document.hidden && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const finishClose = () => { if (!panelOpen && epoch === panelEpoch && !drawer.hidden) { clearTimeout(panelCloseTimer); drawer.hidden = true; native('shell', { type: 'panel', open: false }); } };
  if (open) { drawer.hidden = false; markVisibleWork(); workbench.schedulePresentation(); native('shell', { type: 'panel', open: true }); }
  if (animate && !drawer.hidden) {
    panelAnimation = drawer.animate(open ? [{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'translateY(0)'}] : [{opacity:1,transform:'translateY(0)'},{opacity:0,transform:'translateY(6px)'}], {duration:open ? 200 : 180,easing:'cubic-bezier(.2,.7,.2,1)'});
    // Occluded WKWebViews can suspend animation frames. Closing must still end.
    if (!open) panelCloseTimer = setTimeout(finishClose, 180);
    panelAnimation.finished.then(() => { if (!open) finishClose(); }, () => {});
  } else if (!open) finishClose();
  introductionEpoch++; introductionFramePending = false;
  if (open) { requestAnimationFrame(() => {
    if (panelOpen && !petWindow.collapsed && epoch === panelEpoch && !document.hidden && document.hasFocus?.() !== false&&!records.isOpen&&!workbench.isOpen) { fitComposer(); $('text').focus({ preventScroll: true }); }
  }); scheduleIntroductionAck(); }
}
function fitComposer() {
  const input = $('text'); input.style.height = 'auto';
  input.style.height = `${Math.min(120, Math.max(24, input.scrollHeight || 24))}px`;
}
const playback = new DesktopPlaybackController(new BrowserPlaybackDriver(), scope => view.accepts(scope)||workSpeechView.accepts(scope), (requestId, event) => {
  const workOutput=workSpeechView.accepts(event.scope);
  (workOutput?workSpeechView:view).receive({type:'playback',playback:event});
  if(workOutput&&event.type==='started'&&workNotice)workNotice.started=true;
  if(workOutput&&event.type==='ended'&&workNotice?.started&&workNotice.workBinding)work.presented(workNotice.workBinding);
  if(workOutput&&['ended','stopped','error'].includes(event.type)){workNotice=null;workSpeechView.reset();}
  renderUI();
  send({ channel: 'playback', requestId, event });
  if (['ended','stopped','error'].includes(event.type)) renderer?.reset();
  if (event.type === 'started' || ['ended','stopped','error'].includes(event.type)) report({ type: 'playback-state', event: event.type, timingBasis: event.timingBasis, model: renderer?.ready ? renderer.snapshot() : null });
});
function stopPlayback(scope) { playback.stop(scope); }
function restoreSelectedSource(){const source=work.state?.sourceInput;if(workInputSource==='generic'&&work.expanded&&source&&typeof source.draftId==='string'&&typeof source.text==='string'&&isProductCharacter(source.scope?.characterId)&&['original_input','legacy_saved_input'].includes(source.provenance))chat.restoreSource(source);}
function markVisibleWork(){if(workInputSource==='generic'&&!petWindow.collapsed&&!records.isOpen&&panelOpen&&!document.hidden&&!$('drawer').hidden&&work.expanded&&!$('work-card').hidden)work.presented();}
function displayedInputBinding(){if(workInputSource==='native'){const binding=workbench.inputBinding();return binding?{workbenchBinding:binding}:null;}
 const binding=work.inputBinding();return binding?{workBinding:binding}:null;}
function presentNativeWork(){
 if(!workbench.needsPresentation()||document.hidden||petWindow.collapsed)return;
 records.close(false);panel(true);workbench.open();
 const card=$('workbench-draft'),content=$('workbench-content');
 if(card&&content.contains(card))content.scrollTop=card.offsetTop-content.offsetTop;
}
function clearWorkSpeech(){const scope=workNotice?.scope;workNotice=null;workSpeechView.reset();if(scope)stopPlayback(scope);}
function stopCapture(scope) {
  if (!scope || capturing && scopeEquals(capturing.scope, scope)) voicePhase = 'idle';
  if (!capturing || scope && !scopeEquals(capturing.scope, scope)) return;
  const active = capturing; capturing = null; captureFeedback.stop(active.feedbackToken);active.controller.abort(); active.session?.stop();
  report({ type: 'capture-stopped' });
}
function command(cmd,{wakeInput=false}={}) {
  const commandEnteredAt=performance.now();
  if (!connection.connected) return;
  if(!wakeInput&&['start_voice','click_invitation','submit_text','cancel'].includes(cmd.type)){wake.pause();wakeRequestId=null;}
  if(['start_voice','submit_text'].includes(cmd.type)){
    const {workBinding,workbenchBinding,...inputCommand}=cmd;cmd={...inputCommand,...(displayedInputBinding()??{})};
  }
  if(['start_voice','click_invitation'].includes(cmd.type))voiceRequestAt=inputEventTiming?.at??commandEnteredAt;

  if (cmd.type === 'finish_voice' && voicePhase !== 'recording') {
    command({ type: 'cancel' }); view.error = '录音尚未就绪，已取消；请等到提示正在听再结束。'; renderUI(); return;
  }
  if (cmd.type === 'click_invitation' && voicePhase !== 'idle') return;
  if(['start_voice','click_invitation'].includes(cmd.type))captureFeedbackToken=wakeInput?wakeFeedbackToken:captureFeedback.start();
  else if(['finish_voice','cancel','submit_text'].includes(cmd.type)&&!wakeInput)captureFeedback.stop();
  if(['cancel','start_voice','click_invitation'].includes(cmd.type))textRequestId=null;
  if(cmd.type==='submit_text'){textRequestId=crypto.randomUUID();cmd={...cmd,clientRequestId:textRequestId};}
  if (cmd.type === 'start_voice') { voiceRequestId = crypto.randomUUID();wakeRequestId=wakeInput?voiceRequestId:null; cmd = { ...cmd, clientRequestId: voiceRequestId }; invitationPending = false; }
  if (cmd.type === 'click_invitation') { voiceRequestId = null; invitationPending = true; }
  if (['cancel', 'submit_text'].includes(cmd.type)) { voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId); }
  if (['start_voice', 'click_invitation'].includes(cmd.type)) { chat.failPending(view.characterId); chat.beginVoice(view.characterId, true); }
  if (cmd.type === 'submit_text' && !chat.submit(view.characterId, cmd.text)) return;
  if (cmd.type === 'cancel') { work.forgetBinding();workbench.forgetBinding();chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId); }
  if (['cancel','submit_text'].includes(cmd.type)) hold.clear();
  if (['cancel','submit_text','start_voice','click_invitation'].includes(cmd.type)) {
    clearWorkSpeech();workSpeechBlocked=false;inputFocusEpoch++;inputScope=null;awaitingTranscript=false;work.input(!!(cmd.workBinding||cmd.workbenchBinding)); routeFocusEpoch=++interactionFocusEpoch; companionRoute=null; void stopPlayback(); stopCapture(); renderer?.reset();
  }
  captureAllowed = cmd.type === 'start_voice' || cmd.type === 'click_invitation';
  if (captureAllowed) { voicePhase = 'preparing'; }
  if (cmd.type === 'finish_voice') { awaitingTranscript=true;voicePhase = 'finishing'; captureAllowed = false; if (capturing) capturing.inputEndedAt = new Date().toISOString(); }
  if (['cancel', 'submit_text', 'start_voice', 'click_invitation'].includes(cmd.type)) awaitingTextTurn = cmd.type === 'submit_text';
  view.command(cmd);
  if (cmd.type === 'start_voice') renderer?.beginAttention();
  // Dispatch explicit voice authorization before rebuilding the chat DOM.
  if (cmd.type === 'start_voice') { send({ channel: 'command', command: cmd }); report({type:'capture-command-timing',source:inputEventTiming?.source??'command',handlerToCommandMs:Math.max(0,commandEnteredAt-voiceRequestAt),handlerToSendMs:Math.max(0,performance.now()-voiceRequestAt)});renderUI(); }
  else { renderUI(); send({ channel: 'command', command: cmd }); }

}
const bytesFromBase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
function base64(bytes) { let text = ''; for (let at = 0; at < bytes.length; at += 32768) text += String.fromCharCode(...bytes.subarray(at, at + 32768)); return btoa(text); }
function connectionChanged(value) {
  if (!connection.update(value)) return;
  wake.disconnect();wakeRequestId=null;
  captureFeedback.stop();
  awaitingTextTurn = false;clearWorkSpeech();spokenNotices.clear();workSpeechBlocked=false;inputFocusEpoch=0;interactionFocusEpoch=0;routeFocusEpoch=0; inputScope=null;awaitingTranscript=false;work.reset(); companionRoute=null; textRequestId=null;
  workbench.disconnect();
  workInputSource='generic';
  presentationPolicy=null;applyPresentationPolicy();
  hold.clear(); voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId);
  introduction = null; introductionEpoch++; introductionFramePending = false; captureAllowed = false;
  chat.setDraft(view.characterId, $('text').value); chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId);
  void stopPlayback(); stopCapture(); renderer?.reset(); view.reset(); view.reply = ''; view.invitation = null;
  renderUI();
  if (!connection.active) panel(true);
}
async function receive(message, generation) {
  if (!connection.current(generation)) return;
  if (message.channel === 'backend_ready') {
    if (message.bridgeVersion !== DESKTOP_BRIDGE_VERSION || !isProductCharacter(message.characterId) || typeof message.sessionId !== 'string' || !message.sessionId) {
      connectionChanged({ generation, state: 'failed', reason: 'version' });
      native('shell', { type: 'disconnect', generation }); return;
    }
    if (!connection.ready(generation)) return;
    wake.disconnect();wakeRequestId=null;
    captureFeedback.stop();
    awaitingTextTurn = false;clearWorkSpeech();spokenNotices.clear();workSpeechBlocked=false;inputFocusEpoch=0;interactionFocusEpoch=0;routeFocusEpoch=0; inputScope=null;awaitingTranscript=false;work.reset(); companionRoute=null; textRequestId=null;
    workbench.ready();
    workInputSource='generic';
    presentationPolicy=null;applyPresentationPolicy();
    introduction = null; introductionEpoch++; introductionFramePending = false; captureAllowed = false;
    void stopPlayback(); stopCapture(); renderer?.reset();
    backendSessionId=message.sessionId;view.setSession(message.characterId, message.sessionId);workSpeechView.setSession(message.characterId,message.sessionId);
    chat.restoreHistory(message.characterId, message.history);
    if (message.introduction && typeof message.introduction.id === 'string' && message.introduction.id && typeof message.introduction.text === 'string' && message.introduction.text.trim()) introduction = { ...message.introduction, generation, acknowledged: false };
    $('text').value = chat.draft(view.characterId); renderUI();
    report({ type: message.channel, characterId: message.characterId, bridgeVersion: DESKTOP_BRIDGE_VERSION }); return;
  }
  if(message.channel==='wake_control'){if(!connection.connected)return;wake.control(message);return;}
  if(message.channel==='wake_result'){if(!connection.connected)return;wake.result(message);return;}
  if(message.channel==='wake_error'){if(!connection.connected)return;wake.error(message);return;}
  if (message.channel === 'backend_closed') { connectionChanged({ generation, state: 'disconnected' }); return; }
  if (!connection.connected) return;
  if(message.channel==='work_state') { if(work.receive(message.state)){renderer?.workEvent?.('work',message.state);markVisibleWork();if(message.state.focus==='work')restoreSelectedSource();renderUI();} return; }
  if(message.channel==='workbench_state'){if(workbench.receive(message.state)){renderer?.workEvent?.('workbench',message.state);presentNativeWork();}return;}
  if(message.channel==='work_speech'){
    const e=message.event;
    if(!e||!e.scope||e.scope.sessionId!==backendSessionId||!isProductCharacter(e.scope.characterId)||!Number.isSafeInteger(e.inputEpoch)||e.inputEpoch!==inputFocusEpoch||typeof e.noticeId!=='string')return;
    if(e.state==='end'){if(workNotice?.noticeId===e.noticeId&&scopeEquals(workNotice.scope,e.scope)){if(playback.busy&&scopeEquals(playback.scope,e.scope))workNotice.ending=true;else clearWorkSpeech();}return;}
    if(e.state!=='start'||spokenNotices.has(e.noticeId)||workSpeechBlocked||voicePhase!=='idle'||capturing||awaitingTextTurn||['thinking','speaking','listening'].includes(view.state))return;
    clearWorkSpeech();spokenNotices.add(e.noticeId);workNotice={noticeId:e.noticeId,scope:e.scope,ending:false,workBinding:e.workBinding?structuredClone(e.workBinding):undefined};workSpeechView.scope=e.scope;renderUI();return;
  }
  if(message.channel==='input_route') {
    if(!view.accepts(message.scope)||!['companion','work'].includes(message.route))return;
    chat.route(message.scope,message.route);
    if(message.route==='work'){companionRoute=null;awaitingTextTurn=false;if(workInputSource==='generic'){if(routeFocusEpoch===interactionFocusEpoch)work.routedWork();markVisibleWork();restoreSelectedSource();}view.reset();renderer?.reset();}
    else {companionRoute=message.scope;work.input();}
    renderUI(); return;
  }
  if(message.channel==='presentation_policy'){
    const p=message.policy;
    if(!p||typeof p.modelId!=='string'||!Number.isSafeInteger(p.revision)||p.revision<0||!Array.isArray(p.enabledIds)||p.enabledIds.some(id=>typeof id!=='string'))return;
    if(presentationPolicy?.modelId===p.modelId&&p.revision<=presentationPolicy.revision)return;
    presentationPolicy=structuredClone(p);applyPresentationPolicy();return;
  }
  if (message.channel === 'event') {
    const e = message.event;
    if(e.type==='turn'&&e.input.kind==='text'&&(!textRequestId||e.input.clientRequestId!==textRequestId))return;
    if(e.type==='reply'&&!scopeEquals(companionRoute,e.reply.scope))return;
    if (e.type === 'turn' && e.input.kind === 'voice' && !(invitationPending && !e.input.clientRequestId) && (!voiceRequestId || e.input.clientRequestId !== voiceRequestId)) return;
    // Work presentation may reset before a late ASR event; input identity is independent.
    const accepted = e.type==='transcript' ? scopeEquals(inputScope,e.scope) : view.receive(e);
    if(accepted&&e.type==='turn')inputScope=e.input.scope;
    if(accepted&&e.type==='transcript')awaitingTranscript=false;
    if(accepted&&e.type==='error'){captureFeedback.stop();inputScope=null;awaitingTranscript=false;}
    if (accepted && ['turn', 'error'].includes(e.type)) awaitingTextTurn = false;
    if (accepted && e.type === 'turn') { if (e.input.kind === 'text') chat.acknowledge(e.input.scope, true); else chat.bindVoice(e.input.scope); }
    if (accepted && e.type === 'transcript') chat.transcript(e.scope, e.text);
    if (accepted && e.type === 'reply' && scopeEquals(companionRoute,e.reply.scope)) { chat.reply(e.reply.scope, e.reply.text); renderer?.presentReply?.(e.reply); }
    if (accepted && e.type === 'error') { hold.clear(); voiceRequestId = null; invitationPending = false; chat.cancelVoice(view.characterId); chat.failPending(view.characterId); $('text').value = chat.draft(view.characterId); }
    if (accepted && (e.type === 'error' || e.type === 'presentation' && e.presentation.state === 'error')) { captureFeedback.stop();void stopPlayback(); stopCapture(); renderer?.reset(); }
    if (accepted && e.type === 'turn') { if (playback.scope && !scopeEquals(playback.scope, e.input.scope)) void stopPlayback(); if (capturing && !scopeEquals(capturing.scope, e.input.scope)) stopCapture(); renderer?.reset({ preserveAttention: e.input.kind === 'voice' }); }
    if (accepted) renderUI(); return;
  }
  try {
    if (message.channel === 'stop' || message.channel === 'capture_stop') {
      if (message.channel === 'stop') await stopPlayback(message.scope); else stopCapture(message.scope);
      send({ channel: 'ack', requestId: message.requestId }, generation); return;
    }
    if (message.channel === 'play') { report({type:'diag-play-arrived', bytes:(message.audioBase64||'').length, scope:message.tts?.scope, route:companionRoute, workSpeech:!!(workNotice&&!workNotice.ending)});
      const isWorkSpeech=workNotice&&!workNotice.ending&&scopeEquals(workNotice.scope,message.tts.scope);
      if(!scopeEquals(companionRoute,message.tts.scope)&&!isWorkSpeech||isWorkSpeech&&workNotice.playRequestId&&workNotice.playRequestId!==message.requestId){report({type:'diag-play-dropped'});message.audioBase64='';send({channel:'playback',requestId:message.requestId,event:{type:'stopped',scope:message.tts.scope,at:new Date().toISOString()}});return;}
      if(isWorkSpeech)workNotice.playRequestId=message.requestId;
      if(isWorkSpeech)workSpeechView.expression=message.tts.expression??workSpeechView.expression;
      const bytes = bytesFromBase64(message.audioBase64); message.audioBase64 = '';
      await playback.play(message.requestId, message.tts, bytes);
      return;
    }
    if (message.channel === 'capture_start') {
      if (!captureAllowed || !view.accepts(message.scope)) throw new Error('录音仅能由当前主动语音轮次打开');
      const fromWake=wakeRequestId!==null&&wakeRequestId===voiceRequestId;
      if(fromWake&&!wake.pendingCapture){if(capturing?.wake&&capturing.session&&scopeEquals(capturing.scope,message.scope)){send({channel:'ack',requestId:message.requestId},generation);return;}throw new Error('唤醒录音已取消');}
      stopCapture(); voicePhase = 'preparing';
      const active = { scope: message.scope, controller: new AbortController(),feedbackToken:captureFeedbackToken,wake:fromWake }; capturing = active;
      const driver = new BrowserCaptureDriver({ workletModuleUrl: new URL('./recorder-worklet.js', import.meta.url), cameraWidth: 640, jpegQuality: .8, maxBufferedSamples: 12000000,onLevel:level=>{if(capturing===active&&!active.controller.signal.aborted)captureFeedback.level(active.feedbackToken,level);}, onDiagnostic: event => {
        if(capturing===active){if(event.phase==='stopped')captureFeedback.stop(active.feedbackToken);report({type:'capture-timing',...event,requestElapsedMs:Math.max(0,performance.now()-voiceRequestAt)});}
      } });
      const opening=active.wake?Promise.resolve(wake.takeCapture()):driver.open(active.controller.signal);renderUI();
      active.session = await opening;
      if (capturing !== active) { active.session.stop(); throw new Error('录音轮次已取消'); }
      voicePhase = 'recording'; hold.ready(); renderUI();
      send({ channel: 'ack', requestId: message.requestId }, generation);if(active.wake)wake.captureReady(); report({ type: 'capture-ready' }); return;
    }
    if (message.channel === 'capture_finish') {
      const active = capturing;
      if (!active?.session || !scopeEquals(active.scope, message.scope)) throw new Error('没有本轮已就绪的录音');
      if(!active.wake)captureFeedback.stop(active.feedbackToken);
      const inputEndedAt = active.inputEndedAt ?? new Date().toISOString();
      const value = await active.session.finish();
      try {
        if (capturing !== active) throw new Error('采集结果已失效');
        send({ channel: 'capture', requestId: message.requestId, result: { scope: active.scope, audio: { id: crypto.randomUUID(), mimeType: 'audio/wav', base64: base64(value.audio) }, images: value.images.map(i => ({ id: crypto.randomUUID(), mimeType: i.mimeType, base64: base64(i.bytes) })), inputEndedAt, captureStoppedAt: value.captureStoppedAt } }, generation);
        capturing = null; voicePhase = 'idle'; renderUI(); report({ type: 'capture-finished', inputEndedAt, captureStoppedAt: value.captureStoppedAt });
      } finally { value.audio.fill(0); value.images.forEach(i => i.bytes.fill(0)); }
    }
  } catch (error) {
    const failure = toDeviceFailure(error), text = deviceFailureMessage(failure), scope = message.scope ?? message.tts?.scope;
    if (connection.current(generation) && message.channel.startsWith('capture') && scope && view.accepts(scope)) {
      stopCapture(scope); captureAllowed = false; hold.clear(); voiceRequestId = null; invitationPending = false;
      inputScope=null;awaitingTranscript=false;chat.cancelVoice(view.characterId); view.receive({ type: 'error', scope, message: text }); renderUI();
    }
    send({ channel: 'rpc_error', requestId: message.requestId, ...(scope ? { scope } : {}), error: failure, message: text }, generation);
  }
}
// Mouse-passthrough lock. While locked the window ignores mouse events, so clicks land on
// whatever is behind the pet. The native side keeps forwarding mouse *moves* to this renderer,
// which lets the lock button take clicks again as soon as the pointer is over it - so the
// button itself always remains a way back, without depending on a global shortcut.
let pointerLocked = false, lockButtonHot = false;
/** Locking hides the pet's controls so clicks reach whatever is behind it. The lock
 *  button stays visible (the native side keeps it clickable) as the way back. */
const hideDuringLock = locked => { document.body.dataset.pointerLocked = String(locked === true); };
const syncPointerLock = locked => {
  pointerLocked = locked === true;
  const button = $('pointer-lock');
  if (!button) return;
  button.setAttribute('aria-pressed', String(pointerLocked));
  button.title = pointerLocked ? '已锁定：点击穿透（移到这个按钮上即可点它解锁）' : '锁定鼠标穿透（锁定后点击落到下方窗口）';
  hideDuringLock(pointerLocked);
};
const setLockButtonHot = hot => {
  if (hot === lockButtonHot) return;
  lockButtonHot = hot;
  // Only meaningful while locked; unlocked, the whole window already takes clicks.
  if (pointerLocked) native('shell', { type: 'pointer_lock_hover', hot });
};
window.addEventListener('mousemove', event => {
  if (!pointerLocked) return;
  const button = $('pointer-lock');
  if (!button || button.hidden) { setLockButtonHot(false); return; }
  const r = button.getBoundingClientRect();
  setLockButtonHot(event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom);
}, { capture: true, passive: true });
/** The persisted pan must be re-applied whenever a new renderer is created. */
const applyStoredModelOffset = () => renderer?.setModelOffset?.(lastDisplayConfig?.artOffsetX ?? 0, lastDisplayConfig?.artOffsetY ?? 0);
// Movement mode: while on, dragging the character pans the model inside its canvas (the model
// keeps its size). Capture phase + stopPropagation keeps the pet-window handlers from also
// treating the gesture as a window drag or a click-to-chat.
let moveMode = false;
let moveDrag = null;
const setMoveMode = on => {
  moveMode = on === true;
  const button = $('model-move');
  if (button) {
    button.setAttribute('aria-pressed', String(moveMode));
    button.title = moveMode
      ? '正在调整模型：滚轮缩放模型、拖动平移模型（再点关闭；长按重置模型位置和大小）'
      : '点击开启调整模型（滚轮缩放、拖动平移）；长按重置窗口大小'
  }
  $('character').dataset.moveMode = String(moveMode);
  if (!moveMode) moveDrag = null;
};
const character = $('character');
// Cursor following: the operator's explicit choice, so it drives the rig directly instead of going
// through the optional proc-head/proc-body catalog rows (an imported model has neither).
let lookMode = false, lookPoint = { x: 0, y: 0 };
const setLookMode = on => {
  lookMode = on === true;
  const button = $('model-look');
  if (button) {
    button.setAttribute('aria-pressed', String(lookMode));
    button.title = lookMode
      ? '正在注视鼠标：眼睛、头部和身体一起跟随（再点关闭）'
      : '点击让模型注视鼠标（眼睛、头部和身体一起跟随；再点关闭）';
  }
  // The main process owns the OS cursor poll, because the page cannot see the pointer once it leaves
  // the window. Following therefore continues outside the window instead of stopping at its edge.
  native('shell', { type: 'look_cursor', enabled: lookMode });
  if (lookMode) {
    lookPoint = { x: 0, y: 0 };
    renderer?.setLookTarget?.(0, 0, true);
  } else {
    renderer?.setLookTarget?.(0, 0, false);
  }
};
/** -1..1 relative to the visible character area; y is inverted because screen y grows downward. */
const lookFromClient = (clientX, clientY) => {
  const rect = character.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: Math.max(-1, Math.min(1, (clientX - (rect.left + rect.width / 2)) / Math.max(1, rect.width / 2))),
    y: Math.max(-1, Math.min(1, (clientY - (rect.top + rect.height / 2)) / Math.max(1, rect.height / 2))),
  };
};
const applyLook = point => {
  if (!lookMode || !point) return;
  lookPoint = point;
  renderer?.setLookTarget?.(point.x, point.y, true);
};
// In-window pointer: cheapest and most precise while the cursor is over the pet.
window.addEventListener('mousemove', event => {
  if (!lookMode) return;
  applyLook(lookFromClient(event.clientX, event.clientY));
}, { capture: true, passive: true });
$('model-look')?.addEventListener('click', () => setLookMode(!lookMode));
character.addEventListener('pointerdown', event => {
  if (!moveMode || moveDrag || (event.button !== undefined && event.button !== 0)) return;
  event.stopPropagation();
  moveDrag = { id: event.pointerId, x: event.screenX, y: event.screenY };
  character.setPointerCapture(event.pointerId);
}, { capture: true });
character.addEventListener('pointermove', event => {
  if (!moveDrag || moveDrag.id !== event.pointerId) return;
  event.stopPropagation(); event.preventDefault();
  const dx = event.screenX - moveDrag.x, dy = event.screenY - moveDrag.y;
  moveDrag.x = event.screenX; moveDrag.y = event.screenY;
  // Fractions of canvas width so the model tracks the pointer exactly at any zoom.
  const rect = character.getBoundingClientRect();
  const current = renderer?.modelOffset?.() ?? { x: 0, y: 0 };
  const w = Math.max(1, rect.width);
  const applied = renderer?.setModelOffset?.(current.x + dx / w, current.y + dy / w);
  if (applied) native('shell', { type: 'set_model_offset', x: applied.x, y: applied.y });
}, { capture: true });
const endMoveDrag = event => {
  if (!moveDrag || moveDrag.id !== event.pointerId) return;
  event.stopPropagation();
  moveDrag = null;
  if (character.hasPointerCapture?.(event.pointerId)) character.releasePointerCapture(event.pointerId);
};
character.addEventListener('pointerup', endMoveDrag, { capture: true });
character.addEventListener('pointercancel', endMoveDrag, { capture: true });
// Long-press the move button to reset the model to its default position and size. A short
// press still toggles the adjust mode; only a press held past the threshold resets.
// Wheel-zoom state for both modes. Movement-mode model scale and non-movement-mode window zoom are
// separate quantities in the shell (prefs.characterScale and prefs.width) and must stay separate here
// too: one shared accumulator made each mode start from the size the other one was left at, so
// switching modes snapped the model or the window to the other mode's scale before it zoomed.
let wheelZoom = createWheelZoom(lastDisplayConfig);
const MOVE_LONG_PRESS_MS = 600;
let movePressTimer, moveLongPressFired = false;
const moveButton = $('model-move');
const clearMovePress = () => { if (movePressTimer) { clearTimeout(movePressTimer); movePressTimer = undefined; } };
moveButton.addEventListener('pointerdown', event => {
  if (event.button !== undefined && event.button !== 0) return;
  clearMovePress();
  moveLongPressFired = false;
  movePressTimer = setTimeout(() => {
    movePressTimer = undefined; moveLongPressFired = true;
    // The gesture belongs to whichever layer the button is currently driving, so the
    // reset is routed by mode: window framing when off, model framing when on.
    native('shell', { type: moveMode ? 'reset_model_framing' : 'reset_window_framing' });
    // The shell just reset its own value; re-seed both from the config that comes back, so the next
    // notch continues from the reset size instead of the size that was on screen before the reset.
    wheelZoom = syncWheelZoom(wheelZoom, lastDisplayConfig);
  }, MOVE_LONG_PRESS_MS);
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) moveButton.addEventListener(type, clearMovePress);
$('model-move').onclick = event => {
  event.stopPropagation();
  setMoveMode(!moveMode);
};
if (moveLongPressFired) { moveLongPressFired = false; }
// Rebind: swallow the click that follows a long press so it does not also toggle the mode.
moveButton.addEventListener('click', event => { if (moveLongPressFired) { event.stopImmediatePropagation(); moveLongPressFired = false; } }, { capture: true });
$('pointer-lock').onclick = event => {
  event.stopPropagation();
  const next = !pointerLocked;
  syncPointerLock(next);
  native('shell', { type: 'set_passthrough', locked: next });
};
window.petBridge = { receive, connectionChanged, hotkeyConfig, hotkeyEvent, pointerLock: value => syncPointerLock(value?.locked), displayConfig: config => {
 display.receive(config); petWindow.receive(config);
 // The renderer does not exist yet on the first config (it is created after initialDisplay),
 // so remember the value and let selectRenderer apply it.
 lastDisplayConfig = config;
  if (Number.isFinite(config?.zoomScale)) liveFraming.zoomScale = config.zoomScale;
  if (Number.isFinite(config?.artOffsetX)) liveFraming.artOffsetX = config.artOffsetX;
  if (Number.isFinite(config?.artOffsetY)) liveFraming.artOffsetY = config.artOffsetY;
  // Never overwrite an in-flight pan: the renderer holds the authoritative live value.
  if (!moveDrag) renderer?.setModelOffset?.(config?.artOffsetX ?? 0, config?.artOffsetY ?? 0);
  // A CSS-scaled element would otherwise stretch a fixed-size backing store, so raise
  // the canvas resolution to match the movement-mode zoom.
  renderer?.setResolutionScale?.(Number.isFinite(config?.characterScale) ? config.characterScale : 1);
 if (['video','live2d'].includes(config.rendererKind) && config.rendererKind !== rendererKind) { rendererKind = config.rendererKind; if(rendererBooted) void selectRenderer(rendererKind); }
 initialDisplayResolve?.(); initialDisplayResolve=undefined;
 renderer?.setSuspended?.(petWindow.collapsed || document.hidden);
 if (workbench.isOpen) workbench.position(); if (records.isOpen) records.position();
},
 managementResult,workbenchOpenResult:result=>workbench.nativeOpenResult(result),
 // OS cursor poll from the main process, used while the pointer is outside the window.
 lookCursor:value=>applyLook(value&&Number.isFinite(value.x)&&Number.isFinite(value.y)?{x:value.x,y:value.y}:null) };
window.desktopHost?.subscribe((method, ...args) => window.petBridge[method]?.(...args));
window.WhaleDesktop = { express: async payload => {
  if (renderer?.kind !== 'video' || !renderer.ready) throw Error('请先选择视频鲸鱼');
  return renderer.invoke(payload);
}, physicsDiagnostics: () => renderer?.physicsDiagnostics?.() ?? null, motionTuning: () => renderer?.motionTuning?.() ?? null, setMotionTuning: patch => renderer?.setMotionTuning?.(patch) ?? null, modelZoom: () => renderer?.modelZoom ?? null, setModelZoom: value => renderer?.setModelZoom?.(value) ?? null, modelOffset: () => renderer?.modelOffset?.() ?? null, setModelOffset: (x, y) => renderer?.setModelOffset?.(x, y) ?? null, snapshot: () => renderer ? {kind:renderer.kind,ready:renderer.ready,...(renderer.ready ? renderer.snapshot() : {})} : null };
// Wheel over the character zooms the model. Non-passive so the page never scrolls
// instead. The native shell scales the character box and grows the window to fit, so
// the enlarged model is never clipped by the pet pane.
{
  const wheelTarget = $('character');
  // The wheel has two jobs. Outside movement mode it resizes the whole window, so the model,
  // the pane and the corner controls scale together. Inside movement mode it scales only the
  // model, leaving the window and the controls untouched.
  wheelTarget.addEventListener('wheel', event => {
    if (petWindow.collapsed) return;
    event.preventDefault();
    // One message per notch, for the mode that is active. The other mode's value is untouched.
    const action = applyWheel(wheelZoom, { moveMode, deltaY: event.deltaY });
    if (action) native('shell', action);
  }, { passive: false });
}
$('model-kind').onchange = () => { const kind = $('model-kind').value; if(window.desktopHost) native('shell',{type:'set_renderer',rendererKind:kind}); else void selectRenderer(kind); };
// Rename the character from the panel. Enter or leaving the field commits; the shell stores it and
// echoes the new name back, so this box and the chat header stay in step.
$('character-name-input').onchange = () => {
  const name = $('character-name-input').value.trim().slice(0, 24);
  const label = $('character-name');
  if (name && label) label.textContent = name;
  $('character-name-input').value = name;
  if (name) native('shell', { type: 'set_character_name', characterName: name });
};
// Seed the field from the header, which the shell fills with the saved name.
{
  const field = $('character-name-input'), label = $('character-name');
  if (field && label && !field.value) field.value = label.textContent.trim();
}
$('video-play').onclick = () => renderer?.request?.($('video-action').value);
$('video-reassure').onclick = () => renderer?.reassure?.();
$('open').onclick = () => panel(true); $('close').onclick = () => panel(false); $('quit').onclick = () => { wake.disconnect();captureFeedback.stop();void stopPlayback(); stopCapture(); native('shell', { type: 'quit' }); };
$('text').oninput = () => { clearWorkSpeech();workSpeechBlocked=true;interactionFocusEpoch++; work.input(!!displayedInputBinding()); chat.setDraft(view.characterId, $('text').value); fitComposer(); };
$('text').oncompositionstart = () => { composing = true; };
$('text').oncompositionend = () => { composing = false; };
$('text').onkeydown = event => {
  if (event.key !== 'Enter') return;
  if (composing || event.isComposing || event.keyCode === 229) { event.preventDefault(); return; }
  if (!event.shiftKey) { event.preventDefault(); $('form').requestSubmit(); }
};
$('form').onsubmit = event => {
  event.preventDefault(); const text = $('text').value.trim();
  if (composing || event.isComposing || !text || !connection.connected || chat.pending(view.characterId)) return;
  $('text').value = ''; command({ type: 'submit_text', text });
};
$('text').onfocus = () => report({ type: 'input-focus', active: document.activeElement === $('text') });
$('voice').onclick = () => timedVoiceInput(performance.now(),'voice-button',()=>command({ type: voicePhase !== 'idle' ? 'finish_voice' : 'start_voice' }));
$('stop').onclick = () => command({ type: 'cancel' });
$('invitation').onclick = () => { if (view.invitation) { const id = view.invitation.id; view.invitation = null; panel(true); command({ type: 'click_invitation', invitationId: id }); } };
const petWindowControl = target => ['pet-collapse', 'pet-ball', 'workbench-collapse', 'work-records-collapse'].includes(target?.id);
const editing = target => ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable || ['view-full', 'view-half', 'model-resize', 'management', 'workbench-open'].includes(target?.id) || petWindowControl(target);
document.addEventListener('keydown', e => {
  const receivedAt=performance.now();
  if(petWindow.collapsed)return;
  if(workbench.isOpen){if(e.key==='Tab'){workbench.tab(e);return;}if(e.key==='Escape'){e.preventDefault();e.stopPropagation();workbench.close();return;}}
  if(e.key==='Tab'&&records.isOpen){records.tab(e);return;}
  if(e.key==='Escape'&&records.isOpen){e.preventDefault();e.stopPropagation();records.close();return;}
  if (e.key === 'Escape' && display.cancel(e)) return;
  if (bindingKey || composing || e.isComposing || e.keyCode === 229) return;
  if (!editing(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && timedVoiceInput(receivedAt,'keyboard',()=>hold.down(e.code,e.repeat))) { e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === 'Escape') { if (playback.busy || capturing || voicePhase !== 'idle' || view.scope) command({ type: 'cancel' }); else panel(false); }
}, true);
document.addEventListener('keyup', e => { if (hold.up(e.code)) { e.preventDefault(); e.stopPropagation(); } }, true);
document.addEventListener('focusin', e => { if (editing(e.target) && !petWindowControl(e.target)) hold.cancel(); });
window.addEventListener('blur', () => { hold.cancel(); display.cancel(); petWindow.cancel(); });
document.addEventListener('visibilitychange', () => { renderer?.setSuspended?.(document.hidden || petWindow.collapsed); introductionEpoch++; introductionFramePending = false; if (document.hidden) { hold.cancel(); display.cancel(); petWindow.cancel(); } else {presentNativeWork();workbench.schedulePresentation();scheduleIntroductionAck();} });
window.addEventListener('pagehide', () => { display.cancel(); connectionChanged({ generation: connection.generation, state: 'disconnected' }); void stopPlayback(); stopCapture(); renderer?.dispose(); });
window.addEventListener('error', e => report({ type: 'script-error', message: e.message }));
window.addEventListener('unhandledrejection', e => report({ type: 'promise-error', message: String(e.reason) }));
renderUI(); native('shell', { type: 'ready' });
// The first displayConfig can be delivered before this page's bridge exists, and the page cannot
// finish booting until one arrives. Ask for the current framing so the handshake always completes.
native('shell', { type: 'request_display_config' });
let frame = 0, lastRender = 0;
{
  await initialDisplay; rendererBooted = true; await selectRenderer(rendererKind);
// Apply the persisted model position once a renderer exists, including after a renderer switch.
void applyStoredModelOffset();
  function animate(at) { requestAnimationFrame(animate); if (at - lastRender > 32) { if (view.expireInvitation(Date.now())) renderUI(); const shown=workSpeechView.state==='speaking'?workSpeechView:view;if (!petWindow.collapsed && !document.hidden) renderer?.updateView(shown,voicePhase==='preparing'?'listening':shown.state,(work.focused||workInputSource==='native')&&shown===view); lastRender = at; frame++; } }
  requestAnimationFrame(animate);
  // Bounded telemetry of model parameters only, never transcript/audio/frame contents.
  let lastTrace = 0;
  setInterval(() => { if (playback.busy && renderer?.ready && performance.now() - lastTrace > 700) { lastTrace = performance.now(); report({ type: 'speaking-parameters', ...renderer.snapshot() }); } }, 500);
}
