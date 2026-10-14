import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEngineProfile } from './profile.mjs';
import { engineEnvironment } from './runtime.mjs';

let boot;try{boot=JSON.parse(readFileSync(3,'utf8'));}finally{closeSync(3);}
const profile=readEngineProfile(boot.projectRoot);
if(!profile || process.execPath!==profile.runtime.nodeExecutable)throw Error('Pinned project runtime required');
const lock=join(profile.home,'.aaaagent-dsh-host.lock'),descriptor=join(profile.home,'.aaaagent-dsh-host.json');
if(JSON.parse(readFileSync(lock,'utf8')).nonce!==boot.nonce)throw Error('DSH owner changed');
writeFileSync(lock,JSON.stringify({nonce:boot.nonce,pid:process.pid}),{mode:0o600});
const env={...engineEnvironment(profile.runtime,profile.home),DSH_HOME:profile.dshHome,CODEX_HOME:profile.codexHome,DSH_TELEMETRY_DISABLED:'1',LANG:'en_US.UTF-8'};
const child=spawn(profile.runtime.nodeExecutable,[profile.runtime.dshEntrypoint,'web','--patch',profile.dshPresetOverlay,'--no-open','--host','127.0.0.1','--port','0'],
  {cwd:profile.home,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='',published=false,closing=false;
const control=createServer((req,res)=>{
  if(req.method!=='POST'||req.url!=='/stop'||req.headers.authorization!=='Bearer '+boot.nonce||req.headers.origin){res.writeHead(403);res.end();return;}
  res.writeHead(202);res.end();stop();
});
await new Promise((done,reject)=>{control.once('error',reject);control.listen(0,'127.0.0.1',done);});
control.unref();
const controlOrigin='http://127.0.0.1:'+control.address().port;
const cleanup=()=>{control.close();for(const file of [lock,descriptor])try{if(JSON.parse(readFileSync(file,'utf8')).nonce===boot.nonce)unlinkSync(file);}catch{}};
const update=bytes=>{
  log+=bytes;if(log.length>2*1024*1024)log=log.slice(-1024*1024);
  // This protected operational endpoint is consumed by native DSH transports, never an evidence/report log.
  writeFileSync(profile.dshWebLog,log,{mode:0o600});
  const match=log.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+)\/\?token=/);
  if(!published&&match){const tmp=descriptor+'.'+boot.nonce;writeFileSync(tmp,JSON.stringify({version:1,nonce:boot.nonce,
    projectRoot:boot.projectRoot,runtimeRoot:profile.runtimeRoot,home:profile.home,dataHome:profile.dshHome,inventorySha256:profile.runtime.inventorySha256,
    origin:match[1],controlOrigin,pid:process.pid,childPid:child.pid})+'\n',{flag:'wx',mode:0o600});renameSync(tmp,descriptor);published=true;}
};
child.stdout.on('data',update);child.stderr.on('data',update);
child.once('error',()=>{cleanup();process.exitCode=1;});
child.once('exit',code=>{cleanup();writeFileSync(profile.dshWebLog,log.replace(/(token=)[^\s&)]+/g,'$1[redacted]'),{mode:0o600});process.exitCode=code??1;});
function stop(){if(closing)return;closing=true;child.kill('SIGTERM');}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
