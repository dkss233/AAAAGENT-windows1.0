import Database from 'better-sqlite3';
import { prepareSocialDatabase, readPrivateSocialText } from './storage.js';
import { dirname, resolve, isAbsolute } from 'node:path';
import { CloudError, fields, id, record, text, version, type Experience, type Persona, type SocialContextPort, type SocialReference, type SyncPage } from './protocol.js';
import { endpointUrl } from './model.js';

export interface LocalConnectionConfig { version:1;enabled:boolean;roleId:string;characterId:string;endpoint:string;syncToken:string;maxAgeMs:number;maxContextCharacters:number }
/** Separate cache: never opens the private companion database and never sends a conversation. */
export class LocalSocialConnection implements SocialContextPort {
  private readonly db:Database.Database;
  private pending:Promise<void>|undefined;
  private closed=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  constructor(filename:string,readonly config:LocalConnectionConfig,private readonly request:typeof fetch=fetch,private readonly now=Date.now){
    id(config.roleId);id(config.characterId);endpointUrl(config.endpoint);
    if(config.version!==1||typeof config.enabled!=='boolean'||typeof config.syncToken!=='string'||config.syncToken.length<32||!Number.isSafeInteger(config.maxAgeMs)||config.maxAgeMs<1000||config.maxAgeMs>300000||!Number.isSafeInteger(config.maxContextCharacters)||config.maxContextCharacters<100||config.maxContextCharacters>12000)throw new CloudError('invalid_local_connection');
    prepareSocialDatabase(filename);
    this.db=new Database(filename);
    this.db.pragma('journal_mode=WAL');this.db.pragma('busy_timeout=5000');
    this.db.exec('CREATE TABLE IF NOT EXISTS state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),binding TEXT NOT NULL,epoch TEXT,cursor INTEGER NOT NULL,persona TEXT,groups_json TEXT NOT NULL,revision INTEGER NOT NULL,synced INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS social(id TEXT PRIMARY KEY,body TEXT NOT NULL,sequence INTEGER NOT NULL);');
    const binding=JSON.stringify([config.roleId,config.characterId,config.endpoint]);
    this.db.prepare("INSERT OR IGNORE INTO state VALUES(1,?,NULL,0,NULL,'[]',0,0)").run(binding);
    if((this.db.prepare('SELECT binding FROM state').get() as {binding:string}).binding!==binding){this.db.close();throw new CloudError('cache_binding_mismatch');}
  }
  private state(){return this.db.prepare('SELECT * FROM state').get() as {epoch:string|null;cursor:number;persona:string|null;groups_json:string;revision:number;synced:number};}
  async sync():Promise<void>{
    if(this.closed||!this.config.enabled)return;
    if(this.pending)return this.pending;
    this.pending=this.pull().finally(()=>{this.pending=undefined;});return this.pending;
  }
  private async pull():Promise<void>{
    // Bounded page work per tick. The cursor advances only with its atomic cache commit.
    for(let page=0;page<10;page++){
      const before=this.state(),url=new URL(`/v1/${this.config.roleId}/sync`,this.config.endpoint);url.searchParams.set('after',String(before.cursor));
      let response:Response;
      const read=()=>this.request(url,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${this.config.syncToken}`},signal:AbortSignal.timeout(5000)});
      // GET is idempotent; a restarted server may close the client's old pooled socket.
      try{response=await read();}catch(error){if(this.closed)throw error;response=await read();}
      if(!response.ok){await response.body?.cancel();throw new CloudError('sync_failed',502);}
      const raw=await boundedJson(response,256000),data=validatePage(raw,this.config.roleId,before.cursor);
      if(before.epoch&&before.epoch!==data.epoch)throw new CloudError('cloud_identity_changed',409);
      this.db.transaction(()=>{
        // Revocation applies even if no new event has changed the stream cursor.
        for(const row of this.db.prepare('SELECT id,body FROM social').all() as {id:string;body:string}[])
          if(!data.allowedGroups.includes((JSON.parse(row.body) as Experience).groupId))this.db.prepare('DELETE FROM social WHERE id=?').run(row.id);
        for(const change of data.changes){
          if(change.kind==='delete')this.db.prepare('DELETE FROM social WHERE id=?').run(change.id);
          else this.db.prepare('INSERT INTO social VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,sequence=excluded.sequence').run(change.id,JSON.stringify(change.experience),change.sequence);
        }
        const persona=JSON.stringify(data.persona),groups=JSON.stringify(data.allowedGroups);
        const changed=persona!==before.persona||groups!==before.groups_json||data.changes.length>0;
        this.db.prepare('UPDATE state SET epoch=?,cursor=?,persona=?,groups_json=?,revision=revision+?,synced=? WHERE singleton=1').run(data.epoch,data.cursor,persona,groups,+changed,data.more?0:this.now());
      })();
      if(!data.more)return;
    }
  }
  start():void{if(this.timer||this.closed||!this.config.enabled)return;void this.sync().catch(()=>{});this.timer=setInterval(()=>{void this.sync().catch(()=>{});},15000);this.timer.unref();}
  capture(characterId:string):SocialReference|undefined{
    if(this.closed||!this.config.enabled||characterId!==this.config.characterId)return;
    const state=this.state();if(!state.persona||this.now()-state.synced>this.config.maxAgeMs)return;
    const experiences:Experience[]=[];let characters=0;
    for(const row of this.db.prepare('SELECT body FROM social ORDER BY sequence DESC').iterate() as Iterable<{body:string}>){
      if(characters+row.body.length>this.config.maxContextCharacters)continue;
      experiences.push(JSON.parse(row.body));characters+=row.body.length;
    }
    return{roleId:this.config.roleId,persona:JSON.parse(state.persona),experiences,cacheRevision:state.revision};
  }
  assertCurrent(reference:SocialReference):void{
    if(this.closed||reference.roleId!==this.config.roleId)throw new CloudError('social_context_invalidated',409);
    const state=this.state();if(state.revision!==reference.cacheRevision||this.now()-state.synced>this.config.maxAgeMs)throw new CloudError('social_context_invalidated',409);
  }
  status():{roleId:string;cursor:number;cachedExperiences:number;fresh:boolean}{
    const s=this.state();return{roleId:this.config.roleId,cursor:s.cursor,cachedExperiences:(this.db.prepare('SELECT COUNT(*) AS n FROM social').get() as {n:number}).n,fresh:!!s.persona&&this.now()-s.synced<=this.config.maxAgeMs};
  }
  async close():Promise<void>{this.closed=true;if(this.timer)clearInterval(this.timer);await this.pending?.catch(()=>{});this.db.close();}
}
async function boundedJson(response:Response,max:number):Promise<unknown>{
  const reader=response.body?.getReader();if(!reader)throw new CloudError('empty_sync');let size=0;const chunks:Uint8Array[]=[];
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>max)throw new CloudError('sync_too_large');chunks.push(next.value);}}
  finally{await reader.cancel().catch(()=>{});}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new CloudError('invalid_sync_json');}
}
function validatePage(raw:unknown,roleId:string,after:number):SyncPage{
  const v=record(raw);fields(v,['version','roleId','epoch','cursor','more','persona','allowedGroups','changes']);
  if(v.version!==1||v.roleId!==roleId||typeof v.more!=='boolean'||!Array.isArray(v.allowedGroups)||!Array.isArray(v.changes)||v.changes.length>100)throw new CloudError('invalid_sync');
  const cursor=version(v.cursor);if(cursor<after||v.more&&cursor===after)throw new CloudError('invalid_cursor');
  id(v.epoch);const p=record(v.persona);fields(p,['roleId','name','persona','revision']);if(p.roleId!==roleId)throw new CloudError('persona_role_mismatch');
  const persona:Persona={roleId,name:text(p.name,80),persona:text(p.persona,3000),revision:version(p.revision)};
  const allowedGroups=v.allowedGroups.map(id);if(allowedGroups.length>1000)throw new CloudError('too_many_groups');
  let previous=after;
  const changes:SyncPage['changes']=v.changes.map(raw=>{
    const c=record(raw);fields(c,['sequence','kind','id','experience']);const sequence=version(c.sequence),changeId=id(c.id);
    if(sequence<=previous||sequence>cursor)throw new CloudError('invalid_change_order');previous=sequence;
    if(c.kind==='delete'){if(c.experience!==undefined)throw new CloudError('invalid_delete');return{sequence,kind:'delete',id:changeId};}
    if(c.kind!=='upsert')throw new CloudError('invalid_change');
    const e=record(c.experience);fields(e,['id','roleId','groupId','summary','sourceEventIds','participants','occurredAt','perspective']);
    if(e.id!==changeId||e.roleId!==roleId||e.perspective!=='participated'||!allowedGroups.includes(id(e.groupId))||!Array.isArray(e.sourceEventIds)||!e.sourceEventIds.length||!Array.isArray(e.participants)||e.participants.length>20)throw new CloudError('invalid_experience_scope');
    const occurredAt=text(e.occurredAt,32);if(!Number.isFinite(Date.parse(occurredAt)))throw new CloudError('invalid_experience_time');
    const experience:Experience={id:changeId,roleId,groupId:id(e.groupId),summary:text(e.summary,1200),sourceEventIds:e.sourceEventIds.map(id),participants:e.participants.map(raw=>{const p=record(raw);fields(p,['id','name']);return{id:id(p.id),name:text(p.name,80)};}),occurredAt,perspective:'participated'};
    return{sequence,kind:'upsert',id:changeId,experience};
  });
  return{version:1,roleId,epoch:id(v.epoch),cursor,more:v.more,persona,allowedGroups,changes};
}
/** Optional product connection; absence preserves the original local companion path. */
export function openLocalSocialConnection(projectRoot:string):LocalSocialConnection|undefined{
  const filename=resolve(projectRoot,'.local/data/social-connection.json');
  let raw:string;try{raw=readPrivateSocialText(filename);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  const v=record(JSON.parse(raw));fields(v,['version','enabled','roleId','characterId','endpoint','syncToken','maxAgeMs','maxContextCharacters']);
  if(v.enabled===false)return;
  if(!isAbsolute(projectRoot))throw new CloudError('absolute_project_root_required');
  const connection=new LocalSocialConnection(resolve(projectRoot,'.local/data/social-cache.sqlite'),v as unknown as LocalConnectionConfig);connection.start();return connection;
}
