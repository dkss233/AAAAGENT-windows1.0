import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { prepareSocialDatabase } from './storage.js';
import { dirname } from 'node:path';
import { CloudError, id, text, version, type Persona, type GroupPolicy, type SocialEvent, type SocialModelReply, type Experience, type SyncPage, type SocialModelInput, type ConfirmedParticipation } from './protocol.js';

type Job = { event_id:string; payload:string; hash:string; state:string; attempt:number; delivery_attempt:number; support:string; reply:string|null; external_reply:string|null; summary:string|null; receipt:string|null; lease:string|null; persona_revision:number|null; policy_revision:number|null; error:string|null };
export class SocialStore {
  readonly db: Database.Database;
  readonly epoch: string;
  constructor(filename: string, readonly roleId: string, initial: { name:string; persona:string }) {
    id(roleId);
    prepareSocialDatabase(filename);
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), role_id TEXT NOT NULL, epoch TEXT NOT NULL, name TEXT NOT NULL, persona TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (group_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, share INTEGER NOT NULL, reply_mode TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, reply TEXT, summary TEXT, receipt TEXT, lease TEXT, persona_revision INTEGER, policy_revision INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS experiences (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, body TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS changes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, group_id TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL);`);
    if(!(this.db.pragma('table_info(events)') as {name:string}[]).some(column=>column.name==='delivery_attempt'))this.db.exec('ALTER TABLE events ADD COLUMN delivery_attempt INTEGER NOT NULL DEFAULT 0');
    if(!(this.db.pragma('table_info(events)') as {name:string}[]).some(column=>column.name==='support'))this.db.exec("ALTER TABLE events ADD COLUMN support TEXT NOT NULL DEFAULT '[]'");
    if(!(this.db.pragma('table_info(events)') as {name:string}[]).some(column=>column.name==='external_reply'))this.db.exec('ALTER TABLE events ADD COLUMN external_reply TEXT');
    this.db.prepare('INSERT OR IGNORE INTO identity VALUES(1,?,?,?,?,1)').run(roleId, randomUUID(), text(initial.name,80), text(initial.persona,3000));
    const row = this.db.prepare('SELECT * FROM identity WHERE singleton=1').get() as {role_id:string;epoch:string};
    if (row.role_id !== roleId) { this.db.close(); throw new CloudError('database_role_mismatch'); }
    this.epoch = row.epoch;
  }
  close(): void { this.db.close(); }
  persona(): Persona {
    const r = this.db.prepare('SELECT * FROM identity WHERE singleton=1').get() as {name:string;persona:string;revision:number};
    return {roleId:this.roleId,name:r.name,persona:r.persona,revision:r.revision};
  }
  setPersona(name: string, persona: string, expected: number): Persona {
    if (!this.db.prepare('UPDATE identity SET name=?,persona=?,revision=revision+1 WHERE singleton=1 AND revision=?').run(text(name,80),text(persona,3000),version(expected)).changes) throw new CloudError('persona_conflict',409);
    return this.persona();
  }
  policy(groupId: string): GroupPolicy | undefined {
    const r=this.db.prepare('SELECT * FROM groups WHERE group_id=?').get(id(groupId)) as {enabled:number;share:number;reply_mode:'all'|'addressed';revision:number}|undefined;
    return r ? {groupId,enabled:!!r.enabled,shareWithOwner:!!r.share,replyMode:r.reply_mode,revision:r.revision} : undefined;
  }
  policies(): GroupPolicy[] { return (this.db.prepare('SELECT group_id FROM groups ORDER BY group_id').all() as {group_id:string}[]).map(r=>this.policy(r.group_id)!); }
  setPolicy(input: Omit<GroupPolicy,'revision'>, expected: number): GroupPolicy {
    id(input.groupId); version(expected);
    if (typeof input.enabled!=='boolean'||typeof input.shareWithOwner!=='boolean'||!['all','addressed'].includes(input.replyMode)) throw new CloudError('invalid_policy');
    return this.db.transaction(()=>{
      const old=this.policy(input.groupId);
      if(!old&&(this.db.prepare('SELECT COUNT(*) AS n FROM groups').get() as {n:number}).n>=200)throw new CloudError('group_limit',409);
      if ((old?.revision??0)!==expected) throw new CloudError('policy_conflict',409);
      this.db.prepare('INSERT INTO groups VALUES(?,?,?,?,?) ON CONFLICT(group_id) DO UPDATE SET enabled=excluded.enabled,share=excluded.share,reply_mode=excluded.reply_mode,revision=excluded.revision')
        .run(input.groupId,+input.enabled,+input.shareWithOwner,input.replyMode,expected+1);
      if (input.enabled && input.shareWithOwner && (!old?.enabled || !old.shareWithOwner)) {
        for (const row of this.db.prepare('SELECT id FROM experiences WHERE group_id=? AND deleted=0').all(input.groupId) as {id:string}[])
          this.db.prepare('INSERT INTO changes(id,group_id,kind) VALUES(?,?,?)').run(row.id,input.groupId,'upsert');
      }
      if (!input.enabled) this.db.prepare("UPDATE events SET state='ignored',lease=NULL WHERE json_extract(payload,'$.groupId')=? AND state IN ('pending','generating','ready')").run(input.groupId);
      return this.policy(input.groupId)!;
    })();
  }
  accept(event: SocialEvent): {eventId:string;state:string;duplicate:boolean} {
    if(event.roleId!==this.roleId)throw new CloudError('role_mismatch',403);
    const payload=JSON.stringify(event),hash=createHash('sha256').update(payload).digest('hex');
    return this.db.transaction(()=>{
      const old=this.job(event.eventId);
      if(old){if(old.hash!==hash)throw new CloudError('event_id_conflict',409);return{eventId:event.eventId,state:old.state,duplicate:true};}
      const policy=this.policy(event.groupId);
      if(!policy?.enabled)throw new CloudError('group_not_enabled',403);
      if ((this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE state IN ('pending','generating','ready','delivering')").get() as {n:number}).n>=200)throw new CloudError('queue_full',429);
      const state=event.addressed||policy.replyMode==='all'?'pending':'observed';
      this.db.prepare('INSERT INTO events(event_id,payload,hash,state) VALUES(?,?,?,?)').run(event.eventId,payload,hash,state);
      return{eventId:event.eventId,state,duplicate:false};
    })();
  }
  job(eventId:string):Job|undefined{return this.db.prepare('SELECT * FROM events WHERE event_id=?').get(id(eventId)) as Job|undefined;}
  /** Existing QQ answers keep their own bug/search pipeline; summarize only an actual receipt. */
  acceptParticipation(input:ConfirmedParticipation):{eventId:string;state:string;duplicate:boolean} {
    const {event}=input;
    if(event.roleId!==this.roleId)throw new CloudError('role_mismatch',403);
    const reply=text(input.reply,1200),receipt=id(input.receipt),payload=JSON.stringify(event);
    const hash=createHash('sha256').update(JSON.stringify({event,reply,receipt})).digest('hex');
    return this.db.transaction(()=>{
      const old=this.job(event.eventId);
      if(old){if(old.hash!==hash)throw new CloudError('event_id_conflict',409);return{eventId:event.eventId,state:old.state,duplicate:true};}
      if(!this.policy(event.groupId)?.enabled)throw new CloudError('group_not_enabled',403);
      if((this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE state IN ('pending','generating','ready','delivering')").get() as {n:number}).n>=200)throw new CloudError('queue_full',429);
      this.db.prepare("INSERT INTO events(event_id,payload,hash,state,reply,external_reply,receipt) VALUES(?,?,?,'pending',?,?,?)").run(event.eventId,payload,hash,reply,reply,receipt);
      return{eventId:event.eventId,state:'pending',duplicate:false};
    })();
  }
  recover():void {this.db.prepare("UPDATE events SET state='unknown',error='interrupted_model_call',lease=NULL WHERE state='generating'").run();this.db.prepare("UPDATE events SET state='delivery_unknown',error='interrupted_delivery',lease=NULL WHERE state='delivering'").run();}
  claim(maxRequestsPerDay:number): {job:Job; input:SocialModelInput; lease:string}|undefined {
    return this.db.transaction(()=>{
      const job=this.db.prepare("SELECT * FROM events WHERE state='pending' ORDER BY rowid LIMIT 1").get() as Job|undefined;
      if(!job)return;
      const event=JSON.parse(job.payload) as SocialEvent,policy=this.policy(event.groupId);
      if(!policy?.enabled){this.db.prepare("UPDATE events SET state='ignored' WHERE event_id=?").run(event.eventId);return;}
      const day=new Date().toISOString().slice(0,10);
      const used=(this.db.prepare('SELECT requests FROM usage WHERE day=?').get(day) as {requests:number}|undefined)?.requests??0;
      if(used>=maxRequestsPerDay)return;
      this.db.prepare('INSERT INTO usage VALUES(?,1) ON CONFLICT(day) DO UPDATE SET requests=requests+1').run(day);
      const persona=this.persona(),lease=randomUUID();
      this.db.prepare("UPDATE events SET state='generating',attempt=attempt+1,lease=?,persona_revision=?,policy_revision=? WHERE event_id=?").run(lease,persona.revision,policy.revision,event.eventId);
      const rows=this.db.prepare("SELECT payload,reply,state,support FROM events WHERE json_extract(payload,'$.groupId')=? AND state!='forgotten' AND rowid<(SELECT rowid FROM events WHERE event_id=?) ORDER BY rowid DESC LIMIT 20").all(event.groupId,event.eventId) as {payload:string;reply:string|null;state:string;support:string}[];
      const history:SocialModelInput['history']=[];
      const support=new Set([event.eventId]);
      for(const row of rows.reverse()){const e=JSON.parse(row.payload) as SocialEvent;support.add(e.eventId);history.push({actorId:e.actorId,actorName:e.actorName,text:e.text,role:'user',sourceEventId:e.eventId});if(row.state==='delivered'&&row.reply)history.push({actorId:this.roleId,actorName:persona.name,text:row.reply,role:'assistant',sourceEventId:e.eventId});}
      const experiences:Experience[]=[];let characters=0;
      for(const row of this.db.prepare('SELECT body FROM experiences WHERE group_id=? AND deleted=0 ORDER BY rowid DESC').iterate(event.groupId) as Iterable<{body:string}>){
        const experience=JSON.parse(row.body) as Experience;
        if(!experience.participants.some(person=>person.id===event.actorId)||characters+row.body.length>6000)continue;
        experiences.push(experience);characters+=row.body.length;support.add(experience.id);
      }
      this.db.prepare('UPDATE events SET support=? WHERE event_id=?').run(JSON.stringify([...support]),event.eventId);
      return{job:this.job(event.eventId)!,input:{persona,event,history,experiences,...(job.external_reply?{confirmedParticipation:{reply:job.external_reply,receipt:job.receipt!}}:{})},lease};
    })();
  }
  complete(eventId:string,lease:string,result:SocialModelReply):void {
    const reply=text(result.text,1200),summary=text(result.summary,1200);
    this.db.transaction(()=>{
      const job=this.job(eventId);if(!job||job.state!=='generating'||job.lease!==lease)throw new CloudError('stale_job',409);
      const event=JSON.parse(job.payload) as SocialEvent,policy=this.policy(event.groupId);
      if(job.external_reply){
        this.db.prepare("UPDATE events SET state='delivering',reply=?,summary=?,error=NULL WHERE event_id=?").run(job.external_reply,summary,eventId);
        this.acknowledge(eventId,lease,job.receipt!);
        return;
      }
      if(!policy?.enabled||policy.revision!==job.policy_revision||this.persona().revision!==job.persona_revision){this.fail(eventId,lease,'configuration_changed',false);return;}
      this.db.prepare("UPDATE events SET state='ready',reply=?,summary=?,lease=NULL,error=NULL WHERE event_id=?").run(reply,summary,eventId);
    })();
  }
  fail(eventId:string,lease:string,code:string,retryable:boolean):void {
    const job=this.job(eventId); if(!job||job.state!=='generating'||job.lease!==lease)return;
    const state=retryable&&job.attempt<3?'pending':code==='model_outcome_unknown'?'unknown':'failed';
    this.db.prepare('UPDATE events SET state=?,error=?,lease=NULL WHERE event_id=?').run(state,code,eventId);
  }
  claimDelivery(): {deliveryId:string;groupId:string;text:string;lease:string}|null {
    return this.db.transaction(()=>{
      const job=this.db.prepare("SELECT * FROM events WHERE state='ready' ORDER BY rowid LIMIT 1").get() as Job|undefined;if(!job)return null;
      const event=JSON.parse(job.payload) as SocialEvent,policy=this.policy(event.groupId);
      if(!policy?.enabled||policy.revision!==job.policy_revision||this.persona().revision!==job.persona_revision){this.db.prepare("UPDATE events SET state='failed',error='configuration_changed' WHERE event_id=?").run(job.event_id);return null;}
      const lease=randomUUID();this.db.prepare("UPDATE events SET state='delivering',lease=?,delivery_attempt=delivery_attempt+1 WHERE event_id=?").run(lease,job.event_id);
      return{deliveryId:job.event_id,groupId:event.groupId,text:job.reply!,lease};
    })();
  }
  acknowledge(eventId:string,lease:string,receipt:string):void {
    id(receipt);
    this.db.transaction(()=>{
      const job=this.job(eventId);if(!job)throw new CloudError('event_missing',404);
      if(job.state==='delivered'&&job.receipt===receipt)return;
      if(job.state!=='delivering'||job.lease!==lease)throw new CloudError('delivery_conflict',409);
      this.db.prepare("UPDATE events SET state='delivered',receipt=?,lease=NULL WHERE event_id=?").run(receipt,eventId);
      const event=JSON.parse(job.payload) as SocialEvent;
      const policy=this.policy(event.groupId);
      // Keep the real delivery receipt, but do not publish a summary generated under withdrawn settings.
      if(!policy?.enabled||policy.revision!==job.policy_revision||this.persona().revision!==job.persona_revision){
        this.db.prepare("UPDATE events SET summary=NULL,error='configuration_changed_after_claim' WHERE event_id=?").run(eventId);
        return;
      }
      const experience:Experience={id:eventId,roleId:this.roleId,groupId:event.groupId,summary:job.summary!,sourceEventIds:[...new Set([eventId,...JSON.parse(job.support) as string[],receipt])],participants:[{id:event.actorId,name:event.actorName}],occurredAt:event.occurredAt,perspective:'participated'};
      this.db.prepare('INSERT INTO experiences(id,group_id,body) VALUES(?,?,?)').run(eventId,event.groupId,JSON.stringify(experience));
      this.db.prepare("INSERT INTO changes(id,group_id,kind) VALUES(?,?,'upsert')").run(eventId,event.groupId);
    })();
  }
  deliveryFailed(eventId:string,lease:string,outcome:'not_sent'|'unknown'):void{
    const job=this.job(eventId);
    if(!job||job.state!=='delivering'||job.lease!==lease)throw new CloudError('delivery_conflict',409);
    if(!['not_sent','unknown'].includes(outcome))throw new CloudError('invalid_delivery_outcome');
    const state=outcome==='unknown'?'delivery_unknown':job.delivery_attempt<3?'ready':'delivery_failed';
    this.db.prepare('UPDATE events SET state=?,error=?,lease=NULL WHERE event_id=?').run(state,`channel_${outcome}`,eventId);
  }
  forget(experienceId:string):void {
    this.db.transaction(()=>{
      const row=this.db.prepare('SELECT group_id FROM experiences WHERE id=? AND deleted=0').get(id(experienceId)) as {group_id:string}|undefined;
      if(!row)throw new CloudError('experience_missing',404);
      const affected=new Set([experienceId]);const jobs=this.db.prepare('SELECT event_id,support,receipt FROM events').all() as {event_id:string;support:string;receipt:string|null}[];
      const root=jobs.find(job=>job.event_id===experienceId);if(root?.receipt)affected.add(root.receipt);
      let grew=true;while(grew){grew=false;for(const job of jobs)if(!affected.has(job.event_id)&&(JSON.parse(job.support) as string[]).some(source=>affected.has(source))){affected.add(job.event_id);if(job.receipt)affected.add(job.receipt);grew=true;}}
      for(const target of affected){
        const child=this.db.prepare('SELECT group_id FROM experiences WHERE id=? AND deleted=0').get(target) as {group_id:string}|undefined;
        if(child){this.db.prepare("UPDATE experiences SET deleted=1,body='' WHERE id=?").run(target);this.db.prepare("INSERT INTO changes(id,group_id,kind) VALUES(?,?,'delete')").run(target,child.group_id);}
        this.db.prepare("UPDATE events SET state='forgotten',reply=NULL,summary=NULL,lease=NULL WHERE event_id=?").run(target);
      }
      this.db.prepare("UPDATE events SET payload=json_set(payload,'$.text','[已遗忘]','$.actorName','[已遗忘]') WHERE event_id=?").run(experienceId);
    })();
  }
  sync(after:number):SyncPage {
    version(after);
    return this.db.transaction(()=>{
      const high=(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM changes').get() as {n:number}).n;
      if(after>high)throw new CloudError('cursor_ahead',409);
      const rows=this.db.prepare('SELECT * FROM changes WHERE sequence>? ORDER BY sequence LIMIT 10').all(after) as {sequence:number;id:string;group_id:string;kind:'upsert'|'delete'}[];
      const allowedGroups=this.policies().filter(g=>g.enabled&&g.shareWithOwner).map(g=>g.groupId);
      const changes:SyncPage['changes']=[];
      for(const row of rows){if(!allowedGroups.includes(row.group_id))continue;
        const r=this.db.prepare('SELECT body,deleted FROM experiences WHERE id=?').get(row.id) as {body:string;deleted:number};
        changes.push({sequence:row.sequence,kind:r.deleted?'delete':'upsert',id:row.id,...(r.deleted?{}:{experience:JSON.parse(r.body) as Experience})});
      }
      const cursor=rows.at(-1)?.sequence??after;
      return{version:1 as const,roleId:this.roleId,epoch:this.epoch,cursor,more:cursor<high,persona:this.persona(),allowedGroups,changes};
    })();
  }
  status():object {return{roleId:this.roleId,persona:this.persona(),groups:this.policies(),jobs:this.db.prepare('SELECT state,COUNT(*) AS count FROM events GROUP BY state').all(),usage:this.db.prepare('SELECT * FROM usage ORDER BY day DESC LIMIT 7').all()};}
  jobs():object[]{return this.db.prepare('SELECT event_id AS eventId,state,attempt,error FROM events ORDER BY rowid DESC LIMIT 200').all() as object[];}
  resolveJob(eventId:string,action:'skip'|'retry-model'|'retry-delivery'|'confirm-delivered',receipt?:string):void{
    this.db.transaction(()=>{
      const job=this.job(eventId);if(!job)throw new CloudError('event_missing',404);
      if(!['failed','unknown','delivery_unknown','delivery_failed'].includes(job.state))throw new CloudError('job_not_resolvable',409);
      if(action==='skip'){this.db.prepare("UPDATE events SET state='skipped',lease=NULL WHERE event_id=?").run(eventId);return;}
      if(action==='retry-model'&&['failed','unknown'].includes(job.state)){this.db.prepare("UPDATE events SET state='pending',attempt=0,error=NULL WHERE event_id=?").run(eventId);return;}
      if(action==='retry-delivery'&&['delivery_unknown','delivery_failed'].includes(job.state)){this.db.prepare("UPDATE events SET state='ready',error=NULL,delivery_attempt=0 WHERE event_id=?").run(eventId);return;}
      if(action==='confirm-delivered'&&job.state==='delivery_unknown'&&receipt){const lease=randomUUID();this.db.prepare("UPDATE events SET state='delivering',lease=? WHERE event_id=?").run(lease,eventId);this.acknowledge(eventId,lease,receipt);return;}
      throw new CloudError('invalid_resolution');
    })();
  }
}
