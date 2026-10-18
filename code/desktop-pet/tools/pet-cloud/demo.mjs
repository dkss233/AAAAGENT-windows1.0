#!/usr/bin/env node
import {createServer} from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFileSync,existsSync,mkdirSync,chmodSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import Database from 'better-sqlite3';
import {initialize,readConfiguration,acquireLock} from './cli.mjs';
import {SocialStore} from '../../dist/companion/cloud/store.js';
import {DemoSocialModel} from '../../dist/companion/cloud/model.js';
import {startSocialServer} from '../../dist/companion/cloud/server.js';
import {LocalSocialConnection} from '../../dist/companion/cloud/local.js';

export async function startDemo(directory){
  directory=resolve(directory);if(!existsSync(resolve(directory,'service.json')))initialize(directory,{demo:true});
  const c=readConfiguration(directory);if(!c.demo)throw Error('演示必须使用独立的 demo 配置目录。');
  const release=acquireLock(directory);let store,cloud,local,privateDb,http;
  try {
  store=new SocialStore(resolve(directory,'social.sqlite'),c.roleId,{name:c.name,persona:c.persona});
  if(!store.policy('demo-group'))store.setPolicy({groupId:'demo-group',enabled:true,shareWithOwner:true,replyMode:'all'},0);
  cloud=await startSocialServer({store,model:new DemoSocialModel(),tokens:c.tokens,port:c.port,autoWork:false});
  local=new LocalSocialConnection(resolve(directory,'social-cache.sqlite'),{version:1,enabled:true,roleId:c.roleId,characterId:'companion',endpoint:cloud.url,syncToken:c.tokens.sync,maxAgeMs:300000,maxContextCharacters:6000});
  const privateFile=resolve(directory,'local-private.sqlite');privateDb=new Database(privateFile);chmodSync(privateFile,0o600);
  privateDb.exec('CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, text TEXT NOT NULL);');
  await local.sync();
  const session=randomBytes(32).toString('hex');let url='',disconnected=false;
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  const call=async(path,token,method='GET',value)=>{
    const response=await fetch(`${cloud.url}/v1/${c.roleId}/${path}`,{method,headers:{Authorization:`Bearer ${token}`,...(value?{'Content-Type':'application/json'}:{})},...(value?{body:JSON.stringify(value)}:{}),signal:AbortSignal.timeout(10000)});
    const result=await response.json();if(!response.ok)throw Error(result.error);return result;
  };
  http=createServer(async(req,res)=>{
    try{
      if(req.headers.host!==new URL(url).host||req.headers.origin&&req.headers.origin!==url){json(res,403,{error:'来源不匹配'});return;}
      if(req.method==='GET'&&req.url==='/'){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Set-Cookie':`demo=${session}; HttpOnly; SameSite=Strict; Path=/`,'X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff',"Content-Security-Policy":"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});
        res.end(readFileSync(new URL('./demo.html',import.meta.url)));return;
      }
      if(!req.headers.cookie?.split('; ').includes(`demo=${session}`)){json(res,401,{error:'请先打开演示首页'});return;}
      if(req.method==='GET'&&req.url==='/state'){
        json(res,200,{disconnected,persona:store.persona(),share:store.policy('demo-group').shareWithOwner,privateNotes:privateDb.prepare('SELECT text FROM notes ORDER BY id DESC LIMIT 10').all(),experiences:local.capture('companion')?.experiences??[],cloud:store.status()});return;
      }
      if(req.method!=='POST'||!req.headers['content-type']?.startsWith('application/json')){json(res,404,{error:'未知操作'});return;}
      let size=0,raw='';for await(const part of req){size+=part.length;if(size>10000)throw Error('内容过长');raw+=part;}const body=JSON.parse(raw);
      if(req.url==='/private'){
        if(typeof body.text!=='string'||!body.text.trim()||body.text.length>2000)throw Error('请输入不超过 2000 字的测试记录');
        privateDb.prepare('INSERT INTO notes(text) VALUES(?)').run(body.text);json(res,200,{message:'已仅保存到本地演示私库。'});return;
      }
      if(req.url==='/group'){
        if(typeof body.text!=='string'||!body.text.trim()||body.text.length>1000)throw Error('请输入不超过 1000 字的群消息');
        const eventId=randomUUID();await call('events',c.tokens.channel,'POST',{eventId,roleId:c.roleId,scope:'group',groupId:'demo-group',actorId:'demo-person',actorName:'小李',text:body.text,occurredAt:new Date().toISOString(),addressed:true});
        await cloud.worker.tick();const {delivery}=await call('deliveries/claim',c.tokens.channel,'POST',{});
        if(!delivery)throw Error('当前没有待发送回复');
        // This adapter represents a local test group; acknowledgement is not an actual QQ delivery.
        await call('deliveries/ack',c.tokens.channel,'POST',{deliveryId:delivery.deliveryId,lease:delivery.lease,receipt:`demo:${randomUUID()}`});
        if(!disconnected)await local.sync();json(res,200,{reply:delivery.text});return;
      }
      if(req.url==='/share'){
        if(typeof body.enabled!=='boolean')throw Error('无效设置');const policy=store.policy('demo-group');
        await call('group',c.tokens.admin,'PUT',{groupId:'demo-group',enabled:true,shareWithOwner:body.enabled,replyMode:'all',expectedRevision:policy.revision});if(!disconnected)await local.sync();json(res,200,{message:'群经历共享范围已更新。'});return;
      }
      if(req.url==='/connection'){
        if(typeof body.disconnected!=='boolean')throw Error('无效设置');disconnected=body.disconnected;if(!disconnected)await local.sync();json(res,200,{message:disconnected?'已暂停本地同步，云端测试进程继续运行。':'已恢复同步并补齐经历。'});return;
      }
      if(req.url==='/forget'){
        if(typeof body.id!=='string')throw Error('缺少经历标识');await call(`experiences/${encodeURIComponent(body.id)}`,c.tokens.admin,'DELETE');if(!disconnected)await local.sync();json(res,200,{message:'已移除该经历及对应原文，下一次同步会撤回本地引用。'});return;
      }
      json(res,404,{error:'未知操作'});
    }catch{json(res,400,{error:'操作未完成，请检查输入和服务状态。'});}
  });
  await new Promise((ok,fail)=>{http.once('error',fail);http.listen(0,'127.0.0.1',ok);});url=`http://127.0.0.1:${http.address().port}`;
  writeFileSync(resolve(directory,'demo-runtime.json'),JSON.stringify({pid:process.pid,url,cloudUrl:cloud.url,roleId:c.roleId,mode:'synthetic-local-demo'},null,2)+'\n',{mode:0o600});
  let closing=false;
  const close=async()=>{if(closing)return;closing=true;await new Promise(ok=>{http.close(ok);http.closeIdleConnections();});await local.close();await cloud.close();privateDb.close();store.close();release();};
  return{url,close};
  } catch(error) {
    if(http?.listening)await new Promise(ok=>{http.close(ok);http.closeIdleConnections();});
    await local?.close();await cloud?.close();privateDb?.close();store?.close();release();throw error;
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const directory=process.argv[2];if(!directory)throw Error('需要指定独立的演示数据目录。');
  startDemo(directory).then(d=>{process.stdout.write(`本地联调页面：${d.url}\n合成模式，不连接真实群聊或收费模型。\n`);process.once('SIGTERM',()=>void d.close());process.once('SIGINT',()=>void d.close());}).catch(()=>{process.stderr.write('演示未启动，请核查独立数据目录与服务锁。\n');process.exitCode=1;});
}
