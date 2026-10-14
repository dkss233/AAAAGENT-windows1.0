import test from 'node:test';import assert from 'node:assert/strict';import {app} from './ui-harness.mjs';
const scope={characterId:'companion',sessionId:'s1',turnId:'voice',generation:1};
const draft={id:'d',version:1,text:'原始任务输入',projects:[],targets:[]};
const confirmation={id:'current',version:1,phase:'awaiting_confirmation',executor:'harness',text:'当前简明安排',plan:{title:'核对资料',reason:'长安排原因'},createdAt:''};
const old={id:'old',version:2,phase:'completed',executor:'codex',target:{hostId:'local',threadId:'internal-task-id',title:'历史核对'},text:'旧工程全文'.repeat(100),result:'长回执日志'.repeat(100),createdAt:''};
const sourceInput={draftId:'d',scope,text:draft.text,provenance:'original_input',conversation:[{role:'assistant',scope,text:'任务里的澄清问题'},{role:'user',scope,text:'任务里的补充回答'}]};
const snapshot=(sequence,extra={})=>({sequence,stage:'confirming',focus:'work',draft,confirmation,sourceInput,requests:[old],...extra});
const state=(a,s)=>a.bridge.receive({channel:'work_state',state:s},1);
const messages=a=>a.wire().map(m=>m.value.message);
async function setup(shown=true){const a=await app({explicitRouting:true});a.changed(1);await a.ready();await state(a,snapshot(1));if(shown)a.node('work-reopen').onclick();else a.node('open').onclick();return a;}
const escape=a=>a.listeners.get('keydown')({key:'Escape',code:'Escape',preventDefault(){},stopPropagation(){}});
const start=a=>{a.node('voice').onclick();return messages(a).filter(m=>m.command?.type==='start_voice').at(-1).command;};

test('long history, task dialogue, IDs and details exist only in the independent record content',async()=>{
 const a=await setup();assert.match(a.node('work-card').textContent,/当前简明安排/);assert.doesNotMatch(a.node('work-card').textContent,/旧工程全文|长回执日志|internal-task-id|任务里的|长安排原因/);assert.match(a.node('work-records-content').textContent,/旧工程全文/);assert.match(a.node('work-records-content').textContent,/长回执日志/);assert.match(a.node('work-records-content').textContent,/任务里的澄清问题/);assert.match(a.node('reply').textContent,/原始任务输入/);
 const count=messages(a).length;a.node('work-records-open').onclick();assert.equal(a.node('work-records-dialog').open,true);assert.equal(messages(a).length,count);assert.equal(a.node('work-confirm').disabled,false);
});

test('Escape closes only records and restores opening control and chat scroll without cancelling active voice',async()=>{
 const a=await setup();start(a);const origin=a.node('work-records-open');a.node('conversation').scrollTop=38;origin.onclick();assert.equal(a.document.activeElement.id,'work-records-close');a.node('work-records-content').scrollTop=150;a.node('conversation').scrollTop=40;const count=messages(a).length;escape(a);assert.equal(a.node('work-records-dialog').open,false);assert.equal(a.document.activeElement.id,'work-records-open');assert.equal(a.node('conversation').scrollTop,38);assert.equal(a.node('drawer').hidden,false);assert.equal(messages(a).length,count);assert.equal(a.node('voice').textContent,'取消准备');
});

test('browsing records preserves last presented binding and never focuses a historical request',async()=>{
 const a=await setup();const before=messages(a).filter(m=>m.channel==='work_action').length;a.node('work-records-open').onclick();a.node('work-record-old').open=true;a.node('work-records-close').onclick();a.node('work-hide').onclick();const command=start(a);assert.equal(command.workBinding.requestId,'current');assert.equal(messages(a).filter(m=>m.channel==='work_action').length,before);assert.equal(messages(a).some(m=>m.action?.id==='old'&&m.action.type==='focus'),false);const b=await setup();b.node('work-records-open').onclick();b.node('work-record-select-old').onclick();assert.equal(b.node('work-card').hidden,true);assert.equal(messages(b).filter(m=>m.action?.id==='old'&&m.action.type==='focus').length,1);await state(b,snapshot(2,{confirmation:undefined,draft:undefined,activeRequestId:'old',sourceInput:{...sourceInput,draftId:'old-source',text:'准确的旧任务输入'}}));assert.equal(b.node('work-card').hidden,false);assert.match(b.node('reply').textContent,/准确的旧任务输入/);
});

test('a never-shown or newly obscured confirmation cannot become presented by opening records',async()=>{
 for(const shown of [false,true]){const a=await setup(shown);a.node('work-records-open').onclick();await state(a,snapshot(2,{confirmation:{...confirmation,version:2}}));const command=start(a);assert.equal(command.workBinding,undefined);assert.equal(a.node('work-records-dialog').open,true);assert.match(a.node('reply').textContent,shown?/原始任务输入/:/^$/);const b=await setup(shown);b.node('work-records-open').onclick();await state(b,snapshot(2,{confirmation:{...confirmation,version:2}}));b.node('work-records-close').onclick();const next=start(b);if(shown)assert.equal(next.workBinding.requestVersion,2);else assert.equal(next.workBinding,undefined);}
});

test('record refresh stays on the same local record and disconnect closes stale data without sending actions',async()=>{
 const a=await setup();a.node('work-records-open').onclick();a.node('work-record-old').open=true;a.node('work-records-content').scrollTop=90;await state(a,snapshot(2,{requests:[{...old,result:'新的真实状态文本'}]}));assert.equal(a.node('work-record-old').open,true);assert.equal(a.node('work-records-content').scrollTop,90);assert.match(a.node('work-records-content').textContent,/新的真实状态文本/);a.node('work-records-close').onclick();assert.equal(start(a).workBinding.requestId,'current');a.node('work-records-open').onclick();const before=messages(a).length;a.changed(1,'disconnected');assert.equal(a.node('work-records-dialog').open,false);assert.equal(a.node('work-records-content').textContent,'');assert.equal(messages(a).length,before);
});
