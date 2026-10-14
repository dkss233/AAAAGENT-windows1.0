// This landing page is issued only by a consumed, identity-checked browser ticket.
// The management bearer stays in this tab's session storage, outside the URL.
export const managementEntryScript = `const ticket=location.hash.slice(1);history.replaceState(null,'','/open');
fetch('/launch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})})
.then(async r=>{if(!r.ok)throw Error();const v=await r.json();const u=new URL(v.url);
if(u.origin!==location.origin||u.pathname!=='/'||u.hash||u.username||u.password||
   !/^[a-f0-9]{64}$/.test(v.managementToken)||[...u.searchParams.keys()].join(',')!=='nativePath')throw Error();
const p=new URL(u.searchParams.get('nativePath'),location.origin);
if(p.origin!==location.origin||!p.pathname.startsWith('/native/')||p.hash||p.username||p.password||
   /^\\/native\\/(pair|login)(\\/|$)/.test(p.pathname))throw Error();
const key='aaa-original-management-return-v1',relation=v.originalManagementReturn;
if(relation!==undefined){
 if(!relation||Object.keys(relation).sort().join(',')!=='environmentId,navigationId,origin,path,version'||
    relation.version!=='0.1.1'||relation.path!=='/'||
    typeof relation.environmentId!=='string'||!relation.environmentId||relation.environmentId.length>250||/[\\x00-\\x1f\\x7f]/.test(relation.environmentId)||
    !/^http:\\/\\/127\\.0\\.0\\.1:[1-9][0-9]{0,4}$/.test(relation.origin)||relation.origin===location.origin||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(relation.navigationId))throw Error();
 sessionStorage.setItem(key,JSON.stringify(relation));
}else sessionStorage.removeItem(key);
sessionStorage.setItem('pet-management-session-v1',v.managementToken);location.replace(u.href);})
.catch(()=>{document.getElementById('state').textContent='这次打开未完成或入口已过期，请回原页面重新打开。任务不会重新派发。';});`;

// Only document routes can show recovery. Data, assets and commands keep their auth gate.
export function nativeRecoveryTarget(raw, origin) {
 try {
  if (typeof raw!=='string'||!raw.startsWith('/native/')||/[\\\x00-\x20\x7f]/.test(raw)) return null;
  if(raw.split(/[?#]/,1)[0].split('/').some(part=>['.','..'].includes(decodeURIComponent(part))))return null;
  const url=new URL(raw,origin),parts=url.pathname.slice(8).split('/').map(decodeURIComponent),keys=[...url.searchParams.keys()];
  const identifier=value=>typeof value==='string'&&!!value&&value.length<=250&&!/[\/\\\x00-\x1f\x7f]/.test(value)&&!['.','..'].includes(value);
  if(url.origin!==origin||url.hash||url.username||url.password||['pair','login'].includes(parts[0]))return null;
  let environmentId=null;
  if(parts.length===1&&parts[0]==='') {
   if(keys.length) {
    if(keys.length!==2||new Set(keys).size!==2||!keys.includes('aaaProject')||!keys.includes('aaaEnvironment')||!identifier(url.searchParams.get('aaaProject'))||!identifier(url.searchParams.get('aaaEnvironment')))return null;
    environmentId=url.searchParams.get('aaaEnvironment');
   }
  } else {
   if(parts.length!==2||!parts.every(identifier)||keys.length||parts.some(part=>part.includes('.')))return null;
   environmentId=parts[0];
  }
  return {path:url.pathname+url.search,environmentId};
 }catch{return null;}
}

export function nativeRecoveryHtml(managementOrigin) {
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AAAAGENT · 恢复工程连接</title><link rel="stylesheet" href="/native-session-recovery.css"><script src="/appearance.mjs"></script><script defer src="/native-session-recovery.js"></script></head><body><main><p class="brand">AAAAGENT</p><h1>恢复工程连接</h1><p id="state" role="status">正在重新核对本机连接…</p><nav><button id="retry" type="button">重新连接</button><a href="${managementOrigin}/">返回管理</a></nav></main></body></html>`;
}

export const nativeRecoveryCss = `:root{color-scheme:light dark;--bg:#f8f6f1;--panel:#fffdfa;--fg:#292824;--muted:#77736a;--line:#ddd8ce;--accent:#c9866c}html[data-appearance=dark]{--bg:#242421;--panel:#2c2c28;--fg:#e9e6de;--muted:#aaa69b;--line:#42423a}*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,sans-serif}main{width:min(560px,calc(100% - 40px));padding:36px;border:1px solid var(--line);border-radius:18px;background:var(--panel)}.brand{color:var(--muted);font-size:13px;letter-spacing:.08em}h1{font-size:23px;font-weight:600}#state{color:var(--muted);min-height:3.3em}nav{display:flex;gap:14px;align-items:center;margin-top:24px}button,a{font:inherit;border-radius:10px;padding:9px 16px}button{color:var(--fg);background:transparent;border:1px solid var(--line);cursor:pointer}button:disabled{opacity:.5;cursor:wait}a{color:var(--accent);text-decoration:none}button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}`;

export const nativeRecoveryScript = `const target=(${nativeRecoveryTarget.toString()})(location.pathname+location.search,location.origin);
const state=document.getElementById('state'),retry=document.getElementById('retry');let pending=false;
async function recover(){
 if(pending)return;pending=true;retry.disabled=true;state.textContent='正在重新核对本机连接…';
 try{
  const token=sessionStorage.getItem('pet-management-session-v1');
  if(!target||!/^http:\\/\\/127\\.0\\.0\\.1:[1-9][0-9]{0,4}$/.test(location.origin)||!/^[a-f0-9]{64}$/.test(token??'')){
   state.textContent='这个标签页缺少续接授权。请返回管理，重新打开这条对话。';return;
  }
  const response=await fetch('/api/native-mount/session',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error();const value=await response.json();
  if(value.apiVersion!==1||value.mountPath!=='/native/'||!['native-read','native-operate'].includes(value.mode)||value.readonly!==(value.mode==='native-read')||typeof value.environmentId!=='string'||!value.environmentId||target.environmentId!==null&&value.environmentId!==target.environmentId||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.now())throw Error();
  location.replace(target.path);
 }catch{state.textContent='暂时无法恢复连接。可以重试，或返回管理重新打开。';}
 finally{pending=false;retry.disabled=false;}
}
retry.addEventListener('click',recover);void recover();`;
