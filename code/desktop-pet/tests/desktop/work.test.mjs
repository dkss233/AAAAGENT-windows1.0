import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
const scope={characterId:'companion',sessionId:'s1',turnId:'t1',generation:1};
const expression={emotion:'warm',intensity:.5,gesture:null,delivery:''};
const draft={id:'d1',version:1,text:'合成工程正文',projects:[{id:'p1',version:3,name:'合成项目',abstract:'测试',detailRef:{rootPath:'/synthetic'}}],targets:[{threadId:'task1',hostId:'local',title:'既有任务',projectPath:'/synthetic'}]};
const confirmation={id:'r1',version:2,phase:'awaiting_confirmation',text:draft.text,target:{threadId:'task1',hostId:'local'},createdAt:''};
const state=(sequence,stage='confirming',extra={})=>({sequence,focus:'work',stage,draft,confirmation,requests:[],...extra});
const event=(a,event)=>a.bridge.receive({channel:'event',event},1);
const route=(a,route,which=scope)=>a.bridge.receive({channel:'input_route',scope:which,route},1);
const work=(a,s)=>a.bridge.receive({channel:'work_state',state:s},1);
const submit=(a,text=draft.text)=>{a.node('text').value=text;a.node('form').onsubmit({preventDefault(){}});};
const turn=(a,kind='text',which=scope)=>event(a,{type:'turn',input:{kind,scope:which,startedAt:''}});
async function ready(){const a=await app({explicitRouting:true});a.changed(1);await a.ready();return a;}
const actions=a=>a.wire().map(m=>m.value.message).filter(m=>m.channel==='work_action').map(m=>m.action);
test('engineering input is visible immediately while confirmation sends id/version once',async()=>{
 const a=await ready();submit(a);assert.match(a.node('reply').textContent,/合成工程正文/);await turn(a);assert.match(a.node('reply').textContent,/合成工程正文/);
 await work(a,state(1));await route(a,'work');assert.equal(a.node('work-card').hidden,false);assert.match(a.node('work-confirm-body').textContent,/合成工程正文/);assert.match(a.node('reply').textContent,/合成工程正文/);
 a.node('work-confirm').onclick();a.node('work-confirm').onclick();assert.deepEqual(JSON.parse(JSON.stringify(actions(a))),[{type:'confirm',id:'r1',expectedVersion:2}]);assert.equal(a.harness.captureOpens,0);assert.equal(a.harness.playOpens,0);
});
test('ordinary text is shown once and late routes cannot duplicate canceled input',async()=>{
 const a=await ready();submit(a,'合成闲聊');await turn(a);await route(a,'companion');await route(a,'companion');assert.equal(a.node('reply').children.length,1);assert.match(a.node('reply').textContent,/合成闲聊/);
 submit(a,'不应显示');const next={...scope,turnId:'t2',generation:2};await turn(a,'text',next);a.node('stop').onclick();await route(a,'companion',next);assert.equal(a.node('reply').children.length,2);assert.match(a.node('reply').textContent,/不应显示/);
});
test('ASR original input is shown once in either route order for both destinations',async()=>{
 for(const order of ['route-first','transcript-first'])for(const destination of ['work','companion']){
  const a=await ready();a.node('voice').onclick();await turn(a,'voice');
  if(order==='route-first')await route(a,destination);
  await event(a,{type:'transcript',scope,text:'合成语音原文'});
  if(order==='transcript-first'){assert.match(a.node('reply').textContent,/合成语音原文/);await route(a,destination);}
  assert.match(a.node('reply').textContent,/合成语音原文/);assert.equal(a.node('reply').children.length,1);
 }
});
test('replanning clarification sends no execution and stale snapshots cannot regress card',async()=>{
 const a=await ready();submit(a);await turn(a);await route(a,'work');await work(a,state(4,'clarifying',{confirmation:undefined,draft:{...draft,question:'希望整理哪个项目？'}}));a.node('work-clarify-text').value='整理演示项目';a.node('work-replan').onclick();
 assert.deepEqual(JSON.parse(JSON.stringify(actions(a)[0])),{type:'replan',draftId:'d1',expectedVersion:1,text:'整理演示项目'});
 await work(a,state(5,'working'));await work(a,state(4,'failed'));assert.equal(a.node('work-badge').textContent.trim(),'已接收 · 等待结果');
});
test('new chat input and Space collapse work; old receipts leave only marker and never cancel engineering',async()=>{
 const a=await ready();submit(a);await turn(a);await route(a,'work');await work(a,state(1,'working'));
 a.node('text').value='继续聊天';a.node('text').oninput();assert.equal(a.node('work-card').hidden,true);await work(a,state(2,'working'));assert.equal(a.node('work-card').hidden,true);assert.equal(a.node('work-badge').hidden,false);
 a.bridge.hotkeyConfig('Space');a.bridge.hotkeyEvent({type:'down',code:'Space',repeat:false});assert.equal(a.node('work-card').hidden,true);assert.deepEqual(actions(a),[]);
});
test('dismiss is not engineering cancellation; completion result is separate, reconnect sends nothing',async()=>{
 const a=await ready();submit(a);await turn(a);await route(a,'work');await work(a,state(1));a.node('work-dismiss').onclick();assert.equal(actions(a)[0].type,'dismiss');
 await work(a,state(2,'completed',{draft:undefined,confirmation:undefined,requests:[{...confirmation,version:3,phase:'completed',result:'合成工程结果'}]}));
 a.node('work-badge').onclick();assert.doesNotMatch(a.node('work-card').textContent,/合成工程结果/);assert.match(a.node('work-records-content').textContent,/合成工程结果/);assert.doesNotMatch(a.node('reply').textContent,/合成工程结果/);assert.equal(a.harness.playOpens,0);
 const count=actions(a).length;a.changed(1,'disconnected');a.changed(2);await a.ready(2,'s2');assert.equal(actions(a).length,count);assert.equal(a.node('work-badge').hidden,true);
 await a.bridge.receive({channel:'work_state',state:state(99,'working')},1);assert.equal(a.node('work-badge').hidden,true);
});
test('cancel before text acknowledgement rejects the old client token and binds the immediate retry',async()=>{
 const a=await ready();submit(a,'取消的文本');const first=a.wire().at(-1).value.message.command.clientRequestId;a.node('stop').onclick();submit(a,'当前文本');const second=a.wire().at(-1).value.message.command.clientRequestId;
 await event(a,{type:'turn',input:{kind:'text',scope,startedAt:'',clientRequestId:first}});await route(a,'companion');assert.equal(a.node('reply').children.length,2);
 const next={...scope,turnId:'next',generation:3};await event(a,{type:'turn',input:{kind:'text',scope:next,startedAt:'',clientRequestId:second}});await route(a,'companion',next);assert.match(a.node('reply').textContent,/当前文本/);assert.equal(a.node('reply').children.length,2);
});
test('typing during classification retains companion focus when the old work route arrives',async()=>{
 const a=await ready();submit(a);await turn(a);a.node('text').value='下一句话';a.node('text').oninput();await work(a,state(1,'selecting',{confirmation:undefined}));await route(a,'work');assert.equal(a.node('work-card').hidden,true);assert.equal(a.node('work-badge').hidden,false);
});
test('total background count remains visible even when all ten displayed records are terminal',async()=>{
 const a=await ready();await work(a,state(1,'idle',{focus:'companion',draft:undefined,confirmation:undefined,requests:[],pendingCount:12}));assert.equal(a.node('work-badge').hidden,false);assert.match(a.node('work-badge').textContent,/12 项状态待核对/);
});
test('required route handshake refuses old backend; unrouted audio is cleared without opening playback',async()=>{
 const a=await app({explicitRouting:true});a.changed(1);await a.bridge.receive({channel:'backend_ready',bridgeVersion:'0.2.0',characterId:'companion',sessionId:'s1'},1);assert.match(a.node('status').textContent,/版本不一致/);
 const b=await ready();submit(b);await turn(b);const play={channel:'play',requestId:'unrouted',tts:{scope},audioBase64:'AQI='};await b.bridge.receive(play,1);assert.equal(play.audioBase64,'');assert.equal(b.harness.playOpens,0);
});
test('explicit unsent owner failure allows a new manual confirmation; sending/unknown never enables resend',async()=>{
 const a=await ready();submit(a);await turn(a);await route(a,'work');await work(a,state(1,'confirming',{draft:undefined}));a.node('work-confirm').onclick();const click=a.node('work-confirm').onclick;
 await work(a,state(2,'sending',{draft:undefined,confirmation:undefined}));click();await work(a,state(3,'unknown',{draft:undefined,confirmation:undefined}));click();assert.equal(actions(a).filter(x=>x.type==='confirm').length,1);
 await work(a,state(4,'confirming',{draft:undefined,confirmation,detail:'目标尚未连接，没有发送'}));assert.equal(a.node('work-confirm').disabled,false);a.node('work-confirm').onclick();assert.equal(actions(a).filter(x=>x.type==='confirm').length,2);
});
test('completed receipt is visible above other background counts without taking companion focus',async()=>{
 const a=await ready();await work(a,state(1,'completed',{focus:'companion',pendingCount:4,draft:undefined,confirmation:undefined}));assert.match(a.node('work-badge').textContent,/已完成.*4 项状态待核对/);assert.equal(a.node('work-badge').dataset.focused,'false');assert.equal(a.node('work-card').hidden,true);
});
test('confirmation uses frozen title, then exact known target fallback, otherwise an explicit unknown name',async()=>{
 const a=await ready();submit(a);await turn(a);await route(a,'work');await work(a,state(1,'selecting',{confirmation:undefined}));assert.equal(a.node('drawer').dataset.workOpen,'true');
 await work(a,state(2,'confirming',{draft:undefined,confirmation:{...confirmation,target:{...confirmation.target,title:'已核验的任务标题'}}}));assert.match(a.node('work-card').textContent,/任务：已核验的任务标题/);
 await work(a,state(3,'confirming',{draft:undefined,confirmation}));assert.match(a.node('work-card').textContent,/任务：既有任务/);
 await work(a,state(4,'confirming',{draft:undefined,confirmation:{...confirmation,target:{threadId:'missing',hostId:'local'}}}));assert.match(a.node('work-card').textContent,/任务：任务名称暂不可用/);
 a.node('text').oninput();assert.equal(a.node('drawer').dataset.workOpen,'false');
});

const descendants=n=>[n,...(n.children??[]).flatMap(c=>typeof c==='object'?descendants(c):[])];
const exists=(a,id)=>[...descendants(a.node('work-card')),...descendants(a.node('work-actions'))].some(n=>n.id===id);
const plain=x=>JSON.parse(JSON.stringify(x));
async function card(extra={}){const a=await ready();submit(a);await turn(a);await route(a,'work');await work(a,state(1,'confirming',extra));return a;}
test('complete cards have one confirmation and no editing controls until requested',async()=>{
 for(const executor of ['codex','harness']){
  const c={...confirmation,executor,target:executor==='codex'?{...confirmation.target,title:'冻结的任务名'}:undefined,project:draft.projects[0],plan:{title:'整理项目说明',reason:'依据请求范围选择执行者'}};
  const a=await card({confirmation:c});assert.match(a.node('work-card').textContent,executor==='harness'?/执行者：DeepSeek Harness/:/执行者：Codex/);
  assert.equal(exists(a,'work-target'),false);assert.equal(exists(a,'work-project'),false);assert.equal(exists(a,'work-text'),false);assert.equal(exists(a,'work-select'),false);
  assert.equal(descendants(a.node('work-actions')).filter(n=>n.id==='work-confirm').length,1);assert.equal(a.node('work-confirm-body').textContent,c.text);
  if(executor==='harness')assert.doesNotMatch(a.node('work-card').textContent,/任务名称暂不可用|任务：/);
  a.node('work-confirm').onclick();assert.deepEqual(plain(actions(a)),[{type:'confirm',id:c.id,expectedVersion:c.version}]);
 }
});
test('editing freezes confirmation; save re-prepares only, renewed card requires explicit confirmation',async()=>{
 const c={...confirmation,executor:'codex',project:draft.projects[0]},a=await card({confirmation:c}),oldClick=a.node('work-confirm').onclick;
 a.node('work-edit').onclick();assert.equal(a.node('work-target').value,JSON.stringify(['local','task1']));assert.equal(a.node('work-project').value,JSON.stringify(['p1',3]));assert.equal(a.node('work-text').value,c.text);assert.equal(a.node('work-confirm').disabled,true);
 oldClick();assert.equal(actions(a).length,0);a.node('work-text').value='修改后的正文';a.node('work-text').oninput();a.node('work-save').onclick();oldClick();
 assert.deepEqual(plain(actions(a)),[{type:'reprepare',draftId:'d1',expectedVersion:1,text:'修改后的正文',executor:'codex',target:{threadId:'task1',hostId:'local'},projectId:'p1',projectVersion:3}]);
 const next={...c,id:'r2',version:1,text:'修改后的正文'};await work(a,state(2,'confirming',{draft:{...draft,version:2},confirmation:next}));assert.equal(exists(a,'work-edit-form'),false);oldClick();assert.equal(actions(a).length,1);a.node('work-confirm').onclick();assert.deepEqual(plain(actions(a)[1]),{type:'confirm',id:'r2',expectedVersion:1});
});
test('executor switch preserves native directory project and Harness sends no Codex target',async()=>{
 const project={...draft.projects[0],id:'directory-hash',source:'task_directory'},a=await card({draft:{...draft,projects:[project]},confirmation:{...confirmation,project}});
 a.node('work-edit').onclick();a.node('work-executor').value='harness';a.node('work-executor').onchange();assert.equal(exists(a,'work-target'),false);assert.equal(a.node('work-project').value,JSON.stringify([project.id,3]));a.node('work-save').onclick();
 assert.deepEqual(plain(actions(a)[0]),{type:'reprepare',draftId:'d1',expectedVersion:1,text:draft.text,executor:'harness',projectId:'directory-hash',projectVersion:3});
 const b=await card({confirmation:{...confirmation,executor:'harness',target:undefined}});assert.match(b.node('work-card').textContent,/项目：未绑定项目/);b.node('work-edit').onclick();b.node('work-executor').value='codex';b.node('work-executor').onchange();assert.equal(b.node('work-save').disabled,true);b.node('work-save').onclick();assert.equal(actions(b).length,0);
});
test('concurrent update preserves dirty draft but blocks save; cancel exposes latest confirmation',async()=>{
 const a=await card();a.node('work-edit').onclick();a.node('work-text').value='尚未保存的修改';a.node('work-text').oninput();
 await work(a,state(2,'confirming',{draft:{...draft,version:2},confirmation:{...confirmation,version:3,text:'后台新正文'}}));assert.equal(a.node('work-text').value,'尚未保存的修改');assert.equal(a.node('work-save').disabled,true);assert.equal(a.node('work-confirm').disabled,true);a.node('work-save').onclick();assert.equal(actions(a).length,0);
 a.node('work-edit').onclick();assert.equal(exists(a,'work-edit-form'),false);assert.equal(a.node('work-confirm-body').textContent,'后台新正文');a.node('work-confirm').onclick();assert.deepEqual(plain(actions(a)[0]),{type:'confirm',id:'r1',expectedVersion:3});
});

test('confirmed Harness approval shows native session and explicit open action without resending',async()=>{
 const r={...confirmation,executor:'harness',target:undefined,phase:'accepted',confirmedAt:'synthetic',harnessSessionId:'session-synthetic',nativeStatus:'approval'};
 const a=await card({confirmation:undefined,requests:[r]});assert.match(a.node('work-records-content').textContent,/等待在 Harness 中批准/);assert.doesNotMatch(a.node('work-card').textContent,/session-synthetic/);assert.match(a.node('work-records-content').textContent,/session-synthetic/);a.node('work-record-native-r1').onclick();assert.deepEqual(plain(actions(a)),[{type:'open_native',id:'r1'}]);assert.equal(exists(a,'work-confirm'),false);
 const b=await card({confirmation:{...r,phase:'awaiting_confirmation'}});assert.equal(b.node('work-confirm').disabled,true);b.node('work-confirm').onclick();assert.equal(actions(b).length,0);
});

test('only the explicitly active Harness approval changes foreground status and work pose',async()=>{
 const approval={...confirmation,id:'approval',executor:'harness',target:undefined,phase:'accepted',confirmedAt:'synthetic',harnessSessionId:'session-approval',nativeStatus:'approval'},running={...approval,id:'running',harnessSessionId:'session-running',nativeStatus:'working'};
 const a=await card({confirmation:undefined,draft:undefined,activeRequestId:'running',requests:[approval,running]});await work(a,state(2,'working',{confirmation:undefined,draft:undefined,activeRequestId:'running',requests:[approval,running]}));assert.equal(a.node('work-badge').dataset.focused,'true');assert.doesNotMatch(a.node('work-badge').textContent,/批准/);
 await work(a,state(3,'working',{confirmation:undefined,draft:undefined,activeRequestId:'approval',requests:[approval,running]}));assert.equal(a.node('work-badge').dataset.focused,'false');assert.match(a.node('work-badge').textContent,/等待在 Harness 中批准/);assert.ok(exists(a,'work-native-approval'));
 a.node('text').oninput();await work(a,state(4,'working',{focus:'companion',confirmation:undefined,draft:undefined,activeRequestId:'approval',requests:[approval,running],pendingCount:2}));assert.equal(a.node('work-card').hidden,true);assert.match(a.node('work-badge').textContent,/等待结果 2 项/);assert.equal(a.node('work-badge').dataset.focused,'false');
});

test('automatic planning with a draft shows progress only, never an early clarification form',async()=>{
 const a=await card({confirmation:undefined});await work(a,state(2,'classifying',{confirmation:undefined}));assert.match(a.node('work-card').textContent,/正在整理任务/);for(const id of ['work-clarify-text','work-replan','work-project','work-target','work-text','work-confirm'])assert.equal(exists(a,id),false);
});

test('prepared replan sends current draft only and retires old confirmation closures',async()=>{
 const a=await card({confirmation:{...confirmation,text:'旧规划改写后的正文'}}),confirmOld=a.node('work-confirm').onclick,replanOld=a.node('work-replan').onclick;
 assert.equal(a.node('work-confirm').disabled,false);assert.equal(exists(a,'work-target'),false);assert.equal(actions(a).length,0);replanOld();replanOld();confirmOld();assert.deepEqual(plain(actions(a)),[{type:'replan',draftId:'d1',expectedVersion:1,text:draft.text}]);
 // An unrelated newer snapshot of the old card must not re-enable its send.
 await work(a,state(2));confirmOld();replanOld();assert.equal(a.node('work-confirm').disabled,true);assert.equal(actions(a).length,1);
 await work(a,state(3,'classifying',{confirmation:undefined,draft:{...draft,version:2}}));confirmOld();replanOld();assert.equal(exists(a,'work-replan'),false);assert.equal(actions(a).length,1);
 await work(a,state(4,'confirming',{draft:{...draft,version:2},confirmation:{...confirmation,id:'renewed',version:1}}));confirmOld();replanOld();assert.equal(actions(a).length,1);a.node('work-confirm').onclick();assert.deepEqual(plain(actions(a)[1]),{type:'confirm',id:'renewed',expectedVersion:1});
});
test('prepared replan is unavailable for confirmed, uncertain, missing-draft or actively edited cards',async()=>{
 for(const extra of [{draft:undefined},{confirmation:{...confirmation,confirmedAt:'synthetic'}},{confirmation:{...confirmation,phase:'unknown'}}]){const a=await card(extra);assert.equal(exists(a,'work-replan'),false);}
 const a=await card(),replanOld=a.node('work-replan').onclick;a.node('work-edit').onclick();assert.equal(a.node('work-replan').disabled,true);replanOld();assert.equal(actions(a).length,0);a.node('work-edit').onclick();a.node('work-confirm').onclick();replanOld();assert.equal(actions(a).length,1);
});
