// Browser interaction checks for ui-fixture.mjs; never use against the real API.
const assert=(value,message)=>{if(!value)throw Error(message)};
const get=id=>document.getElementById(id);
const click=id=>{const e=get(id);assert(e&&!e.disabled,'Missing/enabled control: '+id);e.click()};
const fill=(id,value,event='input')=>{const e=get(id);assert(e,'Missing field: '+id);if(e.getAttribute('role')==='combobox'){e.click();const option=[...document.querySelectorAll('[role=option]')].find(n=>n.dataset.value===value);assert(option,'Missing option: '+value);option.click();return;}e.value=value;e.dispatchEvent(new Event(event,{bubbles:true}))};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(predicate,message)=>{const end=Date.now()+5000;while(!predicate()){if(Date.now()>end)throw Error(message);await pause(25)}};
const auth={Authorization:'Bearer fixture-session-only','Content-Type':'application/json'};
const control=async body=>{const r=await fetch('/fixture/control',{method:'POST',headers:auth,body:JSON.stringify(body)});assert(r.ok,'Fixture control failed')};
const state=async()=>{const r=await fetch('/fixture/state',{headers:auth});return r.json()};
const chooseRecord=id=>{const e=document.querySelector('[data-record-id="'+id+'"]');assert(e,'Record absent: '+id);e.click()};
export async function runUIChecks(){
  assert(document.body.innerText.includes('隔离演示'),'Refuse tests outside isolated fixture');
  const results=[];const check=async(name,fn)=>{await fn();results.push({name,status:'passed'})};
  await check('session authorization; saved/effective distinction; plain-text events',async()=>{
    assert(!location.hash,'Token fragment retained');click('nav-models');assert(document.body.innerText.includes('等待重启'),'Pending state hidden');
    assert(document.body.innerText.includes('语音转写') && document.body.innerText.includes('视频情绪'),'ASR absent');
    click('nav-events');assert(document.body.innerText.includes('<img src=x'),'Event source not presented literally');assert(!document.querySelector('main img'),'Event HTML rendered');
  });
  await check('single product identity without selector; legacy snapshot and foreign records rejected',async()=>{
    click('nav-memory');click('memory-records');await until(()=>document.querySelector('[data-record-id="companion-memory"]'),'Companion list absent');
    assert(!get('character')&&!document.querySelector('.rolebar'),'Role selector or placeholder retained');
    await control({legacySnapshot:true});click('refresh');await until(()=>document.body.innerText.includes('单角色版本不匹配'),'Legacy snapshot accepted');
    await control({legacySnapshot:false});click('refresh');await until(()=>document.body.innerText.includes('已连接'),'Snapshot recovery failed');
    await control({foreignRecords:true});click('record-search');await until(()=>document.body.innerText.includes('查询结果包含其他角色'),'Foreign record accepted');
    assert(!document.body.innerText.includes('不应显示的旧角色记录'),'Foreign text displayed');
    await control({foreignRecords:false});click('refresh');await until(()=>!get('refresh').disabled,'Refresh pending');click('record-search');await until(()=>!get('record-search').disabled,'Record reload pending');
    chooseRecord('companion-memory');fill('record-text','未保存的记忆草稿');
  });
  await check('record conflict preserves draft; explicit review uses latest version',async()=>{
    const before=(await state()).writes.length;await control({recordConflict:true});click('record-save');await until(()=>get('record-review'),'Conflict did not surface');await until(()=>get('record-text')?.disabled===false,'Save did not settle');
    assert(get('record-text').value==='未保存的记忆草稿','Conflict discarded draft');assert(get('record-save').disabled,'Conflict allowed blind resubmission');assert((await state()).writes.length===before,'Conflict counted as successful write');
    click('record-review');click('record-save');await until(()=>document.body.innerText.includes('记录已更新'),'Reviewed save failed');
    const last=(await state()).writes.at(-1);assert(last.body.characterId==='companion'&&last.body.expectedVersion===2,'Save scope or version wrong');
  });
  await check('prompt conflict preserves fictional persona draft and supports versioned update',async()=>{
    click('memory-prompt');await until(()=>get('prompt-text'),'Prompt absent');fill('prompt-text','保持自己的判断，也留意共同经历。');await control({promptConflict:true});click('prompt-save');await until(()=>get('prompt-review'),'Prompt conflict absent');await until(()=>!get('prompt-text').disabled,'Prompt save pending');assert(get('prompt-text').value==='保持自己的判断，也留意共同经历。','Prompt draft lost');
    click('prompt-review');click('prompt-save');await until(()=>document.body.innerText.includes('角色设定已更新'),'Prompt save failed');
  });
  await check('a stale prompt read cannot invalidate a successful save',async()=>{
    await control({delayPromptGet:300});click('prompt-refresh');fill('prompt-text','保存成功后仍应保留的新设定');click('prompt-save');await until(()=>document.body.innerText.includes('角色设定已更新'),'Prompt save did not complete');await pause(500);
    assert(!get('prompt-review'),'Older read invalidated the saved prompt');assert(get('prompt-text').value==='保存成功后仍应保留的新设定','Older read changed saved content');await control({delayPromptGet:0});
  });
  await check('settings conflict rebases only edited fields and remains pending restart',async()=>{
    click('nav-overview');fill('context-targetInputTokens','240000');await control({settingsConflict:true});click('settings-save');await until(()=>get('settings-review'),'Settings conflict absent');await until(()=>!get('settings-review').disabled,'Settings conflict still pending');assert(get('context-targetInputTokens').value==='240000','Settings draft lost');click('settings-review');
    assert(get('context-currentEmotionReserveTokens').value==='384','Unedited newer setting overwritten');click('settings-save');await until(()=>document.body.innerText.includes('配置已保存为版本'),'Settings save failed');const saved=(await state()).settings;
    assert(saved.saved.context.targetInputTokens===240000&&saved.saved.context.currentEmotionReserveTokens===384&&saved.effectiveRevision===2&&saved.pending,'Saved/effective semantics wrong');
    click('nav-models');click('configure-dialogue');fill('model-dialogue','fixture-dialogue-b','change');click('settings-save');await until(()=>!get('settings-save').disabled,'Model save pending');const updated=(await state()).settings;assert(updated.saved.providers.dialogue.model==='fixture-dialogue-b'&&updated.effective.providers.dialogue.model==='fixture-dialogue-a','Draft model incorrectly shown as effective');
  });
  await check('read-only derived data, searchable records and context view',async()=>{
    click('nav-memory');click('memory-records');await until(()=>get('record-kind'),'No record search');fill('record-kind','vector_index','change');await until(()=>document.querySelector('[data-record-id="companion-vector"]'),'Derived record absent');chooseRecord('companion-vector');assert(!get('record-save')&&!get('record-text'),'Derived record editable');
    fill('record-kind','transcript','change');await until(()=>document.querySelector('[data-record-id="companion-transcript"]'),'Transcript absent');fill('record-query','不存在的查询');click('record-search');await until(()=>document.body.innerText.includes('没有符合条件'),'Search ignored');fill('record-query','');
    click('memory-context');await until(()=>document.body.innerText.includes('隔离演示的上下文结果'),'Context absent');assert(document.body.innerText.includes('今天想把课程'),'Context records not displayed');
  });
  await check('offline and expired session retain drafts, block save, and recover',async()=>{
    click('memory-prompt');await until(()=>get('prompt-text'),'Prompt missing');fill('prompt-text','等待重新连接的草稿');await control({offline:true});click('refresh');await until(()=>document.body.innerText.includes('连接中断'),'Offline concealed');assert(get('prompt-text').value==='等待重新连接的草稿'&&get('prompt-save').disabled,'Offline draft/save unsafe');
    await control({offline:false,unauthorized:true});click('refresh');await until(()=>get('session'),'401 reconnect absent');assert(get('prompt-text').value==='等待重新连接的草稿','401 destroyed draft');
    await control({unauthorized:false});fill('session','fixture-session-only');get('session').form.requestSubmit();await until(()=>!get('session'),'Reconnect failed');assert(get('prompt-text').value==='等待重新连接的草稿','Reconnect discarded draft');
  });
  await check('rollback is a versioned save, not immediate application',async()=>{
    click('nav-models');const btn=document.querySelector('[data-target-revision="2"]');assert(btn&&!btn.disabled,'Rollback unavailable');btn.click();await until(()=>!get('settings-save').disabled,'Rollback pending');const last=(await state()).writes.at(-1);assert(last.route==='/api/settings/rollback'&&last.body.targetRevision===2,'Rollback route wrong');assert((await state()).settings.effectiveRevision===2,'Rollback mutated effective instance');
  });
  assert(!/(?:^|\n)(?:false|true|null|undefined)(?:\n|$)/.test(document.body.innerText),'Conditional UI values leaked into visible copy');
  return {passed:results.length,failed:0,results,proof:'Actual UI and browser events against isolated, generated API data; not real business API acceptance'};
}

export async function runChoiceChecks(){
  assert(document.body.innerText.includes('隔离演示'),'Refuse outside fixture');
  await control({catalog:true});click('refresh');await until(()=>!get('refresh').disabled,'Snapshot pending');click('nav-models');click('configure-dialogue');
  fill('model-dialogue','fixture-dialogue-b','change');click('settings-save');await until(()=>!get('settings-save').disabled,'Save pending');
  const config=(await state()).settings.saved.providers.dialogue;
  assert(config.model==='fixture-dialogue-b'&&config.reservationMicros===900000&&config.inputMicrosPerToken===9&&config.outputMicrosPerToken===19,'Model choice did not replace tariff/defaults');
  assert(config.credentialRef==='fixture-credential','Same-provider credential reference lost');
  click('configure-tts');fill('model-tts','fixture-tts-b','change');assert(get('voice-tts').getAttribute('role')==='combobox','Registered voice choices absent');assert(get('voice-tts').value==='registered-b','Default voice not updated with choice');
  fill('voice-tts','registered-a','change');click('settings-save');await until(()=>!get('settings-save').disabled,'Voice save pending');assert((await state()).settings.saved.providers.tts.voice==='registered-a','Registered voice not saved');
  return {passed:1,failed:0,checks:['model-specific configuration and tariffs replaced','same-provider credential reference retained','registered voice list/default/selection submitted'],boundary:'isolated fixture; actual adapter catalog and API acceptance owned by integration'};
}

export async function runSlotPendingCheck(){
  assert(document.body.innerText.includes('隔离演示'),'Refuse outside fixture');
  const {modelsView}=await import('/views.mjs');
  const settings=(await state()).settings;
  settings.effective.providers.tts.voice='Cherry';
  settings.saved=structuredClone(settings.effective);
  settings.saved.providers.tts.voice='Serena';
  settings.pending=true;
  const view=modelsView({s:{snapshot:{settings},connection:'online',pending:new Set(),providerSlot:null,settingsConflict:false}});
  const cards=Object.fromEntries(['dialogue','perception','tts'].map(slot=>[slot,view.querySelector('#configure-'+slot).closest('section').textContent]));
  assert(!cards.dialogue.includes('已保存待重启'),'Unchanged dialogue card incorrectly pending');
  assert(!cards.perception.includes('已保存待重启'),'Unchanged perception card incorrectly pending');
  assert(cards.tts.includes('音色：Cherry')&&cards.tts.includes('已保存待重启：'+settings.saved.providers.tts.model+' · Serena'),'TTS effective/pending voices missing');
  assert(view.querySelector('.version-strip').textContent.includes('等待重启'),'Global pending state disappeared');
  return {passed:1,failed:0,checks:['only changed TTS card shows pending voice','unchanged dialogue/perception cards have no pending hint','global pending state retained'],boundary:'production modelsView rendered in browser with isolated generated settings; no real API or provider calls'};
}
