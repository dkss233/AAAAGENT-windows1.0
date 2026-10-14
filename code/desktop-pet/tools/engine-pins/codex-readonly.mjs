import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readEngineProfile } from '../../../workbench/integration/engine-pins/profile.mjs';

/** Read-only real app-server inspection. No turn, prompt, login or account refresh operation. */
export async function inspectCodexInputs(root, { cwds = [], threadIds = [] } = {}) {
  const profile = readEngineProfile(root);
  if (!profile) throw Error('Project engine profile required');
  const child = spawn(profile.codexLauncher, ['app-server'], { cwd: root, stdio: ['pipe','pipe','pipe'] });
  child.stderr.resume(); const pending = new Map(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { let r; try { r = JSON.parse(line); } catch { return; }
    const p = pending.get(r.id); if (!p) return; pending.delete(r.id); clearTimeout(p.timer);
    r.error ? p.reject(Error('Read-only Codex method rejected')) : p.resolve(r.result); });
  const rpc = (method, params) => {
    if (!['initialize','account/read','skills/list','thread/read','thread/turns/list'].includes(method)) throw Error('Read-only method required');
    const requestId = ++id; return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error('Read-only Codex timeout: ' + method)); }, 15000);
      pending.set(requestId, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
    });
  };
  child.on('error', () => { for (const p of pending.values()) p.reject(Error('Codex launcher unavailable')); });
  child.on('exit', () => { for (const p of pending.values()) p.reject(Error('Codex read-only process exited')); });
  try {
    await rpc('initialize', { clientInfo: { name: 'aaaagent_owned_inputs_readonly', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const account = await rpc('account/read', { refreshToken: false });
    const skills = await rpc('skills/list', { cwds, forceReload: true });
    const threads = [];
    for (const threadId of threadIds) {
      const read = await rpc('thread/read', { threadId, includeTurns: false });
      if (read.thread.id !== threadId) throw Error('Original thread identity changed');
      let turns;
      if (read.thread.historyMode !== 'paginated') {
        const full = await rpc('thread/read', { threadId, includeTurns: true });
        if (full.thread.id !== threadId) throw Error('Original thread identity changed');
        turns = full.thread.turns;
      } else {
        turns = []; let cursor = null; const seen = new Set();
        do {
          if (seen.has(cursor)) throw Error('Repeated original history cursor'); seen.add(cursor);
          const page = await rpc('thread/turns/list', { threadId, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full' });
          if (!Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) throw Error('Original history page malformed');
          turns.push(...page.data); cursor = page.nextCursor;
        } while (cursor !== null);
      }
      threads.push({ id: threadId, turns: turns.length, items: turns.reduce((n,t)=>n+t.items.length,0), readable: true });
    }
    return { account: { type: account.account?.type ?? null, authenticated: !!account.account, requiresOpenaiAuth: account.requiresOpenaiAuth },
      skills: skills.data.map(row => ({ cwd: row.cwd, names: row.skills.map(s => s.name), errors: row.errors.length })),
      threads, modelRequests: 0, turnStarts: 0 };
  } finally {
    lines.close(); for (const p of pending.values()) clearTimeout(p.timer); child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(done => child.once('exit', done)); child.kill('SIGTERM');
      let timer; await Promise.race([exited,new Promise(done => { timer = setTimeout(done,5000); })]); clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
  }
}
