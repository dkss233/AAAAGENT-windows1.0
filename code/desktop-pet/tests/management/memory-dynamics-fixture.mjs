// Synthetic HTTP fixture for the real management UI. No business DB, models or devices.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
import {fixtureBudget,fixtureReport} from './ui/context-budget/fixture-budget.mjs';
const uiRoot=fileURLToPath(new URL('../../management/ui/',import.meta.url));
const stamp='2026-09-12T00:00:00.000Z';
const defaults={baseHalfLifeDays:30,emotionHalfLifeDays:7,baselineWeight:.55,activationWeight:.25,importanceWeight:.15,emotionWeight:.05};
const policyVersion=(revision,policy=defaults,restoredFromRevision=null)=>({revision,effectiveAt:stamp,policy:structuredClone(policy),restoredFromRevision});
const raw=(id,kind,text,state='active')=>({characterId:'companion',id,kind,text,state,version:1,createdAt:stamp,role:kind==='transcript'?'user':null,sources:[],origin:'conversation',editable:['memory','transcript','summary'].includes(kind)&&state==='active'});
const traits=(emotionStatus='missing')=>({category:'event',importance:.5,evidenceSources:[{id:'source-park',version:1}],emotion:{status:emotionStatus,intensity:emotionStatus==='observed'?0:null,sources:emotionStatus==='observed'?[{id:'source-park',version:1}]:[],observation:emotionStatus==='observed'?'合成证据：明确的零强度观测':null}});
function item(id,kind,text,emotionStatus='missing',state='active'){
 const record=raw(id,kind,text,state);if(kind==='memory')record.sources=[{id:'source-park',version:1}];
 return {record,relatedIds:kind==='memory'?['source-park','index-park']:[],dynamics:kind==='memory'?{recordId:id,recordVersion:1,lineageIds:[id],traits:traits(emotionStatus),activation:.81,emotion:0,halfLifeDays:60,anchorAt:stamp,evaluatedAt:stamp,lastReinforcedDay:null,policyRevision:2}:null};
}
const candidate=(id,selected=true)=>({source:{id,version:1},activation:.81,importance:.5,emotion:0,relevance:selected?1:0,priority:selected?.8275:0,matchedTerms:selected?['公园']:[],cueKind:selected?'keywords':'none',selected,omission:selected?null:'no_cue'});
export async function createMemoryDynamicsFixture(){
 const token='memory-dynamics-synthetic-session';let state;
 const reset=()=>state={controls:{},requests:[],writes:[],dataRevision:8,policy:policyVersion(2),history:[policyVersion(1,{...defaults,baseHalfLifeDays:25}),policyVersion(2)],items:[
   item('memory-missing','memory','周六去安静的公园拍照。'),item('memory-observed','memory','重要的课程分享安排。','observed'),item('memory-invalid','memory','尚不能采用的情绪证据。','invalid'),
   item('memory-shared','memory','与其他事实共享来源的记忆。'),item('memory-deleted','memory','已请求遗忘的旧安排。','missing','deleted'),
   item('source-park','transcript','合成来源原文：我喜欢安静的公园。'),item('summary-park','summary','合成摘要：喜欢安静的公园。'),item('emotion-park','emotion','只有分类标签，没有可用强度。'),item('index-park','keyword_index','公园，摄影'),
   ...Array.from({length:19},(_,i)=>item('memory-extra-'+i,'memory',i===0?'<img src=x onerror="window.unsafeRendered=true"> 合成文本':`合成记忆片段 ${i+1}，用于分页。`)),
 ],traces:Array.from({length:12},(_,i)=>({id:'trace-'+i,kind:'actual',scope:{characterId:'companion',sessionId:'synthetic-session',turnId:'turn-'+i,generation:1},dataRevision:7,policyRevision:1,evaluatedAt:stamp,candidates:[candidate('memory-missing'),candidate('memory-invalid',false)],countedInputTokens:180,inputTokenBudget:1200,status:['assembled','consumed','invalidated'][i%3]}))};
 reset();
 const slots=['dialogue','memory_turn','summary','perception','tts','admission'];
 const providers=Object.fromEntries(slots.map(slot=>[slot,{adapterId:'synthetic',provider:'synthetic',model:'fixture-no-calls',endpoint:'https://example.invalid',credentialRef:'fixture',inputTokenLimit:320000,contextWindowTokens:262144,outputTokenLimit:4096,reservationMicros:0,inputMicrosPerToken:0,outputMicrosPerToken:0}]));
 const config={providers,context:{targetInputTokens:200000,currentEmotionReserveTokens:512,maxRecentMessages:20,maxMemories:6,summaryLimit:2,summaryMinMessages:12,summaryMaxMessages:24,timeoutMs:3000}};
 const snapshot=()=>({apiVersion:1,runtime:{instanceId:state.controls.instanceId||'synthetic-memory-instance',pid:0,sourceRevision:'synthetic only',startedAt:stamp,observedAt:stamp,characterId:'companion',sessionId:'synthetic-session',online:true},characters:[{id:'companion',label:'青梅竹马',revision:1}],settings:{revision:1,effectiveRevision:1,saved:config,effective:config,savedBudget:fixtureBudget(config),effectiveBudget:fixtureBudget(config),pending:false,history:[],savedAt:stamp},modules:[{id:'memory_turn',label:'记忆维护',providerSlot:'memory_turn',status:'error',detail:'合成观测：上次维护失败，尚未完成。',activeJobs:0,calls:1,lastElapsedMs:null,lastError:'合成错误：来源版本变化',lastObservedAt:stamp},{id:'retrieval',label:'记忆检索',status:'ready',detail:'合成观测，不连接真实数据。',activeJobs:0,calls:2,lastElapsedMs:5,lastError:null,lastObservedAt:stamp}],events:[{id:1,moduleId:'memory_turn',kind:'failed',characterId:'companion',at:stamp,elapsedMs:null,message:'合成维护失败，未提交更新。'}],adapters:[],credentials:[]});
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const fail=(res,status,message)=>send(res,status,{error:{code:status===409?'version_conflict':'unavailable',message}});
 const server=createServer(async(req,res)=>{try{
   const url=new URL(req.url,'http://localhost'),path=url.pathname;
   if(path.startsWith('/api/')){
     if(req.headers.authorization!=='Bearer '+token||state.controls.unauthorized)return fail(res,401,'合成会话已失效');
     const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
     state.requests.push({method:req.method,path,body,search:url.search});
     if(state.controls.offline)return fail(res,503,'合成服务暂时不可用');
     if(path==='/api/snapshot')return send(res,200,snapshot());
     const characterId='companion';
     if(path==='/api/memory/dynamics'){
       const offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit')),q=url.searchParams.get('query')||'',all=url.searchParams.get('state')==='all';
       const rows=state.items.filter(i=>(all||i.record.state==='active')&&(i.record.text.includes(q)||i.record.id===q));
       const data=structuredClone({characterId,dataRevision:state.dataRevision,evaluatedAt:stamp,policy:state.policy,policyHistory:state.history,items:rows.slice(offset,offset+limit),total:rows.length,offset,limit,timeZone:'Asia/Shanghai'});
       if(state.controls.foreign)data.items[0].record.characterId='retired';
       if(state.controls.oldRevision)data.dataRevision=1;
       if(state.controls.delayData)await new Promise(r=>setTimeout(r,state.controls.delayData));return send(res,200,data);
     }
     if(path==='/api/memory/traces'){
       const offset=Number(url.searchParams.get('offset')),limit=Number(url.searchParams.get('limit'));
       return send(res,200,{characterId,records:state.traces.slice(offset,offset+limit),total:state.traces.length,offset,limit});
     }
     if(path==='/api/memory/preview'){
       if(body.expectedDataRevision!==state.dataRevision||body.expectedPolicyRevision!==state.policy.revision)return fail(res,409,'试算版本已变化');
       const data={kind:'preview',characterId,dataRevision:state.dataRevision,policyRevision:state.policy.revision,evaluatedAt:body.evaluatedAt==='now'?new Date().toISOString():body.evaluatedAt,effectiveFrom:new Date().toISOString(),before:body.query?[candidate('memory-missing')]:[],after:body.query?[{...candidate('memory-missing'),activation:.75,priority:.81}]:[]};
       if(state.controls.previewWrongVersion)data.policyRevision++;
       if(state.controls.delayPreview)await new Promise(r=>setTimeout(r,state.controls.delayPreview));return send(res,200,data);
     }
     if(path==='/api/memory/policy'||path==='/api/memory/policy/rollback'){
       if(state.controls.policyConflict){delete state.controls.policyConflict;state.policy=policyVersion(state.policy.revision+1,{...defaults,baseHalfLifeDays:35});state.history.push(state.policy);state.dataRevision++;}
       if(body.expectedRevision!==state.policy.revision)return fail(res,409,'策略已更新');
       if(state.controls.failWrite)return fail(res,400,'合成失败：策略未保存');
       const target=path.endsWith('rollback')?state.history.find(h=>h.revision===body.targetRevision):null;
       state.policy=policyVersion(state.policy.revision+1,target?.policy||body.policy,target?.revision??null);state.policy.effectiveAt=new Date().toISOString();state.history.push(state.policy);state.dataRevision++;state.writes.push({path,body});
       const result=structuredClone(state.policy);if(state.controls.badAck)result.revision=body.expectedRevision;
       if(state.controls.delayWrite)await new Promise(r=>setTimeout(r,state.controls.delayWrite));return send(res,200,result);
     }
     if(path==='/api/memory/forget'||path==='/api/memory/restore'){
       const item=state.items.find(i=>i.record.id===body.id);if(!item||item.record.kind!=='memory')return fail(res,400,'只支持长期记忆');
       if(item.record.id==='memory-shared')return fail(res,400,'共享混合来源暂不支持遗忘，本次零写入。');
       if(body.expectedVersion!==item.record.version)return fail(res,409,'记忆版本变化');
       if(state.controls.failWrite)return fail(res,400,'合成失败：未处理');
       item.record.state=path.endsWith('forget')?'deleted':'active';item.record.version++;item.record.editable=item.record.state==='active';item.dynamics.recordVersion=item.record.version;state.dataRevision++;state.writes.push({path,body});
       return send(res,200,{characterId,revision:state.dataRevision,affectedIds:[body.id,'index-park'],status:'applied'});
     }
     if(path==='/api/records'){
       const rows=state.items.map(i=>i.record).filter(r=>r.kind===url.searchParams.get('kind'));
       return send(res,200,{characterId,revision:state.dataRevision,records:rows,total:rows.length,offset:0,limit:25});
     }
     if(path==='/api/prompt')return send(res,200,{characterId,revision:1,text:'合成角色设定，不代表用户事实。'});
     if(path==='/api/context')return send(res,200,{characterId,revision:state.dataRevision,query:'',prompt:'合成设定',recent:[],summaries:[],memories:[],contextBudget:fixtureReport(fixtureBudget(config),{messages:0,turns:0,summaries:0,memories:0,historicalEmotions:2}),note:'合成的当前上下文试算。'});
     return fail(res,404,'合成接口未实现');
   }
   const name=path==='/'?'index.html':decodeURIComponent(path.slice(1)),file=resolve(uiRoot,name);
   if(!file.startsWith(uiRoot))return fail(res,404,'文件不存在');
   let data=await readFile(file);if(name==='index.html')data=Buffer.from(data.toString().replace('<body>','<body><div style="padding:8px;background:#fff0ca;color:#624a13;font:12px sans-serif;text-align:center">隔离合成数据 · 不连接用户数据、模型或设备</div>'));
   res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.mjs':'text/javascript','.css':'text/css'})[extname(file)]||'application/octet-stream');res.end(data);
 }catch(e){fail(res,500,e.message);}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:`http://127.0.0.1:${server.address().port}/#token=${token}`,reset,budget:fixtureBudget(config),get state(){return state;},close:()=>new Promise(r=>{server.close(r);server.closeAllConnections();})};
}
