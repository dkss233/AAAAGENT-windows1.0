import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync,openSync,closeSync,lstatSync,realpathSync } from 'node:fs';
import { readFile,writeFile,unlink,open } from 'node:fs/promises';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { prepareTrialLaunch } from '../dist/app/trial-launcher.js';
import { assertTrialQuiescent,inspectTrialUpdate,installTrialUpdate } from './install-trial-update.mjs';
const execute=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex');
const message='启动未完成，已保留数据。请保留此提示联系集成任务。';
const files=root=>({config:resolve(root,'artifacts/W0-I/model-evaluation/trial/user-trial/config.json'),descriptor:resolve(root,'artifacts/W0-I/model-evaluation/trial/user-trial/management-session.json'),backendLock:resolve(root,'artifacts/W0-I/model-evaluation/backend.lock')});
async function optional(path){try{return await readFile(path);}catch(e){if(e.code==='ENOENT')return;throw e;}}

/** SQLite's process lock is released on crash; a second click never stops the first click's new instance. */
export async function withRestartLock(root,operation,requestedAt=Date.now()){
 const dir=resolve(root,'artifacts/W0-I/trial-feedback-01');mkdirSync(dir,{recursive:true,mode:0o700});
 if(realpathSync(dir)!==dir)throw Error('启动状态目录不允许符号链接。');
 const file=resolve(dir,'startup.sqlite');try{closeSync(openSync(file,'wx',0o600));}catch(e){if(e.code!=='EEXIST')throw e;}
 const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('启动状态文件权限不正确。');
 const db=new Database(file,{timeout:0,fileMustExist:true});let locked=false;
 try{
  try{db.exec('CREATE TABLE IF NOT EXISTS launch_state(id INTEGER PRIMARY KEY CHECK(id=1), completed_at INTEGER NOT NULL, result TEXT NOT NULL); BEGIN IMMEDIATE');locked=true;}
  catch(e){if(e.code==='SQLITE_BUSY')return {status:'restart_in_progress'};throw e;}
  const last=db.prepare('SELECT * FROM launch_state WHERE id=1').get();
  if(last&&last.completed_at>=requestedAt){db.exec('ROLLBACK');locked=false;return {...JSON.parse(last.result),status:'joined_restart'};}
  const result=await operation();db.prepare('INSERT INTO launch_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET completed_at=excluded.completed_at,result=excluded.result').run(Date.now(),JSON.stringify(result));db.exec('COMMIT');locked=false;return result;
 }finally{if(locked)db.exec('ROLLBACK');db.close();}
}

export function selectUpdate(root,currentBytes,planBytes,expectedHash){
 if(!planBytes)return null; // Never discover or replay historical update-plan.json files.
 if(!/^[a-f0-9]{64}$/.test(expectedHash??'')||hash(planBytes)!==expectedHash)throw Error('新更新包尚未按准确指纹确认。');
 const plan=JSON.parse(planBytes),currentHash=hash(currentBytes);
 if(plan.projectRoot!==root||plan.activateOnSuccess!==true)throw Error('更新包不属于当前已启用项目。');
 if(plan.nextConfigSha256===currentHash)return null;
 if(plan.currentConfigSha256!==currentHash)throw Error('此更新包已过期，当前程序保持不变。');
 return plan;
}
export function projectProcesses(root,stdout){
 const desktop=resolve(root,'code/desktop-pet/desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet');
 const backend=resolve(root,'code/desktop-pet/dist/app/trial-backend.js');
 return stdout.split('\n').flatMap(line=>{
  const m=line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);if(!m)return [];
  const command=m[4],native=command===desktop||command.startsWith(desktop+' ');
  const node=command.match(/^(?:\S*\/)?node\s+(.+)$/),isBackend=!!node&&(node[1]===backend||node[1].startsWith(backend+' '));
  if(!native&&!isBackend)return [];
  return [{pid:Number(m[1]),ppid:Number(m[2]),started:m[3],command,kind:native?'desktop':'backend'}];
 });
}
const same=(a,b)=>a.pid===b.pid&&a.started===b.started&&a.command===b.command;
export async function stopPrevious(root,host){
 const old=await host.list(root),oldDescriptor=await host.descriptor(root);
 if(old.some(p=>p.kind==='desktop'))await host.quit(root,old.filter(p=>p.kind==='desktop')).catch(()=>{});
 const remaining=async()=>{const current=await host.list(root);return old.filter(p=>current.some(q=>same(p,q)));};
 const wait=async ms=>{const end=Date.now()+ms;while((await remaining()).length&&Date.now()<end)await host.sleep(150);return remaining();};
 let left=await wait(host.graceMs??10000);
 for(const p of left)await host.signal(root,p,'SIGTERM');left=await wait(host.termMs??5000);
 for(const p of left)await host.signal(root,p,'SIGKILL');left=await wait(host.killMs??2000);
 if(left.length)throw Error('本项目旧进程仍未退出，尚未启动新实例。');
 // Any process not in the captured old set belongs to a later launch; do not kill it.
 if((await host.list(root)).length)throw Error('已有新的桌宠实例启动，本次没有重复启动。');
 await host.release(root,old,oldDescriptor);
 return old.map(({pid,kind,started})=>({pid,kind,started}));
}
export async function processList(root){const {stdout}=await execute('/bin/ps',['-axo','pid=,ppid=,lstart=,command='],{env:{...process.env,LC_ALL:'en_US.UTF-8'}});return projectProcesses(root,stdout);}
async function descriptor(root){const bytes=await optional(files(root).descriptor);if(!bytes)return;try{return JSON.parse(bytes);}catch{return;}}
async function portClosed(url){
 const {createConnection}=await import('node:net');const u=new URL(url);if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('管理地址不是本机地址。');
 return new Promise(resolve=>{const s=createConnection({host:u.hostname.replace(/^\[|\]$/g,''),port:Number(u.port)});s.setTimeout(500);s.once('connect',()=>{s.destroy();resolve(false);});s.once('error',()=>{s.destroy();resolve(true);});s.once('timeout',()=>{s.destroy();resolve(false);});});
}
export async function releaseStaleBackendLock(root,previous,isAlive=pid=>{try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;return true;}}){
 const lock=files(root).backendLock,bytes=await optional(lock);if(!bytes)return false;
 const stat=lstatSync(lock);if(!stat.isFile()||stat.isSymbolicLink())throw Error('后端锁不是本项目的普通文件。');
 let owner;try{owner=JSON.parse(bytes);}catch{throw Error('后端锁内容无法核对，未自动删除。');}
 if(!Number.isSafeInteger(owner.pid)||owner.pid<=1||!Number.isFinite(Date.parse(owner.startedAt)))throw Error('后端锁身份不正确，未自动删除。');
 if(isAlive(owner.pid))throw Error('后端锁进程仍存在或PID已被复用，未自动删除。');
 const config=JSON.parse(await readFile(files(root).config));
 if(owner.phaseId!==config.phaseId||owner.sourceRevision!==config.sourceRevision||previous&&(previous.pid!==owner.pid||previous.sourceRevision!==owner.sourceRevision))throw Error('旧后端锁与当前项目状态不一致，已保留供核对。');
 const current=lstatSync(lock);if(current.ino!==stat.ino||!(await readFile(lock)).equals(bytes))throw Error('后端锁已变化，未自动删除。');
 await unlink(lock);return true;
}
export const macHost={
 list:processList,descriptor,sleep,
 async quit(root,old){for(const p of old){if((await processList(root)).some(q=>same(p,q)))await execute('/usr/bin/osascript',['-l','JavaScript','-e',"ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier("+p.pid+").terminate;"],{timeout:12000});}},
 async signal(root,p,signal){if((await processList(root)).some(q=>same(p,q)))try{process.kill(p.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;}},
 async release(root,old,previous){
  await releaseStaleBackendLock(root,previous);
  if(previous?.url){let closed=false;for(let n=0;n<20;n++){if(await portClosed(previous.url)){closed=true;break;}await sleep(100);}if(!closed)throw Error('旧管理端口仍在使用，未重复启动。');}
  const config=JSON.parse(await readFile(files(root).config));await assertTrialQuiescent(config,{allowWorkbenchRunning:true});
 },
 prepare:prepareTrialLaunch,
 inspect:plan=>inspectTrialUpdate(plan,async()=>{}),install:installTrialUpdate,
 async launch(root,plan){
  const log=await open(resolve(root,'artifacts/W0-I/trial-feedback-01/startup.log'),'a',0o600);
  const child=spawn(plan.executable,plan.arguments,{env:plan.environment,detached:true,stdio:['ignore',log.fd,log.fd]});
  let spawnError;child.once('error',()=>{spawnError=true;});child.unref();await log.close();
  const end=Date.now()+30000;
  while(Date.now()<end){
   if(spawnError)throw Error('桌宠进程未能启动。');
   const processes=await processList(root),native=processes.find(p=>p.pid===child.pid&&p.kind==='desktop'),d=await descriptor(root);
   if(native&&d?.sourceRevision===plan.version&&processes.some(p=>p.pid===d.pid&&p.ppid===native.pid&&p.kind==='backend')){
    const u=new URL(d.url),token=new URLSearchParams(u.hash.slice(1)).get('token');
    if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw Error('管理地址不是本机地址。');
    try{const response=await fetch(u.origin+'/api/snapshot',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(1000)});if(response.ok)return {desktopPid:native.pid,backendPid:d.pid,sourceRevision:plan.version,readyAt:new Date().toISOString()};}catch{}
   }
   await sleep(150);
  }
  throw Error('桌宠尚未就绪，请保留启动提示；不会重复生成实例。');
 },
};
export async function restartTrial(root,{nodePath=process.execPath,planFile,planSha256,host=macHost,requestedAt=Date.now()}={}){
 root=realpathSync(root);
 return withRestartLock(root,async()=>{
  const configBytes=await readFile(files(root).config),plan=selectUpdate(root,configBytes,planFile?await readFile(planFile):undefined,planSha256);
  await host.prepare(root,nodePath,process.env); // Verify current activation and all runtime pins before touching a process.
  if(plan)await host.inspect(plan);
  const previous=await stopPrevious(root,host);
  if(plan)await host.install(plan); // Existing exact plan, config, budget and quiescent checks remain authoritative.
  const current=await host.prepare(root,nodePath,process.env),started=await host.launch(root,current);
  return {status:'started',...started,previous,updated:!!plan};
 },requestedAt);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=key=>{const n=args.indexOf(key);return n>=0?args[n+1]:undefined;};
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
 try{
  if(args.some((a,n)=>n%2===0&&!['--root','--plan','--plan-sha256'].includes(a))||args.length%2||value('--root')&&realpathSync(value('--root'))!==realpathSync(root))throw Error('启动入口参数不正确。');
  const result=await restartTrial(root,{planFile:value('--plan'),planSha256:value('--plan-sha256'),requestedAt:Math.floor(Date.now()-process.uptime()*1000)});
  process.stdout.write(result.status==='restart_in_progress'?'正在重启桌宠，请稍候。\n':'桌宠已启动。\n');
  if(result.status!=='restart_in_progress')await writeFile(resolve(root,'artifacts/W0-I/trial-feedback-01/last-start.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
 }catch(e){process.stderr.write((e instanceof Error?e.message:message)+'\n');process.exitCode=1;}
}
