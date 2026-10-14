import test from 'node:test';
import assert from 'node:assert/strict';
import {app} from './ui-harness.mjs';
const config = (mode='full',width=360) => ({mode,preferredWidth:width,modelWidth:width,modelHeight:width*340/360,drawerHeight:340});
const event = (extra={}) => ({pointerId:7,button:0,screenX:0,screenY:0,preventDefault(){},stopPropagation(){},...extra});
const shell = a => a.messages.filter(m=>m.name==='shell' && m.value.type!=='ready').map(m=>m.value);

test('actual entry applies restored framing and screen-fit size without scaling chat fonts or overwriting preference',async()=>{
 const a=await app();a.bridge.displayConfig({...config('half',720),modelWidth:280,modelHeight:280*340/360});
 assert.equal(a.harness.framing,'half');assert.equal(a.node('view-half')['aria-pressed'],'true');
 assert.equal(a.node('character').style.width,'280px');assert.equal(a.node('text').style.fontSize,undefined);
 assert.equal(shell(a).length,0);
 a.node('view-full').onclick(event());assert.equal(shell(a).at(-1).type,'set_display');assert.equal(shell(a).at(-1).mode,'full');
 assert.ok(!shell(a).some(x=>x.type==='panel'||x.type==='drag'));assert.equal(a.wire().length,0);
});
test('corner pointer capture keeps diagonal size proportional outside element and commits once without opening chat or PTT',async()=>{
 const a=await app(),h=a.node('model-resize');a.bridge.displayConfig(config());
 h.onpointerdown(event());h.onpointermove(event({screenX:100,screenY:100*340/360}));h.onpointerup(event());h.onlostpointercapture(event());
 const commands=shell(a);assert.deepEqual(commands.map(x=>x.phase),['begin','update','commit']);assert.ok(Math.abs(commands.at(-1).width-460)<.001);assert.equal(h.captured,null);assert.equal(a.wire().length,0);
});
test('pointer loss, blur and mode change cancel a resize; idle clicks do not replace a constrained saved size',async()=>{
 for(const end of ['onpointercancel','onlostpointercapture','blur','mode']){
  const a=await app(),h=a.node('model-resize');a.bridge.displayConfig({...config('half',720),modelWidth:280});h.onpointerdown(event());h.onpointermove(event({screenX:50}));
  if(end==='blur')a.listeners.get('window:blur')();else if(end==='mode')a.node('view-full').onclick(event());else h[end](event());
  assert.equal(shell(a).filter(x=>x.phase==='cancel').length,1,end);h.onpointerup(event());assert.equal(shell(a).filter(x=>x.phase==='commit').length,0);
 }
 const a=await app(),h=a.node('model-resize');h.onpointerdown(event());h.onpointerup(event());assert.equal(shell(a).at(-1).phase,'cancel');
});
test('resize arrows do not trigger configured speech key; Escape cancels before conversation shortcuts',async()=>{
 const a=await app();a.changed(1);await a.ready();a.bridge.hotkeyConfig('ArrowRight');const h=a.node('model-resize');
 const e=event({target:h,key:'ArrowRight',code:'ArrowRight'});a.listeners.get('keydown')(e);h.onkeydown(e);
 assert.equal(a.wire().length,0);assert.equal(shell(a).at(-1).width,380);
 h.onpointerdown(event());a.listeners.get('keydown')(event({target:h,key:'Escape',code:'Escape'}));assert.equal(shell(a).at(-1).phase,'cancel');
});
