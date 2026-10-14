import { spawn } from 'node:child_process';
import { isPrivateDirectorySync, isPrivateFileSync, restrictPrivatePathSync } from '../../dist/core/platform-files.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const boardDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const boardId = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 250 && !/[\u0000-\u001f\u007f]/u.test(value);
const store = fileURLToPath(new URL('./store.py', import.meta.url));
const pythonCode = 'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("board",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); v=json.load(sys.stdin); a=v["action"]; print(m.canonical(m.initialize(v["database"],v["registry"]) if a=="initialize" else m.snapshot(v["database"],v["scope"]) if a=="snapshot" else m.apply(v["database"],v["request"],v["capability"])))';

/** The existing transaction store remains authoritative. Secrets use stdin, never argv or logs. */
export function runBoardStore(input, python = process.env.AAAAGENT_BOARD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')) {
  return new Promise((accept, reject) => {
    const child = spawn(python, ['-X', 'utf8', '-I', '-c', pythonCode, store], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let bytes = 0, settled = false; const output=[];
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : accept(value); };
    const timer = setTimeout(() => { child.kill(); finish(Error('board_store_unavailable')); }, 10000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { child.kill(); finish(Error('board_store_unavailable')); } else output.push(Buffer.from(chunk)); });
    child.stderr.resume();
    child.on('error', () => finish(Error('board_store_unavailable')));
    child.on('close', code => { try { if (code !== 0) throw Error(); finish(null, JSON.parse(Buffer.concat(output).toString('utf8'))); } catch { finish(Error('board_store_rejected')); } });
    child.stdin.on('error', () => finish(Error('board_store_unavailable')));
    child.stdin.end(JSON.stringify(input));
  });
}

export function readPrivateBoardJson(file) {
  const stat = lstatSync(file);
  if (!isPrivateFileSync(file, stat) || stat.size > 1024 * 1024) throw Error('unsafe_board_state');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writePrivateBoardJson(file, value, create = false) {
  const parent = dirname(file);
  if (realpathSync(parent) !== parent || !isPrivateDirectorySync(parent)) throw Error('unsafe_board_directory');
  if (create) { writeFileSync(file, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 }); restrictPrivatePathSync(file); return; }
  if (existsSync(file)) readPrivateBoardJson(file);
  const temporary = join(parent, '.write-' + randomBytes(12).toString('hex'));
  writeFileSync(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
  restrictPrivatePathSync(temporary);
  renameSync(temporary, file);
}

/** One persistent product directory per exact environment/project; registration creates no native session. */
export function createBoardRegistry({ directory, verifyParticipants, python = process.env.AAAAGENT_BOARD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }) {
  if (resolve(directory) !== directory || typeof verifyParticipants !== 'function') throw Error('board_registry_required');
  const parent = dirname(directory);
  if (realpathSync(parent) !== parent) throw Error('unsafe_board_parent');
  if (!existsSync(directory)) { mkdirSync(directory, { mode: 0o700 }); restrictPrivatePathSync(directory); }
  if (realpathSync(directory) !== directory || !isPrivateDirectorySync(directory)) throw Error('unsafe_board_directory');
  const scopeKey = scope => {
    if (!scope || !boardId(scope.environmentId) || !boardId(scope.projectId) || Object.keys(scope).some(k => !['environmentId', 'projectId'].includes(k))) throw Error('invalid_board_scope');
    return boardDigest([scope.environmentId, scope.projectId]);
  };
  const location = scope => join(directory, scopeKey(scope));
  function load(scope) {
    const folder = location(scope);
    if (!existsSync(folder)) return null;
    if (realpathSync(folder) !== folder || !isPrivateDirectorySync(folder)) throw Error('unsafe_board_directory');
    const saved = readPrivateBoardJson(join(folder, 'registry.json'));
    if (saved.version !== '0.1.0' || boardDigest(saved.scope) !== boardDigest(scope) || saved.folder !== folder) throw Error('board_scope_changed');
    return saved;
  }
  return {
    directory, load, location,
    async register(input) {
      if (!input || Object.keys(input).some(k => !['scope', 'participants', 'dispatchAuthorization'].includes(k))) throw Error('invalid_registration');
      scopeKey(input.scope);
      const actors = input.participants;
      if (!Array.isArray(actors) || actors.length < 2 || actors.length > 16 || actors.filter(a => a?.role === 'coordinator').length !== 1 || new Set(actors.map(a => a?.actorId)).size !== actors.length || new Set(actors.map(a => a?.threadId)).size !== actors.length || actors.some(a => !a || Object.keys(a).some(k => !['actorId','threadId','providerInstanceId','role','title'].includes(k)) || ![a.actorId,a.threadId,a.title].every(boardId) || a.providerInstanceId !== 'codex' || !['coordinator','executor'].includes(a.role))) throw Error('invalid_participants');
      const grant = input.dispatchAuthorization ?? null;
      if (grant && (Object.keys(grant).some(k => !['authorizationId','maxDispatches','expiresAt'].includes(k)) || !boardId(grant.authorizationId) || !Number.isSafeInteger(grant.maxDispatches) || grant.maxDispatches < 1 || grant.maxDispatches > 100 || !Number.isFinite(Date.parse(grant.expiresAt)))) throw Error('invalid_dispatch_authorization');
      const digest = boardDigest(input), previous = load(input.scope);
      if (previous) { if (previous.registrationDigest !== digest) throw Error('registration_frozen'); return this.publicRegistration(previous); }
      const verified = await verifyParticipants(input.scope, actors);
      if (!Array.isArray(verified) || verified.length !== actors.length) throw Error('original_identity_unavailable');
      const folder = location(input.scope);
      mkdirSync(folder, { mode: 0o700 });
      restrictPrivatePathSync(folder);
      const participants = actors.map((actor, index) => ({ ...actor, original: verified[index] }));
      const capabilities = participants.map(() => randomBytes(32).toString('hex'));
      participants.forEach((actor,i)=>{actor.capabilitySha256=createHash('sha256').update(capabilities[i]).digest('hex');});
      const saved = { version: '0.1.0', boardId: 'board-' + scopeKey(input.scope), scope: input.scope, folder, registrationDigest: digest, participants, dispatchAuthorization: grant, createdAt: new Date().toISOString() };
      const database = join(folder, 'board.sqlite');
      await runBoardStore({ action: 'initialize', database, registry: { boardId: saved.boardId, scope: saved.scope, participants: participants.map((a, i) => ({ actorId:a.actorId,threadId:a.threadId,providerInstanceId:a.providerInstanceId,title:a.title,role:a.role,capabilitySha256:createHash('sha256').update(capabilities[i]).digest('hex') })) } }, python);
      for (let i=0;i<participants.length;i++) writePrivateBoardJson(join(folder, 'actor-' + boardDigest(participants[i].actorId) + '.json'), { version:'0.1.0',scope:saved.scope,actorId:participants[i].actorId,capability:capabilities[i],originFile:join(directory,'runtime.json') }, true);
      writePrivateBoardJson(join(folder, 'dispatches.json'), { version:'0.1.0',records:{} }, true);
      writePrivateBoardJson(join(folder, 'registry.json'), saved, true);
      return this.publicRegistration(saved);
    },
    publicRegistration(saved) { return { version:saved.version,boardId:saved.boardId,scope:saved.scope,dispatchEnabled:!!saved.dispatchAuthorization,participants:saved.participants.map(a => ({ actorId:a.actorId,threadId:a.threadId,role:a.role,contextFile:join(saved.folder,'actor-' + boardDigest(a.actorId)+'.json') })) }; },
    authenticate(saved, actorId, capability) {
      const actor = saved.participants.find(a => a.actorId === actorId);
      if (!actor || typeof capability !== 'string' || !/^[a-f0-9]{64}$/.test(capability)) throw Error('actor_not_authorized');
      const context = readPrivateBoardJson(join(saved.folder,'actor-' + boardDigest(actorId)+'.json'));
      if(context.version!==saved.version||context.actorId!==actorId||boardDigest(context.scope)!==boardDigest(saved.scope)||context.originFile!==join(directory,'runtime.json')||typeof context.capability!=='string'||!/^[a-f0-9]{64}$/.test(context.capability)||createHash('sha256').update(context.capability).digest('hex')!==actor.capabilitySha256)throw Error('actor_context_changed');
      if (!timingSafeEqual(Buffer.from(context.capability),Buffer.from(capability))) throw Error('actor_not_authorized');
      return actor;
    },
    snapshot(saved) { return runBoardStore({ action:'snapshot',database:join(saved.folder,'board.sqlite'),scope:saved.scope },python); },
    apply(saved, request, capability) { return runBoardStore({ action:'apply',database:join(saved.folder,'board.sqlite'),request,capability },python); },
  };
}
