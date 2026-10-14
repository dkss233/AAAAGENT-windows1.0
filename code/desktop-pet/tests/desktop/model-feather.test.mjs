// Runs synchronously in model-feather-visual.mjs on actual WebGL, with fixed rig pose.
import {ModelFeather} from '../../desktop/model-feather.mjs';
const assert=(value,message)=>{if(!value)throw Error(message)};
const pixels=(gl,w,h)=>{const p=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,p);return p};
const differences=(a,b,start=0)=>{let n=0;for(let i=start;i<a.length;i++)if(a[i]!==b[i])n++;return n};
const rowAlpha=(data,w,row)=>{let max=0;for(let x=0;x<w;x++)max=Math.max(max,data[(row*w+x)*4+3]);return max};
export function runFeatherChecks(rig) {
  const gl=rig.gl,canvas=rig.canvas,original={mode:rig.framing,width:canvas.style.width,height:canvas.style.height};
  const results=[];
  const check=(name,fn)=>results.push({name,...fn()});
  try {
    check('actual model: upper pixels unchanged; progressive transparent bottom',()=>{
      rig.setFraming('half');rig.draw();const f=rig.feather,apply=f.apply;
      f.apply=()=>true;try{rig.draw()}finally{f.apply=apply}
      const raw=pixels(gl,canvas.width,canvas.height);rig.draw();const soft=pixels(gl,canvas.width,canvas.height);
      const band=Math.ceil(f.bandCss*canvas.height/canvas.clientHeight),upperChanged=differences(raw,soft,band*canvas.width*4);
      assert(upperChanged===0,'Upper model pixels changed');assert(differences(raw,soft)>0,'No effect on actual model');
      const rawBottom=rowAlpha(raw,canvas.width,0),bottom=rowAlpha(soft,canvas.width,0);
      assert(rawBottom>0&&bottom===0,'Hard edge was not removed');
      const samples=[0,.25,.5,.75,1].map(r=>({row:Math.min(band-1,Math.floor(band*r)),maxAlpha:rowAlpha(soft,canvas.width,Math.min(band-1,Math.floor(band*r)))}));
      assert(samples[1].maxAlpha>0&&samples[1].maxAlpha<samples[3].maxAlpha,'No graded alpha');
      const allocation=f.allocations,texture=f.texture;
      for(let i=0;i<5;i++)rig.draw();assert(f.allocations===allocation&&f.texture===texture,'Texture reallocated each frame');
      return {canvas:[canvas.width,canvas.height],bandCss:f.bandCss,radiusCss:f.radiusCss,strip:[f.width,f.height],rgbaBytes:f.width*f.height*4,rawBottom,bottom,upperChanged,samples,textureReused:true,vao:f.status};
    });
    check('full pixels unchanged after half; storage released and resize bounded',()=>{
      rig.setFraming('full');rig.draw();const full=pixels(gl,canvas.width,canvas.height);
      rig.setFraming('half');rig.draw();rig.setFraming('full');assert(rig.feather.texture===null,'Half texture retained in full');rig.draw();
      const fullChanged=differences(full,pixels(gl,canvas.width,canvas.height));assert(fullChanged===0,'Full pixels changed after half');
      rig.setFraming('half');rig.draw();const f=rig.feather,texture=f.texture,n=f.allocations,oldBand=f.bandCss,oldHeight=canvas.clientHeight;
      canvas.style.width='720px';canvas.style.height='680px';rig.draw();
      assert(f.texture===texture&&f.allocations===n+1,'Resize does not reuse storage handle');assert(Math.abs(f.bandCss/oldBand-canvas.clientHeight/oldHeight)<1e-6,'Band does not scale with model');
      const measured={canvas:[canvas.width,canvas.height],bandCss:f.bandCss,radiusCss:f.radiusCss,strip:[f.width,f.height],rgbaBytes:f.width*f.height*4};
      rig.draw();assert(f.allocations===n+1,'Repeated large frame reallocates');
      canvas.style.width=original.width;canvas.style.height=original.height;rig.draw();return {fullChanged,textureReleased:true,enlarged:measured};
    });
    check('real blur and GL state restoration with and without VAO',()=>checkIsolatedGL());
    assert(gl.getError()===gl.NO_ERROR,'Model WebGL error');
    return {passed:results.length,failed:0,renderer:gl.getParameter(gl.RENDERER),antialias:gl.getContextAttributes().antialias,results};
  } finally {canvas.style.width=original.width;canvas.style.height=original.height;rig.setFraming(original.mode);rig.draw()}
}
function checkIsolatedGL() {
  const canvas=document.createElement('canvas');canvas.width=128;canvas.height=340;canvas.style.cssText='width:128px;height:340px';document.body.append(canvas);
  const gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false});assert(gl,'No test WebGL');
  const ext=gl.getExtension('OES_vertex_array_object'),resources=[],passes=[];
  const stripes=()=>{gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.colorMask(true,true,true,true);gl.enable(gl.SCISSOR_TEST);for(let x=0;x<canvas.width;x++){gl.scissor(x,0,1,canvas.height);gl.clearColor(x%2,0,1-x%2,1);gl.clear(gl.COLOR_BUFFER_BIT)}gl.disable(gl.SCISSOR_TEST)};
  const snapshot=()=>{
    const keys=['FRAMEBUFFER_BINDING','VIEWPORT','CURRENT_PROGRAM','ARRAY_BUFFER_BINDING','ACTIVE_TEXTURE','TEXTURE_BINDING_2D','SCISSOR_BOX','COLOR_WRITEMASK','BLEND_SRC_RGB','BLEND_DST_RGB','BLEND_SRC_ALPHA','BLEND_DST_ALPHA','BLEND_EQUATION_RGB','BLEND_EQUATION_ALPHA'];
    const s=keys.map(k=>[k,gl.getParameter(gl[k])]);
    for(const k of ['BLEND','SCISSOR_TEST','CULL_FACE','DEPTH_TEST','STENCIL_TEST','DITHER'])s.push([k,gl.isEnabled(gl[k])]);
    for(const k of ['BUFFER_BINDING','ENABLED','SIZE','TYPE','NORMALIZED','STRIDE'])s.push(['attrib'+k,gl.getVertexAttrib(0,gl['VERTEX_ATTRIB_ARRAY_'+k])]);
    s.push(['offset',gl.getVertexAttribOffset(0,gl.VERTEX_ATTRIB_ARRAY_POINTER)]);if(ext)s.push(['vao',gl.getParameter(ext.VERTEX_ARRAY_BINDING_OES)]);
    const active=gl.getParameter(gl.ACTIVE_TEXTURE);gl.activeTexture(gl.TEXTURE0);s.push(['texture0',gl.getParameter(gl.TEXTURE_BINDING_2D)]);gl.activeTexture(active);return s;
  };
  const same=(before,after)=>before.every(([key,a],i)=>{const b=after[i][1];return ArrayBuffer.isView(a)||Array.isArray(a)?Array.from(a).every((x,j)=>x===b[j]):a===b});
  try {
    const modes=[];
    for(const withoutVAO of [false,true]) {
      if(ext)ext.bindVertexArrayOES(null);
      // Give the fallback a real pre-existing attribute pointer to preserve.
      const buffer=gl.createBuffer();resources.push(['buffer',buffer]);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(32),gl.STATIC_DRAW);gl.vertexAttribPointer(0,3,gl.FLOAT,false,16,4);gl.disableVertexAttribArray(0);
      const context=withoutVAO?new Proxy(gl,{get:(target,key)=>key==='getExtension'?name=>name==='OES_vertex_array_object'?null:target.getExtension(name):typeof target[key]==='function'?target[key].bind(target):target[key]}):gl;
      const f=new ModelFeather(context);passes.push(f);stripes();f.apply(canvas);let data=pixels(gl,canvas.width,canvas.height);
      const at=(12*canvas.width+64)*4;assert(data[at]>0&&data[at+2]>0&&data[at+1]===0,'Effect is opacity only or adds a colored halo');assert(data[at]<=data[at+3]&&data[at+2]<=data[at+3],'Non-premultiplied output');
      const mixed=Array.from(data.slice(at,at+4));
      const vao=ext?.createVertexArrayOES();if(vao){resources.push(['vao',vao]);ext.bindVertexArrayOES(vao)}
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.vertexAttribPointer(0,3,gl.FLOAT,true,16,4);gl.enableVertexAttribArray(0);
      const texture=gl.createTexture();resources.push(['texture',texture]);gl.activeTexture(gl.TEXTURE3);gl.bindTexture(gl.TEXTURE_2D,texture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,4,4,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      const framebuffer=gl.createFramebuffer();resources.push(['framebuffer',framebuffer]);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
      gl.viewport(2,3,17,19);gl.scissor(3,4,9,11);gl.enable(gl.BLEND);gl.enable(gl.SCISSOR_TEST);gl.enable(gl.CULL_FACE);gl.disable(gl.DITHER);gl.colorMask(false,true,false,true);
      const before=snapshot();f.apply(canvas);const after=snapshot();assert(same(before,after),'GL state changed '+withoutVAO);assert(gl.getError()===gl.NO_ERROR,'Test GL error '+withoutVAO);
      modes.push({mode:f.status,mixedPixel:mixed,stateRestored:true});
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.colorMask(true,true,true,true);gl.disable(gl.SCISSOR_TEST);
    }
    // No extension and no prior pointer: WebGL1 cannot restore a null pointer.
    // The effect must decline without changing GL state or throwing.
    if(ext) {
      const empty=ext.createVertexArrayOES();resources.push(['vao',empty]);ext.bindVertexArrayOES(empty);
      const context=new Proxy(gl,{get:(target,key)=>key==='getExtension'?name=>name==='OES_vertex_array_object'?null:target.getExtension(name):typeof target[key]==='function'?target[key].bind(target):target[key]});
      const f=new ModelFeather(context);passes.push(f);const before=snapshot();
      assert(f.apply(canvas)===false&&f.status==='unavailable-attribute-state','Unsupported attribute state not handled');assert(same(before,snapshot()),'Unsupported path altered GL');
      modes.push({mode:f.status,stateRestored:true,threw:false});
    }
    return {modes};
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);if(ext)ext.bindVertexArrayOES(null);
    for(const f of passes)f.dispose();
    for(const [kind,r] of resources){if(kind==='vao')ext.deleteVertexArrayOES(r);else gl['delete'+kind[0].toUpperCase()+kind.slice(1)](r)}
    gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.remove();
  }
}
