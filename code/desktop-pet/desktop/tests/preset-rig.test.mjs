import test from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRig,read} from './rig-loader.mjs';
const rig=await createRig(),root='desktop/assets/jellyfish/';
const raw=await readFile(root+'pet.model3.json'),model=JSON.parse(raw),parameters=rig._model.getModel().parameters;
const catalog=JSON.parse(await readFile(root+'presets.json'));
const names=new Map(JSON.parse(await readFile(root+'星月水母.cdi3.json')).Parameters.map(p=>[p.Id,p.Name]));
const ranges=Array.from(parameters.ids,(id,i)=>({id,name:names.get(id)??'',min:parameters.minimumValues[i],max:parameters.maximumValues[i],default:parameters.defaultValues[i]}));
const expressions=[];
for(const e of model.FileReferences.Expressions){const json=JSON.parse(await readFile(root+e.File));expressions.push({name:e.Name,file:e.File,parameters:json.Parameters.map(p=>({...p,...ranges.find(r=>r.id===p.Id)}))})}
const evidence={modelId:catalog.modelId,modelFingerprint:catalog.modelFingerprint,manifestSha256:createHash('sha256').update(raw).digest('hex'),parameters:ranges,expressions,motion:JSON.parse(await readFile(root+'Scene1.motion3.json')).Meta,automatic:[],preview:[]};
const view={state:'speaking',mouth:.3,expression:{emotion:'happy',intensity:1,delivery:'',gesture:'heart'}};
const frames=(n=70)=>{for(let i=0;i<n;i++){rig.last=performance.now()-33;rig.updateView(view)}};
const ids=catalog.items.filter(i=>i.availability==='automatic').map(i=>i.id);
const policy=(revision,enabledIds=ids,modelId=catalog.modelId)=>rig.setAutomaticPolicy({modelId,revision,enabledIds});
test('manifest expressions reference real finite Cubism parameters',()=>{
 assert.equal(ranges.length,244);assert.equal(expressions.length,36);
 for(const e of expressions)for(const p of e.parameters){assert.ok(p.id,e.name+':'+p.Id);assert.ok(Number.isFinite(p.Value));assert.ok(p.min<=p.default&&p.default<=p.max,p.Id)}
 console.log(JSON.stringify({realParameters:ranges.length,expressions:expressions.length,watermark:rig.get('fase80'),controlled:ranges.filter(p=>['ParamAngleX2','ParamAngleX3','ParamAngleX4','ParamBodyAngleX','ParamMouthOpenY','ParamEyeLOpen','ParamEyeROpen'].includes(p.id))}));
});
test('replaced moc bytes with unchanged filename/manifest reject old model binding',async()=>{
 await assert.rejects(()=>createRig(async name=>{const buffer=await read(name);if(name.endsWith('.moc3'))new Uint8Array(buffer)[100]^=1;return buffer}),/模型与预设目录版本不一致/);
});
test('no policy fails closed but actual playback mouth remains available',()=>{
 frames();assert.equal(rig.faceKey,'');assert.equal(rig.gestureKey,'');assert.equal(rig.get('ParamBreath'),0);assert.equal(rig.get('ParamAngleX2'),0);assert.equal(rig.get('ParamEyeLOpen'),1);assert.ok(rig.get('ParamMouthOpenY')>.5);
});
test('all 17 enabled expression/pose IDs drive real parameters and retain mouth',()=>{
 assert.ok(policy(1));
 for(const item of catalog.items.filter(i=>['expression','pose'].includes(i.category))){
  rig.reset();view.expression={emotion:'happy',intensity:1,delivery:'',gesture:'heart',presetId:item.id};frames();
  const changed=expressions.find(e=>e.name===item.expressionName).parameters.filter(p=>p.Id!=='ParamMouthOpenY'&&p.Value!==0).map(p=>({id:p.Id,value:rig.get(p.Id)}));
  assert.ok(changed.some(p=>Math.abs(p.value)>.2),item.id);assert.equal(item.category==='expression'?rig.faceKey:rig.gestureKey,item.expressionName);assert.equal(item.category==='expression'?rig.gestureKey:rig.faceKey,'');assert.ok(rig.get('ParamMouthOpenY')>.5);assert.equal(rig.get('fase80'),1);
  evidence.automatic.push({id:item.id,changed});
 }
});
test('explicit null, unknown and appearance IDs never fall back to emotion or gesture',()=>{
 for(const presetId of [null,'unknown','../../face.exp3.json','exp-shouer']){
  rig.reset();view.expression={emotion:'happy',intensity:1,delivery:'',gesture:'heart',presetId};frames();assert.equal(rig.faceKey,'');assert.equal(rig.gestureKey,'');assert.equal(rig.get('fase53'),0);assert.equal(rig.get('fase72'),0);assert.equal(rig.get('fase67'),0);
 }
});
test('legacy face/pose coexist; disabling clears in-flight and repeated late intents each frame',()=>{
 rig.reset();view.expression={emotion:'happy',intensity:1,delivery:'',gesture:'heart'};frames();assert.equal(rig.faceKey,'星星眼');assert.equal(rig.gestureKey,'比心');assert.ok(rig.get('fase53')>.5&&rig.get('fase72')>.5);
 assert.ok(policy(2,[]));frames(1);assert.equal(rig.get('fase53'),0);assert.equal(rig.get('fase72'),0);
 for(const presetId of ['exp-xingxingyan','exp-qidao']){view.expression.presetId=presetId;frames();assert.equal(rig.faceKey,'');assert.equal(rig.gestureKey,'');assert.equal(rig.get('fase92'),0)}
 for(const id of ['ParamAngleX2','ParamAngleX3','ParamAngleX4','ParamBreath'])assert.equal(rig.get(id),0,id);
 assert.equal(rig.get('ParamEyeLOpen'),1);assert.equal(rig.get('ParamEyeROpen'),1);assert.equal(rig._motionManager.isFinished(),true);assert.ok(rig.get('ParamMouthOpenY')>.5);
});
test('policy rejects stale revisions and other model IDs without granting fallback',()=>{
 assert.equal(policy(1),false);assert.equal(rig.automaticIds.size,0);
 assert.equal(policy(3,ids,'different-model'),false);assert.equal(rig.automaticIds.size,0);
 assert.equal(policy(3,['exp-shouer']),false);assert.equal(rig.automaticIds.size,0);
 assert.ok(policy(3));assert.equal(policy(3,[]),false);assert.equal(rig.automaticIds.size,21);
 assert.equal(policy(0,[],'disconnected'),false);assert.equal(rig.automaticIds.size,0);assert.ok(policy(0));assert.equal(rig.automaticIds.size,21);
 policy(4,[]);
});
test('turn reset and all 39 previews stay in real rig bounds, release controls and preserve accessories',()=>{
 rig.reset();rig.set('fase67',1);frames();rig.reset();assert.equal(rig.get('fase67'),1);
 view.state='idle';view.mouth=0;
 for(const item of catalog.items.filter(i=>i.previewable)){
  rig.selectPreset(item.id);frames(100);assert.equal(rig.get('fase80'),1);assert.equal(rig.get('ParamMouthOpenY'),0);
  const live=Array.from(parameters.values);assert.ok(live.every(Number.isFinite));
  for(let i=0;i<live.length;i++)assert.ok(live[i]>=parameters.minimumValues[i]-.0001&&live[i]<=parameters.maximumValues[i]+.0001,item.id+':'+parameters.ids[i]);
  evidence.preview.push({id:item.id,changed:live.flatMap((v,i)=>Math.abs(v-rig.previewBaseline[i])>.01?[parameters.ids[i]]:[])});
  rig.stopPreview();frames(100);assert.equal(rig.get('fase67'),1);assert.equal(rig.get('fase80'),1);
  for(const id of ['fase53','fase72','fase92','fase85','fase99'])assert.ok(Math.abs(rig.get(id)-rig.previewBaseline[rig.parameterIndices.get(id)])<.001,item.id+':release '+id);
 }
 assert.throws(()=>rig.selectPreset('exp-shuiyin'));assert.throws(()=>rig.selectPreset('../file'));assert.throws(()=>rig.selectPreset({id:'exp-qidao'}));
 rig.selectPreset('exp-qidao');frames();const before=rig.get('fase92');rig.selectPreset('exp-tushe');frames(1);assert.ok(rig.get('fase92')>before*.25,'outgoing pose fades rather than dropping in one frame');rig.restorePreview();frames(100);assert.equal(rig.get('fase92'),0);assert.equal(rig.get('fase67'),1);assert.equal(rig.get('fase80'),1);
});
test.after(async()=>{rig.dispose();await writeFile('../../artifacts/W1/preset-management-01/rig-evidence.json',JSON.stringify(evidence,null,2)+'\n')});
