import { isPrivateDirectorySync, isPrivateFileSync, restrictPrivatePathSync } from '../../../desktop-pet/dist/core/platform-files.js';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Bind one provider key and explicitly related native session files; never copies a home or lock. */
export async function bindDshInputs(profile, { credentialsFile, sourceDshHome, sessionFiles = [] } = {}) {
  const target = profile.dshHome;
  if (realpathSync(target) !== target || !isPrivateDirectorySync(target)) throw Error('Unsafe project DSH data home');
  const codec = await import(pathToFileURL(join(profile.runtimeRoot,'dsh/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js')));
  const plan = [];
  let key;
  if (credentialsFile) {
    const source = resolve(credentialsFile), stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || !isPrivateFileSync(source) || realpathSync(source) !== source)
      throw Error('Unsafe explicit DSH credentials');
    try {
      const text = readFileSync(source,'utf8'), migrated = codec.renderFlatLayoutMigration(text, source);
      key = codec.parseCredentialsDocument(migrated ?? text, source).refs.get('DEEPSEEK_API_KEY');
    } catch { throw Error('Original provider credential format could not be admitted'); }
    if (typeof key !== 'string' || !key.length) throw Error('Original DeepSeek provider key unavailable');
    plan.push({source, destination:join(target,'.credentials.yaml'),kind:'provider-key'});
  }
  for (const file of sessionFiles) {
    if (!sourceDshHome) throw Error('Explicit source DSH home required');
    const source=resolve(file), part=relative(join(resolve(sourceDshHome),'sessions'),source).replaceAll('\\','/'), stat=lstatSync(source);
    if (part.startsWith('..') || !/^[^/]+\/[a-zA-Z0-9_-]+\/session\.v3\.jsonl\.zstd$/.test(part) ||
        !stat.isFile() || stat.isSymbolicLink() || realpathSync(source)!==source) throw Error('Original DSH session outside selected scope');
    plan.push({source,destination:join(target,'sessions',part),kind:'original-session'});
  }
  const destinations=new Set();
  for(const item of plan) {
    if(destinations.has(item.destination)||item.kind!=='provider-key'&&existsSync(item.destination))throw Error('DSH selected input already exists; no overwrite');
    destinations.add(item.destination);
    for(let p=dirname(item.destination);p!==target;p=dirname(p))if(existsSync(p)&&realpathSync(p)!==p)throw Error('DSH input destination link refused');
  }
  for(const item of plan) {
    mkdirSync(dirname(item.destination),{recursive:true,mode:0o700});
    if(item.kind==='provider-key') {
      let previous={refs:new Map(),records:new Map()};
      if(existsSync(item.destination)) {
        const st=lstatSync(item.destination);
        if(!st.isFile()||st.isSymbolicLink()||!isPrivateFileSync(item.destination))throw Error('Unsafe existing DSH credential document');
        try { previous=codec.parseCredentialsDocument(readFileSync(item.destination,'utf8'),item.destination); }
        catch { throw Error('Existing project credential format changed'); }
      }
      const old=previous.refs.get('DEEPSEEK_API_KEY');
      if(old&&old!==key)throw Error('Existing project provider key differs; reconcile without replacing it');
      previous.refs.set('DEEPSEEK_API_KEY',key);
      writeFileSync(item.destination,JSON.stringify({version:1,refs:Object.fromEntries(previous.refs),records:Object.fromEntries(previous.records)},null,2)+'\n',{mode:0o600});
    }
    else copyFileSync(item.source,item.destination,constants.COPYFILE_EXCL);
    restrictPrivatePathSync(item.destination);
  }
  return {providerKeyPresent:!!key,selectedOriginalSessions:sessionFiles.length,sourceCredentialsChanged:false,modelRequests:0};
}
