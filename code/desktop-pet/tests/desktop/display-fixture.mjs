// Explicit silent visual harness: actual frontend, Cubism/Core/moc/textures/shaders.
// Only native screen/transport and media adapters are controlled. Never launches a backend.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
const baseline=process.argv.includes('--baseline');
const desktop=resolve('desktop'),dir=resolve('../../artifacts/W1/model-display-01/'+(baseline?'baseline-visual':'visual'));await mkdir(join(dir,'build'),{recursive:true});
await writeFile(join(dir,'index.html'),(await readFile(join(desktop,'index.html'),'utf8')).replace('<script src="vendor/', '<script src="fixture.js"></script><script src="vendor/'));
await build({entryPoints:['desktop/main.mjs'],bundle:true,format:'esm',outfile:join(dir,'build/renderer.js'),plugins:[{name:'no-media',setup(b){
 if(baseline){b.onResolve({filter:/cubism-renderer\.mjs/},a=>({path:a.path,namespace:'baseline'}));b.onLoad({filter:/.*/,namespace:'baseline'},()=>({resolveDir:desktop,contents:execFileSync('git',['show','d4d7c01b7385d90a8fbf934d7277600520e223b5:code/desktop-pet/desktop/cubism-renderer.mjs'],{encoding:'utf8'}).replace('export class JellyfishRenderer','class BaselineRenderer')+'\nexport class JellyfishRenderer extends BaselineRenderer {setFraming(){}}'}))}
 b.onResolve({filter:/browser-playback\.ts|browser-capture\.ts/},a=>({path:a.path,namespace:'silent'}));
 b.onLoad({filter:/.*/,namespace:'silent'},a=>({contents:`export class ${a.path.includes('playback')?'BrowserPlaybackDriver':'BrowserCaptureDriver'} {open(){throw Error('This visual fixture forbids devices')}}`}));
}}]});
await writeFile(join(dir,'fixture.js'),`
const q=new URLSearchParams(location.search);let mode=q.get('mode')||'full',preferredWidth=Number(q.get('size'))||360,open=false,before;
document.documentElement.style.background='#dce5f0';window.visualReports=[];window.shellMessages=[];
function layout(){const sw=Number(q.get('screenWidth'))||innerWidth,sh=Number(q.get('screenHeight'))||innerHeight;const drawer=open?Math.min(340,Math.max(0,sh-150)):0;const width=Math.max(1,Math.min(preferredWidth,Math.max(1,sw-20),Math.max(1,sh-drawer-36)/(340/360)));const c={mode,preferredWidth,modelWidth:width,modelHeight:width*340/360,drawerHeight:drawer};window.petBridge.displayConfig(c);window.visualLayout=c;}
window.webkit={messageHandlers:{diagnostic:{postMessage(v){visualReports.push(v)}},desktop:{postMessage(v){throw Error('visual fixture forbids backend commands')}},shell:{postMessage(v){shellMessages.push(v);if(v.type==='ready')queueMicrotask(async()=>{
window.petBridge.connectionChanged({generation:1,state:'connecting'});await window.petBridge.receive({channel:'backend_ready',bridgeVersion:'0.2.0',characterId:'companion',sessionId:'display-visual'},1);layout();if(q.has('chat'))document.getElementById('open').click();
});if(v.type==='panel'){open=v.open;layout()}if(v.type==='set_display'){mode=v.mode;layout()}if(v.type==='resize_model'){if(v.phase==='begin')before=preferredWidth;if(v.phase==='cancel')preferredWidth=before;if(['update','commit'].includes(v.phase))preferredWidth=Math.max(220,Math.min(720,v.width));layout()}}}}};
`);
const server=createServer(async(req,res)=>{try{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const base=['/index.html','/fixture.js','/build/renderer.js','/'].includes(path)?dir:desktop;const file=resolve(base,'.'+(path==='/'?'/index.html':path));if(!file.startsWith(base+'/'))throw Error();const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.wasm':'application/wasm'})[extname(file)]??'application/octet-stream');res.end(data)}catch{res.statusCode=404;res.end()}});
server.listen(0,'127.0.0.1',()=>console.log('DISPLAY_URL=http://127.0.0.1:'+server.address().port));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
