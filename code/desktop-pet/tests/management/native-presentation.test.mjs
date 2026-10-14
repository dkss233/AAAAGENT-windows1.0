// Production Foundation transport only; no AppKit/WebKit session, model, or device.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
test('production native transport forwards initial and changed policy after ready without inventing an IPC path',async t=>{
 const parent=resolve('../../artifacts/W0-I/preset-management-01/native');await mkdir(parent,{recursive:true});const dir=await mkdtemp(join(parent,'policy-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const source=await readFile('desktop/native/main.swift','utf8');
 const harness=String.raw`
let transport = BackendConnection()
var messages: [[String:Any]] = []
transport.onMessage = { _,message in messages.append(message) }
let script = "console.log(JSON.stringify({channel:'backend_ready'}));console.log(JSON.stringify({channel:'presentation_policy',policy:{modelId:'test',revision:0,enabledIds:['exp-zzz']}}));require('readline').createInterface({input:process.stdin}).on('line',()=>console.log(JSON.stringify({channel:'presentation_policy',policy:{modelId:'test',revision:1,enabledIds:[]}})));"
transport.start(executable: CommandLine.arguments[1],arguments:["-e",script])
func wait(_ n:Int){let end=Date().addingTimeInterval(3);while messages.count<n && Date()<end{RunLoop.main.run(until:Date().addingTimeInterval(0.01))};precondition(messages.count>=n)}
wait(2)
precondition(messages[0]["channel"] as? String == "backend_ready")
precondition(messages[1]["channel"] as? String == "presentation_policy")
precondition((messages[1]["policy"] as! [String:Any])["revision"] as? Int == 0)
precondition(transport.send(["channel":"command"],generation:transport.generation))
wait(3)
precondition((messages[2]["policy"] as! [String:Any])["enabledIds"] as? [String] == [])
transport.close();RunLoop.main.run(until:Date().addingTimeInterval(0.7))
print("PASS native presentation policy forwarding")
`;
 const file=join(dir,'main.swift'),binary=join(dir,'policy');await writeFile(file,source+'\n'+harness);
 const compile=spawnSync('/usr/bin/swiftc',['-D','DESKTOP_CONNECTION_TEST',file,'-o',binary],{encoding:'utf8',timeout:60000});assert.equal(compile.status,0,compile.stderr);
 const result=spawnSync(binary,[process.execPath],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/PASS native/);
});
