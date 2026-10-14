import { randomBytes } from 'node:crypto';

export const landingHtml = '<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>打开工作台</title><body><p id="state">正在连接完整工作台…</p><script src="/open.js"></script></body></html>';
export const landingScript = `const ticket=location.hash.slice(1);history.replaceState(null,'','/open');
fetch('/launch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})})
.then(async r=>{if(!r.ok)throw Error();const v=await r.json();const u=new URL(v.url);
if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.hash)throw Error();location.replace(u.href);})
.catch(()=>{document.getElementById('state').textContent='这次打开未完成或入口已过期，请回原页面重新打开。任务不会重新派发。';});`;

/** Short-lived navigation tickets hold a fixed target, never a native credential. */
export class BrowserTickets {
  #entries = new Map();
  constructor(now = Date.now) { this.now = now; }
  issue(target) {
    for (const [id, entry] of this.#entries) if (entry.until <= this.now()) this.#entries.delete(id);
    if (this.#entries.size >= 64) throw Error('Too many pending browser entries');
    const ticket = randomBytes(32).toString('base64url'), until = this.now() + 60000;
    this.#entries.set(ticket, { target: structuredClone(target), until });
    return { ticket, expiresAt: new Date(until).toISOString() };
  }
  consume(ticket) {
    if (typeof ticket !== 'string') throw Error('Invalid browser entry');
    const entry = this.#entries.get(ticket); this.#entries.delete(ticket);
    if (!entry || entry.until <= this.now()) throw Error('Expired browser entry');
    return entry.target;
  }
}

const identifier = x => typeof x === 'string' && x.length > 0 && x.length <= 250 && !/[\x00-\x1f\x7f]/.test(x);
/** Rechecks native identity immediately before pairing; no caller-supplied URL is accepted. */
export async function nativeTarget(client, target) {
  if (!target || !['home','project','task'].includes(target.kind) || !identifier(target.environmentId)) throw Error('Invalid target');
  const descriptor = await client.environmentDescriptor();
  if (descriptor.environmentId !== target.environmentId) throw Error('Native environment changed');
  if (target.kind === 'home') return '/';
  if (!identifier(target.t3ProjectId) || typeof target.workspaceRoot !== 'string') throw Error('Invalid project');
  const snapshot = await client.shellSnapshot();
  const projects = snapshot.projects.filter(p => p.id === target.t3ProjectId && p.workspaceRoot === target.workspaceRoot && !p.deletedAt);
  if (projects.length !== 1) throw Error('Native project changed');
  if (target.kind === 'project') return '/?aaaProject=' + encodeURIComponent(target.t3ProjectId) + '&aaaEnvironment=' + encodeURIComponent(target.environmentId);
  if (!identifier(target.threadId) || !identifier(target.providerInstanceId)) throw Error('Invalid thread');
  const { thread } = await client.threadSnapshot(target.threadId, 1);
  if (!thread || thread.id !== target.threadId || thread.projectId !== target.t3ProjectId || thread.deletedAt ||
      thread.modelSelection?.instanceId !== target.providerInstanceId) throw Error('Native task changed');
  return '/' + encodeURIComponent(target.environmentId) + '/' + encodeURIComponent(target.threadId);
}
