import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'AAAAGENT install 中文 '));
  t.after(async()=>{assert.equal(dirname(root),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
  const script=join(root,'Install-Windows.ps1');
  await copyFile(new URL('../../../../Install-Windows.ps1',import.meta.url),script);
  await mkdir(join(root,'code/desktop-pet'),{recursive:true});
  await writeFile(join(root,'code/desktop-pet/package-lock.json'),'{}');
  const run=(...args)=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,...args],
    {encoding:'utf8',windowsHide:true,timeout:15000,stdio:'pipe'});
  return {root,run};
}

test('installer preflight handles spaces and Unicode without creating configuration or dependencies',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),before=await readdir(f.root);
  const result=JSON.parse(f.run('-CheckOnly'));
  assert.equal(result.platform,'win32');assert.equal(result.architecture,'x64');assert.equal(result.existingConfiguration,false);
  assert.deepEqual(await readdir(f.root),before);
  assert.deepEqual(await readdir(join(f.root,'code/desktop-pet')),['package-lock.json']);
  assert.throws(()=>f.run('-CheckOnly','-PrepareOnly'),/Choose CheckOnly or PrepareOnly/);
});

for(const relative of ['.local/model-evaluation/trial/user-trial/config.json',
  '.local/model-evaluation/trial/user-trial/activation.json',
  '.local/model-evaluation/trial/user-trial/first-run.lock','.local/model-evaluation/backend.lock']){
  test('installer preserves existing '+relative+' before npm can change dependencies',{skip:process.platform!=='win32'},async t=>{
    const f=await fixture(t),file=join(f.root,relative);
    await mkdir(dirname(file),{recursive:true});await writeFile(file,'synthetic-preserve-exactly');
    assert.throws(()=>f.run('-PrepareOnly'),relative.endsWith('.lock')?/lock exists/:/Existing configuration preserved/);
    assert.equal(await readFile(file,'utf8'),'synthetic-preserve-exactly');
    assert.deepEqual(await readdir(join(f.root,'code/desktop-pet')),['package-lock.json']);
  });
}
