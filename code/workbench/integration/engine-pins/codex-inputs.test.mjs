import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bindCodexInputs } from './codex-inputs.mjs';

const evidence = resolve('artifacts/W0-I/engine-pin-54'); mkdirSync(evidence,{recursive:true});
function fixture(t) { const root=mkdtempSync(join(evidence,'inputs-')); t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'home'); mkdirSync(join(home,'.codex'),{recursive:true,mode:0o700});
  const skill=join(root,'chosen');mkdirSync(skill);writeFileSync(join(skill,'SKILL.md'),'---\nname: chosen\ndescription: Fixture.\n---\n');
  const account=join(root,'account');writeFileSync(account,'controlled-account',{mode:0o600});return {root,home,skill,account}; }
test('explicit selected inputs preserve the original account and exclude unrelated home data',t=>{
  const {root,home,skill,account}=fixture(t);writeFileSync(join(root,'unrelated'),'do not copy');
  assert.deepEqual(bindCodexInputs(home,{skills:[skill],authFile:account}),{selectedSkills:1,accountCopied:true,selectedOriginalSessions:0,modelRequests:0});
  assert.equal(readFileSync(account,'utf8'),'controlled-account');assert.equal(readFileSync(join(home,'.codex/auth.json'),'utf8'),'controlled-account');
  assert.throws(()=>bindCodexInputs(home,{skills:[skill],authFile:account}),/already exists/);
});
test('ambiguous sources and linked destinations fail before any account write',t=>{
  const {root,home,skill,account}=fixture(t);mkdirSync(join(root,'outside'));symlinkSync(join(root,'outside'),join(home,'.codex/skills'));
  assert.throws(()=>bindCodexInputs(home,{skills:[skill],authFile:account}),/destination link/);
  assert.throws(()=>bindCodexInputs(home,{skills:[skill,skill],authFile:account}),/Ambiguous/);
  assert.throws(()=>readFileSync(join(home,'.codex/auth.json')),/ENOENT/);
});
