import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { engineInventory, here, sha256, verifyEngineRuntime } from './runtime.mjs';

const original=process.env.ENGINE_RUNTIME_ROOT;
assert.ok(original,'Use the actual pinned runtime for integrity checks');
const evidence=resolve(here,'../../../../.local/validation-20261010/runtime-integrity');mkdirSync(evidence,{recursive:true});

test('real complete graph refuses a replaced executable even with a forged marker; extra files and escaping links also fail',t=>{
  const temp=mkdtempSync(join(evidence,'drift-'));t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const runtime=join(temp,'runtime');cpSync(original,runtime,{recursive:true,verbatimSymlinks:true});
  assert.equal(verifyEngineRuntime(runtime).fileCount,verifyEngineRuntime(original).fileCount);
  const binary=join(runtime,process.platform === 'win32' ? 'codex/bin/codex.exe' : 'codex/bin/codex'),bytes=readFileSync(binary),markerFile=join(runtime,'.aaaagent-engine.json'),markerBytes=readFileSync(markerFile);
  writeFileSync(binary,'replaced binary');assert.throws(()=>verifyEngineRuntime(runtime),/runtime changed/);
  const marker=JSON.parse(markerBytes);marker.files[process.platform === 'win32' ? 'codex/bin/codex.exe' : 'codex/bin/codex'].sha256=sha256(Buffer.from('replaced binary'));
  writeFileSync(markerFile,JSON.stringify(marker));assert.throws(()=>verifyEngineRuntime(runtime),/runtime changed/);
  writeFileSync(binary,bytes);writeFileSync(markerFile,markerBytes);
  writeFileSync(join(runtime,'unexpected'),'unexpected');assert.throws(()=>verifyEngineRuntime(runtime),/runtime changed/);rmSync(join(runtime,'unexpected'));
  symlinkSync(evidence,join(runtime,'escape'),process.platform === 'win32' ? 'junction' : 'dir');assert.throws(()=>verifyEngineRuntime(runtime),/escapes install/);rmSync(join(runtime,'escape'));
  assert.equal(verifyEngineRuntime(runtime).fileCount,verifyEngineRuntime(original).fileCount);
});

test('editing a copied release lock cannot bless an existing runtime',async t=>{
  const temp=mkdtempSync(join(evidence,'lock-drift-'));t.after(()=>rmSync(temp,{recursive:true,force:true}));
  for(const name of ['runtime.mjs','engine-lock.json','package-lock.json','runtime-source.json'])cpSync(join(here,name),join(temp,name));
  const lock=JSON.parse(readFileSync(join(temp,'engine-lock.json')));lock.codex.version='0.999.0';writeFileSync(join(temp,'engine-lock.json'),JSON.stringify(lock));
  const copied=await import(pathToFileURL(join(temp,'runtime.mjs')));
  assert.throws(()=>copied.verifyEngineRuntime(original),/source lock changed/);
});
