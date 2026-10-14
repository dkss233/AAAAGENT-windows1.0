import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../../..');
const option=n=>{const at=process.argv.indexOf(n);assert.ok(at>=0&&process.argv[at+1]);return resolve(process.argv[at+1]);};
const assembly=option('--assembly'),evidence=option('--evidence'),esbuild=option('--esbuild'),playwright=option('--playwright'),styles=option('--styles'),red=process.argv.includes('--red');
assert.ok(assembly===join(root,'artifacts/runtime/native-tool-output-54'));assert.ok(evidence.startsWith(join(root,'artifacts/W1/native-tool-output-54/')));await mkdir(evidence,{recursive:true});
const web=join(assembly,'apps/web'),timeline=join(web,'src/components/chat/MessagesTimeline.tsx'),entities=join(web,'src/state/entities.ts');
const originalPath='/Users/example/AAAAGENT/artifacts/worktrees/W0-I-independent-blackboard-54/artifacts/runtime/independent-blackboard-native-read-ui/apps/web/src/components/chat/MessagesTimeline.tsx';
const timelineSource=await readFile(red?originalPath:timeline,'utf8');
if(red)assert.equal(createHash('sha256').update(timelineSource).digest('hex'),'9397884b276b406de777e7a9127d47885f77868d8989168cff7121c99cf5c63a');
let entitySource=await readFile(entities,'utf8');
// Replace only metadata hooks in the test bundle. Original row/render/client stay intact.
for(const [name,type,body] of [['useProject','EnvironmentProject','return ref && window.__project?.environmentId===ref.environmentId && window.__project.id===ref.projectId ? window.__project : null;'],['useThread','EnvironmentThread','return ref && window.__thread?.environmentId===ref.environmentId && window.__thread.id===ref.threadId ? window.__thread : null;']]){
 const begin=entitySource.indexOf(`export function ${name}(`),open=entitySource.indexOf(`): ${type} | null {`,begin),end=entitySource.indexOf('\n}',open)+2;
 assert.ok(begin>=0&&open>begin&&end>open);entitySource=entitySource.slice(0,open)+`): ${type} | null { ${body}\n}`+entitySource.slice(end);
}
const target={environmentId:'controlled-env',projectId:'controlled-project',workspaceRoot:'/controlled/workspace',providerInstanceId:'codex',threadId:'controlled-original-c',turnId:'controlled-original-turn',toolCallId:'controlled-original-exec'};
const tail='尾部校验：CONTROLLED_FULL_TAIL\n';
function full(t){const prefix=`受控原形状输出 ${t.threadId}/${t.turnId}/${t.toolCallId}\n`,lines='0123456789\n'.repeat(450);return prefix+lines+'x'.repeat(5200-Buffer.byteLength(prefix+lines+tail))+tail;}
function payload(t){const output=full(t);return {apiVersion:'0.1.0',source:'t3-original-terminal-activity',complete:true,scope:Object.fromEntries(['environmentId','projectId','workspaceRoot','providerInstanceId','threadId'].map(k=>[k,t[k]])),nativeThreadId:'controlled-native-original-c',turnId:t.turnId,toolCallId:t.toolCallId,activityId:'controlled-terminal-activity',itemType:'command_execution',command:'python3 controlled-command-not-executed',output,outputBytes:Buffer.byteLength(output),outputSha256:createHash('sha256').update(output).digest('hex'),exitCode:0};}
const entry=`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{__OriginalToolRow,__TimelineRowCtx}from ${JSON.stringify(timeline)};
const initial=${JSON.stringify(target)};
function Harness(){const[current,setCurrent]=useState(initial),[tick,setTick]=useState(0),[draft,setDraft]=useState('受控原草稿');
 window.__change=(field,value)=>setCurrent(s=>({...s,[field]:value}));window.__rerender=()=>setTick(n=>n+1);
 window.__thread={environmentId:current.environmentId,id:current.threadId,projectId:current.projectId,modelSelection:{instanceId:current.providerInstanceId}};
 window.__project={environmentId:current.environmentId,id:current.projectId,workspaceRoot:current.workspaceRoot};
 const ref={environmentId:current.environmentId,threadId:current.threadId};
 const row={id:'original-activity-row',createdAt:'2026-10-02T00:00:00Z',turnId:current.turnId,toolCallId:current.toolCallId,itemType:'command_execution',toolLifecycleStatus:'completed',sourceActivityKind:'tool.completed',tone:'tool',label:'受控原Python工具',command:'python3 controlled-command-not-executed',detail:'受控84字摘要：完整尾部尚未读取。'};
 const ctx={threadRef:ref,toolOutputThreadRef:ref,routeThreadKey:JSON.stringify([current.environmentId,current.threadId]),workspaceRoot:current.workspaceRoot,onImageExpand:()=>{},timestampFormat:'locale',tick};
 return <main style={{maxWidth:960,margin:'0 auto',padding:16}}><p>受控原工具行 · 仅内存只读响应</p><textarea aria-label="受控原草稿" value={draft} onChange={e=>setDraft(e.target.value)}/><__TimelineRowCtx value={ctx}><__OriginalToolRow workEntry={row} workspaceRoot={current.workspaceRoot} isExpandedToolGroupEntry={false}/></__TimelineRowCtx></main>;
}createRoot(document.getElementById('root')).render(<Harness/>);`;
const {build}=createRequire(join(esbuild,'package.json'))(esbuild);
async function bundle(nativeRead){
 const built=await build({stdin:{contents:entry,resolveDir:web,loader:'tsx'},bundle:true,write:false,platform:'browser',format:'esm',target:'es2022',jsx:'automatic',tsconfig:join(web,'tsconfig.json'),
  define:{'process.env.NODE_ENV':'"production"','import.meta.env':JSON.stringify({APP_VERSION:'offline',VITE_AAA_NATIVE_READ:nativeRead?'1':'0',VITE_AAA_PREVIEW:'0',MODE:'test',DEV:false,PROD:true})},
  plugins:[{name:'original-row-with-controlled-metadata',setup(b){
   b.onLoad({filter:/MessagesTimeline\.tsx$/},()=>({contents:timelineSource+'\nexport { PlainWorkEntryRow as __OriginalToolRow, TimelineRowCtx as __TimelineRowCtx };',loader:'tsx',resolveDir:dirname(timeline)}));
   b.onLoad({filter:/src\/state\/entities\.ts$/},a=>a.path===entities?{contents:entitySource,loader:'ts',resolveDir:dirname(entities)}:undefined);
   b.onResolve({filter:/\?worker$/},a=>({path:a.path,namespace:'unused-worker'}));b.onLoad({filter:/.*/,namespace:'unused-worker'},()=>({contents:'export default class { constructor(){ throw Error("unused offline worker"); } }',loader:'js'}));
  }}],loader:{'.svg':'dataurl','.woff2':'dataurl'},logLevel:'silent'});
 return built.outputFiles.find(f=>f.path.endsWith('.js'))?.text??built.outputFiles[0].text;
}
const script=await bundle(true),production=red?null:await bundle(false);
const css=(await Promise.all((await readdir(styles)).filter(n=>n.endsWith('.css')).map(n=>readFile(join(styles,n),'utf8')))).join('\n');
const html='<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/bundle.js"></script>';
const {webkit}=await import(pathToFileURL(playwright).href),browser=await webkit.launch({headless:true});
const cases=[];let failure,last;
async function setup(width=390,mode='native'){
 const context=await browser.newContext({viewport:{width,height:800}}),page=await context.newPage(),requests=[],pending=[],errors=[],blocked=[];
 page.on('pageerror',e=>errors.push(String(e)));page.setDefaultTimeout(6000);
 await page.addInitScript(()=>{for(const n of ['WebSocket','EventSource'])window[n]=class{constructor(){throw Error('offline blocks '+n);}};if(navigator.mediaDevices)navigator.mediaDevices.getUserMedia=()=>Promise.reject(Error('offline blocks device'));});
 await page.route('**/*',route=>{
  const r=route.request(),url=new URL(r.url());
  if(url.origin!=='https://tool-output.invalid'||r.method()!=='GET'){blocked.push(r.method()+' '+url.origin+url.pathname);return route.abort();}
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:html});
  if(url.pathname==='/bundle.js')return route.fulfill({contentType:'text/javascript',body:mode==='production'?production:script});
  if(url.pathname==='/style.css')return route.fulfill({contentType:'text/css',body:css});
  const match=url.pathname.match(/^\/api\/orchestration\/threads\/([^/]+)\/tool-output$/);
  if(match){const t={threadId:decodeURIComponent(match[1]),...Object.fromEntries(url.searchParams)};requests.push({path:url.pathname+url.search,target:t});pending.push({route,target:t});return;}
  blocked.push(url.pathname);return route.abort();
 });
 await page.goto('https://tool-output.invalid/');await page.locator('[aria-expanded]').first().waitFor();
 const toggle=()=>page.locator('[aria-expanded]').first().locator(':scope > div').first();
 return last={page,context,requests,pending,errors,blocked,toggle,async waitCount(n){await assertEventually(()=>requests.length===n);},async release(index,status=200,patch={}){const p=pending[index];assert.ok(p);try{await p.route.fulfill({status,json:status===200?{...payload(p.target),...patch}:{error:'controlled unavailable'}});}catch(e){if(!/intercept|handled|closed|Target|request|Route/i.test(String(e)))throw e;}}};
}
async function assertEventually(test){for(let i=0;i<100;i++){if(test())return;await new Promise(r=>setTimeout(r,20));}assert.ok(test());}
async function finish(name,s,extra={}){assert.deepEqual(s.errors,[]);assert.deepEqual(s.blocked,[]);cases.push({name,passed:true,requests:s.requests,...extra});await s.context.close();}
try{
 for(const width of red?[390]:[390,1280]){
  const s=await setup(width);assert.equal(s.requests.length,0);await s.page.getByLabel('受控原草稿').fill('受控原草稿保持');await s.toggle().click();
  if(red){await s.page.screenshot({path:join(evidence,'original-summary-only.png')});assert.equal(s.requests.length,1,'original expanded command needs a lazy original-full-output read');}
  await s.waitCount(1);await s.page.getByText('正在读取原工具全文，摘要保留。',{exact:true}).waitFor();assert.ok((await s.page.getByLabel('原工具摘要').innerText()).includes('受控84字摘要'));assert.equal((await s.page.locator('main').innerText()).includes(tail.trim()),false);
  await s.page.evaluate(()=>{window.__rerender();window.__rerender();});assert.equal(s.requests.length,1);await s.release(0);
  await s.page.getByLabel('原工具完整输出',{exact:true}).waitFor();const pre=s.page.getByLabel('原工具完整输出',{exact:true});assert.equal(await pre.textContent(),full(target));assert.equal(await s.page.getByLabel('原工具命令',{exact:true}).textContent(),payload(target).command);
  await pre.evaluate(e=>e.scrollTop=e.scrollHeight);const geometry=await pre.evaluate(e=>{const b=e.getBoundingClientRect(),text=e.firstChild,range=document.createRange();range.setStart(text,text.textContent.lastIndexOf('尾部校验'));range.setEnd(text,text.textContent.length);const tail=range.getBoundingClientRect();return{scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,right:b.right,left:b.left,tailBottom:tail.bottom,preBottom:b.bottom,viewport:innerWidth};});
  assert.ok(geometry.scrollHeight>geometry.clientHeight);assert.ok(geometry.tailBottom<=geometry.preBottom+2);assert.ok(geometry.left>=0&&geometry.right<=width);assert.equal(await s.page.getByLabel('受控原草稿').inputValue(),'受控原草稿保持');
  await pre.click();assert.equal(await s.page.locator('[aria-expanded]').first().getAttribute('aria-expanded'),'true');await s.page.screenshot({path:join(evidence,`${width}-full-tail.png`)});
  await s.toggle().click();assert.equal(await s.page.getByLabel('原工具完整输出',{exact:true}).count(),0);await s.toggle().click();await s.waitCount(2);await s.toggle().click();await s.release(1);assert.equal(await s.page.locator('[data-native-tool-output-phase]').count(),0);
  await s.toggle().click();await s.waitCount(3);await s.release(2);await s.page.getByLabel('原工具完整输出',{exact:true}).waitFor();assert.equal(await s.page.getByLabel('受控原草稿').inputValue(),'受控原草稿保持');
  await finish(`${width}: collapsed lazy read, verified full tail, scroll, selection, rerender, close and reopen`,s,{geometry,outputBytes:5200});
 }
 if(!red){
  for(const field of ['threadId','turnId','toolCallId']){
   const s=await setup();await s.toggle().click();await s.waitCount(1);await s.page.evaluate(field=>window.__change(field,'controlled-new-'+field),field);await s.waitCount(2);
   await s.release(0);assert.equal(await s.page.getByLabel('原工具完整输出',{exact:true}).count(),0);await s.release(1);await s.page.getByLabel('原工具完整输出',{exact:true}).waitFor();assert.equal(await s.page.getByLabel('原工具完整输出',{exact:true}).textContent(),full({...target,[field]:'controlled-new-'+field}));
   await finish('late old '+field+' reply never appears on the new original key',s);
  }
  const ready=await setup();await ready.toggle().click();await ready.waitCount(1);await ready.release(0);await ready.page.getByLabel('原工具完整输出',{exact:true}).waitFor();
  await ready.page.evaluate(()=>{
   window.__observedOutputs=[];
   window.__outputObserver=new MutationObserver(()=>window.__observedOutputs.push(document.querySelector('pre[aria-label="原工具完整输出"]')?.textContent??null));
   window.__outputObserver.observe(document.querySelector('main'),{subtree:true,childList:true,characterData:true,attributes:true});
   window.__change('toolCallId','controlled-ready-new-exec');
  });
  await ready.waitCount(2);assert.equal(await ready.page.getByLabel('原工具完整输出',{exact:true}).count(),0);
  await ready.release(1);await ready.page.getByLabel('原工具完整输出',{exact:true}).waitFor();
  const observed=await ready.page.evaluate(()=>{window.__outputObserver.disconnect();return window.__observedOutputs;});
  assert.ok(observed.length>0);assert.equal(observed.includes(full(target)),false);assert.equal(await ready.page.getByLabel('原工具完整输出',{exact:true}).textContent(),full({...target,toolCallId:'controlled-ready-new-exec'}));
  await finish('completed old output disappears on identity switch before the next read completes',ready,{observedCommitCount:observed.length});
  for(const status of [401,404,413,503]){const s=await setup();await s.toggle().click();await s.waitCount(1);await s.release(0,status);await s.page.getByText('原工具全文暂不可读取，已保留摘要。',{exact:true}).waitFor();assert.ok((await s.page.getByLabel('原工具摘要').innerText()).includes('受控84字摘要'));assert.equal(await s.page.getByLabel('原工具完整输出',{exact:true}).count(),0);await s.page.evaluate(()=>window.__rerender());assert.equal(s.requests.length,1);await finish('HTTP '+status+' retains summary, no false full or auto retry',s);}
  const corrupt=await setup();await corrupt.toggle().click();await corrupt.waitCount(1);await corrupt.release(0,200,{outputSha256:'0'.repeat(64)});await corrupt.page.getByText('原工具全文暂不可读取，已保留摘要。',{exact:true}).waitFor();await finish('digest rejection retains summary in the original row',corrupt);
  const provider=await setup();await provider.toggle().click();await provider.waitCount(1);await provider.page.evaluate(()=>window.__change('providerInstanceId','dsh'));await provider.release(0);await provider.page.getByText('原工具全文暂不可读取，已保留摘要。',{exact:true}).waitFor();assert.equal(await provider.page.getByLabel('原工具完整输出',{exact:true}).count(),0);assert.equal(provider.requests.length,1);await finish('switch to unsupported provider cancels and refuses full output',provider);
  const prod=await setup(390,'production');await prod.toggle().click();assert.equal(await prod.page.locator('[data-native-tool-output-phase]').count(),0);assert.equal(prod.requests.length,0);assert.ok((await prod.page.locator('main').innerText()).includes('受控84字摘要'));await finish('default production retains original row with no new full-output request',prod);
 }
}catch(e){failure=e;if(last)cases.push({name:'failure diagnostics',errors:last.errors,blocked:last.blocked,requests:last.requests,text:await last.page.locator('main').innerText().catch(String)});}
finally{await browser.close();}
await writeFile(join(evidence,'results.json'),JSON.stringify({cases,failure:failure?String(failure):null,timelineSourceSha256:createHash('sha256').update(timelineSource).digest('hex'),
 boundary:'original PlainWorkEntryRow and owned output component in controlled WebKit; only metadata hooks and readonly HTTP replaced by synthetic original-shaped snapshots; no real native service, Python execution, model or device'},null,2)+'\n');
if(failure)throw failure;console.log(JSON.stringify({groups:cases.filter(c=>c.passed).length,liveNetwork:0,tools:0,models:0}));
