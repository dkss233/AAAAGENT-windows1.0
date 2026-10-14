// Runs the original UI checks in an isolated synthetic server and actual browser.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
if(!process.env.PLAYWRIGHT_MODULE)throw Error('Use the existing Playwright module');
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const child=spawn(process.execPath,['tests/management/ui-fixture.mjs'],{stdio:['ignore','pipe','pipe']});let browser;
try{
 const url=await new Promise((ok,no)=>{let out='';const timer=setTimeout(()=>no(Error('Fixture startup timeout')),5000);child.once('exit',()=>{clearTimeout(timer);no(Error('Fixture exited'));});child.stdout.on('data',v=>{out+=v;const m=/UI_FIXTURE=(\S+)/.exec(out);if(m){clearTimeout(timer);ok(m[1]);}});});
 browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(url);await page.locator('#nav-memory').waitFor();
 const result=await page.evaluate(async()=>{const {runUIChecks}=await import('/ui.test.mjs');return runUIChecks();});
 const out=resolve(process.env.MANAGEMENT_UI_OUTPUT||'../../artifacts/W0-I/memory-dynamics-01');await mkdir(out,{recursive:true});await writeFile(resolve(out,'legacy-ui-regression.json'),JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify(result)+'\n');
 if(process.env.MANAGEMENT_UI_SCREENSHOTS==='1'){
   await page.goto('about:blank');await page.goto(url);await page.getByText('已连接',{exact:true}).waitFor();
   const shots=[];const layout=[];
   for(const width of [1360,360]){
     await page.setViewportSize({width,height:1000});
     for(const [name,nav,section] of [['overview','overview'],['records','memory','records'],['prompt','memory','prompt'],['models','models'],['events','events'],['presentation','presentation']]){
       await page.locator('#nav-'+nav).click();if(section)await page.locator('#memory-'+section).click();
       if(name==='records')await page.locator('[data-record-id="companion-memory"]').waitFor();
       if(name==='prompt')await page.locator('#prompt-text').waitFor();
       if(name==='models')await page.locator('#configure-tts').click();
       if(name==='presentation'){await page.locator('[data-preset-id="fixture-preset-0"]').waitFor();await page.getByText('模型暂时无法预览',{exact:true}).waitFor();}
       const fit=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
       if(!fit)throw Error(name+' exceeds '+width+'px viewport');layout.push({page:name,width,fits:true});
       const nameOnDisk='folk-'+name+'-'+width+'.png';await page.screenshot({path:resolve(out,nameOnDisk),fullPage:true});shots.push(nameOnDisk);
     }
   }
   await writeFile(resolve(out,'shared-page-layout.json'),JSON.stringify({kind:'Actual UI with synthetic data; model assets unavailable in fixture, no real preview acceptance',layout,shots},null,2)+'\n');
 }

}finally{await browser?.close();if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}}
