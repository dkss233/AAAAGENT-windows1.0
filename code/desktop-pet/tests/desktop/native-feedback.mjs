// Bounded native keyboard probe. Real WKWebView, pet:// handler, actual frontend
// and production sizing. Renderer/media adapters throw or remain inert; there
// is no backend, model call, database, live capture or audio output.
import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const baseline=process.argv.includes('--baseline'),prepare=process.argv.includes('--prepare'),out=resolve('../../artifacts/W1/companion-feedback-01'),dir=join(out,baseline?'native-fixture-before':'native-fixture-after');
mkdirSync(join(dir,'build'),{recursive:true});
const source=p=>baseline?execFileSync('git',['show','dc7597a:'+p],{encoding:'utf8'}):readFileSync(p.replace('code/desktop-pet/',''),'utf8');
const entry=source('code/desktop-pet/desktop/main.mjs');
writeFileSync(join(dir,'index.html'),source('code/desktop-pet/desktop/index.html').replace('<script src="vendor/cubism/Core/live2dcubismcore.min.js"></script>',''));
writeFileSync(join(dir,'style.css'),source('code/desktop-pet/desktop/style.css'));
await build({stdin:{contents:entry,resolveDir:resolve('desktop'),sourcefile:'main.mjs'},bundle:true,format:'esm',outfile:join(dir,'build/renderer.js'),plugins:[{name:'no-devices',setup(b){
 b.onResolve({filter:/cubism-renderer\.mjs|browser-playback\.ts|browser-capture\.ts/},a=>({path:a.path,namespace:'silent'}));
 b.onLoad({filter:/.*/,namespace:'silent'},a=>({contents:a.path.includes('cubism')?'export class JellyfishRenderer{async load(){}setFraming(){}reset(){}snapshot(){return {}}dispose(){}updateView(){}}':`export class ${a.path.includes('playback')?'BrowserPlaybackDriver':'BrowserCaptureDriver'}{open(){throw Error('native fixture forbids devices')}}`}));
 if(baseline){b.onResolve({filter:/display-controls\.mjs/},()=>({path:'controls',namespace:'old'}));b.onLoad({filter:/.*/,namespace:'old'},()=>({contents:source('code/desktop-pet/desktop/display-controls.mjs')}));}
}}]});
const native=source('code/desktop-pet/desktop/native/main.swift');
const focus=native.match(/^\s*web\.focusRingType = .*$/m)?.[0]??'';
const harness=String.raw`
final class FeedbackProbe: NSObject, WKScriptMessageHandler {
 var web: WKWebView!, panel: PetPanel!, opened=false, stage=0, replies=[[String:Any]]()
 let output=CommandLine.arguments[2]
 let active=CommandLine.arguments.contains("--active")
 let previous=NSWorkspace.shared.frontmostApplication
 var activatedAt:Date?
 func restore() { if active {panel.orderOut(nil);previous?.activate(options:[])} }
 func js(_ source:String,_ then:(()->Void)?=nil) { web.evaluateJavaScript(source) { _,error in if let error { fputs("JS: \(error)\n",stderr) };then?() } }
 func layout() {
  let l=PetDisplayLayout.fit(width:360,open:opened,screen:CGRect(x:0,y:0,width:1000,height:1000),anchor:CGPoint(x:0,y:1000))
  let screen=NSScreen.main?.visibleFrame ?? CGRect(x:0,y:0,width:1200,height:1000)
  panel.setFrame(CGRect(x:active ? screen.minX+20 : -10000,y:active ? screen.maxY-l.frame.height-20 : -10000,width:l.frame.width,height:l.frame.height),display:true)
  js("petBridge.displayConfig({mode:'half',preferredWidth:360,modelWidth:\(l.modelWidth),modelHeight:\(l.modelHeight),drawerHeight:\(l.drawerHeight)})")
 }
 func delay(_ work:@escaping()->Void) { DispatchQueue.main.asyncAfter(deadline:.now()+(active ? 0.22 : 0.35),execute:work) }
 func key(_ type:NSEvent.EventType) {
  let event=NSEvent.keyEvent(with:type,location:.zero,modifierFlags:[],timestamp:ProcessInfo.processInfo.systemUptime,windowNumber:panel.windowNumber,context:nil,characters:" ",charactersIgnoringModifiers:" ",isARepeat:false,keyCode:49)!
  if type == .keyDown { web.keyDown(with:event) } else { web.keyUp(with:event) }
 }
 func capture(_ name:String,_ then:@escaping()->Void) {
  js("JSON.stringify({name:'\(name)',hidden:document.getElementById('drawer').hidden,active:document.activeElement.id,focusVisible:Array.from(document.querySelectorAll(':focus-visible')).map(n=>n.id)})")
  web.evaluateJavaScript("JSON.stringify({name:'\(name)',hidden:document.getElementById('drawer').hidden,active:document.activeElement.id,focusVisible:Array.from(document.querySelectorAll(':focus-visible')).map(n=>n.id)})") { value,_ in
   if let s=value as? String,let data=s.data(using:.utf8),var d=try? JSONSerialization.jsonObject(with:data) as? [String:Any] {d["hostFocusRingType"]=self.web.focusRingType.rawValue;d["isKey"]=self.panel.isKeyWindow;d["appActive"]=NSApp.isActive;d["firstResponder"]=String(describing:self.panel.firstResponder);self.replies.append(d)}
   self.web.takeSnapshot(with:nil) { image,error in
    if let data=image?.tiffRepresentation,let b=NSBitmapImageRep(data:data),let png=b.representation(using:.png,properties:[:]) {try? png.write(to:URL(fileURLWithPath:self.output+"-"+name+".png"))};then()
   }
  }
 }
 func run() {
  if active {activatedAt=Date();NSApp.activate(ignoringOtherApps:true);panel.makeKeyAndOrderFront(nil);panel.makeFirstResponder(web);DispatchQueue.main.asyncAfter(deadline:.now()+2.5){self.restore();fputs("native active time bound reached\n",stderr);exit(3)}}
  js("petBridge.connectionChanged({generation:1,state:'connecting'});petBridge.receive({channel:'backend_ready',bridgeVersion:'0.2.0',characterId:'companion',sessionId:'native-fixture'},1);document.getElementById('open').click()")
  delay {self.js("document.getElementById('close').click()");self.delay{self.panel.makeFirstResponder(self.web);self.key(.keyDown);self.key(.keyUp);self.delay{self.capture("closed-space"){
   self.js("petBridge.hotkeyConfig('Space')");self.delay{self.key(.keyDown);self.key(.keyUp);self.delay{self.capture("ptt-space"){
    if self.active {self.replies.append(["activeSeconds":Date().timeIntervalSince(self.activatedAt!),"restoringPID":self.previous?.processIdentifier ?? -1])}
    self.restore()
    DispatchQueue.main.asyncAfter(deadline:.now()+0.1){
     if self.active {self.replies.append(["restoredFrontmostPID":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1])}
     let data=try! JSONSerialization.data(withJSONObject:self.replies,options:[.prettyPrinted,.sortedKeys]);try! data.write(to:URL(fileURLWithPath:self.output+".json"));print(String(data:data,encoding:.utf8)!);self.panel.close();exit(0)
    }
   }}}
  }}}}
 }
 func userContentController(_ controller:WKUserContentController,didReceive message:WKScriptMessage) {
  guard message.name == "shell",let d=message.body as? [String:Any] else{return}
  if d["type"] as? String == "ready" {layout();delay{self.run()}}
  if d["type"] as? String == "panel" {opened=d["open"] as? Bool ?? false;layout()}
 }
}
let app=NSApplication.shared;app.setActivationPolicy(.accessory)
let probe=FeedbackProbe(),config=WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.setURLSchemeHandler(AssetScheme(root:URL(fileURLWithPath:CommandLine.arguments[1])),forURLScheme:"pet")
for name in ["shell","desktop","diagnostic"] {config.userContentController.add(probe,name:name)}
let web=WKWebView(frame:CGRect(x:0,y:0,width:500,height:916),configuration:config)
FOCUS_CONFIG
web.setValue(false,forKey:"drawsBackground");web.underPageBackgroundColor = .clear
let panel=PetPanel(contentRect:CGRect(x:-10000,y:-10000,width:500,height:916),styleMask:[.borderless],backing:.buffered,defer:false)
panel.isOpaque=false;panel.backgroundColor = .clear;panel.contentView=web;panel.orderFront(nil);panel.makeKey();panel.makeFirstResponder(web)
probe.web=web;probe.panel=panel
web.load(URLRequest(url:URL(string:"pet://app/index.html")!))
DispatchQueue.main.asyncAfter(deadline:.now()+20){fputs("native focus timeout\n",stderr);exit(2)}
app.run()
`.replace('FOCUS_CONFIG',focus);
try{
 writeFileSync(join(dir,'main.swift'),source('code/desktop-pet/desktop/native/display-layout.swift')+'\n'+native+'\n'+harness);
 const compile=spawnSync('swiftc',['-D','DESKTOP_WORKLET_TEST',join(dir,'main.swift'),'-o',join(dir,'native-probe')],{encoding:'utf8',timeout:60000});assert.equal(compile.status,0,compile.stderr);
 if(prepare){console.log(join(dir,'native-probe'));}else{
 const run=spawnSync(join(dir,'native-probe'),[dir,join(out,baseline?'before-native':'after-native')],{encoding:'utf8',timeout:25000});
 writeFileSync(join(out,baseline?'before-native-run.txt':'after-native-run.txt'),run.stdout+'\n'+run.stderr);assert.equal(run.status,0,run.stderr+'\n'+run.stdout);console.log(run.stdout);}
}finally{if(!prepare)rmSync(dir,{recursive:true,force:true})}
