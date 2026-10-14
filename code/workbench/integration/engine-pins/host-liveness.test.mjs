import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { T3LocalService } from '../t3-local-service.mjs';
import { projectT3EngineSettings } from './profile.mjs';

const evidence=resolve('artifacts/W0-I/engine-pin-54');mkdirSync(evidence,{recursive:true});
test('cached live T3 refuses a dead native DSH child before returning a usable connection',async t=>{
  const root=mkdtempSync(join(evidence,'host-liveness-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home'),baseDir=join(root,'t3'),sourceDir=join(root,'source');
  mkdirSync(home);mkdirSync(join(baseDir,'userdata'),{recursive:true});
  const profile={home,runtimeRoot:join(root,'engines'),dshHome:join(home,'.dsh'),codexHome:join(home,'.codex'),
    codexLauncher:join(root,'codex'),runtime:{inventorySha256:'known'}};
  writeFileSync(join(baseDir,'userdata/settings.json'),JSON.stringify(projectT3EngineSettings({},profile)),{mode:0o600});
  writeFileSync(join(baseDir,'.aaaagent-t3-host.json'),JSON.stringify({version:1,origin:'http://127.0.0.1:10000',token:'a'.repeat(64),
    hostPid:process.pid,sourceDir,baseDir,engineProjectRoot:root}),{mode:0o600});
  const descriptor={version:1,projectRoot:root,runtimeRoot:profile.runtimeRoot,home,dataHome:profile.dshHome,
    inventorySha256:'known',pid:process.pid,childPid:process.pid,origin:'http://127.0.0.1:10001'};
  const file=join(home,'.aaaagent-dsh-host.json');writeFileSync(file,JSON.stringify(descriptor),{mode:0o600});
  const service=new T3LocalService({sourceDir,nodeExecutable:process.execPath,baseDir,logFile:join(home,'log'),engineProjectRoot:root});
  service.verifiedEngineHostPid=process.pid;service.verifiedEngineProfile=profile;
  assert.equal((await service.ensureHost()).hostPid,process.pid);
  writeFileSync(file,JSON.stringify({...descriptor,childPid:2147483647}),{mode:0o600});
  await assert.rejects(service.ensureHost(),e=>e.code==='ESRCH');
});
