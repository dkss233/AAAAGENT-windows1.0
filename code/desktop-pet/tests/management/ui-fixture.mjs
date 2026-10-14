// Isolated development server: generated data only. Never opens the business DB/providers/devices.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {fixtureBudget,fixtureReport} from './ui/context-budget/fixture-budget.mjs';
const root=resolve('management/ui'),token='fixture-session-only',now=()=>new Date().toISOString();
const chars=[{id:'companion',label:'青梅竹马',revision:1}];
const slots=['asr','dialogue','memory_turn','summary','perception','tts','admission'];
const selection=slot=>({adapterId:'fixture-'+slot,provider:'dashscope',model:'fixture-'+slot+'-a',endpoint:'https://example.invalid/api',credentialRef:'fixture-credential',inputTokenLimit:320000,contextWindowTokens:262144,outputTokenLimit:4096,reservationMicros:200000,inputMicrosPerToken:2,outputMicrosPerToken:8,...(slot==='tts'?{voice:'demo-voice',language:'Chinese'}:{}),...(slot==='dialogue'?{temperature:.7}:{})});
const base={providers:Object.fromEntries(slots.map(slot=>[slot,selection(slot)])),context:{targetInputTokens:200000,currentEmotionReserveTokens:512,maxRecentMessages:24,maxMemories:6,summaryLimit:8,summaryMinMessages:12,summaryMaxMessages:24,timeoutMs:3000}};
const record=(characterId,id,kind,text,editable=true)=>({characterId,id,kind,text,editable,version:1,state:'active',createdAt:now(),role:kind==='transcript'?'user':null,sources:[],origin:'conversation'});
let state;
function reset(){state={controls:{},writes:[],settings:{revision:3,effectiveRevision:2,savedAt:now(),pending:true,applyOn:'restart',effective:structuredClone(base),saved:structuredClone(base),history:[{revision:2,savedAt:now()},{revision:3,savedAt:now()}]},records:[record('companion','companion-memory','memory','周六下午去拍鸽子，喜欢安静的公园。'),record('companion','companion-memory-2','memory','下周一讨论课程脚本。'),record('companion','companion-transcript','transcript','今天想把课程的演示部分再改一改。'),record('companion','companion-summary','summary','最近在整理课程，周末准备出门。'),record('companion','companion-keyword','keyword_index','课程、周末、摄影',false),record('companion','companion-vector','vector_index','演示索引记录；不能据此判断真实 embedding 已启用。',false)],prompts:{companion:{characterId:'companion',revision:2,text:'你是关系亲近的青梅竹马，不预设恋爱关系，不编造具体共同童年。'}}};}
reset();
function budgetSettings(){return {...state.settings,savedBudget:state.controls.savedBudget||fixtureBudget(state.settings.saved),effectiveBudget:state.controls.effectiveBudget||fixtureBudget(state.settings.effective)};}
function snapshot(){return {apiVersion:1,runtime:{instanceId:'isolated-fixture-instance',pid:12345,sourceRevision:'fixture-only · 非真实运行数据',startedAt:now(),observedAt:now(),characterId:'companion',sessionId:'fixture',online:true},modules:[...slots.map(slot=>({id:slot,label:({asr:'语音转写',dialogue:'对话大模型',memory_turn:'记忆维护',summary:'摘要生成',perception:'视频情绪',tts:'语音合成 TTS',admission:'轮次判断'})[slot],status:slot==='tts'?'error':'ready',detail:slot==='tts'?'演示失败：上次合成未完成，其余模块可继续查看。':'隔离演示模块，未发起任何真实调用。',providerSlot:slot,activeJobs:0,calls:slot==='dialogue'?7:2,lastElapsedMs:slot==='tts'?null:850,lastError:slot==='tts'?'演示服务超时，请检查型号与配置。':null,lastObservedAt:now()})),{id:'retrieval',label:'记忆检索 RAG',status:'ready',detail:'按角色读取近期对话、摘要和长期记忆。',activeJobs:0,calls:7,lastElapsedMs:12,lastError:null,lastObservedAt:now()}],events:[{id:1,at:now(),moduleId:'dialogue',kind:'completed',characterId:'companion',elapsedMs:850,message:'演示：对话回复生成完成。'},{id:2,at:now(),moduleId:'tts',kind:'failed',characterId:'companion',elapsedMs:null,message:'演示：合成服务超时。<img src=x onerror="window.unsafeRendered=true">'}],settings:budgetSettings(),adapters:slots.map(slot=>({id:'fixture-'+slot,label:'演示适配 · '+slot,slots:[slot],provider:'dashscope',endpoints:['https://example.invalid/api'],modelHint:'仅用于测试',...(state.controls.catalog?{choices:['a','b'].map((suffix,i)=>{const {credentialRef,...configuration}=selection(slot);return {label:'演示型号 '+suffix,configuration:{...configuration,model:'fixture-'+slot+'-'+suffix,...(slot==='dialogue'&&i?{inputTokenLimit:64000,contextWindowTokens:65536}:{}),reservationMicros:i?900000:200000,inputMicrosPerToken:i?9:2,outputMicrosPerToken:i?19:8,...(slot==='tts'?{voice:i?'registered-b':'registered-a'}:{})},...(slot==='tts'?{voices:[{id:'registered-a',label:'已登记音色 A'},{id:'registered-b',label:'已登记音色 B'}]}:{})}})}:{}),models:['fixture-'+slot+'-a','fixture-'+slot+'-b'],capabilities:{instructions:slot==='tts',cloning:false,voice:slot==='tts',language:slot==='tts',temperature:slot==='dialogue'},status:'available',note:'本页为隔离演示；这些型号不会被发送到真实服务。'})),credentials:[{id:'fixture-credential',label:'演示凭据引用',status:'configured',masked:'••••（非真实凭据）'}],characters:chars};}
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
const failure=(res,status,code,message)=>send(res,status,{error:{code,message}});
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/fixture/')){
  if(req.headers.authorization!=='Bearer '+token)return failure(res,401,'unauthorized','演示会话失效');
  let body={};if(req.method!=='GET'){const chunks=[];for await(const chunk of req)chunks.push(chunk);body=JSON.parse(Buffer.concat(chunks).toString()||'{}');}
  if(url.pathname==='/fixture/control'){if(body.reset)reset();Object.assign(state.controls,body);return send(res,200,{ok:true});}
  if(url.pathname==='/fixture/state')return send(res,200,state);
  if(state.controls.unauthorized)return failure(res,401,'unauthorized','演示会话失效');
  if(state.controls.offline)return failure(res,503,'unavailable','演示：服务暂时不可用');
  if(url.pathname==='/api/snapshot'){const data=snapshot();if(state.controls.legacySnapshot){data.runtime.characterId='friend';data.characters=[{id:'friend',label:'旧角色',revision:1}];}return send(res,200,data);}
  const characterId=body.characterId||url.searchParams.get('characterId');
  if(characterId&&characterId!=='companion')return failure(res,400,'invalid_character','只支持当前青梅竹马');
  if(url.pathname==='/api/presentation'&&req.method==='GET')return send(res,200,{catalog:{modelId:'isolated-style-fixture',items:[['微笑','expression','automatic'],['困倦','expression','automatic'],['比心','pose','automatic'],['安静待机','idle','automatic'],['发饰','appearance','manual'],['固定装饰','appearance','unavailable']].map(([label,category,availability],i)=>({id:'fixture-preset-'+i,label,category,availability,source:category==='idle'?'procedural':'model-expression',previewable:availability!=='unavailable',reason:availability==='unavailable'?'暂不可预览':null}))},policy:{modelId:'isolated-style-fixture',revision:1,enabledIds:['fixture-preset-0']}});
  if(url.pathname==='/api/records'){
   const kind=url.searchParams.get('kind'),q=url.searchParams.get('query')||'',offset=Number(url.searchParams.get('offset'))||0,limit=Number(url.searchParams.get('limit'))||25;
   const rows=state.records.filter(r=>r.characterId===characterId&&r.kind===kind&&r.text.includes(q));const data={characterId,revision:1,records:structuredClone(rows.slice(offset,offset+limit)),total:rows.length,offset,limit};
   if(state.controls.foreignRecords)data.records=[{...data.records[0],characterId:'retired',text:'不应显示的旧角色记录'}];
   if(state.controls.delayRecords)await new Promise(r=>setTimeout(r,state.controls.delayRecords));return send(res,200,data);
  }
  if(url.pathname==='/api/records/edit'){
   const r=state.records.find(r=>r.id===body.id&&r.characterId===characterId);if(!r)return failure(res,404,'not_found','记录不存在');
   if(state.controls.recordConflict){delete state.controls.recordConflict;r.version++;r.text='其他位置更新的最新内容。';}
   if(r.version!==body.expectedVersion)return failure(res,409,'version_conflict','记录版本冲突');
   if(!r.editable)return failure(res,400,'invalid_request','该记录不可编辑');r.text=body.text;r.version++;state.writes.push({route:url.pathname,body});return send(res,200,{status:'applied',characterId,operationId:body.operationId,revision:r.version,record:r,invalidatedIds:['derived-fixture']});
  }
  if(url.pathname==='/api/prompt'){
   const p=state.prompts[characterId];if(req.method==='GET'){const copy=structuredClone(p);if(state.controls.delayPromptGet)await new Promise(r=>setTimeout(r,state.controls.delayPromptGet));return send(res,200,copy);}
   if(state.controls.promptConflict){delete state.controls.promptConflict;p.revision++;p.text='其他位置更新的角色设定。';}
   if(p.revision!==body.expectedRevision)return failure(res,409,'version_conflict','设定版本冲突');p.text=body.text;p.revision++;state.writes.push({route:url.pathname,body});return send(res,200,p);
  }
  if(url.pathname==='/api/context'){
   const rich=state.controls.budgetRich,query=url.searchParams.get('query')||'';
   const recent=rich?Array.from({length:48},(_,i)=>({...record(characterId,'recent-'+i,'transcript','合成近期消息 '+i),role:i%2?'assistant':'user'})):state.records.filter(r=>r.characterId===characterId&&r.kind==='transcript');
   const summaries=rich?Array.from({length:3},(_,i)=>record(characterId,'summary-'+i,'summary','合成摘要 '+i)):state.records.filter(r=>r.characterId===characterId&&r.kind==='summary');
   const memories=rich?Array.from({length:8},(_,i)=>record(characterId,'memory-'+i,'memory','相关合成长期记忆 '+i)):state.records.filter(r=>r.characterId===characterId&&r.kind==='memory');
   const report=state.controls.contextBudget||fixtureReport(fixtureBudget(state.settings.effective),{messages:recent.length,turns:rich?24:1,summaries:summaries.length,memories:memories.length,historicalEmotions:2});
   const data={characterId,revision:1,query,prompt:state.prompts[characterId].text,recent,summaries,memories,...(!state.controls.legacyBudget?{contextBudget:report}:{}),note:'隔离演示的上下文结果，不代表真实记忆语义验收。'};
   if(state.controls.foreignContext)data.recent[0].characterId='retired';
   if(state.controls.delayContext)await new Promise(r=>setTimeout(r,state.controls.delayContext));return send(res,200,data);
  }
  if(url.pathname==='/api/settings'||url.pathname==='/api/settings/rollback'){
   if(state.controls.settingsConflict){delete state.controls.settingsConflict;state.settings.revision++;state.settings.saved.context.currentEmotionReserveTokens=384;}
   if(state.settings.revision!==body.expectedRevision)return failure(res,409,'version_conflict','配置版本冲突');
   const c=body.settings?.context;if(c&&(!Number.isSafeInteger(c.targetInputTokens)||c.targetInputTokens<1||!Number.isSafeInteger(c.currentEmotionReserveTokens)||c.currentEmotionReserveTokens<0||c.currentEmotionReserveTokens>c.targetInputTokens))return failure(res,400,'invalid_request','合成服务：预算无效');
   if(state.controls.rejectBudget)return failure(res,400,'invalid_request','合成服务：模型容量登记不匹配');
   state.settings.saved=structuredClone(body.settings||base);state.settings.revision++;state.settings.pending=true;state.settings.savedAt=now();state.settings.history.push({revision:state.settings.revision,savedAt:now()});state.writes.push({route:url.pathname,body});return send(res,200,budgetSettings());
  }
  return failure(res,404,'not_found','没有这个接口');
 }
 if(url.pathname==='/ui.test.mjs'){res.setHeader('Content-Type','text/javascript');return res.end(await readFile(resolve('tests/management/ui.test.mjs')));}
 const name=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname.slice(1)),file=resolve(root,name);if(!file.startsWith(root+'/'))return failure(res,404,'not_found','文件不存在');
 let data=await readFile(file);if(name==='index.html')data=Buffer.from(data.toString().replace('<body>','<body><div style="padding:7px;text-align:center;background:#fff0ca;color:#73591a;font:12px sans-serif">隔离演示 · 所有数据与凭据引用均为测试生成，不连接真实服务</div>'));
 res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.mjs':'text/javascript','.css':'text/css'})[extname(file)]||'application/octet-stream');res.end(data);
 }catch(e){failure(res,500,'internal_error',e.message)}});
server.listen(Number(process.env.UI_FIXTURE_PORT)||0,'127.0.0.1',()=>console.log('UI_FIXTURE=http://127.0.0.1:'+server.address().port+'/#token='+token));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
