// Uses the supplied real .moc3 and official Core/Framework; only the GPU draw is omitted.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopViewState } from '../../desktop/view-state.ts';
import { COMPANION_ID } from '../../contracts/character.ts';
globalThis.__dirname=resolve('desktop/vendor/cubism/Core');
globalThis.require=createRequire(import.meta.url);
vm.runInThisContext(await readFile('desktop/vendor/cubism/Core/live2dcubismcore.min.js','utf8'));
// Core initializes its embedded runtime asynchronously; wait for the public version function.
for(let attempt=0;attempt<100;attempt++){try{Live2DCubismCore.Version.csmGetVersion();break;}catch(error){if(attempt===99)throw error;await new Promise(resolve=>setTimeout(resolve, 10));}}
const {JellyfishRenderer}=await import('../../desktop/cubism-renderer.mjs');
const read=async name=>{const b=await readFile('desktop/assets/jellyfish/'+name);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
class SilentRig extends JellyfishRenderer { draw() {} }
const rig=new SilentRig(null,()=>{});await rig.loadRig(read);rig.ready=true;
const view=new DesktopViewState();
const frame=()=>{rig.last=performance.now()-33;rig.updateView(view);};
test('real rig keeps mouth, face and body gesture active concurrently, then resets all three',()=>{
 view.state='speaking';view.mouth=.4;view.expression={emotion:'happy',intensity:1,delivery:'',gesture:'heart'};
 const body=[];for(let i=0;i<80;i++){frame();body.push(rig.get('ParamBodyAngleX'));}
 console.log(JSON.stringify({evidence:'actual-rig',bodyMin:Math.min(...body),bodyMax:Math.max(...body),...rig.snapshot(),eye:rig.get('fase53'),heart:rig.get('fase72'),watermarkSwitch:rig.get('fase80')}));
 assert.ok(rig.get('ParamMouthOpenY')>.1);assert.ok(rig.get('fase53')>.5);assert.ok(rig.get('fase72')>.5);
 assert.ok(Math.max(...body)-Math.min(...body)>.1);assert.equal(rig.get('fase80'),1);
 rig.reset();view.reset();for(let i=0;i<4;i++)frame();
 assert.equal(rig.get('ParamMouthOpenY'),0);assert.equal(rig.get('fase53'),0);assert.equal(rig.get('fase72'),0);assert.equal(rig.get('fase80'),1);
});
test('real supplied rig ignores costume and watermark names in model gesture intent',()=>{
 rig.reset();view.reset();
 for(const gesture of ['水印','飞头','变小','does-not-exist']){view.expression={emotion:'neutral',intensity:0,delivery:'',gesture};for(let i=0;i<4;i++)frame();assert.equal(rig.snapshot().gesture,'');assert.equal(rig.get('fase80'),1);assert.equal(rig.get('ParamMouthOpenY'),0);}
});
test('changing supported face and pose keeps an outgoing expression during the transition while mouth stays live',()=>{
 rig.reset();view.reset();view.state='speaking';view.mouth=.25;view.expression={emotion:'happy',intensity:1,delivery:'',gesture:'heart'};
 for(let i=0;i<80;i++)frame();const before=rig.get('fase53');
 view.expression={emotion:'sad',intensity:1,delivery:'',gesture:'comfort'};frame();
 assert.ok(before>.5);assert.ok(rig.get('fase53')>before*.25,'换表情首帧不能直接删掉上一表情');
 assert.ok(rig.get('ParamMouthOpenY')>.1,'表情转换不能停止实际说话口型');
 rig.reset();view.reset();frame();assert.equal(rig.get('fase53'),0);assert.equal(rig.get('ParamMouthOpenY'),0);
});

test('historical smoke02 payload with test-only companion scope drives its face and resets at playback end',async()=>{
 const frozen=JSON.parse(await readFile('tests/desktop/fixtures/actual-smoke02-reply.json','utf8'));
 // The frozen reply/source hash belongs to the old friend trial. Rebind only an
 // in-memory test copy; this is not a real companion reply or a data migration.
 const event={...frozen.event,reply:{...frozen.event.reply,scope:{...frozen.event.reply.scope,characterId:COMPANION_ID}}};
 const v=new DesktopViewState(),scope=event.reply.scope;v.setSession(scope.characterId,scope.sessionId);
 v.receive({type:'turn',input:{scope,kind:'text',startedAt:''}});v.receive(event);
 v.receive({type:'playback',playback:{type:'started',scope,audioId:'silent-event-only',at:''}});
 v.receive({type:'playback',playback:{type:'amplitude',scope,value:.25,at:''}});
 rig.reset();for(let i=0;i<80;i++){rig.last=performance.now()-33;rig.updateView(v)}
 assert.equal(rig.snapshot().face,'星星眼');assert.equal(rig.snapshot().gesture,'');assert.ok(rig.get('fase53')>.5);assert.ok(rig.get('ParamMouthOpenY')>.1);
 assert.deepEqual(v.expression,frozen.event.reply.expression,'render normalization leaves the historical expression/TTS delivery unchanged');
 v.receive({type:'playback',playback:{type:'ended',scope,at:''}});rig.reset();rig.updateView(v);
 assert.equal(rig.get('ParamMouthOpenY'),0);assert.equal(rig.get('fase53'),0);
});
test('four supported supplied poses remain controllable together with mouth and face',()=>{
 for(const [gesture,parameter] of [['heart','fase72'],['comfort','fase86'],['hold_star','fase73'],['lean','ParamAngleZ4']]){
  rig.reset();view.reset();view.state='speaking';view.mouth=.3;view.expression={emotion:'warm',intensity:.7,delivery:'',gesture};
  for(let i=0;i<80;i++)frame();assert.ok(Math.abs(rig.get(parameter))>.3,gesture);assert.ok(rig.get('fase55')>.5);assert.ok(rig.get('ParamMouthOpenY')>.1);assert.equal(rig.get('fase80'),1);
 }
 rig.reset();view.reset();frame();assert.equal(rig.get('ParamMouthOpenY'),0);
});
test('framing and Retina resize change only projection/buffer, keep isotropic pixels and preserve rig parameters',()=>{
 const before=Array.from(rig._model.getModel().parameters.values);
 rig.canvas={clientWidth:360,clientHeight:340,width:0,height:0};globalThis.devicePixelRatio=2;
 rig._modelMatrix.setHeight(1.9);rig._modelMatrix.setPosition(0,0);
 rig.setFraming('full');const full=Array.from(rig.projection.getArray());
 assert.equal(rig.canvas.width,720);assert.equal(rig.canvas.height,680);
 rig.setFraming('half');const half=rig.projection.getArray();assert.ok(Math.abs(half[0]-full[0]*3.2)<.000001);assert.ok(Math.abs(half[5]-full[5]*3.2)<.000001);assert.ok(half[13]<-1.3);
 assert.deepEqual(Array.from(rig._model.getModel().parameters.values),before);
 for(const width of [220,720,280]){rig.canvas.clientWidth=width;rig.canvas.clientHeight=width*340/360;rig.syncViewport();const m=rig.projection.getArray();assert.ok(Math.abs(m[0]*rig.canvas.width-m[5]*rig.canvas.height)<.001);}
 globalThis.devicePixelRatio=1;rig.syncViewport();assert.equal(rig.canvas.width,560);
 rig.canvas.clientWidth=360;rig.canvas.clientHeight=340;globalThis.devicePixelRatio=2;rig.setFraming('full');assert.deepEqual(Array.from(rig.projection.getArray()),full);
 assert.deepEqual(Array.from(rig._model.getModel().parameters.values),before);
 rig.canvas=null;
});
