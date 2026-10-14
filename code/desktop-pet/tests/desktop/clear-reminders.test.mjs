import test from 'node:test';import assert from 'node:assert/strict';import {app} from './ui-harness.mjs';
const row=(id,extra={})=>({id,version:2,phase:'unknown',confirmedAt:'2026-09-15T00:00:00Z',text:'合成任务 '+id,createdAt:'',...extra});
const rows=[row('a'),row('b'),row('done',{phase:'completed'}),row('unconfirmed',{phase:'awaiting_confirmation',confirmedAt:undefined}),row('cleared',{reminderCleared:true})];
const snapshot=(sequence,extra={})=>({sequence,stage:'idle',focus:'companion',requests:rows,pendingCount:2,...extra});
const receive=(a,s)=>a.bridge.receive({channel:'work_state',state:s},1);
const actions=a=>a.wire().map(w=>w.value.message).filter(m=>m.channel==='work_action').map(m=>JSON.parse(JSON.stringify(m.action)));
async function setup(){const a=await app({explicitRouting:true});a.changed(1);await a.ready();await receive(a,snapshot(1));a.node('work-badge').onclick();return a;}
test('one click clears only the exact current confirmed unknown set, with no optimistic success or extra confirmation',async()=>{
 const a=await setup();a.node('work-reminders-clear').onclick();assert.deepEqual(actions(a),[{type:'clear_unknown_reminders',records:[{id:'a',expectedVersion:2},{id:'b',expectedVersion:2}]}]);assert.match(a.node('work-badge').textContent,/待核对 2 项/);assert.match(a.node('work-reminder-feedback').textContent,/等待/);a.node('work-reminders-clear').onclick();assert.equal(actions(a).length,1);
 await receive(a,snapshot(2,{requests:rows.map(r=>r.phase==='unknown'?{...r,version:3,reminderCleared:true}:r),pendingCount:0,reminderFeedback:'已清除 2 项待核对提醒，记录保留。'}));assert.equal(a.node('work-badge').hidden,true);assert.match(a.node('work-reminder-feedback').textContent,/已清除 2 项/);assert.match(a.node('work-records-content').textContent,/提醒已清除/);assert.match(a.node('work-record-a').textContent,/结果待核实/);assert.equal(a.node('work-reminders-clear').disabled,true);
 a.node('work-records-close').onclick();a.node('close').onclick();a.node('open').onclick();a.node('work-records-open').onclick();assert.equal(a.node('work-records-dialog').open,true);assert.match(a.node('work-record-a').textContent,/合成任务 a/);assert.equal(actions(a).length,1);
});
test('single clear revalidates the latest snapshot and leaves other work and current confirmation visible',async()=>{
 const a=await setup(),stale=a.node('work-reminder-clear-a').onclick;await receive(a,snapshot(2,{requests:[row('a',{version:3,phase:'completed'}),row('b')],pendingCount:1}));stale();assert.equal(actions(a).length,0);
 a.node('work-reminder-clear-b').onclick();assert.deepEqual(actions(a)[0],{type:'clear_unknown_reminders',records:[{id:'b',expectedVersion:2}]});
 const draft={id:'d',version:1,text:'有效当前安排',targets:[],projects:[]},confirmation=row('current',{phase:'awaiting_confirmation',confirmedAt:undefined});
 await receive(a,snapshot(3,{stage:'confirming',draft,confirmation,requests:[row('b',{reminderCleared:true}),row('running',{phase:'accepted'})],pendingCount:1,reminderFeedback:'提醒已清除。'}));assert.equal(a.node('work-badge').hidden,false);assert.match(a.node('work-badge').textContent,/等待结果 1 项/);
 a.node('work-records-close').onclick();a.node('work-badge').onclick();assert.equal(a.node('work-confirm').disabled,false);assert.equal(actions(a).some(x=>x.type==='confirm'),false);
});
test('newer unrelated snapshots are not clear success; timeout/disconnect restore controls without inventing clearing',async()=>{
 const a=await setup();a.node('work-reminders-clear').onclick();await receive(a,snapshot(2));assert.match(a.node('work-reminder-feedback').textContent,/等待/);assert.match(a.node('work-badge').textContent,/待核对 2 项/);[...a.timers.values()].at(-1)();assert.match(a.node('work-reminder-feedback').textContent,/暂未确认/);assert.equal(a.node('work-reminders-clear').disabled,false);
 a.node('work-reminders-clear').onclick();a.changed(1,'disconnected');assert.equal(a.node('work-records-dialog').open,false);assert.equal(a.node('work-records-content').textContent,'');
});
test('a simulated ASR control result snapshot clears reminders without hiding a later real result or new task',async()=>{
 const a=await setup();await receive(a,snapshot(2,{requests:rows.map(r=>r.phase==='unknown'?{...r,reminderCleared:true}:r),pendingCount:0,reminderFeedback:'已清除待核对提醒。'}));assert.equal(actions(a).length,0);assert.equal(a.node('work-badge').hidden,true);assert.match(a.node('work-reminder-feedback').textContent,/已清除/);
 await receive(a,snapshot(3,{stage:'completed',activeRequestId:'a',requests:[row('a',{version:3,phase:'completed',reminderCleared:false,result:'合成新回执'})],pendingCount:0}));assert.equal(a.node('work-badge').hidden,false);assert.match(a.node('work-badge').textContent,/已完成/);assert.match(a.node('work-record-a').textContent,/合成新回执/);
 await receive(a,snapshot(4,{requests:[row('new')],pendingCount:1}));assert.equal(a.node('work-badge').hidden,false);assert.match(a.node('work-badge').textContent,/待核对 1 项/);
});
test('a version-only unknown update cannot reuse a previous clearing success',async()=>{
 const a=await setup();await receive(a,snapshot(2,{reminderFeedback:'已清除 2 项待核对提醒，记录保留。'}));a.node('work-reminders-clear').onclick();assert.match(a.node('work-reminder-feedback').textContent,/等待/);
 const changed=rows.map(r=>r.id==='a'||r.id==='b'?{...r,version:3}:r);await receive(a,snapshot(3,{requests:changed,reminderFeedback:'已清除 2 项待核对提醒，记录保留。'}));assert.match(a.node('work-reminder-feedback').textContent,/记录已变化/);assert.doesNotMatch(a.node('work-reminder-feedback').textContent,/已清除/);assert.match(a.node('work-badge').textContent,/待核对 2 项/);
 await receive(a,snapshot(4,{requests:changed,reminderFeedback:'已清除 2 项待核对提醒，记录保留。'}));assert.doesNotMatch(a.node('work-reminder-feedback').textContent,/已清除/);
 a.node('work-reminders-clear').onclick();await receive(a,snapshot(5,{requests:changed,reminderFeedback:'清除未完成，请刷新后重试。'}));assert.match(a.node('work-reminder-feedback').textContent,/清除未完成/);assert.equal(a.node('work-reminders-clear').disabled,false);
});
