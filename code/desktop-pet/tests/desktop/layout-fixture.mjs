// Bounded local visual fixture: actual HTML/CSS/main, with asset/device adapters
// replaced. No provider, audio output, microphone or camera API can be reached.
import {build} from 'esbuild';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join,extname} from 'node:path';
import {createServer} from 'node:http';
const dir=resolve('../../artifacts/W1/companion-step1-01/layout-fixture');await mkdir(join(dir,'assets/ui'),{recursive:true});await mkdir(join(dir,'build'),{recursive:true});
let html=await readFile('desktop/index.html','utf8');html=html.replace('<script src="vendor/cubism/Core/live2dcubismcore.min.js"></script>','<script src="fixture.js"></script>');
await writeFile(join(dir,'index.html'),html);await copyFile('desktop/style.css',join(dir,'style.css'));await copyFile('desktop/assets/ui/框3.png',join(dir,'assets/ui/框3.png'));
await build({entryPoints:['desktop/main.mjs'],bundle:true,format:'esm',platform:'browser',outfile:join(dir,'build/renderer.js'),plugins:[{name:'no-devices',setup(b){
 b.onResolve({filter:/cubism-renderer\.mjs|browser-playback\.ts|browser-capture\.ts/},a=>({path:a.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},a=>({contents:a.path.includes('cubism')?'export class JellyfishRenderer{async load(){}setFraming(){}reset(){}snapshot(){return {}}dispose(){}updateView(){}}':a.path.includes('playback')?'export class BrowserPlaybackDriver{open(){throw Error("fixture forbids devices")}}':'export class BrowserCaptureDriver{open(){throw Error("fixture forbids devices")}}'}));
}}]});
await writeFile(join(dir,'fixture.js'),`
window.fixtureMessages=[];window.webkit={messageHandlers:{diagnostic:{postMessage(){}},shell:{postMessage(v){if(v.type==='ready')queueMicrotask(async()=>{
 window.petBridge.connectionChanged({generation:1,state:'connecting',canRetry:true});
 await window.petBridge.receive({channel:'backend_ready',bridgeVersion:'0.2.0',characterId:'companion',sessionId:'layout',...(location.search.includes('intro')?{introduction:{id:'intro-fixture',text:'有些记忆像被雾遮住了。不过，能再次和你说话，还是很安心。'}}:{})},1);
 if(location.search.includes('intro')){window.layoutFixtureReady=true;return;}
 document.getElementById('open').click();document.getElementById('text').value='今天练琴终于弹顺了！';document.getElementById('form').dispatchEvent(new Event('submit',{cancelable:true}));
 window.petBridge.hotkeyConfig('ArrowLeft');
})}},desktop:{postMessage(v){window.fixtureMessages.push(v);if(v.message.command?.type==='submit_text')queueMicrotask(async()=>{
 const scope={characterId:'companion',sessionId:'layout',turnId:'layout-text',generation:1};
 await window.petBridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'text',startedAt:''}}},1);
 const text=location.search.includes('long')?'这一小段终于弹顺了，值得开心一下。'.repeat(30):'听起来很有成就感！是哪一段终于顺下来了？';
 await window.petBridge.receive({channel:'event',event:{type:'reply',reply:{scope,text,expression:{emotion:'happy',intensity:.7,delivery:'',gesture:null}}}},1);
 await window.petBridge.receive({channel:'event',event:location.search.includes('long')?{type:'error',scope,message:'未能获得麦克风或摄像头权限，请在系统设置中允许访问后重试。'}:{type:'presentation',presentation:{scope,state:'idle',expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null},mouth:0}}},1);
 document.getElementById('text').value='我输入的中文清晰可见';window.layoutFixtureReady=true;
})}}}};
`);
const server=createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);const p=resolve(dir,'.'+(pathname==='/'?'/index.html':pathname));if(!p.startsWith(dir+'/'))throw Error();const data=await readFile(p);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png'})[extname(p)]??'application/octet-stream');res.end(data)}catch{res.statusCode=404;res.end()}});
server.listen(0,'127.0.0.1',()=>console.log('LAYOUT_URL=http://127.0.0.1:'+server.address().port));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));process.on('SIGINT',()=>server.close(()=>process.exit(0)));
