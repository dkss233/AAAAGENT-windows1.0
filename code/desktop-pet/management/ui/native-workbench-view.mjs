import {el,button,notice} from './dom.mjs';
import {nativeOpenReceiptValid} from './workbench-view.mjs';

// The serving process declares its own entry. Never infer this from a port or failed request.
export function managementEntryMode(doc=document){
 const entries=doc.querySelectorAll('meta[name="aaa-management-entry"]');
 if(entries.length!==1||entries[0].getAttribute('data-version')!=='0.1.0')return null;
 const mode=entries[0].getAttribute('content');
 return ['original-management','mounted-readonly'].includes(mode)?mode:null;
}

const returnKey='aaa-original-management-return-v1';
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=250&&!/[\x00-\x1f\x7f]/.test(value);
function loopbackOrigin(value){
 if(typeof value!=='string')return false;
 try{const url=new URL(value);return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!!url.port&&Number(url.port)>0&&url.origin===value&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password;}catch{return false;}
}
const deniedMedia="camera 'none'; microphone 'none'; autoplay 'none'";
function microphonePolicy(origin,enabled){
 return enabled&&loopbackOrigin(origin)?`camera 'none'; microphone ${origin}; autoplay 'none'`:deniedMedia;
}
export function managementFrameOrigin(doc=document,origin=location.origin){
 const entries=doc.querySelectorAll('meta[name="aaa-management-frame-origin"]');
 if(entries.length!==1||entries[0].getAttribute('data-version')!=='0.1.0')return null;
 const value=entries[0].getAttribute('content');return loopbackOrigin(value)&&value!==origin?value:null;
}
export function originalManagementRelation(value,origin){
 return value&&Object.keys(value).sort().join(',')==='environmentId,navigationId,origin,path,version'&&
  value.version==='0.1.1'&&value.path==='/'&&loopbackOrigin(value.origin)&&value.origin===origin&&identifier(value.environmentId)&&
  typeof value.navigationId==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.navigationId)?{...value}:null;
}
export function originalFrameMessage(value,relation,parent=false){
 if(!value||!relation||value.source!==(parent?'aaa-original-management-parent':'aaa-original-management-frame')||value.version!=='0.1.0'||
  value.navigationId!==relation.navigationId||value.environmentId!==relation.environmentId)return false;
 const keys=Object.keys(value).sort().join(',');
 if(parent)return keys==='environmentId,mode,navigationId,source,type,version'&&value.type==='appearance.state'&&['light','dark','system'].includes(value.mode);
 if(['ready','return'].includes(value.type))return keys==='environmentId,navigationId,source,type,version';
 return value.type==='error'&&(['environmentId,navigationId,phase,source,type,version','environmentId,navigationId,source,type,version'].includes(keys))&&
  (value.phase===undefined||['expired','offline','error'].includes(value.phase));
}

// A desktop launch carries an already issued frame receipt in the normal
// management URL fragment. It never grants another API or dispatch operation.
export function consumeOriginalNativeEntry(current,frameOrigin){
 const values=new URLSearchParams(current.hash.slice(1)).getAll('nativeEntry');
 if(!values.length)return null;
 try{
  if(values.length!==1||values[0].length>16384||!frameOrigin)throw Error();
  const receipt=JSON.parse(values[0]),target=receipt?.target;
  if(!['home','project','task'].includes(target?.kind)||
     target.kind==='task'&&![target.taskId,target.threadId,target.t3ProjectId,target.providerInstanceId,target.workspaceRoot].every(identifier)||
     !nativeOpenReceiptValid(receipt,target.kind,target.projectId,target.kind==='task'?{...target,id:target.taskId}:null)||
     new URL(receipt.url).origin!==frameOrigin)throw Error();
  const relation=originalManagementRelation(receipt.originalManagementReturn,current.origin);
  if(!relation||relation.environmentId!==target.environmentId)throw Error();
  return {receipt,error:false};
 }catch{return {receipt:null,error:true};}
}

// Own only the overlay and one consumed browser relationship. All form state stays in the original document.
export function createOriginalManagementFrameView(client,getHost,initialEntry=null){
 const origin=location.origin,frameOrigin=managementFrameOrigin();
 let identity=null,epoch=0,pending=null,disposed=false,active=false,frame=null,relation=null,ready=false,timer=null;
 let phase='idle',savedFocus=null,savedScroll=null,savedInert=false;
 const parentApp=document.getElementById('app');
 const portal=el('section',{class:'native-workbench-portal',hidden:true,'aria-label':'原生工程工作台'});
 Object.assign(portal.style,{left:'0',top:'0',width:'100vw',height:'100dvh'});
 const frameHost=el('div',{class:'native-workbench-frame-host'}),message=el('div',{class:'native-workbench-state'});portal.append(frameHost,message);document.body.append(portal);
 const hostIdentity=()=>{const host=getHost();return JSON.stringify([host.authEpoch,host.instanceId,host.connection]);};
 const online=()=>getHost().connection==='online'&&identifier(getHost().instanceId);
 function clear(){epoch++;pending?.abort();pending=null;clearTimeout(timer);timer=null;ready=false;relation=null;frame?.remove();frame=null;}
 function leave(){
  if(!active)return;if(!ready)clear();active=false;portal.hidden=true;frameHost.inert=true;if(parentApp)parentApp.inert=savedInert;
  if(savedFocus?.isConnected)savedFocus.focus({preventScroll:true});if(savedScroll)window.scrollTo(savedScroll.x,savedScroll.y);
 }
 function update(){
  portal.dataset.phase=phase;portal.hidden=!active;frameHost.inert=!active||!ready;frameHost.style.visibility=ready?'visible':'hidden';
  message.hidden=ready;
  const texts={connecting:'正在打开已有工程工作台…',loading:'正在读取真实项目与对话…',expired:'本机原生会话已失效，请重新打开。原管理页的编辑仍保留。',offline:'完整工程工作台暂不可用。原管理页的编辑仍保留。',error:'工程入口无法核对或未能加载。请返回原管理页后重试。'};
  message.replaceChildren(notice(texts[phase]??texts.error,['error','expired'].includes(phase)?'warning':'muted'),button('返回管理',leave));
  if(active&&!ready)message.querySelector('button')?.focus({preventScroll:true});
 }
 function sync(){
  const next=hostIdentity();if(next===identity)return;const changed=identity!==null;identity=next;clear();phase=online()?'idle':getHost().connection==='locked'?'expired':'offline';
  if(changed&&active){phase=online()?'error':phase;update();}
 }
 function appearanceChanged(){
  const mode=getHost().appearance?.state().mode;if(!ready||!frame||!relation||!['light','dark','system'].includes(mode))return;
  frame.contentWindow.postMessage({source:'aaa-original-management-parent',version:'0.1.0',navigationId:relation.navigationId,environmentId:relation.environmentId,type:'appearance.state',mode},frameOrigin);
 }
 async function enter(project=null,issued=null){
  sync();if(disposed||pending||active)return;
  savedFocus=document.activeElement;savedScroll={x:scrollX,y:scrollY};savedInert=parentApp?.inert??false;
  active=true;if(parentApp)parentApp.inert=true;
  if(ready&&frame&&relation&&project===null){update();appearanceChanged();frame.focus({preventScroll:true});return;}
  clear();phase='connecting';update();
  if(managementEntryMode()!=='original-management'||!frameOrigin||!online()||project!==null&&!identifier(project?.id)){phase=online()?'error':'offline';update();return;}
  const at=epoch,currentIdentity=identity,controller=new AbortController();pending=controller;
  const target=issued?.receipt?.target?.kind??(project===null?'home':'project'),projectId=issued?.receipt?.target?.projectId??project?.id;
  try{
   if(issued?.error)throw Error('invalid_initial_native_entry');
   const value=issued?.receipt??await client.request('/api/workbench/native-open',{method:'POST',credentials:'same-origin',body:{target,...(projectId?{projectId}:{})},signal:controller.signal});
   if(disposed||controller.signal.aborted||at!==epoch||identity!==currentIdentity||hostIdentity()!==currentIdentity)return;
   const returned=originalManagementRelation(value?.originalManagementReturn,origin);
   const originalTarget=issued?.receipt?.target;
   if(!nativeOpenReceiptValid(value,target,projectId,target==='task'?{...originalTarget,id:originalTarget.taskId}:null)||new URL(value.url).origin!==frameOrigin||!returned||returned.environmentId!==value.target.environmentId)throw Error('invalid_native_open_receipt');
   // Delegate only to the verified intermediate origin before its first navigation.
   // Its authenticated mount still denies media to read-only native documents.
   relation=returned;phase='loading';frame=el('iframe',{class:'native-workbench-frame',title:'真实原生项目与对话',referrerPolicy:'no-referrer',allow:microphonePolicy(frameOrigin,true),src:value.url});frameHost.append(frame);update();
   timer=setTimeout(()=>{timer=null;if(!disposed&&at===epoch&&!ready){phase='error';update();}},Math.min(60000,Date.parse(value.expiresAt)-Date.now()));
  }catch(error){
   if(disposed||controller.signal.aborted||at!==epoch||identity!==currentIdentity)return;
   phase=error.status===401||error.status===403?'expired':error.status===503?'offline':'error';update();
  }finally{if(pending===controller)pending=null;}
 }
 function onMessage(event){
  if(disposed||!active||!frame||!relation||event.source!==frame.contentWindow||event.origin!==frameOrigin||hostIdentity()!==identity||!online()||!originalFrameMessage(event.data,relation))return;
  if(event.data.type==='ready'&&phase==='loading'){ready=true;phase='ready';clearTimeout(timer);timer=null;update();appearanceChanged();frame.focus({preventScroll:true});}
  else if(event.data.type==='return'&&ready)leave();
  else if(event.data.type==='error'){const failed=event.data.phase??'error';clear();phase=failed;update();}
 }
 window.addEventListener('message',onMessage);
 return {sync,enter,open:enter,openInitial(){if(initialEntry!==null&&online()){const value=initialEntry;initialEntry=null;void enter(null,value);}},refresh(){},view:()=>el('div'),afterRender(){},appearanceChanged,isRetainingPage:()=>active,
  dispose(){disposed=true;clear();leave();window.removeEventListener('message',onMessage);portal.remove();}};
}

// Only the routes emitted by the identity-checked pet browser ticket are accepted.
export function nativeEntryTarget(raw,origin,environmentId){
 if(typeof raw!=='string'||!raw||raw.includes('#')||raw.includes('\\')||/[\x00-\x20\x7f]/.test(raw))return null;
 try{
  const url=new URL(raw,origin);if(url.origin!==origin||url.username||url.password||!url.pathname.startsWith('/native/'))return null;
  const segments=url.pathname.slice(8).split('/').map(decodeURIComponent),keys=[...url.searchParams.keys()];
  const identifier=value=>typeof value==='string'&&!!value&&value.length<=250&&!/[\x00-\x1f\x7f]/.test(value);
  if(['pair','login'].includes(segments[0]))return null;
  let targetEnvironment=null;
  if(segments.length===1&&segments[0]===''){
   if(keys.length){
    if(keys.length!==2||new Set(keys).size!==2||!keys.includes('aaaProject')||!keys.includes('aaaEnvironment')||!identifier(url.searchParams.get('aaaProject')))return null;
    targetEnvironment=url.searchParams.get('aaaEnvironment');if(!identifier(targetEnvironment))return null;
   }
  }else{
   if(segments.length!==2||!segments.every(identifier)||keys.length)return null;
   targetEnvironment=segments[0];
  }
  if(environmentId!==undefined&&targetEnvironment!==null&&targetEnvironment!==environmentId)return null;
  return {path:url.pathname+url.search,environmentId:targetEnvironment};
 }catch{return null;}
}
export function consumeInitialNativeEntry(current,history){
 const url=new URL(current.href),values=url.searchParams.getAll('nativePath');if(!values.length)return null;
 const target=values.length===1&&[...url.searchParams.keys()].length===1?nativeEntryTarget(values[0],url.origin):null;
 url.searchParams.delete('nativePath');history.replaceState(null,'',url.pathname+url.search+url.hash);
 return {path:target?.path??null,error:!target};
}

export function validNativeSession(value,now=Date.now()){
 const until=Date.parse(value?.expiresAt);
 return value?.apiVersion===1&&(['native-read','native-operate'].includes(value.mode))&&value.mountPath==='/native/'&&value.readonly===(value.mode==='native-read')&&
  Object.keys(value).sort().join(',')==='apiVersion,environmentId,expiresAt,mode,mountPath,readonly'&&typeof value.environmentId==='string'&&!!value.environmentId.trim()&&Number.isFinite(until)&&until>now;
}
// Contains only the mount lifecycle. Project/thread state remains in the original app.
export function createNativeMountSession(client,getHost,onChange=()=>{},now=Date.now){
 let identity=null,epoch=0,pending=null,timer=null,disposed=false;
 let state={phase:'idle',session:null};
 const publish=phase=>{state={...state,phase};onChange();};
 const clear=()=>{epoch++;pending?.abort();pending=null;if(timer!==null)clearTimeout(timer);timer=null;};
 function sync(){
  const host=getHost(),next=JSON.stringify([host.authEpoch,host.instanceId,host.connection]);
  if(next!==identity){identity=next;clear();state={phase:host.connection==='online'?'idle':host.connection==='locked'?'expired':'offline',session:null};onChange();}
 }
 async function connect(renew=false){
  sync();if(disposed||pending||getHost().connection!=='online')return;
  const previous=renew&&state.phase==='ready'?state.session:null;
  clear();const at=epoch,controller=new AbortController();pending=controller;
  if(previous){timer=setTimeout(()=>{timer=null;if(!disposed&&at===epoch){controller.abort();publish('expired');}},Math.max(1,Date.parse(previous.expiresAt)-now()));}
  else publish('connecting');
  try{
   const value=await client.request('/api/native-mount/session',{method:'POST',body:{},credentials:'same-origin',signal:controller.signal});
   if(disposed||at!==epoch||controller.signal.aborted)return;
   if(!validNativeSession(value,now()))throw Error('Invalid mount response');
   if(previous&&value.environmentId!==previous.environmentId)throw Error('Native environment changed');
   if(timer!==null)clearTimeout(timer);
   state={phase:'ready',session:value};
   const remaining=Date.parse(value.expiresAt)-now();
   timer=setTimeout(()=>{timer=null;if(!disposed&&at===epoch){if(remaining>60_000)void connect(true);else publish('expired');}},Math.min(2147483647,remaining>60_000?remaining-60_000:remaining));
   onChange();
  }catch(e){if(disposed||at!==epoch||controller.signal.aborted)return;state={phase:e.status===401||e.status===403?'expired':e.status===503?'offline':'error',session:null};onChange();}
  finally{if(pending===controller)pending=null;}
 }
 return {sync,connect,state:()=>state,fail(phase='error'){clear();publish(phase);},dispose(){disposed=true;clear();},};
}

export function createNativeWorkbenchView(client,render,getHost,initialEntry=null){
 let disposed=false,active=false,frame=null,loaded=false,timer=null,mountedSession=null,sessionEnvironment=null,lastPath='/native/';
 let initialPath=initialEntry?.path??null,entryError=initialEntry?.error===true;
 let animation=null,transitionPending=false,transitionFrom=null,focusPending=false,lastFocus=null;
 const parentReturn=(()=>{if(window.parent===window)return null;try{const value=JSON.parse(sessionStorage.getItem(returnKey));return value?.origin!==location.origin?originalManagementRelation(value,value?.origin):null;}catch{return null;}})();
 let parentReady=false,parentError=null,mountStarted=false,mountedIdentity=null;
 const connectionIdentity=()=>{const host=getHost();return JSON.stringify([host.authEpoch,host.instanceId,host.connection]);};
 function notifyParent(type,phase){
  if(!parentReturn)return;
  window.parent.postMessage({source:'aaa-original-management-frame',version:'0.1.0',navigationId:parentReturn.navigationId,environmentId:parentReturn.environmentId,type,...(phase?{phase}:{})},parentReturn.origin);
 }
 function returnToManagement(page){if(parentReturn)notifyParent('return');else getHost().navigate?.(page);}
 const portal=el('section',{class:'native-workbench-portal',hidden:true,'aria-label':'原生工程工作台'});
 const frameHost=el('div',{class:'native-workbench-frame-host'});
 const message=el('div',{class:'native-workbench-state'});
 portal.append(frameHost,message);
 const mount=createNativeMountSession(client,getHost,()=>{update();queueMicrotask(()=>{if(!disposed)render();});});
 function rememberPath(){
  try{const url=new URL(frame.contentWindow.location.href);if(url.origin===location.origin&&url.pathname.startsWith('/native/')&&!/^\/native\/(pair|login)(\/|$)/.test(url.pathname))lastPath=url.pathname+url.search;}catch{}
 }
 function update(){
  const state=entryError?{...mount.state(),phase:'error'}:mount.state();portal.dataset.phase=state.phase;
  if(parentReturn&&state.phase==='ready'&&(state.session.environmentId!==parentReturn.environmentId||getHost().connection!=='online'||connectionIdentity()!==mountedIdentity)){mount.fail();return;}
  // Updating `allow` alone cannot revoke a loaded document's inherited policy.
  // Destroy the operable document on auth loss, expiry or reconnect; drafts remain
  // in the original app's persistent store and only a verified route is retained.
  if(frame&&mountedSession?.mode==='native-operate'&&state.phase!=='ready'){
   rememberPath();frame.remove();frame=null;loaded=false;mountedSession=null;
  }
  const media=microphonePolicy(location.origin,state.phase==='ready'&&state.session?.mode==='native-operate'&&
   validNativeSession(state.session)&&getHost().connection==='online');
  if(!active&&!animation&&!transitionPending)portal.hidden=true;frameHost.inert=!active||state.phase!=='ready';frameHost.style.visibility=state.phase==='ready'?'visible':'hidden';
  const texts={idle:'正在准备原生工作台…',connecting:'正在连接已有原生服务…',expired:'本机原生会话已失效。草稿保留，重新连接后继续查看。',offline:'原生服务暂时不可用。可以重试连接，已有任务不会重新提交。',error:'原生工作台未能打开。请重试连接。'};
  message.hidden=state.phase==='ready'&&loaded;
  const messages=[notice(entryError?'原任务入口无效或与当前环境不一致，请从桌宠重新打开。':state.phase==='ready'?'正在读取真实项目与对话…':texts[state.phase],state.phase==='expired'||state.phase==='error'?'warning':'muted')];
  if(state.phase!=='ready'||!loaded)messages.push(button('返回管理',()=>returnToManagement('overview')));
  if(!entryError&&!['connecting','ready','idle'].includes(state.phase))messages.push(button('重新连接原生工作台',()=>mount.connect(),{disabled:getHost().connection!=='online'}));
  message.replaceChildren(...messages);
  if(state.phase==='ready'&&state.session!==mountedSession){
   const continuous=frame&&loaded&&mountedSession?.mode===state.session.mode&&mountedSession.environmentId===state.session.environmentId;
   mountedSession=state.session;if(!continuous)loaded=false;const sameEnvironment=sessionEnvironment===state.session.environmentId;
   if(!sameEnvironment){lastPath='/native/';sessionEnvironment=state.session.environmentId;}
   if(initialPath!==null){
    const target=nativeEntryTarget(initialPath,location.origin,state.session.environmentId);initialPath=null;
    if(!target){entryError=true;update();return;}
    lastPath=target.path;
   }
   if(frame&&!continuous){if(sameEnvironment)rememberPath();frame.allow=media;frame.title=state.session.mode==='native-operate'?'真实原生项目与对话':'真实原生项目与对话（只读）';frame.src=lastPath;}
  }
  if(state.phase==='ready'&&!frame){
   frame=el('iframe',{class:'native-workbench-frame',title:state.session.mode==='native-operate'?'真实原生项目与对话':'真实原生项目与对话（只读）',referrerPolicy:'no-referrer',allow:media,src:lastPath});
   frame.addEventListener('load',()=>{inspect();update();});frameHost.append(frame);
  }
  message.hidden=state.phase==='ready'&&loaded;
  if(parentReturn&&state.phase==='ready'&&loaded&&!parentReady){parentReady=true;parentError=null;notifyParent('ready');}
  if(parentReturn&&mountStarted&&['expired','offline','error'].includes(state.phase)&&parentError!==state.phase){parentError=state.phase;notifyParent('error',state.phase);}
  sendState();if(!animation)focusWorkspace();
 }
 function inspect(){
  if(!active||!frame||mount.state().phase!=='ready')return;
  try{if(frame.contentWindow.location.href==='about:blank')return;const url=new URL(frame.contentWindow.location.href);if(url.origin!==location.origin||!url.pathname.startsWith('/native/'))mount.fail();
   else if(/^\/native\/(pair|login)(\/|$)/.test(url.pathname))mount.fail('expired');
   else {lastPath=url.pathname+url.search;if(frame.contentDocument.querySelector('.aaa-workspace-shell')){loaded=true;update();}else if(frame.contentDocument.readyState==='complete'&&!frame.contentDocument.getElementById('root')){
    let phase='error';if(frame.contentDocument.contentType==='application/json')try{const value=JSON.parse(frame.contentDocument.querySelector('pre')?.textContent??frame.contentDocument.body.textContent);if(value.error==='native_auth_expired')phase='expired';}catch{}
    if(phase==='expired')mount.fail(phase);else failDocument();
   }}}catch{failDocument();}
 }
 function failDocument(){
  const session=mount.state().session;mount.fail();
  // WebKit can replace an HTTP 401 document with its own HTML error page.
  // Read the public auth state instead of treating that document as a live app.
  void (async()=>{let phase='error';try{
   const response=await fetch('/api/auth/session',{method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error'});
   if(response.status===401||response.status===403)phase='expired';else if(response.status>=500)phase='offline';
   else if(response.ok&&(await response.json()).authenticated===false)phase='expired';
  }catch{phase='offline';}
  if(!disposed&&mount.state().session===session&&mount.state().phase==='error')mount.fail(phase);
  })();
 }
 function rectStyle(r){return {left:`${r.left}px`,top:`${r.top}px`,width:`${r.width}px`,height:`${r.height}px`};}
 function targetRect(){return active?{left:0,top:0,width:innerWidth,height:innerHeight}:
  (document.getElementById('nav-workbench')?.getBoundingClientRect()??{left:0,top:0,width:208,height:72});}
 function focusWorkspace(){
  if(!focusPending||!active||!loaded||mount.state().phase!=='ready')return;
  focusPending=false;
  try{const target=lastFocus?.isConnected?lastFocus:frame.contentDocument.querySelector('.aaa-menu-trigger');target?.focus({preventScroll:true});}catch{}
 }
 function position(){
  if(!active&&!animation&&!transitionPending)return;
  const to=rectStyle(targetRect());
  if(transitionPending){
   transitionPending=false;portal.hidden=false;
   const from=rectStyle(transitionFrom??targetRect());Object.assign(portal.style,to);
   portal.style.pointerEvents=active?'auto':'none';portal.inert=!active;
   const finish=()=>{animation=null;Object.assign(portal.style,rectStyle(targetRect()));portal.hidden=!active;portal.dataset.transition='settled';focusWorkspace();};
   if(!window.matchMedia('(prefers-reduced-motion: reduce)').matches&&typeof portal.animate==='function'){
    const current=portal.animate([from,to],{duration:260,easing:'cubic-bezier(.2,.7,.2,1)'});animation=current;
    portal.dataset.transition=active?'entering':'leaving';
    current.finished.then(()=>{if(animation===current)finish();},()=>{});
   }else finish();
  }else if(!animation&&active){portal.hidden=false;Object.assign(portal.style,to);focusWorkspace();}
 }
 function sendState(){
  const appearance=getHost().appearance?.state();if(!frame||!appearance)return;
  frame.contentWindow?.postMessage({source:'aaa-workspace-ui',version:1,type:'shell.state',mode:appearance.mode,resolved:appearance.resolved,phase:mount.state().phase},location.origin);
 }
 function onMessage(event){
  if(disposed||!frame||event.origin!==location.origin||event.source!==frame.contentWindow||mount.state().phase!=='ready'||!loaded)return;
  try{const url=new URL(frame.contentWindow.location.href);if(url.origin!==location.origin||!url.pathname.startsWith('/native/'))return;}catch{return;}
  const value=event.data;if(!value||value.source!=='aaa-workspace-ui'||value.version!==1)return;
  if(value.type==='shell.ready')sendState();
  else if(value.type==='management.navigate'&&active&&['overview','memory','projects','tasks','wechat','models','presentation','events'].includes(value.page))returnToManagement(value.page);
  else if(value.type==='appearance.set'&&['light','dark','system'].includes(value.mode))getHost().appearance?.set(value.mode);
 }
 function onParentMessage(event){
  if(disposed||!parentReturn||event.source!==window.parent||event.origin!==parentReturn.origin||!originalFrameMessage(event.data,parentReturn,true)||
   getHost().connection!=='online'||connectionIdentity()!==mountedIdentity||mount.state().phase!=='ready'||mount.state().session?.environmentId!==parentReturn.environmentId)return;
  getHost().appearance?.set(event.data.mode);
 }
 function sync(){
  const host=getHost(),next=host.page==='workbench';
  if(next!==active){transitionFrom=portal.hidden?document.getElementById('nav-workbench')?.getBoundingClientRect():portal.getBoundingClientRect();animation?.cancel();animation=null;transitionPending=true;focusPending=next;
   if(!next)try{lastFocus=frame?.contentDocument.activeElement;}catch{}
   active=next;
  }
  document.body.classList.toggle('native-workbench-active',active);mountedIdentity=connectionIdentity();mount.sync();
  if(!entryError&&active&&host.connection==='online'&&mount.state().phase==='idle'){mountStarted=true;void mount.connect();}
  update();
 }
 function afterRender(){
  if(!portal.isConnected)document.body.append(portal);
  position();
  if(!active&&transitionPending===false&&portal.dataset.transition==='leaving')document.querySelector('.main h1')?.focus({preventScroll:true});
 }
 window.addEventListener('message',onMessage);
 window.addEventListener('message',onParentMessage);
 window.addEventListener('resize',position);document.addEventListener('scroll',position,true);
 timer=setInterval(inspect,2000);
 return {sync,open(){},refresh(){if(!entryError&&active&&mount.state().phase==='idle'){mountStarted=true;void mount.connect();}},view(){return el('div',{class:'native-workbench-page'},
  el('div',{id:'native-workbench-placeholder',class:'native-workbench-placeholder'}));},afterRender,appearanceChanged:sendState,
  dispose(){disposed=true;mount.dispose();animation?.cancel();clearInterval(timer);window.removeEventListener('message',onMessage);window.removeEventListener('message',onParentMessage);window.removeEventListener('resize',position);document.removeEventListener('scroll',position,true);portal.remove();document.body.classList.remove('native-workbench-active');}};
}
