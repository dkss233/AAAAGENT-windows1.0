import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
const scope={characterId:'companion',sessionId:'s1',turnId:'old',generation:1};
const tts={scope,audio:{id:'synthetic-audio',uri:'test://audio',mimeType:'audio/wav',temporary:true},expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null},durationMs:null,synchronization:'amplitude'};
const commandTypes=a=>a.wire().filter(m=>m.value.message.channel==='command').map(m=>m.value.message.command.type);
const down=(a,repeat=false,target={tagName:'DIV'})=>a.listeners.get('keydown')({code:'Space',key:' ',repeat,target,preventDefault(){},stopPropagation(){}});
const up=a=>a.listeners.get('keyup')({code:'Space',preventDefault(){},stopPropagation(){}});
async function ready(){const a=await app();a.changed(1);await a.ready();a.bridge.hotkeyConfig('Space');return a;}
async function oldText(a){a.node('text').value='合成旧输入';a.node('form').onsubmit({preventDefault(){}});await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'text',startedAt:''}}},1);}
for(const announced of [false,true])test(`Space stops the current audio synchronously, started event announced=${announced}`,async()=>{
 const a=await ready();await oldText(a);const playing=a.bridge.receive({channel:'play',requestId:'old-play',tts,audioBase64:'AQI='},1);await Promise.resolve();
 if(announced)a.harness.playback.emit({type:'started',audioId:'synthetic-audio',at:''});
 try{down(a);
 // No await: output abort/stop must precede any bridge or microphone readiness.
 assert.equal(a.harness.playback.signal.aborted,true,'Space must abort local output even while UI still says thinking');
 assert.ok(a.harness.playStops>0);assert.equal(a.harness.captureOpens,0);assert.equal(commandTypes(a).at(-1),'start_voice');
 }finally{a.node('stop').onclick();up(a);await playing;}
});
test('Space starts a replacement voice during pure thinking',async()=>{
 const a=await ready();await oldText(a);down(a);assert.equal(commandTypes(a).at(-1),'start_voice');up(a);
});
for(const phase of ['preparing','listening','finishing'])test(`Space replaces a previous voice in ${phase}`,async()=>{
 const b=await ready();b.node('voice').onclick();await b.bridge.receive({channel:'event',event:{type:'turn',input:{scope,kind:'voice',startedAt:''}}},1);
 const opening=b.bridge.receive({channel:'capture_start',requestId:'old-capture',scope},1);let stopped=false;const session={stop(){stopped=true;}};
 if(phase!=='preparing'){b.harness.openCapture(session);await opening;}
 if(phase==='finishing')b.node('voice').onclick();
 down(b);assert.equal(commandTypes(b).at(-1),'start_voice','old voice phase cannot block a fresh held turn');assert.equal(b.harness.captureSignal.aborted,true);
 if(phase==='preparing'){b.harness.openCapture(session);await opening;}
 assert.equal(stopped,true);assert.match(b.node('status').textContent,/准备麦克风/);up(b);
});

test('old prepared audio and old packets cannot revive after Space, while repeat/repress and current capture still work',async()=>{
 const a=await ready();await oldText(a);a.harness.delayPlaybackOpen=true;
 const playing=a.bridge.receive({channel:'play',requestId:'old-prepare',tts,audioBase64:'AQI='},1);await Promise.resolve();const old=a.harness.playback;
 down(a);assert.equal(old.signal.aborted,true);const first=a.wire().at(-1).value.message.command.clientRequestId;
 down(a,true);down(a);assert.equal(commandTypes(a).filter(t=>t==='start_voice').length,1);
 up(a);down(a);const second=a.wire().at(-1).value.message.command.clientRequestId;assert.notEqual(first,second);
 const current={...scope,turnId:'new',generation:3};await a.bridge.receive({channel:'event',event:{type:'turn',input:{scope:current,kind:'voice',startedAt:'',clientRequestId:second}}},1);
 a.harness.resolvePlayback();await playing;old.emit({type:'started',audioId:'old-late',at:''});old.emit({type:'amplitude',value:1,at:''});
 const late={channel:'play',requestId:'old-packet',tts,audioBase64:'AQI='};await a.bridge.receive(late,1);assert.equal(a.harness.playOpens,1);assert.equal(late.audioBase64,'');
 await a.bridge.receive({channel:'event',event:{type:'reply',reply:{scope,text:'旧轮迟到文本',expression:tts.expression}}},1);assert.ok(!a.renderedText().includes('旧轮迟到文本'));
 const opening=a.bridge.receive({channel:'capture_start',requestId:'new-capture',scope:current},1);a.harness.openCapture({stop(){}});await opening;assert.match(a.node('status').textContent,/正在听/);up(a);assert.equal(commandTypes(a).at(-1),'finish_voice');
});
test('stale capture stop does not clear the new microphone preparation state',async()=>{
 const a=await ready();await oldText(a);down(a);assert.match(a.node('status').textContent,/准备麦克风/);
 await a.bridge.receive({channel:'capture_stop',requestId:'old-stop',scope},1);assert.match(a.node('status').textContent,/准备麦克风/);a.node('voice').onclick();assert.equal(commandTypes(a).at(-1),'cancel','old stop must not turn cancel-preparation into another start');up(a);
});
test('Space in editable input and IME remains typing; ordinary Space stops audio before sending a new command',async()=>{
 const a=await ready();await oldText(a);const playing=a.bridge.receive({channel:'play',requestId:'old-play',tts,audioBase64:'AQI='},1);await Promise.resolve();a.harness.playback.emit({type:'started',audioId:'synthetic-audio',at:''});
 for(const target of [{tagName:'INPUT'},{tagName:'TEXTAREA'},{tagName:'DIV',isContentEditable:true}])down(a,false,target);
 a.listeners.get('keydown')({code:'Space',key:' ',target:{tagName:'DIV'},isComposing:true,preventDefault(){},stopPropagation(){}});
 assert.equal(a.harness.playStops,0);assert.equal(commandTypes(a).filter(t=>t==='start_voice').length,0);assert.equal(a.harness.captureOpens,0);
 a.harness.order.length=0;down(a);assert.equal(a.harness.order[0],'output-stop');assert.ok(a.harness.order.indexOf('command:start_voice')>0);up(a);await playing;
});
test('playback preparation errors show short Chinese feedback without engine details',async()=>{
 const a=await ready();await oldText(a);a.harness.playbackError='EncodingError: decodeAudioData PRIVATE_ENDPOINT';
 await a.bridge.receive({channel:'play',requestId:'broken',tts,audioBase64:'AQI='},1);
 assert.match(a.node('status').textContent,/语音|声音/);assert.doesNotMatch(a.renderedText(),/EncodingError|decodeAudioData|PRIVATE_ENDPOINT/);
});
