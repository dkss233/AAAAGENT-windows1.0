import test from 'node:test';import assert from 'node:assert/strict';
import {createRig} from './rig-loader.mjs';import catalog from '../assets/jellyfish/presets.json';
const rig=await createRig();let time=0;Object.defineProperty(globalThis,'performance',{value:{now:()=>time},configurable:true});
const ids=catalog.items.filter(i=>i.availability==='automatic').map(i=>i.id);
rig.setAutomaticPolicy({modelId:catalog.modelId,revision:1,enabledIds:ids});rig.last=0;
const view={state:'idle',mouth:0,expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null}};
const frame=(state=view.state)=>{view.state=state;time+=33;rig.updateView(view);return ['ParamAngleX2','ParamAngleX3','ParamAngleX4','ParamEyeBallX','ParamEyeBallY','ParamEyeLOpen'].map(id=>rig.get(id));};
test('thinking enters without a head snap, holds gaze and tilt then eases out',()=>{
 for(let i=0;i<40;i++)frame();const before=frame(),first=frame('thinking');assert.ok(Math.abs(first[1]-before[1])<2,'no direct state pitch jump');
 for(let i=0;i<90;i++)frame();assert.ok(Math.abs(rig.get('ParamEyeBallX'))>.15);assert.ok(Math.abs(rig.get('ParamAngleX4'))>3);
 const prior=rig.get('ParamAngleX4');rig.reset();frame('idle');assert.ok(Math.abs(rig.get('ParamAngleX4')-prior)<2,'reset eases transient head control');
 for(let i=0;i<100;i++)frame();assert.ok(Math.abs(rig.get('ParamEyeBallX'))<.01);
});
test('attention changes real head and eyes; interrupt, policy and mouth remain independent',()=>{
 rig.beginAttention();const samples=[];for(let i=0;i<30;i++)samples.push(frame('listening'));
 assert.ok(Math.min(...samples.map(s=>s[5]))<.5);assert.ok(Math.max(...samples.map(s=>s[1]))-Math.min(...samples.map(s=>s[1]))>3);
 rig.beginAttention();frame('thinking');rig.reset();view.mouth=.4;view.expression={emotion:'happy',intensity:1,delivery:'',gesture:'heart'};for(let i=0;i<30;i++)frame('speaking');assert.ok(rig.get('ParamMouthOpenY')>.5);assert.ok(rig.get('fase72')>.5);
 rig.setAutomaticPolicy({modelId:catalog.modelId,revision:2,enabledIds:[]});rig.beginAttention();for(let i=0;i<40;i++)frame('thinking');
 for(const id of ['ParamAngleX2','ParamAngleX3','ParamAngleX4','ParamEyeBallX','ParamEyeBallY'])assert.equal(rig.get(id),rig.defaults[rig.parameterIndices.get(id)],id);
 assert.equal(rig.get('ParamMouthOpenY'),0);assert.equal(rig.get('fase80'),1);
 assert.equal(rig.interaction.attentionAt,null,'disabled gestures are never queued');
 rig.setAutomaticPolicy({modelId:catalog.modelId,revision:3,enabledIds:ids});rig.beginAttention();assert.notEqual(rig.interaction.attentionAt,null);rig.setAutomaticPolicy({modelId:'disconnected',revision:0,enabledIds:[]});assert.equal(rig.interaction.attentionAt,null);
});
test.after(()=>rig.dispose());
