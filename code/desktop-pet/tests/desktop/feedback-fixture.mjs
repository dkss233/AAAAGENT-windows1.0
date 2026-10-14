// Actual desktop HTML/CSS/entry and Cubism assets; only transport and media are
// controlled. No backend, database, microphone, camera or audio output is opened.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {createServer} from 'node:http';
export async function fixture() {
 const desktop=resolve('desktop'),dir=resolve('../../artifacts/W1/companion-feedback-01/fixture');
 await mkdir(join(dir,'build'),{recursive:true});
 await writeFile(join(dir,'index.html'),(await readFile(join(desktop,'index.html'),'utf8')).replace('<script src="vendor/', '<script src="fixture.js"></script><script src="vendor/'));
 await build({entryPoints:['desktop/main.mjs'],bundle:true,format:'esm',outfile:join(dir,'build/renderer.js'),plugins:[{name:'no-media',setup(b){
  b.onResolve({filter:/browser-playback\.ts|browser-capture\.ts/},a=>({path:a.path,namespace:'silent'}));
  b.onLoad({filter:/.*/,namespace:'silent'},a=>({contents:`export class ${a.path.includes('playback')?'BrowserPlaybackDriver':'BrowserCaptureDriver'} {open(){throw Error('fixture forbids devices')}}`}));
 }}]});
 await writeFile(join(dir,'fixture.js'),`
 document.documentElement.style.background='#d9e4f1';
 window.fixtureWire=[];window.fixtureShell=[];window.fixtureReports=[];
 window.fixtureLayout={mode:'half',preferredWidth:360,modelWidth:360,modelHeight:340,drawerHeight:340};
 window.fixtureConfigure=c=>{Object.assign(fixtureLayout,c);window.petBridge.displayConfig(fixtureLayout)};
 let turn=0;
 window.fixtureReply=async text=>{const scope={characterId:'companion',sessionId:'feedback',turnId:'t'+(++turn),generation:turn};
 await petBridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'text',startedAt:''}}},1);
 await petBridge.receive({channel:'event',event:{type:'reply',reply:{scope,text,expression:{emotion:'happy',intensity:.6,delivery:'',gesture:null}}}},1);
 await petBridge.receive({channel:'event',event:{type:'presentation',presentation:{scope,state:'idle',expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null},mouth:0}}},1);
 return scope;};
 window.webkit={messageHandlers:{diagnostic:{postMessage(v){fixtureReports.push(v)}},desktop:{postMessage(v){fixtureWire.push(v)}},shell:{postMessage(v){fixtureShell.push(v);if(v.type==='ready')queueMicrotask(async()=>{
 petBridge.connectionChanged({generation:1,state:'connecting'});await petBridge.receive({channel:'backend_ready',bridgeVersion:'0.2.0',characterId:'companion',sessionId:'feedback'},1);fixtureConfigure({});window.fixtureReady=true;
 });if(v.type==='set_display')fixtureConfigure({mode:v.mode});}}}};
 `);
 const server=createServer(async(req,res)=>{try{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const base=['/index.html','/fixture.js','/build/renderer.js','/'].includes(path)?dir:desktop;const file=resolve(base,'.'+(path==='/'?'/index.html':path));if(!file.startsWith(base+'/'))throw Error();const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.wasm':'application/wasm'})[extname(file)]??'application/octet-stream');res.end(data)}catch{res.statusCode=404;res.end()}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:'http://127.0.0.1:'+server.address().port,async close(){await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})}};
}
