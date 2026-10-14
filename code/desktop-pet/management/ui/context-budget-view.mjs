import {el,notice,definition} from './dom.mjs';

const layers={required:'必要输入与规则',current_emotion:'当前双方情绪',recent:'近期完整对话',summary:'会话摘要',memory:'相关长期记忆',historical_emotion:'历史情绪详情'};
const constraints={target:'输入目标',api_input:'模型接口输入容量',context_window:'总窗口扣除输出预留'};
export const omissionLabels={
  hard_gate:'归属、有效性或遗忘检查未通过',no_cue:'没有匹配线索',below_threshold:'低于选入门槛',
  limit:'历史条数限制',budget:'上下文空间不足',required_over_budget:'必要输入超出预算',
  recent_budget:'近期完整轮次超出剩余预算',orphan_assistant:'缺少对应用户消息',
  summary_budget:'摘要超出剩余预算',memory_budget:'长期记忆超出剩余预算',
  current_emotion_budget:'当前情绪超出预留',historical_emotion_budget:'历史情绪超出剩余预算',
};
const count=n=>Number.isSafeInteger(n)&&n>=0;
const text=s=>typeof s==='string'&&s.length>0;
const tokens=n=>n.toLocaleString('zh-CN')+' token';
export function validBudgetInfo(b){
  return !!b&&count(b.targetInputTokens)&&b.targetInputTokens>0&&count(b.apiInputLimit)&&b.apiInputLimit>0&&
    (b.contextWindowTokens===null||count(b.contextWindowTokens)&&b.contextWindowTokens>0)&&
    count(b.reservedOutputTokens)&&count(b.effectiveInputTokens)&&b.effectiveInputTokens>0&&
    Array.isArray(b.constrainedBy)&&b.constrainedBy.length>0&&b.constrainedBy.every(k=>Object.hasOwn(constraints,k))&&
    !!b.counting&&['model_tokenizer','utf8_upper_bound'].includes(b.counting.method)&&
    b.counting.estimated===(b.counting.method==='utf8_upper_bound')&&text(b.counting.model)&&text(b.counting.version);
}
export function validBudgetReport(b){
  return validBudgetInfo(b)&&b.version==='0.1.0'&&count(b.countedInputTokens)&&
    !!b.selected&&['messages','turns','summaries','memories','historicalEmotions'].every(k=>count(b.selected[k]))&&
    !!b.layers&&Object.keys(layers).every(k=>count(b.layers[k]))&&
    Object.keys(layers).reduce((n,k)=>n+b.layers[k],0)===b.countedInputTokens&&
    Array.isArray(b.omissions)&&b.omissions.every(o=>o&&Object.hasOwn(layers,o.layer)&&text(o.reason)&&(o.id===undefined||text(o.id)))&&
    (b.unreadRecent===undefined||typeof b.unreadRecent==='boolean');
}
export function budgetProblem(c){
  if(!c||c.targetInputTokens===undefined&&c.currentEmotionReserveTokens===undefined)return '';
  if(!count(c.targetInputTokens)||c.targetInputTokens===0)return '输入预算请填写正整数。';
  if(!count(c.currentEmotionReserveTokens)||c.currentEmotionReserveTokens>c.targetInputTokens)return '情绪预留请填写 0 到输入预算之间的整数。';
  return '';
}
function info(b){
  return definition([
    ['输入目标',tokens(b.targetInputTokens)],['实际有效输入',tokens(b.effectiveInputTokens)],
    ['模型接口输入容量',tokens(b.apiInputLimit)],['模型总窗口',b.contextWindowTokens===null?'未登记；按接口输入容量约束':tokens(b.contextWindowTokens)],
    ['输出预留',tokens(b.reservedOutputTokens)],['约束来源',b.constrainedBy.map(k=>constraints[k]).join('、')],
    ['计数模型',b.counting.model],['计数方法',b.counting.estimated?'估算（UTF-8 字节上界）':'对应模型 Tokenizer'],
    ['计数版本',b.counting.version],
  ]);
}
export function budgetComparison(settings){
  return el('div',{class:'grid'},[['当前运行预算',settings.effectiveBudget,settings.effectiveRevision,settings.effective],['最近保存预算',settings.savedBudget,settings.revision,settings.saved]].map(([label,b,revision,config])=>{
    const valid=validBudgetInfo(b)&&b.counting.model===config?.providers?.dialogue?.model;
    return (
    el('details',{'data-budget-info':label},el('summary',{},label+' · 版本 '+revision),
      label==='最近保存预算'&&el('p',{class:'subtle'},settings.pending?'等待重启后生效。':'已在当前实例生效。'),
      valid?el('div',{},info(b),definition([['当前情绪预留',count(config?.context?.currentEmotionReserveTokens)?tokens(config.context.currentEmotionReserveTokens):'未提供']])):notice('服务未提供当前模型的完整预算信息。'),
      valid&&el('small',{},'计数预测与供应商实际计费用量分别记录。')));
  }));
}
export function contextBudgetView(b){
  if(b===undefined)return notice('该记录未提供预算明细；计数方法与实选数量不可用。');
  if(!validBudgetReport(b))return notice('预算明细格式不匹配，已拒绝显示。','error');
  const omissions=new Map();for(const o of b.omissions){const key=o.layer+'/'+o.reason;const entry=omissions.get(key)||{layer:o.layer,reason:o.reason,ids:[],count:0};entry.count++;if(o.id)entry.ids.push(o.id);omissions.set(key,entry);}
  return el('section',{'data-context-budget':'0.1.0'},el('h3',{},'上下文预算明细'),
    definition([[b.counting.estimated?'估算用量':'本地 Tokenizer 计数',b.countedInputTokens.toLocaleString('zh-CN')+' / '+tokens(b.effectiveInputTokens)],
      ['实选近期消息 / 完整轮次',b.selected.messages+' / '+b.selected.turns],['实选摘要 / 长期记忆',b.selected.summaries+' / '+b.selected.memories],['选入历史情绪',b.selected.historicalEmotions]]),
    el('p',{class:'subtle'},'近期消息数不含本轮输入。'+(b.counting.estimated?'用量为 UTF-8 字节上界估算，含协议余量。':'用量由对应模型 Tokenizer 本地预测。')+'供应商实际计费用量另行记录。'),
    el('details',{},el('summary',{},'容量与计数方法'),info(b)),
    el('details',{},el('summary',{},'各层用量与遗漏'),el('p',{class:'subtle'},'各层按选入顺序增量计数，合计 '+b.countedInputTokens.toLocaleString('zh-CN')+'；采用上方同一计数方法。'),
      definition(Object.entries(layers).map(([key,label])=>[label,b.layers[key].toLocaleString('zh-CN')])),
      b.unreadRecent&&notice('仍有未读取的近期历史；未对这些正文逐条评估。'),
      omissions.size?el('ul',{},[...omissions.values()].map(o=>el('li',{},layers[o.layer]+'：'+(omissionLabels[o.reason]||o.reason)+' · '+o.count+' 项',o.ids.length>0&&el('details',{},el('summary',{},'查看标识'),el('div',{class:'text-block'},o.ids.join('\n')))))):el('p',{class:'empty'},'本次未记录遗漏。')));
}
