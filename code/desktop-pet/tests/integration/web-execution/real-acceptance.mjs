// B56 original installed browser acceptance. Starts no turn until the exact
// original Composer targets, configuration and independent ledger are frozen.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {T3LocalService} from '../../../../workbench/integration/t3-local-service.mjs';
import {T3HttpClient} from '../../../../workbench/integration/t3-http-client.mjs';
import {readEngineProfile} from '../../../../workbench/integration/engine-pins/profile.mjs';

const R=process.env.B56_ORIGINAL_ROOT,E=process.env.B56_EVIDENCE;
assert(R?.endsWith('/acdemic/movefile')&&E?.startsWith(R+'/artifacts/worktrees/W0-I-engine-pin-54/artifacts/W0-I/web-execution-56'));
const runId=process.env.B56_RUN_ID??'real-run-01';assert(['real-run-01','real-run-02','real-run-03'].includes(runId));
const run=E+'/'+runId,candidate=JSON.parse(fs.readFileSync(process.env.B56_CANDIDATE??E+'/real-web-acceptance-candidate.json'));fs.mkdirSync(run,{recursive:true,mode:0o700});
if(runId==='real-run-02'){
 const prior=JSON.parse(fs.readFileSync(E+'/real-run-01/ledger.json')),cold=JSON.parse(fs.readFileSync(E+'/real-run-01/blocked-original-cold-read.json'));
 assert.equal(prior.status,'closed-local-configuration-failure-before-forward');assert.equal(prior.reservations.length,0);assert.equal(cold.originalCommandReceipt,null);assert.equal(cold.providerPrompts,0);assert(Object.values(cold.counts).every(n=>n===0));
}
const digest=value=>createHash('sha256').update(value).digest('hex');
const write=(name,value)=>fs.writeFileSync(run+'/'+name,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const expectedSource=process.env.B56_INSTALLED_SOURCE??'a6b9c8f6755325c4334a891b291aa0704a6ec47b';assert(/^[a-f0-9]{40}$/.test(expectedSource));
const priorPrompts=runId==='real-run-03'?2:0;
if(priorPrompts){const prior=JSON.parse(fs.readFileSync(E+'/real-run-02/ledger.json'));assert.equal(prior.status,'closed-source-fix-required');assert.equal(prior.reservations.length,2);assert.equal(new Set(prior.reservations.map(r=>r.provider)).size,2);}
const require=createRequire(new URL('../../../package.json',import.meta.url));
const Database=require('better-sqlite3'),db=new Database(R+'/data/desktop-pet/t3-home/userdata/state.sqlite',{readonly:true});
const profile=readEngineProfile(R),service=new T3LocalService({sourceDir:R+'/artifacts/runtime/engine-pin-54/t3-runtime',nodeExecutable:profile.runtime.nodeExecutable,baseDir:R+'/data/desktop-pet/t3-home',logFile:R+'/data/desktop-pet/logs/t3-workbench.log',engineProjectRoot:R,dshWebLogPath:profile.dshWebLog});
const client=new T3HttpClient(service,{transport:(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(45000)})});
const env=(await client.environmentDescriptor()).environmentId;assert.equal(env,candidate.entry.expectedOriginalEnvironmentId);
const descriptor=JSON.parse(fs.readFileSync(R+'/artifacts/W0-I/model-evaluation/trial/user-trial/management-session.json'));
assert.equal(descriptor.sourceRevision,expectedSource);
const management=new URL(descriptor.url),token=new URLSearchParams(management.hash.slice(1)).get('token');
const response=await fetch(management.origin+'/api/workbench/native-open/desktop',{method:'POST',headers:{Authorization:'Bearer '+token,Origin:management.origin,'Content-Type':'application/json'},body:JSON.stringify({target:'home'})});
assert(response.ok,'original native open');const issued=await response.json();const entry=new URL(issued.url);assert(entry.hash.length>1);
const {chromium}=await import(pathToFileURL(process.env.B56_PLAYWRIGHT_MODULE));
const browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width:1280,height:900},reducedMotion:'reduce'});
const launch=await context.request.post(entry.origin+'/launch',{headers:{Origin:entry.origin},data:{ticket:entry.hash.slice(1)}});assert.equal(launch.status(),200);
const capsResponse=await context.request.get(entry.origin+'/api/native-mount/capabilities');assert.equal(capsResponse.status(),200);const caps=await capsResponse.json();
assert.equal(caps.mode,'native-operate');assert.equal(caps.environmentId,env);
const projectTitle='B56 bounded web acceptance 01',projectId=candidate.project.projectId;
let project=db.prepare('SELECT * FROM projection_projects WHERE project_id=?').get(projectId);
if(!project){
  const command={type:'project.create',commandId:randomUUID(),projectId,title:projectTitle,workspaceRoot:candidate.project.workspaceRoot,createdAt:new Date().toISOString()};
  write('project-command.json',{commandId:command.commandId,payloadSha256:digest(JSON.stringify(command)),projectId,workspaceRoot:command.workspaceRoot});
  await client.createCommand(command);const receipt=await client.readReceipt(command.commandId);assert.equal(receipt?.status,'accepted');assert.equal(receipt.aggregateId,projectId);write('project-receipt.json',receipt);
  project=db.prepare('SELECT * FROM projection_projects WHERE project_id=?').get(projectId);
}
assert(project);assert.equal(project.workspace_root,candidate.project.workspaceRoot);
const pages=new Map(),targets=new Map(),observations={at:new Date().toISOString(),source:expectedSource,environmentId:env,projectId,gatewayOrigin:entry.origin,capabilities:caps,commands:[],pageErrors:[],rpcResults:[],checks:[],prompts:0};
let ledger=null,armed=null,closed=false;
const save=()=>{write('observations.json',observations);if(ledger)write('ledger.json',ledger);};
await context.route('**/*',route=>new URL(route.request().url()).origin===entry.origin?route.continue():route.abort());
await context.routeWebSocket(/\/ws(?:\?|$)/,socket=>{
  const upstream=socket.connectToServer(),connectionId=randomUUID();
  socket.onMessage(message=>{
    try{
      const raw=JSON.parse(String(message));
      for(const item of Array.isArray(raw)?raw:[raw]){
        if(item.tag!=='orchestration.dispatchCommand')continue;
        const command=item.payload;
        // Only this anonymous acceptance project's original command payloads
        // are retained. No HTTP auth, cookies, signed upload URL or profile data.
        (observations.originalCommands??=[]).push(command);save();
        const target=[...targets.values()].find(value=>value.threadId===command.threadId);
        if(!target)(observations.blockedCommands??=[]).push({type:command.type,commandId:command.commandId,threadId:command.threadId,payloadSha256:digest(JSON.stringify(command)),forwarded:false});
        assert(target,'only frozen original draft/thread may mutate');
        if(command.bootstrap?.createThread)assert.equal(command.bootstrap.createThread.projectId,projectId);
        const record={type:command.type,commandId:command.commandId,threadId:command.threadId,payloadSha256:digest(JSON.stringify(command)),modelSelection:command.modelSelection,runtimeMode:command.runtimeMode,requestId:String(item.id),connectionId,at:new Date().toISOString()};
        if(['thread.turn.start','thread.user-input.respond'].includes(command.type)){
          assert(ledger?.status==='active'&&!closed&&armed,'no unfrozen or repeated send');
          assert.equal(target.provider,armed.provider);assert.equal(command.type,'thread.turn.start','optional questions require explicit original request review');
          assert.equal(command.threadId,armed.threadId);assert.equal(command.modelSelection.instanceId,armed.provider);
          const proposed=candidate.providers.find(p=>p.instanceId===armed.provider).turnsProposed[armed.index];
          assert.equal(command.modelSelection.model,proposed.model);assert.equal(command.runtimeMode,proposed.runtimeMode);
          assert(JSON.stringify(command).includes(proposed.prompt),'exact configured prompt must be carried');
          assert(command.modelSelection.options?.some(o=>o.id==='reasoningEffort'&&o.value===proposed.reasoningEffort));
          assert.equal(ledger.reservations.filter(r=>r.provider===armed.provider).length+(priorPrompts?1:0),armed.index);
          const expectedAttachments=candidate.attachments.filter(a=>(proposed.attachmentKinds??['file','image']).includes(a.kind));
          const actualAttachments=command.message.attachments;assert.equal(actualAttachments.length,expectedAttachments.length,'all configured attachments required before forwarding');
          for(const expected of expectedAttachments){const actual=actualAttachments.find(a=>a.type===expected.kind&&a.name===expected.path.split('/').at(-1));assert.equal(actual?.sizeBytes,expected.size);assert(command.message.context?.records?.some(c=>c.attachmentId===actual.id),'original attachment context required');}
          assert(ledger.reservations.length+priorPrompts<6&&ledger.reservations.filter(r=>r.kind==='prompt').length+priorPrompts<4);
          const installed=JSON.parse(fs.readFileSync(R+'/artifacts/W0-I/model-evaluation/trial/user-trial/config.json'));
          assert.equal(installed.sourceRevision??installed.runtimeSourceRevision,expectedSource);
          ledger.reservations.push({...record,provider:armed.provider,index:armed.index,kind:'prompt',status:'reserved-before-forward',nativeSessionId:target.nativeSessionId??null});
          observations.prompts++;armed=null;save();
        }
        observations.commands.push(record);save();
      }
      upstream.send(message);
    }catch(error){observations.transportBlocked=String(error);save();console.log(JSON.stringify({blocked:String(error)}));socket.close({code:1008,reason:'Frozen acceptance scope rejected'});}
  });
  upstream.onMessage(message=>{
    try{const raw=JSON.parse(String(message));for(const item of Array.isArray(raw)?raw:[raw])if(item._tag==='Exit'){
      const record=observations.commands.find(c=>c.requestId===String(item.requestId)&&c.connectionId===connectionId);if(record){const exit=item.exit;observations.rpcResults.push({commandId:record.commandId,result:exit._tag,connectionId,requestId:String(item.requestId),value:exit._tag==='Success'?exit.value:undefined});save();}
    }}catch{}socket.send(message);
  });
});
const editor=p=>p.locator('[data-testid="composer-editor"] [contenteditable="true"], [data-testid="composer-editor"][contenteditable="true"]').first();
async function originalDraft(p){
 const draftId=new URL(p.url()).pathname.split('/').at(-1);
 await p.waitForFunction(id=>{try{return Boolean(JSON.parse(localStorage.getItem('t3code:composer-drafts:v1')).state.draftThreadsByThreadKey[id]?.threadId)}catch{return false}},draftId);
 const value=await p.evaluate(id=>{const state=JSON.parse(localStorage.getItem('t3code:composer-drafts:v1')).state;const draft=state.draftThreadsByThreadKey[id];return {draftId:id,...draft};},draftId);
 assert.equal(value.environmentId,env);assert.equal(value.projectId,projectId);assert.equal(value.worktreePath,null);assert.equal(value.startFromOrigin,false);return value;
}
async function snapshot(p){return {path:new URL(p.url()).pathname,body:(await p.locator('body').innerText()).slice(-6000),buttons:await p.getByRole('button').evaluateAll(elements=>elements.map(e=>({text:e.textContent,name:e.getAttribute('aria-label'),pressed:e.getAttribute('aria-pressed')}))),options:await p.getByRole('option').allTextContents(),menuRadios:await p.getByRole('menuitemradio').allTextContents()};}
async function readProvider(provider){
 const t=targets.get(provider);assert(t);const binding=db.prepare('SELECT * FROM provider_session_runtime WHERE thread_id=?').get(t.threadId);
 if(binding){const cursor=JSON.parse(binding.resume_cursor_json);const native=cursor.threadId??cursor.sessionId;assert(!t.nativeSessionId||t.nativeSessionId===native,'same SID');t.nativeSessionId=native;}
 const turns=db.prepare('SELECT turn_id,state FROM projection_turns WHERE thread_id=? ORDER BY row_id').all(t.threadId);
 const messages=db.prepare('SELECT message_id,turn_id,role,text FROM projection_thread_messages WHERE thread_id=? ORDER BY created_at,message_id').all(t.threadId);
 const runtime=binding?{provider:binding.provider_instance_id,status:binding.status,runtimeMode:binding.runtime_mode,nativeSessionId:t.nativeSessionId,payload:JSON.parse(binding.runtime_payload_json)}:null;
 if(ledger)for(const reservation of ledger.reservations.filter(r=>r.provider===provider)){reservation.receipt=await client.readReceipt(reservation.commandId);reservation.nativeSessionId=t.nativeSessionId??null;reservation.observedTurns=turns;reservation.status=reservation.receipt?.status??'unknown';}
 const result={target:t,runtime,turns,messages,DOM:await snapshot(pages.get(provider))};write(provider+'-latest.json',result);save();return result;
}
console.log(JSON.stringify({ready:true,source:expectedSource,environmentId:env,projectId,mode:caps.mode,providers:caps.providers.map(p=>p.providerInstanceId)}));
const input=createInterface({input:process.stdin});
for await(const line of input){
 try{
  const command=JSON.parse(line),provider=command.provider;let page=pages.get(provider);
  if(command.action==='page'){
    assert(['codex','dsh'].includes(provider)&&!page);page=await context.newPage();pages.set(provider,page);page.setDefaultTimeout(18000);page.on('pageerror',e=>{observations.pageErrors.push(String(e));save();});
    await page.goto(entry.origin+'/native/?aaaProject='+projectId+'&aaaEnvironment='+env);await page.getByRole('button',{name:'New thread',exact:true}).click();console.log(JSON.stringify(await snapshot(page)));
  }else if(command.action==='existing'){
    assert.equal(runId,'real-run-03');assert(['codex','dsh'].includes(provider)&&!page);
    const old=JSON.parse(fs.readFileSync(E+'/real-run-02/'+provider+'-latest.json')).target;assert.equal(old.environmentId,env);assert.equal(old.projectId,projectId);
    targets.set(provider,old);page=await context.newPage();pages.set(provider,page);page.setDefaultTimeout(18000);page.on('pageerror',e=>{observations.pageErrors.push(String(e));save();});
    await page.goto(entry.origin+'/native/'+env+'/'+old.threadId);await editor(page).waitFor();console.log(JSON.stringify(await readProvider(provider)));
  }else if(command.action==='project'){
    await page.getByRole('option',{name:new RegExp(projectTitle)}).first().click();await editor(page).waitFor();assert((await page.locator('body').innerText()).includes('What should we build in \n'+projectTitle),'original draft must visibly name the isolated project');const draft=await originalDraft(page);const threadId=draft.threadId;assert(/^[a-f0-9-]{36}$/.test(threadId));targets.set(provider,{provider,draftId:draft.draftId,threadId,environmentId:env,projectId,nativeSessionId:null});console.log(JSON.stringify({draftIdentity:targets.get(provider),...await snapshot(page)}));
  }else if(command.action==='button-click'){await page.getByRole('button',{name:command.label,exact:true}).click();console.log(JSON.stringify(await snapshot(page)));
  }else if(command.action==='model-open'){await page.locator('[data-chat-provider-model-picker="true"]:visible').first().click();console.log(JSON.stringify(await snapshot(page)));
  }else if(command.action==='model-select'){await page.getByRole('option',{name:new RegExp(command.label,'i')}).first().click();console.log(JSON.stringify(await snapshot(page)));
  }else if(command.action==='effort-open'){await page.getByRole('button',{name:command.label,exact:true}).click();console.log(JSON.stringify(await snapshot(page)));
  }else if(command.action==='effort-select'){await page.getByRole('menuitemradio',{name:new RegExp('^'+command.label+'(?:\\s|$)')}).first().click();console.log(JSON.stringify(await snapshot(page)));
  }else if(command.action==='mode-open'){await page.locator('[data-composer-shortcut="composer.mode"]:visible').first().click();console.log(JSON.stringify(await snapshot(page)));
  }else if(command.action==='mode-select'){await page.getByRole('option',{name:new RegExp(command.label)}).or(page.getByRole('menuitemradio',{name:command.label,exact:true})).first().click();console.log(JSON.stringify(await snapshot(page)));
  }else if(command.action==='compose'){
    const index=command.index??(priorPrompts?1:0),proposed=candidate.providers.find(p=>p.instanceId===provider).turnsProposed[index];assert(proposed);
    await editor(page).fill(proposed.prompt);observations.checks.push(provider+' configured prompt filled before attachment');save();console.log(JSON.stringify(await snapshot(page)));
  }else if(command.action==='attach'){
    const index=command.index??(priorPrompts?1:0),proposed=candidate.providers.find(p=>p.instanceId===provider).turnsProposed[index];assert((await editor(page).innerText()).includes(proposed.prompt),'fill before attach');
    const attached=candidate.attachments.filter(a=>(proposed.attachmentKinds??['file','image']).includes(a.kind));for(const f of attached)assert.equal(digest(fs.readFileSync(f.path)),f.sha256);
    await page.locator('input[type=file]').first().setInputFiles(attached.map(a=>a.path));await page.waitForLoadState('networkidle');console.log(JSON.stringify(await snapshot(page)));
  }else if(command.action==='freeze'){
    assert.equal(targets.size,2);assert(!fs.existsSync(run+'/ledger.json'));
    const currentCatalogs={};for(const provider of ['codex','dsh']){const catalog=await client.providerModels(provider);const original=catalog.providers.find(p=>p.instanceId===provider);assert(original?.status==='ready'&&original.authStatus==='authenticated');for(const turn of candidate.providers.find(p=>p.instanceId===provider).turnsProposed){const model=original.models.find(m=>m.id===turn.model);assert(model?.reasoningEfforts.some(e=>e.id===turn.reasoningEffort));}currentCatalogs[provider]=original;if(!priorPrompts){const draft=await originalDraft(pages.get(provider));assert.equal(draft.threadId,targets.get(provider).threadId);assert.equal(draft.runtimeMode,candidate.providers.find(p=>p.instanceId===provider).turnsProposed[0].runtimeMode);}else{const state=await readProvider(provider);assert.equal(state.turns.length,1);assert.equal(state.turns[0].state,'completed');}}
    const actual={...candidate,version:'0.5',candidateId:candidate.candidateId+'-'+runId,status:'frozen-installed-real-run',dispatchAuthorized:true,ledgerCreated:true,frozenAt:new Date().toISOString(),remainingConfigurationForC:[],currentOriginalCatalogs:currentCatalogs,priorLocalFailure:runId==='real-run-02'?{receipt:E+'/real-run-01/local-failure-receipt.json',sha256:digest(fs.readFileSync(E+'/real-run-01/local-failure-receipt.json')),actuallyForwardedPrompts:0,nativeReservations:0}:null,runControl:{...candidate.runControl,ledgerPathPlanned:run+'/ledger.json'},implementationInputs:{...candidate.implementationInputs,I_fixedCurrentSource:expectedSource,ordinaryAdoption:'source '+expectedSource},providers:candidate.providers.map(p=>({...p,threadId:targets.get(p.instanceId).threadId,draftId:targets.get(p.instanceId).draftId,nativeSessionId:targets.get(p.instanceId).nativeSessionId??null,catalogEvidence:'configuration.json:currentOriginalCatalogs.'+p.instanceId,catalogEvidenceSha256:null,catalogFresh:true})),driverSha256:digest(fs.readFileSync(new URL(import.meta.url))),originalProjectReceipt:JSON.parse(fs.readFileSync(E+'/real-run-01/project-receipt.json'))};write('configuration.json',actual);
    ledger={version:1,runId:actual.candidateId,status:'active',operator:'W0-I',startedAt:new Date().toISOString(),configurationSha256:digest(fs.readFileSync(run+'/configuration.json')),priorLocalFailure:actual.priorLocalFailure,priorPaidBook:priorPrompts?{path:E+'/real-run-02/ledger.json',sha256:digest(fs.readFileSync(E+'/real-run-02/ledger.json')),usedPrompts:2}:null,combinedUsedBefore:priorPrompts,budget:candidate.budget,maxNativeReservations:6,maxApplicationPrompts:4,replays:0,autoJudge:0,reservations:[],supplierInternalRequests:null,actualFeeMicros:null,usageStatus:'await original native/supplier receipts;unknown not zero'};save();console.log(JSON.stringify({frozen:true,targets:[...targets.values()],configurationSha256:ledger.configurationSha256}));
  }else if(command.action==='send'){
    assert(ledger?.status==='active'&&!armed);const index=command.index,proposed=candidate.providers.find(p=>p.instanceId===provider).turnsProposed[index];assert(proposed);
    if(index===1){const state=await readProvider(provider);assert.equal(state.turns.length,1);assert.equal(state.turns[0].state,'completed');assert(['ready','idle','stopped'].includes(state.runtime.status));}
    assert((await editor(page).innerText()).includes(proposed.prompt),'configured prompt must survive attachments; send never replaces rich content');await page.waitForLoadState('networkidle');const send=page.locator('button[type=submit][data-aaa-native-command="thread.turn.start"]:visible').first();assert(!await send.isDisabled());armed={provider,index,threadId:targets.get(provider).threadId};await send.click();console.log(JSON.stringify({clicked:true,provider,index,forwarded:!armed,blocked:observations.transportBlocked??null}));
  }else if(command.action==='read'){console.log(JSON.stringify(await readProvider(provider)));
  }else if(command.action==='refresh'){const draft='B56-unsent-draft-'+provider;await editor(page).fill(draft);await page.reload();await editor(page).waitFor();assert.equal(await editor(page).innerText(),draft);await page.screenshot({path:run+'/'+provider+'-refresh.png'});const state=await readProvider(provider);observations.checks.push(provider+' refresh retained draft, exact history and SID without resend');console.log(JSON.stringify(state));
  }else if(command.action==='finish'){
    closed=true;ledger.status=command.status??'closed';ledger.closedAt=new Date().toISOString();ledger.actualUsageStatus='native/provider readback separate;fees unknown until supplier settlement';save();console.log(JSON.stringify({closed:true,reservations:ledger.reservations.length,prompts:observations.prompts,fees:ledger.actualFeeMicros}));break;
  }else if(command.action==='inspect'){console.log(JSON.stringify(await snapshot(page)));
  }else throw Error('unknown scoped action');
 }catch(error){observations.lastActionError=String(error);save();console.log(JSON.stringify({actionFailed:String(error),newNativeReservations:ledger?.reservations.length??0}));}
}
input.close();await browser.close();db.close();
