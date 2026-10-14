import { createHash } from 'node:crypto';
import type { WorkbenchChannelCommandPort, WorkbenchCommandResult, WorkbenchContinuationDraft, WorkbenchInput, WorkbenchTaskRef } from '../contracts/workbench.js';
import type { WeChatInput } from './service.js';
import type { WeChatStore } from './store.js';
import { sameTask } from './workbench-query.js';

type T3Task = Extract<WorkbenchTaskRef, { readonly origin: 't3' }>;
type Pending = { draftId:string; version:number; commandId:string; task:T3Task; sourceMessageId:string;
  phase:'open'|'checking'; shown:boolean };
type History = { draftId:string; commandId:string; task:T3Task };
type State = { current?:Pending; history:History[] };
type Action = {kind:'prepare';taskId?:string;body:string}|{kind:'revise';body:string}|
  {kind:'confirm'|'read'|'cancel'|'plain_confirm'|'plain_cancel'|'invalid'};
export type CommandAnswer = {handled:true;text:string|undefined;current:()=>boolean;onDelivered?:(accepted:boolean)=>void}|{handled:false};
const UUID='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const prepare=new RegExp(`^(?:继续|续接)任务(?:\\s+(${UUID}))?\\s*[:：]\\s*([\\s\\S]+)$`,'i');
const exactId=new RegExp('^'+UUID+'$','i');

function action(raw:string):Action|undefined {
  const text=raw.normalize('NFKC').trim();
  const selected=prepare.exec(text);
  if(selected)return {kind:'prepare',...(selected[1]?{taskId:selected[1].toLowerCase()}:{}),body:selected[2]!.trim()};
  const focused=/^继续\s*[:：]\s*([\s\S]+)$/u.exec(text);
  if(focused)return {kind:'prepare',body:focused[1]!.trim()};
  const revised=/^修改续接\s*[:：]\s*([\s\S]+)$/u.exec(text);
  if(revised)return {kind:'revise',body:revised[1]!.trim()};
  if(/^(?:继续|续接)\s*任务|^修改续接/u.test(text))return {kind:'invalid'};
  if(text==='确认续接')return {kind:'confirm'};
  if(text==='查询续接')return {kind:'read'};
  if(text==='取消续接')return {kind:'cancel'};
  if(text==='确认')return {kind:'plain_confirm'};
  if(text==='取消')return {kind:'plain_cancel'};
}
const sameNative=(a:WorkbenchTaskRef,b:WorkbenchTaskRef)=>sameTask(a,b);
const card=(draft:WorkbenchContinuationDraft)=>'续接任务 '+draft.task.id+'（版本 '+draft.version+'）\n原话：'+draft.input.rawText+
  '\n将发送：'+draft.input.dispatchText+'\n请核对。回复“确认”或“确认续接”发送；回复“修改续接：新正文”可修改，回复“取消续接”可放弃这张未发送卡。';
const resultText=(result:WorkbenchCommandResult)=>'续接任务 '+(result.task?.id??'')+'：'+({recorded:'仍待确认',accepted:'已接收',unknown:'结果待核',unsupported:'当前不可派发',conflict:'身份或版本冲突'} as const)[result.state]+'。命令：'+result.commandId+'。';

/** The channel stores only task/draft references; raw and reviewed text live in the workbench draft. */
export class WeChatWorkbenchCommand {
  private generation=0;
  private readonly key:string;
  constructor(private readonly options:{port:WorkbenchChannelCommandPort|undefined;store:Pick<WeChatStore,'get'|'set'>;
    channelKey:string;focusTask:()=>T3Task|undefined;selectTask:(task:T3Task)=>void}) {
    this.key='workbench-continuation:'+options.channelKey;
  }
  private state():State { try {const value=this.options.store.get<State>(this.key);return value&&Array.isArray(value.history)?value:{history:[]};}catch{return {history:[]};} }
  private save(value:State) { this.options.store.set(this.key,value); }
  private matches(pending:Pending,result:WorkbenchCommandResult):boolean {
    return result.commandId===pending.commandId&&!!result.task&&sameNative(result.task,pending.task);
  }
  /** Only a public readback of the original claimed command can enter this channel's submitted history. */
  private rememberClaim(pending:Pending,result:WorkbenchCommandResult):void {
    if(!this.matches(pending,result)||(result.state!=='accepted'&&result.state!=='unknown'))return;
    const state=this.state();
    if(state.current?.draftId!==pending.draftId||state.current.commandId!==pending.commandId)return;
    if(state.history.some(item=>item.commandId===pending.commandId))return;
    this.save({...state,history:[...state.history,{draftId:pending.draftId,commandId:pending.commandId,task:pending.task}]});
  }
  private async readOriginal(pending:Pending,current:()=>boolean):Promise<{text?:string;state?:WorkbenchCommandResult['state']}> {
    try {
      const result=await this.options.port!.readContinuation(pending.draftId,'wechat',this.options.channelKey);
      if(!current())return {};
      if(!this.matches(pending,result))return {text:'续接回执身份待核；不会重新派发。'};
      this.rememberClaim(pending,result);
      return {text:resultText(result),state:result.state};
    } catch {return current()?{text:'续接回执待核；不会重新派发。'}:{};}
  }

  async handle(input:WeChatInput,signal:AbortSignal,oldPending:boolean):Promise<CommandAnswer> {
    const parsed=action(input.text),generation=++this.generation;
    const current=()=>!signal.aborted&&generation===this.generation;
    const answer=(text?:string,onDelivered?:(accepted:boolean)=>void):CommandAnswer=>({handled:true,text,current,...(onDelivered?{onDelivered}:{})});
    const state=this.state(),pending=state.current;
    if(!parsed)return {handled:false};
    if(parsed.kind==='invalid')return answer('续接请用“继续任务 <准确任务ID>：正文”，或先选中任务后用“继续任务：正文”。修改请用“修改续接：新正文”。');
    if((parsed.kind==='plain_confirm'||parsed.kind==='plain_cancel')&&!pending)return {handled:false};
    if((parsed.kind==='plain_confirm'||parsed.kind==='plain_cancel')&&oldPending)return answer('当前还有另一张待确认任务卡。请明确回复“确认续接／取消续接”，或先处理原任务卡。');
    if(!this.options.port)return answer('工作台续接尚不可用；本次没有发送任务。');
    const restoreOpen=async (intent:Pending):Promise<CommandAnswer>=>{
      try {
        const draft=await this.options.port!.readContinuationDraft(intent.draftId,'wechat',this.options.channelKey);
        if(!current())return answer();
        if(draft.id!==intent.draftId||draft.version!==intent.version||draft.state!=='open'||
            draft.commandId!==intent.commandId||!sameNative(draft.task,intent.task)||
            draft.input.origin.channel!=='wechat'||draft.input.origin.channelSessionId!==this.options.channelKey||
            draft.input.origin.messageId!==intent.sourceMessageId||!draft.input.dispatchText.trim())
          return answer('续接草稿身份或版本待核；旧确认不能使用。');
        const latest=this.state();
        if(latest.current?.draftId!==intent.draftId||latest.current.commandId!==intent.commandId||
            (latest.current.phase!=='checking'&&latest.current.phase!=='open'))return answer();
        this.save({...latest,current:{...latest.current,phase:'open',shown:false}});
        const prefix=intent.phase==='checking'?'上次确认未进入派发，重新核对：\n':'续接卡尚未确认送达，重新展示：\n';
        return answer(prefix+card(draft),accepted=>{if(!accepted)return;const saved=this.state();
          if(saved.current?.draftId===intent.draftId&&saved.current.version===intent.version&&saved.current.phase==='open')
            this.save({...saved,current:{...saved.current,shown:true}});});
      }catch{return answer(current()?'续接草稿详情待核；不会重新派发。':undefined);}
    };
    if(parsed.kind==='prepare'){
      if(!parsed.body)return answer('请在“继续任务：”后写明要发送的正文。');
      if(oldPending)return answer('当前还有一张旧任务卡待确认。请先确认或取消它，再续接工作台任务。');
      if(pending?.phase==='checking'&&!state.history.some(item=>item.commandId===pending.commandId))
        return answer('上次续接确认仍待核。请先查询原命令回执；不会重新派发。');
      if(pending?.phase==='open'&&pending.sourceMessageId!==input.messageId)return answer('已有待确认续接卡；请先确认、修改或取消，避免混淆目标。');
      let task:T3Task;
      try {
        const focus=this.options.focusTask(),taskId=parsed.taskId??focus?.id;
        if(!taskId||!exactId.test(taskId))return answer('请先用准确任务ID选择目标，或发送“继续任务 <任务ID>：正文”。');
        const read=await this.options.port.refreshTask(taskId);
        if(!current())return answer();
        if(!read?.projection||read.projection.taskId!==taskId||read.task.id!==taskId||read.task.origin!=='t3'||
            (focus&&!parsed.taskId&&!sameNative(focus,read.task)))return answer('任务身份待核；没有准备或发送续接。');
        task=read.task;
        const messageId=input.messageId;
        const workInput:WorkbenchInput={inputId:'wechat-'+createHash('sha256').update(this.options.channelKey+':'+messageId).digest('hex'),
          origin:{channel:'wechat',channelSessionId:this.options.channelKey,messageId},rawText:input.text,
          dispatchText:parsed.body,createdAt:new Date(input.createdAt??Date.now()).toISOString()};
        const draft=await this.options.port.prepareContinuation(taskId,workInput);
        if(!current())return answer();
        if(draft.task.origin!=='t3'||!sameNative(task,draft.task)||draft.input.rawText!==input.text||
            draft.input.origin.channel!=='wechat'||draft.input.origin.channelSessionId!==this.options.channelKey||
            draft.input.origin.messageId!==messageId)return answer('续接草稿身份待核；没有发送。');
        if(draft.state==='dismissed')return answer('这条续接草稿已取消，旧确认不可使用。');
        this.options.selectTask(task);
        const next:Pending={draftId:draft.id,version:draft.version,commandId:draft.commandId,task,
          sourceMessageId:messageId,phase:draft.state==='claimed'?'checking':'open',shown:false};
        this.save({...state,current:next});
        if(draft.state==='claimed')return answer((await this.readOriginal(next,current)).text);
        return answer(card(draft),accepted=>{if(!accepted)return;const latest=this.state();
          if(latest.current?.draftId===draft.id&&latest.current.version===draft.version&&latest.current.phase==='open'){
            this.save({...latest,current:{...latest.current,shown:true}});}});
      }catch{return answer(current()?'续接草稿准备待核；没有发送任务。':undefined);}
    }
    if(parsed.kind==='revise'){
      if(!pending||pending.phase!=='open')return answer('当前没有可修改的未发送续接卡。');
      if(!parsed.body)return answer('请在“修改续接：”后写明新的发送正文。');
      try {const draft=this.options.port.reviseContinuation(pending.draftId,pending.version,'wechat',this.options.channelKey,parsed.body);
        if(!current())return answer();
        if(draft.id!==pending.draftId||draft.commandId!==pending.commandId||!sameNative(draft.task,pending.task)||draft.version<=pending.version)return answer('续接卡版本待核；旧确认不能使用。');
        const next={...pending,version:draft.version,shown:false};this.save({...state,current:next});
        return answer(card(draft),accepted=>{if(!accepted)return;const latest=this.state();
          if(latest.current?.draftId===draft.id&&latest.current.version===draft.version&&latest.current.phase==='open')this.save({...latest,current:{...latest.current,shown:true}});});
      }catch{return answer(current()?'续接卡版本待核；旧确认不能使用。':undefined);}
    }
    if(parsed.kind==='cancel'||parsed.kind==='plain_cancel'){
      if(!pending)return answer('当前没有待确认续接卡。');
      try {const dismissed=this.options.port.dismissContinuation(pending.draftId,pending.version,'wechat',this.options.channelKey);
        if(dismissed.state!=='dismissed'||dismissed.commandId!==pending.commandId||!sameNative(dismissed.task,pending.task)||dismissed.version<=pending.version)
          return answer('续接卡取消结果待核；旧确认不能使用。');
        this.save({history:state.history});return answer('已取消这张未发送的续接卡；旧版本确认已失效。');
      }catch{return answer('续接卡可能已提交或版本变化，不能把它当作已取消执行；请查询原命令回执。');}
    }
    if(parsed.kind==='read'){
      if(!pending)return answer('当前微信会话没有可查询的续接卡。');
      const read=await this.readOriginal(pending,current);
      return read.state==='recorded'&&(pending.phase==='checking'||!pending.shown)?restoreOpen(pending):answer(read.text);
    }
    if(!pending)return answer('当前没有待确认续接卡。');
    if(pending.phase==='checking'){
      const read=await this.readOriginal(pending,current);
      return read.state==='recorded'?restoreOpen(pending):answer(read.text);
    }
    if(!pending.shown)return restoreOpen(pending);
    if(parsed.kind==='plain_confirm'){
      try {const status=await this.options.port.refreshTask(pending.task.id);
        if(!current())return answer();
        if(!status?.projection||!sameNative(status.task,pending.task))return answer('任务身份待核；本次没有派发。');
        if(status.projection.phase==='waiting_approval'||status.projection.phase==='waiting_answer')return answer('原生任务同时在等待工具批准或回答。请明确回复“确认续接”以确认这张续接卡；这里不会代为批准工具。');
      }catch{return answer(current()?'任务状态待核；本次没有派发。':undefined);}
    }
    const claimed={...pending,phase:'checking' as const};
    this.save({...state,current:claimed}); // Crash after this point permits readback only.
    try {const result=await this.options.port.confirmContinuation(pending.draftId,pending.version,'wechat',this.options.channelKey);
      if(!current())return answer();
      if(!this.matches(pending,result))return answer('续接确认回执身份待核；不会再次派发。');
      const read=await this.readOriginal(claimed,current);
      if(result.state==='unsupported'&&read.state==='recorded'){
        const latest=this.state();
        if(latest.current?.draftId===pending.draftId&&latest.current.commandId===pending.commandId)
          this.save({...latest,current:{...latest.current,phase:'open'}});
        return answer(resultText(result));
      }
      if((result.state==='accepted'||result.state==='unknown')&&read.state==='recorded')
        return answer('续接确认与原命令读回不一致，结果待核；不会再次派发。');
      return answer(read.text);
    }catch{return answer(current()?'续接确认结果待核；请查询原命令回执，不会再次派发。':undefined);}
  }

  async history(signal:AbortSignal):Promise<string[]> {
    if(!this.options.port)return [];
    const pending=this.state().current;
    if(pending?.phase==='checking'&&!this.state().history.some(item=>item.commandId===pending.commandId)){
      signal.throwIfAborted();
      try {const read=await this.options.port.readContinuation(pending.draftId,'wechat',this.options.channelKey);
        signal.throwIfAborted();this.rememberClaim(pending,read);
      }catch{signal.throwIfAborted();}
    }
    const seen=new Set<string>(),rows:string[]=[];
    for(const item of this.state().history){
      signal.throwIfAborted();
      if(seen.has(item.commandId))continue;seen.add(item.commandId);
      try {const result=await this.options.port.readContinuation(item.draftId,'wechat',this.options.channelKey);
        if((result.state!=='accepted'&&result.state!=='unknown')||result.commandId!==item.commandId||!result.task||!sameNative(result.task,item.task))continue;
        rows.push('工作台续接任务 '+item.task.id+'：'+(result.state==='accepted'?'已接收':'结果待核')+'。命令：'+item.commandId+'。');
      }catch{ /* An unreadable claim is not presented as a confirmed historical send. */ }
    }
    return rows;
  }
}
