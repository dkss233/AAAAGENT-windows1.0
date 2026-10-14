// Explicit Playwright CLI visual capture function, invoked with --filename.
// The URL must be the current task's silent display-fixture server.
async page => {
  const origin = await page.evaluate(()=>location.origin);
  const results = [];
  for (const scene of [
    {name:'full-final', mode:'full',size:360,w:380,h:800},
    {name:'half-final', mode:'half',size:360,w:380,h:800},
    {name:'half-min', mode:'half',size:220,w:240,h:400},
    {name:'half-max', mode:'half',size:720,w:740,h:800},
    {name:'half-chat-small-screen', mode:'half',size:720,w:406,h:740,chat:true},
  ]) {
    await page.setViewportSize({width:scene.w,height:scene.h});
    await page.goto(`${origin}/?mode=${scene.mode}&size=${scene.size}${scene.chat?'&chat&screenWidth=1512&screenHeight=740':''}`);
    await page.waitForFunction(()=>window.visualReports?.some(v=>v.type==='model-loaded'));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const metrics=await page.evaluate(()=>{
      const canvas=document.querySelector('canvas'), drawer=document.getElementById('drawer');
      const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};
      return {layout:visualLayout,dpr:devicePixelRatio,canvas:[canvas.width,canvas.height,canvas.clientWidth,canvas.clientHeight],pet:box('pet'),handle:box('model-resize'),drawer:box('drawer'),chatOpen:!drawer.hidden,font:getComputedStyle(document.getElementById('text')).fontSize,errors:visualReports.filter(v=>['model-error','script-error','promise-error'].includes(v.type))};
    });
    if(metrics.errors.length)throw Error(JSON.stringify(metrics.errors));
    if(metrics.font!=='13px'||metrics.handle.right>scene.w+.1||metrics.handle.bottom>scene.h+.1)throw Error('font/handle outside layout');
    if(scene.chat&&metrics.drawer.bottom>scene.h+.1)throw Error('chat outside visible area');
    await page.locator(scene.chat?'body':'#pet').screenshot({path:`${scene.name}.png`,scale:'css'});
    results.push({scene,...metrics});
  }
  // Closing a screen-constrained chat restores the preferred model size.
  await page.getByRole('button',{name:'收起对话'}).click();
  const restored=await page.evaluate(()=>visualLayout);
  if(restored.preferredWidth!==720||restored.modelWidth!==720)throw Error('screen fitting overwrote preference');
  results.push({restoredAfterChatClose:restored});
  console.log(JSON.stringify(results,null,2));
}
