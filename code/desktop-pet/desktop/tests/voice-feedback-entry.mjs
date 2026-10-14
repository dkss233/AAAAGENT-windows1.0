import {JellyfishRenderer} from '../cubism-renderer.mjs';
import catalog from '../assets/jellyfish/presets.json';
Math.random=()=>.3;
const canvas=document.getElementById('model'),rig=new JellyfishRenderer(canvas,()=>{},{assetBase:'/assets/jellyfish/',shaderBase:'/vendor/cubism/Framework/Shaders/WebGL/'});
await rig.load();const ids=catalog.items.filter(i=>i.availability==='automatic').map(i=>i.id);let revision=1;
rig.setAutomaticPolicy({modelId:catalog.modelId,revision,enabledIds:ids});
const view={state:'idle',mouth:0,expression:{emotion:'neutral',intensity:0,delivery:'',gesture:null}};
window.evidence={samples:[],modelFingerprint:catalog.modelFingerprint,parameters:[],errors:[],boundary:'real Cubism/WebGL, synthetic turn/playback amplitude, no audio/device/backend'};
const p=rig._model.getModel().parameters;for(let i=0;i<p.count;i++)if(/AngleX[234]$|BodyAngleX$|EyeBall|Eye[LR]Open/.test(p.ids[i]))evidence.parameters.push({id:p.ids[i],min:p.minimumValues[i],max:p.maximumValues[i],default:p.defaultValues[i]});
let stopped=false,frame;
function tick(){if(stopped)return;rig.updateView(view);const gl=rig.gl,pixels=new Uint8Array(4);gl.readPixels(canvas.width/2,canvas.height/2,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);evidence.samples.push({at:performance.now(),state:view.state,framing:rig.framing,pitch:rig.get('ParamAngleX3'),roll:rig.get('ParamAngleX4'),gaze:rig.get('ParamEyeBallX'),eye:rig.get('ParamEyeLOpen'),mouth:rig.get('ParamMouthOpenY'),body:rig.get('ParamBodyAngleX'),alpha:pixels[3]});frame=requestAnimationFrame(tick)}
window.action=(name)=>{
 document.getElementById('state').textContent=name;
 if(name==='attention'){rig.reset();rig.beginAttention();view.state='listening';view.mouth=0;view.expression={emotion:'neutral',intensity:0,delivery:'',gesture:null};}
 else if(name==='speaking'){rig.reset();view.state='speaking';view.mouth=.25;view.expression={emotion:'warm',intensity:.6,delivery:'',gesture:'comfort'};}
 else if(name==='disabled'){rig.reset();rig.setAutomaticPolicy({modelId:catalog.modelId,revision:++revision,enabledIds:[]});rig.beginAttention();view.state='thinking';view.mouth=0;}
 else {rig.reset();view.state=name;view.mouth=0;view.expression={emotion:'neutral',intensity:0,delivery:'',gesture:null};}
};
window.framing=mode=>{rig.setAutomaticPolicy({modelId:catalog.modelId,revision:++revision,enabledIds:ids});rig.setFraming(mode);window.action('idle');};
window.closePreview=()=>{stopped=true;cancelAnimationFrame(frame);rig.dispose()};tick();window.ready=true;
