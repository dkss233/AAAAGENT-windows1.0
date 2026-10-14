import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3ChildService as T3LocalService } from './t3-child-service.mjs';
import { T3LocalService as HostClient } from './t3-local-service.mjs';
import { BrowserTickets, nativeTarget } from './t3-browser.mjs';

const sourceLock = JSON.parse(readFileSync(new URL('./t3-source.json', import.meta.url), 'utf8'));
const fakeServer = `
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const boot = JSON.parse(readFileSync(3, 'utf8'));
const key = Buffer.from(process.env.AAAAGENT_T3_PROJECT_CONTEXT_HMAC, 'hex');
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json');
  if (request.url === '/oauth/token') {
    response.end(JSON.stringify({ access_token: 'local-test-token-'.repeat(4), token_type: 'Bearer', expires_in: 3600 }));
  } else if (request.url === '/api/auth/pairing-token') {
    response.end(JSON.stringify({ credential:'synthetic-pairing-only' }));
  } else if (request.url === '/api/auth/browser-session') {
    response.setHeader('Set-Cookie','t3-session-test=synthetic-cookie; Path=/; HttpOnly; SameSite=Lax');
    response.end('{}');
  } else if (request.url === '/mac') {
    response.end(JSON.stringify({ mac: createHmac('sha256', key).update('fixed payload').digest('hex') }));
  } else {
    response.end(JSON.stringify({ environmentId: 'synthetic' }));
  }
});
server.listen(boot.port, boot.host);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

test('private proof key pairs with only the current child and rotates on relaunch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aaaagent-t3-proof-'));
  const sourceDir = join(root, 'source');
  const binDir = join(sourceDir, 'apps/server/dist');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(sourceDir, '.aaaagent-prepared.json'), JSON.stringify({
    commit: sourceLock.commit, licenseSha256: sourceLock.licenseSha256,
  }));
  writeFileSync(join(sourceDir, 'package.json'), '{"type":"module"}');
  writeFileSync(join(binDir, 'bin.mjs'), fakeServer);
  const service = new T3LocalService({ sourceDir, nodeExecutable: process.execPath,
    baseDir: join(root, 'state'), logFile: join(root, 'service.log') });
  const inherited = process.env.AAAAGENT_T3_PROJECT_CONTEXT_HMAC;
  process.env.AAAAGENT_T3_PROJECT_CONTEXT_HMAC = '00'.repeat(32);
  try {
    const first = await service.start();
    const firstMac = await service.signProviderContextProof('fixed payload');
    assert.equal(firstMac, (await (await fetch(first.origin + '/mac')).json()).mac);
    assert.notEqual(firstMac, createHmacOfInheritedKey());
    assert.equal(await service.signProviderContextProof('fixed payload'), firstMac);
    await service.stop();
    const second = await service.start();
    const secondMac = await service.signProviderContextProof('fixed payload');
    assert.equal(secondMac, (await (await fetch(second.origin + '/mac')).json()).mac);
    assert.notEqual(secondMac, firstMac);
  } finally {
    await service.stop();
    if (inherited === undefined) delete process.env.AAAAGENT_T3_PROJECT_CONTEXT_HMAC;
    else process.env.AAAAGENT_T3_PROJECT_CONTEXT_HMAC = inherited;
    rmSync(root, { recursive: true, force: true });
  }
});

function createHmacOfInheritedKey() {
  return createHmac('sha256', Buffer.alloc(32)).update('fixed payload').digest('hex');
}


test('host is shared, caller detach preserves child, browser ticket consumes once, explicit stop ends child', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aaaagent-t3-host-'));
  const sourceDir = join(root, 'source'); mkdirSync(join(sourceDir,'apps/server/dist'), {recursive:true});
  writeFileSync(join(sourceDir,'.aaaagent-prepared.json'), JSON.stringify({commit:sourceLock.commit,licenseSha256:sourceLock.licenseSha256}));
  writeFileSync(join(sourceDir,'apps/server/dist/bin.mjs'),fakeServer);
  const options = {sourceDir,nodeExecutable:process.execPath,baseDir:join(root,'state'),logFile:join(root,'host.log')};
  const a = new HostClient(options), b = new HostClient(options);
  try {
    const [first, second] = await Promise.all([a.start(),b.start()]);
    assert.equal(first.pid,second.pid); assert.equal(first.origin,second.origin);
    const signature = await a.signProviderContextProof('fixed payload');
    await a.stop(); assert.equal((await b.start()).pid,first.pid);
    assert.equal(signature,await b.signProviderContextProof('fixed payload'));
    const entry = await b.openBrowser({kind:'home',environmentId:'synthetic'});
    const url = new URL(entry.url), ticket = url.hash.slice(1);
    assert.ok(!entry.url.includes(first.accessToken));
    const headers = {Origin:url.origin,'Content-Type':'application/json'};
    const denied = await fetch(url.origin+'/launch',{method:'POST',headers:{...headers,Origin:'https://elsewhere.invalid'},body:JSON.stringify({ticket})});
    assert.equal(denied.status,503);
    const launch = await fetch(url.origin+'/launch',{method:'POST',headers,body:JSON.stringify({ticket})});
    assert.equal(launch.status,200); assert.match(launch.headers.get('set-cookie'),/HttpOnly/);
    assert.deepEqual(await launch.json(),{url:first.origin+'/'});
    assert.equal((await fetch(url.origin+'/launch',{method:'POST',headers,body:JSON.stringify({ticket})})).status,503);
    await b.stopBackground();
    for(let i=0;i<50;i++){try{process.kill(first.pid,0);await new Promise(r=>setTimeout(r,100));}catch{break;}}
    assert.throws(()=>process.kill(first.pid,0));
  } finally {
    await b.stopBackground().catch(()=>{});
    rmSync(root,{recursive:true,force:true});
  }
});

test('navigation expires, stays exact, never falls back across native identities', async () => {
  let now = 1000; const tickets = new BrowserTickets(()=>now);
  const ticket=tickets.issue({kind:'home'});now+=60001;assert.throws(()=>tickets.consume(ticket.ticket));
  let project='p',provider='codex';
  const c={environmentDescriptor:async()=>({environmentId:'e'}),shellSnapshot:async()=>({projects:[{id:project,workspaceRoot:'/tmp/project'}]}),
    threadSnapshot:async()=>({thread:{id:'t',projectId:project,modelSelection:{instanceId:provider}}})};
  const target={kind:'task',environmentId:'e',t3ProjectId:'p',workspaceRoot:'/tmp/project',threadId:'t',providerInstanceId:'codex'};
  assert.equal(await nativeTarget(c,target),'/e/t');provider='dsh';await assert.rejects(nativeTarget(c,target));provider='codex';
  project='other';await assert.rejects(nativeTarget(c,target));
  await assert.rejects(nativeTarget(c,{...target,environmentId:'elsewhere'}));
});


test('a separate launcher exits naturally while its detached host and child remain available', async () => {
  const root=mkdtempSync(join(tmpdir(),'aaaagent-t3-launcher-exit-'));
  const sourceDir=join(root,'source');mkdirSync(join(sourceDir,'apps/server/dist'),{recursive:true});
  writeFileSync(join(sourceDir,'.aaaagent-prepared.json'),JSON.stringify({commit:sourceLock.commit,licenseSha256:sourceLock.licenseSha256}));
  writeFileSync(join(sourceDir,'apps/server/dist/bin.mjs'),fakeServer);
  const options={sourceDir,nodeExecutable:process.execPath,baseDir:join(root,'state'),logFile:join(root,'host.log')};
  const launcher=spawn(process.execPath,['--input-type=module','-e',
    `import {T3LocalService} from ${JSON.stringify(new URL('./t3-local-service.mjs',import.meta.url).href)};
     const service=new T3LocalService(${JSON.stringify(options)});await service.start();await service.stop();console.log('ready');`],
    {stdio:['ignore','pipe','pipe']});
  const exited=once(launcher,'exit');const service=new HostClient(options);
  let timer;
  try {
    await once(launcher.stdout,'data');
    const before=await service.status();
    const code=await Promise.race([exited.then(([code])=>code),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('launcher retained by detached host bootstrap pipe')),3000);})]);
    clearTimeout(timer);assert.equal(code,0);
    const after=await service.status();assert.equal(after.hostPid,before.hostPid);assert.equal(after.pid,before.pid);
    assert.equal((await (await fetch(after.origin+'/mac')).json()).mac,await service.signProviderContextProof('fixed payload'));
  } finally {
    clearTimeout(timer);await service.stopBackground().catch(()=>{});
    if(launcher.exitCode===null)launcher.kill('SIGKILL');await exited;
    rmSync(root,{recursive:true,force:true});
  }
});
