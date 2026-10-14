import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from '../../desktop-pet/node_modules/better-sqlite3/lib/index.js';
import { T3ChildService } from './t3-child-service.mjs';
import { T3HttpClient } from './t3-http-client.mjs';
import { t3TerminalMaterial } from '../../desktop-pet/dist/app/terminal-material.js';
import { normalizeProjectRecentTurns } from '../../desktop-pet/dist/app/project-context.js';
import { WorkbenchService } from '../../desktop-pet/dist/app/workbench-service.js';
import { SqliteWorkbenchStore } from '../../desktop-pet/dist/app/workbench-store.js';
import { SqliteProjectMemory } from '../../desktop-pet/dist/projects/project-memory-sqlite.js';
import { createProjectTerminalExtractor } from '../../desktop-pet/dist/projects/project-terminal-extractor.js';

const enabled = process.env.T3_MATERIAL_SOURCE && process.env.T3_MATERIAL_NODE && process.env.T3_MATERIAL_EVIDENCE;
test('fixed T3 SQLite and authenticated HTTP provide exact Codex/DSH user bindings to AAA without models',
  { skip: !enabled }, async () => {
  const sourceDir = resolve(process.env.T3_MATERIAL_SOURCE);
  const nodeExecutable = resolve(process.env.T3_MATERIAL_NODE);
  const evidenceDir = resolve(process.env.T3_MATERIAL_EVIDENCE);
  mkdirSync(evidenceDir, { recursive: true });
  const run = mkdtempSync(join(evidenceDir, 'http-'));
  const home = join(run, 'home'), baseDir = join(run, 't3-home'), projectRoot = join(run, 'project');
  for (const path of [home, join(baseDir, 'userdata'), projectRoot]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(baseDir, 'userdata/settings.json'), JSON.stringify({
    projectSettingsFolded: true, providers: Object.fromEntries(
      ['codex','dsh','claudeAgent','cursor','grok','opencode','antigravity'].map(p => [p, { enabled: false }])) }), { mode: 0o600 });
  const old = Object.fromEntries(['HOME','CODEX_HOME','DSH_HOME','PATH'].map(k => [k, process.env[k]]));
  Object.assign(process.env, { HOME: home, CODEX_HOME: join(home,'.codex'), DSH_HOME: join(home,'.dsh'),
    PATH: `${dirname(nodeExecutable)}:/usr/bin:/bin` });
  const native = new T3ChildService({ sourceDir, nodeExecutable, baseDir, logFile: join(run,'t3.log') });
  const client = new T3HttpClient(native);
  let db, store, memory;
  try {
    const connection = await native.start();
    assert.equal((await fetch(connection.origin + '/api/orchestration/threads/absent?turnLimit=1')).status,401);
    await client.createCommand({ type:'project.create', commandId:'create-project', projectId:'native-project',
      title:'Exact turn material isolated fixture', workspaceRoot:projectRoot, createdAt:'2026-09-28T00:00:00.000Z' });
    for (const provider of ['codex','dsh']) await client.createCommand({ type:'thread.create', commandId:`create-${provider}`,
      threadId:`thread-${provider}`, projectId:'native-project', title:`${provider} fixture only`,
      modelSelection:{ instanceId:provider, model:'synthetic-no-provider' }, runtimeMode:'approval-required',
      interactionMode:'default', branch:null, worktreePath:null, createdAt:'2026-09-28T00:00:00.000Z' });
    await native.stop();
    const filename = join(baseDir,'userdata/state.sqlite'); db = new Database(filename);
    const insertMessage = db.prepare(`INSERT INTO projection_thread_messages
      (message_id,thread_id,turn_id,role,text,is_streaming,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)`);
    const insertTurn = db.prepare(`INSERT INTO projection_turns
      (thread_id,turn_id,pending_message_id,state,requested_at,started_at,completed_at,assistant_message_id,checkpoint_files_json)
      VALUES(?,?,?,?,?,?,?,?,'[]')`);
    const inputs = [];
    db.transaction(() => {
      for (const provider of ['codex','dsh']) {
        const threadId = `thread-${provider}`;
        for (const [ordinal,state,phase] of [[1,'completed','completed'],[2,'error','failed'],[3,'interrupted','cancelled'],[4,'completed','completed']]) {
          const turnId = `${provider}-turn-${ordinal}`, userId = `${provider}-user-${ordinal}`, assistantId = `${provider}-assistant-${ordinal}`;
          const at = `2026-09-28T00:0${ordinal}:00.000Z`, earlier='2026-09-27T23:00:00.000Z';
          insertTurn.run(threadId,turnId,userId,state,at,at,at,assistantId);
          // Actual provider projection shape: user turn_id NULL, user timestamp precedes its turn anchor.
          insertMessage.run(userId,threadId,null,'user',`Original ${provider} input ${ordinal}`,earlier,earlier);
          insertMessage.run(assistantId,threadId,turnId,'assistant',`Original ${provider} answer ${ordinal}`,at,at);
          inputs.push({ provider, threadId, turnId, userId, assistantId, at, phase });
        }
        insertMessage.run(`${provider}-stray`,threadId,null,'user','Unassigned text must not be borrowed',
          '2026-09-28T00:04:01.000Z','2026-09-28T00:04:01.000Z');
        db.prepare('UPDATE projection_threads SET latest_turn_id=? WHERE thread_id=?').run(`${provider}-turn-4`,threadId);
      }
    })();
    const messagesBefore = db.prepare('SELECT * FROM projection_thread_messages ORDER BY message_id').all();db.close();db=undefined;
    const environment = await client.environmentDescriptor();
    const project={ id:'logical-project', name:'Fixture', abstract:'', detailRef:{rootPath:projectRoot},version:1,updatedAt:'2026-09-28T00:00:00.000Z' };
    store = new SqliteWorkbenchStore(join(run,'workbench.sqlite'));
    store.bindProject(project,environment.environmentId,{id:'native-project',workspaceRoot:projectRoot},projectRoot);
    const tasks = new Map(); const snapshots=[];
    for (const provider of ['codex','dsh']) {
      const ref={id:`task-${provider}`,projectId:project.id,provider,origin:'t3',environmentId:environment.environmentId,
        t3ProjectId:'native-project',threadId:`thread-${provider}`,providerInstanceId:provider};
      const full=await client.threadSnapshot(ref.threadId,50);store.saveVerifiedTask(ref,full.thread);tasks.set(provider,ref);
      const recent=normalizeProjectRecentTurns(ref,full);
      assert.equal(recent.turns.length,4);assert.ok(recent.turns.every(t=>t.messages[0].role==='user'));
      assert.ok(full.thread.messages.filter(m=>m.role==='user').every(m=>m.turnId===null));
      let page=await client.threadSnapshot(ref.threadId,1);const sequence=page.snapshotSequence;const seen=[];
      for (let index=4;index>=1;index--) {
        const source=inputs.find(x=>x.provider===provider&&x.turnId===`${provider}-turn-${index}`);
        const evidence={projectId:project.id,taskId:ref.id,nativeTurnId:source.turnId,terminalEventId:`terminal-${source.turnId}`,
          terminalPhase:source.phase,occurredAt:source.at,extractionVersion:'b54-t3-terminal-v1',
          ...(source.phase==='completed'?{resultRef:`t3:${ref.environmentId}:${ref.threadId}:message:${source.assistantId}`}:{})};
        const material=t3TerminalMaterial(ref,evidence,page).material;
        assert.equal(page.snapshotSequence,sequence);assert.deepEqual(material.userMessages.map(m=>m.id),[source.userId]);
        assert.equal(material.assistantMessage?.id,source.phase==='completed'?source.assistantId:undefined);
        assert.ok(!seen.includes(source.userId));seen.push(source.userId);
        snapshots.push({provider,ordinal:index,snapshotSequence:sequence,rawUserTurnId:page.thread.messages.find(m=>m.id===source.userId).turnId,
          userId:source.userId,phase:source.phase});
        if(index>1) {assert.equal(page.page.hasMore,true);page=await client.threadSnapshot(ref.threadId,1,page.page.beforeCursor);}
      }
      assert.equal(page.page.hasMore,false);
      for (const [index,source] of inputs.filter(x=>x.provider===provider).entries()) {
        store.recordEvent({eventId:`started-${source.turnId}`,taskId:ref.id,sequence:index*2+1,phase:'running',
          observedAt:source.at,nativeTurnId:source.turnId,evidence:'native_read'});
        store.recordEvent({eventId:`terminal-${source.turnId}`,taskId:ref.id,sequence:index*2+2,phase:source.phase,
          observedAt:source.at,nativeTurnId:source.turnId,evidence:'native_read',
          ...(source.phase==='completed'?{resultRef:`t3:${ref.environmentId}:${ref.threadId}:message:${source.assistantId}`}:{})});
      }
    }
    let service;const captured=[];
    memory = new SqliteProjectMemory(join(run,'memory.sqlite'),{autoProcess:false,
      extractor:createProjectTerminalExtractor({readTerminalMaterial:e=>service.readTerminalMaterial(e)},async material=>{
        captured.push({turn:material.evidence.nativeTurnId,user:material.userMessages.map(x=>x.id)});return {outcome:'no_change'};
      })});
    const pagedClient = {environmentDescriptor:()=>client.environmentDescriptor(), shellSnapshot:()=>client.shellSnapshot(),
      threadSnapshot:(id,_limit,cursor)=>client.threadSnapshot(id,1,cursor),
      async dispatch(){throw Error('No provider dispatch allowed');}, readReceipt:id=>client.readReceipt(id)};
    service = new WorkbenchService({async get(id){return id===project.id?project:null;}},store,pagedClient,false,memory);
    await service.recoverTerminalDelivery();
    const queued=await memory.listJobs(project.id);assert.equal(queued.length,8);
    await memory.runPending();assert.equal(captured.length,queued.length);assert.equal(new Set(captured.map(x=>x.turn)).size,8);
    assert.ok((await memory.listJobs(project.id)).every(j=>j.state==='done'&&j.attempts===1));
    assert.deepEqual(await memory.list({projectId:project.id,limit:20}),[]);
    assert.equal(await service.recoverTerminalDelivery(),0);
    await native.stop();db=new Database(filename,{readonly:true});
    assert.deepEqual(db.prepare('SELECT * FROM projection_thread_messages ORDER BY message_id').all(),messagesBefore);
    db.close();db=undefined;
    // Same home cold read also retains exact source binding, without provider dispatch.
    const restored=await client.threadSnapshot('thread-dsh',1);
    assert.equal(restored.turnMessageBindings.turns[0].userMessageId,'dsh-user-4');
    writeFileSync(join(evidenceDir,'http-result.json'),JSON.stringify({status:'passed',method:'fixed T3 isolated real SQLite and authenticated HTTP; explicit native-shaped fixtures, no real provider',
      snapshots,queued:queued.length,captured,rawMessagesUnchanged:true,coldRead:true,modelCalls:0,productionWrites:0,runDirectory:run},null,2)+'\n',{mode:0o600});
  } finally {
    db?.close();await memory?.close();store?.close();await native.stop();
    for(const[k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  }
});
