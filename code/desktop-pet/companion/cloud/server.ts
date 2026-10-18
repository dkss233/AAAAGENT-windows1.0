import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { CloudError, fields, id, parseEvent, parseParticipation, record, text, version, type SocialModel } from './protocol.js';
import { SocialStore } from './store.js';

export class SocialWorker {
  private active=false;
  private readonly abort=new AbortController();
  constructor(private readonly store:SocialStore,private readonly model:SocialModel,private readonly maxRequestsPerDay=100){}
  async tick():Promise<boolean>{
    if(this.active||this.abort.signal.aborted)return false;
    const claimed=this.store.claim(this.maxRequestsPerDay);if(!claimed)return false;
    this.active=true;
    try{this.store.complete(claimed.job.event_id,claimed.lease,await this.model.reply(claimed.input,this.abort.signal));}
    catch(error){const code=error instanceof CloudError?error.code:'model_outcome_unknown';this.store.fail(claimed.job.event_id,claimed.lease,code,code==='model_retryable');}
    finally{this.active=false;}
    return true;
  }
  async close():Promise<void>{this.abort.abort();while(this.active)await new Promise(resolve=>setTimeout(resolve,10));}
}
export interface ServerOptions {
  store:SocialStore;model:SocialModel;tokens:{admin:string;channel:string;sync:string};
  host?:string;port?:number;maxRequestsPerDay?:number;autoWork?:boolean;
}
const authorized=(actual:string|undefined,expected:string)=>{
  const a=Buffer.from(actual??''),b=Buffer.from(`Bearer ${expected}`);return a.length===b.length&&timingSafeEqual(a,b);
};
async function body(req:IncomingMessage):Promise<Record<string,unknown>>{
  if(!req.headers['content-type']?.startsWith('application/json'))throw new CloudError('json_required',415);
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>32000)throw new CloudError('request_too_large',413);chunks.push(chunk);}
  try{return record(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch(error){if(error instanceof CloudError)throw error;throw new CloudError('invalid_json');}
}
function send(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));}
export async function startSocialServer(options:ServerOptions){
  const {store,tokens}=options;
  if(Object.values(tokens).some(t=>typeof t!=='string'||t.length<32)||new Set(Object.values(tokens)).size!==3)throw new CloudError('distinct_service_tokens_required');
  const max=options.maxRequestsPerDay??100;if(!Number.isSafeInteger(max)||max<1||max>10000)throw new CloudError('invalid_daily_request_limit');
  store.recover();
  const worker=new SocialWorker(store,options.model,max);
  const server=createServer(async(req,res)=>{
    try{
      if(req.headers.origin)throw new CloudError('browser_requests_not_allowed',403);
      const url=new URL(req.url??'/', 'http://localhost');
      if(req.method==='GET'&&url.pathname==='/health'){send(res,200,{ok:true,protocol:1});return;}
      const prefix=`/v1/${store.roleId}/`;
      if(!url.pathname.startsWith(prefix))throw new CloudError('route_not_found',404);
      const route=url.pathname.slice(prefix.length);
      const role=authorized(req.headers.authorization,tokens.admin)?'admin':authorized(req.headers.authorization,tokens.channel)?'channel':authorized(req.headers.authorization,tokens.sync)?'sync':undefined;
      if(!role)throw new CloudError('unauthorized',401);
      const requireRole=(wanted:typeof role)=>{if(role!==wanted)throw new CloudError('forbidden',403);};
      if(req.method==='GET'&&route==='sync'){requireRole('sync');send(res,200,store.sync(version(Number(url.searchParams.get('after')??0))));return;}
      if(req.method==='GET'&&route==='status'){requireRole('admin');send(res,200,store.status());return;}
      if(req.method==='GET'&&route==='jobs'){requireRole('admin');send(res,200,store.jobs());return;}
      if(req.method==='POST'&&route==='jobs/resolve'){requireRole('admin');const v=await body(req);fields(v,['eventId','action','receipt']);store.resolveJob(id(v.eventId),v.action as 'skip',v.receipt===undefined?undefined:id(v.receipt));send(res,200,{ok:true});return;}
      if(req.method==='PUT'&&route==='persona'){requireRole('admin');const v=await body(req);fields(v,['name','persona','expectedRevision']);send(res,200,store.setPersona(text(v.name,80),text(v.persona,3000),version(v.expectedRevision)));return;}
      if(req.method==='PUT'&&route==='group'){requireRole('admin');const v=await body(req);fields(v,['groupId','enabled','shareWithOwner','replyMode','expectedRevision']);send(res,200,store.setPolicy({groupId:id(v.groupId),enabled:v.enabled as boolean,shareWithOwner:v.shareWithOwner as boolean,replyMode:v.replyMode as 'addressed'|'all'},version(v.expectedRevision)));return;}
      if(req.method==='POST'&&route==='events'){requireRole('channel');send(res,202,store.accept(parseEvent(await body(req))));return;}
      if(req.method==='POST'&&route==='participations'){requireRole('channel');send(res,202,store.acceptParticipation(parseParticipation(await body(req))));return;}
      if(req.method==='POST'&&route==='deliveries/claim'){requireRole('channel');fields(await body(req),[]);send(res,200,{delivery:store.claimDelivery()});return;}
      if(req.method==='POST'&&route==='deliveries/ack'){requireRole('channel');const v=await body(req);fields(v,['deliveryId','lease','receipt']);store.acknowledge(id(v.deliveryId),text(v.lease,128),id(v.receipt));send(res,200,{ok:true});return;}
      if(req.method==='POST'&&route==='deliveries/fail'){requireRole('channel');const v=await body(req);fields(v,['deliveryId','lease','outcome']);store.deliveryFailed(id(v.deliveryId),text(v.lease,128),v.outcome as 'unknown');send(res,200,{ok:true});return;}
      if(req.method==='DELETE'&&route.startsWith('experiences/')){requireRole('admin');store.forget(id(route.slice('experiences/'.length)));send(res,200,{ok:true});return;}
      throw new CloudError('route_not_found',404);
    }catch(error){if(!res.headersSent)send(res,error instanceof CloudError?error.status:500,{error:error instanceof CloudError?error.code:'internal_error'});else res.destroy();}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=32;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,options.host??'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw Error('missing_address');
  const timer=options.autoWork===false?undefined:setInterval(()=>{void worker.tick().catch(()=>{});},1000);timer?.unref();
  return{url:`http://127.0.0.1:${address.port}`,port:address.port,worker,async close(){if(timer)clearInterval(timer);await worker.close();await new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeIdleConnections();});}};
}
