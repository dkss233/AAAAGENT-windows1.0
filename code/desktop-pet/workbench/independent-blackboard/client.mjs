import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readPrivateBoardJson } from './registry.mjs';

/** Role credentials are read only from the actor's private context and sent in an HTTP header. */
export async function boardActorRequest(contextFile, kind, body = {}, { operationId = randomUUID(), expectedRevision, transport = fetch } = {}) {
  if(kind==='read'&&expectedRevision===undefined) {
    const current=await boardActorRequest(contextFile,'snapshot',{}, {transport});
    expectedRevision=current.snapshot?.revision;
    if(!Number.isSafeInteger(expectedRevision))throw Error('board_revision_unavailable');
  }
  const context = readPrivateBoardJson(contextFile), runtime = readPrivateBoardJson(context.originFile);
  if(context.version!=='0.1.0'||runtime.version!=='0.1.0'||typeof context.capability!=='string'||!/^[a-f0-9]{64}$/.test(context.capability))throw Error('invalid_actor_context');
  const url = new URL(runtime.origin);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('local_board_origin_required');
  const response = await transport(url.origin + '/api/independent-blackboard/actor', {
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:'Bearer '+context.capability,Origin:url.origin,'Content-Type':'application/json'},
    body:JSON.stringify({scope:context.scope,actorId:context.actorId,operationId,kind,body,...(expectedRevision===undefined?{}:{expectedRevision})}),
  });
  const raw=await response.text();if(raw.length>2*1024*1024)throw Error('board_response_too_large');
  let value;try{value=JSON.parse(raw);}catch{throw Error('board_response_invalid');}
  if(!response.ok)throw Error(typeof value.error==='string'?value.error:'board_request_rejected');
  return value;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2),index=args.indexOf('--context');
    if(index!==0||!args[1]||!args[2])throw Error('usage_context_kind_json_input_required');
    const raw=args[3]?readFileSync(args[3]==='-'?0:resolve(args[3]),'utf8'):null;
    if(raw!==null&&Buffer.byteLength(raw)>65536)throw Error('actor_input_too_large');
    const input=raw!==null?JSON.parse(raw):{};
    // Each mutating operation supplies the revision from its preceding read.
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['body','operationId','expectedRevision'].includes(k)))throw Error('invalid_actor_input');
    const value=await boardActorRequest(resolve(args[1]),args[2],input.body??{},input);
    process.stdout.write(JSON.stringify(value)+'\n');
  } catch { process.stderr.write('共享黑板操作未完成；保留原operationId并先查询当前记录，派发未知时只查原回执。\n');process.exitCode=1; }
}
