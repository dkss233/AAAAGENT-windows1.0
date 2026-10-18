import {el,button,badge,notice} from './dom.mjs';
const categoryNames={all:'全部',expression:'表情',pose:'姿势',appearance:'外观',idle:'待机'};
let coreReady;
function loadCore(){if(globalThis.Live2DCubismCore)return Promise.resolve();return coreReady??=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/presentation-runtime/core.js';script.onload=resolve;script.onerror=()=>{coreReady=null;script.remove();reject(Error('模型运行文件加载失败，请刷新重试。'));};document.head.append(script);});}
const sourceNames={'model-expression':'模型预设','model-motion':'模型动画',procedural:'程序动作'};
export function createPresentationView(client,render) {
  const canvas=el('canvas',{class:'preset-canvas','aria-label':'当前模型真实预览'});
  const stage=el('div',{class:'preset-stage'},canvas), status=el('p',{class:'preset-preview-status',role:'status'},'正在准备模型…');
  let data=null,query='',category='all',selected=null,engine=null,loading=null,active=false,epoch=0,saving=false,error='',message='';
  // Swapping the rig is a task, not a request: the backend opens a native folder dialog and then runs
  // the installer, which rebuilds the renderer assets and re-pins the fingerprint. This page polls.
  let swapping=false,timer=null;
  async function swapModel(){
    if(swapping)return;
    swapping=true;error='';message='已打开文件夹选择窗口，请在弹出的窗口里选好模型文件夹。';
    render();
    try{
      let state=await client.request('/api/presentation/model',{method:'POST',body:{}});
      // The dialog waits for the operator, so poll until the backend reports it settled.
      const deadline=Date.now()+30*60*1000;
      while(state?.running&&Date.now()<deadline){
        await new Promise(resolve=>{timer=setTimeout(resolve,2000);});
        state=await client.request('/api/presentation/model');
      }
      if(state?.running){message='更换模型仍在进行，可以稍后回来查看结果。';}
      else if(state?.cancelled){message='已取消，模型没有改动。';}
      else if(state?.completed){message='模型已更换。请退出并重新启动桌宠后生效。';}
      else{message='';error=state?.detail??'更换模型未完成，请查看 .local\\model-install.log。';}
    }catch(e){message='';error=e?.status===404?'当前版本不支持在控制台更换模型。':'更换模型未完成：'+(e?.message??'未知原因');}
    finally{if(timer){clearTimeout(timer);timer=null;}swapping=false;render();}
  }
  // Preview scale. The renderer clamps it to 0.2 – 8; 1 is the framing preset's own baseline.
  let previewZoom=1;
  const ZOOM_MIN=0.2, ZOOM_MAX=8;
  const clampZoom=value=>Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,value));
  function applyZoom(value){
    previewZoom=clampZoom(Number.isFinite(value)?value:previewZoom);
    // The engine arrives asynchronously; a zoom set before that is applied on readiness below.
    engine?.setZoom?.(previewZoom);
    const readout=document.getElementById('preset-zoom-value');
    if(readout)readout.textContent=Math.round(previewZoom*100)+'%';
    return previewZoom;
  }
  const resize=new ResizeObserver(()=>engine?.resize());resize.observe(stage);
  async function ensureEngine(){
    if(engine)return engine;if(loading)return loading;const ticket=epoch;
    loading=loadCore().then(()=>import('./presentation-preview.js')).then(m=>m.createPresentationPreview({canvas,onStatus:value=>{
      if(ticket!==epoch)return;const text=typeof value==='string'?value:value?.message;if(text)status.textContent=text;
    },assetBase:new URL('/presentation-assets/',location.href).href,shaderBase:new URL('/presentation-shaders/',location.href).href})).then(value=>{
      if(ticket!==epoch||!active){value.dispose();return null;}engine=value;status.textContent='模型已就绪，选择一项开始预览。';applyZoom(previewZoom);render();return value;
    }).catch(e=>{if(ticket===epoch){status.textContent='模型暂时无法预览';error=e.message;render();}return null;}).finally(()=>{if(ticket===epoch)loading=null;});
    return loading;
  }
  async function refresh(){try{data=await client.request('/api/presentation');error='';render();}catch(e){error=e.message;render();}}
  async function select(preset){if(!preset.previewable)return;const ticket=epoch;error='';const value=await ensureEngine();if(!value||ticket!==epoch||!active)return;
    try{await value.select(preset.id);if(ticket!==epoch||!active)return;selected=preset.id;status.textContent='正在预览：'+preset.label;render();}catch(e){error=e.message;render();}}
  // Hiding holds a preset's parameters at the value its own expression would set, which is exactly
  // what activating that expression does. One write is not enough: the render loop and reset()
  // restore parameters every frame, so the renderer re-applies this continuously.
  async function setHidden(p,on){if(saving||!data)return;saving=true;error='';message='';render();
    const next=new Set(data.policy.hiddenIds??[]);
    if(on)next.add(p.id);else next.delete(p.id);
    const ids=new Set(data.policy.enabledIds);const emo={...(data.policy.emotions??{})};
    if(on){ids.delete(p.id);for(const [emotion,id] of Object.entries(emo))if(id===p.id)delete emo[emotion];}
    const affected=(p.parameters??[]).join('、');
    try{data=await client.request('/api/presentation',{method:'PUT',body:{modelId:data.catalog.modelId,expectedRevision:data.policy.revision,enabledIds:[...ids],emotions:emo,hiddenIds:[...next]}});
      message=on?`已持续启用：${p.label}${affected?'（'+affected+' 会一直保持该表情的效果）':''}。`:`已停止持续启用：${p.label}。`;}
    catch(e){error=e.message;if(e.status===409)await refresh();}finally{saving=false;render();}}
  function hideToggle(p){
    const hidden=(data?.policy?.hiddenIds??[]).includes(p.id);
    const affected=(p.parameters??[]).join('、');
    return el('div',{class:'preset-hide'},el('label',{class:'preset-toggle',title:hidden?'取消勾选即不再持续启用':'勾选后一直启用本表情，桌宠上就会保持它的效果'},
      el('input',{type:'checkbox',checked:hidden,disabled:saving,id:'hide-'+p.id,'aria-label':p.label+' 是否持续启用',onChange:e=>void setHidden(p,e.target.checked)}),
      el('span',{},'是否持续启用该表情'),
      affected&&el('small',{class:'preset-hide-params'},hidden?`持续启用中（${affected}）`:`影响 ${affected}`)));
  }
  function stop(restore=false){if(restore)engine?.restore();else engine?.stop();selected=null;status.textContent=restore?'已恢复预览模型的默认外观。':'预览已停止。';render();}
  /** Apply a full mapping. `previous` is the emotion this row held, cleared when the row moves on. */
  async function saveMapping(next,success,previous){if(saving||!data)return;saving=true;error='';message='';render();
    const ids=new Set(data.policy.enabledIds);
    for(const id of new Set(Object.values(next)))ids.add(id);
    for(const id of Object.values(data.policy.emotions??{}))if(id&&!Object.values(next).includes(id))ids.delete(id);
    try{data=await client.request('/api/presentation',{method:'PUT',body:{modelId:data.catalog.modelId,expectedRevision:data.policy.revision,enabledIds:[...ids],emotions:next,hiddenIds:data.policy.hiddenIds??[]}});
      message=success;}
    catch(e){error=e.message;if(e.status===409)await refresh();}finally{saving=false;render();}}
  /** Pair one expression with one emotion. Taking an emotion removes it from its previous owner. */
  // Pairs are keyed by expression id while pending, so one map serves both editing orders.
  function setPair(emotion,expressionId,previous){
    if(!data)return;
    const wasPending=[...pendingPairs.entries()].find(([,freed])=>freed===previous);
    if(emotion&&!expressionId){
      // Only an emotion was chosen: it belongs to the row still waiting for one.
      if(wasPending){expressionId=wasPending[0];}
      else if(previous){expressionId=(data.policy.emotions??{})[previous];} // switching this row's emotion
      if(!expressionId){error='请先在左边选择表情，再选择情绪。';render();return;}}
    else if(expressionId&&!emotion){
      if(previous)emotion=previous;                 // this row already owns an emotion: move it over
      else if(wasPending)emotion=wasPending[1];     // a pending row being filled in
      else {pendingPairs.set(expressionId,'');render();return;} // brand-new row: wait for the emotion
    }
    // The pending marker is keyed by whichever expression the row used before this edit.
    for(const id of [...pendingPairs.keys()]){
      if(id===expressionId||id===wasPending?.[0]||pendingPairs.get(id)===previous)pendingPairs.delete(id);
    }
    if(!emotion&&previous){const next={...(data.policy.emotions??{})};delete next[previous];
      void saveMapping(next,`已解除 ${emotionLabels[previous]??previous} 的配对。`,previous);return;}
    const item=data.catalog.items.find(i=>i.id===expressionId);
    const next={...(data.policy.emotions??{})};
    for(const [key,id]of Object.entries(next))if(id===expressionId)delete next[key];
    if(previous&&previous!==emotion)delete next[previous];
    next[emotion]=expressionId;
    const owner=data.catalog.items.find(i=>i.id===(data.policy.emotions??{})[emotion]);
    const moved=owner&&owner.id!==expressionId?`（已从「${owner.label}」移过来）`:'';
    void saveMapping(next,`已保存：${item?.label??expressionId} → ${emotionLabels[emotion]??emotion}${moved}`,previous);}
  // Emotion assignment as a single-select per expression: pick the emotion this expression should
  // answer to. Choosing an emotion takes it away from whichever expression held it before.
  const emotionLabels={happy:'开心',sad:'悲伤',warm:'温柔',angry:'生气',surprised:'惊讶'};
  // expressionId → the emotion that row held, for a row whose expression is chosen but emotion is not.
  const pendingPairs=new Map();
  const assignable=p=>p.category==='expression'&&!!p.expressionName;
  async function setEmotions(p,values){
    if(!data||!assignable(p))return;
    const next={...(data.policy.emotions??{})};
    for(const [emotion,id]of Object.entries(next))if(id===p.id)delete next[emotion];
    const chosen=values.filter(v=>v in emotionLabels);
    for(const emotion of chosen)next[emotion]=p.id;
    const detail=chosen.length?[...chosen].map(e=>'「'+(emotionLabels[e]??e)+'」').join('、'):'不用于任何情绪';
    await saveMapping(next,`已保存：${p.label} ${chosen.length?'用于 '+detail:detail}。`);}
  function emotionPicker(p){
    if(!assignable(p))return el('div');
    const own=data?.policy?.emotions??{};
    const mine=Object.entries(own).filter(([,id])=>id===p.id).map(([emotion])=>emotion);
    const select=el('select',{class:'preset-emotion-select',disabled:saving,id:'emotion-select-'+p.id,
      'aria-label':p.label+' 对应情绪',onChange:e=>void setEmotions(p,[e.target.value].filter(Boolean))},
      el('option',{value:''},'不用于任何情绪'),
      ...Object.entries(emotionLabels).map(([emotion,label])=>{
        const takenBy=own[emotion],owner=takenBy&&takenBy!==p.id?data?.catalog?.items?.find(i=>i.id===takenBy):null;
        return el('option',{value:emotion,selected:mine.length===1&&mine[0]===emotion},
          label+(owner?`（现由「${owner.label}」使用，选它即改由本表情）`:''));
      }));
    return el('div',{class:'preset-emotions'},el('label',{class:'preset-emotions-label',for:select.id},'对应情绪'),select);
  }
  async function toggle(preset,enabled){if(saving||!data||!(preset.availability==='automatic'||preset.expressionName))return;saving=true;error='';message='';render();
    const ids=new Set(data.policy.enabledIds);if(enabled)ids.add(preset.id);else ids.delete(preset.id);
    try{data=await client.request('/api/presentation',{method:'PUT',body:{modelId:data.catalog.modelId,expectedRevision:data.policy.revision,enabledIds:[...ids],hiddenIds:data.policy.hiddenIds??[]}});message=`已保存：${preset.label}${enabled?'允许':'不再'}自动使用。`;}
    catch(e){error=e.message;if(e.status===409)await refresh();}finally{saving=false;render();}}
  function activate(){if(active)return;active=true;epoch++;void refresh();queueMicrotask(()=>void ensureEngine());}
  function deactivate(){if(!active)return;active=false;epoch++;engine?.dispose();engine=null;loading=null;selected=null;}
  function view(){
    activate();const items=data?.catalog.items??[],enabled=new Set(data?.policy.enabledIds??[]),hidden=new Set(data?.policy?.hiddenIds??[]);
    // Hidden presets stay listed: the checkbox is the control, not a list filter.
    const filtered=items.filter(p=>(category==='all'||p.category===category)&&(!query||p.label.toLowerCase().includes(query.toLowerCase())));
    const current=items.find(p=>p.id===selected);
    const stats=el('div',{class:'preset-stats'},[[items.length,'现有预设'],[items.filter(p=>p.previewable).length,'可手动预览'],[enabled.size,'允许自动使用'],[hidden.size,'持续启用']].map(([n,label])=>el('div',{},el('strong',{},n),el('span',{},label))));
    const preview=el('section',{class:'card preset-preview'},el('div',{class:'section-head'},el('div',{},el('h2',{},'AAAAGENT · 预览'),el('p',{class:'subtle'},current?current.label:'选择右侧预设，看看实际表现')),badge('独立预览','info')),stage,
      // Zoom control: the preview canvas keeps a fixed framing, so a large rig can only be inspected
      // by scaling it. The value is per session and does not touch the pet window's own zoom.
      el('div',{class:'preset-zoom'},el('label',{for:'preset-zoom-range'},'缩放'),
        el('button',{type:'button',class:'preset-zoom-step','aria-label':'缩小',onClick:()=>{applyZoom(previewZoom/1.25);const r=document.getElementById('preset-zoom-range');if(r)r.value=String(previewZoom);}},'−'),
        el('input',{id:'preset-zoom-range',type:'range',min:String(ZOOM_MIN),max:String(ZOOM_MAX),step:'0.05',value:String(previewZoom),
          'aria-label':'预览缩放',onInput:e=>applyZoom(Number(e.target.value)),onChange:e=>applyZoom(Number(e.target.value))}),
        el('button',{type:'button',class:'preset-zoom-step','aria-label':'放大',onClick:()=>{applyZoom(previewZoom*1.25);const r=document.getElementById('preset-zoom-range');if(r)r.value=String(previewZoom);}},'+'),
        el('output',{id:'preset-zoom-value',for:'preset-zoom-range'},Math.round(previewZoom*100)+'%'),
        button('重置 100%',()=>{applyZoom(1);const r=document.getElementById('preset-zoom-range');if(r)r.value='1';},{class:'preset-zoom-reset'})),
      status,
      el('div',{class:'actions'},button('停止预览',()=>stop(),{disabled:!engine||!selected}),button('更换模型',swapModel,{id:'model-swap',disabled:swapping}),button('恢复默认',()=>stop(true),{disabled:!engine})),
      el('p',{class:'subtle preset-hint'},'预览不影响聊天，也不会播放声音。缩放只作用于这个预览窗口。'));
    const search=el('input',{id:'preset-search',type:'search',placeholder:'搜索表情或动作',value:query,'aria-label':'搜索表情或动作',onInput:e=>{query=e.target.value;render();}});
    const filters=el('div',{class:'preset-filters',role:'group','aria-label':'预设分类'},Object.entries(categoryNames).map(([id,label])=>button(label,()=>{category=id;render();},{'aria-pressed':category===id,class:category===id?'selected':''})));
    const own=data?.policy?.emotions??{};
    // Pairing editor: two dropdowns per row — pick an expression, pick the emotion it answers to.
    // One emotion maps to exactly one expression, so a pairing can never overlap.
    const expressionOptions=items.filter(p=>assignable(p)&&!hidden.has(p.id));
    const pairs=Object.entries(own).map(([emotion,id])=>({emotion,id}));
    // Rows whose expression is chosen but whose emotion is still pending render as a draft entry.
    for(const [id,emotion]of pendingPairs)if(!pairs.some(p=>p.id===id))pairs.push({emotion,id,pending:!emotion});
    const maxRows=Math.max(Object.keys(emotionLabels).length,pairs.length);
    const pairRows=[];
    for(let i=0;i<maxRows;i++){
      const row=pairs[i];
      const freeEmotions=Object.keys(emotionLabels).filter(e=>!own[e]||own[e]===row?.id);
      const expressionSelect=el('select',{class:'pair-select',disabled:saving,id:'pair-expression-'+i,'aria-label':'第'+(i+1)+'行 表情',
        onChange:e=>void setPair('',e.target.value,row?.emotion??'')},
        el('option',{value:''},'选择表情…'),
        ...expressionOptions.map(p=>el('option',{value:p.id,selected:row?.id===p.id},p.label)));
      const emotionSelect=el('select',{class:'pair-select'+(row?.pending?' is-pending':''),disabled:saving,id:'pair-emotion-'+i,'aria-label':'第'+(i+1)+'行 情绪',
        onChange:e=>void setPair(e.target.value,row?.pending?row.id:'',row?.emotion??'')},
        el('option',{value:''},row?.pending?'请选择情绪…':'选择情绪…'),
        ...freeEmotions.map(emotion=>el('option',{value:emotion,selected:row?.emotion===emotion},emotionLabels[emotion])));
      pairRows.push(el('div',{class:'pair-row'+(row?.pending?' is-pending':'')},
        expressionSelect,el('span',{class:'pair-arrow','aria-hidden':'true'},'→'),emotionSelect,
        row&&!row.pending?button('解除',()=>void setPair(row.emotion,'',''),{class:'pair-remove','aria-label':'解除 '+row.emotion})
          :el('span',{class:'pair-remove-placeholder'})));
    }
    const pairsEditor=el('section',{class:'card preset-pairs'},el('div',{class:'section-head'},el('h2',{},'情绪对应表情'),el('span',{class:'subtle'},'左边选表情，右边选情绪')),
      el('div',{class:'pair-head'},el('span',{},'表情'),el('span'),el('span',{},'情绪')),
      el('div',{class:'pair-rows'},pairRows),
      el('p',{class:'subtle'},'桌宠检测到某个情绪时，就会切到与它配对的表情。一个情绪只能配一个表情（配对时会自动从别的表情那里移过来）。'),
      el('div',{class:'preset-summary-rows'},Object.entries(emotionLabels).map(([emotion,label])=>{
        const id=own[emotion],item=id?data?.catalog?.items?.find(i=>i.id===id):null;
        return el('div',{class:'preset-summary-row'},el('span',{class:'preset-summary-key'},label),
          el('span',{class:'preset-summary-value'+(item?'':' is-empty')},item?item.label:'（未设置，不会切换表情）'));
      })));
    const list=el('section',{class:'card preset-list'},el('div',{class:'section-head'},el('h2',{},'表情与动作'),el('span',{class:'subtle'},filtered.length+' 项')),search,filters,
      el('p',{class:'subtle'},'每张表情卡片右侧的下拉框决定它对应哪种情绪。勾选「是否持续启用该表情」后，桌宠会一直保持这个表情的效果（例如署名标记类的表情持续启用后就不再显示）—— 取消勾选即可恢复。'),
      el('div',{class:'preset-cards'},filtered.map(p=>{
        const allowed=enabled.has(p.id),isSelected=selected===p.id,isHidden=hidden.has(p.id);
        const card=el('article',{class:'preset-card'+(isSelected?' is-selected':'')+(isHidden?' is-hidden':''),'data-preset-id':p.id},
          button(el('span',{},el('strong',{},p.label),el('small',{},categoryNames[p.category]+' · '+sourceNames[p.source])),()=>void select(p),{class:'preset-select',disabled:!p.previewable,'aria-pressed':isSelected,'aria-label':'预览 '+p.label}),
          el('div',{class:'preset-card-bottom'},p.availability==='automatic'?el('label',{class:'preset-toggle'},el('input',{type:'checkbox',checked:allowed,disabled:saving,id:'enable-'+p.id,'aria-label':p.label+' 允许自动使用',onChange:e=>void toggle(p,e.target.checked)}),el('span',{},'允许自动使用'),el('b',{'aria-hidden':'true'},allowed?'✓':'×')):badge(p.previewable?'手动预览':'不可预览',p.previewable?'info':'warning')),
          hideToggle(p),
          emotionPicker(p),
          p.reason&&el('p',{class:'preset-reason'},p.reason));return card;
      })),!filtered.length&&notice(data?'没有找到匹配的预设。':'正在读取预设目录…'));
    return el('div',{class:'presentation-page'},stats,error&&notice(error,'error'),message&&notice(message,'success'),saving&&notice('正在保存自动使用设置…'),
      el('div',{class:'preset-layout'},preview,el('div',{class:'preset-column'},pairsEditor,list)),data&&el('details',{class:'card preset-details'},el('summary',{},'素材详情'),
        el('p',{},'36个模型表情或外观文件、1个模型待机动画、3项程序动作。数量不等于情绪种类或新生成动画。'),
        el('p',{},'模型版本：'+data.catalog.modelId),el('p',{},'设置版本：'+data.policy.revision),el('p',{},'允许列表按当前模型保存。未开放的外观预设不会交给聊天模型；恢复预览保持现有水印策略。')));
  }
  return {view,deactivate,refresh,dispose(){deactivate();resize.disconnect();}};
}
