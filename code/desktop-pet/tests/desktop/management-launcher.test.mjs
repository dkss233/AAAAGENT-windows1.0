// Actual Foundation Process bridge; the fixed helper path contains a local test
// script. Never reads the real management session or opens a browser/backend.
import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';import {spawnSync} from 'node:child_process';import {resolve,join} from 'node:path';
const out=resolve('../../artifacts/W1/speech-control-02');mkdirSync(out,{recursive:true});const dir=mkdtempSync(join(out,'launcher-fixture-'));
const root=join(dir,'project with spaces'),desktop=join(root,'desktop'),script=join(root,'tools/start-management.mjs'),marker=join(dir,'invocation.json');mkdirSync(desktop,{recursive:true});mkdirSync(join(root,'tools'));
writeFileSync(join(dir,'main.swift'),readFileSync('desktop/native/main.swift','utf8')+String.raw`
let root=URL(fileURLWithPath:CommandLine.arguments[1]),node=CommandLine.arguments[2],scenario=CommandLine.arguments[3]
let launcher=ManagementPageLauncher(timeout:scenario == "timeout" ? 0.15 : 3)
var results=[Bool]()
func wait(){let end=Date().addingTimeInterval(4);while results.isEmpty && Date()<end{RunLoop.main.run(until:Date().addingTimeInterval(0.01))}}
precondition(launcher.open(desktopRoot:root,node:scenario == "missing" ? "/nonexistent/fixture-node":node){results.append($0)})
if scenario == "duplicate" {precondition(!launcher.open(desktopRoot:root,node:node){_ in fatalError("duplicate callback")})}
if scenario == "cancel" {DispatchQueue.main.asyncAfter(deadline:.now()+0.15){launcher.cancel()}}
wait();precondition(results == [scenario == "success" || scenario == "duplicate"])
RunLoop.main.run(until:Date().addingTimeInterval(0.06));precondition(results.count == 1)
print("launcher \(scenario): passed")
`);
try{
 const compile=spawnSync('swiftc',['-D','DESKTOP_CONNECTION_TEST',join(dir,'main.swift'),'-o',join(dir,'probe')],{encoding:'utf8',timeout:60000});assert.equal(compile.status,0,compile.stderr);
 for(const scenario of ['success','duplicate','failed','missing','timeout','cancel'])test('native management launcher '+scenario,()=>{
  writeFileSync(script,`import fs from 'node:fs';process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),pid:process.pid}));console.log('fixture-token-not-real');console.error('fixture-token-not-real');${scenario==='failed'?'process.exit(7)':scenario==='timeout'||scenario==='cancel'?'setInterval(()=>{},1000)':'setTimeout(()=>{},70)'}`);
  const run=spawnSync(join(dir,'probe'),[desktop,process.execPath,scenario],{encoding:'utf8',timeout:6000});assert.equal(run.status,0,run.stdout+run.stderr);assert.ok(!run.stdout.includes('fixture-token'));assert.ok(!run.stderr.includes('fixture-token'));console.log(run.stdout.trim());
  if(['success','duplicate','failed','timeout','cancel'].includes(scenario)){const invoked=JSON.parse(readFileSync(marker,'utf8'));assert.deepEqual(invoked.argv,[script]);assert.equal(invoked.cwd,root);assert.throws(()=>process.kill(invoked.pid,0),{code:'ESRCH'})}
 });
 test.after(()=>rmSync(dir,{recursive:true,force:true}));
}catch(e){rmSync(dir,{recursive:true,force:true});throw e}
