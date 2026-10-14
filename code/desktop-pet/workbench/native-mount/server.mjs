import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { isNativeHttpRead, makeReadRpcFilter, makeExecutionRpcFilter } from './policy.mjs';
import { BrowserTickets, landingHtml, landingScript } from '../../../workbench/integration/t3-browser.mjs';
import { managementEntryScript, nativeRecoveryTarget, nativeRecoveryHtml, nativeRecoveryScript, nativeRecoveryCss } from './management-entry.mjs';

const COOKIE = 'aaa_native_read_session';
const TTL = 30 * 60_000;
const MANAGEMENT_CSP = "default-src 'self'; media-src 'self' blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const NATIVE_CSP = "default-src 'self'; media-src 'self' blob:; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'";
const TYPES = { '.html':'text/html; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png',
  '.jpg':'image/jpeg', '.woff2':'font/woff2', '.wasm':'application/wasm', '.txt':'text/plain' };
const MANAGEMENT_READS = new Set(['/api/snapshot', '/api/projects', '/api/workbench/status',
  '/api/workbench/project-bindings', '/api/workbench/tasks', '/api/workbench/task-detail', '/api/presentation']);
const equal = (a,b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const loopback = raw => {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Loopback origin required');
  return url.origin;
};
const cookies = raw => (raw ?? '').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));

// Composition only: original services remain the sole owners of project/thread state.
export async function startNativeReadMount(options) {
  const managementOrigin = loopback(options.managementOrigin), nativeOrigin = loopback(options.nativeOrigin);
  if (![options.managementToken, options.nativeToken].every(t => typeof t==='string' && t.length>=32)) throw Error('Existing service auth required');
  const token = options.token ?? randomBytes(32).toString('hex');
  if (token.length < 32) throw Error('Invalid candidate auth');
  const uiRoot = await realpath(options.uiRoot), nativeRoot = await realpath(options.nativeDist);
  const nativeHtml=await readFile(resolve(nativeRoot,'index.html'),'utf8');
  const inlineScriptHashes=[...nativeHtml.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([,attrs,body])=>! /\bsrc\s*=/.test(attrs) && body.trim())
    .map(([, ,body])=>`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
  const nativeCsp=NATIVE_CSP.replace("script-src 'self'",`script-src 'self' ${inlineScriptHashes.join(' ')}`);
  const managementCsp=options.managementBrowserEntry ?
    MANAGEMENT_CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self' " + managementOrigin) : MANAGEMENT_CSP;
  const framedNativeCsp=options.managementBrowserEntry ?
    nativeCsp.replace("frame-ancestors 'self'", "frame-ancestors 'self' " + managementOrigin) : nativeCsp;
  const managementFiles = new Set((await readdir(uiRoot)).filter(s=> /^[A-Za-z0-9._-]+\.(?:mjs|css|html)$/.test(s) || s === 'presentation-preview.js'));
  // Exact routes prepared from the original model manifest, never request prefixes or files.
  const presentationPaths = new Set(options.presentationReadPaths ?? []);
  for (const path of presentationPaths) {
    if (typeof path !== 'string' || /[%?#\\\0]/.test(path) || path.split('/').slice(1).some(part => !part || part === '.' || part === '..') ||
        !(path === '/presentation-runtime/core.js' || path.startsWith('/presentation-assets/') || path.startsWith('/presentation-shaders/'))) throw Error('Invalid fixed presentation route');
  }
  const sessions = new Map(), tickets = new Map(), sockets = new Set();
  const browserTickets = new BrowserTickets();
  const audit = { managementReads: {}, nativeReads: {}, rpcAllowed: {}, rpcRejected: {},
    sessionsIssued: 0, socketsOpened: 0, upstreamSocketsOpened: 0, upstreamFailures: 0 };
  const count = (map,key) => { map[key]=(map[key]??0)+1; };
  let origin;
  const bearer = req => equal(req.headers.authorization, 'Bearer '+token);
  const session = req => {
    const values = cookies(req.headers.cookie);
    if (values.length !== 1) return null;
    const id=values[0].slice(COOKIE.length+1), saved=sessions.get(id);
    if (!saved || saved.expires <= Date.now()) { sessions.delete(id); return null; }
    return { id, ...saved };
  };
  function json(res, status, body) {
    res.statusCode=status;res.setHeader('Content-Type',TYPES['.json']);res.end(JSON.stringify(body));
  }
  async function upstream(path, native=true, method='GET') {
    const response = await fetch((native?nativeOrigin:managementOrigin)+path, {
      method,
      headers: { Authorization:'Bearer '+(native?options.nativeToken:options.managementToken) },
      redirect:'error',signal:AbortSignal.timeout(10_000),cache:'no-store',
    });
    return response;
  }
  async function forwardRead(res, url, native, headOnly=false, mode='native-read') {
    count(native?audit.nativeReads:audit.managementReads,url.pathname);
    const response=await upstream(url.pathname+url.search,native,headOnly?'HEAD':'GET');
    res.statusCode=response.status;
    res.setHeader('Content-Type',response.headers.get('content-type')??'application/json');
    // Credentials, Set-Cookie, redirects and production CSP never cross this boundary.
    if (native && url.pathname==='/api/auth/session' && response.ok) {
      const value=await response.json();
      if (value.authenticated===true) value.scopes=mode==='native-operate' && value.scopes?.includes('orchestration:operate') ?
        ['orchestration:read','orchestration:operate'] : ['orchestration:read'];
      res.end(JSON.stringify(value));
    } else res.end(headOnly ? undefined : Buffer.from(await response.arrayBuffer()));
  }
  function rememberSession(state, descriptor, res, current=null) {
    const ttl=options.sessionTtlMs??TTL;
    if(!Number.isSafeInteger(ttl)||ttl<1||ttl>TTL)throw Error('Invalid session lifetime');
    const now=Date.now(),expiry=state.expiresAt?Date.parse(state.expiresAt):now+ttl;
    if (!state.authenticated || !Number.isFinite(expiry) || expiry<=now || typeof descriptor.environmentId!=='string')
      throw Error('Native session unavailable');
    for(const [id,saved] of sessions)if(saved.expires<=now)sessions.delete(id);
    if(!current&&sessions.size>=32)throw Error('Session capacity');
    const capable=options.executionGate?.capability();
    if(capable && capable.environmentId!==descriptor.environmentId)throw Error('Execution environment changed');
    if(current&&current.environmentId!==descriptor.environmentId)throw Error('Native environment changed');
    const mode=capable && state.scopes?.includes('orchestration:operate')&&current?.mode!=='native-read'?'native-operate':'native-read';
    const id=current?.id??randomBytes(32).toString('hex'),saved={expires:Math.min(now+ttl,expiry),mode,environmentId:descriptor.environmentId};
    sessions.set(id,saved);audit.sessionsIssued++;
    res.setHeader('Set-Cookie',`${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1,Math.ceil((saved.expires-now)/1000))}`);
    return saved;
  }
  async function mintSession(res) {
    const management = await upstream('/api/snapshot', false);
    if (!management.ok) throw Error('Management reader unavailable');
    const response = await upstream('/api/auth/session');
    if (!response.ok) throw Error('Native session unavailable');
    const descriptor=await upstream('/.well-known/t3/environment');
    if(!descriptor.ok)throw Error('Native identity unavailable');
    return rememberSession(await response.json(),await descriptor.json(),res);
  }
  async function smallBody(req, limit = 16384) {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw Error('Request too large'); chunks.push(Buffer.from(chunk)); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const server = createServer({ requestTimeout:10_000,headersTimeout:10_000 },(req,res)=> {
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',managementCsp);
    void (async()=> {
      if (req.headers.host!==new URL(origin).host || req.headers.origin && req.headers.origin!==origin) return json(res,403,{error:'origin_rejected'});
      const url=new URL(req.url,origin);
      if (['GET','HEAD'].includes(req.method)&&!url.search&&['/native-session-recovery.js','/native-session-recovery.css'].includes(url.pathname)) {
        const script=url.pathname.endsWith('.js');res.setHeader('Content-Type',TYPES[script?'.js':'.css']);
        return res.end(req.method==='HEAD'?undefined:script?nativeRecoveryScript:nativeRecoveryCss);
      }
      if (url.pathname.startsWith('/api/native-mount/voice/')) {
        const current=session(req);
        if (!current) return json(res,401,{error:'native_auth_expired'});
        if (current.mode !== 'native-operate') return json(res,403,{error:'engineering_voice_readonly'});
        const voice=options.engineeringVoiceService;
        if (!voice) return json(res,503,{error:'engineering_voice_unavailable'});
        if (url.pathname === '/api/native-mount/voice/capabilities' && req.method === 'GET') return json(res,200,voice.capabilities());
        const receipt=/^\/api\/native-mount\/voice\/receipts\/([a-f0-9-]+)$/i.exec(url.pathname);
        if (receipt && req.method === 'GET') {
          try {
            const target=JSON.parse(url.searchParams.get('target') ?? 'null');
            if (target?.environmentId !== current.environmentId) return json(res,409,{error:'engineering_voice_target_changed'});
            return json(res,200,await voice.receipt(receipt[1],target));
          } catch {return json(res,409,{error:'engineering_voice_receipt_unavailable'});}
        }
        if (url.pathname === '/api/native-mount/voice/transcribe' && req.method === 'POST') {
          if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return json(res,403,{error:'origin_rejected'});
          const controller=new AbortController();
          const closed=()=>{if (!res.writableEnded) controller.abort();};res.once('close',closed);
          try {
            const request=await smallBody(req,3*1024*1024);
            if (request?.target?.environmentId !== current.environmentId) return json(res,409,{error:'engineering_voice_target_changed'});
            return json(res,200,await voice.transcribe(request,AbortSignal.any([controller.signal,AbortSignal.timeout(300_000)])));
          } catch {return json(res,409,{error:'engineering_voice_rejected'});}
          finally {res.off('close',closed);}
        }
        return json(res,404,{error:'engineering_voice_route_unavailable'});
      }
      if(url.pathname==='/api/independent-blackboard/actor'&&req.method==='POST') {
        if(!options.independentBlackboardService)return json(res,404,{error:'board_unavailable'});
        if(req.headers.origin!==origin||!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return json(res,403,{error:'origin_rejected'});
        const authorization=req.headers.authorization;
        if(typeof authorization!=='string'||!/^Bearer [a-f0-9]{64}$/.test(authorization))return json(res,401,{error:'actor_not_authorized'});
        try{return json(res,200,await options.independentBlackboardService.actor(await smallBody(req,65536),authorization.slice(7)));}
        catch{return json(res,409,{error:'board_actor_rejected'});}
      }
      if(url.pathname==='/api/independent-blackboard/register'&&req.method==='POST') {
        if(!options.independentBlackboardService)return json(res,404,{error:'board_unavailable'});
        const current=session(req);
        if(!bearer(req)&&current?.mode!=='native-operate')return json(res,401,{error:'auth_expired'});
        if(req.headers.origin!==origin||!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return json(res,403,{error:'origin_rejected'});
        try {
          // Verify the existing management and native account before metadata registration.
          const state=await mintSession(res);
          if(state.mode!=='native-operate')return json(res,403,{error:'board_registration_readonly'});
          return json(res,200,await options.independentBlackboardService.register(await smallBody(req)));
        } catch{return json(res,409,{error:'board_registration_rejected'});}
      }
      if (options.nativeBrowserTarget && req.method === 'GET' && ['/open', '/open.js'].includes(url.pathname)) {
        res.setHeader('Content-Type', url.pathname === '/open' ? TYPES['.html'] : TYPES['.js']);
        return res.end(url.pathname === '/open' ? landingHtml : options.managementBrowserEntry ? managementEntryScript : landingScript);
      }
      if (options.nativeBrowserTarget && req.method === 'POST' && url.pathname === '/api/native-mount/open-browser') {
        if (!bearer(req)) return json(res,401,{error:'auth_expired'});
        if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return json(res,403,{error:'origin_rejected'});
        const request = await smallBody(req);
        if (!request || typeof request !== 'object' || Array.isArray(request) ||
            request.originalManagementReturn !== undefined && request.originalManagementReturn !== true)
          return json(res,400,{error:'invalid_original_return'});
        const { originalManagementReturn: requestedReturn, ...target } = request;
        if (requestedReturn && !options.managementBrowserEntry) return json(res,400,{error:'original_return_unavailable'});
        const path = await options.nativeBrowserTarget(target);
        if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('#')) throw Error('Invalid native target');
        const originalManagementReturn = requestedReturn ?
          { version:'0.1.1',origin:managementOrigin,path:'/',environmentId:target.environmentId,navigationId:randomUUID() } : undefined;
        const issued = browserTickets.issue({ target, ...(originalManagementReturn ? { originalManagementReturn } : {}) });
        return json(res,200,{url:origin+'/open#'+issued.ticket,expiresAt:issued.expiresAt,
          ...(originalManagementReturn ? { originalManagementReturn } : {})});
      }
      if (options.nativeBrowserTarget && req.method === 'POST' && url.pathname === '/launch') {
        if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return json(res,403,{error:'origin_rejected'});
        let target;
        try { const body=await smallBody(req); target=browserTickets.consume(body.ticket); } catch { return json(res,401,{error:'entry_expired'}); }
        const path = await options.nativeBrowserTarget(target.target);
        if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('#')) throw Error('Invalid native target');
        await mintSession(res);
        if (options.managementBrowserEntry) {
          return json(res,200,{url:origin+'/?nativePath='+encodeURIComponent('/native'+path),managementToken:token,
            ...(target.originalManagementReturn ? { originalManagementReturn: target.originalManagementReturn } : {})});
        }
        return json(res,200,{url:origin+'/native'+path});
      }
      if (url.pathname === '/api/native-mount/skill-trial' && req.method === 'GET') {
        if (!session(req)) return json(res,401,{error:'native_auth_expired'});
        return json(res,200,{apiVersion:1,trial:options.skillTrialGate?.capability() ?? null});
      }
      if (url.pathname === '/api/native-mount/capabilities' && req.method === 'GET') {
        const current=session(req);
        if(!current)return json(res,401,{error:'native_auth_expired'});
        return json(res,200,{...(options.executionGate?.capability(current.mode) ?? {
          apiVersion:1,version:'0.2.0',environmentId:current.environmentId,mode:'native-read',commandTypes:[],providers:[] }),
          expiresAt:new Date(current.expires).toISOString()});
      }
      const targetCapabilityMatch = /^\/api\/native-mount\/targets\/([^/]+)\/capabilities$/.exec(url.pathname);
      if (targetCapabilityMatch && req.method === 'GET') {
        const current=session(req);
        if(!current)return json(res,401,{error:'native_auth_expired'});
        if(!options.executionGate)return json(res,404,{error:'native_target_unavailable'});
        try {
          const capability=await options.executionGate.targetCapability(decodeURIComponent(targetCapabilityMatch[1]),current.mode);
          return capability ? json(res,200,{...capability,expiresAt:new Date(current.expires).toISOString()}) :
            json(res,404,{error:'native_target_unavailable'});
        } catch { return json(res,503,{error:'native_target_unavailable'}); }
      }
      const receiptMatch = /^\/api\/orchestration\/commands\/([^/]+)\/receipt$/.exec(url.pathname);
      if (receiptMatch && req.method === 'GET' && (options.skillTrialGate?.allowsReceipt(decodeURIComponent(receiptMatch[1])) ||
          session(req)?.mode==='native-operate' && options.executionGate?.allowsReceipt(decodeURIComponent(receiptMatch[1])))) {
        if (!session(req)) return json(res,401,{error:'native_auth_expired'});
        const commandId = decodeURIComponent(receiptMatch[1]);
        const response = await upstream(url.pathname);
        if (!response.ok) return json(res,response.status,{error:'native_receipt_unavailable'});
        const value = await response.json(); options.skillTrialGate?.reconcile(commandId,value);options.executionGate?.reconcile(commandId,value);
        return json(res,200,value);
      }
      if (url.pathname==='/api/native-mount/session' && req.method==='POST') {
        if (!bearer(req)) return json(res,401,{error:'auth_expired'});
        if (req.headers.origin!==origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')) return json(res,403,{error:'origin_rejected'});
        let size=0;for await(const bytes of req) {size+=bytes.length;if(size>1024)return json(res,413,{error:'invalid_request'});}
        // Mint only after both actual services verify their existing credentials.
        const management=await upstream('/api/snapshot',false);
        if (!management.ok) return json(res,management.status===401?401:503,{error:'management_unavailable'});
        const response=await upstream('/api/auth/session');
        if (!response.ok) return json(res,response.status===401?401:503,{error:'native_unavailable'});
        const state=await response.json();
        if (!state.authenticated) return json(res,401,{error:'native_auth_expired'});
        const descriptorResponse=await upstream('/.well-known/t3/environment');
        if (!descriptorResponse.ok) return json(res,503,{error:'native_unavailable'});
        const descriptor=await descriptorResponse.json();
        const now=Date.now();
        const nativeExpiry=state.expiresAt?Date.parse(state.expiresAt):now+TTL;
        if(!Number.isFinite(nativeExpiry)||nativeExpiry<=now)return json(res,401,{error:'native_auth_expired'});
        // Native API/WS are original root paths. This uniquely named cookie is
        // accepted only by the native boundary; management APIs always need Bearer.
        const saved=rememberSession(state,descriptor,res,session(req));
        return json(res,200,{apiVersion:1,mode:saved.mode,mountPath:'/native/',readonly:saved.mode!=='native-operate',
          environmentId:descriptor.environmentId,expiresAt:new Date(saved.expires).toISOString()});
      }
      const nativeBoundary=url.pathname.startsWith('/native/') || url.pathname==='/ws' ||
        url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/orchestration/') ||
        url.pathname.startsWith('/api/attachments/') || url.pathname.startsWith('/api/assets/') || url.pathname==='/.well-known/t3/environment';
      if(nativeBoundary) {
        const current=session(req);
        if(!current) {
          // An expired document must load recovery before the SPA can renew its cookie.
          // This page contains no service credential, thread data or execution capability.
          if(req.method==='GET'&&/\btext\/html\b/i.test(req.headers.accept??'')&&nativeRecoveryTarget(url.pathname+url.search,origin)) {
            res.setHeader('Content-Type',TYPES['.html']);res.setHeader('Content-Security-Policy',framedNativeCsp);
            return res.end(nativeRecoveryHtml(managementOrigin));
          }
          return json(res,401,{error:'native_auth_expired',message:'本机会话已失效，请从控制台重新连接。'});
        }
        const toolMatch = /^\/api\/orchestration\/threads\/([^/]+)\/tool-output$/.exec(url.pathname);
        if (toolMatch) {
          if (req.method !== 'GET') return json(res,403,{error:'native_readonly'});
          if (!options.originalToolOutputReader) return json(res,404,{error:'original_tool_output_unavailable'});
          const keys = ['environmentId', 'projectId', 'workspaceRoot', 'providerInstanceId', 'turnId', 'toolCallId'];
          if ([...url.searchParams.keys()].some(key => !keys.includes(key)) ||
              keys.some(key => url.searchParams.getAll(key).length !== 1)) return json(res,404,{error:'original_tool_output_not_found'});
          const result = await options.originalToolOutputReader({ threadId: decodeURIComponent(toolMatch[1]),
            ...Object.fromEntries(keys.map(key => [key, url.searchParams.get(key)])) });
          count(audit.nativeReads, '/api/orchestration/threads/:threadId/tool-output');
          return json(res,result.status,result.body);
        }
        const boardMatch = /^\/api\/orchestration\/projects\/([^/]+)\/independent-blackboard$/.exec(url.pathname);
        if (boardMatch) {
          if (req.method !== 'GET') return json(res,403,{error:'board_readonly'});
          if (!options.independentBlackboardReader) return json(res,404,{error:'board_unavailable'});
          const result = await options.independentBlackboardReader({
            projectId: decodeURIComponent(boardMatch[1]), environmentId: url.searchParams.get('environmentId'),
          });
          return json(res,result.status,result.body);
        }
        if(req.method==='POST' && url.pathname==='/api/auth/websocket-ticket') {
          if(req.headers.origin!==origin)return json(res,403,{error:'origin_rejected'});
          for(const [id,t]of tickets)if(t.expires<=Date.now())tickets.delete(id);
          if(tickets.size>=64)return json(res,429,{error:'ticket_limit'});
          const id=randomBytes(32).toString('hex'),expires=Date.now()+60_000;
          tickets.set(id,{session:current.id,expires});
          return json(res,200,{ticket:id,expiresAt:new Date(expires).toISOString()});
        }
        if(isNativeHttpRead(req.method,url.pathname))return forwardRead(res,url,true,false,current.mode);
        if(current.mode==='native-operate' && req.method==='POST' && /^\/api\/attachments\/upload\/[A-Za-z0-9_.-]{1,4096}$/.test(url.pathname)) {
          if(req.headers.origin!==origin)return json(res,403,{error:'origin_rejected'});
          const maxBytes=50*1024*1024,declared=Number(req.headers['content-length']);
          if(!Number.isSafeInteger(declared)||declared<1||declared>maxBytes)return json(res,413,{error:'attachment_size_rejected'});
          let bytes=0;const chunks=[];
          for await(const chunk of req){bytes+=chunk.length;if(bytes>declared)return json(res,413,{error:'attachment_size_rejected'});chunks.push(chunk);}
          if(bytes!==declared)return json(res,400,{error:'attachment_size_rejected'});
          const response=await fetch(nativeOrigin+url.pathname,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30_000),
            headers:{Authorization:'Bearer '+options.nativeToken,'Content-Type':'application/octet-stream','Content-Length':String(bytes)},body:Buffer.concat(chunks)});
          res.statusCode=response.status;res.setHeader('Content-Type',response.headers.get('content-type')??'text/plain');
          return res.end(Buffer.from(await response.arrayBuffer()));
        }
        if(current.mode==='native-operate' && req.method==='GET' && /^\/api\/assets\/[A-Za-z0-9_.%-]+(?:\/[^?#]*)?$/.test(url.pathname))
          return forwardRead(res,url,true);
        if(url.pathname.startsWith('/native/') && ['GET','HEAD'].includes(req.method)) {
          let relative=decodeURIComponent(url.pathname.slice('/native/'.length));
          if(relative.includes('..') || relative.includes('\\') || relative.includes('\0'))return json(res,404,{error:'not_found'});
          if(!relative || !extname(relative))relative='index.html';
          const file=await realpath(resolve(nativeRoot,relative)).catch(()=>null);
          if(!file || !file.startsWith(nativeRoot+sep))return json(res,404,{error:'not_found'});
          if(relative==='index.html')res.setHeader('Content-Security-Policy',framedNativeCsp);
          const bytes=await readFile(file);res.setHeader('Content-Type',TYPES[extname(file)]??'application/octet-stream');
          return res.end(req.method==='HEAD'?undefined:bytes);
        }
        return json(res,403,{error:'native_readonly',message:'该操作未启用。'});
      }
      if(url.pathname.startsWith('/api/')) {
        if(!bearer(req))return json(res,401,{error:'auth_expired'});
        if(req.method==='GET' && MANAGEMENT_READS.has(url.pathname))return forwardRead(res,url,false);
        if(req.method==='GET')return json(res,404,{error:{code:'unavailable',message:'该管理页面未在本次工程读取入口启用。'}});
        return json(res,403,{error:'candidate_readonly',message:'本候选入口只读取当前工程状态。'});
      }
      if (presentationPaths.has(decodeURIComponent(url.pathname))) {
        if (!['GET', 'HEAD'].includes(req.method) || url.search) return json(res,404,{error:'not_found'});
        return forwardRead(res,url,false,req.method==='HEAD');
      }
      const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
      if(!['GET','HEAD'].includes(req.method)||!managementFiles.has(file))return json(res,404,{error:'not_found'});
      res.setHeader('Content-Type',TYPES[extname(file)]??'application/octet-stream');
      let bytes=await readFile(resolve(uiRoot,file));
      if(file==='index.html'){
        const marker='<meta name="aaa-management-entry" content="mounted-readonly" data-version="0.1.0">',html=bytes.toString('utf8');
        bytes=Buffer.from(/<\/head\s*>/i.test(html)?html.replace(/<\/head\s*>/i,marker+'</head>'):marker+html);
      }
      res.end(req.method==='HEAD'?undefined:bytes);
    })().catch(()=> {audit.upstreamFailures++;if(!res.headersSent)json(res,503,{error:'native_unavailable',message:'原服务暂不可读取，请核对连接。'});else res.end();});
  });
  const { WebSocket, WebSocketServer }=options.webSocket;
  const wss=new WebSocketServer({noServer:true,maxPayload:1_048_576,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=> {
    const reject=()=>{socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');};
    const url=new URL(req.url,origin),current=session(req);
    if(req.headers.host!==new URL(origin).host || req.headers.origin!==origin || url.pathname!=='/ws' || !current)return reject();
    const ticket=url.searchParams.get('wsTicket');
    if(ticket) { const t=tickets.get(ticket);tickets.delete(ticket);if(!t||t.session!==current.id||t.expires<=Date.now())return reject(); }
    if(sockets.size>=16)return reject();
    wss.handleUpgrade(req,socket,head,down=> {
      sockets.add(down);audit.socketsOpened++;
      const target=new URL(nativeOrigin);target.protocol='ws:';target.pathname='/ws';
      // Only the pinned protocol version is retained; never a browser credential/target.
      const protocol=url.searchParams.get('orchestrationProtocol');if(protocol)target.searchParams.set('orchestrationProtocol',protocol);
      const up=new WebSocket(target,{headers:{Authorization:'Bearer '+options.nativeToken,Origin:nativeOrigin},maxPayload:16_777_216,perMessageDeflate:false,handshakeTimeout:10_000});
      const filter=current.mode==='native-operate' ? makeExecutionRpcFilter(options.executionGate) :
        makeReadRpcFilter({skillTrialGate:options.skillTrialGate}),pending=[];let pendingBytes=0,processing=Promise.resolve();
      let expire;
      const checkExpiry=()=>{
        const saved=sessions.get(current.id);
        if(!saved||saved.expires<=Date.now()||saved.environmentId!==current.environmentId||saved.mode!==current.mode){down.close(4401,'本机会话已失效');return;}
        expire=setTimeout(checkExpiry,Math.max(1,saved.expires-Date.now()));expire.unref();
      };
      checkExpiry();
      const send=data=> {if(up.readyState===WebSocket.OPEN)up.send(data);else if(up.readyState===WebSocket.CONNECTING){pendingBytes+=Buffer.byteLength(data);if(pendingBytes>1_048_576)throw Error('Read queue limit');pending.push(data);}else throw Error('Native disconnected');};
      up.on('open',()=>{audit.upstreamSocketsOpened++;for(const data of pending)up.send(data);pending.length=0;});
      down.on('message',(bytes,binary)=> {
        processing=processing.then(async()=>{try {
          if(binary)throw Error('JSON required');
          if(down.readyState!==WebSocket.OPEN)return;
          const {forward,rejected,replayed=[]}=await filter.filter(bytes.toString());
          for(const item of rejected){count(audit.rpcRejected,'readonly');down.send(JSON.stringify(item));}
          for(const item of replayed)down.send(JSON.stringify(item));
          for(const item of forward){if(item._tag==='Request')count(audit.rpcAllowed,item.tag);send(JSON.stringify(item));}
        }catch{down.close(1008,'请求无效');}});
      });
      up.on('message',(bytes,binary)=> {
        try {if(binary)throw Error('JSON required');filter.receive(bytes.toString());if(down.readyState===WebSocket.OPEN)down.send(bytes.toString());}
        catch{down.close(1011,'原服务读取失败');}
      });
      up.on('error',()=>{audit.upstreamFailures++;down.close(1011,'原服务读取失败');});
      up.on('close',()=>down.close(1011,'原服务已断开'));
      down.on('error',()=>up.terminate());
      down.on('close',()=>{clearTimeout(expire);sockets.delete(down);up.terminate();});
    });
  });
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(options.port??0,'127.0.0.1',done);});
  origin='http://127.0.0.1:'+server.address().port;
  return {origin,token,audit:()=>structuredClone({...audit,...(options.skillTrialGate ? {skillTrial:options.skillTrialGate.audit()} : {})}),close:async()=>{
    sessions.clear();tickets.clear();for(const socket of sockets)socket.terminate();wss.close();server.closeAllConnections();
    await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));
    options.skillTrialGate?.close();
  }};
}
