// Bounded native integration observation of the production AppDelegate/clip/WK code.
// Preparation is silent; --run-once is only used for the C-scheduled <=8s slot.
import {readFileSync,writeFileSync,mkdirSync,cpSync,existsSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),root=resolve(project,'../..');
const [mode,sourceArg]=process.argv.slice(2),source=resolve(sourceArg||root),desktop=join(source,'code/desktop-pet/desktop');
const out=join(root,'artifacts/W0-I/panel-stability-01/native'),fixture=join(out,'fixture'),binary=join(out,'NativePanelStability');
const hash=v=>createHash('sha256').update(v).digest('hex');
const inputs=['native/main.swift','native/display-layout.swift','main.mjs','display-controls.mjs','style.css','index.html','cubism-renderer.mjs'];
const fingerprints=()=>Object.fromEntries(inputs.map(p=>[p,hash(readFileSync(join(desktop,p)))]));
if(mode==='--run-once'){
 const prep=JSON.parse(readFileSync(join(out,'preparation.json')));
 if(JSON.stringify(prep.sources)!==JSON.stringify(fingerprints())||hash(readFileSync(binary))!==prep.binarySha256)throw Error('Prepared source or binary changed');
 writeFileSync(join(out,'call-started.json'),JSON.stringify({at:new Date().toISOString(),visibleSecondsLimit:8,modelCalls:0,deviceCalls:0}),{flag:'wx'});
 const r=spawnSync(binary,['--root',fixture],{encoding:'utf8',timeout:35000,maxBuffer:8*1024*1024});
 writeFileSync(join(out,'native-log.txt'),r.stdout+'\n'+r.stderr);if(r.error)throw r.error;if(r.status!==0)throw Error('Native observation did not pass; keep receipts, no automatic retry');
 console.log(readFileSync(join(out,'result.json'),'utf8'));process.exit(0);
}
if(mode!=='--prepare')throw Error('Use --prepare source-worktree or --run-once source-worktree');
if(existsSync(join(out,'call-started.json')))throw Error('One-run observation already consumed; do not overwrite evidence');
mkdirSync(join(fixture,'build'),{recursive:true});
for(const d of ['assets','vendor'])if(!existsSync(join(fixture,d)))cpSync(join(desktop,d),join(fixture,d),{recursive:true});
const instrument=`
const originalDraw=JellyfishRenderer.prototype.draw;
JellyfishRenderer.prototype.draw=function(){originalDraw.call(this);if(!window.measureNative)return;const c=this.canvas,g=this.gl,p=new Uint8Array(c.width*c.height*4);g.readPixels(0,0,c.width,c.height,g.RGBA,g.UNSIGNED_BYTE,p);let ink=0;for(let i=3;i<p.length;i+=64)if(p[i]>12)ink++;window.nativeSample?.({kind:'draw',ink,buffer:[c.width,c.height]})};
`;
await build({stdin:{contents:readFileSync(join(desktop,'main.mjs'),'utf8'),resolveDir:desktop,sourcefile:'main.mjs'},bundle:true,format:'esm',outfile:join(fixture,'build/renderer.js'),plugins:[{name:'isolated-native',setup(b){
 b.onResolve({filter:/browser-playback\.ts|browser-capture\.ts/},a=>({path:a.path,namespace:'forbidden-media'}));
 b.onLoad({filter:/.*/,namespace:'forbidden-media'},a=>({contents:`export class ${a.path.includes('playback')?'BrowserPlaybackDriver':'BrowserCaptureDriver'}{open(){throw Error('Native probe forbids all audio/video devices')}}`}));
 b.onLoad({filter:/cubism-renderer\.mjs$/},()=>({resolveDir:desktop,contents:readFileSync(join(desktop,'cubism-renderer.mjs'),'utf8')+instrument}));
}}]});
writeFileSync(join(fixture,'style.css'),readFileSync(join(desktop,'style.css')));
writeFileSync(join(fixture,'index.html'),readFileSync(join(desktop,'index.html'),'utf8').replace('<script src="vendor/','<script src="probe.js"></script><script src="vendor/'));
writeFileSync(join(fixture,'probe.js'),`
window.nativeSample=data=>{if(!window.measureNative)return;const c=document.getElementById('model'),r=c.getBoundingClientRect();webkit.messageHandlers.diagnostic.postMessage({type:'native-sample',...data,at:performance.now(),rect:[r.x,r.y,r.width,r.height],buffer:[c.width,c.height],drawerHidden:document.getElementById('drawer').hidden})};
for(const name of ['width','height']){const d=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,name);Object.defineProperty(HTMLCanvasElement.prototype,name,{...d,set(v){if(this.id==='model')nativeSample({kind:'buffer-reset',dimension:name,value:v});d.set.call(this,v)}})}
function sampleFrame(){nativeSample({kind:'frame'});requestAnimationFrame(sampleFrame)}requestAnimationFrame(sampleFrame);
`);
let native=readFileSync(join(desktop,'native/main.swift'),'utf8');
function replaceOnce(from,to){if(native.split(from).length!==2)throw Error('Production probe seam changed: '+from);native=native.replace(from,to)}
replaceOnce('let displayPreferences = PetDisplayPreferences()','let displayPreferences = PetDisplayPreferences(defaults: UserDefaults(suiteName:"movefile.native-panel-stability-isolated")!)');
replaceOnce('panel.orderFrontRegardless()','panel.orderOut(nil) // Test loads the actual renderer before the single foreground slot.');
replaceOnce('case "panel":', 'case "panel":\n                guard nativeProbe?.started != nil else { return } // No surprise pre-slot foreground on a renderer failure.');
replaceOnce('pageReady = true; applyDisplay(); startTransport()','pageReady = true; applyDisplay() // Test never starts backend transport.');
replaceOnce('func diagnostic(_ name: String, _ values: [String: Any] = [:]) {','func diagnostic(_ name: String, _ values: [String: Any] = [:]) {\n        if name == "renderer", values["type"] as? String == "native-sample" { nativeProbe?.sample(values); return }; nativeProbe?.event(name,values)');
replaceOnce('#if !DESKTOP_WORKLET_TEST\nlet app = NSApplication.shared\nlet delegate = AppDelegate(); app.delegate = delegate\napp.run()\n#endif', '// Isolated test owns the sole top-level app.run entry.');
writeFileSync(join(out,'ProductionHost.swift'),native);
writeFileSync(join(out,'main.swift'),String.raw`
import AppKit
import WebKit
import QuartzCore
let output=URL(fileURLWithPath:CommandLine.arguments[2]).deletingLastPathComponent()
let host=AppDelegate()
var nativeProbe:NativeProbe?
final class NativeProbe {
 let previous=NSWorkspace.shared.frontmostApplication
 var started:Date?,records=[[String:Any]](),events=[[String:Any]](),snapshots=[[String:Any]](),done=false,scheduled=false
 var initial:CGRect?,firstViewport:CGSize?
 func array(_ r:CGRect)->[Double]{[r.minX,r.minY,r.width,r.height]}
 func js(_ s:String){host.web.evaluateJavaScript("void (()=>{"+s+"})()"){_,e in if let e{self.events.append(["error":e.localizedDescription])}}}
 func event(_ n:String,_ v:[String:Any]) {
  if n=="panel" {var e=v;e["kind"]="native-panel";e["visibleElapsed"]=started.map{Date().timeIntervalSince($0)} ?? 0;events.append(e)}
  if n=="renderer",v["type"] as? String=="model-loaded", !scheduled {scheduled=true;DispatchQueue.main.asyncAfter(deadline:.now()+0.25){self.begin()}}
 }
 func sample(_ v:[String:Any]) {
  guard started != nil,!done,let r=v["rect"] as? [Double],r.count==4 else{return}
  let rect=CGRect(x:r[0],y:host.web.isFlipped ? r[1] : host.web.bounds.height-r[1]-r[3],width:r[2],height:r[3])
  let screen=host.panel.convertToScreen(host.web.convert(rect,to:nil))
  var record=v;record["visibleElapsed"]=Date().timeIntervalSince(started!);record["screenRect"]=array(screen);record["nativeModel"]=array(host.modelScreenFrame!);record["panel"]=array(host.panel.frame);record["web"]=array(host.web.frame);record["clip"]=array(host.viewportClip.bounds);record["webFlipped"]=host.web.isFlipped;record["nativeOpen"]=host.displayOpen;record["appActive"]=NSApp.isActive;record["isKey"]=host.panel.isKeyWindow;record["backingScale"]=host.panel.backingScaleFactor
  records.append(record)
 }
 func snapshot(_ name:String) {
  guard !done else{return}
  let cfg=WKSnapshotConfiguration();cfg.rect=host.web.convert(host.panel.contentView!.bounds,from:host.panel.contentView)
  host.web.takeSnapshot(with:cfg){image,error in
   guard let image,let tiff=image.tiffRepresentation,let rep=NSBitmapImageRep(data:tiff),let png=rep.representation(using:.png,properties:[:]) else{self.snapshots.append(["name":name,"error":error?.localizedDescription ?? "no image"]);return}
   try? png.write(to:output.appendingPathComponent(name+".png"));self.snapshots.append(["name":name,"bytes":png.count,"scope":"WK clipped snapshot, not OS compositor recording"])
  }
 }
 func begin() {
  guard started==nil else{return}
  guard NSWorkspace.shared.frontmostApplication?.processIdentifier==previous?.processIdentifier else{finish("foreground-changed-before-slot");return}
  started=Date()
  host.displayPreferences.setMode("half")
  let screen=NSScreen.main!.visibleFrame
  host.applyDisplay(proposedModelTop:CGPoint(x:screen.maxX-200,y:screen.maxY-50))
  initial=host.modelScreenFrame;firstViewport=host.web.frame.size
  NSApp.activate(ignoringOtherApps:true);host.panel.makeKeyAndOrderFront(nil);host.panel.makeFirstResponder(host.web)
  js("petBridge.connectionChanged({generation:1,state:'connecting'});petBridge.receive({channel:'backend_ready',bridgeVersion:'0.2.0',characterId:'companion',sessionId:'native-isolated'},1)")
  after(0.65){self.js("window.measureNative=true")}
  for (time,id) in [(1.0,"open"),(1.7,"close"),(2.15,"open"),(2.21,"close"),(2.27,"open"),(2.33,"close"),(2.39,"open"),(3.1,"close")] {
   after(time){self.events.append(["kind":"test-click","id":id,"visibleElapsed":Date().timeIntervalSince(self.started!)]);self.js("document.getElementById('\(id)').click()")}
  }
  for (time,name) in [(0.85,"closed"),(1.08,"opening"),(1.82,"closing"),(2.45,"rapid"),(3.5,"closed-final")] {after(time){self.snapshot(name)}}
  after(4.5){self.finish("sequence-finished")};after(7.5){self.finish("visible-timeout")}
 }
 func after(_ delay:Double,_ work:@escaping()->Void){DispatchQueue.main.asyncAfter(deadline:.now()+delay,execute:work)}
 func finish(_ reason:String) {
  guard !done else{return};done=true;host.panel?.orderOut(nil);host.captureTimer?.invalidate();host.web?.stopLoading();host.connection.close();host.panel?.close();previous?.activate(options:[])
  let duration=started.map{Date().timeIntervalSince($0)} ?? 0
  after(0.15){
   let resets=self.records.filter{$0["kind"] as? String=="buffer-reset"}.count
   let draws=self.records.filter{$0["kind"] as? String=="draw"},empty=draws.filter{($0["ink"] as? Int ?? 0)==0}.count
   let stable=self.records.allSatisfy {r in guard let s=r["screenRect"] as? [Double],let m=self.initial else{return false};return zip(s,self.array(m)).allSatisfy{abs($0-$1)<0.1}}
   let viewportStable=self.records.allSatisfy{r in guard let w=r["web"] as? [Double],let first=self.firstViewport else{return false};return abs(w[2]-first.width)<0.1 && abs(w[3]-first.height)<0.1}
   let openFrames=self.records.filter{$0["nativeOpen"] as? Bool==true}.count
   let closedFrames=self.records.filter{$0["nativeOpen"] as? Bool==false}.count
   let rapidFrames=self.records.filter{let t=$0["visibleElapsed"] as? Double ?? 0;return t>=2.15 && t<=2.85}.count
   let noBackend=host.connection.processIdentifier==nil
   let errors=self.events.filter{$0["error"] != nil}
   let restored=NSWorkspace.shared.frontmostApplication?.processIdentifier==self.previous?.processIdentifier
   let activeObserved=self.records.contains{$0["appActive"] as? Bool==true && $0["isKey"] as? Bool==true}
   let pass=noBackend && errors.isEmpty && closedFrames>0 && rapidFrames>3 && restored && activeObserved && reason=="sequence-finished" && duration<8 && self.records.count>20 && openFrames>0 && stable && viewportStable && resets==0 && draws.count>5 && empty==0
   let result:[String:Any]=["status":pass ? "passed":"failed","reason":reason,"visibleSeconds":duration,"samples":self.records,"sampleCount":self.records.count,"openFrames":openFrames,"closedFrames":closedFrames,"rapidFrames":rapidFrames,"stableScreenRect":stable,"stableWKViewport":viewportStable,"canvasBufferResets":resets,"activeKeyObserved":activeObserved,"foregroundRestored":restored,"actualDraws":draws.count,"emptyDraws":empty,"snapshots":self.snapshots,"events":self.events,"previousFrontmostPID":self.previous?.processIdentifier ?? -1,"restoredFrontmostPID":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,"noBackend":host.connection.processIdentifier==nil,"modelDeviceCalls":0,"scope":"Actual AppDelegate/clip/WK geometry plus actual Cubism draw samples. WK snapshots do not establish OS compositor frame continuity."]
   if let data=try? JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]){try? data.write(to:output.appendingPathComponent("result.json"))}
   UserDefaults.standard.removePersistentDomain(forName:"movefile.native-panel-stability-isolated")
   exit(pass ? 0:1)
  }
 }
}
let app=NSApplication.shared
nativeProbe=NativeProbe();app.delegate=host
DispatchQueue.main.asyncAfter(deadline:.now()+25){nativeProbe?.finish("load-timeout")}
app.run()
`);
try { execFileSync('swiftc',['-D','DESKTOP_WORKLET_TEST','-module-cache-path',join(project,'desktop/.cache/swift'),'-framework','AppKit','-framework','WebKit',join(desktop,'native/display-layout.swift'),join(out,'ProductionHost.swift'),join(out,'main.swift'),'-o',binary],{stdio:'pipe'}); } catch(error) { writeFileSync(join(out,'prepare-error.txt'),String(error.stderr||error)); throw error; }
writeFileSync(join(out,'preparation.json'),JSON.stringify({at:new Date().toISOString(),sourceRoot:source,sources:fingerprints(),binarySha256:hash(readFileSync(binary)),productionSeams:['independent preference suite','initial window held hidden until model load','no startTransport at page ready','diagnostic sampling hook','test owns sole top-level app.run'],geometryAndApplyDisplay:'unmodified production source','visibleSecondsPlanned':4.5,'hardStopSeconds':7.5,'modelDeviceCalls':0,'executed':false},null,2)+'\n');
console.log(JSON.stringify({status:'prepared_not_run',binary,visibleSeconds:4.5,hardStopSeconds:7.5}));
