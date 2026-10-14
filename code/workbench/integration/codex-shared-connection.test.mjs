import test from 'node:test';
import assert from 'node:assert/strict';
import { codexSharedTransport, readCodexSharedConnection, inspectSharedCodexSocket, originalAppSharedSession } from './codex-shared-connection.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, lstat, readlink, rm, chmod, cp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createUnixServer } from 'node:net';
import { once } from 'node:events';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const root='/controlled/project', home='/controlled/codex';
const transport=codexSharedTransport(home);
function fixture() {
  const receipt={version:1,status:'active',transport:'shared-unix',codexHome:home,...transport,
    activatedAt:'2026-10-05T16:00:00Z',originalAppTransportSha256:'a'.repeat(64),
    originalAppPid:101,serverPid:102,socketDevice:1,socketInode:2,
    originalProviderLaunchArgsSha256:createHash('sha256').update('').digest('hex'),
    proof:{originalAppConnected:true,sameServerObserved:true,originalMcpPreserved:true,originalSkillsPreserved:true,providerTransportVerified:true}};
  const settings={providerInstances:{codex:{enabled:true,driver:'codex',config:{binaryPath:join(root,'artifacts/runtime/engine-bindings/codex'),homePath:home,launchArgs:''}}}};
  const fileStat={isFile:()=>true,isSymbolicLink:()=>false,uid:501,mode:0o600};
  const socketStat={isSocket:()=>true,isSymbolicLink:()=>false,uid:501,mode:0o600,dev:1,ino:2};
  const parentStat={isDirectory:()=>true,isSymbolicLink:()=>false,uid:501,mode:0o700};
  const live=new Set([101,102]);
  const options={uid:501,stat:path=>path===transport.socketPath?socketStat:path===dirname(transport.socketPath)?parentStat:fileStat,
    read:path=>JSON.stringify(path.endsWith('settings.json')?settings:receipt),realpath:value=>value,alive:pid=>live.has(pid)};
  return {receipt,settings,fileStat,socketStat,live,options,read:()=>readCodexSharedConnection(root,home,options)};
}
test('both native transports name the same private Unix owner without a TCP listener',()=>{
  assert.equal(transport.desktopWebsocketUrl,'ws+unix:///controlled/codex/app-server-control/app-server-control.sock:/rpc');
  assert.equal(transport.providerLaunchArgs,"--aaaagent-shared-unix '/controlled/codex/app-server-control/app-server-control.sock'");
  for(const path of ['relative','/bad:socket','/bad\npath','/'+ 'a'.repeat(120)])assert.throws(()=>codexSharedTransport(path));
  assert.equal(fixture().read()?.socketPath,transport.socketPath);
});
test('the fixed native socket alias is accepted only at its exact protected path and owner',()=>{
  const f=fixture(), original=f.options.stat, physical='/private/tmp/codex-daemon-501/'+createHash('sha256').update(transport.socketPath).digest('hex');
  const directory={isDirectory:()=>true,isSymbolicLink:()=>false,uid:501,mode:0o700};
  f.options.stat=path=>path===transport.socketPath?{isSymbolicLink:()=>true,uid:501}:
    path===physical?f.socketStat:path==='/private/tmp/codex-daemon-501'?directory:original(path);
  f.options.realpath=path=>path==='/tmp'?'/private/tmp':path===transport.socketPath?physical:path;
  assert.equal(f.read()?.socketPath,transport.socketPath);
  directory.mode=0o755;assert.equal(f.read(),null);directory.mode=0o700;
  f.options.realpath=path=>path==='/tmp'?'/private/tmp':path===transport.socketPath?'/foreign.sock':path;
  assert.equal(f.read(),null);
});
test('a planned receipt or unverified original App connection cannot enable imported conversation writes',()=>{
  for(const change of [f=>{f.receipt.status='prepared';},f=>{f.receipt.proof.originalAppConnected=false;},
    f=>{f.receipt.proof.sameServerObserved=false;},f=>{f.receipt.codexHome='/foreign';},
    f=>{f.receipt.proof.originalMcpPreserved=false;},f=>{f.receipt.proof.originalSkillsPreserved=false;},
    f=>{f.receipt.proof.providerTransportVerified=false;},
    f=>{f.receipt.socketPath='/foreign.sock';},f=>{f.receipt.originalAppPid=f.receipt.serverPid;}]){
    const f=fixture();change(f);assert.equal(f.read(),null);
  }
});
test('App/server exit, socket replacement and provider transport drift close admission immediately',()=>{
  for(const change of [f=>{f.live.delete(101);},f=>{f.live.delete(102);},f=>{f.socketStat.ino++;},
    f=>{f.socketStat.mode=0o666;},f=>{f.socketStat.uid=502;},f=>{f.fileStat.mode=0o644;},
    f=>{f.settings.providerInstances.codex.config.launchArgs='--changed';},f=>{f.settings.providerInstances.codex.enabled=false;}]){
    const f=fixture();change(f);assert.equal(f.read(),null);
  }
});

test('an imported SID needs its own original-owner tools proof even when the shared server is live',()=>{
  const f=fixture(), sid='original-sid';
  f.options.nativeSessionId=sid;
  assert.equal(f.read(),null);
  f.receipt.sharedSessions={[sid]:{nativeSessionId:sid,sameOwnerObserved:true,
    originalMcpPreserved:true,originalSkillsPreserved:true,ownerConfigurationSha256:'b'.repeat(64)}};
  assert.equal(f.read()?.socketPath,transport.socketPath);
  for(const field of ['sameOwnerObserved','originalMcpPreserved','originalSkillsPreserved']){
    f.receipt.sharedSessions[sid][field]=false;assert.equal(f.read(),null);
    f.receipt.sharedSessions[sid][field]=true;
  }
  f.options.nativeSessionId='different-sid';assert.equal(f.read(),null);
  f.options.nativeSessionId=sid;f.receipt.sharedSessions[sid].ownerConfigurationSha256='unverified';
  assert.equal(f.read(),null);
});

test('original App metadata borrows the verified owner; a wrong SID/cwd or lost receipt never starts a private writer',
  {timeout:10000},async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const root=await mkdtemp('/private/tmp/aaa-owner-'),home=join(root,'codex'),sid='fixture-original-sid';
  const route=codexSharedTransport(home),input={binaryPath:join(root,'artifacts/runtime/engine-bindings/codex'),
    homePath:home,cwd:join(root,'workspace'),threadId:'import:codex:'+sid,resumeCursor:{threadId:sid}};
  await mkdir(dirname(route.socketPath),{recursive:true,mode:0o700});
  await mkdir(join(root,'data/desktop-pet/t3-home/userdata'),{recursive:true});
  const server=createUnixServer(),peer=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  t.after(async()=>{
    peer.kill('SIGTERM');if(peer.exitCode===null&&peer.signalCode===null)await once(peer,'exit');
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true});
  });
  server.listen(route.socketPath);await once(server,'listening');await chmod(route.socketPath,0o600);
  const socket=await stat(route.socketPath),database=new DatabaseSync(join(home,'state_5.sqlite'));
  database.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,originator TEXT,archived INTEGER)');
  database.prepare('INSERT INTO threads VALUES (?,?,?,0)').run(sid,input.cwd,'Codex Desktop');
  database.prepare('INSERT INTO threads VALUES (?,?,?,0)').run('fixture-cli-sid',input.cwd,'codex_cli_rs');database.close();
  await writeFile(join(root,'data/desktop-pet/t3-home/userdata/settings.json'),JSON.stringify({providerInstances:{codex:{
    enabled:true,driver:'codex',config:{binaryPath:input.binaryPath,homePath:home,launchArgs:''}}}}));
  const receipt={version:1,status:'active',transport:'shared-unix',codexHome:home,...route,
    activatedAt:new Date().toISOString(),originalAppTransportSha256:'a'.repeat(64),originalAppPid:peer.pid,
    serverPid:process.pid,socketDevice:socket.dev,socketInode:socket.ino,
    originalProviderLaunchArgsSha256:createHash('sha256').update('').digest('hex'),
    proof:{originalAppConnected:true,sameServerObserved:true,originalMcpPreserved:true,originalSkillsPreserved:true,providerTransportVerified:true},
    sharedSessions:{[sid]:{nativeSessionId:sid,sameOwnerObserved:true,originalMcpPreserved:true,
      originalSkillsPreserved:true,ownerConfigurationSha256:'b'.repeat(64)}}};
  const receiptPath=join(root,'data/desktop-pet/codex-shared-connection.json');
  await writeFile(receiptPath,JSON.stringify(receipt),{mode:0o600});
  assert.deepEqual(await originalAppSharedSession(input),{kind:'shared',launchArgs:route.providerLaunchArgs});
  for(const change of [{cwd:'/different'}, {resumeCursor:{threadId:'wrong'}}, {resumeCursor:undefined}])
    assert.deepEqual(await originalAppSharedSession({...input,...change}),{kind:'unavailable'});
  assert.deepEqual(await originalAppSharedSession({...input,threadId:'normal-t3-thread'}),{kind:'native'});
  assert.deepEqual(await originalAppSharedSession({...input,threadId:'import:codex:fixture-cli-sid',
    resumeCursor:{threadId:'fixture-cli-sid'}}),{kind:'native'});
  await rm(receiptPath);assert.deepEqual(await originalAppSharedSession(input),{kind:'unavailable'});
});

test('real pinned shared server accepts websocket and JSON-lines bridge peers on one SID without model generation',
  {skip:!process.env.NATIVE_CODEX_SHARED_BINARY},async t=>{
  const binary=process.env.NATIVE_CODEX_SHARED_BINARY, wsModule=process.env.NATIVE_MOUNT_WS_MODULE;
  const evidence=process.env.NATIVE_CODEX_SHARED_EVIDENCE;
  assert.ok(binary?.endsWith('/codex/bin/codex')&&wsModule&&evidence?.includes('/native-input-repair-01/'));
  const WebSocket=(await import(pathToFileURL(wsModule).href)).default;
  const home=await mkdtemp('/private/tmp/aaa-shared-');
  const workspace=join(home,'workspace');await mkdir(workspace);
  const route=codexSharedTransport(home);let modelCalls=0;
  const model=createServer((req,res)=>{modelCalls++;res.statusCode=503;res.end('Generation excluded');});
  model.listen(0,'127.0.0.1');await once(model,'listening');
  await writeFile(join(home,'config.toml'),`model="gpt-6.1-sol"\nmodel_provider="fixture"\n[model_providers.fixture]\nname="No generation fixture"\nbase_url="http://127.0.0.1:${model.address().port}/v1"\nwire_api="responses"\n`,{mode:0o600});
  const environment={...process.env,CODEX_HOME:home};delete environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  // A saved, metadata-only fixture represents an existing SID. A brand new empty
  // thread/start has no rollout yet and cannot exercise the existing-history path.
  const fixtureSID=randomUUID(), stamp=new Date().toISOString();
  const sessionDir=join(home,'sessions',stamp.slice(0,4),stamp.slice(5,7),stamp.slice(8,10));
  await mkdir(sessionDir,{recursive:true,mode:0o700});
  await writeFile(join(sessionDir,'rollout-'+stamp.replace(/[:.]/g,'-')+'-'+fixtureSID+'.jsonl'),
    JSON.stringify({timestamp:stamp,type:'session_meta',payload:{id:fixtureSID,timestamp:stamp,cwd:workspace,
      originator:'desktop_shared_fixture',cli_version:'0.160.0',source:'vscode',model_provider:'fixture',
      base_instructions:{text:'Synthetic metadata fixture; no user work or model generation'}}})+'\n',{mode:0o600});
  const server=spawn(binary,['app-server','--listen','unix://'],{env:environment,stdio:['ignore','pipe','pipe']});
  let serverErrors='';server.stderr.on('data',bytes=>{serverErrors+=String(bytes);});server.stdout.resume();
  let desktop,proxy;
  const record={version:1,scope:'Real fixed Codex0.160 transport in private empty temporary home; original App/home untouched',
    protocolMethods:[],peers:['original-style Unix WebSocket','T3-style JSON-lines/WebSocket bridge'],
    originalHomeMutation:false,originalNativeSIDChanges:0,isolatedMetadataSIDsCreated:0,
    syntheticSavedMetadataFixtures:1,nativeTurns:0,modelCalls:0,status:'failed'};
  let bridgeNode=process.execPath;
  let bridgeArgs=[fileURLToPath(new URL('./codex-shared-stdio.mjs',import.meta.url)),home,wsModule];
  function peer(send,subscribe,label){
    let next=0;const pending=new Map(),notifications=[];
    subscribe(raw=>{
      let data;try{data=JSON.parse(String(raw));}catch{return;}
      if(data.id!=null&&pending.has(data.id)){
        const p=pending.get(data.id);pending.delete(data.id);clearTimeout(p.timer);
        data.error?p.reject(Error(JSON.stringify(data.error))):p.resolve(data.result);
      }else if(data.method)notifications.push({method:data.method,threadId:data.params?.threadId??data.params?.thread?.id});
    });
    return {notifications,request(method,params){
      assert.ok(['initialize','thread/start','thread/resume','thread/read','thread/loaded/list','thread/name/set'].includes(method));
      record.protocolMethods.push({peer:label,method});const id=++next;
      return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(Error('Protocol timeout: '+method));},10000);
        pending.set(id,{resolve,reject,timer});send({id,method,params});});
    },notify(method,params){send({method,params});}};
  }
  try{
    const deadline=Date.now()+10000;
    while(Date.now()<deadline){try{if((await stat(route.socketPath)).isSocket())break;}catch{}
      if(server.exitCode!==null)throw Error('Owned server exited before socket readiness');
      await new Promise(resolve=>setTimeout(resolve,25));}
    const socketStat=await lstat(route.socketPath);
    record.socket={isSocket:socketStat.isSocket(),isFile:socketStat.isFile(),isSymbolicLink:socketStat.isSymbolicLink(),mode:socketStat.mode};
    if(socketStat.isSymbolicLink())record.socket.link=await readlink(route.socketPath);
    if(socketStat.isFile()){
      const locator=JSON.parse(await readFile(route.socketPath,'utf8'));
      record.socket.locatorKeys=Object.keys(locator);
    }
    assert.ok((await stat(route.socketPath)).isSocket(),JSON.stringify(record.socket));
    const checkedSocket=inspectSharedCodexSocket(route.socketPath);record.socket.checked=checkedSocket;
    if(process.env.NATIVE_CODEX_SHARED_LAUNCHER==='1'){
      const project=join(home,'launcher-project'),engine=resolve(binary,'../../..');
      const engineCopy=join(project,'artifacts/runtime',engine.split('/').at(-1));
      await mkdir(dirname(engineCopy),{recursive:true});
      const cloned=spawnSync('/bin/cp',['-cR',engine,engineCopy]);assert.equal(cloned.status,0);
      const integration=join(project,'code/workbench/integration');await mkdir(join(integration,'engine-pins'),{recursive:true});
      for(const name of ['codex-shared-connection.mjs','codex-shared-stdio.mjs'])
        await cp(fileURLToPath(new URL('./'+name,import.meta.url)),join(integration,name));
      for(const name of ['launch.mjs','runtime.mjs','engine-lock.json','runtime-source.json','package-lock.json'])
        await cp(fileURLToPath(new URL('./engine-pins/'+name,import.meta.url)),join(integration,'engine-pins',name));
      const wsCopy=join(project,'artifacts/runtime/engine-pin-54/t3-runtime/apps/server/node_modules/ws');
      await mkdir(dirname(wsCopy),{recursive:true});await cp(dirname(wsModule),wsCopy,{recursive:true});
      await mkdir(join(project,'data/desktop-pet/t3-home/userdata'),{recursive:true});
      await writeFile(join(project,'data/desktop-pet/t3-home/userdata/settings.json'),JSON.stringify({providerInstances:{codex:{
        enabled:true,driver:'codex',config:{homePath:home,binaryPath:join(project,'artifacts/runtime/engine-bindings/codex'),launchArgs:''}}}}));
      // Synthetic activation proof belongs only to this controlled transport fixture.
      await writeFile(join(project,'data/desktop-pet/codex-shared-connection.json'),JSON.stringify({
        version:1,status:'active',transport:'shared-unix',codexHome:home,...route,activatedAt:stamp,
        originalAppTransportSha256:'a'.repeat(64),originalAppPid:process.pid,serverPid:server.pid,
        socketDevice:checkedSocket.device,socketInode:checkedSocket.inode,
        originalProviderLaunchArgsSha256:createHash('sha256').update('').digest('hex'),
        proof:{originalAppConnected:true,sameServerObserved:true,originalMcpPreserved:true,
          originalSkillsPreserved:true,providerTransportVerified:true}}),{mode:0o600});
      bridgeNode=join(engineCopy,'node/bin/node');
      bridgeArgs=[join(integration,'engine-pins/launch.mjs'),engineCopy,'codex','app-server','--aaaagent-shared-unix',route.socketPath];
      record.launcher={used:true,scope:'Exact pinned launcher with fixture-only receipt; no actual App activation'};
    }
    desktop=new WebSocket(route.desktopWebsocketUrl);await once(desktop,'open');
    const a=peer(frame=>desktop.send(JSON.stringify(frame)),callback=>desktop.on('message',callback),'desktop');
    proxy=spawn(bridgeNode,bridgeArgs,{env:environment,stdio:['pipe','pipe','pipe']});
    proxy.stderr.resume();let buffer='';
    const b=peer(frame=>proxy.stdin.write(JSON.stringify(frame)+'\n'),callback=>proxy.stdout.on('data',bytes=>{
      buffer+=String(bytes);let offset;while((offset=buffer.indexOf('\n'))>=0){callback(buffer.slice(0,offset));buffer=buffer.slice(offset+1);}}),'web');
    const initialize=name=>({clientInfo:{name,version:'0.1.0'},capabilities:{experimentalApi:true}});
    const av=await a.request('initialize',initialize('desktop_shared_fixture'));a.notify('initialized',{});
    const bv=await b.request('initialize',initialize('t3_shared_fixture'));b.notify('initialized',{});
    record.initialization={desktopUserAgent:av.userAgent,webUserAgent:bv.userAgent};
    assert.ok(av.userAgent.includes('/0.160.0')&&bv.userAgent.includes('/0.160.0'));
    const sid=fixtureSID;record.isolatedSID=sid;
    const started=await a.request('thread/resume',{threadId:sid,cwd:workspace,model:'gpt-6.1-sol',modelProvider:'fixture',sandbox:'read-only',approvalPolicy:'never',excludeTurns:true});
    assert.equal(started.thread.id,sid);
    const resumed=await b.request('thread/resume',{threadId:sid,cwd:workspace,excludeTurns:true});
    assert.equal(resumed.thread.id,sid);assert.equal(resumed.thread.cwd,workspace);
    await a.request('thread/name/set',{threadId:sid,name:'shared fixture A'});
    assert.equal((await b.request('thread/read',{threadId:sid,includeTurns:true})).thread.name,'shared fixture A');
    await b.request('thread/name/set',{threadId:sid,name:'shared fixture B'});
    assert.equal((await a.request('thread/read',{threadId:sid,includeTurns:true})).thread.name,'shared fixture B');
    for(const client of [a,b])assert.ok((await client.request('thread/loaded/list',{})).data.includes(sid));
    record.notifications={desktop:a.notifications,web:b.notifications};
    for(const client of [a,b])assert.ok(client.notifications.some(event=>event.method==='thread/name/updated'&&event.threadId===sid));
    const final=(await a.request('thread/read',{threadId:sid,includeTurns:true})).thread;
    assert.equal(final.turns.length,0);assert.equal(modelCalls,0);
    record.modelCalls=modelCalls;record.checks=['One backend and original SID retained across both transports',
      'Both peers change/read shared metadata and receive exact-SID native notifications','Zero native turns/model requests'];record.status='passed';
  }finally{
    desktop?.terminate();proxy?.stdin.end();proxy?.kill('SIGTERM');server.kill('SIGTERM');
    if(server.exitCode===null)await once(server,'exit').catch(()=>{});
    // Only this isolated server's startup lock, after its verified exit and no open FD.
    if(record.socket?.link){
      const ownedLock=record.socket.link+'.lock';
      const holders=spawnSync('/usr/sbin/lsof',['-t',ownedLock],{encoding:'utf8'});
      const lock=await lstat(ownedLock).catch(()=>null);
      if(server.exitCode!==null&&holders.status===1&&!holders.stdout.trim()&&lock?.isFile()&&lock.uid===process.getuid()){
        await rm(ownedLock);record.fixtureStartupLockRemoved=true;
      }
    }
    model.closeAllConnections();await new Promise(resolve=>model.close(resolve));
    record.modelCalls=modelCalls;record.serverStderrBytes=Buffer.byteLength(serverErrors);
    await mkdir(evidence,{recursive:true,mode:0o700});await writeFile(join(evidence,'result.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
    await rm(home,{recursive:true,force:true});
  }
});
