import {JellyfishRenderer} from '../cubism-renderer.mjs';
window.workEvidence={frames:[],boundary:'Actual desktop entry and supplied Cubism/WebGL; synthetic bridge and playback events; no microphone/camera/audio device/model calls.'};
const update=JellyfishRenderer.prototype.updateView;
JellyfishRenderer.prototype.updateView=function(...args){
 update.apply(this,args);window.testRig=this;
 if(!this.ready||workEvidence.frames.length>=5000)return;
 const gl=this.gl,pixels=new Uint8Array(4);gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
 workEvidence.frames.push({at:performance.now(),phase:window.testPhase??'load',state:args[0].state,work:args[2],framing:this.framing,pitch:this.get('ParamAngleX3'),gaze:this.get('ParamEyeBallY'),eye:this.get('ParamEyeLOpen'),mouth:this.get('ParamMouthOpenY'),body:this.get('ParamBodyAngleX'),face:this.faceKey,cornerAlpha:pixels[3]});
};
await import('../main.mjs');
window.testReady=true;
