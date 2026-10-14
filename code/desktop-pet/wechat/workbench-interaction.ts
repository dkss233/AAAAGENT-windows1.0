import { createHash } from 'node:crypto';
import type { WorkbenchTaskRef, WorkbenchNativeInteractionPort, WorkbenchInteraction,
  WorkbenchInteractionResponse, WorkbenchInteractionBindingSummary, WorkbenchInteractionCommandRead } from '../contracts/workbench.js';
import type { WeChatInput } from './service.js';
import type { WeChatStore } from './store.js';
import type { CommandAnswer } from './workbench-command.js';
import { sameTask } from './workbench-query.js';

type Task = Extract<WorkbenchTaskRef,{origin:'t3'}>;
type Card = { task:Task; id:string; version:number; kind:WorkbenchInteraction['kind']; fingerprint:string; sentAt:number };
/** Metadata only: no request summary, options, answer text or credentials. */
export type NativeInteractionCapture = { channel:string; cards:Card[] };
type Attempt = { task:Task; id:string; version:number; kind:WorkbenchInteraction['kind']; commandId?:string };
type State = { cards:Card[]; attempts:Attempt[] };
type Action = {type:'show'|'ambiguous'|'invalid'}|{type:'read'|'respond';id:string;version:number;body:string;kind?:WorkbenchInteraction['kind']};
const REQUEST_ID='(?:[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const replyPattern=new RegExp(`^(回应原生请求|回答原生请求|查询原生回执)\\s+(${REQUEST_ID})\\s+v([0-9]+)(?:\\s*[:：]\\s*|\\s*\\n)([\\s\\S]*)$`,'i');
const readPattern=new RegExp(`^查询原生回执\\s+(${REQUEST_ID})\\s+v([0-9]+)$`,'i');
const fingerprint=(value:WorkbenchInteraction)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const matches=(a:Attempt,b:{id:string;version:number},task:Task)=>a.id===b.id&&a.version===b.version&&sameTask(a.task,task);
function parse(text:string):Action|undefined {
  const value=text.trim();
  if(/^(?:查询|查看)原生请求[。！!？?]?$/.test(value))return {type:'show'};
  if(/^(?:确认|批准|拒绝|允许|同意|回答|选项\s*\d+)[。！!？?]?$/.test(value))return {type:'ambiguous'};
  const read=readPattern.exec(value);
  if(read&&Number.isSafeInteger(Number(read[2])))return {type:'read',id:read[1]!.toLowerCase(),version:Number(read[2]),body:''};
  const reply=replyPattern.exec(value);
  if(reply&&Number.isSafeInteger(Number(reply[3])))return {type:reply[1]==='查询原生回执'?'read':'respond',id:reply[2]!.toLowerCase(),version:Number(reply[3]),body:reply[4]!,kind:reply[1]==='回答原生请求'?'question':'approval'};
  if(/^(?:回应|回答|查询|查看)原生(?:请求|回执)/.test(value))return {type:'invalid'};
}
function response(request:WorkbenchInteraction,body:string):WorkbenchInteractionResponse|undefined {
  if(request.kind==='approval'){
    const selected=/^选项\s*([1-9][0-9]*)$/.exec(body.trim());
    const choice=selected&&request.choices[Number(selected[1])-1];
    return choice?{type:'decide_approval',choiceId:choice.id}:undefined;
  }
  const lines=body.trim().split(/\r?\n/),answers:Extract<WorkbenchInteractionResponse,{type:'answer_question'}>['answers'][number][]=[];
  if(lines.length!==request.questions.length||!lines.length)return;
  const seen=new Set<number>();
  for(const line of lines){
    const match=/^\s*([1-9][0-9]*)\s*[:：]\s*(选项|自填)\s*[:：]?\s*([^\r\n]*)$/.exec(line);
    if(!match)return;
    const index=Number(match[1])-1,q=request.questions[index];
    if(!q||seen.has(index))return;
    seen.add(index);
    if(match[2]==='自填'){
      const custom=match[3]!.trim();
      if(!q.allowCustomAnswer||!custom||custom.includes('\0')||custom.length>120000)return;
      answers.push({questionId:q.id,selectedOptionIds:[],customText:custom});continue;
    }
    if(!/^[1-9][0-9]*(?:\s*[,，、]\s*[1-9][0-9]*)*$/.test(match[3]!))return;
    const numbers=match[3]!.split(/\s*[,，、]\s*/).map(Number);
    if(new Set(numbers).size!==numbers.length||numbers.length>30||(!q.allowMultiple&&numbers.length!==1))return;
    const ids=numbers.map(n=>q.options?.[n-1]?.id);
    if(ids.some(id=>id===undefined))return;
    answers.push({questionId:q.id,selectedOptionIds:ids as string[]});
  }
  return {type:'answer_question',answers};
}
function render(task:Task,request:WorkbenchInteraction):string {
  const head=`任务 ${task.id}\n原生请求 ${request.id} v${request.version}`;
  const receipt=`查询原生回执 ${request.id} v${request.version}`;
  if(request.kind==='approval')return head+'\n'+request.summary+'\n选项来源：'+(request.choiceSource==='t3_default'?'T3 默认选项':'原生提供方')+'\n'+request.choices.map((c,i)=>`${i+1}. ${c.label}${c.warning?'\n警告：'+c.warning:''}`).join('\n')+
    `\n请明确选择，无默认项。回复：回应原生请求 ${request.id} v${request.version}：选项 编号\n查询回执：${receipt}`;
  return head+'\n'+request.questions.map((q,i)=>`${i+1}. ${q.prompt}\n${q.allowMultiple?'可多选':'单选'}；${q.allowCustomAnswer?'也可单独自填':'不支持自填'}\n`+
    (q.options??[]).map((o,j)=>`  ${j+1}. ${o.label}${o.description?'：'+o.description:''}`).join('\n')).join('\n')+
    `\n请一次回答全部问题，无默认答案。回复首行：回答原生请求 ${request.id} v${request.version}\n接着每题一行：题号：选项 编号（多选以逗号分隔），或 题号：自填：内容。\n查询回执：${receipt}`;
}
function receiptText(read:WorkbenchInteractionCommandRead):string {
  const command={recorded:'已记录',accepted:'已接收',conflict:'身份或版本冲突',unsupported:'当前不可提交',unknown:'结果待核'}[read.command.state];
  const resolution={pending:'原生请求仍在等待处理',answered:'原生请求已解决',expired:'原生请求已过期',unknown:'原生处理结果待核'}[read.resolution];
  return `回复命令 ${read.command.commandId}：${command}；${resolution}。不会自动重复提交。`;
}
export function nativeInteractionPort(value:unknown):WorkbenchNativeInteractionPort|undefined {
  const port=value as Partial<WorkbenchNativeInteractionPort>|undefined;
  return port&&['listNativeInteractions','respondNativeInteraction','readNativeInteractionCommand','listNativeInteractionBindings','readNativeInteractionCommandForTask'].every(key=>typeof port[key as keyof WorkbenchNativeInteractionPort]==='function')?port as WorkbenchNativeInteractionPort:undefined;
}

/** Explicit user choices only, tied to the exact task and a card delivered before the inbound batch. */
export class WeChatWorkbenchInteraction {
  private generation=0;
  private readonly key:string;
  constructor(private readonly options:{port:WorkbenchNativeInteractionPort|undefined;store:Pick<WeChatStore,'get'|'set'|'claim'>;channelKey:string;focusTask:()=>Task|undefined}){
    this.key='workbench-native:'+options.channelKey;
  }
  private state():State {return this.options.store.get<State>(this.key)??{cards:[],attempts:[]};}
  capture():NativeInteractionCapture {return structuredClone({channel:this.options.channelKey,cards:this.state().cards});}
  private saveAttempt(attempt:Attempt){
    const state=this.state(),index=state.attempts.findIndex(a=>matches(a,attempt,attempt.task));
    if(index<0)state.attempts.push(attempt);else state.attempts[index]=attempt;
    this.options.store.set(this.key,state);
  }
  private async readOriginal(task:Task,attempt:Attempt,binding:WorkbenchInteractionBindingSummary,current:()=>boolean):Promise<string|undefined>{
    if(binding.kind!==attempt.kind||binding.requestVersion!==attempt.version||attempt.commandId&&attempt.commandId!==binding.commandId)return '原生回执身份或版本不符，请在原任务核对；不会再次提交。';
    // Persist the recovered locator before awaiting a possibly lost readback.
    this.saveAttempt({...attempt,commandId:binding.commandId});
    const read=await this.options.port!.readNativeInteractionCommandForTask(task.projectId,task.id,attempt.id);
    if(!current())return;
    if(read.command.commandId!==binding.commandId||!read.command.task||!sameTask(read.command.task,task)||read.interaction&&
      (read.interaction.id!==attempt.id||read.interaction.taskId!==task.id||read.interaction.kind!==attempt.kind||read.interaction.version!==attempt.version))return '原生回执身份或版本不符，请在原任务核对；不会再次提交。';
    return receiptText(read);
  }
  async handle(input:WeChatInput,signal:AbortSignal):Promise<CommandAnswer>{
    const generation=++this.generation,action=parse(input.text);
    if(!action)return {handled:false};
    const task=this.options.focusTask(),port=this.options.port,snapshot=input.nativeInteractionCapture??this.capture();
    const current=()=>!signal.aborted&&generation===this.generation&&(!task?!this.options.focusTask():!!this.options.focusTask()&&sameTask(task,this.options.focusTask()!));
    const answer=(text?:string):CommandAnswer=>({handled:true,text,current});
    if(action.type==='ambiguous'&&(!task||!port))return {handled:false};
    if(action.type==='invalid')return answer('请用“查询原生请求”查看请求，再按卡片中的编号和版本逐项回复。');
    if(!task)return answer('请先用“选择任务 完整任务编号”选择当前微信会话的任务，再查询原生请求。');
    if(task.provider!=='codex')return action.type==='ambiguous'?{handled:false}:answer('当前任务不支持微信原生审批或问答，请到原任务处理。');
    if(!port)return answer('当前原生交互接口不可用，请到原任务处理；没有提交回复。');
    try{
      signal.throwIfAborted();
      if(action.type==='respond'||action.type==='read'){
        const state=this.state(),attempt=state.attempts.find(a=>matches(a,action,task));
        // Read the authoritative persistent binding BEFORE considering any new submission.
        const persisted=await port.listNativeInteractionBindings(task.projectId,task.id);
        if(!current())return answer();
        if(persisted.status!=='supported'||!sameTask(persisted.task,task))return answer('原生命令记录暂不可核实，没有提交；请稍后查询原生回执。');
        const bindings=persisted.bindings.filter(b=>b.interactionId===action.id);
        if(bindings.length>1)return answer('原生命令记录不唯一，请在原任务核对。');
        const binding=bindings[0];
        if(binding){
          const original=attempt??{task,id:action.id,version:action.version,kind:action.kind??binding.kind};
          return answer(await this.readOriginal(task,original,binding,current));
        }
        if(attempt)return answer('首次回复的回执仍待核对；尚未找到原命令，不会再次提交。请到原任务核对。');
        if(action.type==='read')return answer('尚未找到该请求的已提交命令。');
      }
      const listed=await port.listNativeInteractions(task.projectId,task.id);
      if(!current())return answer();
      if(!sameTask(listed.task,task)||listed.status!=='supported')return answer('原生请求身份或能力尚未核实，请到原任务处理；没有提交回复。');
      if(listed.interactions.some(r=>r.taskId!==task.id)||new Set(listed.interactions.map(r=>r.id)).size!==listed.interactions.length)return answer('原生请求归属不明确，请到原任务核对。');
      const requests=listed.interactions.filter(r=>r.state==='pending');
      if(action.type==='ambiguous')return requests.length||this.state().cards.some(card=>sameTask(card.task,task))?answer('请明确要回复哪条原生请求及哪个选项。发送“查询原生请求”查看完整卡片；任务确认或续接确认不会批准工具操作。'):{handled:false};
      if(action.type==='show'){
        const state=this.state();state.cards=[];this.options.store.set(this.key,state);
        if(!requests.length)return answer('当前任务没有待答的原生请求。已有命令可按原卡片中的“查询原生回执”查询。');
        return {handled:true,current,text:requests.map(r=>render(task,r)).join('\n\n'),onDelivered:accepted=>{
          if(!accepted||!current())return;
          const state=this.state();state.cards=requests.map(r=>({task,id:r.id,version:r.version,kind:r.kind,fingerprint:fingerprint(r),sentAt:Date.now()}));this.options.store.set(this.key,state);
        }};
      }
      if(action.type!=='respond'&&action.type!=='read')return answer();
      const card=snapshot.channel===this.options.channelKey?snapshot.cards.find(c=>matches(c,action,task)):undefined;
      const stillShown=this.state().cards.find(c=>matches(c,action,task));
      if(!card||!stillShown||card.sentAt!==stillShown.sentAt||card.fingerprint!==stillShown.fingerprint||input.createdAt!==undefined&&input.createdAt<card.sentAt)return answer('这条回复没有对应本微信会话此前已送达的完整卡片。请先“查询原生请求”，收到后再回复。');
      const request=requests.find(r=>r.id===action.id&&r.version===action.version&&r.kind===action.kind);
      if(!request||fingerprint(request)!==card.fingerprint)return answer('原生请求或选项已变化，请重新“查询原生请求”后再回答。');
      const selected=response(request,action.body);
      if(!selected)return answer('答案不完整或选项不符。请按卡片编号明确选择；问答需每题一行并一次答全，自填与选项只能选一种。');
      if(!current())return answer();
      if(!this.options.store.claim(this.options.channelKey,'native-response:'+input.messageId))return answer('这条消息已处理或回执待核，请查询原生回执；不会重复提交。');
      const claimed:Attempt={task,id:request.id,version:request.version,kind:request.kind};
      this.saveAttempt(claimed);
      const read=await port.respondNativeInteraction(task.projectId,task.id,request.id,request.version,selected);
      // Claim remains durable even if focus changed or the transport was aborted after sending.
      const identity=!!read.command.task&&sameTask(read.command.task,task)&&(!read.interaction||read.interaction.id===claimed.id&&read.interaction.taskId===task.id&&read.interaction.kind===claimed.kind&&read.interaction.version===claimed.version);
      // The public service returns this exact unsupported shape before creating a binding or dispatching.
      // Recheck its persistent ledger, and release only the local attempt; the inbound message claim stays used.
      if(identity&&read.command.state==='unsupported'&&read.command.detail==='原生请求派发尚未启用。'&&read.command.commandId===claimed.id&&read.resolution==='unknown'&&!read.interaction&&current()){
        const after=await port.listNativeInteractionBindings(task.projectId,task.id);
        if(current()&&after.status==='supported'&&sameTask(after.task,task)&&!after.bindings.some(b=>b.interactionId===claimed.id)){
          const state=this.state();state.attempts=state.attempts.filter(a=>!matches(a,claimed,task)||a.commandId!==undefined);
          this.options.store.set(this.key,state);
          return answer('当前派发未启用，已确认这次没有提交。启用后请发送一条新的明确回复；这条旧消息不会复用。');
        }
      }
      if(identity&&read.command.state!=='unsupported'&&read.command.state!=='conflict')this.saveAttempt({...claimed,commandId:read.command.commandId});
      if(!current())return answer();
      if(!identity)return answer('回复回执身份待核，请查询原生回执；不会重复提交。');
      return answer(receiptText(read));
    }catch{
      return answer(current()?'原生交互状态暂不可确认。若已提交，请查询原生回执；不会自动再次提交。':undefined);
    }
  }
}
