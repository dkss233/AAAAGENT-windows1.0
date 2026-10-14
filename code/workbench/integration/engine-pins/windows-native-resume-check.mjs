/** Resume a stopped isolated T3-created Codex thread through the official stdio server. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {engineDirectory,engineEnvironment,verifyEngineRuntime} from './runtime.mjs';
const root=resolve(import.meta.dirname,'../../../..');const run=resolve(process.argv[2]);
const prior=JSON.parse(readFileSync(join(run,'result.json'),'utf8'));const task=prior.tasks.find(x=>x.provider==='codex');
assert.equal(task.rounds.length,2);assert.ok(task.rounds[1].completedAt);assert.ok(!existsSync(join(run,'t3-home/.aaaagent-t3-owner.json')),'T3 owner must release before native resume');
const sid=task.rounds[0].nativeSid,runtime=verifyEngineRuntime(join(root,engineDirectory));
const child=spawn(runtime.codexExecutable,['app-server'],{cwd:task.workspace,env:{...process.env,...engineEnvironment(runtime,join(run,'home'))},windowsHide:true,stdio:['pipe','pipe','pipe']});
let seq=0,turnId,completed,stderr='';const pending=new Map();const events=[];child.stderr.on('data',b=>stderr+=b);
const lines=createInterface({input:child.stdout});lines.on('line',line=>{const value=JSON.parse(line);const p=pending.get(value.id);if(p){pending.delete(value.id);clearTimeout(p.timer);value.error?p.reject(Error(JSON.stringify(value.error))):p.done(value.result);return;} if(value.method==='turn/completed'){events.push(value.params);if(value.params.turn.id===turnId)completed=value.params.turn;} if(value.id!==undefined)child.stdin.write(JSON.stringify({id:value.id,error:{code:-32601,message:'No interactive requests accepted by bounded validation'}})+'\n');});
const rpc=(method,params)=>new Promise((done,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout; not resent'))},30000);pending.set(id,{done,reject,timer});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
const result={status:'running',nativeSid:sid,workspace:task.workspace,startedAt:new Date().toISOString(),transport:'official Codex app-server stdio after T3 owner released'};const save=()=>writeFileSync(join(run,'native-resume.json'),JSON.stringify(result,null,2)+'\n');save();
try {await rpc('initialize',{clientInfo:{name:'aaaagent_windows_resume_check',version:'1.0.0'},capabilities:{experimentalApi:true}});child.stdin.write(JSON.stringify({method:'initialized'})+'\n');
const read=await rpc('thread/read',{threadId:sid,includeTurns:true});assert.equal(read.thread.id,sid);result.priorTurns=read.thread.turns.length;assert.equal(result.priorTurns,2);
const resumed=await rpc('thread/resume',{threadId:sid,cwd:task.workspace,model:task.model,approvalPolicy:'never',sandbox:'danger-full-access'});assert.equal(resumed.thread.id,sid);
result.sentAt=new Date().toISOString();save();const start=await rpc('turn/start',{threadId:sid,input:[{type:'text',text:'Read result.json and followup.txt from our previous two turns. Create native-resume.txt in this current directory containing exactly "same SID; final=37". Read it back. Do not modify other files or use network or subagents.'}],approvalPolicy:'never',sandboxPolicy:{type:'dangerFullAccess'}});turnId=start.turn.id;result.turnId=turnId;save();
const end=Date.now()+180000;while(!completed&&Date.now()<end){completed=events.find(e=>e.turn.id===turnId)?.turn;await new Promise(r=>setTimeout(r,500));}assert.equal(completed?.status,'completed');result.completedAt=new Date().toISOString();result.elapsedMs=Date.parse(result.completedAt)-Date.parse(result.sentAt);result.output=readFileSync(join(task.workspace,'native-resume.txt'),'utf8').trim();assert.equal(result.output,'same SID; final=37');
const after=await rpc('thread/read',{threadId:sid,includeTurns:true});assert.equal(after.thread.id,sid);result.finalTurns=after.thread.turns.length;assert.equal(result.finalTurns,3);result.status='passed';
}catch(error){result.status='failed';result.error=error.message;process.exitCode=1;}finally{child.kill('SIGTERM');lines.close();for(const p of pending.values())clearTimeout(p.timer);save();writeFileSync(join(run,'native-resume.stderr.log'),stderr);console.log(JSON.stringify(result));}
