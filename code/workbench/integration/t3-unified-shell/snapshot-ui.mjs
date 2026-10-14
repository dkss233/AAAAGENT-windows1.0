// Freeze actual management UI source from a Git commit; never copy private runtime.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const taskRoot=resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const source=resolve(process.argv[2]??'');
const requested=process.argv[3];
if(!requested || !/^[0-9a-f]{40}$/.test(requested))throw Error('Exact Git commit required');
const git=(...args)=>execFileSync('git',['-C',source,...args]);
const commit=git('rev-parse',requested+'^{commit}').toString().trim();
const prefix='code/desktop-pet/management/ui/';
const output=resolve(taskRoot,'artifacts/runtime/workspace-ui-integration-54/ui-'+commit);
if(existsSync(output))throw Error('Frozen UI already exists; verify receipt instead of overwrite');
const files=git('ls-tree','-rz','--full-tree',commit,'--',prefix).toString().split('\0').filter(Boolean);
const pins=[];
for(const entry of files){
 const match=entry.match(/^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/);
 if(!match)throw Error('Only regular tracked UI files allowed');
 const path=match[3];const name=path.slice(prefix.length);
 if(!/^[A-Za-z0-9._-]+\.(?:mjs|css|html)$/.test(name))throw Error('Unexpected UI path');
 const bytes=git('cat-file','blob',match[2]);
 mkdirSync(output,{recursive:true});writeFileSync(resolve(output,name),bytes);
 pins.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});
}
if(!pins.some(x=>x.path===prefix+'index.html') || !pins.some(x=>x.path===prefix+'app.mjs'))throw Error('Actual application entry absent');
const receipt={package:'B54-WORKSPACE-UI-INTEGRATION',source,commit,uiRoot:output,sourceFiles:pins,actualManagementSource:true,fixture:false};
const receiptPath=output+'.source.json';writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({commit,uiRoot:output,files:pins.length,receipt:relative(taskRoot,receiptPath)}));
