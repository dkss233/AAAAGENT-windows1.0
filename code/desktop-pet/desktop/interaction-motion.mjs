// Semantic timing only. Model IDs and physical ranges belong to the renderer.
const smooth=t=>t*t*(3-2*t);
const curve=(t,points)=>{for(let i=1;i<points.length;i++){const [end,value]=points[i],[start,previous]=points[i-1];if(t<=end)return previous+(value-previous)*smooth(Math.max(0,(t-start)/(end-start)));}return points.at(-1)[1];};
// Cursor-following amounts, in the same units the idle animation uses: gaze is -1..1, and the angles
// are yaw/pitch/roll units that the renderer scales. Note the two destinations differ — the body
// angles are written directly, while ParamAngleX/Y/Z run through MOTION_TUNING.headAngleScale (30),
// so the head values here are small on purpose. Kept modest because this rig's 45 physics chains
// amplify the head angles into hair, clothing and body motion, exactly as in Cubism's cursor preview.
export const LOOK_TUNING = {
  headYaw: 0.3, headPitch: 0.23, headRoll: 0.27,
  bodyYaw: 3, bodyPitch: 2, bodyRoll: 2,
  gazeX: 0.95, gazeY: 0.85,
};
export class InteractionMotion {
  constructor(){
    this.values={yaw:0,pitch:0,roll:0,body:0,bodyYaw:0,bodyPitch:0,bodyRoll:0,gazeX:0,gazeY:0,blink:0};
    this.attentionAt=null;
    this.look={active:false,x:0,y:0};
  }
  start(now){this.attentionAt=now;}
  release(){this.attentionAt=null;}
  /**
   * Point the rig at a cursor position, or stop doing so. `x`/`y` are -1..1, negative being left/up.
   * Values are applied directly rather than eased: the renderer blends each parameter already, and
   * easing here as well would make the gaze lag behind the pointer.
   */
  setLook(x,y,active=true){this.look.active=active===true;this.look.x=active?Math.max(-1,Math.min(1,Number(x)||0)):0;this.look.y=active?Math.max(-1,Math.min(1,Number(y)||0)):0;}
  sample({now,delta,elapsed,state,head,body,blink,work=false,reducedMotion=false}){
    const age=this.attentionAt===null?Infinity:Math.max(0,(now-this.attentionAt)/1000);
    if(age>.9)this.attentionAt=null;
    const tap=age<=.9?curve(age,[[0,0],[.12,-1],[.32,.42],[.7,0],[.9,0]]):0;
    const eye=age<=.4?curve(age,[[0,0],[.09,1],[.16,1],[.35,0],[.4,0]]):0;
    const speaking=state==='speaking',thinking=state==='thinking',listening=state==='listening';
    // Every key the smoothing loop below touches must exist here, because that loop is what stores
    // `this.values[key]`; a key added after it stays undefined and reaches the renderer as null.
    const target={
      yaw:thinking?4+Math.sin(elapsed*.45)*.7:Math.sin(elapsed*.75)*(speaking?7:2),
      pitch:(thinking?-4:listening?3:Math.sin(elapsed*1.1)*2)+tap*12,
      roll:(thinking?-7+Math.sin(elapsed*.35)*.6:Math.sin(elapsed*.65)*(speaking?5:2))+tap*2,
      body:Math.sin(elapsed*.75)*(speaking?3:1)+tap*1.8,
      bodyYaw:0, bodyPitch:0, bodyRoll:0,
      gazeX:thinking?.3+Math.sin(elapsed*.4)*.035:0,
      gazeY:thinking?.18:age<.9?.1:0,
      blink:eye
    };
    // Cursor following replaces the idle sway for the parts it drives, so the rig looks at the
    // pointer instead of drifting. Physics still adds the secondary motion on top.
    if(this.look.active){
      const {x,y}=this.look,T=LOOK_TUNING;
      target.yaw=x*T.headYaw;
      target.pitch=-y*T.headPitch;
      target.roll=x*T.headRoll;
      target.gazeX=x*T.gazeX;
      target.gazeY=-y*T.gazeY;
      target.body=x*T.bodyYaw;
      target.bodyYaw=x*T.bodyYaw;
      target.bodyPitch=-y*T.bodyPitch;
      target.bodyRoll=x*T.bodyRoll;
    }
    if(work){
      const cycle=reducedMotion?0:elapsed;
      target.yaw=1.5+Math.sin(cycle*.55)*.7;
      target.pitch=-8+Math.sin(cycle*.8)*.9;
      target.roll=-2.5+Math.sin(cycle*.4)*.4;
      target.body=Math.sin(cycle*.55)*.55;
      target.bodyYaw=0; target.bodyPitch=0; target.bodyRoll=0;
      target.gazeX=.14+Math.sin(cycle*.4)*.03;
      target.gazeY=-.28;
      target.blink=.16;
    }
    for(const key of Object.keys(target)){
      // The body channels obey the body switch; `body` is the legacy single-channel value the
      // renderer still reads for ParamBodyAngleX.
      const isBody=key==='body'||key==='bodyYaw'||key==='bodyPitch'||key==='bodyRoll';
      const allowed=isBody?body:key==='blink'?blink:head;
      if(!allowed){this.values[key]=0;continue;}
      const tau=key==='blink'?.035:(this.look.active?.02:age<.9?.055:.22);
      this.values[key]+=(target[key]-this.values[key])*(1-Math.exp(-Math.max(0,delta)/tau));
    }
    return this.values;
  }
}
