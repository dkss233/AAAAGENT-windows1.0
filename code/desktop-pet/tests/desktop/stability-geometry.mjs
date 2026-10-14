// Compiles the actual shell geometry; browser/native probes consume this output.
import {readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
export function geometry(baseline=false) {
 const dir=resolve('../../artifacts/W1/panel-stability-01/geometry-'+(baseline?'before':'after'));mkdirSync(dir,{recursive:true});
 const source=baseline?execFileSync('git',['show','ab35d0e:code/desktop-pet/desktop/native/display-layout.swift'],{encoding:'utf8'}):readFileSync('desktop/native/display-layout.swift','utf8');
 const body=`
let a=CommandLine.arguments.dropFirst().map{Double($0)!}
let screen=CGRect(x:a[2],y:a[3],width:a[4],height:a[5])
let l=PetDisplayLayout.fit(width:a[0],open:a[1]==1,screen:screen,anchor:CGPoint(x:a[6],y:a[7]))
func rect(_ r:CGRect)->[Double]{[r.minX,r.minY,r.width,r.height]}
${baseline?`let model=CGRect(x:l.frame.midX-l.modelWidth/2,y:l.frame.maxY-l.modelHeight,width:l.modelWidth,height:l.modelHeight)
let config:[String:Any]=["modelWidth":l.modelWidth,"modelHeight":l.modelHeight,"drawerHeight":l.drawerHeight]
let modelFrame=model,petFrame=CGRect(x:l.frame.minX,y:l.frame.maxY-l.modelHeight-36,width:l.frame.width,height:l.modelHeight+36),placement="below"
let nextAnchor=[l.frame.minX,l.frame.maxY]`:`let config=l.configuration,modelFrame=l.modelFrame,petFrame=l.petFrame,placement=l.placement
let nextAnchor=[l.modelFrame.midX,l.modelFrame.maxY]`}
let result:[String:Any]=["frame":rect(l.frame),"model":rect(modelFrame),"pet":rect(petFrame),"config":config,"screen":rect(screen),"placement":placement,"anchor":nextAnchor]
print(String(data:try! JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]),encoding:.utf8)!)
`;
 writeFileSync(join(dir,'main.swift'),source+body);
 execFileSync('swiftc',[join(dir,'main.swift'),'-o',join(dir,'layout')]);
 return {layout({width=360,open=false,screen=[0,0,1280,720],anchor=[990,650]}){return JSON.parse(execFileSync(join(dir,'layout'),[width,+open,...screen,...anchor].map(String),{encoding:'utf8'}))},close(){rmSync(dir,{recursive:true,force:true})}};
}
