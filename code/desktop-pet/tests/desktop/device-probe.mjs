// Local engineering probe, never calls a model. The supplied audio is not copied to disk.
// Run from code/desktop-pet: node tests/desktop/device-probe.mjs --audio /path/audio.wav --out /absolute/evidence/dir
// Terminal commands: play, stop, invite, exit. At most one audible replay per process.
// UI text only verifies command delivery and never replays the fixture or calls a provider.
import {ProbePolicy} from './probe-policy.mjs';
import {spawn} from 'node:child_process';
import {readFileSync,mkdirSync,createWriteStream} from 'node:fs';
import {resolve} from 'node:path';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
const option=n=>process.argv[process.argv.indexOf(n)+1];
if(!process.argv.includes('--out'))throw Error('Explicit evidence output directory required');
const out=resolve(option('--out'));mkdirSync(out,{recursive:true});
const records=createWriteStream(resolve(out,'probe.jsonl'));
const record=v=>{const line=JSON.stringify({observedAt:new Date().toISOString(),...v});records.write(line+'\n');if(!['amplitude','progress'].includes(v.type))process.stdout.write(line+'\n');};
const root=resolve('desktop');
const child=spawn(resolve(root,'build/星月陪伴.app/Contents/MacOS/DesktopPet'),['--root',root],{stdio:['pipe','pipe','pipe']});
const characterId='companion',sessionId='probe-companion-1';let scope=null,generation=0;
const playbackPolicy=new ProbePolicy();
const send=message=>child.stdin.write(JSON.stringify(message)+'\n');
const event=e=>send({channel:'event',event:e});
const ready=()=>send({channel:'backend_ready',bridgeVersion:'0.2.0',characterId,sessionId});
const begin=kind=>{scope={characterId,sessionId,turnId:`probe-${++generation}`,generation};event({type:'turn',input:{scope,kind,startedAt:new Date().toISOString()}});return scope;};
function play(){
 const decision=playbackPolicy.request('explicit_play',process.argv.includes('--audio'));
 if(!decision.play)return record({type:'probe-error',message:decision.reason});
 const s=begin('text');const bytes=readFileSync(option('--audio'));const expression={emotion:'happy',intensity:.8,delivery:'',gesture:'heart'};
 record({type:'fixture',scope:s,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,scriptedExpression:true,realDialogue:false});
 event({type:'reply',reply:{scope:s,text:'正在进行本地播放验证。',expression}});
 send({channel:'play',requestId:s.turnId,tts:{scope:s,audio:{id:s.turnId,uri:'pet-media://probe/audio',mimeType:'audio/wav',temporary:true},expression,durationMs:4560,synchronization:'amplitude'},audioBase64:bytes.toString('base64')});bytes.fill(0);
}
function stop(){if(scope)send({channel:'stop',requestId:'stop-'+scope.turnId,scope});}
function invite(){event({type:'invitation',invitation:{characterId,id:'probe-invitation',eventId:'probe-event',text:'这是本地提醒显示验证',gesture:'hold_star',eligibleAt:new Date().toISOString(),expiresAt:new Date(Date.now()+15000).toISOString(),status:'shown'}});}
createInterface({input:child.stdout}).on('line',line=>{
 let m;try{m=JSON.parse(line);}catch{return record({type:'unexpected-stdout',length:line.length});}
 if(m.channel==='capture'){
   const a=Buffer.from(m.result.audio.base64,'base64');const imageBytes=m.result.images.map(i=>Buffer.from(i.base64,'base64').length);
   record({type:'capture-result',scope:m.result.scope,audioBytes:a.length,images:imageBytes.length,imageBytes,inputEndedAt:m.result.inputEndedAt,captureStoppedAt:m.result.captureStoppedAt,rawRetained:false});a.fill(0);
   event({type:'presentation',presentation:{scope:m.result.scope,state:'idle',expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null},mouth:0}});return;
 }
 if(m.channel==='playback'){record({channel:m.channel,...m.event});return;}
 if(m.channel==='command'){
   record({type:'ui-command',command:m.command.type,characterId:m.command.characterId,textLength:m.command.text?.length});
   switch(m.command.type){
    case 'submit_text':playbackPolicy.request('submit_text',process.argv.includes('--audio'));event({type:'error',scope:null,message:'本地设备验证只检查输入送达；真实对话请使用正式启动入口。'});break;
    case 'cancel':stop();if(scope)send({channel:'capture_stop',requestId:'cancel-capture',scope});break;
    case 'start_voice':case 'click_invitation':{const s=begin('voice');send({channel:'capture_start',requestId:'capture-'+s.turnId,scope:s});break;}
    case 'finish_voice':if(scope)send({channel:'capture_finish',requestId:'finish-'+scope.turnId,scope});break;
   }
   return;
 }
 record({type:'bridge-result',...m});
 if(m.channel==='rpc_error')event({type:'error',scope,message:m.message});
});
let modelReady=false;
createInterface({input:child.stderr}).on('line',line=>{
 try{const v=JSON.parse(line);record({source:'native',...v});if(v.type==='model-loaded'&&!modelReady){modelReady=true;ready();record({type:'probe-ready',pid:child.pid});}}catch{record({type:'native-note',message:line});}
});
createInterface({input:process.stdin}).on('line',line=>{switch(line.trim()){case 'play':play();break;case 'stop':stop();break;case 'invite':invite();break;case 'exit':child.kill('SIGTERM');break;default:record({type:'probe-help',commands:['play','stop','invite','exit']});}});
child.on('exit',code=>{record({type:'probe-exit',code});records.end();process.exitCode=code??0;process.stdin.destroy();});
process.on('SIGINT',()=>child.kill('SIGTERM'));
