import {query} from './api.mjs';
import {el,button,badge,notice,definition,field,select} from './dom.mjs';
import {createProjectMemoryView} from './project-memory-view.mjs';

const phases={recorded:'已记录',accepted:'已接收',running:'运行中',waiting_approval:'等待批准',waiting_answer:'等待回答',completed:'已完成',failed:'失败',cancelled:'已取消',unknown:'待核对'};
const providers={codex:'Codex',dsh:'DeepSeek Harness'};
const id=value=>typeof value==='string'&&!!value.trim()&&value.length<=250;
const printable=value=>typeof value==='string'&&!!value.trim();
const taskOk=(task,projectId)=>task&&task.projectId===projectId&&id(task.id)&&Object.hasOwn(providers,task.provider)&&(
 task.origin==='t3'&&['environmentId','t3ProjectId','threadId','providerInstanceId'].every(key=>id(task[key]))||
 task.origin==='legacy_codex_app'&&id(task.hostId)&&id(task.nativeSessionId)||
 task.origin==='legacy_dsh'&&id(task.profileId)&&id(task.nativeSessionId));
const projectionOk=(value,taskId)=>value===null||value&&value.taskId===taskId&&Number.isSafeInteger(value.sequence)&&value.sequence>=0&&id(value.eventId)&&Object.hasOwn(phases,value.phase)&&
 ['nativeTurnId','resultRef'].every(key=>value[key]===undefined||typeof value[key]==='string');
const previewOk=row=>row.resultPreview===undefined||row.projection?.phase==='completed'&&row.resultPreview?.nativeTurnId===row.projection.nativeTurnId&&id(row.resultPreview.messageId)&&typeof row.resultPreview.text==='string'&&[...row.resultPreview.text].length<=320&&typeof row.resultPreview.truncated==='boolean';
const rowOk=(row,projectId)=>row&&taskOk(row.task,projectId)&&projectionOk(row.projection,row.task.id)&&previewOk(row);
const nativeIdentity=task=>task?.origin==='t3'&&taskOk(task,task.projectId)&&
 (task.nativeSessionId===undefined||id(task.nativeSessionId))?
 JSON.stringify([task.id,task.projectId,task.provider,task.origin,task.environmentId,task.t3ProjectId,
  task.threadId,task.providerInstanceId,task.nativeSessionId??null]):null;
const focusOk=(value,projectId)=>value&&value.version==='0.1.0'&&value.projectId===projectId&&
 Number.isSafeInteger(value.revision)&&value.revision>=0&&
 (value.task===null||value.task.projectId===projectId&&nativeIdentity(value.task)!==null);
const statusOk=value=>value&&value.version==='0.1.1'&&typeof value.readAvailable==='boolean'&&typeof value.dispatchEnabled==='boolean'&&
 ['verified_same_origin_task_detail','unavailable'].includes(value.sourceOpening)&&typeof value.preciseTurnJump==='boolean';
const detailPath=(projectId,taskId)=>query('/api/workbench/task-detail',{projectId,taskId});
const expectedDetailApi=(projectId,taskId)=>'/api/workbench/task-detail?projectId='+encodeURIComponent(projectId)+'&taskId='+encodeURIComponent(taskId);
const detailOk=(value,projectId,taskId,target)=>value&&taskOk(value.task,projectId)&&value.task.id===taskId&&value.task.origin==='t3'&&
 value.native?.thread?.id===value.task.threadId&&value.native.thread.projectId===value.task.t3ProjectId&&
 value.native.thread.modelSelection?.instanceId===value.task.providerInstanceId&&
 (!target||target.environmentId===value.task.environmentId&&target.threadId===value.task.threadId);
const sourceOk=(value,projectId,taskId)=>value&&value.status==='verified_task'&&value.projectId===projectId&&value.taskId===taskId&&
 id(value.environmentId)&&id(value.threadId)&&value.detailApi===expectedDetailApi(projectId,taskId)&&
 value.sourceIdsVerified===false&&value.preciseTurnJump===false;
const safeError=error=>error?.status===404?'任务未建立可信项目映射，暂不能打开。':error?.status===409?'项目或任务绑定已变化，请重新核对。':
 error?.status===401||error?.status===403?'本机会话已失效，请重新连接。':'本机任务暂不可读取，请稍后核对。';
const sourceError=error=>error?.status===404?'该来源未找到可信任务绑定，原始引用仍可复制。':safeError(error);
const createText=value=>typeof value==='string'&&!!value.trim()&&value.length<=250&&!/[\u0000-\u001f\u007f]/u.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(value);
const catalogCurrent=value=>value?.available===true&&typeof value.checkedAt==='string'&&Number.isFinite(Date.parse(value.checkedAt))&&
 Date.now()-Date.parse(value.checkedAt)>=-60000&&Date.now()-Date.parse(value.checkedAt)<=15*60000;
const catalogOk=value=>value&&value.version==='0.1.0'&&typeof value.available==='boolean'&&value.provider==='codex'&&value.instanceId==='codex'&&
 Array.isArray(value.models)&&value.models.length<=500&&value.models.every(model=>createText(model.id)&&createText(model.name))&&
 new Set(value.models.map(model=>model.id)).size===value.models.length&&
 (value.available?value.models.length>0&&catalogCurrent(value):value.checkedAt===null&&value.models.length===0);
const createStages={project:'项目创建回执',thread:'任务创建回执',environment:'原生环境',project_readback:'项目读回',thread_readback:'任务读回'};
const recoveryStages=new Set(['project','thread','thread_readback']);
const recoveredRequestOk=(value,projectId,operationId)=>value&&value.operationId===operationId&&value.projectId===projectId&&
 createText(value.title)&&value.provider==='codex'&&value.modelSelection?.instanceId==='codex'&&createText(value.modelSelection.model)&&
 Object.keys(value).sort().join(',')==='modelSelection,operationId,projectId,provider,title'&&
 Object.keys(value.modelSelection).sort().join(',')==='instanceId,model';
const recoveryRowOk=(value,projectId)=>value&&uuid(value.operationId)&&typeof value.createdAt==='string'&&
 Number.isFinite(Date.parse(value.createdAt))&&['unknown','conflict'].includes(value.state)&&recoveryStages.has(value.stage)&&
 (value.request===null||recoveredRequestOk(value.request,projectId,value.operationId));
const creationsOk=(value,projectId)=>value&&value.version==='0.1.0'&&value.projectId===projectId&&
 Array.isArray(value.creations)&&value.creations.length<=500&&value.creations.every(row=>recoveryRowOk(row,projectId))&&
 new Set(value.creations.map(row=>row.operationId)).size===value.creations.length;
const continuationText=value=>typeof value==='string'&&!!value.trim()&&value.length<=120000&&!value.includes('\0');
const continuationDraftOk=(value,task,messageId,rawText)=>value&&uuid(value.id)&&uuid(value.commandId)&&
 Number.isSafeInteger(value.version)&&value.version>=1&&['open','claimed','dismissed'].includes(value.state)&&
 nativeIdentity(value.task)===nativeIdentity(task)&&value.input?.inputId===messageId&&
 value.input.origin?.channel==='web'&&id(value.input.origin.channelSessionId)&&
 value.input.origin.messageId===messageId&&value.input.rawText===rawText&&continuationText(value.input.rawText)&&
 continuationText(value.input.dispatchText)&&typeof value.input.createdAt==='string'&&Number.isFinite(Date.parse(value.input.createdAt));
const continuationListOk=(value,projectId,task,revision)=>value&&value.version==='0.1.0'&&
 value.projectId===projectId&&value.taskId===task.id&&value.focusRevision===revision&&
 typeof value.truncated==='boolean'&&Array.isArray(value.drafts)&&value.drafts.length<=20&&
 value.drafts.every(draft=>continuationDraftOk(draft,task,draft.input?.origin?.messageId,draft.input?.rawText)&&
  draft.state!=='dismissed')&&new Set(value.drafts.map(draft=>draft.id)).size===value.drafts.length;
const continuationResultOk=(value,draft)=>value&&value.commandId===draft.commandId&&
 ['recorded','accepted','conflict','unsupported','unknown'].includes(value.state)&&
 (value.task===undefined||nativeIdentity(value.task)===nativeIdentity(draft.task));
const interactionOk=(value,task)=>value&&id(value.id)&&value.taskId===task.id&&
 Number.isSafeInteger(value.version)&&value.version>=0&&['pending','answered','expired','unknown'].includes(value.state)&&
 ['durable','live_only'].includes(value.answerLifetime)&&
 (value.kind==='approval'&&typeof value.summary==='string'&&Array.isArray(value.choices)&&value.choices.length>0&&
  value.choices.length<=30&&value.choices.every(choice=>id(choice.id)&&printable(choice.label)&&
   (choice.warning===undefined||typeof choice.warning==='string'))&&
  new Set(value.choices.map(choice=>choice.id)).size===value.choices.length&&
  (value.choiceSource===undefined||['provider','t3_default'].includes(value.choiceSource))||
 value.kind==='question'&&Array.isArray(value.questions)&&value.questions.length>0&&value.questions.length<=20&&
  value.questions.every(question=>id(question.id)&&printable(question.prompt)&&
   (question.options===undefined||Array.isArray(question.options)&&question.options.length<=30&&
    question.options.every(option=>id(option.id)&&printable(option.label)&&
     (option.description===undefined||typeof option.description==='string'))&&
    new Set(question.options.map(option=>option.id)).size===question.options.length)&&
   (question.allowMultiple===undefined||typeof question.allowMultiple==='boolean')&&
   (question.allowCustomAnswer===undefined||typeof question.allowCustomAnswer==='boolean')&&
   ((question.options?.length||0)>0||question.allowCustomAnswer===true))&&
  new Set(value.questions.map(question=>question.id)).size===value.questions.length);
const interactionListOk=(value,task)=>value&&['supported','unsupported','unverified'].includes(value.status)&&
 nativeIdentity(value.task)===nativeIdentity(task)&&Array.isArray(value.interactions)&&value.interactions.length<=100&&
 value.interactions.every(item=>interactionOk(item,task))&&
 new Set(value.interactions.map(item=>item.id)).size===value.interactions.length;
const interactionBindingsOk=(value,task)=>value&&['supported','unsupported'].includes(value.status)&&
 nativeIdentity(value.task)===nativeIdentity(task)&&Array.isArray(value.bindings)&&
 value.bindings.every(binding=>id(binding.interactionId)&&id(binding.commandId)&&
  ['approval','question'].includes(binding.kind)&&Number.isSafeInteger(binding.requestVersion)&&binding.requestVersion>=0)&&
 new Set(value.bindings.map(binding=>binding.interactionId)).size===value.bindings.length;
const interactionReadOk=(value,attempt)=>value&&value.command&&id(value.command.commandId)&&
 (!attempt.commandId||value.command.commandId===attempt.commandId)&&
 ['recorded','accepted','conflict','unsupported','unknown'].includes(value.command.state)&&
 ['pending','answered','expired','unknown'].includes(value.resolution)&&
 (value.command.task===undefined||nativeIdentity(value.command.task)===nativeIdentity(attempt.task))&&
 (value.interaction===undefined||interactionOk(value.interaction,attempt.task)&&
  value.interaction.id===attempt.id&&value.interaction.version===attempt.version);
const interactionBlank=()=>({list:null,target:null,bindings:null,bindingsTarget:null,bindingsError:'',
 selectedId:null,answers:{},attempts:{},error:'',busy:false});

export function nativeOpenReceiptValid(value,target,projectId,task){
  if(value?.version!=='0.1.0'||value.status!=='ready'||value.target?.kind!==target||
   !id(value.target.environmentId)||value.target.projectId!==projectId||
   target==='project'&&!id(value.target.t3ProjectId)||
   target==='task'&&(!task||value.target.taskId!==task.id||
    value.target.environmentId!==task.environmentId||value.target.threadId!==task.threadId||
    task.t3ProjectId&&value.target.t3ProjectId!==task.t3ProjectId||
    task.providerInstanceId&&value.target.providerInstanceId!==task.providerInstanceId))return false;
  const until=Date.parse(value.expiresAt);
  if(!Number.isFinite(until)||until<=Date.now()||until>Date.now()+60000)return false;
  try{const url=new URL(value.url);
   return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&
    url.username===''&&url.password===''&&url.port!==''&&url.pathname==='/open'&&url.search===''&&
    /^#[A-Za-z0-9_-]{43}$/u.test(url.hash);
  }catch{return false;}
 }

export function createWorkbenchView(client,render,getHost,openProjects,navigate=url=>window.location.assign(url)){
 const states=new Map(),reads=new Map();
 let project=null,section='memory',epoch=0,identity=null,disposed=false;
 const nativeOpen={busy:false,error:'',message:''};
 let navigationTimer=null,navigationLeave=null;
 function stopNavigationWatch(){
  if(navigationTimer!==null)clearTimeout(navigationTimer);
  if(navigationLeave)window.removeEventListener('pagehide',navigationLeave);
  navigationTimer=null;navigationLeave=null;
 }
 function watchNavigation(at,hostIdentity){
  navigationLeave=()=>{stopNavigationWatch();nativeOpen.busy=false;nativeOpen.message='';};
  window.addEventListener('pagehide',navigationLeave,{once:true});
  navigationTimer=setTimeout(()=>{
   stopNavigationWatch();nativeOpen.busy=false;
   if(disposed||epoch!==at||identity!==hostIdentity)return;
   nativeOpen.message='';nativeOpen.error='浏览器仍停留在原页；请重新打开工程入口。任务不会重发。';render();
  },4000);
 }
 const memory=createProjectMemoryView(client,render,getHost,openSource);
 const state=()=>project?states.get(project.id):null;
 const online=()=>getHost().connection==='online';
 const blank=()=>({rows:null,status:null,selected:null,detail:null,source:null,error:'',message:'',stale:true,
  loading:new Set(),busy:false,verifiedTaskId:null,catalog:null,catalogError:'',createDraft:{title:'',model:''},
  creations:null,creationsError:'',selectedCreationId:null,createPending:null,createBusy:false,createMessage:'',createError:'',
  focus:null,focusError:'',focusBusy:false,localSelection:false,
  interaction:interactionBlank(),
  continuation:{raw:'',reviewed:'',reviewedEdited:false,draft:null,pending:null,editText:'',phase:'compose',busy:false,
   error:'',receipt:null,discovered:null,discoveryError:'',uncertainConfirmation:false,commandRead:null}});
 function abort(){for(const controller of reads.values())controller.abort();reads.clear();for(const value of states.values()){value.loading.clear();value.busy=false;}}
 function invalidate(){epoch++;abort();}
 function sync(){
  memory.sync();
  const host=getHost(),next=[host.authEpoch,host.instanceId,host.connection].join('/');
  if(next!==identity){
   const changed=identity!==null&&next!==identity;
   identity=next;invalidate();
   stopNavigationWatch();nativeOpen.busy=false;nativeOpen.error='';nativeOpen.message='';
   for(const value of states.values()){
    value.stale=true;value.status=null;value.selected=null;value.source=null;value.detail=null;value.verifiedTaskId=null;value.catalog=null;
    value.focus=null;value.focusError='';value.localSelection=false;
    value.continuation.discovered=null;value.continuation.discoveryError='';
    value.interaction.list=null;value.interaction.target=null;value.interaction.bindings=null;
    value.interaction.bindingsTarget=null;value.interaction.selectedId=null;
    value.creations=null;value.creationsError='';value.selectedCreationId=null;
    if(value.createPending)value.createPending={...value.createPending,error:'连接已更新，请从服务端重新读取未完成创建。'};
    if(changed){value.source=null;value.selected=null;value.rows=null;}
   }
  }
 }

 async function openNative(target,sourceContext=null){
  if(nativeOpen.busy||!online()||disposed)return;
  const current=state(),projectId=target==='home'?undefined:project?.id;
  const row=target==='task'?current?.rows?.find(entry=>entry.task.id===current.selected):null;
  const savedTask=target==='task'&&row?.task.origin==='t3'&&current?.focus?.task?.id===row.task.id&&
   nativeIdentity(current.focus.task)===nativeIdentity(row.task)&&!current.stale&&!current.localSelection?row.task:null;
  const sourceTask=target==='task'&&sourceContext&&current?.source===sourceContext&&
   sourceOk(sourceContext.target,projectId,sourceContext.source.taskId)?
   {id:sourceContext.source.taskId,environmentId:sourceContext.target.environmentId,threadId:sourceContext.target.threadId}:null;
  const task=sourceContext?sourceTask:savedTask;
  if(target!=='home'&&!projectId||target==='task'&&!task){nativeOpen.error='请先保存并核对准确的原生任务焦点。';render();return;}
  nativeOpen.busy=true;nativeOpen.error='';nativeOpen.message='';render();
  const at=epoch,hostIdentity=identity;
  let navigationRequested=false;
  const body={target,...(projectId?{projectId}:{}),...(task?{taskId:task.id}:{})};
  if(!sourceContext&&target!=='home'&&current?.focus?.projectId===projectId)body.expectedFocusRevision=current.focus.revision;
  try{
   const value=await client.request('/api/workbench/native-open',{method:'POST',credentials:'same-origin',body});
   if(disposed||epoch!==at||identity!==hostIdentity||
    sourceContext&&state()?.source!==sourceContext||
    savedTask&&(!current?.focus||current.focus.revision!==body.expectedFocusRevision||
     nativeIdentity(current.focus.task)!==nativeIdentity(savedTask)))return;
   if(!nativeOpenReceiptValid(value,target,projectId,task))throw Error('invalid_native_open_receipt');
   nativeOpen.message='正在切换至工程入口…';render();
   watchNavigation(at,hostIdentity);
   navigate(value.url);
   navigationRequested=true;
  }catch(error){
   stopNavigationWatch();nativeOpen.message='';
   if(disposed||epoch!==at||identity!==hostIdentity)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   nativeOpen.error=error.status===401||error.status===403?'本机会话已失效，请重新连接。':
    error.status===409?'项目或任务焦点已变化，请刷新后重新打开。':
    error.status===503?'完整工程工作台暂不可用，请稍后重新打开。':
    error.message==='invalid_native_open_receipt'?'打开回执或票据无法核对，请重新打开。':
    '打开未完成，请检查本机服务后重新打开。';
  }finally{if(!navigationRequested){nativeOpen.busy=false;if(!disposed)render();}}
 }
 function open(next){
  if(!next||!id(next.id))return;
  invalidate();
  const old=state();if(old){old.selected=null;old.detail=null;old.source=null;old.focus=null;old.localSelection=false;}
  project={id:next.id,name:next.name||next.id,rootPath:typeof next.detailRef?.rootPath==='string'?next.detailRef.rootPath:null};
  if(!states.has(next.id))states.set(next.id,blank());
  const current=state();current.selected=null;current.detail=null;current.source=null;current.focus=null;current.focusError='';current.localSelection=false;
  current.continuation.discovered=null;current.continuation.discoveryError='';
  current.interaction.list=null;current.interaction.target=null;current.interaction.bindings=null;
  current.interaction.bindingsTarget=null;current.interaction.selectedId=null;
  memory.open(project);section='memory';
 }
 async function read(key,path,options,accept,onFailure){
  const current=state(),projectId=project?.id,at=epoch;
  if(!current||disposed||!online())return;
  reads.get(key)?.abort();
  const controller=new AbortController();reads.set(key,controller);current.loading.add(key);render();
  try{
   const value=await client.request(path,{...options,signal:controller.signal});
   if(disposed||epoch!==at||project?.id!==projectId||reads.get(key)!==controller)return;
   accept(value,current,projectId);
  }catch(error){
   if(error.name!=='AbortError'&&!disposed&&epoch===at&&project?.id===projectId&&reads.get(key)===controller){
    if(error.status===401||error.status===403)getHost().onError(error);
    if(onFailure)onFailure(error,current);
    else current.error=safeError(error);
   }
  }finally{
   if(reads.get(key)===controller){reads.delete(key);current.loading.delete(key);render();}
  }
 }
 function loadStatus(){
  return read('status','/api/workbench/status',{},(value,current)=>{
   if(!statusOk(value))throw Error('invalid_workbench_status');
   current.status=value;
   if(interactionTarget(current))loadInteractions();
  },(error,current)=>{current.status=null;current.error=safeError(error);});
 }
 function reconcileFocus(current){
  if(current.source||current.localSelection||!current.focus||current.stale||!current.rows)return;
  const saved=current.focus.task;
  if(!saved){current.selected=null;current.detail=null;return;}
  const row=current.rows.find(entry=>entry.task.id===saved.id);
  if(!row||nativeIdentity(row.task)!==nativeIdentity(saved)){
   current.selected=null;current.detail=null;
   current.focusError='已保存的任务不在当前项目列表，或原生身份已变化；本页没有恢复旧选择。';
   return;
  }
  if(current.selected!==row.task.id){
   current.selected=row.task.id;current.detail=null;
  }
 }
 function loadFocus(){
  const projectId=project?.id,current=state();if(!current||!projectId)return;
  current.focus=null;current.focusError='';
  if(!current.source&&!current.localSelection){current.selected=null;current.detail=null;}
  return read('focus',query('/api/workbench/focus',{projectId}),{credentials:'same-origin'},(value,active,id)=>{
   if(!focusOk(value,id))throw Error('invalid_workbench_focus');
   active.focus=value;reconcileFocus(active);
  },(error,active)=>{
   active.focus=null;if(!active.source&&!active.localSelection){active.selected=null;active.detail=null;}
   active.focusError=error.status===401||error.status===403?'本机会话已失效，请重新连接。':
    '已保存的任务选择暂不可核对；列表可临时查看，但本页选择不会保存。请刷新后再试。';
  });
 }
 function loadTasks(){
  const projectId=project?.id;if(!projectId)return;
  state().stale=true;
  return read('tasks',query('/api/workbench/tasks',{projectId}),{},(value,current,id)=>{
   if(!Array.isArray(value?.tasks)||value.tasks.length>500||!value.tasks.every(row=>rowOk(row,id))||
       new Set(value.tasks.map(row=>row.task.id)).size!==value.tasks.length)throw Error('invalid_workbench_tasks');
   current.rows=value.tasks;current.stale=false;
   if(current.selected&&!value.tasks.some(row=>row.task.id===current.selected)&&!current.source)current.selected=null;
   reconcileFocus(current);
  },(error,current)=>{current.stale=true;current.error=safeError(error);});
 }
 function loadCatalog(){
  const current=state();if(!current)return;
  current.catalog=null;current.catalogError='';
  return read('catalog','/api/workbench/provider-models',{},(value,active)=>{
   if(!catalogOk(value))throw Error('invalid_provider_models');
   active.catalog=value;
   if(!value.available)active.catalogError='当前账号模型目录不可用，暂不能新建任务。';
   else if(active.createDraft.model&&!value.models.some(model=>model.id===active.createDraft.model))active.catalogError='原选模型已不在当前账号目录，请重新选择。';
  },(error,active)=>{active.catalog=null;active.catalogError=error.status===401||error.status===403?'本机会话已失效，请重新连接。':'当前账号模型目录暂不可核实，请稍后刷新。';});
 }
 function loadCreations(){
  const projectId=project?.id,current=state();if(!current||!projectId)return;
  current.creations=null;current.creationsError='';
  return read('creations',query('/api/workbench/tasks/creations',{projectId}),{},(value,active,id)=>{
   if(!creationsOk(value,id))throw Error('invalid_create_recovery');
   active.creations=value.creations;
   if(!value.creations.some(row=>row.operationId===active.selectedCreationId))active.selectedCreationId=value.creations[0]?.operationId||null;
   if(!active.createBusy&&active.createPending&&value.creations.some(row=>row.operationId===active.createPending.input.operationId))active.createPending=null;
  },(error,active)=>{active.creations=null;active.creationsError=error.status===401||error.status===403?'本机会话已失效，请重新连接。':'未完成创建暂不可读取，当前不能安全继续。';});
 }
 function loadTaskPage(){
  const current=state();if(!current||!online())return;
  current.error='';current.message='';
  current.continuation.discovered=null;current.continuation.discoveryError='';
  current.interaction.list=null;current.interaction.target=null;current.interaction.bindings=null;
  current.interaction.bindingsTarget=null;current.interaction.selectedId=null;
  if(!current.source){current.localSelection=false;current.selected=null;current.detail=null;}
  return Promise.all([loadStatus(),loadTasks(),loadFocus()]);
 }
 function loadDetail(taskId){
  const projectId=project?.id;if(!projectId||!id(taskId))return;
  state().detail=null;
  return read('detail',detailPath(projectId,taskId),{},(value,current,id)=>{
   const row=current.rows?.find(entry=>entry.task.id===taskId);
   if(current.selected!==taskId||!detailOk(value,id,taskId,current.source?.target)||
      row?.task.origin==='t3'&&nativeIdentity(value.task)!==nativeIdentity(row.task))throw Error('invalid_workbench_detail');
   current.detail=value;
   if(continuationTarget(current))loadContinuations();
   if(interactionTarget(current))loadInteractions();
  },(error,current)=>{current.detail=null;current.error=safeError(error);});
 }
 function showLocalTask(current,row){
  reads.get('detail')?.abort();
  reads.get('interactions')?.abort();
  reads.get('interactionBindings')?.abort();
  current.selected=row.task.id;current.localSelection=true;current.source=null;current.detail=null;current.error='';section='tasks';
  current.interaction.list=null;current.interaction.target=null;current.interaction.bindings=null;
  current.interaction.bindingsTarget=null;current.interaction.selectedId=null;
  if(row.task.origin!=='t3'){
   if(!current.focusError.includes('旧任务'))current.focusError+=(current.focusError?' ':'')+'旧任务仅供本页查看，暂不支持重新打开后恢复选择。';
  }else if(!current.focus&&!current.focusError)current.focusError='保存状态尚未核对；当前仅供本页查看，请刷新后再选择以保存。';
  render();
 }
 async function saveFocus(taskId,row=null){
  const current=state(),projectId=project?.id,at=epoch,previous=current?.focus;
  if(!current||!projectId||!previous||current.focusBusy||current.stale||!online())return;
  current.focusBusy=true;current.focusError='';current.message='';render();
  try{
   const value=await client.request('/api/workbench/focus',{method:'POST',credentials:'same-origin',
    body:{projectId,taskId,expectedRevision:previous.revision}});
   if(disposed||epoch!==at||project?.id!==projectId)return;
   const unchanged=taskId===null?previous.task===null:
    previous.task?.id===taskId&&nativeIdentity(previous.task)===nativeIdentity(row?.task);
   if(!focusOk(value,projectId)||value.revision<previous.revision||
      (value.revision===previous.revision&&!unchanged)||
      (taskId===null?value.task!==null:!row||value.task?.id!==taskId||nativeIdentity(value.task)!==nativeIdentity(row.task)))
    throw Error('invalid_workbench_focus_receipt');
   current.focus=value;current.focusError='';
   if(row){showLocalTask(current,row);if(taskId!==null)current.localSelection=false;}
   else{current.selected=null;current.detail=null;current.localSelection=false;render();}
   current.message=taskId===null?'已清除这个项目保存的任务选择。':'已保存为这个项目的当前任务。';render();
  }catch(error){
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   current.focus=null;
   current.focusError=error.status===409?'保存选择时版本已变化；当前仅供本页查看，请刷新任务页核对。':
    '任务选择尚未保存；当前仅供本页查看，请刷新任务页核对。';
   if(row)showLocalTask(current,row);else render();
  }finally{current.focusBusy=false;if(!disposed&&epoch===at&&project?.id===projectId)render();}
 }
 function chooseTask(taskId){
  const current=state(),row=current?.rows?.find(entry=>entry.task.id===taskId);
  if(!row||current.busy||current.focusBusy||current.stale||!online())return;
  if(!current.focus)return showLocalTask(current,row);
  if(row.task.origin==='t3')return saveFocus(taskId,row);
  if(current.focus.task)return saveFocus(null,row);
  showLocalTask(current,row);
 }
 function refreshTask(){
  const current=state(),taskId=current?.selected,row=current?.rows?.find(entry=>entry.task.id===taskId);
  if(!taskId||row?.task.origin!=='t3'||!current.status?.readAvailable||current.busy||!online())return;
  current.busy=true;current.error='';
  return Promise.resolve(read('refresh','/api/workbench/tasks/refresh',{method:'POST',body:{taskId}},(value,active,projectId)=>{
   if(active.selected!==taskId||!rowOk(value,projectId)||value.task.id!==taskId)throw Error('invalid_workbench_refresh');
   active.rows=[value,...(active.rows||[]).filter(row=>row.task.id!==taskId)];
   active.verifiedTaskId=taskId;active.message='已从原生任务核对这项状态。';
  },(error,active)=>{active.error=safeError(error);})).finally(()=>{current.busy=false;render();});
 }
 function continuationTarget(current){
  if(!current||!online()||current.stale||current.focusBusy||current.loading.has('focus')||
     !current.status?.readAvailable||current.localSelection||current.source)return null;
  const saved=current.focus?.task,row=current.rows?.find(entry=>entry.task.id===saved?.id);
  if(!saved||current.selected!==saved.id||!row||
     nativeIdentity(row.task)===null||nativeIdentity(row.task)!==nativeIdentity(saved)||
     nativeIdentity(current.detail?.task)!==nativeIdentity(saved))return null;
  return saved;
 }
 function interactionTarget(current){
  const target=continuationTarget(current);
  return target?.provider==='codex'?target:null;
 }
 function loadInteractionBindings(){
  const current=state(),target=interactionTarget(current),projectId=project?.id;
  if(!current||!target||!projectId)return;
  const work=current.interaction;
  work.bindings=null;work.bindingsTarget=null;work.bindingsError='';
  return read('interactionBindings',query('/api/workbench/interactions/bindings',{projectId,taskId:target.id}),{},
   (value,active)=>{
    if(nativeIdentity(interactionTarget(active))!==nativeIdentity(target)||active.selected!==target.id)return;
    if(!interactionBindingsOk(value,target))throw Error('invalid_native_interaction_bindings');
    const work=active.interaction;work.bindings=value;work.bindingsTarget=target;
    for(const binding of value.bindings){
     const previous=work.attempts[binding.interactionId];
     if(previous&&nativeIdentity(previous.task)!==nativeIdentity(target)){
      work.bindings=null;work.bindingsError='原生请求编号出现跨任务冲突，不能回答或核对。';return;
     }
     if(previous&&(previous.version!==binding.requestVersion||previous.commandId&&previous.commandId!==binding.commandId)){
      previous.error='服务端绑定与本页记录不一致；不能重新回答。';
      work.bindings=null;work.bindingsError='原生请求绑定已变化，不能回答或核对。';return;
     }
     const listed=work.list?.interactions.find(item=>item.id===binding.interactionId);
     if(listed&&(listed.kind!==binding.kind||listed.version!==binding.requestVersion)){
      work.bindings=null;work.bindingsError='原生请求版本或类型与已认领命令不一致，不能回答或核对。';return;
     }
     work.attempts[binding.interactionId]=previous||{id:binding.interactionId,version:binding.requestVersion,
      task:target,interaction:listed||{id:binding.interactionId,kind:binding.kind},
      commandId:binding.commandId,read:null,error:'已从服务端找回原命令，正在只读核对。'};
     work.attempts[binding.interactionId].commandId=binding.commandId;
    }
    for(const binding of value.bindings.slice(0,10)){
     const attempt=work.attempts[binding.interactionId];
     if(!attempt.read&&!attempt.reading)void readInteractionCommand(binding.interactionId);
    }
   },(error,active)=>{
    active.interaction.bindings=null;active.interaction.bindingsTarget=null;
    active.interaction.bindingsError=error.status===401||error.status===403?'本机会话已失效，历史命令无法核对。':
     '服务端已认领请求暂不可读取；为避免重复回答，当前禁用提交。';
   });
 }
 function loadInteractions(){
  const current=state(),target=interactionTarget(current),projectId=project?.id;
  if(!current||!target||!projectId)return;
  const work=current.interaction;
  work.list=null;work.target=null;work.error='';
  const listing=read('interactions',query('/api/workbench/interactions',{projectId,taskId:target.id}),{},
   (value,active)=>{
    if(nativeIdentity(interactionTarget(active))!==nativeIdentity(target)||active.selected!==target.id)return;
    if(!interactionListOk(value,target))throw Error('invalid_native_interactions');
    active.interaction.list=value;active.interaction.target=target;
    for(const binding of active.interaction.bindings?.bindings||[]){
     const listed=value.interactions.find(item=>item.id===binding.interactionId);
     if(listed&&(listed.kind!==binding.kind||listed.version!==binding.requestVersion)){
      active.interaction.bindings=null;
      active.interaction.bindingsError='原生请求版本或类型与已认领命令不一致，不能回答或核对。';
      break;
     }
    }
    if(!value.interactions.some(item=>item.id===active.interaction.selectedId))active.interaction.selectedId=null;
   },(error,active)=>{
    active.interaction.list=null;active.interaction.target=null;
    active.interaction.error=error.status===401||error.status===403?'本机会话已失效，原生请求暂不可读。':
     error.status===409?'任务绑定已变化，旧请求不能操作。':'原生请求读取失败；不能根据任务状态猜测批准或提问内容。';
   });
  return Promise.all([listing,loadInteractionBindings()]);
 }
 function interactionDraft(work,item){
  if(!work.answers[item.id]||work.answers[item.id].version!==item.version){
   work.answers[item.id]={version:item.version,choiceId:'',questions:Object.fromEntries((item.questions||[]).map(q=>
    [q.id,{selectedOptionIds:[],customMode:!(q.options?.length),customText:''}]))};
  }
  return work.answers[item.id];
 }
 function interactionResponse(item,draft){
  if(item.kind==='approval')return item.choices.some(choice=>choice.id===draft.choiceId)?
   {type:'decide_approval',choiceId:draft.choiceId}:null;
  const answers=[];
  for(const question of item.questions){
   const input=draft.questions[question.id];if(!input)return null;
   if(input.customMode){
    if(!question.allowCustomAnswer||!continuationText(input.customText))return null;
    answers.push({questionId:question.id,selectedOptionIds:[],customText:input.customText});
   }else{
    const selected=input.selectedOptionIds;
    if(!Array.isArray(selected)||selected.length===0||!question.allowMultiple&&selected.length!==1||
       new Set(selected).size!==selected.length||selected.some(id=>!question.options?.some(option=>option.id===id)))return null;
    answers.push({questionId:question.id,selectedOptionIds:[...selected]});
   }
  }
  return {type:'answer_question',answers};
 }
 async function respondInteraction(){
  const current=state(),work=current?.interaction,target=interactionTarget(current),projectId=project?.id,
   item=work?.list?.interactions.find(value=>value.id===work.selectedId),at=epoch;
  if(!work||!target||!item||work.busy||work.attempts[item.id]||!current.status?.dispatchEnabled||
     nativeIdentity(work.target)!==nativeIdentity(target)||item.state!=='pending'||!online())return;
  const response=interactionResponse(item,interactionDraft(work,item));if(!response)return;
  delete work.answers[item.id];
  const attempt={id:item.id,version:item.version,task:target,interaction:item,commandId:null,read:null,
   error:'提交结果待核对；本页不会再次发送同一请求。',reading:false};
  work.attempts[item.id]=attempt;work.busy=true;work.error='';render();
  try{
   const value=await client.request('/api/workbench/interactions/respond',{method:'POST',
    body:{projectId,taskId:target.id,interactionId:item.id,expectedVersion:item.version,response}});
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(!interactionReadOk(value,attempt))throw Error('invalid_native_interaction_receipt');
   attempt.commandId=value.command.commandId;attempt.read=value;
   attempt.error=value.command.state==='conflict'?'原命令发生冲突，请核对请求。':
    value.command.state==='unsupported'?'原生回答派发尚未启用，没有发送。':'';
  }catch(error){
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   attempt.error=error.status===409?'请求版本或任务身份已变化；不要沿旧请求重发。':
    '提交回执暂不可读取，原命令可能已领取；不要重新提交。';
  }finally{work.busy=false;if(!disposed&&epoch===at&&project?.id===projectId)render();}
  if(!attempt.commandId&&nativeIdentity(interactionTarget(current))===nativeIdentity(target))
   await loadInteractionBindings();
 }
 async function readInteractionCommand(interactionId){
  const current=state(),work=current?.interaction,attempt=work?.attempts[interactionId],
   target=interactionTarget(current),projectId=project?.id,at=epoch;
  if(!attempt||!target||nativeIdentity(target)!==nativeIdentity(attempt.task)||attempt.reading||!online())return;
  attempt.reading=true;attempt.error='';render();
  try{
   const value=await client.request(query('/api/workbench/interactions/commands',
    {projectId,taskId:target.id,interactionId:attempt.id}));
   if(disposed||epoch!==at||project?.id!==projectId||nativeIdentity(interactionTarget(current))!==nativeIdentity(target))return;
   if(!interactionReadOk(value,attempt))throw Error('invalid_native_interaction_command');
   attempt.commandId=value.command.commandId;attempt.read=value;
  }catch(error){
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   attempt.error='原命令暂不可读取；保留请求编号，稍后只读核对。';
  }finally{attempt.reading=false;if(!disposed&&epoch===at&&project?.id===projectId)render();}
 }
 const continuationSame=(current,draft)=>nativeIdentity(continuationTarget(current))===nativeIdentity(draft?.task)&&
  nativeIdentity(draft?.task)!==null;
 const continuationError=error=>error.status===409?'任务或工作卡版本已变化；请只读核对原草稿，旧确认不能再用。':
  error.status===401||error.status===403?'本机会话已失效，请重新连接后核对原草稿。':
  '操作回执待核对；请读取原草稿，不要重新提交。';
 function loadContinuations(){
  const current=state(),target=continuationTarget(current),projectId=project?.id;
  if(!target||!projectId)return;
  const revision=current.focus.revision;
  current.continuation.discovered=null;current.continuation.discoveryError='';
  return read('continuations',query('/api/workbench/continuations',{projectId}),{credentials:'same-origin'},
   (value,active,id)=>{
    if(active.focus?.revision!==revision||nativeIdentity(continuationTarget(active))!==nativeIdentity(target))return;
    if(!continuationListOk(value,id,target,revision))throw Error('invalid_continuation_list');
    const work=active.continuation;work.discovered=value;
    if(work.pending){
     const matches=value.drafts.filter(draft=>draft.input.origin.messageId===work.pending.messageId);
     const recovered=matches.length===1&&matches[0].input.rawText===work.pending.rawText&&
      nativeIdentity(matches[0].task)===nativeIdentity(work.pending.task)?matches[0]:null;
     if(recovered){work.draft=recovered;work.pending=null;work.editText=recovered.input.dispatchText;
      work.phase=recovered.state==='open'?'ready':'uncertain';work.error='';}
     else work.discoveryError=value.truncated?'列表只显示最近记录；原消息尚未核对，不能重新提交。':
      '原消息尚未在服务端列表找到；当前不会重新提交。';
    }
    if(work.draft){
     const listed=value.drafts.find(draft=>draft.id===work.draft.id);
     if(listed&&(listed.version!==work.draft.version||listed.commandId!==work.draft.commandId||
       nativeIdentity(listed.task)!==nativeIdentity(work.draft.task))){
      work.phase='review_needed';work.error='服务端草稿已变化，请读取原草稿核对后再操作。';
     }
    }
   },(error,active)=>{active.continuation.discovered=null;
    active.continuation.discoveryError=error.status===401||error.status===403?'本机会话已失效，草稿列表暂不可读。':
     '草稿列表暂不可核对；本页不会猜测或重复提交。';});
 }
 async function recoverContinuation(draftId){
  const current=state(),work=current?.continuation,projectId=project?.id,at=epoch,
   listed=work?.discovered?.drafts.find(draft=>draft.id===draftId),previous=work?.draft?.id===draftId?work.draft:null,
   expected=listed||previous;
  if(!expected||!uuid(draftId)||work.busy||!online()||
     (listed?nativeIdentity(expected.task)!==nativeIdentity(continuationTarget(current)):
      expected.task.projectId!==projectId))return;
  work.busy=true;work.error='';render();
  try{
   const value=await client.request(query('/api/workbench/continuation/draft',{draftId}),{credentials:'same-origin'});
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(!continuationDraftOk(value,expected.task,expected.input.origin.messageId,expected.input.rawText)||
      value.id!==expected.id||value.commandId!==expected.commandId||value.version<expected.version)throw Error('invalid_continuation_draft');
   const wasUncertain=work.uncertainConfirmation&&previous?.id===draftId;
   work.draft=value;work.editText=value.input.dispatchText;work.receipt=null;
   if(work.pending?.messageId===value.input.origin.messageId)work.pending=null;
   if(wasUncertain){
    if(value.state==='open'&&value.version===previous.version&&
       work.commandRead?.commandId===value.commandId&&work.commandRead.version===value.version){
     work.phase='ready';work.uncertainConfirmation=false;work.commandRead=null;
     work.error='原命令未领取；已重新展示完整正文。如仍要续接，请重新明确确认。';
    }else{work.phase='uncertain';work.error='原确认仍待核对；不能再次确认。';}
   }else{work.phase=value.state==='open'?'ready':value.state==='dismissed'?'dismissed':'uncertain';work.error='';}
  }catch(error){
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   work.error='原草稿暂不可读取或身份已变化；当前不能编辑或确认。';
   work.phase='review_needed';
  }finally{work.busy=false;if(!disposed&&epoch===at&&project?.id===projectId)render();}
 }
 async function prepareContinuation(){
  const current=state(),target=continuationTarget(current),work=current?.continuation,
   projectId=project?.id,at=epoch;
  if(!target||!work||work.busy||work.draft||work.pending||!continuationText(work.raw)||!continuationText(work.reviewed))return;
  const pending={projectId,task:target,focusRevision:current.focus.revision,messageId:crypto.randomUUID(),
   rawText:work.raw,dispatchText:work.reviewed};
  work.pending=pending;work.phase='prepare_unknown';work.busy=true;work.error='';work.receipt=null;render();
  try{
   const value=await client.request('/api/workbench/continuation/prepare',{method:'POST',credentials:'same-origin',
    body:{projectId,taskId:target.id,expectedFocusRevision:pending.focusRevision,messageId:pending.messageId,
     rawText:pending.rawText,dispatchText:pending.dispatchText}});
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(!continuationDraftOk(value,target,pending.messageId,pending.rawText)||value.state!=='open')throw Error('invalid_continuation_draft');
   work.draft=value;work.pending=null;work.editText=value.input.dispatchText;work.phase='ready';work.error='';
   loadContinuations();
  }catch(error){
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   work.error=continuationError(error);
  }finally{work.busy=false;if(!disposed&&epoch===at&&project?.id===projectId)render();}
 }
 async function reviseContinuation(){
  const current=state(),work=current?.continuation,draft=work?.draft,projectId=project?.id,at=epoch,
   dispatchText=work?.editText;
  if(!draft||work.busy||!continuationSame(current,draft)||!['ready','unsupported'].includes(work.phase)||
     draft.state!=='open'||!continuationText(dispatchText)||dispatchText===draft.input.dispatchText)return;
  work.phase='review_needed';work.busy=true;work.error='';render();
  try{
   const value=await client.request('/api/workbench/continuation/revise',{method:'POST',credentials:'same-origin',
    body:{draftId:draft.id,expectedVersion:draft.version,dispatchText}});
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(!continuationDraftOk(value,draft.task,draft.input.inputId,draft.input.rawText)||
      value.id!==draft.id||value.commandId!==draft.commandId||value.version!==draft.version+1||
      value.state!=='open'||value.input.dispatchText!==dispatchText)throw Error('invalid_continuation_draft');
   work.draft=value;work.editText=value.input.dispatchText;work.phase='ready';work.receipt=null;work.commandRead=null;
  }catch(error){
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   work.error=continuationError(error);
  }finally{work.busy=false;if(!disposed&&epoch===at&&project?.id===projectId)render();}
 }
 async function dismissContinuation(){
  const current=state(),work=current?.continuation,draft=work?.draft,projectId=project?.id,at=epoch;
  if(!draft||work.busy||!continuationSame(current,draft)||!['ready','unsupported'].includes(work.phase)||draft.state!=='open')return;
  work.phase='review_needed';work.busy=true;work.error='';render();
  try{
   const value=await client.request('/api/workbench/continuation/dismiss',{method:'POST',credentials:'same-origin',
    body:{draftId:draft.id,expectedVersion:draft.version}});
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(!continuationDraftOk(value,draft.task,draft.input.inputId,draft.input.rawText)||
      value.id!==draft.id||value.commandId!==draft.commandId||value.version!==draft.version+1||value.state!=='dismissed')
    throw Error('invalid_continuation_draft');
   work.draft=value;work.phase='dismissed';work.receipt=null;work.commandRead=null;
  }catch(error){
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   work.error=continuationError(error);
  }finally{work.busy=false;if(!disposed&&epoch===at&&project?.id===projectId)render();}
 }
 async function confirmContinuation(){
  const current=state(),work=current?.continuation,draft=work?.draft,projectId=project?.id,at=epoch;
  if(!draft||work.busy||!continuationSame(current,draft)||work.phase!=='ready'||draft.state!=='open'||
     work.editText!==draft.input.dispatchText||!current.status?.dispatchEnabled)return;
  work.phase='uncertain';work.uncertainConfirmation=true;work.commandRead=null;work.receipt=null;
  work.busy=true;work.error='';render();
  try{
   const value=await client.request('/api/workbench/continuation/confirm',{method:'POST',credentials:'same-origin',
    body:{draftId:draft.id,expectedVersion:draft.version}});
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(!continuationResultOk(value,draft))throw Error('invalid_continuation_result');
   work.receipt=value;
   work.phase=value.state==='accepted'?'submitted':value.state==='unsupported'?'unsupported':
    value.state==='conflict'?'review_needed':'uncertain';
   if(!['unknown','recorded'].includes(value.state))work.uncertainConfirmation=false;
   if(work.phase==='review_needed')work.error='确认返回冲突；请核对原草稿和准确任务。';
  }catch(error){
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   work.error=continuationError(error);
  }finally{work.busy=false;if(!disposed&&epoch===at&&project?.id===projectId)render();}
 }
 async function readContinuation(){
  const current=state(),work=current?.continuation,draft=work?.draft,projectId=project?.id,at=epoch;
  if(!draft||work.busy||!online())return;
  work.busy=true;work.error='';render();
  try{
   const value=await client.request(query('/api/workbench/continuation',{draftId:draft.id}),{credentials:'same-origin'});
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(!continuationResultOk(value,draft))throw Error('invalid_continuation_result');
   work.receipt=value;
   if(value.state==='accepted'){work.phase='submitted';work.uncertainConfirmation=false;work.commandRead=null;}
   else if(value.state==='conflict'){work.phase='review_needed';work.uncertainConfirmation=false;work.commandRead=null;}
   else if(value.state==='unknown'){work.phase='uncertain';work.uncertainConfirmation=true;work.commandRead=null;}
   else if(work.uncertainConfirmation&&value.state==='recorded'){
    work.phase='uncertain';work.commandRead={commandId:draft.commandId,version:draft.version};
    work.error='原命令尚未领取；请再只读核对原草稿，完整重展示后才能重新确认。';
   }
   if(value.state==='unknown')work.error='原命令仍待核对；本页不会再次确认。';
  }catch(error){
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   work.error='原命令暂不可读取；保留草稿 ID，稍后只读核对。';
  }finally{work.busy=false;if(!disposed&&epoch===at&&project?.id===projectId)render();}
 }
 function anotherContinuation(){
  const current=state(),work=current?.continuation;
  if(!work||work.busy||!['dismissed','submitted'].includes(work.phase))return;
  const discovered=work.discovered,discoveryError=work.discoveryError;
  current.continuation={...blank().continuation,discovered,discoveryError};render();
 }
 const canCreate=current=>!current.createBusy&&online()&&current.status?.readAvailable&&Array.isArray(current.creations)&&
  catalogCurrent(current.catalog)&&createText(current.createDraft.title)&&
  current.catalog.models.some(model=>model.id===current.createDraft.model);
 async function createTask(recheck=false){
  const current=state(),projectId=project?.id,at=epoch;
  if(!current||!projectId||current.createBusy||!online())return;
  const selected=recheck?current.creations?.find(row=>row.operationId===current.selectedCreationId):null;
  if(recheck){if(!current.status?.readAvailable||selected?.state!=='unknown'||!recoveredRequestOk(selected.request,projectId,selected.operationId))return;}
  else if(!canCreate(current))return;
  const input=recheck?selected.request:{operationId:crypto.randomUUID(),projectId,title:current.createDraft.title.trim(),provider:'codex',
   modelSelection:{instanceId:'codex',model:current.createDraft.model}};
  if(!recheck)current.createPending={input,error:'正在创建空任务，请等待回执。'};
  current.createBusy=true;current.createMessage='';current.createError='';render();
  try{
   const value=await client.request('/api/workbench/tasks/create',{method:'POST',body:input});
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(value?.operationId!==input.operationId)throw Error('invalid_create_receipt');
   if(value.state==='accepted'){
    if(!taskOk(value.task,projectId)||value.task.origin!=='t3'||value.task.provider!=='codex'||value.task.providerInstanceId!=='codex')throw Error('invalid_created_task');
    current.createPending=null;if(!recheck)current.createDraft.title='';
    current.createMessage='空任务已创建，尚未发送工作内容。点击任务列表中的这项可保存为下次打开的选择。';current.rows=[{task:value.task,projection:null},...(current.rows||[]).filter(row=>row.task.id!==value.task.id)];
    current.selected=value.task.id;current.localSelection=true;current.detail=null;current.source=null;loadTasks();loadDetail(value.task.id);
   }else if(value.state==='unknown'&&Object.hasOwn(createStages,value.stage)){
    if(!recheck)current.createPending={input,error:createStages[value.stage]+'尚未核实；请从服务端记录中选择后继续。'};
    current.selectedCreationId=input.operationId;
   }else if(value.state==='conflict'&&Object.hasOwn(createStages,value.stage)){
    if(!recheck)current.createPending={input,error:'原生创建回执冲突；请核对服务端记录和任务列表。'};
    current.selectedCreationId=input.operationId;
    current.createError='原生创建回执冲突；当前操作不能继续。';
   }else throw Error('invalid_create_receipt');
  }catch(error){
   if(disposed||epoch!==at||project?.id!==projectId)return;
   if(error.status===401||error.status===403)getHost().onError(error);
   current.createError=error.status===409?'项目或创建配置已变化，请核对服务端记录和任务列表。':error.status===400?'所选模型或创建输入已失效，请刷新模型目录。':
    '创建回执尚未确认，请刷新服务端记录后核对。';
   if(error.status===400){current.createPending=null;current.catalog=null;}
   else if(!recheck)current.createPending={input,error:current.createError};
   current.selectedCreationId=input.operationId;
  }finally{
   current.createBusy=false;
   if(!disposed&&epoch===at&&project?.id===projectId){
    await loadCreations();
    render();
   }
  }
 }
 function openSource(context){
  if(disposed||!project||context.projectId!==project.id)return;
  invalidate();section='tasks';
  const current=state();
  current.selected=id(context.source.taskId)?context.source.taskId:null;
  current.detail=null;current.error='';
  current.source={...context,target:null,error:current.selected?'正在核对来源与任务绑定。':'该来源没有任务 ID，暂不能打开；原始引用仍可复制。'};
  render();loadTaskPage();
  if(!current.selected)return;
  const taskId=current.selected,source=context.source,params={projectId:project.id,taskId};
  if(printable(source.nativeTurnId)&&source.nativeTurnId.length<=1000)params.nativeTurnId=source.nativeTurnId;
  if(printable(source.artifactRef)&&source.artifactRef.length<=1000)params.artifactRef=source.artifactRef;
  read('source',query('/api/workbench/source',params),{},(value,active,projectId)=>{
   if(active.selected!==taskId||!sourceOk(value,projectId,taskId))throw Error('invalid_workbench_source');
   active.source.target=value;active.source.error='';
  },(error,active)=>{active.source.error=sourceError(error);active.detail=null;});
 }
 function changeSection(next){
  if(next===section)return;
  invalidate();section=next;
  const current=state();
  if(current){current.error='';current.message='';if(next==='memory')current.source=null;}
  render();
  if(next==='tasks')loadTaskPage();else memory.refresh();
 }
 async function copy(value){
  const current=state();if(!current)return;
  try{await navigator.clipboard.writeText(value);current.message='引用已复制。';}
  catch{current.message='复制未完成；可以选中文本手动复制。';}
  render();
 }
 function reference(label,value){
  return printable(value)&&el('div',{class:'wb-reference'},el('span',{},label),el('code',{},value),button('复制',()=>copy(value),{'aria-label':'复制'+label}));
 }
 function sourceView(source){
  if(!source)return null;
  const raw=source.source,target=source.target;
  return el('section',{class:'card wb-source',id:'wb-source-context'},
   el('div',{class:'section-head'},el('h3',{},'项目记忆来源'),button('返回项目记忆',()=>changeSection('memory'),{id:'wb-back-memory'})),
   el('p',{class:'subtle'},'条目 '+source.memoryItemId+' · 来源 '+(source.sourceIndex+1)+'。任务内精确跳转尚未验证。'),
   el('div',{class:'text-block'},source.memoryText),
   source.error&&notice(source.error,source.error.startsWith('正在')?'muted':'warning'),
   el('div',{class:'wb-references'},
    reference('任务 ID',raw.taskId),reference('原生轮次 ID',raw.nativeTurnId),reference('记录终态事件 ID',raw.terminalEventId),
    reference('产物引用',raw.artifactRef),reference('用户输入引用',raw.userInputId),
    target&&reference('可信环境 ID',target.environmentId),target&&reference('可信原生线程 ID',target.threadId)),
   target&&button('打开来源任务',()=>openNative('task',source),{id:'wb-native-source',disabled:nativeOpen.busy||!online()}));
 }
 function createView(current){
  const catalog=current.catalog,available=catalogCurrent(catalog),creations=current.creations;
  const selected=creations?.find(row=>row.operationId===current.selectedCreationId);
  const pending=current.createPending&&!creations?.some(row=>row.operationId===current.createPending.input.operationId)?current.createPending:null;
  return el('section',{class:'card wb-create',id:'wb-create-panel'},
   el('div',{class:'section-head'},el('div',{},el('h3',{},'新建空任务'),el('p',{class:'subtle'},'在当前项目创建 Codex 任务容器。创建后不会发送工作内容或调用模型。')),
    button('刷新账号模型目录',loadCatalog,{id:'wb-refresh-models',disabled:!online()||current.loading.has('catalog')||current.createBusy})),
   el('p',{class:'subtle wb-create-target'},'目标项目：'+project.name+' · '+project.id),
   project.rootPath&&el('p',{class:'subtle wb-create-target'},'工作目录：'+project.rootPath),
   current.loading.has('catalog')&&notice('正在读取当前账号可用模型。','muted'),
   current.catalogError&&notice(current.catalogError,'warning'),
   !current.loading.has('catalog')&&!available&&!current.catalogError&&notice('当前账号模型目录尚未核实，暂不能新建。','warning'),
   available&&el('p',{class:'subtle'},'模型目录核对时间：'+new Date(catalog.checkedAt).toLocaleString('zh-CN',{hour12:false})),
   creations?.length>0&&notice('本项目有 '+creations.length+' 项未完成创建。可以选择原记录继续，也可以明确新建另一项空任务。','warning'),
   el('div',{class:'wb-create-form'},
    field('任务标题','wb-create-title',current.createDraft.title,value=>{
     current.createDraft.title=value;const submit=document.getElementById('wb-create-submit');if(submit)submit.disabled=!canCreate(current);
    },{maxLength:250,disabled:current.createBusy,autocomplete:'off'}),
    select('当前账号模型','wb-create-model',current.createDraft.model,
     available?catalog.models.map(model=>({value:model.id,label:model.name+' · '+model.id})):[],value=>{current.createDraft.model=value;current.catalogError='';render();},
     {disabled:current.createBusy||!available||!online()}),
    el('div',{class:'actions'},button('创建空任务',()=>createTask(),{id:'wb-create-submit',class:'primary',disabled:!canCreate(current)}))),
   current.createMessage&&notice(current.createMessage,'success'),
   current.createError&&notice(current.createError,'warning'),
   pending&&el('div',{class:'wb-create-pending'},notice(pending.error,'warning'),
    el('p',{class:'subtle'},'提交结果尚未从服务端记录核实。请刷新未完成记录；本地暂存信息不能用于继续提交。'),
    reference('待核对操作 ID',pending.input.operationId)),
   el('div',{class:'wb-create-recovery'},
    el('div',{class:'section-head'},el('h4',{},'未完成创建'),button('刷新未完成记录',loadCreations,
     {id:'wb-create-refresh',disabled:!online()||current.loading.has('creations')||current.createBusy})),
    current.loading.has('creations')&&notice('正在读取服务端未完成记录。','muted'),
    current.creationsError&&notice(current.creationsError,'warning'),
    creations&&(!creations.length?el('p',{class:'subtle'},'当前项目没有未完成创建。'):
     el('div',{class:'wb-create-recovery-layout'},
      el('div',{class:'record-list wb-create-recovery-list',id:'wb-create-recovery-list'},creations.map(row=>button(
       el('div',{},el('div',{class:'section-head'},el('strong',{},row.request?.title||'原始输入缺失'),
        badge(row.state==='unknown'?'待核对':'冲突',row.state==='unknown'?'warning':'error')),
        el('small',{},(createStages[row.stage]||row.stage)+' · '+new Date(row.createdAt).toLocaleString('zh-CN',{hour12:false})),
        el('small',{},row.operationId)),()=>{current.selectedCreationId=row.operationId;render();},
       {'data-wb-creation-id':row.operationId,class:'record-row','aria-pressed':selected?.operationId===row.operationId}))),
      selected&&el('div',{class:'wb-create-recovery-detail'},
       definition([['状态',selected.state==='unknown'?'待核对':'冲突'],['创建阶段',createStages[selected.stage]],
        ['原任务标题',selected.request?.title||'原始输入缺失'],['原选模型',selected.request?.modelSelection.model||'原始输入缺失'],
        ['创建时间',new Date(selected.createdAt).toLocaleString('zh-CN',{hour12:false})]]),
       reference('创建操作 ID',selected.operationId),
       !selected.request&&notice('服务端缺少原始标题或模型，无法继续这项创建。','warning'),
       selected.state==='conflict'&&notice('这项创建已发生冲突，不能继续；请核对任务列表。','warning'),
       selected.state==='unknown'&&selected.request&&el('div',{},
        el('p',{class:'subtle'},'继续会使用服务端保存的原操作编号、标题和模型，核对已有回执并完成剩余步骤；不会启动模型。'),
        button(current.createBusy?'正在继续…':'继续完成创建',()=>createTask(true),
         {id:'wb-create-recheck',disabled:current.createBusy||!online()||!current.status?.readAvailable})))))));
 }
 function taskList(current){
  const rows=current.rows;
  return el('section',{class:'card wb-tasks-list'},
   el('div',{class:'section-head'},el('h3',{},'项目任务'),badge(rows?rows.length+' 项':'待读取')),
   el('p',{class:'subtle'},'选择一项任务后保存准确焦点；完整详情在 T3 Code 中查看。'),
   el('div',{class:'record-list wb-task-rows',id:'wb-task-rows',tabIndex:0},
    rows?rows.length?rows.map(row=>button(el('div',{},
     el('div',{class:'section-head'},el('strong',{},providers[row.task.provider]),
      badge(phases[row.projection?.phase]||'尚未核对',row.projection?.phase==='completed'?'success':row.projection?.phase?.startsWith('waiting')?'warning':'muted')),
     el('small',{},row.task.id),el('small',{},'最近记录 · '+(row.projection?.nativeTurnId||'无轮次')),
     row.resultPreview&&el('small',{},'最近结果 · '+row.resultPreview.text+(row.resultPreview.truncated?'…':''))),
     ()=>chooseTask(row.task.id),{'data-wb-task-id':row.task.id,class:'record-row','aria-pressed':current.selected===row.task.id,
      disabled:current.stale||current.focusBusy||!online()})):
     el('p',{class:'empty'},'这个项目没有已登记任务。'):
     el('p',{class:'empty'},current.loading.has('tasks')?'正在读取任务列表…':'尚未读取任务列表。')));
 }
 function messagesView(thread){
  const messages=Array.isArray(thread?.messages)?thread.messages.filter(message=>message&&['user','assistant'].includes(message.role)&&typeof message.text==='string').slice(-80):[];
  return el('section',{class:'wb-messages'},el('h4',{},'最近对话'),
   messages.length?messages.map(message=>el('article',{class:'wb-message'},el('strong',{},message.role==='user'?'用户':'执行器'),
    el('div',{class:'text-block'},message.text),reference('消息 ID',message.id))):
    el('p',{class:'subtle'},'该详情没有可展示的用户或执行器消息。'));
 }
 function taskDetail(current){
  const row=current.rows?.find(entry=>entry.task.id===current.selected),detail=current.detail,ref=detail?.task||row?.task;
  return el('section',{class:'card wb-task-detail','data-detail-id':'wb-'+(current.selected||'none')},
   el('div',{class:'section-head'},el('h3',{},'任务详情'),
    current.selected&&el('div',{class:'actions'},
     button('核对状态',refreshTask,{id:'wb-refresh-task',disabled:ref?.origin!=='t3'||!current.status?.readAvailable||current.busy||!online()}),
     current.focus?.task?.id===current.selected&&!current.localSelection&&button('清除保存的选择',()=>saveFocus(null),
      {id:'wb-clear-focus',disabled:current.focusBusy||!online()}))),
   current.selected?el('div',{},
    !detail&&notice(ref?.origin&&ref.origin!=='t3'?'旧任务沿用原入口，当前没有可信原生详情。':current.loading.has('detail')?'正在读取原生详情…':current.error||'请选择任务读取原生详情。',current.error?'warning':'muted'),
    ref&&definition([['执行器',providers[ref.provider]],['来源',ref.origin==='t3'?'T3 已绑定任务':'旧入口引用'],
     ['最近状态',phases[row?.projection?.phase]||'尚未核对'],['状态依据',current.verifiedTaskId===current.selected?'本页刚核对':'本机最近记录'],
     ['原生标题',printable(detail?.native?.thread?.title)?detail.native.thread.title:'尚未读取']]),
    ref&&el('div',{class:'wb-references'},reference('本机任务 ID',ref.id),reference('原生环境 ID',ref.environmentId),
     reference('原生项目 ID',ref.t3ProjectId),reference('原生线程 ID',ref.threadId),reference('执行器实例 ID',ref.providerInstanceId),
     reference('旧入口 Host ID',ref.hostId),reference('旧入口 Profile ID',ref.profileId),reference('旧入口会话 ID',ref.nativeSessionId),
     reference('原生轮次 ID',row?.projection?.nativeTurnId),reference('事件 ID',row?.projection?.eventId),reference('结果引用',row?.projection?.resultRef)),
    detail&&messagesView(detail.native.thread)):
    el('p',{class:'subtle'},'从左侧选择一项任务。'));
 }
 function interactionAnswerView(work,item,draft){
  if(item.kind==='approval')return el('div',{class:'wb-interaction-answers'},
   el('p',{class:'text-block'},item.summary),
   item.choiceSource==='t3_default'&&notice('此请求没有提供供应商选项；下列是 T3 的后备选项，请逐项核对。','warning'),
   el('div',{class:'wb-interaction-options'},item.choices.map((choice,index)=>el('label',{class:'wb-interaction-option'},
    el('input',{type:'radio',name:'wb-approval-'+item.id,value:choice.id,checked:draft.choiceId===choice.id,
     onChange:()=>{draft.choiceId=choice.id;render();}}),
    el('span',{},el('strong',{},choice.label),choice.warning&&el('small',{class:'warning'},choice.warning),
     el('small',{},'选项 '+(index+1)+' · '+choice.id))))));
  return el('div',{class:'wb-interaction-answers'},item.questions.map((question,index)=>{
   const answer=draft.questions[question.id],options=question.options||[];
   return el('fieldset',{class:'wb-interaction-question'},
    el('legend',{},(index+1)+'. '+question.prompt),
    el('small',{class:'subtle'},question.allowMultiple?'可选择多项':'请选择一项'),
    options.length>0&&el('div',{class:'wb-interaction-options'},options.map(option=>el('label',{class:'wb-interaction-option'},
     el('input',{type:question.allowMultiple?'checkbox':'radio',name:'wb-question-'+item.id+'-'+question.id,
      value:option.id,checked:!answer.customMode&&answer.selectedOptionIds.includes(option.id),
      onChange:()=>{
       answer.customMode=false;
       answer.selectedOptionIds=question.allowMultiple?
        answer.selectedOptionIds.includes(option.id)?answer.selectedOptionIds.filter(id=>id!==option.id):
         [...answer.selectedOptionIds,option.id]:[option.id];render();
      }}),el('span',{},el('strong',{},option.label),option.description&&el('small',{},option.description))))),
    question.allowCustomAnswer&&el('div',{class:'wb-interaction-custom'},
     options.length>0&&button(answer.customMode?'改选给定选项':'改用自由回答',()=>{answer.customMode=!answer.customMode;render();},
      {class:'secondary','aria-pressed':answer.customMode}),
     answer.customMode&&field('自由回答','wb-interaction-custom-'+index,answer.customText,value=>{
      answer.customText=value;
      const submit=document.getElementById('wb-interaction-submit');
      if(submit)submit.disabled=!interactionResponse(item,draft);
     },{type:'textarea',rows:4,maxLength:120000,autocomplete:'off'})));
  }));
 }
 function interactionAttemptView(attempt,current){
  const command=attempt.read?.command,resolution=attempt.read?.resolution;
  const commandState={recorded:'已记录，待原生接收',accepted:'命令已接收',conflict:'命令冲突',
   unsupported:'派发未启用',unknown:'命令待核对'};
  const resolutionState={pending:'原生请求仍待处理',answered:'原生请求已解决',expired:'原生请求已过期',unknown:'原生结果待核对'};
  return el('article',{class:'wb-interaction-attempt','data-wb-interaction-attempt':attempt.id},
   el('div',{class:'section-head'},el('strong',{},attempt.interaction.kind==='approval'?'审批回执':'提问回执'),
    badge(resolution?resolutionState[resolution]:'提交结果待核对',resolution==='answered'?'success':'warning')),
   definition([['任务',attempt.task.id],['请求',attempt.id],['请求版本',String(attempt.version)],
    ['命令状态',command?commandState[command.state]:'未取得回执'],
    ['原生结果',resolution?resolutionState[resolution]:'待核对']]),
   attempt.error&&notice(attempt.error,'warning'),
   attempt.commandId?el('div',{class:'wb-references'},reference('原命令 ID',attempt.commandId)):
    notice('尚未取得原命令编号；可按准确项目、任务与请求编号只读找回。本页不会再次提交。','warning'),
   button('只读核对原命令',()=>readInteractionCommand(attempt.id),
    {class:'secondary','data-wb-interaction-read':attempt.id,
     disabled:attempt.reading||current.interaction.busy||!online()}));
 }
 function interactionView(current){
  const work=current.interaction,target=interactionTarget(current),list=target&&
   nativeIdentity(work.target)===nativeIdentity(target)?work.list:null;
  const selected=list?.interactions.find(item=>item.id===work.selectedId),
   draft=selected?interactionDraft(work,selected):null,
   attempted=selected&&work.attempts[selected.id],
   bindingsReady=target&&nativeIdentity(work.bindingsTarget)===nativeIdentity(target)&&
    work.bindings?.status==='supported',
   canAnswer=selected?.state==='pending'&&list.status==='supported'&&!attempted&&!work.busy&&
    bindingsReady&&!work.bindings.bindings.some(binding=>binding.interactionId===selected.id)&&
    current.status?.dispatchEnabled&&interactionResponse(selected,draft);
  const attempts=target?Object.values(work.attempts).filter(attempt=>nativeIdentity(attempt.task)===nativeIdentity(target)):[];
  return el('section',{class:'card wb-interactions',id:'wb-interactions'},
   el('div',{class:'section-head'},el('div',{},el('h3',{},'原生审批与提问'),
    el('p',{class:'subtle'},'读取当前准确任务的原生请求。续接确认与工具审批分别操作。')),
    button('刷新原生请求',loadInteractions,{id:'wb-interactions-refresh',
     disabled:!target||work.busy||current.loading.has('interactions')})),
   !target&&notice(current.selected?'当前任务尚未完成准确 T3 Codex 焦点与详情核对，或该执行器暂不支持此入口。':
    '先选择并保存一个 T3 Codex 任务，再读取原生请求。','warning'),
   target&&!current.status?.dispatchEnabled&&notice('生产原生回答派发尚未启用；可核对请求，当前不能发送批准或回答。','warning'),
   target&&current.loading.has('interactionBindings')&&notice('正在核对服务端已认领的原生请求。','muted'),
   target&&work.bindingsError&&notice(work.bindingsError,'warning'),
   target&&!bindingsReady&&!current.loading.has('interactionBindings')&&!work.bindingsError&&
    notice('历史命令尚未核对，当前不能提交。','warning'),
   target&&notice('指定轮次停止尚不支持。停止任务需要单独的可信接口，不能用取消草稿或中断播报代替。','muted'),
   current.loading.has('interactions')&&notice('正在读取当前任务的原生请求。','muted'),
   work.error&&notice(work.error,'warning'),
   target&&list?.status==='unsupported'&&notice('该原生任务不支持网页批准或提问。','warning'),
   target&&list?.status==='unverified'&&notice('原生请求来源尚未核实，不能操作。','warning'),
   list?.status==='supported'&&(!list.interactions.length?
    el('p',{class:'subtle'},'当前准确任务没有可操作的原生请求。'):
    el('div',{class:'wb-interaction-layout'},
     el('div',{class:'record-list wb-interaction-list',id:'wb-interaction-list'},list.interactions.map((item,index)=>button(
      el('div',{},el('strong',{},item.kind==='approval'?'审批':'提问'),
       badge(item.state==='pending'?'待回应':item.state==='answered'?'已解决':item.state==='expired'?'已过期':'待核对',
        item.state==='pending'?'warning':'muted'),
       el('small',{},'请求 '+(index+1)+' · 版本 '+item.version),
       el('small',{},item.kind==='approval'?item.summary:item.questions.map(q=>q.prompt).join('；'))),
      ()=>{work.selectedId=item.id;render();},{class:'record-row','data-wb-interaction-id':item.id,
       'aria-pressed':selected?.id===item.id}))),
     selected&&el('div',{class:'wb-interaction-detail'},
      definition([['目标项目',project.name+' · '+project.id],['目标任务',target.id],
       ['原生线程',target.threadId],['请求编号',selected.id],['版本',String(selected.version)],
       ['状态',selected.state==='pending'?'待回应':selected.state==='answered'?'已解决':selected.state==='expired'?'已过期':'待核对'],
       ['有效期',selected.answerLifetime==='live_only'?'仅当前原生会话':'原生持久请求']]),
      selected.nativeTurnId&&reference('原生轮次 ID',selected.nativeTurnId),
      interactionAnswerView(work,selected,draft),
      (attempted||work.bindings?.bindings.some(binding=>binding.interactionId===selected.id))&&
       notice('这条请求已有一次提交记录；请核对原命令，不要再次回答。','warning'),
      button(selected.kind==='approval'?'提交所选审批决定':'提交完整回答',respondInteraction,
       {id:'wb-interaction-submit',class:'primary',disabled:!canAnswer})))),
   attempts.length>0&&el('div',{class:'wb-interaction-receipts'},el('h4',{},'本页原命令回执'),
    attempts.map(attempt=>interactionAttemptView(attempt,current))));
 }
 function continuationView(current){
  const work=current.continuation,target=continuationTarget(current),draft=work.draft,
   discovered=target&&work.discovered?.taskId===target.id&&work.discovered.focusRevision===current.focus?.revision?
    work.discovered:null,
   exact=draft&&continuationSame(current,draft),editable=exact&&draft.state==='open'&&
    ['ready','unsupported'].includes(work.phase)&&!work.busy,
   changed=draft&&work.editText!==draft.input.dispatchText;
  const updateCompose=()=>{
   const action=document.getElementById('wb-continuation-prepare');
   if(action)action.disabled=!target||work.busy||!continuationText(work.raw)||!continuationText(work.reviewed);
  };
  return el('section',{class:'card wb-continuation',id:'wb-continuation'},
   el('div',{class:'section-head'},el('h3',{},'续接原任务'),badge(draft?work.phase==='submitted'?'已收到原命令回执':
    work.phase==='dismissed'?'已取消':work.phase==='uncertain'?'待核对':'待确认':
    work.pending?'待核对':'未准备',draft?'warning':'muted')),
   el('p',{class:'subtle'},'只面向当前浏览器已保存、且项目与原生身份重新核对一致的 T3 任务。续接确认与原生工具批准分别处理。'),
   !target&&notice('先从任务列表明确选择 T3 任务，等待焦点和原生详情核对后再续接。','warning'),
   current.status&&!current.status.dispatchEnabled&&notice('原生派发尚未启用；可保存和修改待确认正文，当前不能确认发送。','warning'),
   work.error&&notice(work.error,'warning'),
   target&&el('div',{class:'wb-continuation-recovery'},
    el('div',{class:'section-head'},el('h4',{},'这个任务的待核草稿'),
     button('刷新草稿',loadContinuations,{id:'wb-continuation-refresh',disabled:current.loading.has('continuations')||work.busy})),
    current.loading.has('continuations')&&notice('正在从服务端读取当前任务的草稿。','muted'),
    work.discoveryError&&notice(work.discoveryError,'warning'),
    discovered?.truncated&&notice('仅显示最近 20 条；较早草稿未列出，不能据此认定不存在。','warning'),
    discovered&&(!discovered.drafts.length?el('p',{class:'subtle'},'当前准确任务没有可列出的未取消草稿。'):
     el('div',{class:'record-list',id:'wb-continuation-list'},discovered.drafts.map(row=>button(
      el('div',{},el('strong',{},row.input.rawText.slice(0,160)+(row.input.rawText.length>160?'…':'')),
       el('small',{},'版本 '+row.version+' · '+(row.state==='open'?'待确认':'待核对')),
       el('small',{},row.input.origin.messageId)),()=>recoverContinuation(row.id),
      {'data-wb-continuation-id':row.id,class:'record-row','aria-pressed':draft?.id===row.id,
       disabled:work.busy||work.pending&&work.pending.messageId!==row.input.origin.messageId}))))),
   work.pending&&!draft&&el('div',{class:'wb-continuation-pending'},
    notice('草稿保存结果待核对；本页不会自动再次提交。','warning'),
    definition([['准确目标',work.pending.task.id],['用户原话',work.pending.rawText],['拟派发正文',work.pending.dispatchText]]),
    reference('原消息 ID',work.pending.messageId)),
   !draft&&!work.pending&&el('div',{class:'wb-continuation-compose'},
    target&&definition([['目标项目',project.name+' · '+project.id],['目标任务',target.id],['执行器',providers[target.provider]],
     ['原生线程',target.threadId]]),
    field('用户原话','wb-continuation-raw',work.raw,value=>{
     work.raw=value;
     if(!work.reviewedEdited){work.reviewed=value;const reviewed=document.getElementById('wb-continuation-reviewed');if(reviewed)reviewed.value=value;}
     updateCompose();
    },{type:'textarea',rows:4,maxLength:120000,disabled:!target||work.busy,autocomplete:'off'}),
    field('拟派发正文','wb-continuation-reviewed',work.reviewed,value=>{
     work.reviewed=value;work.reviewedEdited=true;updateCompose();
    },{type:'textarea',rows:5,maxLength:120000,disabled:!target||work.busy,autocomplete:'off'}),
    button('保存待确认续接',prepareContinuation,{id:'wb-continuation-prepare',class:'primary',
     disabled:!target||work.busy||!continuationText(work.raw)||!continuationText(work.reviewed)})),
   draft&&el('div',{class:'wb-continuation-draft'},
    definition([['目标项目',project.name+' · '+draft.task.projectId],['目标任务',draft.task.id],
     ['执行器',providers[draft.task.provider]],['原生线程',draft.task.threadId],
     ['草稿版本',String(draft.version)],['草稿状态',draft.state==='open'?'待确认':draft.state==='dismissed'?'已取消':
      work.phase==='submitted'?'已接收':'已领取·结果待核对']]),
    !exact&&notice('当前保存的任务焦点与这张草稿不一致；本页不能编辑或确认。','warning'),
    el('h4',{},'用户原话'),el('div',{class:'text-block',id:'wb-continuation-original'},draft.input.rawText),
    el('h4',{},'本版确认正文'),el('div',{class:'text-block',id:'wb-continuation-confirmed'},draft.input.dispatchText),
    field('修改派发正文','wb-continuation-edit',work.editText,value=>{
     work.editText=value;
     const save=document.getElementById('wb-continuation-save'),confirm=document.getElementById('wb-continuation-confirm');
     if(save)save.disabled=!editable||!continuationText(value)||value===draft.input.dispatchText;
     if(confirm)confirm.disabled=!editable||value!==draft.input.dispatchText||!current.status?.dispatchEnabled;
    },{type:'textarea',rows:5,maxLength:120000,disabled:!editable,autocomplete:'off'}),
    changed&&notice('修改尚未保存。保存新版后，请重新核对上方完整正文再确认。','warning'),
    el('div',{class:'actions'},
     button('保存修改',reviseContinuation,{id:'wb-continuation-save',disabled:!editable||!changed||!continuationText(work.editText)}),
     button('取消未提交草稿',dismissContinuation,{id:'wb-continuation-dismiss',disabled:!editable}),
     button('确认向原任务续接',confirmContinuation,{id:'wb-continuation-confirm',class:'primary',
      disabled:!editable||changed||!current.status?.dispatchEnabled||work.phase==='unsupported'}),
     button('只读核对原命令',readContinuation,{id:'wb-continuation-read',disabled:work.busy||!online()})),
    work.phase==='uncertain'&&notice('确认结果待核对；只读取原命令，不会再次确认或派发。','warning'),
    work.phase==='dismissed'&&notice('这张未提交草稿已取消；不能把取消当作停止执行中的任务。','muted'),
    work.receipt&&notice(work.receipt.state==='accepted'?'原命令已有接收回执。':
     work.receipt.state==='unsupported'?'原生派发未启用，任务没有发送。':
     work.receipt.state==='conflict'?'原命令发生冲突，不能沿旧版本发送。':'原命令结果仍待核对。',
     work.receipt.state==='accepted'?'success':'warning'),
    el('div',{class:'wb-references'},reference('原消息 ID',draft.input.origin.messageId),
     reference('草稿 ID',draft.id),reference('命令 ID',draft.commandId)),
    ['dismissed','submitted'].includes(work.phase)&&button('另写一条续接',anotherContinuation,
     {id:'wb-continuation-another',disabled:work.busy})));
 }
 function taskPage(){
  const current=state();if(!current)return null;
  const rows=current.rows||[];
  const saved=current.focus?.task,selected=rows.find(row=>row.task.id===current.selected)?.task;
  const exact=selected?.origin==='t3'&&saved?.id===selected.id&&
   nativeIdentity(saved)===nativeIdentity(selected)&&!current.localSelection&&!current.stale;
  return el('section',{class:'wb-task-page wb-native-entry'},
   el('div',{class:'section-head'},el('div',{},el('h2',{},'项目任务 · '+project.name),
    el('p',{class:'subtle'},'项目 '+project.id+' · 完整对话、工具过程与变更在 T3 Code 中查看。')),
    button('刷新列表',loadTaskPage,{id:'wb-reload',disabled:!online()||current.loading.has('tasks')})),
   el('div',{class:'card wb-native-entry-card'},
    el('h3',{},'继续工程任务'),
    el('p',{class:'subtle'},'打开此项目会进入指定原生项目的新草稿；选择已保存任务后可进入准确的原生对话。'),
    el('div',{class:'actions'},
     button('打开此项目',()=>openNative('project'),{id:'wb-native-project',disabled:nativeOpen.busy||!online()}),
     button('打开当前任务',()=>openNative('task'),{id:'wb-native-task',disabled:nativeOpen.busy||!online()||!exact}))),
   current.status===null&&notice(current.loading.has('status')?'正在核对本机原生工作服务。':'本机原生工作服务状态暂不可读取。','muted'),
   current.status&&!current.status.readAvailable&&notice('原生任务暂不可读取；列表中的状态仅为本机最近记录。','warning'),
   current.loading.has('focus')&&notice('正在核对这个项目保存的任务选择。','muted'),
   current.focusError&&notice(current.focusError,'warning'),
   current.error&&notice(current.error,'error'),current.message&&notice(current.message,'success'),
   current.stale&&current.rows&&notice('列表可能已过期，请刷新后核对。','warning'),
   sourceView(current.source),
   el('p',{class:'subtle wb-task-counts'},'已登记 '+rows.length+' 项 · 最近记录需用户回应 '+
    rows.filter(row=>['waiting_approval','waiting_answer'].includes(row.projection?.phase)).length+
    ' 项 · 待核对 '+rows.filter(row=>!row.projection||row.projection.phase==='unknown').length+' 项'),
   taskList(current),exact&&el('p',{class:'subtle'},'当前焦点：'+selected.id+' · '+selected.threadId),
   saved&&button('清除保存的选择',()=>saveFocus(null),{id:'wb-clear-focus',disabled:current.focusBusy||!online()}));
 }
 function view(){
  return el('div',{class:'workbench-page'},
   el('div',{class:'section-head'},el('div',{},el('p',{class:'page-eyebrow'},'工程工作台'),
    el('h2',{},project?'项目 · '+project.name:'选择项目')),
    el('div',{class:'actions'},button('打开 T3 Code',()=>openNative('home'),
     {id:'wb-native-home',disabled:nativeOpen.busy||!online()}),
     button('选择项目',openProjects,{id:'wb-projects'}))),
   nativeOpen.error&&notice(nativeOpen.error,'warning'),nativeOpen.message&&notice(nativeOpen.message,'success'),
   project?el('div',{},el('div',{class:'actions wb-tabs'},
    button('项目任务',()=>changeSection('tasks'),{id:'wb-tab-tasks','aria-pressed':section==='tasks'}),
    button('项目记忆',()=>changeSection('memory'),{id:'wb-tab-memory','aria-pressed':section==='memory'})),
    section==='memory'?memory.view():taskPage()):
    notice('从“项目索引”选择项目，或直接打开完整 T3 Code 工作台。'));
 }
 return {open,view,refresh:()=>section==='memory'?memory.refresh():loadTaskPage(),sync,dispose(){disposed=true;stopNavigationWatch();invalidate();memory.dispose();}};
}
