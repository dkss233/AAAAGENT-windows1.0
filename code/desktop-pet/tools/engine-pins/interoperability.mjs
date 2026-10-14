// Canonical bounded operator; S remains the sole ledger writer. No dispatch retries.
import { readFileSync, writeFileSync, renameSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readEngineProfile } from '../../../workbench/integration/engine-pins/profile.mjs';
import { T3LocalService } from '../../../workbench/integration/t3-local-service.mjs';
import { T3HttpClient } from '../../../workbench/integration/t3-http-client.mjs';

const root = resolve(import.meta.dirname, '../../../..');
const configPath = join(root, 'artifacts/W0-I/engine-pin-54/interoperability/config.json');
const ledgerPath = join(root, 'artifacts/W0-I/engine-pin-54/interoperability/ledger.json');
const evidence = join(root, 'artifacts/W0-S/workbench-54/engine-pin');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.projectRoot !== root || config.operator !== 'W0-S' ||
    config.startsMax !== 4 || config.perExecutorStartsMax !== 2 ||
    realpathSync(config.workspace) !== config.workspace) throw Error('Test scope mismatch');
const actualConfig = JSON.parse(readFileSync(join(root,'artifacts/W0-I/model-evaluation/trial/user-trial/config.json'),'utf8'));
if (actualConfig.sourceRevision !== config.source) throw Error('Installed source differs from test scope');
const ownership = JSON.parse(readFileSync(join(root,'docs/agent/blackboard/OWNERSHIP.json'),'utf8'));
const operator = ownership.tasks.find(value => value.task_id === 'W0-S');
const [action,executor]=process.argv.slice(2);
const readonlyAction=['inspect','read','status'].includes(action);
if (!operator?.bounded_interoperability || (!readonlyAction &&
    (!operator.model_execution_authorized || !operator.paid_execution_authorized))) throw Error('Formal sending scope is closed');
if (operator.bounded_interoperability.configSha256 !== createHash('sha256').update(readFileSync(configPath)).digest('hex') ||
    operator.bounded_interoperability.source !== config.source ||
    config.operatorSha256 !== createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'))
  throw Error('Formal configuration or operator source changed');
const profile = readEngineProfile(root);
const host = JSON.parse(readFileSync(join(config.t3Home, '.aaaagent-t3-host.json'), 'utf8'));
const service = new T3LocalService({ sourceDir: host.sourceDir,
  nodeExecutable: profile.runtime.nodeExecutable, baseDir: config.t3Home,
  logFile: join(root,'data/desktop-pet/logs/t3-workbench.log'),
  engineProjectRoot: root, dshWebLogPath: profile.dshWebLog });
const client = new T3HttpClient(service);
const env = await client.environmentDescriptor();
const connection = await service.start();
if (connection.origin !== config.t3Origin || !env.environmentId) throw Error('Wrong T3 environment');
const now = () => new Date().toISOString();
const save = (name, value) => writeFileSync(join(evidence, name), JSON.stringify(value,null,2)+'\n', {flag:'wx',mode:0o600});
function writeLedger(ledger) {
  if (lstatSync(ledgerPath).isSymbolicLink()) throw Error('Ledger link');
  const temp=ledgerPath+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,JSON.stringify(ledger,null,2)+'\n',{flag:'wx',mode:0o600});
  renameSync(temp,ledgerPath);
}
function reserve(executor, origin, nativeId) {
  if (Date.now()>=Date.parse(config.expiresAt)) throw Error('Test window expired');
  const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));
  const original = ledger.entries.filter(entry => !['t3-replacement','native-replacement'].includes(entry.origin));
  if (ledger.runId !== config.runId || ledger.remaining !== 4-original.length) throw Error('Original ledger mismatch');
  if (origin === 't3-replacement') {
    const replacement=config.codexReplacement;
    const proofBytes=readFileSync(join(root,replacement?.failureEvidence ?? 'missing'));
    const proof=JSON.parse(proofBytes);
    if (executor !== 'codex' || replacement?.authorized !== true || replacement.maxAttempts !== 1 ||
        replacement.source !== config.source || replacement.t3ThreadId !== config.targets.codex.t3ThreadId ||
        replacement.expiresAt !== config.expiresAt || replacement.autoRetry !== false ||
        ledger.entries.some(entry => entry.origin === 't3-replacement') || ledger.entries.length>=5 ||
        original.find(entry => entry.executor === 'codex' && entry.origin === 't3')?.state !== 'provider-start-failed' ||
        proof.providerTurnSent !== false || proof.commandId !== replacement.failedCommandId ||
        createHash('sha256').update(proofBytes).digest('hex') !== replacement.failureEvidenceSha256)
      throw Error('Replacement scope is not exact or already used');
  } else if(origin==='native-replacement') {
    const replacement=config.codexNativeReplacement;
    const failed=original.find(entry=>entry.executor==='codex'&&entry.origin==='native');
    const failureBytes=readFileSync(join(root,replacement?.failureEvidence??'missing'));
    const releaseBytes=readFileSync(join(root,replacement?.releaseEvidence??'missing'));
    const failure=JSON.parse(failureBytes),release=JSON.parse(releaseBytes);
    if(executor!=='codex'||replacement?.authorized!==true||replacement.maxAttempts!==1||
      replacement.expiresAt!==config.expiresAt||replacement.autoRetry!==false||
      replacement.source!==config.source||replacement.t3ThreadId!==config.targets.codex.t3ThreadId||
      replacement.nativeId!==nativeId||ledger.nativeSessionIds.codex!==nativeId||
      replacement.maxTotalAttempts!==6||replacement.maxActualProviderModelTurns!==4||
      config.routes.codex.model!=='gpt-6-astra'||config.routes.codex.reasoningEffort!=='low'||
      ledger.remaining!==0||ledger.entries.length!==5||ledger.entries.some(x=>x.origin==='native-replacement')||
      failed?.state!=='native-app-send-rejected-active-writer'||failed.nativeId!==nativeId||failed.replayed!==false||
      failure.nativeThreadId!==nativeId||failure.nativeContinuation?.followupColdRead?.newTurnObserved!==false||
      failure.nativeContinuation?.followupColdRead?.nativeMarkerPresent!==false||failure.replayed!==false||
      release.target?.nativeThreadId!==nativeId||release.result?.after?.thread?.session?.status!=='stopped'||
      release.modelCalls!==0||!Object.values(release.protection??{}).every(value=>value===true)||
      createHash('sha256').update(failureBytes).digest('hex')!==replacement.failureEvidenceSha256||
      createHash('sha256').update(releaseBytes).digest('hex')!==replacement.releaseEvidenceSha256)
      throw Error('Native replacement scope changed or already used');
  } else if(original.length>=4 || original.filter(x=>x.executor===executor).length>=2 ||
            original.some(x=>x.executor===executor&&x.origin===origin)) throw Error('Attempt already used');
  const entry={executor,origin,nativeId:nativeId??null,t3ThreadId:config.targets[executor].t3ThreadId,
    marker:origin==='t3-replacement'?config.codexReplacement.marker:origin==='native-replacement'?config.codexNativeReplacement.marker:config.markers[executor][origin],
    ...(origin==='native-replacement'?{attemptId:config.codexNativeReplacement.attemptId}:{}),reservedAt:now(),state:'reserved-delivery-unknown'};
  ledger.entries.push(entry);ledger.remaining=4-ledger.entries.filter(x=>!['t3-replacement','native-replacement'].includes(x.origin)).length;ledger.status='running';writeLedger(ledger);
  return entry;
}
if(action==='inspect') {
  const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));
  console.log(JSON.stringify({source:config.source,origin:connection.origin,entries:ledger.entries.length,originalRemaining:ledger.remaining,replacement:config.codexReplacement?.commandId,turnsSent:0}));
} else if(action==='create') {
  const created=[];
  const commands=[{type:'project.create',commandId:config.projectCreateCommandId,
    projectId:config.projectId,title:'同一原生会话互通验收 '+config.runId,workspaceRoot:config.workspace,createdAt:now()},
    ...['codex','dsh'].map(name=>({type:'thread.create',commandId:config.targets[name].threadCreateCommandId,
      threadId:config.targets[name].t3ThreadId,projectId:config.projectId,title:config.targets[name].title,
      modelSelection:{instanceId:config.routes[name].providerInstanceId,
        model:config.routes[name].t3Model??config.routes[name].model,
        options:[{id:'reasoningEffort',value:config.routes[name].reasoningEffort}]},
      interactionMode:'default',runtimeMode:'approval-required',branch:null,worktreePath:null,createdAt:now()}))];
  for(const command of commands) {
    if(await client.readReceipt(command.commandId)) throw Error('Creation already attempted; read receipt only');
    const receipt=await client.createCommand(command);
    const actual=await client.readReceipt(command.commandId);
    created.push({type:command.type,id:command.projectId??command.threadId,commandId:command.commandId,receipt,actual});
    if(actual?.status!=='accepted') throw Error('Creation not confirmed; do not redispatch');
  }
  save('interop-metadata-created.json',{at:now(),environmentId:env.environmentId,source:config.source,created,modelStarts:0});
  console.log(JSON.stringify({environmentId:env.environmentId,created}));
} else if((action==='start' && ['codex','dsh'].includes(executor)) || (action==='start-replacement' && executor==='codex')) {
  const isReplacement=action==='start-replacement';
  const target=isReplacement?{...config.targets.codex,t3TurnCommandId:config.codexReplacement.commandId,t3MessageId:config.codexReplacement.messageId}:config.targets[executor];
  const origin=isReplacement?'t3-replacement':'t3',fileLabel=executor+(isReplacement?'-replacement':'');
  if(await client.readReceipt(target.t3TurnCommandId)) throw Error('Turn already attempted; cold-read only');
  const entry=reserve(executor,origin);
  const prompt='这是同一会话互通的独立测试。不要调用任何工具、不要修改文件、不要启动 Agent 或设备。请只回复以下唯一标记，原样照写：'+entry.marker;
  const command={type:'thread.turn.start',commandId:target.t3TurnCommandId,threadId:target.t3ThreadId,
    message:{messageId:target.t3MessageId,role:'user',text:prompt,attachments:[]},
    modelSelection:{instanceId:config.routes[executor].providerInstanceId,
      model:config.routes[executor].t3Model??config.routes[executor].model,
      options:[{id:'reasoningEffort',value:config.routes[executor].reasoningEffort}]},
    runtimeMode:'approval-required',interactionMode:'default',createdAt:now()};
  save('interop-'+fileLabel+'-first-command.json',{command,reservation:entry,environmentId:env.environmentId,source:config.source});
  try {
    const result=await client.dispatch(command);
    const actual=await client.readReceipt(command.commandId);
    const snapshot=await client.threadSnapshot(target.t3ThreadId,10);
    save('interop-'+fileLabel+'-first-receipt.json',{at:now(),result,actual,snapshot});
    const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));const own=ledger.entries.find(x=>x.executor===executor&&x.origin===origin);
    own.state=actual?.status==='accepted'?'accepted-awaiting-native-result':'delivery-unknown';
    own.dispatchReceipt=result;own.commandReceipt=actual;own.receiptAt=now();writeLedger(ledger);
    console.log(JSON.stringify({executor,result,actual,snapshot}));
  } catch(error) {
    save('interop-'+fileLabel+'-first-dispatch-error.json',{at:now(),error:{name:error.name,code:error.code,status:error.status},delivery:'unknown; no redispatch'});
    throw error;
  }
} else if(action==='read' && ['codex','dsh'].includes(executor)) {
  const snapshot=await client.threadSnapshot(config.targets[executor].t3ThreadId,20);
  save('interop-'+executor+'-cold-read-'+Date.now()+'.json',{at:now(),executor,snapshot});
  console.log(JSON.stringify({executor,snapshot}));
} else if(action==='reserve-native-replacement' && executor==='codex') {
  const replacement=config.codexNativeReplacement;
  const snapshot=await client.threadSnapshot(config.targets.codex.t3ThreadId,1);
  if(snapshot.thread?.session?.status!=='stopped'||snapshot.thread.session.activeTurnId!==null||
    snapshot.thread.latestTurn?.turnId!==replacement?.previousNativeTurnId||snapshot.thread.latestTurn.state!=='completed')
    throw Error('Exact original native handoff is no longer idle');
  console.log(JSON.stringify(reserve('codex','native-replacement',replacement?.nativeId)));
} else if(action==='reserve-native' && ['codex','dsh'].includes(executor)) {
  const ledger=JSON.parse(readFileSync(ledgerPath,'utf8'));const nativeId=ledger.nativeSessionIds[executor];
  if(!nativeId) throw Error('Exact native ID not recorded');
  console.log(JSON.stringify(reserve(executor,'native',nativeId)));
} else if(action==='status') {
  const status=await service.status();
  console.log(JSON.stringify(Object.fromEntries(Object.entries(status).filter(([k])=>!/(token|secret|credential|password)/i.test(k)))));
} else throw Error('Unknown bounded action');
