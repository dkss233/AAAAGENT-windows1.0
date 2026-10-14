import test from 'node:test';import assert from 'node:assert/strict';import {app} from './ui-harness.mjs';
const request=(id,phase)=>({id,version:1,phase,text:'合成任务 '+id,plan:{title:'合成任务 '+id},executor:'codex',confirmedAt:phase==='awaiting_confirmation'?undefined:'2026-09-15T00:00:00Z',createdAt:''});
const rows=[request('pending','awaiting_confirmation'),request('running','accepted'),request('done','completed'),request('unknown','unknown'),request('failed','unavailable')];
const snapshot=(sequence,extra={})=>({sequence,stage:'idle',focus:'work',pendingCount:2,requests:rows,...extra});
const state=(a,s)=>a.bridge.receive({channel:'work_state',state:s},1);
const actions=a=>a.wire().map(m=>m.value.message).filter(m=>m.channel==='work_action');
async function setup(extra={}){const a=await app({explicitRouting:true});a.changed(1);await a.ready();await state(a,snapshot(1,extra));return a;}
test('idle background badge goes directly to records without a focus command or empty chat card',async()=>{
 const a=await setup(),before=actions(a).length;a.node('work-badge').onclick();assert.equal(a.node('work-records-dialog').open,true);assert.equal(a.node('drawer').hidden,false);assert.equal(a.node('work-card').hidden,true);assert.equal(a.node('work-card').textContent,'');assert.equal(actions(a).length,before);assert.equal(a.node('work-badge')['aria-controls'],'work-records-dialog');
 for(const label of ['待确认','等待结果','已完成','结果待核实','本次未完成'])assert.ok(a.node('work-records-content').textContent.includes(label));
 assert.equal(a.node('reply').textContent,'');a.node('work-records-close').onclick();assert.equal(a.document.activeElement.id,'work-badge');
 assert.equal(a.node('work-actions').children.length,1);a.node('work-records-open').onclick();assert.equal(a.node('work-records-dialog').open,true);assert.equal(actions(a).length,before);
});
test('valid confirmation and clarification keep their processing path and confirmation is never automatic',async()=>{
 for(const stage of ['confirming','clarifying']){const draft={id:'d',version:1,text:'合成请求',question:'需要哪一天？',projects:[],targets:[]},a=await setup({stage,draft,...(stage==='confirming'?{confirmation:rows[0]}:{})});a.node('work-badge').onclick();assert.equal(a.node('work-card').hidden,false);assert.ok(!a.node('work-records-dialog').open);assert.equal(actions(a).at(-1).action.type,'focus');assert.equal(actions(a).some(m=>m.action.type==='confirm'),false);}
});
test('refresh shows pending and received counts, preserves selection, and does not dispatch work',async()=>{
 const a=await setup();a.node('work-badge').onclick();const before=actions(a).length;a.node('work-records-refresh').onclick();assert.match(a.node('work-records-feedback').textContent,/正在/);assert.deepEqual(JSON.parse(JSON.stringify(actions(a).at(-1).action)),{type:'refresh'});
 await state(a,snapshot(2));assert.match(a.node('work-records-feedback').textContent,/已收到更新/);assert.match(a.node('work-records-feedback').textContent,/5 条/);assert.equal(actions(a).length,before+1);
 a.node('work-record-refresh-unknown').onclick();assert.deepEqual(JSON.parse(JSON.stringify(actions(a).at(-1).action)),{type:'refresh',id:'unknown'});await state(a,snapshot(3,{requests:[]}));assert.match(a.node('work-records-content').textContent,/有 2 项任务状态待核对/);assert.match(a.node('work-records-feedback').textContent,/0 条/);assert.ok(!actions(a).some(m=>['focus','confirm','select','replan'].includes(m.action.type)));
 a.node('work-records-refresh').onclick();const timer=[...a.timers.values()].at(-1);timer();assert.match(a.node('work-records-feedback').textContent,/暂未收到更新/);assert.equal(a.node('work-records-refresh').disabled,false);
 a.changed(1,'disconnected');assert.equal(a.node('work-records-dialog').open,false);assert.equal(a.node('work-records-content').textContent,'');
});

test('confirmed unknown counts say pending verification rather than running; missing rows remain explicit',async()=>{
 const a=await setup({requests:[request('u1','unknown'),request('u2','unknown')]});assert.match(a.node('work-badge').textContent,/待核对 2 项/);assert.doesNotMatch(a.node('work-badge').textContent,/后台|等待结果/);a.node('work-badge').onclick();assert.match(a.node('work-records-feedback').textContent,/待核对 2 项/);
 await state(a,snapshot(2,{requests:[request('u1','unknown'),request('running','accepted')]}));assert.match(a.node('work-badge').textContent,/等待结果 1 项.*待核对 1 项/);
 await state(a,snapshot(3,{requests:[]}));assert.match(a.node('work-badge').textContent,/2 项状态待核对/);assert.doesNotMatch(a.node('work-badge').textContent,/等待结果/);
});
