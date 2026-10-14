// Local face rendering over the original transparent video. No new character pixels.
export function createFaceEffects({effect,caption,shadow}) {
  const sample=document.createElement('canvas');sample.width=640;sample.height=360;
  const input=sample.getContext('2d',{willReadFrequently:true});
  const matte=document.createElement('canvas');matte.width=640;matte.height=360;
  const matteContext=matte.getContext('2d');
  let dark=false,raf=0,lastFrame=-1,lastVideo=null,face=null,lastUpdate=0;
  const telemetry={enabled:false,faceBox:null,shadedPixels:0,maxAlpha:0,lowerFaceAlpha:0,shadowStyle:'soft-upper-face-gradient',frameCount:0,sampleTime:0,anchor:null,iconSize:null};
  const warmSkin=(r,g,b,a)=>a>180&&r>165&&g>100&&b>80&&r-g>8&&r-g<90&&g-b>2&&g-b<60;
  function inspect(video){
    input.clearRect(0,0,640,360);input.drawImage(video,0,0,640,360);
    const data=input.getImageData(0,0,640,360).data;
    let bx0=640,by0=360,bx1=0,by1=0;
    for(let y=0;y<360;y+=2)for(let x=0;x<640;x+=2){if(data[(y*640+x)*4+3]>120){bx0=Math.min(bx0,x);bx1=Math.max(bx1,x);by0=Math.min(by0,y);by1=Math.max(by1,y);}}
    const top=Math.max(0,by0+Math.round((by1-by0)*.08)),bottom=Math.min(359,by0+Math.round((by1-by0)*.66));
    const skin=new Uint8Array(640*360);
    for(let y=top;y<=bottom;y++)for(let x=bx0;x<=bx1;x++){const i=y*640+x,p=i*4;if(warmSkin(data[p],data[p+1],data[p+2],data[p+3]))skin[i]=1;}
    const visited=skin.slice();let best=null;const stack=[];
    for(let y=top;y<=bottom;y++)for(let x=bx0;x<=bx1;x++){
      const start=y*640+x;if(!visited[start])continue;visited[start]=0;stack.push(start);
      let count=0,x0=640,y0=360,x1=0,y1=0;
      while(stack.length){const i=stack.pop(),px=i%640,py=Math.floor(i/640);count++;x0=Math.min(x0,px);x1=Math.max(x1,px);y0=Math.min(y0,py);y1=Math.max(y1,py);
        for(const next of [i-1,i+1,i-640,i+640])if(next>=0&&next<visited.length&&visited[next]){visited[next]=0;stack.push(next);}}
      if(!best||count>best.count)best={count,x0,y0,x1,y1};
    }
    if(!best||best.count<90)return null;
    const region={x0:Math.max(0,best.x0-10),x1:Math.min(639,best.x1+10),y0:Math.max(top,best.y0-48),y1:Math.min(bottom,best.y1+4)};
    const bounds={x0:640,y0:360,x1:0,y1:0};
    for(let y=region.y0;y<=region.y1;y++)for(let x=region.x0;x<=region.x1;x++)if(skin[y*640+x]){bounds.x0=Math.min(bounds.x0,x);bounds.x1=Math.max(bounds.x1,x);bounds.y0=Math.min(bounds.y0,y);bounds.y1=Math.max(bounds.y1,y);}
    return {data,skin,bounds};
  }
  function draw(result){
    const {bounds:b,data}=result,mask=matteContext.createImageData(640,360);
    let shaded=0,maxAlpha=0,lowerFaceAlpha=0;
    const height=Math.max(1,b.y1-b.y0);
    const mid=(b.x0+b.x1)/2,halfWidth=Math.max(1,(b.x1-b.x0)*.5);
    const smooth=(lo,hi,value)=>{const t=Math.max(0,Math.min(1,(value-lo)/(hi-lo)));return t*t*(3-2*t);};
    for(let y=b.y0;y<=b.y1;y++)for(let x=b.x0;x<=b.x1;x++){
      const i=y*640+x,p=i*4;
      const t=(y-b.y0)/height;
      // Skin components locate the face only. A continuous feathered haze replaces
      // the old binary pixel paint; it ends above the lower half of the face.
      const vertical=smooth(-.06,.12,t)*(1-smooth(.12,.49,t));
      const lateral=1-smooth(.62,1.02,Math.abs((x-mid)/halfWidth));
      // Smoothly preserve cool irises/hair and dark ink, without punched-out holes.
      const cool=smooth(4,34,data[p+2]-data[p]);
      const light=smooth(55,145,Math.max(data[p],data[p+1],data[p+2]));
      const strength=.26*vertical*lateral*(1-.94*cool)*light*(data[p+3]/255);
      const alpha=Math.round(strength*255);
      if(!alpha)continue;
      mask.data[p]=60;mask.data[p+1]=58;mask.data[p+2]=88;mask.data[p+3]=alpha;
      shaded++;maxAlpha=Math.max(maxAlpha,alpha);if(t>=.5)lowerFaceAlpha=Math.max(lowerFaceAlpha,alpha);
    }
    matteContext.putImageData(mask,0,0);
    shadow.width=640;shadow.height=360;shadow.getContext('2d').drawImage(matte,0,0);
    telemetry.shadedPixels=shaded;telemetry.maxAlpha=maxAlpha;telemetry.lowerFaceAlpha=lowerFaceAlpha;
  }
  function position(video,b){
    const rect=video.getBoundingClientRect(),right=document.querySelector('.dsh-pet-root')?.dataset.facing==='right';
    const sx=rect.width/640,sy=rect.height/360;
    const faceLeft=rect.left+(right?640-b.x1:b.x0)*sx;
    const faceRight=rect.left+(right?640-b.x0:b.x1)*sx;
    const faceTop=rect.top+b.y0*sy;
    const faceWidth=faceRight-faceLeft;
    const icon=effect.dataset.icon;
    const base=Math.max(62,Math.min(86,faceWidth*.83));
    const isMeme=icon==='meme';
    const width=isMeme?Math.min(210,innerWidth*.29):icon==='questions'?base*1.45:base,height=isMeme?width/(Number(effect.dataset.aspect)||1):base;
    // Anchor beside the visible face rather than the padded video/hit rectangle.
    let x=isMeme?(right?faceLeft-width-5:faceRight+5):right?faceLeft-width+faceWidth*.16:faceRight-faceWidth*.16;
    x=Math.max(6,Math.min(innerWidth-width-6,x));
    const y=Math.max(8,isMeme?faceTop-28:faceTop-height*.62);
    effect.style.left=x+'px';effect.style.top=y+'px';effect.style.width=width+'px';effect.style.height=height+'px';
    caption.style.left=(faceLeft+faceWidth/2)+'px';caption.style.top=Math.min(innerHeight-22,rect.bottom-10)+'px';
    shadow.style.left=rect.left+'px';shadow.style.top=rect.top+'px';shadow.style.width=rect.width+'px';shadow.style.height=rect.height+'px';shadow.style.transform=right?'scaleX(-1)':'';
    telemetry.anchor={faceLeft,faceRight,faceTop,iconLeft:x,iconTop:y,facing:right?'right':'left'};telemetry.iconSize={width,height};
  }
  function tick(now){
    const active=dark||!!effect.dataset.icon;
    const video=document.querySelector('.dsh-pet-video.is-front');
    if(active&&video&&video.readyState>=2){
      if((video!==lastVideo||video.currentTime!==lastFrame)&&now-lastUpdate>32){
        const result=inspect(video);lastFrame=video.currentTime;lastVideo=video;lastUpdate=now;
        if(result){telemetry.frameCount++;telemetry.sampleTime=video.currentTime;face=result.bounds;telemetry.faceBox={...face};if(dark)draw(result);}
      }
      if(face)position(video,face);
      shadow.hidden=!dark||!face;
    }else shadow.hidden=true;
    telemetry.enabled=dark&&!shadow.hidden;
    raf=requestAnimationFrame(tick);
  }
  raf=requestAnimationFrame(tick);
  return {setDark(value){dark=value;telemetry.enabled=value;if(!value){shadow.hidden=true;telemetry.shadedPixels=0;telemetry.maxAlpha=0;telemetry.lowerFaceAlpha=0;}},place(){const video=document.querySelector('.dsh-pet-video.is-front');if(video&&face)position(video,face);},stats(){return structuredClone(telemetry);},dispose(){cancelAnimationFrame(raf);}};
}
