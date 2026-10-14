import {build} from 'esbuild';
import {mkdir,mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {spawnSync} from 'node:child_process';
const out=resolve('../../artifacts/W1/voice-feedback-03');await mkdir(out,{recursive:true});
const temp=await mkdtemp(join(out,'preview-'));
if(process.argv.includes('--browser')){
 await browserPreview();
} else {
try{const entry=join(temp,'test.mjs');await build({entryPoints:['desktop/tests/voice-feedback-rig.test.mjs'],bundle:true,platform:'node',format:'esm',outfile:entry});const run=spawnSync(process.execPath,[entry],{stdio:'inherit'});process.exitCode=run.status??1;}finally{await rm(temp,{recursive:true,force:true})}

}

async function browserPreview(){
 const {createServer}=await import('node:http'),{chromium}=await import(process.env.PLAYWRIGHT_MODULE);let server,browser,page;const errors=[];
 try{
  await build({entryPoints:['desktop/tests/voice-feedback-entry.mjs'],bundle:true,format:'esm',outfile:join(temp,'entry.js')});
  const desktop=resolve('desktop');
  server=createServer(async(req,res)=>{try{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(path==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f2ede3;color:#685a50;font:16px system-ui;text-align:center}canvas{display:block;width:460px;height:440px;margin:auto}p{margin:16px}</style><p>本地动画验证 · 合成轮次 · 无声音</p><canvas id="model"></canvas><p id="state">idle</p><script src="/vendor/cubism/Core/live2dcubismcore.min.js"></script><script type="module" src="/entry.js"></script>');return;}const file=path==='/entry.js'?join(temp,'entry.js'):resolve(desktop,'.'+path);if(file!==join(temp,'entry.js')&&!file.startsWith(desktop+'/'))throw Error();res.setHeader('Content-Type',({'.js':'text/javascript','.json':'application/json','.png':'image/png','.vert':'text/plain','.frag':'text/plain'})[extname(file)]??'application/octet-stream');res.end(await readFile(file));}catch{res.statusCode=404;res.end()}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true});page=await browser.newPage({viewport:{width:760,height:600},recordVideo:{dir:out,size:{width:760,height:600}}});page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready,{},{timeout:30000});
  for(const mode of ['full','half']){
   await page.evaluate(m=>framing(m),mode);await page.waitForTimeout(700);
   await page.evaluate(()=>action('attention'));await page.waitForTimeout(1100);
   await page.evaluate(()=>action('thinking'));await page.waitForTimeout(1700);await page.screenshot({path:join(out,mode+'-thinking.png')});await page.waitForTimeout(1400);
   await page.evaluate(()=>action('attention'));await page.waitForTimeout(850);
   await page.evaluate(()=>action('speaking'));await page.waitForTimeout(1500);await page.screenshot({path:join(out,mode+'-speaking.png')});
   await page.evaluate(()=>action('idle'));await page.waitForTimeout(1200);
  }
  await page.evaluate(()=>action('disabled'));await page.waitForTimeout(1200);
  const evidence=await page.evaluate(()=>{closePreview();return window.evidence});const {createHash}=await import('node:crypto');evidence.sources={};for(const path of ['desktop/main.mjs','desktop/cubism-renderer.mjs','desktop/interaction-motion.mjs','desktop/tests/voice-feedback-entry.mjs'])evidence.sources[path]=createHash('sha256').update(await readFile(path)).digest('hex');evidence.errors=errors;await page.close();evidence.video=await page.video().path();evidence.passed=errors.length===0&&evidence.samples.length>100&&evidence.samples.some(s=>s.alpha>0);await writeFile(join(out,'browser-evidence.json'),JSON.stringify(evidence,null,2)+'\n');if(!evidence.passed)throw Error('Preview did not draw cleanly');console.log('continuous actual WebGL preview passed',evidence.samples.length,'frames');
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(temp,{recursive:true,force:true});}
}
