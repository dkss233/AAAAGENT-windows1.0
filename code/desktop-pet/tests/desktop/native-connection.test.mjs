// Runs the production transport with Foundation only: no NSApplication, WebKit,
// devices, provider configuration or model calls. Every child is local JS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const cache=resolve('desktop/.cache');mkdirSync(cache,{recursive:true});
const dir=mkdtempSync(join(cache,'connection-native-'));
const harness=String.raw`
let transport = BackendConnection()
func check(_ condition: @autoclosure () -> Bool, _ label: String) {
    if !condition() { transport.close(); RunLoop.main.run(until: Date().addingTimeInterval(0.65)); fputs("FAIL: \(label)\n", stderr); exit(1) }
}
func waitFor(_ condition: () -> Bool, _ seconds: Double = 2) {
    let end = Date().addingTimeInterval(seconds)
    while !condition() && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
    check(condition(), "bounded wait")
}
func settle(_ seconds: Double = 0.08) { RunLoop.main.run(until: Date().addingTimeInterval(seconds)) }
let node = CommandLine.arguments[1], scenario = CommandLine.arguments[2], pidFile = CommandLine.arguments[3]
var states: [(Int,String,String)] = [], messages: [(Int,[String:Any])] = []
transport.onState = { states.append(($0,$1,$2)) }
transport.onMessage = { messages.append(($0,$1)) }
let ready = "console.log(JSON.stringify({channel:'backend_ready',bridgeVersion:'0.2.0',characterId:'companion',sessionId:'local',pid:process.pid}));"
let hold = "setInterval(()=>{},1000);"
func start(_ script: String) {
    transport.start(executable: node, arguments: ["-e",script])
    if let pid = transport.processIdentifier {
        pids.append(pid); try! pids.map(String.init).joined(separator:"\n").write(toFile:pidFile,atomically:true,encoding:.utf8)
    }
}
func awaitReady() { waitFor { transport.state == "ready" } }
var pids: [Int32] = []
switch scenario {
case "launch":
    transport.start(executable: "/nonexistent/desktop-connection-node")
    check(transport.state == "failed" && states.last?.2 == "launch", "launch failure surfaced")
case "eof":
    start(ready + "require('fs').closeSync(1);" + hold)
    waitFor { transport.state == "disconnected" }
    check(states.last?.2 == "eof", "stdout EOF while process alive")
case "exit":
    start(ready + "setTimeout(()=>process.exit(17),50);"); awaitReady()
    waitFor { transport.state == "disconnected" }
    check(states.last!.2 == "eof" || states.last!.2 == "exit:17", "exit surfaced")
case "write":
    start("require('fs').closeSync(0);" + ready + hold); awaitReady()
    check(!transport.send(["channel":"command"], generation:transport.generation), "broken write rejected")
    check(transport.state == "disconnected" && states.last?.2 == "write", "EPIPE recoverable")
case "reconnect":
    start(ready + hold); awaitReady(); let old = transport.generation
    start(ready + hold); awaitReady(); settle()
    check(transport.state == "ready" && transport.generation == old + 1, "old termination cannot close replacement")
    check(!transport.send(["channel":"command"], generation:old), "queued old command rejected")
    check(messages.filter { $0.0 == old }.count == 1, "old reader detached")
case "timeout":
    transport.startupTimeout = 0.12; start(hold)
    waitFor { transport.state == "failed" }
    check(states.last?.2 == "ready-timeout", "hung startup bounded")
case "backpressure":
    start(ready + hold); awaitReady()
    let before = Date()
    check(transport.send(["payload":String(repeating:"x",count:4*1024*1024)], generation:transport.generation), "buffered output")
    transport.close()
    check(Date().timeIntervalSince(before) < 1, "blocked child cannot block close")
case "wire":
    start(ready + "require('readline').createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({channel:'event',received:JSON.parse(line)})));" )
    awaitReady()
    let command: [String:Any] = ["channel":"command","command":["type":"cancel"]]
    check(transport.send(command,generation:transport.generation), "live send")
    waitFor { messages.count == 2 }
    let echoed = messages[1].1["received"] as! [String:Any]
    check(echoed["channel"] as? String == "command" && echoed["generation"] == nil, "public wire unchanged")
    transport.close(); let count = messages.count; settle()
    check(messages.count == count, "closed callbacks ignored")
default: fatalError("unknown scenario")
}
let epoch = transport.generation
transport.close()
check(!transport.send(["channel":"command"],generation:epoch), "dead connection refuses commands")
settle(0.65)
for pid in pids { check(kill(pid,0) == -1 && errno == ESRCH, "child reaped \(pid)") }
print("PASS \(scenario); children checked=\(pids.count); final=\(transport.state)")
`;
try {
 const source=readFileSync('desktop/native/main.swift','utf8')+'\n'+harness;
 const file=join(dir,'main.swift'),binary=join(dir,'connection-test');writeFileSync(file,source);
 const compiled=spawnSync('/usr/bin/swiftc',['-D','DESKTOP_CONNECTION_TEST',file,'-o',binary],{encoding:'utf8',timeout:60000});
 assert.equal(compiled.status,0,compiled.stderr);
 for(const scenario of ['launch','eof','exit','write','reconnect','timeout','backpressure','wire']) {
  await test(`native connection: ${scenario}`,()=>{
   const pidFile=join(dir,scenario+'.pids');
   try {
    const result=spawnSync(binary,[process.execPath,scenario,pidFile],{encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr+'\n'+result.stdout); assert.match(result.stdout,/^PASS/);
    console.log(result.stdout.trim());
   } finally {
    let pids=[];try{pids=readFileSync(pidFile,'utf8').trim().split('\n').map(Number)}catch{}
    for(const pid of pids)try{process.kill(pid,'SIGKILL')}catch(error){if(error.code!=='ESRCH')throw error}
   }
  });
 }
} finally {rmSync(dir,{recursive:true,force:true});}
