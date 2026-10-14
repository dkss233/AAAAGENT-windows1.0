/** Pinned Windows review workbench, independent of the existing pet activation. */
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {readEngineProfile} from './profile.mjs';
import {T3LocalService} from '../t3-local-service.mjs';
import {T3HttpClient} from '../t3-http-client.mjs';
import {openLocalUrl} from '../../../desktop-pet/dist/core/open-url.js';
import {restrictPrivatePathSync} from '../../../desktop-pet/dist/core/platform-files.js';
const root=resolve(import.meta.dirname,'../../../..'),action=process.argv[2]??'open';
if(!['start','open','status','stop'].includes(action)||action==='stop'&&process.argv[3]!=='--confirm-stop-tasks')throw Error('Use start, open, status, or stop --confirm-stop-tasks');
const profile=readEngineProfile(root);if(!profile)throw Error('First install the new isolated engine profile');
const service=new T3LocalService({sourceDir:join(root,'artifacts/runtime/engine-pin-54/t3-runtime'),nodeExecutable:profile.runtime.nodeExecutable,baseDir:join(root,'.local/data/t3-home'),logFile:join(root,'.local/data/logs/t3-review.log'),dshWebLogPath:profile.dshWebLog,engineProjectRoot:root});
if(action==='stop'){await service.stopBackground();console.log(JSON.stringify({status:'stop-requested'}));}
else if(action==='status'){try{console.log(JSON.stringify({status:'running',...await service.status()}));}catch(error){if(error.code!=='ENOENT')throw error;console.log(JSON.stringify({status:'stopped'}));}}
else{const connection=await service.start();const client=new T3HttpClient(service);const descriptor=await client.environmentDescriptor();const models=await client.providerModels();const ui=await fetch(connection.origin);if(!ui.ok||(await ui.text()).includes('/native/assets/'))throw Error('Normal T3 web renderer unavailable');
 const status=await service.status();const safe={status:'ready',checkedAt:new Date().toISOString(),...status,environmentId:descriptor.environmentId,providers:models.providers.map(p=>({instanceId:p.instanceId,status:p.status,models:p.models.length})),sourceDir:service.options.sourceDir,baseDir:service.options.baseDir};
 const directory=join(root,'.local/data/workbench-review');mkdirSync(directory,{recursive:true,mode:0o700});restrictPrivatePathSync(directory);
 const temporary=join(directory,'.status-'+randomUUID()+'.tmp');
 try{writeFileSync(temporary,JSON.stringify(safe,null,2)+'\n',{flag:'wx',mode:0o600});restrictPrivatePathSync(temporary);renameSync(temporary,join(directory,'status.json'));}
 finally{rmSync(temporary,{force:true});}
 console.log(JSON.stringify(safe));
 if(action==='open'){const entry=await service.openBrowser({kind:'home',environmentId:descriptor.environmentId});await openLocalUrl(entry.url);}
}
