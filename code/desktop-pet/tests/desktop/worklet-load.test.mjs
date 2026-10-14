// Optional focused target: real pet:// AssetScheme + hidden WKWebView and an
// OfflineAudioContext. Creates no window and calls no live audio/device API.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const cache=resolve('desktop/.cache');mkdirSync(cache,{recursive:true});
const dir=mkdtempSync(join(cache,'worklet-wk-'));
try {
 const csp=readFileSync('desktop/index.html','utf8').match(/<meta http-equiv="Content-Security-Policy"[^>]+>/)?.[0];assert.ok(csp);
 mkdirSync(join(dir,'build'));
 copyFileSync('desktop/build/recorder-worklet.js',join(dir,'build/recorder-worklet.js'));
 writeFileSync(join(dir,'index.html'),`<!doctype html><head>${csp}</head><body><script src="probe.js"></script></body>`);
 writeFileSync(join(dir,'probe.js'),`
 (async()=>{try{
  const context=new OfflineAudioContext(1,128,48000);
  await context.audioWorklet.addModule(new URL('build/recorder-worklet.js',location.href));
  const node=new AudioWorkletNode(context,'pet-recorder');node.disconnect();node.port.close();
  window.webkit.messageHandlers.probe.postMessage({ok:true,origin:location.origin,context:context.constructor.name});
 }catch(e){window.webkit.messageHandlers.probe.postMessage({ok:false,name:e.name,message:e.message})}})();
 `);
 const harness=String.raw`
final class WorkletProbe: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let result = message.body as? [String:Any] ?? [:]
        let bytes = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(data:bytes,encoding:.utf8)!); exit(result["ok"] as? Bool == true ? 0 : 1)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let probe = WorkletProbe(), config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.setURLSchemeHandler(AssetScheme(root: URL(fileURLWithPath: CommandLine.arguments[1])), forURLScheme: "pet")
config.userContentController.add(probe, name: "probe")
let web = WKWebView(frame:.zero, configuration:config)
web.load(URLRequest(url:URL(string:"pet://app/index.html")!))
DispatchQueue.main.asyncAfter(deadline:.now()+15) { fputs("WK worklet probe timeout\n",stderr); exit(2) }
RunLoop.main.run()
`;
 const swift=join(dir,'main.swift'),binary=join(dir,'worklet-probe');
 writeFileSync(swift,readFileSync('desktop/native/display-layout.swift','utf8')+'\n'+readFileSync('desktop/native/main.swift','utf8')+'\n'+harness);
 const compiled=spawnSync('/usr/bin/swiftc',['-D','DESKTOP_WORKLET_TEST',swift,'-o',binary],{encoding:'utf8',timeout:60000});assert.equal(compiled.status,0,compiled.stderr);
 await test('native pet scheme CSP loads the same-origin recorder in OfflineAudioContext without a window',()=>{
  const run=spawnSync(binary,[dir],{encoding:'utf8',timeout:20000});
  console.log(run.stdout.trim());assert.equal(run.status,0,run.stderr+'\n'+run.stdout);
  const result=JSON.parse(run.stdout.trim().split('\n').at(-1));assert.equal(result.context,'OfflineAudioContext');assert.equal(result.ok,true);
 });
} finally {rmSync(dir,{recursive:true,force:true});}
