import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEngineProfile } from '../../../workbench/integration/engine-pins/profile.mjs';
import { T3LocalService } from '../../../workbench/integration/t3-local-service.mjs';
import { readDshHost } from '../../../workbench/integration/engine-pins/dsh-service.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'),profile=readEngineProfile(root);
if(!profile)throw Error('Project engine profile is not installed');
const [action,flag,...extra]=process.argv.slice(2);
if(!['start','status','stop'].includes(action)||extra.length||action==='stop'&&flag!=='--confirm-stop-tasks'||action!=='stop'&&flag)
  throw Error('Usage: background.mjs start|status|stop --confirm-stop-tasks');
const service=new T3LocalService({sourceDir:resolve(root,'artifacts/runtime/engine-pin-54/t3-runtime'),
  nodeExecutable:profile.runtime.nodeExecutable,baseDir:resolve(root,'artifacts/runtime/engine-pin-54/t3-home'),
  logFile:resolve(profile.home,'t3-project-host.log'),dshWebLogPath:profile.dshWebLog,engineProjectRoot:root});
if(action==='stop'){await service.stopBackground();console.log('Project T3 and DSH stop requested.');}
else{if(action==='start')await service.start();console.log(JSON.stringify({t3:await service.status(),dsh:readDshHost(root),
  codex:'0.160.0',deepseekHarness:'0.2.0-rc.2'},null,2));}
