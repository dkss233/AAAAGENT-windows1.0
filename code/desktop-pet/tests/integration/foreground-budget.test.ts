import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture as settingsFixture} from '../management/helpers.js';
import {fixture,scope,message,change,NOW} from '../memory/sqlite-fixture.js';
import {none,summaryProposal,signal} from '../memory/lifecycle-fixture.js';
import {ManagementSettingsStore} from '../../management/settings-store.js';
import {defaultManagedSettings,effectiveTrialConfiguration} from '../../management/settings.js';
import {SqliteLifecycleMemoryPort} from '../../memory/sqlite-lifecycle-port.js';
import {SqliteManagementMemoryPort} from '../../memory/management-port.js';
import {deepseekFlashModel} from '../../providers/text-protocol.js';
import {JsonDialogueProvider} from '../../providers/qwen-dialogue.js';
import {TrialTransport} from '../../app/trial-backend.js';
import {inputBudgetInfo,countRequestInput} from '../../providers/input-count.js';

test('B01–B09 combined real isolated SQLite/config reopening/provider wire/public UI DTO and retained privacy holds',async t=>{
 const sf=await settingsFixture(t),df=fixture(undefined,'foreground-budget-55');t.after(df.cleanup);
 const store=df.open(),old=deepseekFlashModel(sf.c.models.memory_turn.credentialFile);
 const base={...sf.c,models:{...sf.c.models,dialogue:old,summary:old,admission:old}};
 const settingsFile=join(sf.c.projectRoot,'integration-settings.json'),legacy=defaultManagedSettings(base);
 delete legacy.context.targetInputTokens;delete legacy.context.currentEmotionReserveTokens;
 Object.assign(legacy.providers.dialogue,{inputTokenLimit:32768,reservationMicros:3211264});delete (legacy.providers.dialogue as {contextWindowTokens?:number}).contextWindowTokens;
 legacy.context.maxRecentMessages=24;legacy.context.maxMemories=6;
 await writeFile(settingsFile,JSON.stringify({version:1,current:{revision:1,savedAt:NOW,settings:legacy},history:[]}));
 const settings=await ManagementSettingsStore.open(settingsFile,base),effective=effectiveTrialConfiguration(base,settings.effective);
 const ledgerBefore=await readFile(base.budgetFile),model=effective.models.dialogue;
 let actualWire:Record<string,unknown>|undefined,posts=0;
 const transport=new TrialTransport(effective,async(_url,init)=>{
  posts++;actualWire=JSON.parse(String(init?.body));
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'收到你的问题。',expression:{emotion:'neutral',intensity:.4,delivery:'自然',gesture:null}})}}],usage:{prompt_tokens:100,completion_tokens:10}});
 });
 const endpoint={model:model.model,endpoint:model.endpoint,apiKey:()=> 'fixture-only',authorizer:{authorize:async()=>({settle:async()=>{}})}};
 const dialogue=new JsonDialogueProvider(endpoint,transport,()=>({presets:[]}),()=>({iso:NOW,timeZone:'Asia/Shanghai',localDateTime:'2026年9月6日 20:00:00'}),{outputTokenLimit:model.outputTokenLimit});
 const budget=inputBudgetInfo(model,settings.effective.context.targetInputTokens);
 const port=new SqliteLifecycleMemoryPort(store,{
  context:{inputTokenBudget:budget.effectiveInputTokens,budgetInfo:budget,currentEmotionReserveTokens:512,maxRecentMessages:24,maxMemories:6,summaryLimit:8,countTokens:dialogue.countContext.bind(dialogue),relevance:()=>1},
  turn:{readLimits:{maxRecentMessages:24,maxMemories:6,summaryLimit:8},inputTokenBudget:32768,countTokens:i=>Buffer.byteLength(JSON.stringify(i)),provider:{plan:async i=>none(i)}},
  summary:{inputTokenBudget:32768,minMessages:12,maxMessages:24,countTokens:i=>Buffer.byteLength(JSON.stringify(i)),provider:{summarize:async i=>summaryProposal(i)}}
 });
 // Seed completed history through the real issued-context/assistant storage path.
 for(let i=0;i<35;i++){
  const owned=scope('companion','seed'+i),text='红茶话题 '+i;
  await port.append(owned,[message(owned.turnId+':user',text)]);
  const c=await port.foregroundContext(owned,owned.turnId+':user',text,null,signal());
  await port.appendAssistant(owned,{...message(owned.turnId+':assistant','关于红茶的回复 '+i),role:'assistant'},c,owned.turnId+':user',signal());
 }
 for(let i=0;i<12;i++)store.apply(change({type:'add',id:'tea'+i,text:'红茶重要线索 '+i,sourceIds:['seed0:user']},'add'+i));
 store.apply(change({type:'add',id:'unrelated',text:'钢琴练习',sourceIds:['seed1:user']},'add-other'));
 for(let i=0;i<15;i++)store.recordDerived(scope(),{id:'summary'+i,kind:'summary',text:'红茶会话总结 '+i,sourceIds:['seed0:user'],createdAt:NOW});
 const owned=scope('companion','final'),text='红茶',pending={scope:owned,request:'none' as const,status:'pending' as const};
 await port.append(owned,[message('final:user',text)]);dialogue.prepare({scope:owned,text,memoryPending:pending});
 const ctx=await port.foregroundContext(owned,'final:user',text,null,signal());
 assert.equal(ctx.recent.length,70);assert.equal(ctx.memories.length,12);assert.equal(ctx.contextBudget!.selected.summaries,15);
 assert.ok(!ctx.recent.some(m=>m.id==='final:user'));assert.ok(!ctx.memories.some(m=>m.id==='unrelated'));
 const reply=await dialogue.reply({scope:owned,text,context:ctx,memoryPending:pending},signal());
 assert.equal(posts,1);assert.equal(countRequestInput(actualWire!),ctx.contextBudget!.countedInputTokens);
 assert.equal(Object.values(ctx.contextBudget!.layers).reduce((a,b)=>a+b,0),ctx.contextBudget!.countedInputTokens);
 const data=JSON.parse((actualWire!.messages as {content:string}[]).at(-1)!.content);
 assert.equal(data.currentMessage,text);assert.ok(!data.history.some((m:{text:string})=>m.text===text));
 await port.appendAssistant(owned,{...message('final:assistant',reply.text),role:'assistant'},ctx,'final:user',signal());
 const trace=store.recall.traces({characterId:'companion',offset:0,limit:1}).records[0]!;
 assert.equal(trace.status,'consumed');assert.deepEqual(trace.contextBudget,ctx.contextBudget);
 // Load browser validators without rendering or opening a browser.
 Object.assign(globalThis,{document:{addEventListener:()=>{}},window:{addEventListener:()=>{}}});
 const ui=await import(new URL('../../../management/ui/context-budget-view.mjs',import.meta.url).href);
 assert.equal(ui.validBudgetReport(trace.contextBudget),true);assert.equal(ui.validBudgetInfo(settings.snapshot().effectiveBudget),true);
 const preview=await new SqliteManagementMemoryPort(store,port).context('companion','红茶');
 assert.ok(preview.contextBudget);assert.equal(ui.validBudgetReport(preview.contextBudget),true);
 assert.equal(preview.memories.length,12);
 // A durable failed hold still excludes all earlier facts under the new capacity.
 const held=scope('companion','hold');await port.append(held,[message('hold:user','忘掉旧话题')]);port.beginPendingMutation(held,'hold:user',{request:'forget',sources:null});store.pending.fail(held,'hold:user');
 const holds=JSON.stringify(store.pending.list('companion'));
 const fresh=scope('companion','fresh');await port.append(fresh,[message('fresh:user','无关的新问题')]);
 const safe=await port.foregroundContext(fresh,'fresh:user','无关的新问题',null,signal());assert.deepEqual(safe.memories,[]);assert.equal(safe.summary,'');assert.deepEqual(safe.recent,[]);
 assert.equal(JSON.stringify(store.pending.list('companion')),holds);assert.throws(()=>port.assertContextCurrent(ctx),/stale_context/);
 assert.deepEqual(await readFile(base.budgetFile),ledgerBefore); // No real authorizer/ledger mutation.
});
