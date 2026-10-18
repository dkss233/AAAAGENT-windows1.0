import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startDemo} from './demo.mjs';
const demo=await startDemo(process.argv[2]?resolve(process.argv[2]):fileURLToPath(new URL('../../../../.local/social-demo/',import.meta.url)));
console.log(`联调页面：${demo.url}\n关闭本窗口或按 Ctrl+C 可停止。`);
if(process.platform==='darwin')spawn('open',[demo.url],{stdio:'ignore'}).on('error',()=>{});
else if(process.platform==='win32')spawn('cmd',['/c','start','',demo.url],{stdio:'ignore'}).on('error',()=>{});
process.once('SIGTERM',()=>void demo.close());process.once('SIGINT',()=>void demo.close());
