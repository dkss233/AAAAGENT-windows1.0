import {createPresentationPreview} from '../presentation-preview.mjs';
import catalog from '../assets/jellyfish/presets.json';
const {JellyfishRenderer}=await import('../cubism-renderer.mjs');
window.evidence={draws:0,blank:0,samples:[],statuses:[],rigs:0,maxRAF:0,resources:{},contexts:0};
Math.random=()=>.3;
const pending=new Set(),request=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window);
window.requestAnimationFrame=fn=>{if(!/^tick\d*$/.test(fn.name))return request(fn);let id;id=request(at=>{pending.delete(id);fn(at)});pending.add(id);evidence.maxRAF=Math.max(evidence.maxRAF,pending.size);return id};
window.cancelAnimationFrame=id=>{pending.delete(id);cancel(id)};window.pendingFrames=()=>pending.size;
const canvas=document.getElementById('preview'),getContext=canvas.getContext.bind(canvas);let glSeen;
const resources=Object.fromEntries(['Texture','Buffer','Program','Framebuffer','Renderbuffer'].map(n=>[n,new Set()]));
canvas.getContext=(kind,options)=>{const gl=getContext(kind,options);if(kind==='webgl'&&gl&&gl!==glSeen){glSeen=gl;evidence.contexts++;for(const [type,set] of Object.entries(resources)){const create=gl['create'+type].bind(gl),remove=gl['delete'+type].bind(gl);gl['create'+type]=(...args)=>{const item=create(...args);if(item)set.add(item);return item};gl['delete'+type]=item=>{set.delete(item);return remove(item)}}}return gl};
window.liveResources=()=>Object.fromEntries(Object.entries(resources).map(([k,s])=>[k,s.size]));
let lastSample=0,buffer;
 const draw=JellyfishRenderer.prototype.draw;
JellyfishRenderer.prototype.draw=function(){
 draw.call(this);evidence.draws++;
 if(performance.now()-lastSample>90){lastSample=performance.now();const size=this.canvas.width*this.canvas.height*4;if(buffer?.length!==size)buffer=new Uint8Array(size);this.gl.readPixels(0,0,this.canvas.width,this.canvas.height,this.gl.RGBA,this.gl.UNSIGNED_BYTE,buffer);let alpha=0,hash=2166136261;for(let i=3;i<buffer.length;i+=64){alpha+=buffer[i];hash=Math.imul(hash^buffer[i],16777619)}if(!alpha)evidence.blank++;const sample={framing:this.framing,id:this.previewSelection?.id??null,alpha,hash:hash>>>0,mouth:this.get('ParamMouthOpenY'),star:this.get('fase53'),heart:this.get('fase72'),pray:this.get('fase92'),ears:this.get('fase67'),watermark:this.get('fase80'),breath:this.get('ParamBreath'),head:this.get('ParamAngleX2'),eye:this.get('ParamEyeLOpen')};evidence.samples.push(sample);evidence.last=sample;}
};
const load=JellyfishRenderer.prototype.load;JellyfishRenderer.prototype.load=async function(){evidence.rigs++;return load.call(this)};
for(const item of catalog.items){const option=document.createElement('option');option.value=item.id;option.textContent=item.label;option.disabled=!item.previewable;document.getElementById('preset').append(option)}
const options={canvas,onStatus:s=>{evidence.statuses.push(s);document.getElementById('status').textContent=s.message},assetBase:'/assets/jellyfish/',shaderBase:'/vendor/cubism/Framework/Shaders/WebGL/'};
window.api=await createPresentationPreview(options);window.sameInstance=await createPresentationPreview(options)===api;window.catalog=catalog;
document.getElementById('play').onclick=()=>api.select(document.getElementById('preset').value);
document.getElementById('stop').onclick=()=>api.stop();document.getElementById('restore').onclick=()=>api.restore();document.getElementById('dispose').onclick=()=>api.dispose();
window.reopen=async()=>{window.api=await createPresentationPreview(options)};
window.ready=true;
