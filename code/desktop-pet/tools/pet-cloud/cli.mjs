#!/usr/bin/env node
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync,openSync,closeSync,unlinkSync,statSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SocialStore} from '../../dist/companion/cloud/store.js';
import {startSocialServer} from '../../dist/companion/cloud/server.js';
import {DemoSocialModel,OpenAICompatibleSocialModel,endpointUrl} from '../../dist/companion/cloud/model.js';
import {readPrivateSocialText,writePrivateSocialText} from '../../dist/companion/cloud/storage.js';

export function initialize(directory,{demo=false}={}){
  directory=resolve(directory);mkdirSync(directory,{recursive:true,mode:0o700});
  const filename=resolve(directory,'service.json');if(existsSync(filename))throw Error('此目录已初始化，原配置已保留。');
  const config={version:1,roleId:`pet-${randomUUID()}`,name:'本地桌宠',persona:'温和、坦率、有自己的判断。与不同的人形成独立关系，保持简短自然的交流。',host:'127.0.0.1',port:18766,demo,maxRequestsPerDay:100,tokens:{admin:randomBytes(32).toString('hex'),channel:randomBytes(32).toString('hex'),sync:randomBytes(32).toString('hex')}};
  writePrivateSocialText(filename,JSON.stringify(config,null,2)+'\n');
  return config;
}
export function readConfiguration(directory){
  const filename=resolve(directory,'service.json');
  const config=JSON.parse(readPrivateSocialText(filename));if(config.version!==1)throw Error('服务配置版本不受支持。');return config;
}
export function acquireLock(directory){
  const filename=resolve(directory,'service.lock');
  if(existsSync(filename)){
    const old=JSON.parse(readPrivateSocialText(filename));
    if(!Number.isSafeInteger(old.pid)||old.pid<1)throw Error('请核查原服务锁文件。');
    try{process.kill(old.pid,0);throw Error('此目录已有服务运行。');}catch(error){if(error.code!=='ESRCH')throw error;}
    unlinkSync(filename);
  }
  const identity={pid:process.pid,instance:randomUUID()};writePrivateSocialText(filename,JSON.stringify(identity));
  return()=>{if(existsSync(filename)&&JSON.parse(readPrivateSocialText(filename)).instance===identity.instance)unlinkSync(filename);};
}
export async function serve(directory){
  directory=resolve(directory);const c=readConfiguration(directory),release=acquireLock(directory);let store,server;
  try{
    if(!c.demo&&!process.env.PET_SOCIAL_API_KEY_FILE&&!process.env.PET_SOCIAL_API_KEY&&!c.model?.credentialFile)throw Error('请先配置社交模型的专用凭据。');
    const modelEndpoint=process.env.PET_SOCIAL_MODEL_ENDPOINT??c.model?.endpoint??'';
    if(!c.demo&&endpointUrl(modelEndpoint).protocol!=='https:')throw Error('正式社交服务必须使用 HTTPS 云端模型。');
    const model=c.demo?new DemoSocialModel():new OpenAICompatibleSocialModel({endpoint:modelEndpoint,model:process.env.PET_SOCIAL_MODEL??c.model?.name??'',apiKey:()=>{
      if(process.env.PET_SOCIAL_API_KEY)return process.env.PET_SOCIAL_API_KEY.trim();
      const file=process.env.PET_SOCIAL_API_KEY_FILE??c.model?.credentialFile;if(!file)throw Error('缺少模型密钥文件。');
      const raw=readPrivateSocialText(file,c.model?.credentialField?16000:2048);
      const value=c.model?.credentialField?JSON.parse(raw)[c.model.credentialField]:raw;
      if(typeof value!=='string'||!value.trim())throw Error('云端模型凭据尚未配置。');return value.trim();
    }});
    store=new SocialStore(resolve(directory,'social.sqlite'),c.roleId,{name:c.name,persona:c.persona});
    server=await startSocialServer({store,model,tokens:c.tokens,host:process.env.PET_SOCIAL_HOST??c.host,port:Number(process.env.PET_SOCIAL_PORT??c.port),maxRequestsPerDay:c.maxRequestsPerDay});
    writePrivateSocialText(resolve(directory,'runtime.json'),JSON.stringify({pid:process.pid,url:server.url,roleId:c.roleId,mode:c.demo?'demo':'configured-model'},null,2)+'\n',false);
    process.stdout.write(`角色服务已启动：${server.url}；模式：${c.demo?'合成联调（无模型调用）':'配置的云模型'}\n`);
    let closing=false;const close=async()=>{if(closing)return;closing=true;await server.close();store.close();release();};
    process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());return{server,store,close};
  }catch(error){await server?.close();store?.close();release();throw error;}
}
async function admin(directory,path,method='GET',value){
  const c=readConfiguration(directory),runtime=JSON.parse(readFileSync(resolve(directory,'runtime.json'),'utf8'));
  const url=endpointUrl(runtime.url);const response=await fetch(new URL(`/v1/${c.roleId}/${path}`,url),{method,redirect:'error',headers:{Authorization:`Bearer ${c.tokens.admin}`,...(value?{'Content-Type':'application/json'}:{})},...(value?{body:JSON.stringify(value)}:{}),signal:AbortSignal.timeout(10000)});
  const body=await response.json();if(!response.ok)throw Error(body.error??'request_failed');return body;
}
async function main(){
  const [command,directory,...args]=process.argv.slice(2);if(!directory)throw Error('用法：node tools/pet-cloud/cli.mjs init|serve|status|group|persona|forget|link <数据目录>');
  if(command==='init'){initialize(directory,{demo:args.includes('--demo')});process.stdout.write(`已初始化：${resolve(directory)}（凭据仅保存在本机配置中）\n`);}
  else if(command==='serve')await serve(directory);
  else if(command==='status')process.stdout.write(JSON.stringify(await admin(directory,'status'),null,2)+'\n');
  else if(command==='jobs')process.stdout.write(JSON.stringify(await admin(directory,'jobs'),null,2)+'\n');
  else if(command==='resolve'){
    if(!args[0]||!['skip','retry-model','retry-delivery','confirm-delivered'].includes(args[1]))throw Error('用法：resolve <数据目录> <事件ID> skip|retry-model|retry-delivery|confirm-delivered [发送回执ID]');
    await admin(directory,'jobs/resolve','POST',{eventId:args[0],action:args[1],...(args[2]?{receipt:args[2]}:{})});process.stdout.write('该事件的处理决定已保存。\n');
  }
  else if(command==='group'){
    const groupId=args[0];if(!groupId)throw Error('需要渠道适配器的准确群标识。');const status=await admin(directory,'status'),old=status.groups.find(g=>g.groupId===groupId);
    await admin(directory,'group','PUT',{groupId,enabled:!args.includes('--disable'),shareWithOwner:args.includes('--share'),replyMode:args.includes('--all')?'all':'addressed',expectedRevision:old?.revision??0});process.stdout.write('群设置已保存。\n');
  }else if(command==='persona'){
    const next=JSON.parse(readFileSync(args[0],'utf8')),status=await admin(directory,'status');await admin(directory,'persona','PUT',{name:next.name,persona:next.persona,expectedRevision:status.persona.revision});process.stdout.write('公开人设已更新。\n');
  }else if(command==='forget'){await admin(directory,`experiences/${encodeURIComponent(args[0]??'')}`,'DELETE');process.stdout.write('社交经历已撤回，桌宠下次同步会移除。\n');}
  else if(command==='link'){
    if(!args[0]||!args[1])throw Error('用法：link <服务数据目录> <桌宠项目根> <云端 HTTPS 地址或本机 HTTP 地址>');
    const c=readConfiguration(directory),endpoint=endpointUrl(args[1]).origin,filename=resolve(args[0],'.local/data/social-connection.json');
    mkdirSync(dirname(filename),{recursive:true,mode:0o700});
    writePrivateSocialText(filename,JSON.stringify({version:1,enabled:true,roleId:c.roleId,characterId:'companion',endpoint,syncToken:c.tokens.sync,maxAgeMs:300000,maxContextCharacters:6000},null,2)+'\n');process.stdout.write(`连接文件已生成：${filename}。重启已接入此模块的桌宠后生效。\n`);
  }else throw Error('未知命令。');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'启动失败'}\n`);process.exitCode=1;});
