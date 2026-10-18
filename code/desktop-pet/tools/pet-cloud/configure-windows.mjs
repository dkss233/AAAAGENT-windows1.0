/** Configure only the existing QQ group and the optional desktop social cache. */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { initialize, readConfiguration } from './cli.mjs';
import { readPrivateSocialText, writePrivateSocialText } from '../../dist/companion/cloud/storage.js';
import { openLocalSocialConnection } from '../../dist/companion/cloud/local.js';

const root=fileURLToPath(new URL('../../../../',import.meta.url));
const bot=resolve(root,'../../VerinaBot/VerinaQQBot-Windows'),directory=resolve(root,'.local/social-service');
const file=resolve(directory,'service.json'),settings=JSON.parse(readPrivateSocialText(resolve(bot,'data/settings.json')));
if(typeof settings.group_openid!=='string'||!settings.group_openid)throw Error('请先在 QQ 机器人中绑定目标群。');
const credentialFile=resolve(bot,'secrets/credentials.json');
if(!JSON.parse(readPrivateSocialText(credentialFile)).deepseek_api_key)throw Error('需要已配置的 DeepSeek 云端密钥。');
const c=existsSync(file)?readConfiguration(directory):initialize(directory);
if(c.demo)throw Error('演示数据不能直接转作正式社交记忆。');
const groupId='qq-group-'+createHash('sha256').update(settings.group_openid).digest('hex').slice(0,40);
if(process.argv[2]==='--connect') {
  const origin=`http://127.0.0.1:${c.port}`;
  async function admin(route,method='GET',body){const r=await fetch(`${origin}/v1/${c.roleId}/${route}`,{method,redirect:'error',headers:{Authorization:'Bearer '+c.tokens.admin,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('社交服务配置请求未完成（HTTP '+r.status+'）');return r.json();}
  const state=await admin('status'),old=state.groups.find(g=>g.groupId===groupId);
  if(!old?.enabled||!old.shareWithOwner)await admin('group','PUT',{groupId,enabled:true,shareWithOwner:true,replyMode:'addressed',expectedRevision:old?.revision??0});
  const connection=openLocalSocialConnection(root);
  if(!connection)throw Error('桌宠社交连接未启用。');
  try{await connection.sync();console.log(JSON.stringify({serviceReady:true,desktopCacheFresh:connection.status().fresh,sharedGroups:1}));}finally{await connection.close();}
} else {
  c.name='魔法少女维里奈';c.persona='温柔、可爱、自然的维里奈。每位群友有自己的身份；群友经历不等于桌宠主人的经历。只总结真实已送达的交流，不把反馈或建议说成已经完成的动作。';
  c.model={endpoint:'https://api.deepseek.com/chat/completions',name:'deepseek-flash',credentialFile,credentialField:'deepseek_api_key'};
  c.nodePath=resolve(bot,'runtime/windows-x64/node/node.exe');c.maxRequestsPerDay=100;
  writePrivateSocialText(file,JSON.stringify(c,null,2)+'\n',false);
  const desktopFile=resolve(root,'.local/data/social-connection.json');
  if(existsSync(desktopFile)) {
    const old=JSON.parse(readPrivateSocialText(desktopFile));
    if(old.roleId!==c.roleId||old.endpoint!==`http://127.0.0.1:${c.port}`)throw Error('已有其他社交角色连接，已保留原设置。');
  }
  writePrivateSocialText(desktopFile,JSON.stringify({version:1,enabled:true,roleId:c.roleId,characterId:'companion',endpoint:`http://127.0.0.1:${c.port}`,syncToken:c.tokens.sync,maxAgeMs:300000,maxContextCharacters:6000},null,2)+'\n',false);
  writePrivateSocialText(resolve(bot,'secrets/social-channel.json'),JSON.stringify({version:1,enabled:true,roleId:c.roleId,endpoint:`http://127.0.0.1:${c.port}`,channelToken:c.tokens.channel,groups:[settings.group_openid]},null,2)+'\n',false);
  console.log(JSON.stringify({configured:true,model:'deepseek-flash',localModel:false,desktopLinked:true,qqLinked:true}));
}
