import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, realpath, mkdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startNativeReadMount } from '../../../desktop-pet/workbench/native-mount/server.mjs';
import { nativeTarget } from '../t3-browser.mjs';
import { verifyNativeReadAssetPaths } from './build-native-read-renderer.mjs';
import { openDailyExecutionGate } from '../../../desktop-pet/workbench/native-mount/daily-execution.mjs';
import { createDailyBoardService } from '../../../desktop-pet/workbench/independent-blackboard/service.mjs';
import { createEngineeringVoiceService } from '../../../desktop-pet/workbench/engineering-voice/service.mjs';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

/** The daily entry consumes the accepted renderer through the installed file pins. */
export async function verifyDailyNativeRenderer(projectRoot, runtimeFiles) {
  const directory = 'code/desktop-pet/t3-native/apps/web/dist';
  const root = resolve(projectRoot, directory), found = [];
  if (await realpath(root) !== root) throw Error('Native renderer must be an installed directory');
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file = resolve(dir, name), stat = await lstat(file);
      if (stat.isSymbolicLink()) throw Error('Unexpected renderer link');
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) {
        const path = relative(projectRoot, file).replaceAll('\\', '/');
        if (runtimeFiles[path] !== digest(await readFile(file))) throw Error('Unregistered or changed native renderer');
        found.push(path);
      } else throw Error('Unexpected renderer entry');
    }
  }
  await walk(root);
  const expected = Object.keys(runtimeFiles).filter(path => path.startsWith(directory + '/')).sort();
  if (!found.length || !found.includes(directory + '/index.html') ||
      JSON.stringify(found.sort()) !== JSON.stringify(expected)) throw Error('Incomplete native renderer registration');
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  verifyNativeReadAssetPaths(html);
  const mode = JSON.parse(await readFile(resolve(root, 'aaa-native-read-build.json'), 'utf8'));
  if (mode.version !== 1 || mode.mode !== 'native-read' || mode.base !== '/native/' ||
      mode.buildEnvironment?.VITE_AAA_NATIVE_READ !== '1' || mode.indexSha256 !== digest(html))
    throw Error('Expected the registered native-read build mode');
  return root;
}

/** Attach a browser boundary to the existing daily services; it owns no native task queue. */
export async function startDailyNativeMount(options) {
  const { projectRoot, runtimeFiles, service, client, managementOrigin, managementToken } = options;
  const nativeDist = await verifyDailyNativeRenderer(projectRoot, runtimeFiles);
  const native = await service.start();
  let webSocket = options.webSocket;
  if (!webSocket) {
    const ws = await import(pathToFileURL(resolve(options.runtimeSourceDir, 'apps/server/node_modules/ws/index.js')).href);
    webSocket = { WebSocket: ws.default, WebSocketServer: ws.default.WebSocketServer };
  }
  const originalToolOutputReader = async query => {
    try {
      const descriptor = await client.environmentDescriptor();
      if (descriptor.environmentId !== query.environmentId) return { status: 404, body: { error: 'original_tool_output_not_found' } };
      const { stdout } = await execute(options.nodeExecutable,
        [resolve(projectRoot, 'code/workbench/integration/engine-pins/daily-tool-output.mjs'),
          resolve(projectRoot, '.local/data/t3-home/userdata/state.sqlite'), JSON.stringify(query)],
        { timeout: 10000, maxBuffer: 12 * 1024 * 1024 });
      return JSON.parse(stdout);
    } catch { return { status: 503, body: { error: 'original_tool_output_unavailable' } }; }
  };
  let execution = null;
  if (options.codexHome) try { execution = await openDailyExecutionGate({ projectRoot, codexHome: options.codexHome, client }); }
  catch { /* Unverifiable execution retains the existing read mount. */ }
  let mount;
  let board;
  let engineeringVoice;
  if (execution && options.engineeringAsr) try {
    await mkdir(resolve(projectRoot,'.local/data'),{recursive:true});
    engineeringVoice=createEngineeringVoiceService({directory:resolve(projectRoot,'.local/data/engineering-voice'),client,gate:execution.gate,asr:options.engineeringAsr});
  } catch { /* Private receipt failure closes speech admission only. */ }
  if(execution) try {
    const directory=resolve(projectRoot,'.local/data/independent-blackboard');
    await mkdir(resolve(projectRoot,'.local/data'),{recursive:true});
    board=createDailyBoardService({directory,client,gate:execution.gate});
  } catch { /* Unsafe board state closes only collaboration; original daily services remain usable. */ }
  const independentBlackboardReader=async scope=>{
    if(!board)return{status:404,body:{error:'board_unavailable'}};
    try{return{status:200,body:await board.read(scope)};}
    catch{return{status:404,body:{error:'board_unavailable'}};}
  };
  try { mount = await startNativeReadMount({ managementOrigin, managementToken,
    nativeOrigin: native.origin, nativeToken: native.accessToken, webSocket,
    uiRoot: resolve(projectRoot, 'code/desktop-pet/management/ui'), nativeDist,
    presentationReadPaths: options.presentationReadPaths ?? [], originalToolOutputReader,
    nativeBrowserTarget: target => nativeTarget(client, target), managementBrowserEntry: true, port: 0,
    independentBlackboardReader,...(board?{independentBlackboardService:board}:{}),
    ...(engineeringVoice?{engineeringVoiceService:engineeringVoice}:{}),
    ...(execution ? { executionGate: execution.gate } : {}) });
    board?.setOrigin(mount.origin);
  }
  catch (error) { try { await mount?.close(); } finally { execution?.close(); } throw error; }
  return { origin: mount.origin, audit: mount.audit, async close() { try { await mount.close(); } finally { execution?.close(); } },
    independentGroupAvailable() { return !!board; },
    async registerIndependentGroup(input) {
      if (!board) throw Error('original_board_unavailable');
      return board.register(input);
    },
    async readIndependentGroupRegistration(scope) {
      if (!board) throw Error('original_board_unavailable');
      const saved = board.registry.load(scope);
      if (!saved) return null;
      const exposed = board.registry.publicRegistration(saved);
      return { ...exposed, registrationDigest: saved.registrationDigest,
        coordinatorClientPath: resolve(projectRoot, 'code/desktop-pet/workbench/independent-blackboard/client.mjs'),
        participants: exposed.participants.map(actor => ({ ...actor,
          original: saved.participants.find(p => p.actorId === actor.actorId).original })) };
    },
    async openBrowser(target, controls) {
      // Target identities are rechecked when issuing and consuming the one-use ticket.
      const response = await fetch(mount.origin + '/api/native-mount/open-browser', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: 'Bearer ' + mount.token, Origin: mount.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...target, ...(controls?.returnToOriginalManagement ? { originalManagementReturn: true } : {}) }),
      });
      if (!response.ok) throw Error('Daily native browser handoff unavailable');
      return response.json();
    } };
}
