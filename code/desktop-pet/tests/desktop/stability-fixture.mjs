import {build} from 'esbuild';import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,join,extname} from 'node:path';import {createServer} from 'node:http';import {execFileSync} from 'node:child_process';
import {geometry} from './stability-geometry.mjs';
export async function stabilityFixture(baseline=false){
 const desktop=resolve('desktop'),dir=resolve('../../artifacts/W1/panel-stability-01/fixture-'+(baseline?'before':'after')),g=geometry(baseline);mkdirSync(join(dir,'build'),{recursive:true});
 const source=p=>baseline&&['main.mjs','index.html','style.css','display-controls.mjs'].includes(p)?execFileSync('git',['show','ab35d0e:code/desktop-pet/desktop/'+p],{encoding:'utf8'}):readFileSync(join(desktop,p),'utf8');
 const instrument=`
 const originalDraw=JellyfishRenderer.prototype.draw;
 JellyfishRenderer.prototype.draw=function(){originalDraw.call(this);const c=this.canvas,gl=this.gl;
  if(!this._testPixels||this._testPixels.length!==c.width*c.height*4)this._testPixels=new Uint8Array(c.width*c.height*4);
  gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,this._testPixels);let ink=0;for(let i=3;i<this._testPixels.length;i+=64)if(this._testPixels[i]>12)ink++;
  window.stabilitySample?.({kind:'draw',ink,buffer:[c.width,c.height]});
 };
 `;
 await build({stdin:{contents:source('main.mjs'),resolveDir:desktop,sourcefile:'main.mjs'},bundle:true,format:'esm',outfile:join(dir,'build/renderer.js'),plugins:[{name:'isolated-stability',setup(b){
  b.onResolve({filter:/browser-playback\.ts|browser-capture\.ts/},a=>({path:a.path,namespace:'no-media'}));
  b.onLoad({filter:/.*/,namespace:'no-media'},a=>({contents:`export class ${a.path.includes('playback')?'BrowserPlaybackDriver':'BrowserCaptureDriver'}{open(){throw Error('stability fixture forbids devices')}}`}));
  b.onLoad({filter:/cubism-renderer\.mjs$/},()=>({resolveDir:desktop,contents:source('cubism-renderer.mjs')+instrument}));
  if(baseline)b.onLoad({filter:/display-controls\.mjs$/},()=>({contents:source('display-controls.mjs')}));
 }}]});
 writeFileSync(join(dir,'index.html'),source('index.html').replace('<script src="vendor/','<script src="fixture.js"></script><script src="vendor/'));
 writeFileSync(join(dir,'style.css'),source('style.css'));
 writeFileSync(join(dir,'fixture.js'),`
 window.stabilitySample=data=>parent.stabilitySample?.({...data,at:performance.now(),rect:(()=>{const r=document.getElementById('model').getBoundingClientRect();return[r.x,r.y,r.width,r.height]})()});
 for(const name of ['width','height']){const d=Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype,name);Object.defineProperty(HTMLCanvasElement.prototype,name,{...d,set(v){if(this.id==='model')window.stabilitySample({kind:'buffer-reset',dimension:name,value:v});d.set.call(this,v)}})}
 const frame=()=>{window.stabilitySample({kind:'frame',buffer:(()=>{const c=document.getElementById('model');return[c.width,c.height]})()});requestAnimationFrame(frame)};requestAnimationFrame(frame);
 window.fixtureWire=[];window.webkit={messageHandlers:{diagnostic:{postMessage(v){parent.stabilityReport?.(v)}},desktop:{postMessage(v){fixtureWire.push(v)}},shell:{postMessage(v){parent.stabilityShell?.(v)}}}};
 `);
 writeFileSync(join(dir,'host.html'),`<!doctype html><style>body{margin:0;background:#d9e4f1;overflow:hidden}#clip{position:absolute;overflow:hidden}iframe{position:absolute;border:0}</style><div id="clip"><iframe src="/app/index.html"></iframe></div><script>
 const q=new URLSearchParams(location.search),baseline=${baseline};window.samples=[];window.reports=[];window.layouts=[];
 const clip=document.getElementById('clip'),f=document.querySelector('iframe');window.child=()=>f.contentWindow;
 window.state={width:+q.get('width')||360,screen:JSON.parse(q.get('screen')||'[0,0,1280,720]'),anchor:JSON.parse(q.get('anchor')||(baseline?'[800,650]':'[990,650]')),open:false,mode:q.get('mode')||'half'};
 window.stabilitySample=d=>{const r=f.getBoundingClientRect(),s=state.screen;samples.push({...d,screenRect:[s[0]+r.x+d.rect[0],s[1]+s[3]-r.y-d.rect[1],d.rect[2],d.rect[3]],open:state.open})};
 window.stabilityReport=d=>reports.push(d);let queue=Promise.resolve();
 async function apply(){const r=await fetch('/layout?'+new URLSearchParams({input:JSON.stringify(state)})),l=await r.json();state.anchor=l.anchor;layouts.push(l);window.lastLayout=l;
  const [x,y,w,h]=l.frame,[sx,sy,sw,sh]=state.screen;Object.assign(clip.style,{left:(x-sx)+'px',top:(sy+sh-y-h)+'px',width:w+'px',height:h+'px'});
  Object.assign(f.style,{left:(baseline?0:sx-x)+'px',top:(baseline?0:y+h-sy-sh)+'px',width:(baseline?w:sw)+'px',height:(baseline?h:sh)+'px'});
  // Native window geometry happens before the asynchronous script acknowledgement.
  await new Promise(done=>requestAnimationFrame(()=>{child().petBridge.displayConfig({...l.config,mode:state.mode,preferredWidth:state.width});done()}));
 }
 window.stabilityShell=v=>{if(v.type==='ready')queue=queue.then(async()=>{await apply();child().petBridge.connectionChanged({generation:1,state:'connecting'});await child().petBridge.receive({channel:'backend_ready',bridgeVersion:'0.2.0',characterId:'companion',sessionId:'stability'},1)});
  if(v.type==='panel')queue=queue.then(async()=>{state.open=v.open;await apply()});
  if(v.type==='set_display')queue=queue.then(async()=>{state.mode=v.mode;await apply()});
 };
 window.setCase=async c=>{await queue;Object.assign(state,c);await apply()};window.settled=()=>queue;
 </script>`);
 const server=createServer((req,res)=>{try{const u=new URL(req.url,'http://localhost');if(u.pathname==='/layout'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(g.layout(JSON.parse(u.searchParams.get('input')))));return}
  const path=decodeURIComponent(u.pathname),isHost=path==='/'||path==='/host.html',local=isHost?'host.html':path.replace(/^\/app\//,'');const base=isHost||['index.html','style.css','fixture.js','build/renderer.js'].includes(local)?dir:desktop;
  const file=resolve(base,local);if(!file.startsWith(base+'/'))throw Error();res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png'})[extname(file)]||'application/octet-stream');res.end(readFileSync(file));
 }catch{res.statusCode=404;res.end()}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));return {dir,url:'http://127.0.0.1:'+server.address().port,async close(){await new Promise(r=>server.close(r));g.close();rmSync(dir,{recursive:true,force:true})}};
}
