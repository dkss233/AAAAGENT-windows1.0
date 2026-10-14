import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

for(const key of ['WEB_EXECUTION_NODE','WEB_EXECUTION_DEPENDENCY_SOURCE','WEB_EXECUTION_FIXTURE_MODULE'])assert.ok(process.env[key],key+' must identify an existing approved input');
const directory=resolve(process.env.WEB_EXECUTION_EVIDENCE??'artifacts/W1/web-execution-56/peer-history-'+randomUUID());
assert.ok(directory.includes('/artifacts/W1/web-execution-56/'));
await mkdir(join(directory,'codex-home'),{recursive:true,mode:0o700});
const schemaFile=join(directory,'native-peer-schema.mjs');
const require=createRequire(process.env.WEB_EXECUTION_FIXTURE_MODULE);
const {build}=await import(pathToFileURL(require.resolve('esbuild')));
await build({stdin:{contents:'import * as S from "effect/Schema";import * as C from '+JSON.stringify(join(process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,'packages/effect-codex-app-server/src/_generated/schema.gen.ts'))+';export const threadRead=S.decodeUnknownSync(C.V2ThreadReadResponse);export const approval=S.decodeUnknownSync(C.ServerRequest__CommandExecutionRequestApprovalParams);export const question=S.decodeUnknownSync(C.ServerRequest__ToolRequestUserInputParams);export const resolved=S.decodeUnknownSync(C.ServerNotification__ServerRequestResolvedNotification);',resolveDir:process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,loader:'ts'},outfile:schemaFile,bundle:true,platform:'node',format:'esm',banner:{js:'import {createRequire} from "node:module";const require=createRequire(import.meta.url);'}});
const {threadRead}=await import(pathToFileURL(schemaFile));
const peers=[];
function peer(){
  const processChild=spawn(process.env.WEB_EXECUTION_NODE,[fileURLToPath(new URL('./fake-codex-cli.mjs',import.meta.url))],{env:{...process.env,CODEX_HOME:join(directory,'codex-home'),AAA_WEB_TEST_DIRECTORY:directory,AAA_WEB_TEST_SCHEMA:schemaFile,AAA_WEB_TEST_WIRE:join(process.env.WEB_EXECUTION_DEPENDENCY_SOURCE,'apps/server/src/provider/testFixtures/codexMultiAgentWire.json')},stdio:['pipe','pipe','pipe']});
  const messages=[],waiters=new Set();let errors='';
  processChild.stderr.on('data',data=>errors+=data);
  const lines=createInterface({input:processChild.stdout});
  lines.on('line',line=>{const message=JSON.parse(line);messages.push(message);for(const waiter of waiters)if(waiter.match(message)){waiters.delete(waiter);clearTimeout(waiter.timer);waiter.done(message);}});
  const send=message=>processChild.stdin.write(JSON.stringify(message)+'\n');
  const expect=match=>{
    const old=messages.find(match);if(old)return Promise.resolve(old);
    return new Promise((done,reject)=>{const waiter={match,done,timer:setTimeout(()=>{waiters.delete(waiter);reject(Error('Fixture response timeout '+errors));},5000)};waiters.add(waiter);});
  };
  const request=async(method,params)=>{const id=randomUUID();send({id,method,params});return expect(message=>message.id===id);};
  const close=()=>new Promise(done=>{processChild.once('exit',()=>{clearTimeout(timer);done();});processChild.stdin.end();const timer=setTimeout(()=>processChild.kill(),1000);});
  const result={send,expect,request,close};peers.push(result);return result;
}
const observations={level:'test peer only; original schema; separate read process; no T3 service/model/device',checks:[]};
try{
  await test('native fixture persists exact original IDs, full input and actual finish state across read-only peer processes',async()=>{
    const writer=peer();await writer.request('initialize',{clientInfo:{name:'aaa-fixture-writer'}});
    const cwd=join(directory,'synthetic-project');await mkdir(cwd);
    const started=await writer.request('thread/start',{cwd,model:'fixture-a'});const nativeId=started.result.thread.id;
    observations.nativeId=nativeId;
    const read=async includeTurns=>{
      const reader=peer();
      await reader.request('initialize',{clientInfo:{name:'aaa-fixture-readonly'}});
      const response=await reader.request('thread/read',{threadId:nativeId,includeTurns});
      threadRead(response.result);await reader.close();peers.splice(peers.indexOf(reader),1);
      return response.result.thread;
    };
    const text='[fixture:wait] history-'+randomUUID();
    const running=await writer.request('turn/start',{threadId:nativeId,input:[{type:'text',text}],model:'fixture-b'});
    const turnId=running.result.turn.id;
    let history=await read(true);assert.equal(history.id,nativeId);assert.equal(history.cwd,cwd);
    assert.equal(history.status.type,'active');assert.equal(history.turns[0].status,'inProgress');
    assert.equal(history.turns[0].completedAt,null);assert.ok(Number.isInteger(history.turns[0].startedAt));
    assert.equal(history.turns[0].id,turnId);assert.deepEqual(history.turns[0].items[0].content,[{type:'text',text}]);
    assert.equal(history.turns[0].items[0].id,running.result.turn.items[0].id);
    assert.deepEqual((await read(false)).turns,[]);
    const wrong=await writer.request('turn/interrupt',{threadId:nativeId,turnId:randomUUID()});assert.ok(wrong.error);
    assert.equal((await read(true)).turns[0].status,'inProgress');
    await writer.request('turn/interrupt',{threadId:nativeId,turnId});
    const completed=await writer.expect(message=>message.method==='turn/completed'&&message.params.turn.id===turnId);
    history=await read(true);assert.equal(history.status.type,'idle');assert.equal(history.turns[0].status,'interrupted');
    assert.equal(history.turns[0].completedAt,completed.params.turn.completedAt);
    assert.deepEqual(history.turns[0].items,completed.params.turn.items);
    observations.checks.push('exact SID and complete input/IDs; includeTurns false/true; wrong interrupt refused; actual interrupted notification persisted');
    for(const [marker,method,flag,result] of [
      ['approval','item/commandExecution/requestApproval','waitingOnApproval',{decision:'accept'}],
      ['question','item/tool/requestUserInput','waitingOnUserInput',{answers:{'fixture-choice':{answers:['选项甲']}}}],
    ]){
      const turn=await writer.request('turn/start',{threadId:nativeId,input:[{type:'text',text:'[fixture:'+marker+'] '+randomUUID()}]});
      const request=await writer.expect(message=>message.method===method&&message.params.turnId===turn.result.turn.id);
      history=await read(true);assert.deepEqual(history.status,{type:'active',activeFlags:[flag]});assert.equal(history.turns.at(-1).status,'inProgress');
      writer.send({id:request.id,result});
      const finished=await writer.expect(message=>message.method==='turn/completed'&&message.params.turn.id===turn.result.turn.id);
      history=await read(true);assert.equal(history.turns.at(-1).status,'completed');assert.deepEqual(history.turns.at(-1).items,finished.params.turn.items);
      assert.equal(history.turns.at(-1).items.at(-1).text,finished.params.turn.items.at(-1).text);
      observations.checks.push(marker+' stays in progress until actual exact native response and finish; actual user/agent IDs and text retained');
    }
    const unrelated=peer();const absent=await unrelated.request('thread/read',{threadId:randomUUID(),includeTurns:true});assert.ok(absent.error);
    const resumed=await unrelated.request('thread/resume',{threadId:nativeId});assert.equal(resumed.result.thread.id,nativeId);assert.equal(resumed.result.cwd,cwd);assert.equal(resumed.result.model,'fixture-b');assert.equal(resumed.result.thread.turns.length,3);
    observations.checks.push('unknown SID refused; original resume restores actual cwd/model and three actual turns without a new SID');
  });
}finally{
  await Promise.all(peers.map(p=>p.close()));
  await writeFile(join(directory,'observations.json'),JSON.stringify(observations,null,2)+'\n');
}
