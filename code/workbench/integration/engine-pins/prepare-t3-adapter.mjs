import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { here, engineInventory, sha256 } from './runtime.mjs';

const readLock = () => {
  const lock = JSON.parse(readFileSync(join(here,'t3-adapter-source.json'),'utf8'));
  if (sha256(readFileSync(join(here, '../patches/0007-explicit-strict-policy-0160.patch'))) !== lock.strictPolicySourcePatchSha256)
    throw Error('Strict policy source patch changed');
  return lock;
};

export function applyT3AdapterLayers(original, lock = readLock()) {
  if (sha256(Buffer.from(original)) !== lock.originalBundleSha256) throw Error('T3 adapter input changed');
  let patched = original;
  for (const [before, after] of [[lock.before, lock.after], [lock.strictPolicyBefore, lock.strictPolicyAfter]]) {
    if (!before || !after || patched.split(before).length !== 2) throw Error('T3 adapter patch context changed');
    patched = patched.replace(before, after);
  }
  const strictGuard = value => value.slice(value.indexOf('function verifyStrictOpenResponse('), value.indexOf('\nconst openCodexThread ='));
  if (!strictGuard(original) || strictGuard(original) !== strictGuard(patched) || sha256(strictGuard(patched)) !== lock.strictResponseGuardSha256)
    throw Error('Strict response guard changed');
  if (sha256(Buffer.from(patched)) !== lock.adaptedBundleSha256) throw Error('T3 adapter patch digest mismatch');
  return patched;
}
export function verifyT3EngineAdapter(directory) {
  const lock=readLock(), actual=engineInventory(resolve(directory));
  const inventorySha256 = sha256(JSON.stringify(actual));
  if (process.platform === 'win32') {
    const windows = lock.windowsRuntime;
    if (!windows || windows.platform !== process.platform || windows.arch !== process.arch ||
        windows.sourceCommit !== lock.sourceCommit || inventorySha256 !== windows.inventorySha256 ||
        sha256(readFileSync(join(here, 'windows-t3-source.json'))) !== windows.sourceLockSha256 ||
        sha256(readFileSync(join(directory, 'apps/server/dist/bin.mjs'))) !== windows.serverBundleSha256 ||
        sha256(readFileSync(join(directory, '.aaaagent-prepared.json'))) !== windows.markerSha256)
      throw Error('Windows T3 engine runtime changed');
    return { sourceCommit: windows.sourceCommit, inventorySha256, package: windows.package };
  }
  if (inventorySha256 === lock.adaptedInventorySha256) return {sourceCommit:lock.sourceCommit,inventorySha256};
  const native = lock.nativeSyncRuntime;
  if (!native || inventorySha256 !== native.inventorySha256 || sha256(readFileSync(join(here,'native-sync-source.json'))) !== native.sourceLockSha256 ||
      sha256(readFileSync(join(here,'../patches/0017-native-session-sync.patch'))) !== native.sourcePatchSha256 ||
      sha256(readFileSync(join(directory,'apps/server/dist/bin.mjs'))) !== native.serverBundleSha256 ||
      native.forwardedSourcePatchSha256 && sha256(readFileSync(join(here,'../patches/0018-native-app-forwarded-input.patch'))) !== native.forwardedSourcePatchSha256 ||
      native.webExecutionSourcePatchSha256 && sha256(readFileSync(join(here,'../patches/0019-dsh-web-execution.patch'))) !== native.webExecutionSourcePatchSha256 ||
      native.realtimeSourcePatchSha256 && sha256(readFileSync(join(here,'../patches/0021-native-history-realtime.patch'))) !== native.realtimeSourcePatchSha256 ||
      native.inputRepairSourcePatchSha256 && sha256(readFileSync(join(here,'../patches/0022-native-input-repair.patch'))) !== native.inputRepairSourcePatchSha256 ||
      native.supervisedStateSyncSourcePatchSha256 && sha256(readFileSync(join(here,'../patches/0023-dsh-supervised-state-sync.patch'))) !== native.supervisedStateSyncSourcePatchSha256)
    throw Error('T3 engine adapter runtime changed');
  return { sourceCommit: lock.sourceCommit, inventorySha256, package: native.package };
}

/** Reviewed transport and explicit strict-policy layers over the accepted B54 bundle. */
export function prepareT3EngineAdapter(source, target) {
  if(existsSync(target)) return verifyT3EngineAdapter(target);
  const lock=readLock();
  if(sha256(JSON.stringify(engineInventory(resolve(source))))!==lock.originalInventorySha256)
    throw Error('Original accepted T3 runtime changed');
  cpSync(source,target,{recursive:true,verbatimSymlinks:true,errorOnExist:true,force:false});
  const path=join(target,'apps/server/dist/bin.mjs'), old=readFileSync(path,'utf8');
  const patched=applyT3AdapterLayers(old,lock);
  writeFileSync(path,patched);
  return verifyT3EngineAdapter(target);
}
