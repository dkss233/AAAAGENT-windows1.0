/** Real cloud inference with isolated stores and an explicitly synthetic QQ sender. */
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { SocialStore } from '../../dist/companion/cloud/store.js';
import { startSocialServer } from '../../dist/companion/cloud/server.js';
import { OpenAICompatibleSocialModel } from '../../dist/companion/cloud/model.js';
import { LocalSocialConnection } from '../../dist/companion/cloud/local.js';
import { prepareSocialDatabase, readPrivateSocialText, writePrivateSocialText } from '../../dist/companion/cloud/storage.js';
import { selectTrialDialogue } from '../../dist/app/dialogue-selection.js';
import { ProviderTransport } from '../../dist/providers/transport.js';

const execute=promisify(execFile),root=fileURLToPath(new URL('../../../../',import.meta.url));
const bot=resolve(root,'../../VerinaBot/VerinaQQBot-Windows');
const evidence=resolve(root,'.local/social-integration-20261017');mkdirSync(evidence,{recursive:true});
const directory=mkdtempSync(join(evidence,'cloud-fixture-'));
const credentialFile=resolve(bot,'secrets/credentials.json');
const credentials=JSON.parse(readPrivateSocialText(credentialFile));
assert.equal(typeof credentials.deepseek_api_key,'string');
const endpoint='https://api.deepseek.com/chat/completions',modelId='deepseek-flash';
const calls=[],botChecks=[],privateMarker='PRIVATE_ONLY_MARIGOLD_62613';let stage='initializing';
const stable=(kind,value)=>'qq-'+kind+'-'+createHash('sha256').update(value).digest('hex').slice(0,40);
const roleId='cloud-validation-role',tokens=Object.fromEntries(['admin','channel','sync'].map(k=>[k,randomBytes(32).toString('hex')]));
const cloudFetch=operation=>async(url,init)=>{
  assert.equal(String(url),endpoint);assert.ok(calls.length<8,'Cloud test request ceiling');
  const body=JSON.parse(init.body);assert.equal(body.model,modelId);
  if(operation==='social-summary')assert.ok(!JSON.stringify(body).includes(privateMarker));
  const trace={operation,provider:'deepseek',model:modelId,host:'api.deepseek.com'};calls.push(trace);
  const response=await fetch(url,init);trace.httpStatus=response.status;
  const payload=await response.clone().json().catch(()=>({}));trace.usage=payload.usage??null;
  return response;
};
const cloudModel=new OpenAICompatibleSocialModel({endpoint,model:modelId,apiKey:()=>credentials.deepseek_api_key},cloudFetch('social-summary'));
const serviceFile=resolve(directory,'social.sqlite'),cacheFile=resolve(directory,'social-cache.sqlite');
let store,server,local,privateDb;
const connection=url=>({version:1,enabled:true,roleId,characterId:'companion',endpoint:url,syncToken:tokens.sync,maxAgeMs:300000,maxContextCharacters:6000});
try {
  prepareSocialDatabase(resolve(directory,'private.sqlite'));
  privateDb=new Database(resolve(directory,'private.sqlite'));
  privateDb.exec('CREATE TABLE private_notes(body TEXT NOT NULL)');privateDb.prepare('INSERT INTO private_notes VALUES(?)').run(privateMarker);
  store=new SocialStore(serviceFile,roleId,{name:'维里奈',persona:'温柔自然，保持每个群与群友的身份独立，软件反馈不代表已修复。'});
  for(const [group,share] of [['synthetic-group-a',true],['synthetic-group-b',false]])store.setPolicy({groupId:stable('group',group),enabled:true,shareWithOwner:share,replyMode:'addressed'},0);
  server=await startSocialServer({store,model:cloudModel,tokens,autoWork:false,maxRequestsPerDay:10});
  local=new LocalSocialConnection(cacheFile,connection(server.url));
  const cases=[{group:'synthetic-group-a',id:'cloud-event-a',actor:'synthetic-alice',name:'小林',text:'我正在学 Blender，今天完成了一只绿色小恐龙的模型。'},
    {group:'synthetic-group-b',id:'cloud-event-b',actor:'synthetic-bob',name:'小周',text:'我最近爱喝茉莉花茶，不喜欢喝咖啡。'}];
  for(const [index,message] of cases.entries()) {
    stage='cloud-qq-answer-'+index;
    const data=resolve(directory,'bot-'+index);mkdirSync(data,{recursive:true});
    const channelFile=resolve(data,'channel.json'),inputFile=resolve(data,'input.json');
    writePrivateSocialText(channelFile,JSON.stringify({version:1,enabled:true,roleId,endpoint:server.url,channelToken:tokens.channel,groups:cases.map(x=>x.group)}));
    writePrivateSocialText(inputFile,JSON.stringify({connectionFile:channelFile,data,message,credentialFile}));
    const result=await execute(resolve(bot,'runtime/windows-x64/python/python.exe'),['-X','utf8',resolve(bot,'app/check_social_bridge.py'),'--cloud-roundtrip',inputFile],{windowsHide:true,timeout:95000,maxBuffer:1000000,encoding:'utf8'});
    const check=JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(check.actual_qq_messages_sent,0);assert.ok(check.model_calls.length>=1);
    for(const call of check.model_calls){assert.equal(call.host,'api.deepseek.com');calls.push({operation:'qq-answer',...call});}
    botChecks.push(check);stage='cloud-social-summary-'+index;
    assert.equal(await server.worker.tick(),true);
    assert.equal(store.job(check.event_id).state,'delivered');assert.equal(store.claimDelivery(),null);
    // Repeating an accepted receipt cannot create a second reply or another model request.
    const outbox=new Database(resolve(data,'social-outbox.sqlite'),{readonly:true});
    const participation=JSON.parse(outbox.prepare('SELECT payload FROM outbox').get().payload);outbox.close();
    assert.equal(store.acceptParticipation(participation).duplicate,true);
    assert.equal(await server.worker.tick(),false);
  }
  stage='desktop-sync';await local.sync();assert.equal(local.status().cachedExperiences,1);
  assert.equal(local.capture('companion').experiences[0].participants[0].name,'小林');
  assert.ok(!JSON.stringify(store.db.prepare('SELECT payload FROM events').all()).includes(privateMarker));
  const authorizer={async authorize(request){assert.equal(request.endpoint,endpoint);assert.equal(request.model,modelId);assert.equal(request.operation,'dialogue');return{async settle(){}};}};
  const cloudEndpoint=()=>({endpoint,model:modelId,apiKey:()=>credentials.deepseek_api_key,authorizer});
  const configuration={models:{dialogue:{provider:'deepseek',endpoint,model:modelId,credentialFile,contextWindowTokens:1048576,inputTokenLimit:32768,outputTokenLimit:1600,reservationMicros:100000,inputMicrosPerToken:3,outputMicrosPerToken:9}}};
  async function desktopReply(text,turnId) {
    const selected=selectTrialDialogue(configuration,cloudEndpoint,new ProviderTransport(cloudFetch('desktop-dialogue')),()=>({presets:[]}),32768,.3,undefined,local);
    assert.equal(selected.dialogue.constructor.name,'JsonDialogueProvider');
    const scope={characterId:'companion',sessionId:'cloud-private-session',turnId,generation:0};
    return selected.dialogue.reply({scope,text,context:{scope,characterPrompt:'你是温柔自然的桌宠，只依据给出的资料回答，群友和当前用户是不同的人。',recent:[],summary:privateMarker,memories:[],perception:null,inputTokenBudget:selected.foregroundBudget.effectiveInputTokens}},AbortSignal.timeout(60000));
  }
  stage='cloud-desktop-answer';const answer=await desktopReply('群友小林今天完成了什么？这是我的经历吗？小周的近况也能确认吗？','before-forget');
  assert.match(answer.text,/小林/);assert.match(answer.text,/小恐龙|Blender/);assert.doesNotMatch(answer.text,/茉莉花茶|爱喝咖啡/);
  stage='restart-and-resume';const port=server.port;await local.close();local=undefined;await server.close();server=undefined;store.close();
  store=new SocialStore(serviceFile,roleId,{name:'维里奈',persona:'温柔自然。'});
  server=await startSocialServer({store,model:cloudModel,tokens,port,autoWork:false});local=new LocalSocialConnection(cacheFile,connection(server.url));
  await local.sync();assert.equal(local.status().cachedExperiences,1);assert.equal(store.claimDelivery(),null);
  stage='forget-and-sync';store.forget(botChecks[0].event_id);await local.sync();assert.equal(local.status().cachedExperiences,0);
  stage='cloud-desktop-after-forget';const after=await desktopReply('你还记得群友小林刚才做的模型是什么吗？没有可用记录就说明尚不清楚，不要猜。','after-forget');
  assert.doesNotMatch(after.text,/绿色小恐龙|茉莉花茶/);
  assert.equal(privateDb.prepare('SELECT body FROM private_notes').get().body,privateMarker);
  assert.ok(calls.every(c=>c.host==='api.deepseek.com'));
  const report={status:'passed',provider:'deepseek',model:modelId,modelCalls:calls.length,localModelCalls:0,actualQQMessagesSent:0,syntheticQQSender:true,
    sharedGroupAttribution:true,privateGroupExcluded:true,privateStoreUnchanged:true,receiptDeduplicated:true,restartResumed:true,forgetPropagated:true,
    botReplies:botChecks.map(c=>c.reply),desktopBeforeForget:answer.text,desktopAfterForget:after.text,calls,completedAt:new Date().toISOString()};
  writePrivateSocialText(resolve(evidence,'cloud-validation.json'),JSON.stringify(report,null,2)+'\n',false);
  console.log(JSON.stringify(report));
} catch(error) {
  const report={status:'failed',stage,errorName:error?.name,errorCode:error?.code,modelCalls:calls.length,calls};
  writePrivateSocialText(resolve(evidence,'cloud-validation.json'),JSON.stringify(report,null,2)+'\n',false);
  console.error(JSON.stringify(report));process.exitCode=1;
} finally { await local?.close();await server?.close();store?.close();privateDb?.close(); }
