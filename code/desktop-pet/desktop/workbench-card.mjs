const node=(tag,text,id)=>{const value=document.createElement(tag);if(text!==undefined)value.textContent=text;if(id)value.id=id;return value;};
const label=(text,value)=>{const row=node('p');row.className='desktop-workbench-pair';row.append(node('strong',text),node('span',value));return row;};
const button=(text,id,click,disabled=false)=>{const value=node('button',text,id);value.type='button';value.disabled=disabled;value.onclick=click;return value;};
const validText=value=>typeof value==='string'&&!!value.trim()&&value.length<=120000&&!value.includes('\0');
const identifier=value=>typeof value==='string'&&!!value.trim()&&value.length<=250&&!/[\u0000-\u001f\u007f]/u.test(value);
const originValid=origin=>['desktop','web','wechat'].includes(origin?.channel)&&identifier(origin.channelSessionId)&&identifier(origin.messageId);
const conversationValid=conversation=>conversation===undefined||Array.isArray(conversation)&&conversation.every(row=>
 row&&['user','assistant'].includes(row.role)&&validText(row.text)&&originValid(row.origin));
const taskKey=task=>task?.origin==='t3'&&['id','projectId','environmentId','t3ProjectId','threadId','providerInstanceId'].every(k=>identifier(task[k]))&&
 ['codex','dsh'].includes(task.provider)?JSON.stringify([task.id,task.projectId,task.provider,task.environmentId,task.t3ProjectId,task.threadId,task.providerInstanceId]):null;
const draftValid=draft=>draft&&identifier(draft.id)&&identifier(draft.commandId)&&Number.isSafeInteger(draft.version)&&draft.version>=1&&
 ['open','claimed','dismissed'].includes(draft.state)&&taskKey(draft.task)&&draft.input?.origin?.channel==='desktop'&&
 identifier(draft.input.origin.channelSessionId)&&identifier(draft.input.origin.messageId)&&
 draft.input.inputId===draft.input.origin.messageId&&validText(draft.input.rawText)&&validText(draft.input.dispatchText)&&conversationValid(draft.input.conversation);
const voiceBindingValid=(s,b)=>b===undefined||b?.version==='0.1.0'&&identifier(b.projectId)&&identifier(b.taskId)&&
 Number.isSafeInteger(b.focusRevision)&&b.focusRevision===s.focus.revision&&b.projectId===s.focus.projectId&&
 s.focus.task?.provider==='codex'&&b.taskId===s.focus.task.id&&identifier(b.draftId)&&identifier(b.commandId)&&
 Number.isSafeInteger(b.draftVersion)&&b.draftVersion>=1&&s.selectedDraftId===b.draftId&&s.drafts.some(d=>
 d.id===b.draftId&&d.version===b.draftVersion&&d.commandId===b.commandId&&d.state==='open'&&taskKey(d.task)===taskKey(s.focus.task));
const stateValid=s=>s&&s.version==='0.1.0'&&Number.isSafeInteger(s.sequence)&&s.sequence>=0&&
 typeof s.readAvailable==='boolean'&&typeof s.dispatchEnabled==='boolean'&&s.focus?.version==='0.1.0'&&
 Number.isSafeInteger(s.focus.revision)&&s.focus.revision>=0&&
 (s.focus.projectId===null&&s.focus.task===null||identifier(s.focus.projectId)&&
  (s.focus.task===null||taskKey(s.focus.task)&&s.focus.task.projectId===s.focus.projectId))&&
 Array.isArray(s.projects)&&s.projects.length<=100&&s.projects.every(p=>identifier(p.id)&&identifier(p.name))&&
 new Set(s.projects.map(p=>p.id)).size===s.projects.length&&typeof s.projectsTruncated==='boolean'&&
 Array.isArray(s.tasks)&&s.tasks.every(r=>r&&identifier(r.task?.id)&&identifier(r.task?.projectId)&&
  ['t3','legacy_codex_app','legacy_dsh'].includes(r.task.origin))&&
 Array.isArray(s.drafts)&&s.drafts.length<=20&&s.drafts.every(draftValid)&&
 new Set(s.drafts.map(d=>d.id)).size===s.drafts.length&&typeof s.draftsTruncated==='boolean'&&
 (s.selectedDraftId===null||identifier(s.selectedDraftId)&&s.drafts.some(d=>d.id===s.selectedDraftId))&&
 (!s.command||identifier(s.command.commandId)&&['recorded','accepted','conflict','unsupported','unknown'].includes(s.command.state))&&voiceBindingValid(s,s.voiceBinding);
const resultLabel={recorded:'待用户确认',accepted:'原命令已接收',conflict:'原命令冲突',unsupported:'派发未启用，未发送',unknown:'结果待核对'};
const draftStateLabel={open:'待确认',claimed:'已领取',dismissed:'已取消未提交'};
const phaseLabel={recorded:'已登记',accepted:'已接收',running:'正在处理',waiting_approval:'等待原生批准',waiting_answer:'等待原生回答',completed:'已完成',failed:'未完成',cancelled:'已取消',unknown:'待核对'};
const nativeStateLabel={pending:'待回应',answered:'已解决',expired:'已过期',unknown:'待核对'};
const nativeResolutionLabel={pending:'原生请求仍待处理',answered:'原生请求已解决',expired:'原生请求已过期',unknown:'原生结果待核对'};
const nativeCommandLabel={recorded:'命令已记录，待原生接收',accepted:'命令已接收',conflict:'命令冲突',unsupported:'派发未启用',unknown:'命令结果待核对'};
const unique=values=>new Set(values).size===values.length;
const nativeItemValid=(item,task)=>item&&identifier(item.id)&&item.taskId===task.id&&Number.isSafeInteger(item.version)&&item.version>=0&&
 ['pending','answered','expired','unknown'].includes(item.state)&&['durable','live_only'].includes(item.answerLifetime)&&
 (item.kind==='approval'&&typeof item.summary==='string'&&Array.isArray(item.choices)&&item.choices.length>0&&item.choices.length<=30&&
  item.choices.every(choice=>identifier(choice.id)&&validText(choice.label)&&(choice.warning===undefined||typeof choice.warning==='string'))&&unique(item.choices.map(choice=>choice.id))&&
  (item.choiceSource===undefined||['provider','t3_default'].includes(item.choiceSource))||
 item.kind==='question'&&Array.isArray(item.questions)&&item.questions.length>0&&item.questions.length<=20&&
  item.questions.every(question=>identifier(question.id)&&validText(question.prompt)&&
   (question.options===undefined||Array.isArray(question.options)&&question.options.length<=30&&
    question.options.every(option=>identifier(option.id)&&validText(option.label)&&(option.description===undefined||typeof option.description==='string'))&&unique(question.options.map(option=>option.id)))&&
   (question.allowMultiple===undefined||typeof question.allowMultiple==='boolean')&&
   (question.allowCustomAnswer===undefined||typeof question.allowCustomAnswer==='boolean')&&
   ((question.options?.length??0)>0||question.allowCustomAnswer===true))&&unique(item.questions.map(question=>question.id)));
const nativeValid=(native,target)=>native&&['no_target','supported','unsupported','unverified','unavailable'].includes(native.status)&&
 ['unavailable','supported','unsupported'].includes(native.bindingsStatus)&&Array.isArray(native.interactions)&&native.interactions.length<=100&&
 Array.isArray(native.bindings)&&unique(native.bindings.map(row=>row.interactionId))&&
 native.bindings.every(row=>identifier(row.interactionId)&&identifier(row.commandId)&&['approval','question'].includes(row.kind)&&
  Number.isSafeInteger(row.requestVersion)&&row.requestVersion>=0)&&
 (native.task===null&&!target||target&&taskKey(native.task)===taskKey(target))&&
 native.interactions.every(item=>target&&nativeItemValid(item,target))&&unique(native.interactions.map(item=>item.id))&&
 (native.selectedInteractionId===null||identifier(native.selectedInteractionId))&&
 (native.error===undefined||typeof native.error==='string')&&
 (native.command===undefined||identifier(native.command.command?.commandId)&&
  ['recorded','accepted','conflict','unsupported','unknown'].includes(native.command.command.state)&&
  ['pending','answered','expired','unknown'].includes(native.command.resolution)&&
  (!native.command.command.task||taskKey(native.command.command.task)===taskKey(target)));

/** Presentation only. Native focus, draft versions and command receipts remain authoritative. */
export class DesktopWorkbenchCard {
 constructor({get,send,online,openNative,visible=()=>true,onOpen=()=>{},voice}){
  this.get=get;this.send=send;this.online=online;this.openNativeShell=openNative;this.nativeOpening=false;this.sequence=-1;this.state=null;this.invalid=false;
  this.search='';this.raw='';this.reviewed='';this.reviewedEdited=false;this.composeTarget=null;this.composeMode=false;
  this.pending=null;this.prepareUnknown=null;this.reviewKey=null;this.confirmAttempt=null;this.issue='';
  this.nativeSelectedId=null;this.nativeDraftKey=null;this.nativeDraft=null;this.nativeAttempts=new Set();
  this.visible=visible;this.onOpen=onOpen;this.voice=voice;this.presentedKey=null;this.presentationEpoch=0;this.presentationPending=null;this.blockedKey=null;
  this.presentationReading=null;this.offeredKey=null;this.renderedVoiceKey=null;
  get('workbench-open').onclick=()=>this.open();get('workbench-close').onclick=()=>this.close();
  get('workbench-dialog').addEventListener('cancel',event=>{event.preventDefault();this.close();});
  get('workbench-content').addEventListener('scroll',()=>this.schedulePresentation(),true);
  this.render();
 }
 get isOpen(){return this.get('workbench-dialog').open;}
 disconnect(){
  this.forgetBinding();
  if(this.pending?.type==='prepare')this.prepareUnknown=this.pending;
  this.pending=null;this.nativeOpening=false;this.state=null;this.sequence=-1;this.reviewKey=null;this.invalid=false;this.blockedKey=null;this.offeredKey=null;
  this.nativeDraft=null;this.nativeDraftKey=null;this.nativeSelectedId=null;
  if(this.confirmAttempt)this.issue='连接已更新；先只读核对原命令和草稿。';
  this.close(false);this.render();
 }
 ready(){this.forgetBinding();this.state=null;this.sequence=-1;this.reviewKey=null;this.invalid=false;this.blockedKey=null;this.offeredKey=null;this.nativeDraft=null;this.nativeDraftKey=null;this.nativeSelectedId=null;this.render();}
 launchNative(kind){
  if(this.nativeOpening||!this.online())return;
  const focus=this.state?.focus,target=this.target();
  if(kind!=='home'&&(!this.state?.readAvailable||!identifier(focus?.projectId)||!Number.isSafeInteger(focus.revision)))return;
  if(kind==='task'&&!target)return;
  const command={type:'open_workbench',target:kind};
  if(kind!=='home'){command.projectId=focus.projectId;command.expectedFocusRevision=focus.revision;}
  if(kind==='task')command.taskId=target.id;
  this.nativeOpening=true;this.issue='正在打开完整工程工作台…';this.openNativeShell(command);this.render();
 }
 nativeOpenResult(value){
  if(!this.nativeOpening||typeof value?.ok!=='boolean')return;
  this.nativeOpening=false;this.issue=value.ok?'已在浏览器打开工程入口。':'打开未完成；请刷新并核对当前项目或任务后重试。任务不会重发。';this.render();
 }
 receive(value){
  if(!this.online()||!Number.isSafeInteger(value?.sequence)||value.sequence<=this.sequence)return false;
  this.sequence=value.sequence;
  if(!stateValid(value)){this.forgetBinding();this.state=null;this.invalid=true;this.reviewKey=null;this.pending=null;this.issue='工作台状态无法核对，请刷新。';this.render();return false;}
  const oldKey=this.draftKey(),oldTarget=this.targetKey();this.state=structuredClone(value);this.invalid=false;
  if(oldTarget!==this.targetKey()){this.nativeSelectedId=null;this.nativeDraft=null;this.nativeDraftKey=null;}
  const native=this.native();
  if(native){
   const target=this.target();for(const row of native.bindings)this.nativeAttempts.add(JSON.stringify([taskKey(target),row.interactionId,row.requestVersion,row.kind]));
   if(this.nativeSelectedId&&!native.interactions.some(item=>item.id===this.nativeSelectedId)&&
    !native.bindings.some(row=>row.interactionId===this.nativeSelectedId))this.nativeSelectedId=null;
   if(!this.nativeSelectedId&&native.selectedInteractionId&&
    (native.interactions.some(item=>item.id===native.selectedInteractionId)||native.bindings.some(row=>row.interactionId===native.selectedInteractionId)))this.nativeSelectedId=native.selectedInteractionId;
  }else{this.nativeDraft=null;this.nativeDraftKey=null;}
  if(this.nativeDraftKey!==this.nativeKey(this.nativeItem())){this.nativeDraft=null;this.nativeDraftKey=null;}
  if(this.prepareUnknown){
   const match=value.drafts.find(d=>d.input.origin.messageId===this.prepareUnknown.messageId&&
    d.input.rawText===this.prepareUnknown.rawText&&taskKey(d.task)===this.prepareUnknown.taskKey);
   if(match){this.prepareUnknown=null;this.composeMode=false;this.raw='';this.reviewed='';this.reviewedEdited=false;this.composeTarget=null;this.issue='原消息已从服务端草稿找回。';}
  }
  if(this.pending&&value.sequence>this.pending.sequence){
   if(this.pending.type==='prepare'&&!this.prepareUnknown)this.issue='草稿已保存；请核对完整正文。';
   else this.issue='';
   this.pending=null;
  }
  if(oldKey!==this.draftKey()||oldTarget!==this.targetKey()){
   this.reviewKey=null;if(!this.composeMode)this.reviewed=this.exactDraft()?.input.dispatchText??'';
  }
  if(!value.readAvailable||value.error||value.command?.state==='accepted'||value.command?.state==='conflict'||value.command?.state==='unknown'||this.selectedDraft()?.state==='claimed')this.reviewKey=null;
  if(oldKey!==this.draftKey()||oldTarget!==this.targetKey()||!this.voiceCandidate()||
     this.presentationReading&&this.presentationReading.key!==this.voiceKey()){
   this.presentedKey=null;this.presentationReading=null;this.presentationEpoch++;this.presentationPending=null;
  }
  this.render();return true;
 }
 target(){
  const s=this.state,f=s?.focus;if(!s?.readAvailable||!f?.task||!f.projectId)return null;
  const key=taskKey(f.task);return key&&s.tasks.some(r=>taskKey(r.task)===key)?f.task:null;
 }
 targetKey(){const task=this.target();return task?JSON.stringify([this.state.focus.revision,taskKey(task)]):null;}
 selectedDraft(){return this.state?.drafts.find(d=>d.id===this.state.selectedDraftId)??null;}
 exactDraft(){const draft=this.selectedDraft(),target=this.target();return draft&&target&&taskKey(draft.task)===taskKey(target)?draft:null;}
 draftKey(){const d=this.exactDraft();return d?JSON.stringify([this.targetKey(),d.id,d.version,d.commandId,d.input.rawText,d.input.dispatchText]):null;}
 receipt(){const draft=this.exactDraft(),command=this.state?.command;return draft&&command?.commandId===draft.commandId&&
  (!command.task||taskKey(command.task)===taskKey(draft.task))?command:null;}
 voiceCandidate(){const s=this.state,d=this.exactDraft();return this.online()&&s?.readAvailable&&!s.error&&d?.state==='open'&&
  this.receipt()?.state==='recorded'&&!this.pending&&this.confirmAttempt!==this.draftKey()&&s.voiceBinding?structuredClone(s.voiceBinding):null;}
 voiceKey(){const b=this.voiceCandidate();return b?JSON.stringify([b,this.draftKey(),this.exactDraft().input.conversation??[]]):null;}
 inputBinding(){const key=this.voiceKey();return key&&key===this.presentedKey&&key!==this.blockedKey?this.voiceCandidate():null;}
 needsPresentation(){const key=this.voiceKey();return !!key&&key!==this.offeredKey&&key!==this.blockedKey;}
 forgetBinding(){this.blockedKey=this.voiceKey();this.presentedKey=null;this.presentationReading=null;this.presentationEpoch++;this.presentationPending=null;}
 presentationRegions(){const d=this.exactDraft();return d?[{id:'workbench-draft-raw',text:d.input.rawText},
  ...(d.input.conversation??[]).map((row,index)=>({id:`workbench-draft-dialogue-${index}`,text:row.text})),
  {id:'workbench-draft-body',text:d.input.dispatchText}]:[];}
 presentationSample(){
  const card=this.get('workbench-draft'),content=this.get('workbench-content');
  if(!this.isOpen||!this.visible()||document.hidden||!card||!content||!this.get('workbench-dialog').contains(card)||!card.getClientRects().length)return null;
  const viewport=content.getBoundingClientRect(),regions=[];
  const top=Math.max(0,viewport.top),bottom=Math.min(window.innerHeight??Infinity,viewport.bottom),
   left=Math.max(0,viewport.left),right=Math.min(window.innerWidth??Infinity,viewport.right);
  if(bottom<=top||right<=left)return null;
  for(const required of this.presentationRegions()){
   const element=this.get(required.id);
   if(!element||!card.contains(element)||element.textContent!==required.text)return null;
   const rect=element.getBoundingClientRect(),height=element.scrollHeight,width=element.clientWidth;
   if(!Number.isFinite(height)||height<=0||!Number.isFinite(width)||width<=0||!Number.isFinite(element.clientHeight)||element.clientHeight<=0)return null;
   const scale=rect.height/(element.offsetHeight||rect.height),innerTop=rect.top+(element.clientTop||0)*scale,
    innerBottom=innerTop+element.clientHeight*scale,visibleTop=Math.max(top,innerTop),visibleBottom=Math.min(bottom,innerBottom);
   // CSS wraps text. Credit only the full horizontal text viewport, including
   // its nested scroll position, rather than any sliver of the containing card.
   const visible=element.getClientRects().length&&scale>0&&visibleBottom>visibleTop&&rect.left>=left-1&&rect.right<=right+1&&element.scrollWidth<=width+1;
   regions.push({id:required.id,height,width,interval:visible?[
    Math.max(0,(element.scrollTop||0)+(visibleTop-innerTop)/scale),
    Math.min(height,(element.scrollTop||0)+(visibleBottom-innerTop)/scale)]:null});
  }return regions;
 }
 recordPresentation(key,sample){
  if(this.presentationReading?.key!==key)this.presentationReading={key,regions:new Map()};
  for(const region of sample){let progress=this.presentationReading.regions.get(region.id);
   if(!progress||progress.height!==region.height||progress.width!==region.width){
    progress={height:region.height,width:region.width,intervals:[]};this.presentationReading.regions.set(region.id,progress);
   }
   if(!region.interval)continue;
   const intervals=[...progress.intervals,region.interval].sort((a,b)=>a[0]-b[0]),merged=[];
   for(const interval of intervals){const last=merged.at(-1);
    // One CSS pixel covers integer clientHeight/scrollHeight rounding only.
    if(last&&interval[0]<=last[1]+1)last[1]=Math.max(last[1],interval[1]);else merged.push([...interval]);
   }progress.intervals=merged;
  }
  if(sample.every(region=>{const p=this.presentationReading.regions.get(region.id);return p?.intervals.length===1&&p.intervals[0][0]<=1&&p.intervals[0][1]>=region.height-1;}))this.presentedKey=key;
  this.updateActions();this.updateInputControls();
 }
 schedulePresentation(){
  const key=this.voiceKey();if(!key||key===this.blockedKey||key===this.presentedKey||this.presentationPending===key||!this.isOpen)return;
  const epoch=this.presentationEpoch;this.presentationPending=key;
  // Each actual text region must traverse its scroll viewport. Credit a range
  // only when the same geometry is observed on both sides of a paint boundary.
  requestAnimationFrame(()=>{if(epoch!==this.presentationEpoch||key!==this.voiceKey())return;
   const first=this.presentationSample();
   requestAnimationFrame(()=>{if(epoch!==this.presentationEpoch||key!==this.voiceKey())return;
    this.presentationPending=null;const second=this.presentationSample();
    if(first&&second&&JSON.stringify(first)===JSON.stringify(second))this.recordPresentation(key,second);
    else if(second)this.schedulePresentation();
   });
  });
 }
 updateInputControls(){const button=this.get('workbench-voice'),original=this.get('voice');if(button&&original){
  button.textContent=original.textContent;button.disabled=original.disabled||!!this.pending||
   original.textContent==='开始语音'&&!!this.state?.voiceBinding&&!this.inputBinding();
 }
 const text=this.get('workbench-text');if(text)text.disabled=!!this.pending||!!this.state?.voiceBinding&&!this.inputBinding();
 const status=this.get('workbench-review-status');if(status){status.textContent=this.receipt()?.state==='unknown'?
  '原命令结果待核对，请刷新。':this.confirmAttempt===this.draftKey()?'这版已尝试确认，请刷新核对原命令。':this.inputBinding()?
  '本版原话、补充和完整正文已展示，可以补充或确认。':'请滚动查看本版原话、补充和完整正文。';
 }}
 native(){const target=this.target(),native=this.state?.native;return nativeValid(native,target)?native:null;}
 nativeItem(){return this.native()?.interactions.find(item=>item.id===this.nativeSelectedId)??null;}
 nativeKey(item){return item&&this.targetKey()?JSON.stringify([this.targetKey(),item.id,item.version,item.kind]):null;}
 nativeAttemptKey(item){const target=this.target();return item&&target?JSON.stringify([taskKey(target),item.id,item.version,item.kind]):null;}
 nativeBinding(item){return item?(this.native()?.bindings.find(row=>row.interactionId===item.id)??null):null;}
 answerDraft(item){const key=this.nativeKey(item);if(!key)return null;
  if(this.nativeDraftKey!==key){this.nativeDraftKey=key;this.nativeDraft=item.kind==='approval'?{choiceId:''}:{questions:Object.fromEntries(item.questions.map(q=>[q.id,{selectedOptionIds:[],customMode:!(q.options?.length),customText:''}]))};}
  return this.nativeDraft;}
 nativeResponse(item){if(!item)return null;const draft=this.answerDraft(item);if(!draft)return null;
  if(item.kind==='approval')return item.choices.some(choice=>choice.id===draft.choiceId)?{type:'decide_approval',choiceId:draft.choiceId}:null;
  const answers=[];for(const question of item.questions){const answer=draft.questions[question.id];if(!answer)return null;
   if(answer.customMode){if(!question.allowCustomAnswer||!validText(answer.customText))return null;
    answers.push({questionId:question.id,selectedOptionIds:[],customText:answer.customText});
   }else{const selected=answer.selectedOptionIds;
    if(!selected.length||!question.allowMultiple&&selected.length!==1||!unique(selected)||
     selected.some(id=>!question.options?.some(option=>option.id===id)))return null;
    answers.push({questionId:question.id,selectedOptionIds:[...selected]});}
  }return {type:'answer_question',answers};}
 canRespond(item){const native=this.native();return !!(this.online()&&this.state?.readAvailable&&
  !this.state.error&&this.state.dispatchEnabled&&!this.pending&&native?.status==='supported'&&
  native.bindingsStatus==='supported'&&!native.error&&item?.state==='pending'&&!this.nativeBinding(item)&&
  !this.nativeAttempts.has(this.nativeAttemptKey(item))&&this.nativeResponse(item));}
 selectInteraction(id){const native=this.native();if(!native?.interactions.some(row=>row.id===id)&&
  !native?.bindings.some(row=>row.interactionId===id))return;
  this.nativeSelectedId=id;this.nativeDraft=null;this.nativeDraftKey=null;this.render();}
 respondInteraction(){const item=this.nativeItem(),target=this.target(),response=this.nativeResponse(item),key=this.nativeAttemptKey(item);
  if(!target||!response||!this.canRespond(item))return;
  this.nativeAttempts.add(key);this.nativeDraft=null;this.nativeDraftKey=null;
  this.action({type:'respond_interaction',projectId:target.projectId,taskId:target.id,
   expectedFocusRevision:this.state.focus.revision,interactionId:item.id,expectedVersion:item.version,response});}
 readInteraction(){const id=this.nativeSelectedId,target=this.target(),native=this.native();
  if(!id||!target||!native||native.bindingsStatus!=='supported'||!this.nativeBinding({id})||this.pending||!this.online()||!this.state.readAvailable)return;
  this.action({type:'read_interaction',projectId:target.projectId,taskId:target.id,
   expectedFocusRevision:this.state.focus.revision,interactionId:id});}
 nativeAnswerView(item){const body=node('div');body.className='desktop-workbench-native-answers';const draft=this.answerDraft(item);
  if(item.kind==='approval'){
   body.append(node('p',item.summary));
   if(item.choiceSource==='t3_default')body.append(node('p','原请求未提供供应商选项；以下为 T3 后备选项，请逐项核对。'));
   for(const choice of item.choices){const row=node('label');row.className='desktop-workbench-native-option';
    const input=node('input');input.type='radio';input.name='desktop-native-approval';input.value=choice.id;
    input.checked=draft.choiceId===choice.id;input.onchange=()=>{draft.choiceId=choice.id;this.updateActions();};
    const caption=node('span');caption.append(node('strong',choice.label));if(choice.warning)caption.append(node('small',choice.warning));
    caption.append(node('small',`选项编号 ${choice.id}`));row.append(input,caption);body.append(row);}
   return body;
  }
  for(const [index,question] of item.questions.entries()){
   const answer=draft.questions[question.id],field=node('fieldset');field.className='desktop-workbench-native-question';
   field.append(node('legend',`${index+1}. ${question.prompt}`));
   field.append(node('small',question.allowMultiple?'可选择多项':'请选择一项'));
   for(const option of question.options??[]){const row=node('label');row.className='desktop-workbench-native-option';
    const input=node('input');input.type=question.allowMultiple?'checkbox':'radio';input.name=`desktop-native-question-${index}`;
    input.value=option.id;input.checked=!answer.customMode&&answer.selectedOptionIds.includes(option.id);
    input.onchange=()=>{answer.customMode=false;answer.selectedOptionIds=question.allowMultiple?
     answer.selectedOptionIds.includes(option.id)?answer.selectedOptionIds.filter(id=>id!==option.id):[...answer.selectedOptionIds,option.id]:[option.id];
     this.render();};
    const caption=node('span');caption.append(node('strong',option.label));if(option.description)caption.append(node('small',option.description));
    row.append(input,caption);field.append(row);}
   if(question.allowCustomAnswer){
    if(question.options?.length)field.append(button(answer.customMode?'改选给定选项':'改用自由回答',`workbench-native-custom-mode-${index}`,()=>{
     answer.customMode=!answer.customMode;this.render();},false));
    if(answer.customMode){const text=node('textarea',undefined,`workbench-native-custom-${index}`);text.rows=4;text.maxLength=120000;
     text.value=answer.customText;text.setAttribute('aria-label',`第 ${index+1} 题自由回答`);
     text.oninput=()=>{answer.customText=text.value;this.updateActions();};field.append(text);}}
   body.append(field);
  }return body;}
 nativeSection(){const section=node('section');section.className='desktop-workbench-section desktop-workbench-native';
  section.append(node('h3','原生审批与提问'));
  const target=this.target(),native=this.native();
  if(!target){section.append(node('p','先保存一个准确的 T3 Codex 任务，才能核对原生请求。'));return section;}
  if(this.state.native===undefined){section.append(node('p','当前桌面桥尚未提供原生请求状态；请刷新或更新本机服务。'));return section;}
  if(!native){section.append(node('p','原生请求状态与当前目标不一致或格式无法核对，已关闭回答。'));return section;}
  if(native.error)section.append(node('p',native.error.slice(0,300)));
  if(native.status==='unsupported')section.append(node('p','当前原生任务不支持桌面批准或提问。'));
  if(native.status==='unverified'||native.status==='unavailable')section.append(node('p','原生请求来源暂不可核对，不能操作。'));
  if(native.bindingsStatus!=='supported')section.append(node('p','已认领命令尚未核对，当前不能提交回答。'));
  if(!this.state.dispatchEnabled)section.append(node('p','生产原生回答派发未启用；可只读核对请求。'));
  section.append(label('准确目标',`${target.projectId} · ${target.id} · ${target.threadId} · 焦点版本 ${this.state.focus.revision}`));
  const list=node('div');list.className='desktop-workbench-list desktop-workbench-native-list';
  for(const item of native.interactions){const bound=native.bindings.find(row=>row.interactionId===item.id);
   const b=button(`${item.kind==='approval'?'审批':'提问'} · ${nativeStateLabel[item.state]} · v${item.version} · ${item.kind==='approval'?item.summary:item.questions.map(q=>q.prompt).join('；')}`,
    undefined,()=>this.selectInteraction(item.id));b.dataset.interactionId=item.id;b.setAttribute('aria-pressed',String(this.nativeSelectedId===item.id));
   if(bound)b.append(node('small',' · 已有原命令'));list.append(b);}
  for(const bound of native.bindings.filter(row=>!native.interactions.some(item=>item.id===row.interactionId))){
   const b=button(`已认领${bound.kind==='approval'?'审批':'提问'} · 请求 ${bound.interactionId} · v${bound.requestVersion}`,
    undefined,()=>this.selectInteraction(bound.interactionId));b.dataset.interactionId=bound.interactionId;
   b.setAttribute('aria-pressed',String(this.nativeSelectedId===bound.interactionId));list.append(b);}
  section.append(list);if(native.status==='supported'&&!native.interactions.length&&!native.bindings.length)section.append(node('p','当前准确任务没有原生请求或历史绑定。'));
  const item=this.nativeItem(),binding=this.nativeBinding({id:this.nativeSelectedId}),attempted=item&&this.nativeAttempts.has(this.nativeAttemptKey(item));
  if(!item&&!binding)return section;
  const detail=node('div');detail.className='desktop-workbench-native-detail';
  detail.append(label('请求',`${item?.id??binding.interactionId} · v${item?.version??binding.requestVersion} · ${item?nativeStateLabel[item.state]:'当前列表已无此请求'}`));
  if(item)detail.append(label('有效期',item.answerLifetime==='live_only'?'仅当前原生会话':'原生持久请求'));
  if(binding){detail.append(label('原命令',`${binding.commandId} · 请求版本 ${binding.requestVersion}`));
   if(item&&(binding.kind!==item.kind||binding.requestVersion!==item.version))detail.append(node('p','原请求与已认领命令的类型或版本不同；仅能只读核对。'));
   const read=native.command?.command.commandId===binding.commandId?native.command:null;
   detail.append(label('命令状态',read?nativeCommandLabel[read.command.state]:'原命令待读取'),
    label('原生结果',read?nativeResolutionLabel[read.resolution]:'原生结果待核对'));
   detail.append(button('只读核对原命令','workbench-native-read',()=>this.readInteraction(),
    !!this.pending||!this.online()||!this.state.readAvailable||native.bindingsStatus!=='supported'));
  }else if(attempted)detail.append(node('p','本次回答已提交或回执中断；请刷新并核对服务端绑定，不会自动重发。'));
  if(item?.state==='pending'&&!binding&&!attempted){detail.append(this.nativeAnswerView(item));
   detail.append(button(item.kind==='approval'?'提交所选审批决定':'提交全部问题回答','workbench-native-submit',()=>this.respondInteraction(),!this.canRespond(item)));}
  else if(item&&item.state!=='pending'&&!binding)detail.append(node('p','请求当前不再等待回答。'));
  section.append(detail);return section;}
 canEdit(){const draft=this.exactDraft(),receipt=this.receipt();return this.online()&&this.state?.readAvailable&&!this.state?.error&&draft?.state==='open'&&!this.pending&&
  ['recorded','unsupported'].includes(receipt?.state)&&this.confirmAttempt!==this.draftKey();}
 canConfirm(){return this.canEdit()&&this.state.dispatchEnabled&&this.receipt()?.state==='recorded'&&
  this.reviewed===this.exactDraft().input.dispatchText&&(!this.state.voiceBinding||!!this.inputBinding());}
 action(action){
  if(!this.online()||!this.state||this.pending)return false;
  if(['select','select_draft','confirm','dismiss','revise','prepare'].includes(action.type))this.forgetBinding();
  this.pending={type:action.type,sequence:this.sequence,...(action.type==='prepare'?{messageId:action.messageId,rawText:action.rawText,taskKey:taskKey(this.target())}:{})};
  if(action.type==='prepare')this.prepareUnknown=this.pending;
  if(action.type==='confirm'){this.confirmAttempt=this.draftKey();this.reviewKey=null;}
  this.issue='等待原操作回执；本页不会自动重复提交。';this.send(action);this.render();return true;
 }
 selectProject(projectId){if(!this.state||!this.state.projects.some(p=>p.id===projectId))return;
  this.reviewKey=null;this.action({type:'select',projectId,taskId:null,expectedRevision:this.state.focus.revision});}
 selectTask(taskId){const s=this.state,row=s?.tasks.find(r=>r.task.id===taskId),key=taskKey(row?.task);
  if(!key||row.task.projectId!==s.focus.projectId)return;
  this.reviewKey=null;this.action({type:'select',projectId:s.focus.projectId,taskId,expectedRevision:s.focus.revision});}
 selectDraft(draftId){const draft=this.state?.drafts.find(d=>d.id===draftId);if(!draft)return;
  this.composeMode=false;this.reviewKey=null;this.reviewed=draft.input.dispatchText;this.reviewedEdited=false;
  this.action({type:'select_draft',draftId});}
 refresh(){if(!this.state)return;this.action({type:'refresh'});}
 searchProjects(){if(this.search.length>250||/[\u0000-\u001f\u007f]/u.test(this.search))return;
  this.action({type:'refresh',projectQuery:this.search});}
 beginCompose(){const key=this.targetKey();if(!key)return;
  this.composeMode=true;this.composeTarget=key;this.raw='';this.reviewed='';this.reviewedEdited=false;this.issue='';this.render();}
 prepare(){const target=this.target(),key=this.targetKey();if(!target||this.state?.error||!this.composeMode||this.composeTarget!==key||
  this.prepareUnknown||!validText(this.raw)||!validText(this.reviewed))return;
  this.action({type:'prepare',projectId:target.projectId,taskId:target.id,expectedFocusRevision:this.state.focus.revision,
   messageId:crypto.randomUUID(),rawText:this.raw,dispatchText:this.reviewed});}
 revise(){const draft=this.exactDraft();if(!this.canEdit()||!validText(this.reviewed)||this.reviewed===draft.input.dispatchText)return;
  this.reviewKey=null;this.action({type:'revise',draftId:draft.id,expectedVersion:draft.version,dispatchText:this.reviewed});}
 dismiss(){const draft=this.exactDraft();if(!this.canEdit())return;
  this.reviewKey=null;this.action({type:'dismiss',draftId:draft.id,expectedVersion:draft.version});}
 review(){const draft=this.exactDraft();if(!draft||!this.state?.readAvailable||this.state.error||draft.state!=='open'||this.receipt()?.state!=='recorded'||this.pending||
  this.reviewed!==draft.input.dispatchText)return;
  this.reviewKey=this.draftKey();this.confirmAttempt=null;this.reviewed=draft.input.dispatchText;this.issue='已核对当前目标、原话和完整正文；确认仍需单独点击。';this.render();}
 confirm(){const draft=this.exactDraft();if(!this.canConfirm()||!draft)return;
  this.action({type:'confirm',draftId:draft.id,expectedVersion:draft.version});}
 position(){const r=this.get('drawer').getBoundingClientRect(),d=this.get('workbench-dialog');
  Object.assign(d.style,{left:`${r.left+8}px`,top:`${r.top+8}px`,width:`${Math.max(1,r.width-16)}px`,height:`${Math.max(1,r.height-16)}px`});}
 open(){this.onOpen();this.blockedKey=null;this.offeredKey=this.voiceKey();if(this.isOpen){this.schedulePresentation();return;}this.position();this.get('workbench-dialog').show();this.render();this.get('workbench-close').focus({preventScroll:true});}
 close(restore=true){if(!this.isOpen)return;this.presentationEpoch++;this.presentationPending=null;this.get('workbench-dialog').close();
  if(restore)setTimeout(()=>this.get('workbench-open').focus({preventScroll:true}),0);}
 tab(event){const nodes=[...this.get('workbench-dialog').querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter(n=>n.getClientRects().length);
  if(!nodes.length)return;event.preventDefault();event.stopPropagation();const at=nodes.indexOf(document.activeElement);nodes[(at+(event.shiftKey?-1:1)+nodes.length)%nodes.length].focus({preventScroll:true});}
 render(){
  const s=this.state,selected=this.exactDraft(),target=this.target(),receipt=this.receipt(),open=this.isOpen;
  const launcher=this.get('workbench-open'),summary=this.get('workbench-summary');
  launcher.disabled=!this.online();summary.textContent=this.invalid?'状态待核对':!s?'连接后读取项目与任务':target?`已选任务 · ${s.drafts.length} 张草稿`:s.focus?.projectId?'请选择准确任务':'请选择项目';
  const source=this.get('workbench-source');
  if(selected){const previous=source.querySelector('details')?.open??false;const details=node('details');details.open=previous;
   details.append(node('summary','当前工程原话 · 点击展开完整内容'),node('pre',selected.input.rawText));source.replaceChildren(details);source.hidden=false;
  }else{source.replaceChildren();source.hidden=true;}
  if(!open)return;
  const content=this.get('workbench-content'),footer=this.get('workbench-footer'),scroll=content.scrollTop,focused=document.activeElement?.id;
  const voiceKey=this.voiceKey(),reading=this.renderedVoiceKey===voiceKey?this.presentationRegions().map(r=>[r.id,this.get(r.id)?.scrollTop??0]):[];
  const selectStart=document.activeElement?.selectionStart,selectEnd=document.activeElement?.selectionEnd;
  const parts=[];
  if(!s){parts.push(node('p',this.invalid?'工作台状态无法核对；请重新连接后刷新。':'正在读取本机工作台。'));}
  else{
   if(s.error)parts.push(node('p',s.error.slice(0,300)));
   if(this.issue)parts.push(node('p',this.issue));
   if(!s.readAvailable)parts.push(node('p','原生任务暂不可核对，所有写操作已关闭。'));
   if(!s.dispatchEnabled)parts.push(node('p','原生派发尚未启用。'));
   const nativeEntry=node('section');nativeEntry.className='desktop-workbench-section desktop-workbench-entry';
   nativeEntry.append(node('h3','完整工程工作台'),node('p','完整对话、工具过程和变更在 T3 Code 中查看。'),
    button('打开 T3 Code','workbench-native-home',()=>this.launchNative('home'),this.nativeOpening),
    button('打开当前项目','workbench-native-project',()=>this.launchNative('project'),
     this.nativeOpening||!s.readAvailable||!identifier(s.focus.projectId)),
    button('打开当前任务','workbench-native-task',()=>this.launchNative('task'),
     this.nativeOpening||!target));parts.push(nativeEntry);
   const projects=node('section');projects.className='desktop-workbench-section';projects.append(node('h3','项目'));
   const search=node('div');search.className='desktop-workbench-search';const searchInput=node('input',undefined,'workbench-project-query');searchInput.type='search';searchInput.value=this.search;searchInput.placeholder='按项目名称查找';searchInput.maxLength=250;searchInput.oninput=()=>{this.search=searchInput.value;};
   search.append(searchInput,button('搜索','workbench-project-search',()=>this.searchProjects(),!!this.pending));projects.append(search);
   if(s.projectsTruncated)projects.append(node('p','项目只显示前 100 项，请搜索后选择。'));
   const projectList=node('div');projectList.className='desktop-workbench-list';
   for(const p of s.projects){const active=s.focus.projectId===p.id,b=button(`${p.name} · ${p.id}`,undefined,()=>this.selectProject(p.id),!!this.pending||!s.readAvailable);
    b.dataset.projectId=p.id;b.setAttribute('aria-pressed',String(active));projectList.append(b);}projects.append(projectList);
   if(!s.projects.length)projects.append(node('p','当前搜索没有可列出的项目。'));parts.push(projects);
   if(s.focus.projectId){const tasks=node('section');tasks.className='desktop-workbench-section';tasks.append(node('h3','这个项目的任务'));
    const list=node('div');list.className='desktop-workbench-list';for(const row of s.tasks){const t=row.task,valid=taskKey(t)&&t.projectId===s.focus.projectId,active=taskKey(s.focus.task)===taskKey(t)&&valid;
     const b=button(`${t.provider==='dsh'?'DeepSeek Harness':'Codex'} · ${t.id} · ${phaseLabel[row.projection?.phase]??'状态待核对'}`,undefined,()=>this.selectTask(t.id),!valid||!!this.pending||!s.readAvailable);
     b.dataset.taskId=t.id;b.setAttribute('aria-pressed',String(!!active));list.append(b);
     const preview=row.resultPreview;
     if(row.projection?.phase==='completed'&&preview?.nativeTurnId===row.projection.nativeTurnId&&identifier(preview.messageId)&&typeof preview.text==='string'&&[...preview.text].length<=320&&typeof preview.truncated==='boolean')
      list.append(label('最近结果',preview.text+(preview.truncated?'…':'')));}tasks.append(list);
    if(!s.tasks.length)tasks.append(node('p','这个项目没有可列出的任务。'));
    if(s.focus.task)tasks.append(label('准确目标',`${s.focus.task.id} · ${s.focus.task.threadId??'旧入口'} · 焦点版本 ${s.focus.revision}`));
    tasks.append(button('清除任务选择','workbench-clear-focus',()=>this.action({type:'select',projectId:s.focus.projectId,taskId:null,expectedRevision:s.focus.revision}),!s.focus.task||!!this.pending||!s.readAvailable));parts.push(tasks);}
   if(target&&(s.drafts.length>1||!selected&&s.drafts.length)){
    const drafts=node('section');drafts.className='desktop-workbench-section';drafts.append(node('h3','选择草稿'));
    const list=node('div');list.className='desktop-workbench-list';
    for(const d of s.drafts){const b=button(`${d.input.rawText.slice(0,60)} · v${d.version} · ${draftStateLabel[d.state]}`,
     undefined,()=>this.selectDraft(d.id),!!this.pending);b.dataset.draftId=d.id;b.setAttribute('aria-pressed',String(s.selectedDraftId===d.id));list.append(b);}
    drafts.append(list);if(s.draftsTruncated)drafts.append(node('p','这里仅列出最近 20 张草稿。'));parts.push(drafts);
   }
   if(selected){const draftCard=node('section',undefined,'workbench-draft');draftCard.className='desktop-workbench-section desktop-workbench-draft';
    draftCard.append(node('h3','当前草稿'),label('准确目标',`${selected.task.projectId} · ${selected.task.id} · ${selected.task.threadId}`),
     label('版本与状态',`v${selected.version} · ${draftStateLabel[selected.state]}`),
     label('原命令回执',receipt?resultLabel[receipt.state]:'原命令待核对'),
     node('h4','用户原话'),node('pre',selected.input.rawText,'workbench-draft-raw'));
    if(selected.input.conversation?.length){const dialogue=node('section',undefined,'workbench-conversation');
     dialogue.append(node('h4','本任务的问答与补充'));for(const [index,row] of selected.input.conversation.entries())
      dialogue.append(node('strong',row.role==='user'?'用户':'助手'),node('pre',row.text,`workbench-draft-dialogue-${index}`));draftCard.append(dialogue);}
    draftCard.append(node('h4','待派发完整正文'),node('pre',selected.input.dispatchText,'workbench-draft-body'));
    if(this.confirmAttempt===this.draftKey())draftCard.append(node('p','这版草稿已尝试确认；请刷新并只读核对原命令，不会再次发送。'));
    parts.push(draftCard);
   }else if(s.selectedDraftId)parts.push(node('p','所选草稿与当前保存的准确任务不一致；不能确认。'));
   if(this.prepareUnknown)parts.push(node('p',`原消息 ${this.prepareUnknown.messageId} 的保存结果待核对；刷新或从列表选择，不会自动重复提交。`));
   if(target)parts.push(this.nativeSection());
  }
  content.replaceChildren(...parts);content.scrollTop=scroll;
  for(const [id,top] of reading){const pre=this.get(id);if(pre)pre.scrollTop=top;}this.renderedVoiceKey=voiceKey;
  const actions=[button('刷新与只读核对','workbench-refresh',()=>this.refresh(),!s||!!this.pending),
   button('关闭','workbench-footer-close',()=>this.close())];
  if(selected){actions.unshift(button('确认向原任务续接','workbench-confirm',()=>this.confirm(),!this.canConfirm()),
   button('取消未提交草稿','workbench-dismiss',()=>this.dismiss(),!this.canEdit()));}
  if(selected&&this.voice)actions.push(button(this.get('voice').textContent,'workbench-voice',()=>this.voice()),
   button('文字补充','workbench-text',()=>{this.close(false);this.get('text').focus({preventScroll:true});},!!this.pending));
  if(selected&&s.voiceBinding){const status=node('p',undefined,'workbench-review-status');
   Object.assign(status.style,{flexBasis:'100%',margin:'0'});actions.unshift(status);}
  footer.replaceChildren(...actions);
  this.updateInputControls();
  this.schedulePresentation();
  if(focused){const replacement=this.get(focused);if(replacement&&this.get('workbench-dialog').contains(replacement)){replacement.focus({preventScroll:true});if(selectStart!=null&&replacement.setSelectionRange)try{replacement.setSelectionRange(selectStart,selectEnd)}catch{}}}
 }
 updateActions(){const prepare=this.get('workbench-prepare'),revise=this.get('workbench-revise'),confirm=this.get('workbench-confirm');
  if(prepare)prepare.disabled=!!this.pending||!!this.prepareUnknown||!!this.state?.error||this.composeTarget!==this.targetKey()||!validText(this.raw)||!validText(this.reviewed);
  if(revise)revise.disabled=!this.canEdit()||!validText(this.reviewed)||this.reviewed===this.exactDraft()?.input.dispatchText;
  if(confirm)confirm.disabled=!this.canConfirm();const review=this.get('workbench-review');if(review)review.disabled=!!this.pending||!this.state?.readAvailable||
   !!this.state?.error||this.exactDraft()?.state!=='open'||this.receipt()?.state!=='recorded'||this.reviewed!==this.exactDraft()?.input.dispatchText;
  const submit=this.get('workbench-native-submit');if(submit)submit.disabled=!this.canRespond(this.nativeItem());}
}
