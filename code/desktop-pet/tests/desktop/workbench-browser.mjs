// Production desktop HTML/CSS/main with isolated bridge messages; no model, media or Host calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const esbuild=await import(pathToFileURL(process.env.ESBUILD_MODULE)),build=esbuild.build??esbuild.default.build;
const engines=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const output=resolve(process.env.WORKBENCH_UI_OUTPUT);await mkdir(output,{recursive:true});
const temp=await mkdtemp(join(output,'build-'));let server,browser;
const bridgeVersion=(await readFile('contracts/desktop-bridge.ts','utf8')).match(/DESKTOP_BRIDGE_VERSION\s*=\s*'([^']+)'/)[1];
const task={id:'task-a',projectId:'project-a',provider:'codex',origin:'t3',environmentId:'env-a',
 t3ProjectId:'native-a',threadId:'thread-a',providerInstanceId:'codex'};
const taskB={...task,id:'task-b',threadId:'thread-b'};
const legacy={id:'legacy-a',projectId:'project-a',provider:'codex',origin:'legacy_codex_app',
 hostId:'old-host',nativeSessionId:'old-session'};
const original='用户原话：请核对全部资料。'.repeat(20);
const reviewed='审阅正文：只核对现有资料并列出来源。'.repeat(16);
const draft={id:'draft-a',commandId:'command-a',version:1,state:'open',task,
 input:{inputId:'message-a',origin:{channel:'desktop',channelSessionId:'desktop-primary',messageId:'message-a'},
  rawText:original,dispatchText:reviewed,createdAt:'2026-09-27T00:00:00Z'}};
const emptyFocus={version:'0.1.0',revision:0,projectId:null,task:null};
const focus=(revision=2,selected=task)=>({version:'0.1.0',revision,projectId:'project-a',task:selected});
const projects=[{id:'project-a',name:'甲项目'},{id:'project-b',name:'乙项目'}];
const tasks=[{task,projection:{taskId:task.id,sequence:1,eventId:'event-a',phase:'running'}},
 {task:taskB,projection:null},{task:legacy,projection:null}];
const makeState=(sequence,change={})=>({version:'0.1.0',sequence,readAvailable:true,dispatchEnabled:false,
 focus:emptyFocus,projects,projectsTruncated:true,tasks:[],drafts:[],draftsTruncated:false,
 selectedDraftId:null,...change});
const approval={id:'approval-a',taskId:'task-a',answerLifetime:'live_only',version:2,state:'pending',kind:'approval',
 summary:'允许读取当前工程文件吗？',choiceSource:'provider',choices:[
  {id:'deny',label:'拒绝'},{id:'once',label:'仅本次允许',warning:'只对当前请求生效'},
  {id:'session',label:'本会话允许',warning:'后续请求可能不再单独提示'}]};
const question={id:'question-b',taskId:'task-a',answerLifetime:'durable',version:3,state:'pending',kind:'question',questions:[
 {id:'q1',prompt:'选择需要核对的资料',allowMultiple:true,options:[{id:'a',label:'文档 A'},{id:'b',label:'文档 B'},{id:'c',label:'文档 C'}]},
 {id:'q2',prompt:'请说明交付重点',allowCustomAnswer:true,options:[{id:'short',label:'简明结果'}]}]};
const native=(changes={})=>({status:'supported',task,interactions:[approval,question],bindingsStatus:'supported',bindings:[],
 selectedInteractionId:null,...changes});
const fakeRenderer=`export class JellyfishRenderer {ready=true;async load(){}setAutomaticPolicy(){}setFraming(){}reset(){}beginAttention(){}updateView(){}snapshot(){return {}}dispose(){}}`;
try{
 await build({entryPoints:['desktop/main.mjs'],bundle:true,format:'esm',outfile:join(temp,'main.js'),
  plugins:[{name:'isolated-model-and-media',setup(plugin){
   plugin.onResolve({filter:/cubism-renderer\.mjs|browser-playback\.ts|browser-capture\.ts/},args=>({path:args.path,namespace:'isolated'}));
   plugin.onLoad({filter:/.*/,namespace:'isolated'},args=>({contents:args.path.includes('cubism')?fakeRenderer:
    args.path.includes('playback')?`export class BrowserPlaybackDriver {async open(){window.forbiddenCalls++;throw Error('playback forbidden')}}`:
     `export class BrowserCaptureDriver {async open(){window.forbiddenCalls++;throw Error('capture forbidden')}}`}));
  }}]});
 const html=(await readFile('desktop/index.html','utf8')).replace(/<script[\s\S]*?<\/script>/g,'')
  .replace('</body>','<script type="module" src="main.js"></script></body>');
 server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://local').pathname,
   data=path==='/'?html:path==='/main.js'?await readFile(join(temp,'main.js')):path==='/style.css'?await readFile('desktop/style.css'):null;
  if(data===null){res.statusCode=404;res.end();return;}res.setHeader('Content-Type',path==='/'?'text/html; charset=utf-8':path==='/style.css'?'text/css':'text/javascript');res.end(data);
 }catch(error){res.statusCode=500;res.end(String(error));}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await engines.webkit.launch({headless:true});const results=[];
 for(const width of [500,380]){
  const page=await browser.newPage({viewport:{width,height:940},locale:'zh-CN'}),errors=[];
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{window.wires=[];window.forbiddenCalls=0;
   window.webkit={messageHandlers:Object.fromEntries(['desktop','shell','diagnostic'].map(name=>[name,{postMessage(value){wires.push({name,value})}}]))};
   if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>{forbiddenCalls++;throw Error('device forbidden');};});
  await page.goto(`http://127.0.0.1:${server.address().port}/`);await page.waitForFunction(()=>window.petBridge);
  const recv=(message,generation=1)=>page.evaluate(({message,generation})=>petBridge.receive(message,generation),{message,generation});
  const sendState=(sequence,change={})=>recv({channel:'workbench_state',state:makeState(sequence,change)});
  const actions=()=>page.evaluate(()=>wires.filter(row=>row.name==='desktop'&&row.value.message.channel==='workbench_action').map(row=>row.value.message.action));
  const lastAction=async()=>({...(await actions()).at(-1)});
  await page.evaluate(()=>petBridge.connectionChanged({generation:1,state:'connecting'}));
  await recv({channel:'backend_ready',bridgeVersion,characterId:'companion',sessionId:'session-1'});
  await page.locator('#open').click();await page.waitForFunction(()=>!document.querySelector('#drawer').getAnimations().length);
  await sendState(1);await page.locator('#workbench-open').click();
  assert.equal(await page.locator('#workbench-dialog').evaluate(node=>node.open),true);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgba(0, 0, 0, 0)');
  for(let n=0;n<8;n++){await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.querySelector('#workbench-dialog').contains(document.activeElement)),true);}
  assert.match(await page.locator('#workbench-content').innerText(),/前 100 项/);
  await page.locator('#workbench-project-query').fill('甲');await page.locator('#workbench-project-search').click();
  assert.deepEqual(await lastAction(),{type:'refresh',projectQuery:'甲'});
  await sendState(2,{projects:[projects[0]],projectsTruncated:false});
  await page.locator('[data-project-id="project-a"]').click();
  assert.deepEqual(await lastAction(),{type:'select',projectId:'project-a',taskId:null,expectedRevision:0});
  await sendState(3,{focus:{version:'0.1.0',revision:1,projectId:'project-a',task:null},projects:[projects[0]],tasks});
  assert.equal(await page.locator('[data-task-id="legacy-a"]').isDisabled(),true);
  await page.locator('[data-task-id="task-a"]').click();
  assert.deepEqual(await lastAction(),{type:'select',projectId:'project-a',taskId:'task-a',expectedRevision:1});
  await sendState(4,{focus:focus(),projects:[projects[0]],tasks});
  assert.equal((await page.locator('#workbench-content').innerText()).includes('等待原操作回执'),false);

  const shellOpens=()=>page.evaluate(()=>wires.filter(row=>row.name==='shell'&&row.value.type==='open_workbench').map(row=>row.value));
  assert.equal(await page.locator('#workbench-new').count(),0,'full editor is outside the desktop summary');
  assert.equal(await page.locator('#workbench-prepare').count(),0);
  await page.locator('#workbench-native-home').click();
  assert.deepEqual((await shellOpens()).at(-1),{type:'open_workbench',target:'home'});
  assert.equal(await page.locator('#workbench-native-home').isDisabled(),true);
  await page.evaluate(()=>petBridge.workbenchOpenResult({ok:false}));
  assert.match(await page.locator('#workbench-content').innerText(),/打开未完成/);
  await page.locator('#workbench-native-project').click();
  assert.deepEqual((await shellOpens()).at(-1),{type:'open_workbench',target:'project',
   projectId:'project-a',expectedFocusRevision:2});
  await page.evaluate(()=>petBridge.workbenchOpenResult({ok:true}));
  await page.locator('#workbench-native-task').click();
  assert.deepEqual((await shellOpens()).at(-1),{type:'open_workbench',target:'task',
   projectId:'project-a',taskId:'task-a',expectedFocusRevision:2});
  await page.evaluate(()=>petBridge.workbenchOpenResult({ok:true}));
  await sendState(5,{focus:focus(),projects:[projects[0]],tasks,drafts:[draft],selectedDraftId:'draft-a',
   command:{commandId:'command-a',state:'recorded',task},dispatchEnabled:false,native:native()});
  await page.locator('#workbench-content').evaluate(node=>node.scrollTop=0);
  await page.locator('#workbench-dialog').screenshot({path:join(output,`entry-${width}.png`)});
  assert.equal(await page.locator('#workbench-content').innerText().then(text=>text.includes(original)),true,'full raw input is visible before confirmation');
  assert.equal(await page.locator('#workbench-content').innerText().then(text=>text.includes(reviewed)),true,'full dispatch text is visible before confirmation');
  await page.locator('.desktop-workbench-draft').screenshot({path:join(output,`draft-${width}.png`)});
  assert.equal(await page.locator('#workbench-confirm').isDisabled(),true,'dispatch-off cannot confirm');
  assert.equal(await page.locator('#workbench-dismiss').isDisabled(),false,'unsubmitted draft can still be cancelled');
  assert.equal(await page.locator('#workbench-source').isVisible(),true,'original input remains accessible');
  assert.match(await page.locator('#workbench-source').textContent(),/用户原话/);
  await sendState(6,{focus:focus(),projects:[projects[0]],tasks,drafts:[draft],selectedDraftId:'draft-a',
   command:{commandId:'command-a',state:'recorded',task},dispatchEnabled:true,native:native()});
  assert.equal(await page.locator('#workbench-confirm').isDisabled(),false);
  const beforeConfirm=(await actions()).length;await page.locator('#workbench-confirm').click();
  assert.deepEqual(await lastAction(),{type:'confirm',draftId:'draft-a',expectedVersion:1});
  assert.equal((await actions()).length,beforeConfirm+1);
  assert.equal(await page.locator('#workbench-confirm').isDisabled(),true,'one click cannot be replayed');
  await sendState(7,{focus:focus(),projects:[projects[0]],tasks,drafts:[draft],selectedDraftId:'draft-a',
   command:{commandId:'command-a',state:'recorded',task},dispatchEnabled:true,native:native()});
  assert.equal(await page.locator('#workbench-confirm').isDisabled(),true,'same draft remains single-attempt after readback');
  await page.locator('[data-interaction-id="approval-a"]').click();
  assert.equal(await page.locator('#workbench-native-submit').isDisabled(),true,'approval has no default');
  assert.equal(await page.locator('.desktop-workbench-native-option').count(),3);
  await page.locator('.desktop-workbench-native-option input[value="once"]').check();
  await page.locator('#workbench-native-submit').click();
  assert.deepEqual(await lastAction(),{type:'respond_interaction',projectId:'project-a',taskId:'task-a',
   expectedFocusRevision:2,interactionId:'approval-a',expectedVersion:2,
   response:{type:'decide_approval',choiceId:'once'}});
  const bound={interactionId:'approval-a',commandId:'native-command-a',kind:'approval',requestVersion:2};
  await sendState(8,{focus:focus(),projects:[projects[0]],tasks,drafts:[draft],selectedDraftId:'draft-a',
   dispatchEnabled:true,native:native({bindings:[bound],selectedInteractionId:'approval-a',
    command:{command:{commandId:'native-command-a',state:'accepted',task},resolution:'pending',interaction:approval}})});
  assert.equal(await page.locator('#workbench-native-submit').count(),0,'bound answer cannot replay');
  assert.match(await page.locator('.desktop-workbench-native-detail').innerText(),/原生请求仍待处理/);
  await page.locator('#workbench-native-read').click();
  assert.equal((await lastAction()).type,'read_interaction');
  await sendState(9,{focus:focus(),projects:[projects[0]],tasks,drafts:[draft],selectedDraftId:'draft-a',
   dispatchEnabled:true,native:native({interactions:[{...approval,state:'answered'},question],bindings:[bound]})});
  await page.locator('[data-interaction-id="question-b"]').click();
  assert.equal(await page.locator('#workbench-native-submit').isDisabled(),true,'all questions required');
  await page.locator('.desktop-workbench-native-question').first().locator('input[value="a"]').check();
  await page.locator('#workbench-native-custom-mode-1').click();
  await page.locator('#workbench-native-custom-1').fill('请给简短结论。');
  await page.locator('#workbench-native-submit').click();
  assert.deepEqual(await lastAction(),{type:'respond_interaction',projectId:'project-a',taskId:'task-a',
   expectedFocusRevision:2,interactionId:'question-b',expectedVersion:3,response:{type:'answer_question',answers:[
    {questionId:'q1',selectedOptionIds:['a']},{questionId:'q2',selectedOptionIds:[],customText:'请给简短结论。'}]}});
  const cancelDraft={...draft,id:'draft-b',commandId:'command-b',input:{...draft.input,inputId:'message-b',
   origin:{...draft.input.origin,messageId:'message-b'}}};
  await sendState(10,{focus:focus(),projects:[projects[0]],tasks,drafts:[cancelDraft],selectedDraftId:'draft-b',
   command:{commandId:'command-b',state:'recorded',task},dispatchEnabled:true,native:native()});
  await page.locator('#workbench-dismiss').click();
  assert.deepEqual(await lastAction(),{type:'dismiss',draftId:'draft-b',expectedVersion:1});
  assert.equal(await page.locator('#workbench-dismiss').isDisabled(),true,'cancel stays single-attempt until readback');
  await sendState(11,{focus:focus(3,taskB),projects:[projects[0]],tasks,dispatchEnabled:true,native:native()});
  assert.equal(await page.locator('#workbench-native-task').isDisabled(),false);
  assert.equal(await page.locator('[data-interaction-id]').count(),0,'wrong native task is not shown');
  await page.locator('#workbench-dialog').screenshot({path:join(output,`workbench-${width}.png`)});
  await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement.id==='workbench-open');
  await page.locator('#text').fill('今晚我们聊聊电影。');await page.locator('#send').click();
  const companion=await page.evaluate(()=>wires.filter(row=>row.name==='desktop'&&row.value.message.channel==='command').at(-1)?.value.message.command);
  assert.equal(companion.type,'submit_text');assert.equal(companion.text,'今晚我们聊聊电影。');
  const scope={characterId:'companion',sessionId:'stored',turnId:'old-turn',generation:1};
  await recv({channel:'work_state',state:{sequence:1,stage:'confirming',focus:'work',
   draft:{id:'old-draft',version:1,text:'旧工程原话',projects:[],targets:[]},
   confirmation:{id:'old-confirm',version:1,phase:'awaiting_confirmation',executor:'harness',
    plan:{title:'原有工程',reason:'按原有流程确认。'},text:'旧流程派发正文',createdAt:''},
   sourceInput:{draftId:'old-draft',scope,text:'旧工程原话',provenance:'original_input',
    conversation:[{role:'user',scope,text:'旧工程原话'}]},requests:[]}},1);
  await page.locator('#work-reopen').click();
  assert.equal(await page.locator('#work-confirm').isVisible(),true,'short original confirmation remains');
  assert.match(await page.locator('#work-card').innerText(),/旧流程派发正文/);
  assert.equal(await page.evaluate(()=>forbiddenCalls),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  await writeFile(join(output,`desktop-${width}.json`),JSON.stringify({width,nativeOpens:(await shellOpens()).length,
   workbenchActions:(await actions()).length,noDeviceCalls:await page.evaluate(()=>forbiddenCalls),pageErrors:errors},null,2));
  await page.locator('#workbench-open').click();
  await sendState(1000,{focus:focus(),projects:[projects[0]],tasks:[{task,projection:{taskId:task.id,
   sequence:10,eventId:'complete',phase:'completed',nativeTurnId:'completed-turn'},
   resultPreview:{nativeTurnId:'completed-turn',messageId:'assistant',text:'AAA_B54_CODEX_OK',truncated:false}}]});
  await page.locator('#workbench-refresh').click();
  await sendState(1001,{focus:focus(),projects:[projects[0]],tasks:[{task,projection:{taskId:task.id,
   sequence:10,eventId:'complete',phase:'completed',nativeTurnId:'completed-turn'},
   resultPreview:{nativeTurnId:'completed-turn',messageId:'assistant',text:'AAA_B54_CODEX_OK',truncated:false}}]});
  assert.match(await page.locator('#workbench-content').innerText(),/AAA_B54_CODEX_OK/);
  assert.match(await page.locator('[data-task-id="task-a"]').innerText(),/已完成/);
  assert.equal((await page.locator('#workbench-content').innerText()).includes('等待原操作回执'),false);

  // Exercise native voice binding with the production DOM and paint boundaries.
  // Only bridge commands/controlled receipts are emitted; no capture request,
  // provider call, native turn or task creation is made.
  await page.keyboard.press('Escape');
  await page.evaluate(()=>petBridge.hotkeyConfig('Space'));
  const voiceDraft={...draft,id:'voice-draft',commandId:'voice-command',input:{...draft.input,
   inputId:'voice-original',origin:{...draft.input.origin,messageId:'voice-original'},
   rawText:'先核对文档，不改文件。',dispatchText:'核对现有文档并说明来源。'}};
  const vb=(revision=4,version=1)=>({version:'0.1.0',projectId:task.projectId,taskId:task.id,
   focusRevision:revision,draftId:voiceDraft.id,draftVersion:version,commandId:voiceDraft.commandId});
  const voiceState=(sequence,revision=4,selected=voiceDraft)=>makeState(sequence,{focus:focus(revision),projects:[projects[0]],tasks,
   drafts:[selected],selectedDraftId:selected.id,command:{commandId:selected.commandId,state:'recorded',task},
   native:native({interactions:[]}),dispatchEnabled:true,voiceBinding:vb(revision,selected.version)});
  let inputGeneration=100;
  const probe=async(next)=>page.evaluate(({next,inputGeneration})=>{
   if(next)petBridge.receive({channel:'workbench_state',state:next},1);
   document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));
   const sent=wires.filter(row=>row.name==='desktop'&&row.value.message.channel==='command'&&row.value.message.command.type==='start_voice').at(-1)?.value.message.command;
   if(!sent)throw Error('native card PTT did not emit start_voice');
   const scope={characterId:'companion',sessionId:'session-1',turnId:sent.clientRequestId,generation:inputGeneration};
   petBridge.receive({channel:'event',event:{type:'turn',input:{kind:'voice',scope,startedAt:'',clientRequestId:sent.clientRequestId}}},1);
   petBridge.receive({channel:'event',event:{type:'error',scope,message:'受控采集未启用'}},1);
   return sent;
  },{next,inputGeneration:++inputGeneration});
  const paint=()=>page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
  const readRegion=async(pre)=>{
   await pre.scrollIntoViewIfNeeded();
   const size=await pre.evaluate(el=>({height:el.scrollHeight,client:el.clientHeight}));
   for(let top=0;top<size.height;top+=Math.max(1,size.client-24)){
    await pre.evaluate((el,top)=>{el.scrollTop=top;},top);await paint();
   }
  };
  const readAll=async()=>{const regions=page.locator('#workbench-draft-raw,[id^="workbench-draft-dialogue-"],#workbench-draft-body');
   for(let i=0;i<await regions.count();i++)await readRegion(regions.nth(i));};
  const immediate=await probe(voiceState(2000));assert.equal(immediate.workbenchBinding,undefined,'receipt is not a displayed card');
  assert.equal(await page.locator('#workbench-dialog').evaluate(n=>n.open),true,'native card opens automatically');
  await readAll();const shown=await probe();assert.deepEqual(shown.workbenchBinding,vb());assert.equal(shown.workBinding,undefined);
  assert.match(await page.locator('#workbench-draft').innerText(),/先核对文档.*不改文件/s);
  await page.locator('#workbench-close').click();assert.deepEqual((await probe()).workbenchBinding,vb(),'closing an unchanged shown card retains binding');
  await sendState(2001,{focus:focus(5,taskB),projects:[projects[0]],tasks});assert.equal((await probe()).workbenchBinding,undefined);
  assert.equal((await probe(voiceState(2002,6))).workbenchBinding,undefined,'A→B→A cannot inherit original display');
  await readAll();assert.deepEqual((await probe()).workbenchBinding,vb(6));
  const supplemented={...voiceDraft,version:2,input:{...voiceDraft.input,dispatchText:'核对文档及日期，不改文件。',conversation:[
   {role:'user',text:voiceDraft.input.rawText,origin:voiceDraft.input.origin},
   {role:'assistant',text:'是否也核对日期？',origin:voiceDraft.input.origin},
   {role:'user',text:'还要核对日期。',origin:{...voiceDraft.input.origin,messageId:'voice-supplement'}}]}};
  assert.equal((await probe(voiceState(2003,6,supplemented))).workbenchBinding,undefined,'new body must paint before rebinding');
  await paint();assert.equal((await probe()).workbenchBinding,undefined,'v2 header does not present the body below its viewport');
  assert.match(await page.locator('#workbench-conversation').innerText(),/是否也核对日期？.*还要核对日期/s);
  assert.match(await page.locator('#workbench-draft').innerText(),/用户原话.*先核对文档.*待派发完整正文.*核对文档及日期/s);
  await page.locator('#workbench-draft').screenshot({path:join(output,`native-voice-card-${width}.png`)});
  await readAll();assert.deepEqual((await probe()).workbenchBinding,vb(6,2));
  await page.locator('#workbench-draft pre').last().scrollIntoViewIfNeeded();
  await page.locator('#workbench-dialog').screenshot({path:join(output,`native-voice-body-${width}.png`)});
  const beforeButton=await page.evaluate(()=>wires.length);await page.locator('#workbench-voice').click();
  const buttonCommand=await page.evaluate(()=>wires.filter(r=>r.name==='desktop'&&r.value.message.channel==='command'&&r.value.message.command.type==='start_voice').at(-1)?.value.message.command);
  assert.deepEqual(buttonCommand.workbenchBinding,vb(6,2));assert.equal(buttonCommand.workBinding,undefined);
  assert.ok(await page.evaluate(before=>wires.length>before,beforeButton));
  const buttonScope={characterId:'companion',sessionId:'session-1',turnId:buttonCommand.clientRequestId,generation:++inputGeneration};
  await recv({channel:'event',event:{type:'turn',input:{kind:'voice',scope:buttonScope,startedAt:'',clientRequestId:buttonCommand.clientRequestId}}});
  await recv({channel:'event',event:{type:'error',scope:buttonScope,message:'受控采集未启用'}});
  await page.locator('#workbench-collapse').click();
  assert.deepEqual(await page.evaluate(()=>wires.filter(r=>r.name==='shell'&&r.value.type==='set_collapsed').at(-1)?.value),
   {type:'set_collapsed',collapsed:true,open:true});
  await page.evaluate(()=>petBridge.displayConfig({collapsed:true,ballLeft:20,ballTop:20,ballSize:52}));
  await page.locator('#pet-ball').click();
  assert.deepEqual(await page.evaluate(()=>wires.filter(r=>r.name==='shell'&&r.value.type==='set_collapsed').at(-1)?.value),
   {type:'set_collapsed',collapsed:false,open:true});
  await page.evaluate(()=>petBridge.displayConfig({collapsed:false}));await paint();
  assert.deepEqual((await probe()).workbenchBinding,vb(6,2),'ball restoration keeps only unchanged shown binding');
  const nativeBefore=(await actions()).filter(a=>a.type==='confirm').length;
  await page.locator('#workbench-confirm').click();assert.equal((await actions()).filter(a=>a.type==='confirm').length,nativeBefore+1);
  const unknown=voiceState(2004,6,supplemented);unknown.command.state='unknown';await recv({channel:'workbench_state',state:unknown});
  assert.equal(await page.locator('#workbench-confirm').isDisabled(),true);assert.equal((await probe()).workbenchBinding,undefined);
  await page.locator('#workbench-refresh').click();assert.equal((await lastAction()).type,'refresh');
  assert.equal((await actions()).filter(a=>a.type==='confirm').length,nativeBefore+1,'unknown receipt never replays original command');

  const lines=(title,count)=>Array.from({length:count},(_,i)=>`${title}第${i+1}段：核对文档、日期和来源。`).join('\n');
  const longOrigin={...voiceDraft.input.origin,messageId:'long-original'},longDraft={...voiceDraft,id:'long-draft',commandId:'long-command',
   input:{...voiceDraft.input,inputId:longOrigin.messageId,origin:longOrigin,rawText:lines('原话',12),dispatchText:lines('正文',36),conversation:[
    {role:'user',text:lines('原话',12),origin:longOrigin},
    {role:'assistant',text:lines('问题',14),origin:longOrigin},
    {role:'user',text:lines('回答',8),origin:{...longOrigin,messageId:'long-answer'}}]}};
  const longBinding=(revision=6,version=1)=>({...vb(revision,version),draftId:longDraft.id,commandId:longDraft.commandId});
  const longState=(sequence,revision=6,selected=longDraft)=>({...voiceState(sequence,revision,selected),voiceBinding:longBinding(revision,selected.version)});
  const longEvidence=[];
  const observe=async(label,sent)=>{const geometry=await page.evaluate(()=>{
   const view=document.querySelector('#workbench-content').getBoundingClientRect(),card=document.querySelector('#workbench-draft').getBoundingClientRect(),body=document.querySelector('#workbench-draft-body'),r=body.getBoundingClientRect();
   return {viewport:{top:view.top,bottom:view.bottom},card:{top:card.top,bottom:card.bottom},body:{top:r.top,bottom:r.bottom,scrollTop:body.scrollTop,scrollHeight:body.scrollHeight,clientHeight:body.clientHeight},
    confirmDisabled:document.querySelector('#workbench-confirm').disabled,visibleStatus:document.querySelector('#workbench-review-status').textContent};
  });longEvidence.push({label,...geometry,binding:sent.workbenchBinding??null});return geometry;};
  await probe(longState(2010));await paint();
  const head=await observe('long-card-header-only',await probe());assert.equal(longEvidence.at(-1).binding,null);
  assert.ok(head.body.top>=head.viewport.bottom,'actual dispatch body has not entered the viewport');assert.ok(head.card.top<head.viewport.bottom);
  assert.equal(head.confirmDisabled,true);await page.locator('#workbench-dialog').screenshot({path:join(output,`long-header-unbound-${width}.png`)});
  const longBody=page.locator('#workbench-draft-body');await longBody.scrollIntoViewIfNeeded();await longBody.evaluate(el=>el.scrollTop=0);await paint();
  assert.equal((await probe()).workbenchBinding,undefined,'long body top alone cannot bind');
  await longBody.evaluate(el=>el.scrollTop=el.scrollHeight-el.clientHeight);await paint();
  await observe('body-top-and-bottom-with-unshown-middle',await probe());assert.equal(longEvidence.at(-1).binding,null);
  await readAll();assert.deepEqual((await probe()).workbenchBinding,longBinding());
  await observe('long-v1-all-source-and-body-scrolled',await probe());
  const longV2={...longDraft,version:2,input:{...longDraft.input,dispatchText:lines('新版正文',41),conversation:[...longDraft.input.conversation,
   {role:'user',text:lines('新增补充',6),origin:{...longOrigin,messageId:'long-new-answer'}}]}};
  await probe(longState(2011,6,longV2));await paint();const unseen=await observe('v2-header-new-body-not-seen',await probe());
  assert.equal(longEvidence.at(-1).binding,null);assert.ok(unseen.body.top>=unseen.viewport.bottom);
  const sources=page.locator('#workbench-draft-raw,[id^="workbench-draft-dialogue-"]');
  for(let i=0;i<await sources.count();i++)await readRegion(sources.nth(i));
  assert.equal((await probe()).workbenchBinding,undefined,'new answers cannot substitute for unseen full dispatch body');
  await readRegion(longBody);assert.deepEqual((await probe()).workbenchBinding,longBinding(6,2));
  await observe('v2-new-answer-and-body-fully-presented',await probe());
  await page.locator('#workbench-dialog').screenshot({path:join(output,`long-v2-bound-${width}.png`)});
  const longV3={...longV2,version:3,input:{...longV2.input,dispatchText:lines('第三版正文',45)}};
  await probe(longState(2012,6,longV3));await longBody.scrollIntoViewIfNeeded();await longBody.evaluate(el=>el.scrollTop=0);await paint();
  await sendState(2013,{focus:focus(7,taskB),projects:[projects[0]],tasks});assert.equal((await probe()).workbenchBinding,undefined);
  await probe(longState(2014,8,longV3));await longBody.scrollIntoViewIfNeeded();await longBody.evaluate(el=>el.scrollTop=el.scrollHeight-el.clientHeight);await paint();
  await observe('focus-A-B-A-partial-old-version-not-inherited',await probe());assert.equal(longEvidence.at(-1).binding,null);
  const longV4={...longV3,version:4,input:{...longV3.input,dispatchText:lines('第四版正文',46)}},
   longV5={...longV3,version:5,input:{...longV3.input,dispatchText:lines('最终新版正文',48)}};
  await page.evaluate(({oldState,newState})=>{petBridge.receive({channel:'workbench_state',state:oldState},1);
   requestAnimationFrame(()=>petBridge.receive({channel:'workbench_state',state:newState},1));
  },{oldState:longState(2015,8,longV4),newState:longState(2016,8,longV5)});await paint();
  await observe('version-changed-between-paint-frames',await probe());assert.equal(longEvidence.at(-1).binding,null);
  await readRegion(longBody);assert.equal((await probe()).workbenchBinding,undefined,'new body cannot borrow old raw/answer coverage');
  await readAll();assert.deepEqual((await probe()).workbenchBinding,longBinding(8,5));
  await observe('current-focus-and-v5-all-text-actually-presented',await probe());
  await writeFile(join(output,`long-presentation-${width}.json`),JSON.stringify({width,source:'controlled actual production DOM',
   bodyViewport:'Nested pre scroll clipped to outer content and window; no implementation state inspection',receipts:longEvidence},null,2)+'\n');
  assert.equal(await page.evaluate(()=>forbiddenCalls),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(errors,[]);
  results.push({width,nativeOpens:(await shellOpens()).length,actions:(await actions()).length,
   nativeVoiceBinding:'full raw/body/answer ranges, nested scroll, mid-paint version/focus, collapse and once-confirm checked',
   noDeviceCalls:await page.evaluate(()=>forbiddenCalls),pageErrors:errors});
  await page.close();
 }
 await writeFile(join(output,'browser-evidence.json'),JSON.stringify({engine:'webkit',version:browser.version(),results,
  scope:'Production desktop HTML/CSS/main with synthetic bridge states. Renderer, capture and playback isolated. No real Host/model/device, installed runtime or natural-use acceptance.'},null,2)+'\n');
 console.log('desktop workbench WebKit 500/380 bridge and interaction checks passed');
}catch(error){await writeFile(join(output,'failure.json'),JSON.stringify({message:error.message,stack:error.stack,
 scope:'Controlled production desktop DOM only; no model/device/native task execution.'},null,2)+'\n');throw error;
}finally{await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(temp,{recursive:true,force:true});}
