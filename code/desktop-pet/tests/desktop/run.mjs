// Complete desktop regression, all silent. Bundled rig test uses real Core/moc with GPU draw omitted.
import {build} from 'esbuild';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url));process.chdir(root);
const compiled=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json'],{stdio:'inherit'});
if(compiled.status!==0)process.exit(compiled.status??1);
const cache=resolve('desktop/.cache');await mkdir(cache,{recursive:true});
const dir=await mkdtemp(join(cache,'silent-test-'));const rig=join(dir,'rig.mjs');
try{
 await build({entryPoints:['tests/desktop/model-parameters.test.mjs'],bundle:true,platform:'node',format:'esm',outfile:rig,legalComments:'eof'});
 const result=spawnSync(process.execPath,['--test','dist/tests/desktop','tests/desktop/probe-policy.test.mjs','tests/desktop/connection-state.test.mjs','tests/desktop/introduction.test.mjs','tests/desktop/trial-feedback.test.mjs','tests/desktop/native-connection.test.mjs','tests/desktop/display-controls.test.mjs','tests/desktop/native-display.test.mjs',rig],{stdio:'inherit'});
 process.exitCode=result.status??1;
}finally{await rm(dir,{recursive:true,force:true});}
