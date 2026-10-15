// Executes the actual renderer entry and view/playback state in a minimal DOM.
// Only asset/device adapters are replaced; no browser or device is opened.
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const bridgeVersion=(await readFile('contracts/desktop-bridge.ts','utf8')).match(/DESKTOP_BRIDGE_VERSION\s*=\s*'([^']+)'/)[1];
import {build} from 'esbuild';
const built=await build({entryPoints:['desktop/main.mjs'],bundle:true,write:false,format:'esm',platform:'browser',define:{'import.meta.url':JSON.stringify('pet://app/build/renderer.js')},plugins:[{
 name:'silent-devices', setup(b){
  b.onResolve({filter:/cubism-renderer\.mjs|browser-playback\.ts|browser-capture\.ts/},a=>({path:a.path,namespace:'silent'}));
  b.onLoad({filter:/.*/,namespace:'silent'},a=>({resolveDir:process.cwd(),contents:a.path.includes('cubism')?`
   export class JellyfishRenderer { ready=true; async load(){} setAutomaticPolicy(policy){harness.policy=policy;(harness.policies??=[]).push(policy)} setFraming(mode){harness.framing=mode} reset(options){harness.resets++;harness.resetOptions=options} beginAttention(){harness.order.push('attention');harness.attention=(harness.attention??0)+1} snapshot(){return {}} dispose(){} updateView(view,interaction,working){harness.presented={state:view.state,mouth:view.mouth,working}} }
  `:a.path.includes('wake/browser-capture')?`
   export class BrowserWakeCapture {
    constructor(options){this.options=options;this.closes=0;this.clips=0;this.cameras=0;(harness.wakeDrivers??=[]).push(this)}
    open(signal){this.signal=signal;return new Promise((r,j)=>{this.ready=r;this.reject=j})}
    close(){this.closes++}
    authorizeCaptureCamera(){this.cameras++}
    beginCapture(){this.clips++;const driver=this;return {stop(){driver.clipStops=(driver.clipStops??0)+1},async finish(){driver.finishes=(driver.finishes??0)+1;return {audio:new Uint8Array([1,2,3]),images:[],captureStoppedAt:'2026-09-15T00:00:00Z'}}}}
   }
  `:a.path.includes('playback')?`
   export class BrowserPlaybackDriver { async open(bytes,id,emit,signal){
    harness.playOpens++;if(harness.playbackError)throw new Error(harness.playbackError);
    let done; const session={done:new Promise(r=>done=r),stop(){harness.playStops++;harness.order.push('output-stop');done()}};
    harness.playback={emit,signal,session};if(harness.delayPlaybackOpen)return new Promise(r=>{harness.resolvePlayback=()=>r(session)});return session;
   }}
  `:`
   import {captureFailure} from './media/capture-errors.ts';
   export class BrowserCaptureDriver { constructor(options){harness.captureDiagnostic=options.onDiagnostic;harness.captureLevel=options.onLevel} open(signal){ harness.captureOpens++;harness.captureOpenReplyRenders=harness.replyRenders;harness.captureSignal=signal;return new Promise((r,j)=>{harness.openCapture=r;harness.rejectCapture=j}).catch(error=>{throw captureFailure(error,'get_user_media',signal)}) }}
  `}));
 }
}]});
export async function app({explicitRouting=false}={}){
 const nodes=new Map(),created=[],listeners=new Map();
 const element=()=>{let ownText='',ownClass='',ownStyle={};const e={id:'',hidden:false,disabled:false,textContent:'',value:'',children:[],dataset:{},
   // A real CSSStyleDeclaration carries assignments and setProperty alike; the renderer publishes the
   // model scale with setProperty on documentElement, and sets plain properties elsewhere.
   style:{getPropertyValue(name){return ownStyle[name]??''},setProperty(name,value){ownStyle[name]=String(value)},removeProperty(name){delete ownStyle[name]},get cssText(){return Object.entries(ownStyle).map(([k,v])=>k+':'+v).join(';')}},
   get className(){return ownClass},set className(value){ownClass=String(value)},
   // The renderer queries inside nodes: display-controls looks for the drawer header, and work-records
   // collects focusable buttons. Only appended children are searched; an unmatched query returns null
   // or an empty list, which every caller already guards for.
   querySelector(selector){return queryWithin(this,selector)[0]??null},
   querySelectorAll(selector){return queryWithin(this,selector)},
   closest(selector){return matchesSelector(this,selector)?this:null},
   getClientRects(){return this.hidden?[]:[this.getBoundingClientRect()]},getBoundingClientRect(){return {left:0,top:0,right:300,bottom:100,width:300,height:100}},
   after(n){created.push(n);if(n.id)nodes.set(n.id,n)},append(...items){this.children.push(...items)},appendChild(n){this.append(n);return n},contains(n){return this===n||this.children.some(c=>typeof c==='object'&&c.contains?.(n))},replaceChildren(...items){if(this.id==='reply')harness.replyRenders=(harness.replyRenders??0)+1;this.textContent='';this.children=items},
   setPointerCapture(id){this.captured=id},hasPointerCapture(id){return this.captured===id},releasePointerCapture(){this.captured=null},setAttribute(name,value){this[name]=value;if(this.id==='capture-wave-path'&&name==='d')harness.waveWrites=(harness.waveWrites??0)+1},addEventListener(name,fn){(this.listeners??=new Map()).set(name,fn)},focus(){context.document.activeElement=this},blur(){if(context.document.activeElement===this)context.document.activeElement=null},show(){this.open=true},showModal(){this.open=true},close(){this.open=false}};Object.defineProperty(e,'textContent',{get(){return ownText+this.children.map(x=>typeof x==='string'?x:x.textContent).join(' ')},set(value){ownText=String(value);this.children=[]}});return e};
 const find=(e,id)=>e.id===id?e:e.children?.map(c=>typeof c==='object'?find(c,id):null).find(Boolean);
 // Selector support for the queries the renderer makes. Each comma-separated part is reduced to the
 // tag, #id and .class it names; pseudo-classes such as :not([disabled]) are dropped, so
 // 'button:not([disabled])' matches any button. This is enough for the harness, which supplies no
 // attributes or pseudo-state of its own.
 const selectorParts=selector=>String(selector).split(',').map(part=>{
  const cleaned=part.trim().replace(/::?[\w-]+(\([^)]*\))?/g,'');
  return {tag:(cleaned.match(/^[a-zA-Z][\w-]*/)??[])[0]?.toUpperCase(),id:(cleaned.match(/#([\w-]+)/)??[])[1],classes:[...cleaned.matchAll(/\.([\w-]+)/g)].map(m=>m[1])};
 });
 const matchesSelector=(e,selector)=>typeof e==='object'&&!!e&&selectorParts(selector).some(part=>
  (!part.tag||e.tagName?.toUpperCase()===part.tag)&&(!part.id||e.id===part.id)&&part.classes.every(name=>String(e.className??'').split(/\s+/).includes(name)));
 const queryWithin=(root,selector)=>{const out=[];(function walk(node){for(const child of node.children??[]){if(typeof child!=='object'||!child)continue;if(matchesSelector(child,selector))out.push(child);walk(child)}})(root);return out};
 const node=id=>{const actual=[...nodes.values(),...created].map(e=>find(e,id)).find(Boolean);if(actual)return actual;if(!nodes.has(id)){const e=element();e.id=id;nodes.set(id,e)}return nodes.get(id)};
 const emit=(el,type,value={})=>{const e={preventDefault(){},...value};el['on'+type]?.(e);el.listeners?.get(type)?.(e)};
 const read=e=>e.textContent+' '+e.children.map(x=>typeof x==='string'?x:read(x)).join(' ');
 const renderedText=()=>[...nodes.values(),...created].map(read).join(' ');
 const frames=[],messages=[],timers=new Map(),harness={resets:0,playStops:0,playOpens:0,captureOpens:0,order:[]};let timer=0;
 const context={harness,console,structuredClone,AbortController,URL,Uint8Array,Float32Array,DataView,Date,performance,crypto:globalThis.crypto,atob,btoa,isSecureContext:true,navigator:{userAgent:'controlled DOM'},location:{origin:'pet://app'},
  // documentElement is present because the renderer publishes the model scale as a CSS custom property
  // on it (display-controls sets --character-scale) so labels nested in the scaled model can cancel it.
  document:{hidden:false,body:node('body'),documentElement:element(),getElementById:node,createElement:()=>element(),addEventListener(name,fn){listeners.set(name,fn)}},
  window:{webkit:{messageHandlers:Object.fromEntries(['desktop','shell','diagnostic'].map(name=>[name,{postMessage(value){if(name==='desktop'&&value.message?.command?.type==='start_voice')harness.startReplyRenders=harness.replyRenders??0;if(name==='desktop'&&value.message?.command)harness.order.push('command:'+value.message.command.type);if(name==='desktop'&&value.message.command?.type==='start_voice')harness.feedbackAtSend={hidden:node('capture-feedback').hidden,phase:node('capture-feedback').dataset.phase};messages.push({name,value})}}]))},addEventListener(name,fn){listeners.set('window:'+name,fn)}},
  requestAnimationFrame(fn){frames.push(fn)},setInterval(){},setTimeout(fn){timers.set(++timer,fn);return timer},clearTimeout(id){timers.delete(id)}};
 await vm.runInNewContext('(async()=>{'+built.outputFiles[0].text+'})()',context);
 const bridge=context.window.petBridge;
 const changed=(generation,state='connecting',extra={})=>bridge.connectionChanged({generation,state,canRetry:true,...extra});
 const ready=(generation=1,sessionId='s1',characterId='companion',introduction)=>bridge.receive({channel:'backend_ready',bridgeVersion,characterId,sessionId,introduction},generation);
 const originalReceive = bridge.receive;
 bridge.receive = (message, generation) => {
  // Fixtures echo the current start token just like the actual backend. Tests of
  // stale starts supply an explicit older token and bypass this default.
  if (message.channel === 'event' && message.event.type === 'turn' && message.event.input.kind === 'voice' && message.event.input.clientRequestId === undefined) {
   const start = messages.filter(m=>m.name==='desktop' && m.value.generation===generation && m.value.message.command?.type==='start_voice').at(-1);
   message = { ...message, event: { ...message.event, input: { ...message.event.input, clientRequestId: start?.value.message.command.clientRequestId } } };
  }
  if(message.channel==='event'&&message.event.type==='turn'&&message.event.input.kind==='text'&&message.event.input.clientRequestId===undefined){
   let start=messages.filter(m=>m.name==='desktop'&&m.value.generation===generation&&m.value.message.command?.type==='submit_text').at(-1);
   if(!start&&!explicitRouting&&message.event.input.scope.characterId==='companion'){node('text').value='合成输入';node('form').onsubmit({preventDefault(){}});start=messages.filter(m=>m.name==='desktop'&&m.value.message.command?.type==='submit_text').at(-1);}
   message={...message,event:{...message.event,input:{...message.event.input,clientRequestId:start?.value.message.command.clientRequestId}}};
  }
  const result=originalReceive(message, generation);
  // Legacy tests explicitly synthesize the new route receipt. New routing tests
  // opt out and exercise missing/late/work routes with the actual entry.
  if(!explicitRouting && message.channel==='event') {
   const e=message.event;
   if(e.type==='turn')originalReceive({channel:'input_route',scope:e.input.scope,route:'companion'},generation);
   if(e.type==='transcript')originalReceive({channel:'input_route',scope:e.scope,route:'companion'},generation);
  }
  return result;
 };
 const wire=()=>messages.filter(m=>m.name==='desktop');
 return {frame(at=performance.now()){const work=frames.splice(0);for(const fn of work)fn(at)},document:context.document,node,messages,timers,harness,bridge,changed,ready,wire,emit,renderedText,listeners};
}
