import {readFile,writeFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const names=['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt','silero_vad.onnx'];
const hash=b=>createHash('sha256').update(b).digest('hex');
/** Exact reviewed model files only. Never replaces an existing file, follows a link or reads user recordings. */
export async function installWakeModels({sourceDirectory,destinationDirectory,expectedHashes}){
 const source=await realpath(sourceDirectory),destination=resolve(destinationDirectory);
 if(source!==sourceDirectory||names.some(n=>!/^[a-f0-9]{64}$/.test(expectedHashes?.[n]??'')))throw Error('Exact model sources and reviewed hashes required');
 const content=new Map();
 for(const name of names){const path=resolve(source,name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Model source must be a regular file');const bytes=await readFile(path);if(hash(bytes)!==expectedHashes[name])throw Error('Model source fingerprint changed');content.set(name,bytes);}
 for(let path=destination;path!==dirname(path);path=dirname(path)){
  try{if((await lstat(path)).isSymbolicLink())throw Error('Model destination cannot follow symlinks');}catch(e){if(e.code!=='ENOENT')throw e;}
 }
 for(const name of names){const path=resolve(destination,name);try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||hash(await readFile(path))!==expectedHashes[name])throw Error('Existing model file differs; preserved for review');}catch(e){if(e.code!=='ENOENT')throw e;}}
 await mkdir(destination,{recursive:true,mode:0o700});const created=[];
 for(const [name,bytes] of content){try{await writeFile(resolve(destination,name),bytes,{flag:'wx',mode:0o600});created.push(name);}catch(e){if(e.code!=='EEXIST'||hash(await readFile(resolve(destination,name)))!==expectedHashes[name])throw e;}}
 return {created,verified:names,sha256:expectedHashes,modelsLoaded:false};
}
