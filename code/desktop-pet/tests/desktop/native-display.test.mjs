// Compiles production preference/geometry code without AppKit or a window.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const cache=resolve(process.env.PET_DISPLAY_TEST_CACHE || 'desktop/.cache');mkdirSync(cache,{recursive:true});
const dir=mkdtempSync(join(cache,'display-native-')),exe=join(dir,'display-test');
const suite='test.movefile.display.'+crypto.randomUUID();
try{
 writeFileSync(join(dir,'main.swift'),`
import Foundation
import CoreGraphics
let action=CommandLine.arguments[1], suite=CommandLine.arguments[2]
let defaults=UserDefaults(suiteName:suite)!
let p=PetDisplayPreferences(defaults:defaults)
if action == "save" {
 p.setMode("half");p.resize("begin",width:nil);p.resize("update",width:500);p.resize("commit",width:500);defaults.synchronize()
} else if action == "restore" {
 precondition(p.mode == "half" && p.width == 500)
 p.resize("begin",width:nil);p.resize("update",width:640);p.resize("cancel",width:nil);precondition(p.width == 500)
 p.resize("begin",width:nil);p.resize("update",width:640);p.setMode("full");precondition(p.width == 500)
 p.resize("begin",width:nil);p.resize("update",width:Double.nan);precondition(p.width == 500);p.resize("cancel",width:nil)
 p.resize("begin",width:nil);p.resize("commit",width:9999);precondition(p.width == 720)
 p.resize("begin",width:nil);p.resize("commit",width:1);precondition(p.width == 220)
 print("restart, cancellation, mode change, invalid input, min/max: passed")
} else if action == "geometry" {
 for screen in [CGRect(x:0,y:0,width:1512,height:945),CGRect(x:-800,y:50,width:800,height:560),CGRect(x:0,y:0,width:320,height:300)] {
  for width in [220.0,360.0,720.0] { for open in [false,true] {
   let l=PetDisplayLayout.fit(width:width,open:open,screen:screen,anchor:CGPoint(x:screen.maxX+100,y:screen.maxY+100))
   precondition(screen.insetBy(dx:-0.001,dy:-0.001).contains(l.frame))
   precondition(abs(l.modelHeight/l.modelWidth-340.0/360.0)<0.000001)
   precondition(l.petFrame.height<=screen.height+0.001)
   precondition(!open || screen.insetBy(dx:-0.001,dy:-0.001).contains(l.drawerFrame))
  }}
 }
 let screen=CGRect(x:0,y:0,width:1512,height:740)
 let roomy=PetDisplayLayout.fit(width:360,open:true,screen:CGRect(x:0,y:0,width:1512,height:945),anchor:CGPoint(x:0,y:945))
 precondition(roomy.drawerFrame.width == 480 && roomy.drawerHeight == 540)
 let smallModel=PetDisplayLayout.fit(width:220,open:true,screen:CGRect(x:0,y:0,width:1512,height:945),anchor:CGPoint(x:0,y:945))
 precondition(smallModel.drawerFrame.size == roomy.drawerFrame.size)
 let closed=PetDisplayLayout.fit(width:720,open:false,screen:screen,anchor:CGPoint(x:0,y:740))
 let opened=PetDisplayLayout.fit(width:720,open:true,screen:screen,anchor:CGPoint(x:0,y:740))
 // The old assertion required chat to shrink the model: the reported regression.
 // The new contract preserves its entire screen rect, even if chat must overlay.
 precondition(opened.modelFrame == closed.modelFrame)
 print("18 screen/size/open combinations and independent model/panel sizing: passed")
} else if action == "collapse" {
 for screen in [CGRect(x:0,y:0,width:1512,height:945),CGRect(x:-800,y:50,width:800,height:560),CGRect(x:10,y:20,width:32,height:30)] {
  for width in [220.0,360.0,720.0] { for open in [false,true] {
   for anchor in [CGPoint(x:screen.midX,y:screen.midY),CGPoint(x:screen.minX-500,y:screen.maxY+500),CGPoint(x:screen.maxX+500,y:screen.minY-500)] {
    let normal=PetDisplayLayout.fit(width:width,open:open,screen:screen,anchor:anchor)
    let ball=PetDisplayLayout.fit(width:width,open:open,screen:screen,anchor:anchor,collapsed:true)
    precondition(screen.insetBy(dx:-0.001,dy:-0.001).contains(ball.frame))
    precondition(ball.frame == ball.ballFrame && ball.frame.width == min(44,screen.width,screen.height))
    precondition(ball.modelFrame == normal.modelFrame && ball.drawerFrame == normal.drawerFrame)
    precondition(ball.configuration["collapsed"] as? Bool == true)
    precondition(ball.configuration["ballLeft"] as? CGFloat == ball.frame.minX-screen.minX)
    let cssY=ball.configuration["ballTop"] as! CGFloat
    precondition(abs(screen.maxY-ball.frame.maxY-cssY)<0.001)
    let restored=PetDisplayLayout.fit(width:width,open:open,screen:screen,anchor:CGPoint(x:ball.frame.midX,y:ball.frame.maxY))
    precondition(!restored.collapsed && restored.modelWidth == normal.modelWidth)
    precondition(restored.viewport == ball.viewport && screen.insetBy(dx:-0.001,dy:-0.001).contains(restored.frame))
   }
  }}
 }
 precondition(p.width == 360 && p.mode == "full")
 print("54 ball/restore screen-size-panel-edge cases: passed; viewport/model/drawer dimensions and preferences retained")
} else if action == "clean" { defaults.removePersistentDomain(forName:suite) }
`);
 const compiled=spawnSync('swiftc',['-module-cache-path',join(cache,'swift'),'desktop/native/display-layout.swift',join(dir,'main.swift'),'-o',exe],{encoding:'utf8'});
 assert.equal(compiled.status,0,compiled.stderr);
 test('native sizing fits min/max and small/negative-origin screens without changing aspect',()=>{const r=spawnSync(exe,['geometry',suite],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);console.log(r.stdout.trim())});
 test('actual native preferences survive another process and only completed resize persists',()=>{for(const action of ['save','restore']){const r=spawnSync(exe,[action,suite],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);if(r.stdout)console.log(r.stdout.trim())}});
 test('collapsed native frame contains only the ball and restores model/panel geometry without saving preferences',()=>{const r=spawnSync(exe,['collapse',suite+'-collapse'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);console.log(r.stdout.trim());spawnSync(exe,['clean',suite+'-collapse'])});
 test.after(()=>{spawnSync(exe,['clean',suite]);rmSync(dir,{recursive:true,force:true})});
}catch(error){rmSync(dir,{recursive:true,force:true});throw error}
