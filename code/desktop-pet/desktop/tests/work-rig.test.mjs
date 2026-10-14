import test from 'node:test';import assert from 'node:assert/strict';
import {createRig} from './rig-loader.mjs';
import {DesktopViewState} from '../view-state.ts';
import catalog from '../assets/jellyfish/presets.json';
const rig=await createRig();let clock=0;Object.defineProperty(globalThis,'performance',{value:{now:()=>clock},configurable:true});
const ids=catalog.items.filter(i=>i.availability==='automatic').map(i=>i.id),view=new DesktopViewState();
rig.last=0;let revision=0;
const policy=(enabledIds=ids)=>rig.setAutomaticPolicy({modelId:catalog.modelId,revision:++revision,enabledIds});
const frame=(work=true)=>{clock+=33;rig.updateView(view,view.state,work);};
const frames=(n=70,work=true)=>{for(let i=0;i<n;i++)frame(work);};
test('work uses real head/gaze/eye/body controls, eases in and stays inside actual ranges',()=>{
 policy();frames(60,false);const before=rig.get('ParamAngleX3');frame();assert.ok(Math.abs(rig.get('ParamAngleX3')-before)<2);
 const body=[];for(let i=0;i<160;i++){frame();body.push(rig.get('ParamBodyAngleX'));const p=rig._model.getModel().parameters;for(let n=0;n<p.count;n++)assert.ok(Number.isFinite(p.values[n])&&p.values[n]>=p.minimumValues[n]-.001&&p.values[n]<=p.maximumValues[n]+.001,p.ids[n]);}
 assert.ok(rig.get('ParamAngleX3')<-6);assert.ok(rig.get('ParamEyeBallY')<-.2);assert.ok(rig.get('ParamEyeLOpen')<.9);assert.ok(Math.max(...body)-Math.min(...body)>.2);assert.equal(rig.get('ParamMouthOpenY'),0);
});
test('chat overrides working and the whole spoken reply retains one main face; actual playback controls mouth',()=>{
 const scope={characterId:'companion',sessionId:'s',turnId:'t',generation:1};view.setSession('companion','s');view.receive({type:'turn',input:{kind:'text',scope,startedAt:''}});
 const face={emotion:'happy',intensity:1,gesture:'heart',delivery:''};view.receive({type:'reply',reply:{scope,text:'synthetic',expression:face}});frames();assert.equal(rig.get('ParamMouthOpenY'),0);
 view.receive({type:'playback',playback:{type:'started',scope,audioId:'a',at:''}});view.receive({type:'playback',playback:{type:'amplitude',scope,value:.3,at:''}});
 view.receive({type:'presentation',presentation:{scope,state:'speaking',expression:{emotion:'sad',gesture:null,intensity:1,delivery:''},mouth:1}});frames();
 assert.equal(rig.faceKey,'星星眼');assert.equal(rig.gestureKey,'比心');assert.ok(rig.get('ParamMouthOpenY')>.5);assert.ok(rig.get('fase53')>.5&&rig.get('fase72')>.5);assert.ok(Math.abs(rig.get('ParamEyeBallY'))<.01);
 view.receive({type:'presentation',presentation:{scope,state:'idle',expression:face,mouth:0}});frame();assert.ok(rig.get('ParamMouthOpenY')>.5,'upstream completion does not end playback');
 view.receive({type:'playback',playback:{type:'ended',scope,at:''}});rig.reset();frames(80,false);assert.equal(rig.get('ParamMouthOpenY'),0);assert.equal(rig.faceKey,'');assert.ok(Math.abs(rig.get('ParamEyeBallY'))<.01);
});
test('completion/interrupt exit smoothly, disabled action stays off and manual preview remains available',()=>{
 frames();const before=rig.get('ParamAngleX3');rig.reset();frame(false);assert.ok(Math.abs(rig.get('ParamAngleX3')-before)<2);frames(90,false);assert.ok(Math.abs(rig.get('ParamEyeBallY'))<.01);
 policy(ids.filter(id=>id!=='proc-work-focus'));frames();assert.ok(Math.abs(rig.get('ParamEyeBallY'))<.01);
 policy([]);frames();assert.equal(rig.get('ParamAngleX3'),0);assert.equal(rig.get('ParamMouthOpenY'),0);
 rig.selectPreset('proc-work-focus');frames(100);assert.ok(rig.get('ParamAngleX3')<-6);assert.ok(rig.get('ParamEyeBallY')<-.2);assert.equal(rig.get('ParamMouthOpenY'),0);
 rig.stopPreview();frames(100);assert.ok(Math.abs(rig.get('ParamAngleX3'))<.01);assert.ok(Math.abs(rig.get('ParamEyeBallY'))<.01);assert.equal(rig.get('fase80'),1);
});
test.after(()=>rig.dispose());
