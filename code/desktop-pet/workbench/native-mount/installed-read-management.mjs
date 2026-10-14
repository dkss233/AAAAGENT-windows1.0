import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Reuses the installed HTTP controller and its real configuration readers.
// No trial-backend, RuntimeManagement bootstrap, store, worker or device is started.
export async function startInstalledReadManagement(root, uiRoot) {
  const load = path => import(pathToFileURL(resolve(root,'code/desktop-pet/dist',path)).href);
  const [{readActiveTrialConfiguration},{verifyTrialRuntime},{RegisteredVoiceStore},
    {ManagementSettingsStore},{accountingSnapshot},{credentialRegistry},{availableAdapters},
    {ManagementRuntime},{startManagementServer},{COMPANION_ID,COMPANION_LABEL}] = await Promise.all([
    load('app/trial-config.js'),load('app/trial-launcher.js'),load('providers/registered-voices.js'),load('management/settings-store.js'),
    load('management/accounting.js'),load('management/credentials.js'),load('management/settings.js'),
    load('management/runtime.js'),load('management/server.js'),load('contracts/character.js'),
  ]);
  const directory=resolve(root,'artifacts/W0-I/model-evaluation/trial/user-trial');
  const base=await readActiveTrialConfiguration(resolve(directory,'config.json'),resolve(directory,'activation.json'));
  if(base.sourceRevision!=='361faf1272481d81b2c521e6e059f772081de7b2'||base.projectRoot!==root)throw Error('Installed management input changed');
  await verifyTrialRuntime(base);
  const db=new DatabaseSync(base.database,{readOnly:true});
  let characters;
  try {
    characters=db.prepare('SELECT character_id AS id,revision FROM characters ORDER BY character_id').all();
    if(characters.length!==1||characters[0].id!==COMPANION_ID)throw Error('Existing role input mismatch');
    characters=characters.map(c=>({...c,label:COMPANION_LABEL}));
  } finally {db.close();}
  const voices=await RegisteredVoiceStore.open(resolve(root,'.local/data/registered-voices.json'));
  const existingSettings=await ManagementSettingsStore.open(resolve(directory,'management-settings.json'),base,voices);
  // Even the private upstream HTTP controller has no configuration writer.
  const settings={snapshot:()=>existingSettings.snapshot(),drain:()=>existingSettings.drain()};
  const runtime=new ManagementRuntime(base.sourceRevision);
  // The original controller reads memory.dynamics before choosing its snapshot
  // route. Only actual character metadata is available here; no memory engine.
  const memory={characters:()=>characters,dynamics:undefined};
  const server=await startManagementServer({uiRoot,settings,memory,snapshot:async()=>({
    apiVersion:1,accounting:await accountingSnapshot(base),runtime:runtime.identity(),
    modules:runtime.modules().map(m=>({...m,status:m.id==='backend'?'ready':'unavailable',
      detail:m.id==='backend'?'当前进程提供真实配置与工程读取；桌宠后台已退出。':'桌宠后台未运行；此入口不启动模型、记忆处理或设备。'})),
    events:runtime.recentEvents(),settings:existingSettings.snapshot(),
    adapters:availableAdapters(base,voices),credentials:credentialRegistry(base).list(),
    characters,
  })});
  return {...server,identity:runtime.identity(),mode:'installed-config-readonly',
    effects:{trialBackend:false,runtimeManagementBootstrap:false,businessStoresCreated:0,readonlyRoleDatabaseRead:true,workers:false,
      terminalRecovery:false,balanceRefresh:false,devices:false,configurationWriter:false}};
}
