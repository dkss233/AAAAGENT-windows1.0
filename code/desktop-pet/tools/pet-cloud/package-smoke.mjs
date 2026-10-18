import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute,sep} from 'node:path';
import {createServer} from 'node:net';
import Database from 'better-sqlite3';
import {initialize,acquireLock} from './cli.mjs';
import {startDemo} from './demo.mjs';
import {SocialStore} from '../../dist/companion/cloud/store.js';
import {DemoSocialModel} from '../../dist/companion/cloud/model.js';
import {startSocialServer} from '../../dist/companion/cloud/server.js';
import {openLocalSocialConnection} from '../../dist/companion/cloud/local.js';

function removeFixture(dir){const part=relative(resolve(tmpdir()),resolve(dir));assert.ok(part&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part));rmSync(resolve(dir),{recursive:true,force:true});}
test('public CLI links the desktop to .local data, preserves existing settings and supports disabling',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pet-public-link-'));let server,store,connection;
  try{
    const project=join(dir,'project with spaces'),service=join(dir,'service');
    assert.equal(openLocalSocialConnection(project),undefined);
    const c=initialize(service,{demo:true});store=new SocialStore(join(service,'social.sqlite'),c.roleId,c);
    server=await startSocialServer({store,model:new DemoSocialModel(),tokens:c.tokens,autoWork:false});
    const args=[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'link',service,project,server.url];
    const linked=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(linked.status,0,linked.stderr);
    const filename=join(project,'.local/data/social-connection.json'),saved=readFileSync(filename,'utf8');
    assert.equal(existsSync(join(project,'data/desktop-pet/social-connection.json')),false);
    connection=openLocalSocialConnection(project);assert.ok(connection);await connection.sync();
    assert.equal(connection.status().roleId,c.roleId);assert.equal(connection.status().fresh,true);
    assert.equal(existsSync(join(project,'.local/data/social-cache.sqlite')),true);
    assert.notEqual(spawnSync(process.execPath,args,{encoding:'utf8'}).status,0);
    assert.equal(readFileSync(filename,'utf8'),saved);
    await connection.close();connection=undefined;
    writeFileSync(filename,JSON.stringify({...JSON.parse(saved),enabled:false}),{mode:0o600});
    assert.equal(openLocalSocialConnection(project),undefined);
  }finally{await connection?.close();await server?.close();store?.close();removeFixture(dir);}
});

test('deployment startup, protected endpoint and clean shutdown',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pet-package-'));let server,store;
  try{
    const c=initialize(dir,{demo:true});store=new SocialStore(join(dir,'social.sqlite'),c.roleId,c);
    server=await startSocialServer({store,model:new DemoSocialModel(),tokens:c.tokens});
    assert.equal((await fetch(`${server.url}/health`)).status,200);
    assert.equal((await fetch(`${server.url}/v1/${c.roleId}/status`)).status,401);
  }finally{await server?.close();store?.close();removeFixture(dir);}
});
test('one runtime directory cannot start a duplicate process or overwrite credentials',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pet-lock-'));let release;
  try{initialize(dir,{demo:true});release=acquireLock(dir);assert.throws(()=>acquireLock(dir),/已有服务/);assert.throws(()=>initialize(dir),/已初始化/);}
  finally{release?.();removeFixture(dir);}
});
test('full local demonstration: private storage, offline social activity, reconnect, revocation and restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pet-demo-'));let demo;
  try{
    const c=initialize(dir,{demo:true});const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));c.port=probe.address().port;await new Promise(r=>probe.close(r));
    writeFileSync(join(dir,'service.json'),JSON.stringify(c),{mode:0o600});demo=await startDemo(dir);
    const open=async()=>{const r=await fetch(demo.url);return r.headers.get('set-cookie').split(';')[0];};let cookie=await open();
    const call=async(path,value)=>{const r=await fetch(demo.url+path,{method:value?'POST':'GET',headers:{Cookie:cookie,...(value?{'Content-Type':'application/json',Origin:demo.url}:{})},...(value?{body:JSON.stringify(value)}:{})});assert.equal(r.status,200);return r.json();};
    await call('/private',{text:'PRIVATE_PACKAGE_MARKER'});await call('/connection',{disconnected:true});await call('/group',{text:'我在离线期间完成了建模练习'});
    assert.equal((await call('/state')).experiences.length,0);await call('/connection',{disconnected:false});assert.equal((await call('/state')).experiences.length,1);
    const cloud=new Database(join(dir,'social.sqlite'),{readonly:true});assert.ok(!JSON.stringify(cloud.prepare('SELECT * FROM events').all()).includes('PRIVATE_PACKAGE_MARKER'));cloud.close();
    await call('/share',{enabled:false});assert.equal((await call('/state')).experiences.length,0);await call('/share',{enabled:true});assert.equal((await call('/state')).experiences.length,1);
    await demo.close();demo=await startDemo(dir);cookie=await open();const restored=await call('/state');assert.equal(restored.experiences.length,1);assert.equal(restored.privateNotes[0].text,'PRIVATE_PACKAGE_MARKER');
    await call('/forget',{id:restored.experiences[0].id});assert.equal((await call('/state')).experiences.length,0);
    assert.equal((await fetch(demo.url+'/private',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:'http://evil.invalid'},body:'{"text":"unexpected"}'})).status,403);
  }finally{await demo?.close();removeFixture(dir);}
});
