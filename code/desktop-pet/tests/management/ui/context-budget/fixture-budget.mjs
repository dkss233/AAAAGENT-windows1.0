// Generated public DTOs only; never opens project data, providers or devices.
export function fixtureBudget(config){
  const p=config.providers.dialogue,targetInputTokens=config.context.targetInputTokens;
  const apiInputLimit=p.inputTokenLimit,contextWindowTokens=p.contextWindowTokens??null,reservedOutputTokens=p.outputTokenLimit;
  const windowCapacity=contextWindowTokens===null?Infinity:contextWindowTokens-reservedOutputTokens;
  const effectiveInputTokens=Math.min(targetInputTokens,apiInputLimit,windowCapacity);
  return {targetInputTokens,apiInputLimit,contextWindowTokens,reservedOutputTokens,effectiveInputTokens,
    constrainedBy:[...(effectiveInputTokens===targetInputTokens?['target']:[]),...(effectiveInputTokens===apiInputLimit?['api_input']:[]),...(effectiveInputTokens===windowCapacity?['context_window']:[])],
    counting:{method:'utf8_upper_bound',estimated:true,model:p.model,version:'whole-request-utf8-v1'}};
}
export function fixtureReport(budget,selected={messages:48,turns:24,summaries:3,memories:8,historicalEmotions:2}){
  return {...budget,version:'0.1.0',countedInputTokens:6000,selected,
    layers:{required:900,current_emotion:128,recent:4000,summary:400,memory:500,historical_emotion:72},
    omissions:[{id:'older-round',layer:'recent',reason:'recent_budget'},{layer:'recent',reason:'orphan_assistant'},
      {id:'summary-skipped',layer:'summary',reason:'summary_budget'},
      {id:'unrelated-memory',layer:'memory',reason:'no_cue'},{id:'weak-memory',layer:'memory',reason:'below_threshold'},
      {id:'invalidated-memory',layer:'memory',reason:'hard_gate'},{id:'large-memory',layer:'memory',reason:'memory_budget'},
      {layer:'current_emotion',reason:'current_emotion_budget'},{layer:'historical_emotion',reason:'historical_emotion_budget'}],unreadRecent:true};
}
