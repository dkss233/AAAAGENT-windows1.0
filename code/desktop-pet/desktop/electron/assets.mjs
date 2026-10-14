import { realpath, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
export async function assetResponse(root, value, requestHeaders = new Headers()) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'pet:' || url.host !== 'app' || url.username || url.password) return new Response(null, { status: 403 });
    const name = decodeURIComponent(url.pathname).slice(1) || 'index.html';
    if (name.includes('\\') || name.includes(':') || name.includes('\0') || name.split('/').some(p => p === '..' || p === '.')) return new Response(null, { status: 403 });
    const base = await realpath(root), file = await realpath(resolve(base, name)), part = relative(base, file);
    if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) return new Response(null, { status: 403 });
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webm':'video/webm' }[extname(file)] || 'application/octet-stream';
    if (extname(file) === '.webm') {
      const {size}=await stat(file),range=new Headers(requestHeaders).get('range');
      let start=0,end=size-1,status=200;
      const headers={'content-type':mime,'accept-ranges':'bytes','cache-control':'no-store'};
      if(range){
        const match=/^bytes=(\d*)-(\d*)$/.exec(range);
        if(!match||!match[1]&&!match[2])return new Response(null,{status:416,headers:{'content-range':`bytes */${size}`}});
        start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));end=match[1]&&match[2]?Math.min(size-1,Number(match[2])):size-1;
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)return new Response(null,{status:416,headers:{'content-range':`bytes */${size}`}});
        status=206;headers['content-range']=`bytes ${start}-${end}/${size}`;
      }
      headers['content-length']=String(end-start+1);
      return new Response(Readable.toWeb(createReadStream(file,{start,end})),{status,headers});
    }
    return new Response(await readFile(file), { headers: { 'content-type': mime, 'cache-control': 'no-store' } });
  } catch { return new Response(null, { status: 404 }); }
}
