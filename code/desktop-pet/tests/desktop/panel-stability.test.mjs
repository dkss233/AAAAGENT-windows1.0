import test from 'node:test';import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';import {geometry} from './stability-geometry.mjs';
const g=geometry(),evidence=[];
try{
test('model screen rect and WK viewport remain invariant throughout open/close at every edge',()=>{
 for(const screen of [[0,0,1280,720],[-1440,-100,1440,900],[0,0,800,560],[0,0,320,300]]){
  const [x,y,w,h]=screen;
  for(const width of [220,360,720])for(const anchor of [[x,y],[x+w,y],[x,y+h],[x+w,y+h],[x+w/2,y+h/2]]){
   let l=g.layout({screen,width,anchor}),fixed=l.model;
   for(const open of [true,false,true,true,false,false]){
    l=g.layout({screen,width,anchor:l.anchor,open});assert.deepEqual(l.model,fixed);assert.deepEqual(l.screen,screen);
    const [fx,fy,fw,fh]=l.frame;assert.ok(fx>=x-.01&&fy>=y-.01&&fx+fw<=x+w+.01&&fy+fh<=y+h+.01);
    if(!open)assert.deepEqual(l.frame,l.pet,'collapsed native hit area returns to pet');
    if(open&&l.placement!=='overlay'){
     const c=l.config,dy=y+h-c.drawerTop-c.drawerHeight,dx=x+c.drawerLeft,[mx,my,mw,mh]=l.model;
     assert.ok(dx+c.drawerWidth<=mx+.01||dx>=mx+mw-.01||dy+c.drawerHeight<=my+.01||dy>=my+mh-.01);
    }
   }
   evidence.push({screen,width,anchor,model:fixed});
  }
 }
});
test('reported 720px screen regression no longer moves or scales model; full-size side wins over short bottom',()=>{
 let l=g.layout({anchor:[990,650]});const before=l.model;
 const steps=[l];for(const open of [true,false]){l=g.layout({anchor:l.anchor,open});steps.push(l);assert.deepEqual(l.model,before)}
 assert.equal(steps[1].config.drawerHeight,540);assert.equal(steps[1].placement,'left');
 writeFileSync('../../artifacts/W1/panel-stability-01/after-geometry.json',JSON.stringify(steps,null,2)+'\n');
});
test('explicit user resize or drag changes model geometry, crowded screens use a readable overlay without shrinking it',()=>{
 const a=g.layout({width:360,anchor:[640,650]});const moved=g.layout({width:360,anchor:[a.anchor[0]-40,a.anchor[1]-20]});assert.equal(moved.model[0],a.model[0]-40);
 const resized=g.layout({width:500,anchor:a.anchor});assert.equal(resized.model[2],500);
 const closed=g.layout({width:720,screen:[0,0,800,560],anchor:[400,560]});const opened=g.layout({width:720,screen:[0,0,800,560],anchor:closed.anchor,open:true});
 assert.deepEqual(opened.model,closed.model);assert.equal(opened.placement,'overlay');assert.equal(opened.config.drawerHeight,540);
});
}finally{test.after(()=>{writeFileSync('../../artifacts/W1/panel-stability-01/geometry-matrix.json',JSON.stringify(evidence,null,2)+'\n');g.close()})}
