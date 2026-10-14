import {appendFileSync,readFileSync,realpathSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';

// A test-only native protocol peer. It never connects to a model endpoint.
if(process.argv.includes('--version')){process.stdout.write('codex-cli 0.160.0-fixture\n');process.exit(0);}
const root=resolve(process.env.AAA_WEB_TEST_DIRECTORY??'');
const codexHome=resolve(process.env.CODEX_HOME??'');
if(!root.includes('/artifacts/W1/web-execution-56/')||codexHome!==join(root,'codex-home'))throw Error('Owned fixture home required');
const schemas=await import(pathToFileURL(process.env.AAA_WEB_TEST_SCHEMA));
const wire=JSON.parse(readFileSync(process.env.AAA_WEB_TEST_WIRE,'utf8'));
const database=new DatabaseSync(join(codexHome,'state_5.sqlite'));
database.exec('CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,cwd TEXT,originator TEXT,archived INTEGER DEFAULT 0)');
// Private fixture history, separate from the native binding metadata above.
database.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS fixture_thread_history(id TEXT PRIMARY KEY,snapshot_json TEXT NOT NULL)');
const capture=entry=>appendFileSync(join(root,'fake-provider-wire.jsonl'),JSON.stringify(entry)+'\n');
const send=message=>process.stdout.write(JSON.stringify(message)+'\n');
const reply=(id,result)=>send({id,result});
const notify=(method,params)=>send({method,params});
let originator='unverified',nativeId,cwd,model='fixture-a',activeTurn,snapshot,startedAtMs;
const pending=new Map();
function persist(){
  schemas.threadRead({thread:snapshot.thread});
  database.prepare('INSERT INTO fixture_thread_history VALUES(?,?) ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json').run(nativeId,JSON.stringify(snapshot));
}
function readSnapshot(threadId){
  const row=database.prepare('SELECT snapshot_json FROM fixture_thread_history WHERE id=?').get(threadId);
  return row?JSON.parse(row.snapshot_json):null;
}
function reject(id,message){send({id,error:{code:-32000,message}});}
function waiting(flag){
  snapshot.thread.status={type:'active',activeFlags:[flag]};persist();
}
function finish(text,status='completed'){
  const turn=activeTurn;if(!turn)return;
  const item={type:'agentMessage',id:randomUUID(),text,phase:'final_answer',memoryCitation:null};
  notify('item/started',{threadId:nativeId,turnId:turn.id,item:{...item,text:''}});
  notify('item/agentMessage/delta',{threadId:nativeId,turnId:turn.id,itemId:item.id,delta:text});
  notify('item/completed',{threadId:nativeId,turnId:turn.id,item});
  turn.items.push(item);turn.status=status;turn.completedAt=Math.floor(Date.now()/1000);turn.durationMs=Date.now()-startedAtMs;
  snapshot.thread.status={type:'idle'};snapshot.thread.updatedAt=turn.completedAt;snapshot.thread.recencyAt=turn.completedAt;
  persist();notify('turn/completed',{threadId:nativeId,turn});
  activeTurn=null;
}
function nativeSnapshot(){
  return snapshot;
}
const input=createInterface({input:process.stdin});
input.on('line',line=>{
  let message;try{message=JSON.parse(line);}catch{return;}
  capture(message);
  const {id,method,params}=message;
  if(!method){
    const request=pending.get(id);if(!request)return;
    pending.delete(id);if(message.error){capture({fixture:'protocol.error',requestId:id,error:message.error});return;}
    notify('serverRequest/resolved',schemas.resolved({threadId:nativeId,requestId:id}));
    finish(`受控请求已回应 ${JSON.stringify(message.result??message.error)}`);return;
  }
  switch(method){
    case 'initialize':originator=params?.clientInfo?.name??'unverified';reply(id,{userAgent:'aaa-web-fixture/0.1',codexHome,platformFamily:'unix',platformOs:'macos'});break;
    case 'initialized':break;
    case 'account/read':reply(id,{account:{type:'apiKey'},requiresOpenaiAuth:false});break;
    case 'account/rateLimits/read':send({id,error:{code:-32000,message:'Fixture has no paid usage'}});break;
    case 'skills/list':reply(id,{data:[]});break;
    case 'model/list':reply(id,{data:['fixture-a','fixture-b'].map((name,index)=>({id:name,model:name,displayName:name,description:'Controlled native peer; no model',hidden:false,isDefault:index===0,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Fixture medium'},{reasoningEffort:'high',description:'Fixture high'}]})),nextCursor:null});break;
    case 'thread/start':
      nativeId=randomUUID();cwd=params.cwd;model=params.model??model;
      snapshot={...wire.responses.threadStart,cwd,model,approvalPolicy:'untrusted',approvalsReviewer:'user',
        sandbox:{type:'readOnly',networkAccess:false},runtimeWorkspaceRoots:[cwd],instructionSources:[],
        thread:{...wire.responses.threadStart.thread,id:nativeId,sessionId:nativeId,cwd,path:null,turns:[],
          source:'appServer',cliVersion:'0.160.0-fixture',createdAt:Math.floor(Date.now()/1000),updatedAt:Math.floor(Date.now()/1000),recencyAt:Math.floor(Date.now()/1000),status:{type:'idle'}}};
      persist();
      database.prepare('INSERT INTO threads VALUES(?,?,?,0)').run(nativeId,cwd,originator);reply(id,nativeSnapshot());break;
    case 'thread/resume':{
      const saved=readSnapshot(params.threadId);
      if(!saved){reject(id,'Unknown fixture native thread');break;}
      if(params.cwd&&params.cwd!==saved.cwd){reject(id,'Fixture native cwd mismatch');break;}
      if(saved.thread.status.type==='active'){reject(id,'Fixture native thread is still active');break;}
      snapshot=saved;nativeId=saved.thread.id;cwd=saved.cwd;model=params.model??saved.model;
      snapshot.model=model;persist();reply(id,nativeSnapshot());break;
    }
    case 'thread/read':{
      if(existsSync(join(root,'native-read-unavailable'))){reject(id,'Controlled native read unavailable');break;}
      const saved=readSnapshot(params.threadId);
      if(!saved){reject(id,'Unknown fixture native thread');break;}
      const result={thread:{...saved.thread,turns:params.includeTurns===true?saved.thread.turns:[]}};
      schemas.threadRead(result);reply(id,result);break;
    }
    case 'turn/start':{
      if(!snapshot||params.threadId!==nativeId||activeTurn){reject(id,'Fixture native turn scope is unavailable or busy');break;}
      model=params.model??model;startedAtMs=Date.now();
      const user={type:'userMessage',id:randomUUID(),content:params.input??[]};
      activeTurn={...wire.responses.turnStart.turn,id:randomUUID(),items:[user],itemsView:'full',startedAt:Math.floor(startedAtMs/1000)};
      snapshot.model=model;snapshot.thread.turns.push(activeTurn);snapshot.thread.status={type:'active',activeFlags:[]};
      snapshot.thread.updatedAt=activeTurn.startedAt;snapshot.thread.recencyAt=activeTurn.startedAt;persist();
      capture({fixture:"turn.started",nativeThreadId:nativeId,turnId:activeTurn.id});reply(id,{turn:activeTurn});
      const text=(params.input??[]).filter(part=>part.type==='text').map(part=>part.text).join('\n');
      // Files are read only from a reference actually delivered by the native input.
      const files=[];
      for(const match of text.matchAll(/\[Attached file "[^"\n]+" is saved at: ([^\]\n]+)\]/g)){
        const file=realpathSync(match[1]);
        if(!file.startsWith(join(root,'t3-home','userdata','attachments')+'/'))throw Error('Native attachment outside owned test home');
        const content=readFileSync(file,'utf8');files.push(content);
        capture({fixture:'file.read',pathFromNativeInput:match[1],content,bytes:Buffer.byteLength(content),sha256:createHash('sha256').update(content).digest('hex')});
      }
      const turn=activeTurn;
      setTimeout(()=>{
        if(activeTurn?.id!==turn.id)return;
        notify('turn/started',{threadId:nativeId,turn});
        if(text.includes('[fixture:approval]')){
          const requestId=randomUUID(),itemId=randomUUID();pending.set(requestId,{itemId});
          waiting('waitingOnApproval');
          send({id:requestId,method:'item/commandExecution/requestApproval',params:schemas.approval({threadId:nativeId,turnId:turn.id,itemId,approvalId:itemId,startedAtMs:Date.now(),reason:'Controlled approval',command:'fixture-noop',cwd})});
        }else if(text.includes('[fixture:question]')){
          const requestId=randomUUID(),itemId=randomUUID();pending.set(requestId,{itemId});
          waiting('waitingOnUserInput');
          send({id:requestId,method:'item/tool/requestUserInput',params:schemas.question({threadId:nativeId,turnId:turn.id,itemId,isBlocking:true,questions:[{id:'fixture-choice',header:'受控选择',question:'选择受控答案',isOther:false,isSecret:false,options:[{label:'选项甲',description:'Controlled A'},{label:'选项乙',description:'Controlled B'}]}]})});
        }else if(!text.includes('[fixture:wait]'))finish(`受控原生回执 ${model}\n${text}${files.length ? "\n实际附件内容: "+files.join("\n") : ""}`);
      },25);break;
    }
    case 'turn/interrupt':
      if(params.threadId!==nativeId||params.turnId!==activeTurn?.id){reject(id,'Fixture interrupt thread/turn mismatch');break;}
      reply(id,{});pending.clear();finish('受控任务已中止','interrupted');break;
    case 'thread/name/set':reply(id,{});break;
    default:if(id!==undefined)send({id,error:{code:-32601,message:`Fixture unsupported ${method}`}});
  }
});
input.on('close',()=>database.close());
