import { DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { readEngineProfile } from './profile.mjs';
import { sha256 } from './runtime.mjs';
import { T3ChildService } from '../t3-child-service.mjs';
import { T3HttpClient } from '../t3-http-client.mjs';

const [rootArg, runtimeArg, evidenceArg] = process.argv.slice(2);
if (!rootArg || !runtimeArg || !evidenceArg) throw Error('Expected project, full candidate runtime, unique evidence folder');
const root=resolve(rootArg), runtime=resolve(runtimeArg), evidence=resolve(evidenceArg), home=join(evidence,'candidate-home');
if (existsSync(home)) throw Error('Probe home already exists; no overwrite');
const ids={dsh:'21ce4e9b-f465-4632-8aa2-c2502c6ccc6f',codex:'fb4e6739-b2bd-4c9d-800d-fc9fa57b6872'};
const nativeIds={dsh:'t3_5a155a011a9a33055cc9255670bb39f4fcd414af',codex:'01a0fd21-31d7-77e2-9c39-d59a29daa657'};
const originalPath=join(root,'data/desktop-pet/t3-home/userdata/state.sqlite');
const fingerprint=()=>{const db=new DatabaseSync(originalPath,{readOnly:true});try {return sha256(JSON.stringify(['projection_thread_messages','projection_turns','projection_thread_activities','provider_session_runtime'].map(t=>db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all())));}finally{db.close();}};
const expectedCodexMessages=Number(process.argv[5] ?? 3), expectedCodexTurns=Number(process.argv[6] ?? 1);
if(!Number.isInteger(expectedCodexMessages)||!Number.isInteger(expectedCodexTurns)||expectedCodexMessages<3||expectedCodexTurns<1)throw Error("Expected known Codex counts");
const before=fingerprint();
const originalDb=new DatabaseSync(originalPath,{readOnly:true});
const sessionStatuses=Object.fromEntries(Object.entries(ids).map(([provider,id])=>[provider,originalDb.prepare('SELECT status FROM projection_thread_sessions WHERE thread_id=?').get(id)?.status]));
originalDb.close();
mkdirSync(join(home,'userdata'),{recursive:true,mode:0o700});
execFileSync('python3',['-c','import sqlite3,sys; a=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); b=sqlite3.connect(sys.argv[2]); a.backup(b); b.close(); a.close()',originalPath,join(home,'userdata/state.sqlite')]);
cpSync(join(root,'data/desktop-pet/t3-home/userdata/settings.json'),join(home,'userdata/settings.json'));
const profile=readEngineProfile(root),marker=JSON.parse(readFileSync(join(runtime,'.aaaagent-prepared.json'),'utf8'));
const options={sourceDir:runtime,nodeExecutable:profile.runtime.nodeExecutable,baseDir:home,logFile:join(evidence,'candidate-server.log'),dshWebLogPath:profile.dshWebLog,engineProjectRoot:root};
const result={status:'failed',modelStarts:0,nativeWrites:0,originalDatabaseWrites:0,source:marker.commit,patchSha256:marker.patchSha256,runtime,checks:[],rounds:[]};
let service;
try {
  for (let round=0;round<2;round++) {
    service=new T3ChildService(options);const connection=await service.start(),client=new T3HttpClient(service);
    const environment=await client.environmentDescriptor();
    const reads={};
    for(const [provider,id] of Object.entries(ids)) {
      let snap;
      const deadline=Date.now()+35_000;
      do { snap=await client.threadSnapshot(id,20);
        if(snap.thread?.nativeSessionObservation?.status==='ready' && snap.thread.messages.length===(provider==='dsh'?4:expectedCodexMessages)) break;
        await new Promise(done=>setTimeout(done,500));
      } while(Date.now()<deadline);
      assert.equal(snap.thread?.nativeSessionObservation?.status,'ready',provider+' observation');
      assert.equal(snap.thread.nativeSessionObservation.nativeId,nativeIds[provider]);
      assert.equal(snap.thread.messages.length,provider==='dsh'?4:expectedCodexMessages);
      assert.equal(new Set(snap.thread.messages.map(m=>m.id)).size,snap.thread.messages.length);
      assert.equal(snap.thread.session?.status,sessionStatuses[provider]);
      const oldId=provider==='codex'?'0f2cea3c-a496-4db1-9a87-87fea9975d80':'ce7c8bbc-5cd8-41e3-ab6b-fb03f6526b65';
      assert.equal(snap.thread.messages.find(m=>m.id===oldId)?.turnId,null);
      if(provider==='codex') assert.ok(snap.thread.messages.some(m=>m.id==='552cb57f-3f19-4c13-910d-81da377cc0aa'));
      const reentry=await client.threadSnapshot(id,20);assert.deepEqual(reentry.thread.messages,snap.thread.messages);
      reads[provider]={threadId:id,nativeId:nativeIds[provider],messageIds:snap.thread.messages.map(m=>m.id),observation:snap.thread.nativeSessionObservation,latestTurn:snap.thread.latestTurn,sessionStatus:snap.thread.session?.status};
      writeFileSync(join(evidence,provider+'-formal-round-'+round+'.json'),JSON.stringify(snap,null,2)+'\n',{mode:0o600});
    }
    const db=new DatabaseSync(join(home,'userdata/state.sqlite'),{readOnly:true});
    try {
      result.rounds.push({round,origin:connection.origin,environmentId:environment.environmentId,reads,
        turnCounts:Object.fromEntries(Object.entries(ids).map(([p,id])=>[p,db.prepare('SELECT count(*) AS n FROM projection_turns WHERE thread_id=?').get(id).n])),
        syncEvents:db.prepare("SELECT count(*) AS n FROM orchestration_events WHERE event_type='thread.native-session-synced'").get().n,
        latestSequence:db.prepare('SELECT max(sequence) AS n FROM orchestration_events').get().n});
    } finally {db.close();}
    await service.stop();service=null;
  }
  assert.equal(result.rounds[0].turnCounts.dsh,2);assert.equal(result.rounds[0].turnCounts.codex,expectedCodexTurns);
  assert.equal(result.rounds[1].syncEvents,result.rounds[0].syncEvents);
  assert.equal(fingerprint(),before);
  result.checks=['Original DSH second turn persisted in the same formal dialogue','Original Codex failed input and NULL bindings preserved','No duplicate after reentry or full candidate process restart','Original local runtime statuses retained independently of native observations','Original source database tables unchanged'];result.status='passed';
} catch(error) {result.failure={name:error.name,message:error.message};throw error;}
finally {if(service)await service.stop();writeFileSync(join(evidence,'actual-candidate-probe.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});}
console.log(JSON.stringify({status:result.status,checks:result.checks,rounds:result.rounds.length,modelStarts:0,originalDatabaseWrites:0}));
