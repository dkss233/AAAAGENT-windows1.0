// Runs before the stylesheet as a classic script, and is safe to import again.
(()=>{
 if(window.AAAAppearance)return;
 const key='t3code:theme-appearance-mode',modes=['light','dark','system'];
 const media=window.matchMedia('(prefers-color-scheme: dark)'),listeners=new Set();
 let mode='system',saved=true;
 try{const stored=localStorage.getItem(key);if(modes.includes(stored))mode=stored;}catch{saved=false;}
 const state=()=>({mode,resolved:mode==='system'?(media.matches?'dark':'light'):mode,saved});
 function apply(){const value=state();document.documentElement.dataset.appearance=value.resolved;document.documentElement.style.colorScheme=value.resolved;for(const fn of listeners)fn(value);}
 function set(next){if(!modes.includes(next))return false;mode=next;try{localStorage.setItem(key,next);saved=true;}catch{saved=false;}apply();return saved;}
 window.AAAAppearance={state,set,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
 media.addEventListener('change',()=>{if(mode==='system')apply();});
 window.addEventListener('storage',event=>{if(event.key===key||event.key===null){try{const next=localStorage.getItem(key);mode=modes.includes(next)?next:'system';saved=true;apply();}catch{saved=false;}}});
 apply();
})();
