import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { CloudError, parseEvent, type SocialEvent, type SocialReference } from '../../companion/cloud/protocol.js';
import { SocialStore } from '../../companion/cloud/store.js';
import { DemoSocialModel, OpenAICompatibleSocialModel, socialMessages } from '../../companion/cloud/model.js';
import { LocalSocialConnection, type LocalConnectionConfig } from '../../companion/cloud/local.js';
import { startSocialServer, SocialWorker } from '../../companion/cloud/server.js';
import { JsonDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport, denyPaidCalls, type EndpointConfig, type JsonRecord } from '../../providers/transport.js';
import { buildDialogueRequest } from '../../providers/dialogue-request.js';
import { hostClock } from '../../providers/host-clock.js';
import type { DialogueRequest } from '../../contracts/index.js';

function removeFixture(dir:string):void{const part=relative(resolve(tmpdir()),resolve(dir));assert.ok(part&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part));rmSync(resolve(dir),{recursive:true,force:true});}
const roleId='pet-one',tokens={admin:'a'.repeat(40),channel:'b'.repeat(40),sync:'c'.repeat(40)};
const event=(overrides:Partial<SocialEvent>={}):SocialEvent=>({eventId:'e1',roleId,scope:'group',groupId:'group-a',actorId:'person-a',actorName:'小李',text:'我开始学 Blender 了',occurredAt:'2026-10-15T03:00:00.000Z',addressed:true,...overrides});
function store(file=':memory:'){const s=new SocialStore(file,roleId,{name:'桌宠',persona:'温和自然，有自己的判断。'});s.setPolicy({groupId:'group-a',enabled:true,shareWithOwner:true,replyMode:'addressed'},0);return s;}
const config=(endpoint:string):LocalConnectionConfig=>({version:1,enabled:true,roleId,characterId:'companion',endpoint,syncToken:tokens.sync,maxAgeMs:300000,maxContextCharacters:6000});
async function deliver(s:SocialStore,e=event()){
  s.accept(e);await new SocialWorker(s,new DemoSocialModel()).tick();const d=s.claimDelivery();assert.ok(d);s.acknowledge(d.deliveryId,d.lease,`${e.eventId}:receipt`);return d;
}
async function fixture(){const s=store();const server=await startSocialServer({store:s,model:new DemoSocialModel(),tokens,autoWork:false});const local=new LocalSocialConnection(':memory:',config(server.url));return{s,server,local,async close(){await local.close();await server.close();s.close();}};}

test('transport rejects private scopes, extra private fields, invalid roles and event-ID collisions',()=>{
  const s=store();try{
    assert.throws(()=>parseEvent({...event(),scope:'private'}),/group_events_only/);
    assert.throws(()=>parseEvent({...event(),privateHistory:'secret'}),/unexpected_field/);
    assert.throws(()=>s.accept(event({roleId:'another'})),/role_mismatch/);
    assert.throws(()=>s.accept(event({groupId:'other'})),/group_not_enabled/);
    assert.equal(s.accept(event()).duplicate,false);assert.equal(s.accept(event()).duplicate,true);
    assert.throws(()=>s.accept(event({text:'changed'})),/event_id_conflict/);
  }finally{s.close();}
});
test('only a confirmed delivery becomes a social experience; duplicate ACK and repeated input are idempotent',async()=>{
  const s=store();try{
    s.accept(event());await new SocialWorker(s,new DemoSocialModel()).tick();assert.equal(s.sync(0).changes.length,0);
    const d=s.claimDelivery()!;assert.equal(s.sync(0).changes.length,0);
    s.acknowledge(d.deliveryId,d.lease,'receipt-1');s.acknowledge(d.deliveryId,d.lease,'receipt-1');
    const p=s.sync(0);assert.equal(p.changes.length,1);assert.equal(p.changes[0]!.experience!.participants[0]!.id,'person-a');
    s.accept(event());assert.equal(await new SocialWorker(s,new DemoSocialModel()).tick(),false);
    assert.throws(()=>s.acknowledge(d.deliveryId,d.lease,'different-receipt'),/delivery_conflict/);
  }finally{s.close();}
});
test('model sees only its current group and preserves distinct human identities',async()=>{
  const s=store();try{
    await deliver(s,event({eventId:'a1'}));s.setPolicy({groupId:'group-b',enabled:true,shareWithOwner:false,replyMode:'all'},0);
    s.accept(event({eventId:'b1',groupId:'group-b',text:'B 群秘密'}));
    let captured='';await new SocialWorker(s,{async reply(input){captured=JSON.stringify(socialMessages(input));return{text:'收到',summary:'我在 B 群回复了小李'};}}).tick();
    assert.ok(!captured.includes('Blender'));assert.ok(captured.includes('B 群秘密'));assert.ok(captured.includes('person-a'));
    const d=s.claimDelivery()!;s.acknowledge(d.deliveryId,d.lease,'b-receipt');assert.equal(s.sync(0).changes.length,1);
  }finally{s.close();}
});
test('observed ambient messages are not claimed as participation and persona edits require CAS',async()=>{
  const s=store();try{
    s.accept(event({addressed:false}));assert.equal(await new SocialWorker(s,new DemoSocialModel()).tick(),false);
    assert.equal(s.sync(0).changes.length,0);
    assert.equal(s.setPersona('桌宠','新的公开人设',1).revision,2);assert.throws(()=>s.setPersona('桌宠','旧写入',1),/persona_conflict/);
    assert.throws(()=>s.setPolicy({groupId:'group-a',enabled:true,shareWithOwner:false,replyMode:'all'},0),/policy_conflict/);
  }finally{s.close();}
});
test('policy changes during inference prevent a stale reply from being delivered',async()=>{
  const s=store();try{s.accept(event());await new SocialWorker(s,{async reply(){s.setPolicy({groupId:'group-a',enabled:false,shareWithOwner:false,replyMode:'all'},1);return{text:'stale',summary:'stale'};}}).tick();assert.equal(s.claimDelivery(),null);assert.equal(s.sync(0).changes.length,0);}finally{s.close();}
});
test('settings changed after a delivery claim preserve the receipt without publishing an outdated experience',async()=>{
  for(const change of ['persona','group'] as const){
    const s=store();try{
      s.accept(event());await new SocialWorker(s,new DemoSocialModel()).tick();const d=s.claimDelivery()!;
      if(change==='persona')s.setPersona('桌宠','更新后的公开设定',1);
      else s.setPolicy({groupId:'group-a',enabled:false,shareWithOwner:false,replyMode:'all'},1);
      s.acknowledge(d.deliveryId,d.lease,'actual-receipt');s.acknowledge(d.deliveryId,d.lease,'actual-receipt');
      assert.equal(s.job('e1')!.state,'delivered');assert.equal(s.job('e1')!.receipt,'actual-receipt');
      assert.equal(s.job('e1')!.summary,null);assert.equal(s.job('e1')!.error,'configuration_changed_after_claim');
      if(change==='group')s.setPolicy({groupId:'group-a',enabled:true,shareWithOwner:true,replyMode:'all'},2);
      assert.equal(s.sync(0).changes.length,0);assert.equal(s.claimDelivery(),null);
    }finally{s.close();}
  }
});
test('restart preserves confirmed experience and marks interrupted requests unknown without retry',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pet-cloud-'));const file=join(dir,'cloud.sqlite');let s=store(file);
  try{await deliver(s);s.accept(event({eventId:'interrupted'}));assert.ok(s.claim(100));s.close();s=new SocialStore(file,roleId,{name:'ignored',persona:'ignored'});s.recover();assert.equal(s.job('interrupted')!.state,'unknown');assert.equal(await new SocialWorker(s,new DemoSocialModel()).tick(),false);assert.equal(s.sync(0).changes.length,1);assert.equal(s.persona().name,'桌宠');}
  finally{s.close();removeFixture(dir);}
});
test('interrupted delivery is not automatically resent; explicit rejection retries at most three attempts',async()=>{
  const s=store();try{
    s.accept(event());let calls=0;const w=new SocialWorker(s,{async reply(){calls++;throw new CloudError('model_retryable',502);}});
    for(let n=0;n<5;n++)await w.tick();assert.equal(calls,3);assert.equal(s.job('e1')!.state,'failed');
    s.accept(event({eventId:'e2'}));await new SocialWorker(s,new DemoSocialModel()).tick();assert.ok(s.claimDelivery());s.recover();assert.equal(s.job('e2')!.state,'delivery_unknown');assert.equal(s.claimDelivery(),null);
  }finally{s.close();}
});
test('daily request ceiling stops additional model calls without discarding received messages',async()=>{
  const s=store();try{s.accept(event());s.accept(event({eventId:'e2'}));const w=new SocialWorker(s,new DemoSocialModel(),1);assert.equal(await w.tick(),true);assert.equal(await w.tick(),false);assert.equal(s.job('e2')!.state,'pending');}finally{s.close();}
});
test('operator can reconcile a previously delivered message after restart without resending it',async()=>{
  const s=store();try{
    s.accept(event());await new SocialWorker(s,new DemoSocialModel()).tick();assert.ok(s.claimDelivery());s.recover();
    assert.equal(s.job('e1')!.state,'delivery_unknown');s.resolveJob('e1','confirm-delivered','verified-channel-receipt');
    assert.equal(s.job('e1')!.state,'delivered');assert.equal(s.claimDelivery(),null);assert.equal(s.sync(0).changes.length,1);
  }finally{s.close();}
});
test('delivery failures retain the prepared reply with bounded retries and ambiguous sends await reconciliation',async()=>{
  const s=store();try{
    s.accept(event());await new SocialWorker(s,new DemoSocialModel()).tick();
    for(let n=0;n<3;n++){const d=s.claimDelivery()!;assert.ok(d);s.deliveryFailed(d.deliveryId,d.lease,'not_sent');}
    assert.equal(s.claimDelivery(),null);assert.equal(s.job('e1')!.state,'delivery_failed');assert.equal(s.job('e1')!.attempt,1);
    s.resolveJob('e1','retry-delivery');const d=s.claimDelivery()!;s.deliveryFailed(d.deliveryId,d.lease,'unknown');assert.equal(s.job('e1')!.state,'delivery_unknown');assert.equal(s.claimDelivery(),null);assert.equal(s.sync(0).changes.length,0);
  }finally{s.close();}
});
test('pagination synchronizes large multi-byte summaries without skipping or duplicating records',async()=>{
  const f=await fixture();try{
    for(let n=0;n<45;n++){
      const e=event({eventId:`long-${n}`});f.s.accept(e);const claim=f.s.claim(100)!;f.s.complete(e.eventId,claim.lease,{text:'收到',summary:'测'.repeat(1200)});const d=f.s.claimDelivery()!;f.s.acknowledge(d.deliveryId,d.lease,`receipt-${n}`);
    }
    assert.ok(Buffer.byteLength(JSON.stringify(f.s.sync(0)))<256000);
    await f.local.sync();assert.equal(f.local.status().cachedExperiences,45);assert.equal(f.local.status().cursor,45);
    await f.local.sync();assert.equal(f.local.status().cachedExperiences,45);assert.equal(f.local.status().cursor,45);
  }finally{await f.close();}
});
test('forgetting invalidates derived experiences, queued replies and local references transitively',async()=>{
  const f=await fixture();try{
    await deliver(f.s,event({eventId:'origin',text:'原始社交事实'}));await deliver(f.s,event({eventId:'derived',text:'刚才聊过的事情'}));
    f.s.accept(event({eventId:'late'}));const running=f.s.claim(100)!;
    await f.local.sync();assert.equal(f.local.status().cachedExperiences,2);f.s.forget('origin');
    assert.equal(f.s.job('derived')!.state,'forgotten');assert.equal(f.s.job('late')!.state,'forgotten');
    assert.throws(()=>f.s.complete('late',running.lease,{text:'迟到回复',summary:'迟到摘要'}),/stale_job/);
    await f.local.sync();assert.equal(f.local.status().cachedExperiences,0);
  }finally{await f.close();}
});
test('HTTP separates admin, channel, sync rights and rejects browser or private-history ingestion',async()=>{
  const f=await fixture();try{
    const root=`${f.server.url}/v1/${roleId}`;
    assert.equal((await fetch(`${f.server.url}/health`)).status,200);
    assert.equal((await fetch(`${root}/sync`)).status,401);
    assert.equal((await fetch(`${root}/status`,{headers:{Authorization:`Bearer ${tokens.sync}`}})).status,403);
    assert.equal((await fetch(`${root}/sync`,{headers:{Authorization:`Bearer ${tokens.sync}`,Origin:'http://evil.invalid'}})).status,403);
    assert.equal((await fetch(`${root}/events`,{method:'POST',headers:{Authorization:`Bearer ${tokens.channel}`,'Content-Type':'application/json'},body:JSON.stringify({...event(),scope:'private'})})).status,400);
    assert.equal((await fetch(`${root}/events`,{method:'POST',headers:{Authorization:`Bearer ${tokens.sync}`,'Content-Type':'application/json'},body:JSON.stringify(event())})).status,403);
    assert.equal((await fetch(`${f.server.url}/v1/another/sync`,{headers:{Authorization:`Bearer ${tokens.sync}`}})).status,404);
  }finally{await f.close();}
});
test('HTTP sync carries permitted summaries only, invalidates revoked contexts and replays a regrant',async()=>{
  const f=await fixture();try{
    await deliver(f.s);await f.local.sync();const before=f.local.capture('companion')!;assert.equal(before.experiences.length,1);assert.equal(f.local.capture('another'),undefined);
    f.s.setPolicy({groupId:'group-a',enabled:true,shareWithOwner:false,replyMode:'all'},1);await f.local.sync();assert.equal(f.local.capture('companion')!.experiences.length,0);assert.throws(()=>f.local.assertCurrent(before),/invalidated/);
    f.s.setPolicy({groupId:'group-a',enabled:true,shareWithOwner:true,replyMode:'all'},2);await f.local.sync();assert.equal(f.local.capture('companion')!.experiences.length,1);
    const restored=f.local.capture('companion')!;f.s.forget('e1');await f.local.sync();assert.equal(f.local.capture('companion')!.experiences.length,0);assert.throws(()=>f.local.assertCurrent(restored),/invalidated/);
    assert.ok(!JSON.stringify(f.s.status()).includes('Blender'));
  }finally{await f.close();}
});
test('desktop sync never posts private text; restart resumes cursor and stale offline cache expires',async()=>{
  const f=await fixture(),dir=mkdtempSync(join(tmpdir(),'pet-cache-'));let now=Date.now(),calls:{method:unknown;body:unknown}[]=[];
  const request:typeof fetch=async(input,init)=>{calls.push({method:init?.method,body:init?.body});return fetch(input,init);};
  let local=new LocalSocialConnection(join(dir,'cache.sqlite'),config(f.server.url),request,()=>now);
  try{
    await deliver(f.s);await local.sync();await local.close();local=new LocalSocialConnection(join(dir,'cache.sqlite'),config(f.server.url),request,()=>now);await local.sync();
    assert.equal(local.capture('companion')!.experiences.length,1);assert.ok(calls.every(c=>c.method==='GET'&&c.body===undefined));
    now+=300001;assert.equal(local.capture('companion'),undefined);
    assert.throws(()=>new LocalSocialConnection(join(dir,'cache.sqlite'),{...config(f.server.url),roleId:'another'}),/cache_binding_mismatch/);
  }finally{await local.close();await f.close();removeFixture(dir);}
});
test('a forged synchronization response cannot import private fields or a different group',async()=>{
  const s=store();try{await deliver(s);const page=s.sync(0);page.changes[0]!.experience!.groupId='not-authorized';const local=new LocalSocialConnection(':memory:',config('http://127.0.0.1'),async()=>new Response(JSON.stringify(page)));try{await assert.rejects(local.sync(),/invalid_experience_scope/);assert.equal(local.capture('companion'),undefined);}finally{await local.close();}}finally{s.close();}
});
test('provider transport validates complete visible output and does not return reasoning',async()=>{
  const input={persona:{roleId,name:'桌宠',persona:'自然交流',revision:1},event:event(),history:[]};
  let wire='';const model=new OpenAICompatibleSocialModel({endpoint:'https://example.invalid/v1/chat/completions',model:'configured-model',apiKey:()=>tokens.admin},async(_url,init)=>{wire=String(init?.body);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'收到',summary:'与小李聊建模'}),reasoning_content:'hidden'}}]}));});
  assert.deepEqual(await model.reply(input,new AbortController().signal),{text:'收到',summary:'与小李聊建模'});assert.ok(wire.includes('person-a'));assert.ok(!wire.includes('privateHistory'));
  const timeout=new OpenAICompatibleSocialModel({endpoint:'https://example.invalid/v1/chat/completions',model:'x',apiKey:()=>tokens.admin},async()=>{throw Error('network');});await assert.rejects(timeout.reply(input,new AbortController().signal),/model_outcome_unknown/);
});

const scope={characterId:'companion',sessionId:'private-session',turnId:'turn-1',generation:0};
const request:DialogueRequest={scope,text:'你今天在群里聊了什么？',context:{scope,characterPrompt:'你与用户是亲近的朋友。',recent:[],summary:'本地私人信息',memories:[],perception:null,inputTokenBudget:200000}};
const endpoint:EndpointConfig={endpoint:'https://example.invalid/chat/completions',model:'fixture',apiKey:()=>'',authorizer:denyPaidCalls};
test('desktop actual request builder keeps social facts attributed, budgets them, and excludes them during forgetting',async()=>{
  const f=await fixture();try{
    await deliver(f.s);await f.local.sync();const social=f.local.capture('companion')!;
    const built=buildDialogueRequest(request,endpoint,{now:hostClock(),social});const wire=JSON.stringify(built.body);
    assert.ok(wire.includes('roleSocialContext'));assert.ok(wire.includes('person-a'));assert.ok(wire.includes('本地私人信息'));assert.ok(wire.includes('不能说成当前用户的经历'));
    const forgotten=buildDialogueRequest({...request,memoryPending:{scope,request:'forget',status:'pending'}},endpoint,{now:hostClock(),social});assert.ok(!JSON.stringify(forgotten.body).includes('Blender'));assert.ok(!JSON.stringify(forgotten.body).includes('本地私人信息'));
    let sent:JsonRecord|undefined;
    class CaptureTransport extends ProviderTransport{override async request(_c:EndpointConfig,_s:typeof scope,_o:never,body:JsonRecord){sent=body;return{choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'我和小李聊了建模。',expression:{emotion:'neutral',intensity:0,delivery:'自然',gesture:null}})}}]};}}
    const provider=new JsonDialogueProvider(endpoint,new CaptureTransport(),undefined,undefined,{},f.local);provider.prepare(request);
    assert.ok(provider.countContext(request.context,request.text)>new JsonDialogueProvider(endpoint).countContext(request.context,request.text));
    assert.equal((await provider.reply(request,new AbortController().signal)).text,'我和小李聊了建模。');assert.ok(JSON.stringify(sent).includes('roleSocialContext'));
  }finally{await f.close();}
});
test('revocation during the desktop model call prevents publication of the stale reply',async()=>{
  const f=await fixture();try{
    await deliver(f.s);await f.local.sync();
    class RevokeTransport extends ProviderTransport{override async request(){f.s.forget('e1');await f.local.sync();return{choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'stale',expression:{emotion:'neutral',intensity:0,delivery:'自然',gesture:null}})}}]};}}
    const provider=new JsonDialogueProvider(endpoint,new RevokeTransport(),undefined,undefined,{},f.local);provider.prepare(request);await assert.rejects(provider.reply(request,new AbortController().signal),/invalidated/);
  }finally{await f.close();}
});
