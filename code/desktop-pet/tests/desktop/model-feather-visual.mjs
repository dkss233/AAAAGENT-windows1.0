// Silent actual-model WebGL fixture. No frontend transport, backend or media adapters.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {createServer} from 'node:http';
const desktop=resolve('desktop'),dir=resolve('../../artifacts/W1/half-edge-01/visual');
await mkdir(dir,{recursive:true});
await build({stdin:{contents:`import {JellyfishRenderer} from './desktop/cubism-renderer.mjs';
import {runFeatherChecks} from './tests/desktop/model-feather.test.mjs';
const q=new URLSearchParams(location.search),canvas=document.querySelector('canvas');
canvas.style.width=(Number(q.get('size'))||360)+'px';canvas.style.height=(Number(q.get('size'))||360)*340/360+'px';
document.documentElement.style.background=q.get('bg')==='light'?'#edf1f6':q.get('bg')==='transparent'?'transparent':'#18202b';
window.visualReports=[];window.visualRig=new JellyfishRenderer(canvas,r=>visualReports.push(r));
window.runFeatherChecks=()=>runFeatherChecks(visualRig);
try {await visualRig.load();visualRig.setFraming(q.get('mode')||'half');visualRig.updateView({state:'idle',mouth:0,expression:{emotion:'neutral',intensity:0,gesture:''}});window.visualReady=true;}catch(e){window.visualError=e.stack;throw e;}`,resolveDir:process.cwd(),sourcefile:'half-edge-fixture.mjs'},bundle:true,format:'esm',outfile:join(dir,'fixture.js')});
await writeFile(join(dir,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><title>半身底缘真实模型无声检查</title><style>html,body{margin:0;background:transparent}canvas{display:block}</style></head><body><canvas aria-label="真实 Live2D 模型"></canvas><script src="vendor/cubism/Core/live2dcubismcore.min.js"></script><script type="module" src="fixture.js"></script></body></html>`);
const server=createServer(async(req,res)=>{try{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const base=['/index.html','/fixture.js','/'].includes(path)?dir:desktop;const file=resolve(base,'.'+(path==='/'?'/index.html':path));if(!file.startsWith(base+'/'))throw Error();const data=await readFile(file);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.json':'application/json','.png':'image/png','.wasm':'application/wasm'})[extname(file)]??'application/octet-stream');res.end(data)}catch{res.statusCode=404;res.end()}});
server.listen(0,'127.0.0.1',()=>console.log('FEATHER_URL=http://127.0.0.1:'+server.address().port));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
