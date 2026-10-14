import test from 'node:test';
import assert from 'node:assert/strict';
import type { DialogueContext, TurnScope } from '../../contracts/index.js';
import type { EndpointConfig } from '../../providers/transport.js';
import { JsonDialogueProvider } from '../../providers/qwen-dialogue.js';
import { TrialTransport } from '../../app/trial-backend.js';
import { countRequestInput,inputBudgetInfo,dialogueReservation } from '../../providers/input-count.js';
import { deepseekFlashDialogueModel } from '../../providers/text-protocol.js';
import { fixture } from '../management/helpers.js';
const scope:TurnScope={characterId:'friend',sessionId:'budget-session',turnId:'budget-turn',generation:1};
const context=():DialogueContext=>({scope,characterPrompt:'角色说明',recent:[],summary:'摘要',memories:[],perception:null,inputTokenBudget:200000});

test('B04 frozen whole wire count equals sent Chinese/visual/clock/pending/protocol request',async t=>{
 const f=await fixture(t),model=deepseekFlashDialogueModel(f.c.models.memory_turn.credentialFile);
 const c={...f.c,models:{...f.c.models,dialogue:{...model,targetInputTokens:200000}}};
 let body:Record<string,unknown>|undefined,clockReads=0,visualReads=0;
 const transport=new TrialTransport(c,async(_url,init)=>{
   body=JSON.parse(String(init?.body));return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'已收到',expression:{emotion:'neutral',intensity:.5,delivery:'温和',gesture:null}})}}],usage:{prompt_tokens:123,completion_tokens:5}});
 },undefined,.7);
 const config:EndpointConfig={model:model.model,endpoint:model.endpoint,apiKey:()=> 'controlled-key',authorizer:{authorize:async()=>({settle:async()=>{}})}};
 const provider=new JsonDialogueProvider(config,transport,()=>{visualReads++;return {presets:[{id:'calm',label:'本轮白名单'}]};},()=>{clockReads++;return {iso:'2026-10-03T12:00:00.000Z',timeZone:'Asia/Shanghai',localDateTime:'2026年10月3日 20:00:00'};},{outputTokenLimit:model.outputTokenLimit,temperature:.7});
 const text='中文多字节'.repeat(5000),pending={scope,request:'none' as const,status:'pending' as const};
 provider.prepare({scope,text,memoryPending:pending});
 const background={user:{subject:'user' as const,revision:1,observation:{subject:'user' as const,label:'本轮情绪背景',intensity:.5,confidence:.8,provenance:'user_explicit' as const,sources:[{id:'older',version:1}]},updatedAt:'2026-10-03T12:00:00Z',sourceMessage:{id:'older',version:1},logicalOrder:1,sessionId:scope.sessionId},companion:{subject:'companion' as const,revision:0,observation:null,updatedAt:null,sourceMessage:null,logicalOrder:null,sessionId:null}};
 const ctx:DialogueContext={...context(),emotionBackground:background,perception:{scope,transcript:'当前感知文字',emotion:'happy',modalities:[],cues:[],status:'complete'},recent:[{id:'older',characterId:'friend',role:'user',text:'历史情绪事实',createdAt:'2026-10-03T12:00:00Z',emotionSnapshot:{role:'user',message:{id:'older',version:1},scope,logicalOrder:1,recordedAt:'2026-10-03T12:00:00Z',observations:[background.user.observation],background}}]},counted=provider.countContext(ctx,text);
 assert.ok(counted>32768);assert.ok(counted<200000);
 assert.ok(provider.countContext({...ctx,summary:ctx.summary+' extra'},text)>counted);
 assert.equal(clockReads,1);assert.equal(visualReads,1);
 await provider.reply({scope,text,context:ctx,memoryPending:pending},new AbortController().signal);
 assert.equal(clockReads,1);assert.equal(countRequestInput(body!),counted);
 const wire=JSON.stringify(body);for(const part of ['本轮白名单','2026年10月3日','后台处理状态','本轮情绪背景','当前感知文字','历史情绪事实','emotionSnapshot'])assert.ok(wire.includes(part));assert.equal(body!.max_tokens,393216);assert.equal(body!.temperature,.7);
 assert.equal(provider.countContext({...ctx,contextBudget:{arbitrary:'diagnostic-only'} as never},text),counted);
});

test('B05 API input, shared window, target and output reserve constrain capacity and cost',()=>{
 const model=deepseekFlashDialogueModel('/outside/key');
 assert.equal(inputBudgetInfo(model).effectiveInputTokens,200000);assert.equal(dialogueReservation(model),3545728);
 assert.equal(inputBudgetInfo({...model,inputTokenLimit:40000}).effectiveInputTokens,40000);
 const constrained=inputBudgetInfo(model,900000);assert.equal(constrained.effectiveInputTokens,655360);assert.deepEqual(constrained.constrainedBy,['context_window']);
 assert.equal(dialogueReservation(model,400000),3945728);
 assert.throws(()=>inputBudgetInfo({...model,outputTokenLimit:1048576}),/invalid_context_budget/);
});

test('B04 oversized required request rejects before key access or fake transport',async()=>{
 const provider=new JsonDialogueProvider({model:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions',apiKey:()=>{throw Error('must not read key');},authorizer:{authorize:async()=>{throw Error('must not authorize');}}});
 await assert.rejects(provider.reply({scope,text:'问题',context:{...context(),inputTokenBudget:1}},new AbortController().signal),/required_context_exceeds_budget/);
});
