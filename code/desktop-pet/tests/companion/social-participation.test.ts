import test from 'node:test';
import assert from 'node:assert/strict';
import { SocialStore } from '../../companion/cloud/store.js';
import { SocialWorker, startSocialServer } from '../../companion/cloud/server.js';
import { parseParticipation, type SocialEvent } from '../../companion/cloud/protocol.js';
import { DemoSocialModel } from '../../companion/cloud/model.js';

const event:SocialEvent={eventId:'synthetic-qq-event',roleId:'test-verina',scope:'group',groupId:'synthetic-group',actorId:'synthetic-member',actorName:'测试群友',text:'Issue：打开设置后窗口闪退。',occurredAt:'2026-10-17T00:00:00.000Z',addressed:true};
const participation={event,reply:'已记下 QQ-0001，状态待核查。',receipt:'synthetic-platform-receipt'};
function fixture(){const store=new SocialStore(':memory:',event.roleId,{name:'测试角色',persona:'群友经历保持独立，反馈登记不表示已经修复。'});store.setPolicy({groupId:event.groupId,enabled:true,shareWithOwner:true,replyMode:'addressed'},0);return store;}

test('confirmed QQ replies are summarized once without preparing another outgoing message',async()=>{
  const store=fixture();let calls=0;
  try{
    assert.equal(store.acceptParticipation(parseParticipation(participation)).duplicate,false);
    assert.equal(store.sync(0).changes.length,0);
    await new SocialWorker(store,{async reply(input){calls++;assert.deepEqual(input.confirmedParticipation,{reply:participation.reply,receipt:participation.receipt});return{text:'An untrusted replacement must not replace the actual reply',summary:'我记录了测试群友的设置闪退反馈，编号 QQ-0001，尚待核查。'};}}).tick();
    assert.equal(store.job(event.eventId)!.state,'delivered');
    assert.equal(store.job(event.eventId)!.reply,participation.reply);
    assert.equal(store.claimDelivery(),null);
    const change=store.sync(0).changes[0]!;
    assert.equal(change.experience!.participants[0]!.id,event.actorId);
    assert.ok(change.experience!.sourceEventIds.includes(participation.receipt));
    assert.equal(store.acceptParticipation(parseParticipation(participation)).duplicate,true);
    assert.equal(await new SocialWorker(store,new DemoSocialModel()).tick(),false);assert.equal(calls,1);
    assert.throws(()=>store.acceptParticipation({...participation,receipt:'different-receipt'}),/event_id_conflict/);
    store.forget(event.eventId);assert.equal(store.acceptParticipation(participation).state,'forgotten');
    assert.equal(store.sync(0).changes.at(-1)!.kind,'delete');
  }finally{store.close();}
});

test('withdrawn settings retain the real QQ receipt but never publish a stale summary',async()=>{
  const store=fixture();
  try{
    store.acceptParticipation(participation);const job=store.claim(100)!;
    store.setPolicy({groupId:event.groupId,enabled:true,shareWithOwner:false,replyMode:'addressed'},1);
    store.complete(event.eventId,job.lease,{text:'unused',summary:'不应共享的旧摘要'});
    assert.equal(store.job(event.eventId)!.state,'delivered');
    assert.equal(store.job(event.eventId)!.receipt,participation.receipt);
    assert.equal(store.job(event.eventId)!.summary,null);
    assert.equal(store.sync(0).changes.length,0);assert.equal(store.claimDelivery(),null);
  }finally{store.close();}
});

test('participation endpoint requires channel credentials, an actual receipt field and group scope',async()=>{
  const store=fixture(),tokens={admin:'a'.repeat(40),channel:'b'.repeat(40),sync:'c'.repeat(40)};
  const server=await startSocialServer({store,model:new DemoSocialModel(),tokens,autoWork:false});
  const post=(data:unknown,token:string)=>fetch(server.url+'/v1/'+event.roleId+'/participations',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(data)});
  try{
    assert.equal((await post(participation,tokens.sync)).status,403);
    assert.equal((await post({...participation,receipt:undefined},tokens.channel)).status,400);
    assert.equal((await post({...participation,event:{...event,scope:'private'}},tokens.channel)).status,400);
    assert.equal((await post({...participation,privateHistory:'must not be accepted'},tokens.channel)).status,400);
    assert.equal((await post(participation,tokens.channel)).status,202);
    assert.equal(store.claimDelivery(),null);
  }finally{await server.close();store.close();}
});
