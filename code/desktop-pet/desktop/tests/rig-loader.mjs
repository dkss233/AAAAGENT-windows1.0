import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import vm from 'node:vm';
globalThis.__dirname=resolve('desktop/vendor/cubism/Core');
globalThis.require=createRequire(import.meta.url);
vm.runInThisContext(await readFile('desktop/vendor/cubism/Core/live2dcubismcore.min.js','utf8'));
for(let n=0;n<100;n++){try{Live2DCubismCore.Version.csmGetVersion();break}catch(e){if(n===99)throw e;await new Promise(r=>setTimeout(r,10))}}
const {JellyfishRenderer}=await import('../cubism-renderer.mjs');
export const read=async name=>{const b=await readFile('desktop/assets/jellyfish/'+name);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};
export async function createRig(readSource=read){
 class SilentRig extends JellyfishRenderer {draw(){}}
 const rig=new SilentRig(null,()=>{});try{await rig.loadRig(readSource);rig.ready=true;return rig}catch(e){rig.dispose();throw e}
}
