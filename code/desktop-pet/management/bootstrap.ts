import type { EmotionManagement } from '../contracts/emotion-state.js';
import { restrictPrivatePathSync } from '../core/platform-files.js';
import { createSelfSetup } from './self-setup.js';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { MemoryImportManagement } from '../contracts/memory-import.js';
import {ProviderBalances,readBalanceKey} from './balances.js';
import {FinanceCredentials} from './balance-credentials.js';
import {effectiveTrialConfiguration} from './settings.js';
import type { WakeManagement } from '../contracts/wake.js';
import type { WeChatManagement } from '../contracts/wechat.js';
import { readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { PresentationControls } from '../contracts/presentation-presets.js';
import { presentationAssetRoutes } from './presentation-assets.js';
import type { ManagementMemoryPort } from '../contracts/management.js';
import type { TrialConfiguration } from '../app/trial-config.js';
import { readDesktopCoordinatorProfile } from '../app/desktop-workbench.js';
import { ManagementSettingsStore } from './settings-store.js';
import { availableAdapters } from './settings.js';
import { credentialRegistry } from './credentials.js';
import { ManagementRuntime } from './runtime.js';
import { startManagementServer } from './server.js';
import type {PendingMemoryManagement} from './pending-memory.js';
import {accountingSnapshot} from './accounting.js';
import { SqliteProjectIndex } from '../projects/sqlite-project-index.js';
import { SqliteProjectMemory } from '../projects/project-memory-sqlite.js';
import { createProjectTerminalExtractor, type ProjectTerminalDeriver } from '../projects/project-terminal-extractor.js';
import type { ProjectTerminalModelCallPort, ProjectTerminalModelSelection,
  ProjectTerminalModelTransport } from '../contracts/project-terminal-processing.js';
import { assertProjectTerminalRetrySafe, createProjectTerminalModelCall } from './project-terminal-processing.js';
import { ProjectContextAssembler } from '../projects/project-context-assembler.js';
import { SqliteWorkbenchStore } from '../app/workbench-store.js';
import { WorkbenchService } from '../app/workbench-service.js';
import { reloadingWorkbenchTurnAuthorization, readIsolatedWorkbenchEnvironment, isolatedNativeBrowser, isolatedNativeFrameOrigin } from '../app/workbench-runtime.js';
import type { EngineeringAsrPort } from '../contracts/engineering-voice.js';
import type { T3LocalService } from '../../workbench/integration/t3-local-service.mjs';
import { homedir } from 'node:os';
import { HarnessForwarding } from '../harness/forwarding.js';
import { ForwardReceipts } from '../harness/receipts.js';
import { HarnessConnection } from '../harness/connection.js';
import { CodexAppConnection, verifyCodexAppBuild } from '../harness/codex-app.js';
import { harnessLaunchUrl, relayPresetReady, workPresetReady, RELAY_PRESET_ID } from '../harness/preset.js';
import type { EngineProfile } from '../../workbench/integration/engine-pins/profile.mjs';
import type { DailyNativeMount } from '../../workbench/integration/engine-pins/daily-native-mount.mjs';
import { harnessAccounting } from '../harness/accounting.js';
import { EvaluationBudget } from '../core/evaluation-budget.js';

export interface ProjectTerminalRuntimeRegistration {
  readonly selection: ProjectTerminalModelSelection;
  readonly transport: ProjectTerminalModelTransport;
  readonly createDeriver: (model: ProjectTerminalModelCallPort) => ProjectTerminalDeriver;
}

export async function startRuntimeManagement(base: TrialConfiguration, configFile: string, settings: ManagementSettingsStore,
  runtime: ManagementRuntime, memory: ManagementMemoryPort, presentation?: PresentationControls, pendingMemory?:PendingMemoryManagement, wechat?:WeChatManagement, wake?:WakeManagement, memoryImport?:MemoryImportManagement, emotion?:EmotionManagement,
  terminalProcessing?: ProjectTerminalRuntimeRegistration, engineeringAsr?: EngineeringAsrPort) {
  const effective=effectiveTrialConfiguration(base,settings.effective);
  const selfSetup=createSelfSetup({base,settings,instanceId:runtime.instanceId,mode:'runtime',runtimeReady:()=>{
    try{const raw=readFileSync(configFile,'utf8'),activation=JSON.parse(readFileSync(resolve(dirname(configFile),'activation.json'),'utf8'));
      return activation.status==='active'&&activation.phaseId===base.phaseId&&activation.configSha256===createHash('sha256').update(raw).digest('hex')&&JSON.stringify(JSON.parse(raw))===JSON.stringify(base);
    }catch{return false;}
  }});
  const deepseek=Object.values(effective.models).find(m=>m.provider==='deepseek'&&new URL(m.endpoint).hostname==='api.deepseek.com');
  const balances=new ProviderBalances({credentials:new FinanceCredentials(base.projectRoot),deepseekKey:()=>readBalanceKey(deepseek?.credentialFile)});
  let projects: SqliteProjectIndex | undefined;
  try { projects = new SqliteProjectIndex(resolve(base.projectRoot, '.local/data/project-index.sqlite')); }
  catch { process.stderr.write('Project index unavailable; companion data unchanged.\n'); }
  const t3SourceDir = process.env.AAAAGENT_T3_PREPARED_DIR;
  const t3Node = process.env.AAAAGENT_T3_NODE_EXECUTABLE;
  /** Harness working directory. AAAAGENT_HARNESS_WORKSPACE may point it at an existing tree;
   *  anything missing, relative or malformed keeps the project's own isolated workspace. */
  const harnessWorkspace = (profile: EngineProfile | undefined, fallbackBase: string): string => {
    const fallback = profile ? resolve(profile.home, 'workspace') : resolve(fallbackBase, 'workspace');
    const requested = process.env.AAAAGENT_HARNESS_WORKSPACE;
    if (!requested || !isAbsolute(requested) || /[\0\r\n]/.test(requested)) return fallback;
    try { return statSync(requested).isDirectory() ? requested : fallback; } catch { return fallback; }
  };
  let engineProfile: EngineProfile | undefined;
  let engineProfileInvalid = false;
  try { const { readEngineProfile } = await import(new URL('../../../workbench/integration/engine-pins/profile.mjs', import.meta.url).href);
    engineProfile = readEngineProfile(base.projectRoot); }
  catch { engineProfileInvalid = true; process.stderr.write('Project engine profile unavailable; no global engine fallback.\n'); }
  let workbench: WorkbenchService | undefined;
  let model: ProjectTerminalModelCallPort | null = null;
  let derive: ProjectTerminalDeriver | undefined;
  const terminalBudget = new EvaluationBudget(base.budgetFile, base.budgetBatchId, base.limitMicros);
  if (terminalProcessing && projects && t3SourceDir && t3Node) try {
    model = createProjectTerminalModelCall(effective, terminalProcessing.selection, terminalProcessing.transport, terminalBudget);
    if (model) derive = terminalProcessing.createDeriver(model);
  } catch { process.stderr.write('Project terminal processing unavailable; no provider request started.\n'); }
  let projectMemory: SqliteProjectMemory | undefined;
  if (projects) try {
    const materialPort = {
      readTerminalMaterial: evidence => {
        if (!workbench) throw new Error('Exact native task reader unavailable');
        return workbench.readTerminalMaterial(evidence);
      },
    } satisfies Parameters<typeof createProjectTerminalExtractor>[0];
    const extractor = derive && terminalProcessing ? async (evidence: Parameters<ProjectTerminalDeriver>[0]['evidence'], attemptOrdinal: number) => {
      const attemptDeriver = attemptOrdinal === 1 ? derive : terminalProcessing.createDeriver(
        createProjectTerminalModelCall(effective, terminalProcessing.selection, terminalProcessing.transport,
          terminalBudget, attemptOrdinal)!);
      return createProjectTerminalExtractor(materialPort, attemptDeriver)(evidence);
    } : undefined;
    projectMemory = new SqliteProjectMemory(resolve(base.projectRoot, '.local/data/project-memory.sqlite'),
      extractor ? { extractor, retryGate: (job, nextAttempt) =>
        assertProjectTerminalRetrySafe(terminalBudget, job.evidence, nextAttempt), autoProcess: false } : {});
    // A previously running job is uncertain. Mark it interrupted before enabling any queued work.
    await projectMemory.recoverInterruptedJobs();
  } catch {
    await projectMemory?.close().catch(() => undefined); projectMemory = undefined;
    process.stderr.write('Project memory unavailable; project index and companion data unchanged.\n');
  }
  let workbenchStore: SqliteWorkbenchStore | undefined;
  let t3Service: T3LocalService | undefined;
  let nativeFrameOrigin: (() => string | undefined) | undefined;
  let dailyMount: DailyNativeMount | undefined;
  let dailyMountOptions: { client: import('../../workbench/integration/t3-http-client.mjs').T3HttpClient; runtimeSourceDir: string; codexHome?: string; engineeringAsr?: EngineeringAsrPort } | undefined;
  if (projects) try {
    if (engineProfileInvalid) throw Error('Project engine profile changed');
    const isolated = readIsolatedWorkbenchEnvironment(base.projectRoot);
    const sourceDir = t3SourceDir ?? isolated?.options.sourceDir, nodeExecutable = t3Node ?? isolated?.options.nodeExecutable;
    if (!sourceDir || !nodeExecutable) throw Error('Workbench runtime unavailable');
    const [{ T3LocalService }, { T3HttpClient }] = await Promise.all([
      import(new URL('../../../workbench/integration/t3-local-service.mjs', import.meta.url).href) as
        Promise<typeof import('../../workbench/integration/t3-local-service.mjs')>,
      import(new URL('../../../workbench/integration/t3-http-client.mjs', import.meta.url).href) as
        Promise<typeof import('../../workbench/integration/t3-http-client.mjs')>,
    ]);
    const workbenchOptions = isolated?.options ?? { sourceDir, nodeExecutable,
      baseDir: resolve(base.projectRoot, '.local/data/t3-home'),
      logFile: resolve(base.projectRoot, '.local/data/logs/t3-workbench.log'),
      ...(base.workbenchDshWebLog ? { dshWebLogPath: base.workbenchDshWebLog } : {}) };
    t3Service = new T3LocalService({ ...workbenchOptions,
      ...(engineProfile ? { nodeExecutable: engineProfile.runtime.nodeExecutable,
        engineProjectRoot: base.projectRoot, dshWebLogPath: engineProfile.dshWebLog } : {}) });
    if (isolated) {
      const existing = await t3Service.start();
      if (existing.pid !== isolated.nativePid || (await new T3HttpClient(t3Service).environmentDescriptor()).environmentId !== isolated.environmentId)
        throw Error('Isolated native identity changed');
    }
    workbenchStore = new SqliteWorkbenchStore(resolve(base.projectRoot, '.local/data/workbench.sqlite'));
    const turnAuthorization = reloadingWorkbenchTurnAuthorization(base.projectRoot);
    const client = new T3HttpClient(t3Service);
    const dailyBrowser = { openBrowser: (...args: Parameters<DailyNativeMount['openBrowser']>) => {
      if (!dailyMount) throw Error('Daily native browser not ready');
      return dailyMount.openBrowser(...args);
    } };
    workbench = new WorkbenchService(projects, workbenchStore, client, true,
      projectMemory, projectMemory ? new ProjectContextAssembler(projectMemory) : undefined,
      undefined, t3Service, isolated ? isolatedNativeBrowser(isolated) : dailyBrowser, turnAuthorization,
      isolated ? undefined : {
        available: () => dailyMount?.independentGroupAvailable() ?? false,
        register: input => {
          if (!dailyMount) throw Error('Original independent board not ready');
          return dailyMount.registerIndependentGroup(input);
        },
        readRegistration: scope => {
          if (!dailyMount) throw Error('Original independent board not ready');
          return dailyMount.readIndependentGroupRegistration(scope);
        },
      }, isolated ? undefined : projectId => readDesktopCoordinatorProfile(base.projectRoot, projectId));
    if (isolated) nativeFrameOrigin = () => isolatedNativeFrameOrigin(isolated);
    else {
      nativeFrameOrigin = () => dailyMount?.origin;
      dailyMountOptions = { client, runtimeSourceDir: sourceDir, ...(engineProfile ? { codexHome: engineProfile.codexHome } : {}), ...(engineeringAsr ? { engineeringAsr } : {}) };
    }
  } catch {
    workbenchStore?.close(); workbenchStore = undefined; t3Service = undefined;
    process.stderr.write('Workbench local service unavailable; existing tasks and companion data unchanged.\n');
  }
  const projectMemoryProcessingAvailable = !!(workbench && projectMemory && derive);
  if (projectMemoryProcessingAvailable) projectMemory!.startProcessing();
  const descriptorFile = resolve(dirname(configFile), 'management-session.json');
  const location = { dshHome: engineProfile ? engineProfile.dshHome : resolve(process.env.DSH_HOME || resolve(homedir(), '.dsh')), projectRoot: base.projectRoot,
    nodeExecutable: engineProfile?.runtime.nodeExecutable ?? process.execPath, managementDescriptor: descriptorFile };
  let tasks: HarnessForwarding | undefined;
  let receipts: ForwardReceipts | undefined;
  const harnessDirectory = process.env.PET_HARNESS_HOME || (process.platform === 'win32'
    ? resolve(process.env.APPDATA || homedir(), 'DeepSeek Harness') : resolve(homedir(), 'Library/Application Support/DeepSeek Harness'));
  const makeForwarding = (receipts: ForwardReceipts) => {
    // The host is a ~420 MB process and chat never needs it, so it comes up on demand. Status probes
    // must not block on that boot: they read a short-cached liveness answer and kick the start in the
    // background, so opening the console makes the host come up without the page waiting for it.
    const log = engineProfile?.dshWebLog ?? resolve(harnessDirectory, 'web.log');
    // Status must never start the host by itself: the host costs ~420 MB, so "is it up?" is answered
    // by a short-cached liveness read and nothing more. Starting it is the operator's explicit choice
    // (the console's button, 启动Harness.cmd, or the first work operation).
    const harness = new HarnessConnection(async () => harnessLaunchUrl(log), 5000, !!engineProfile,
      engineProfile ? async origin => {
        const { verifyDshNavigationRuntime } = await import(new URL('../../../workbench/integration/engine-pins/dsh-navigation-runtime.mjs', import.meta.url).href);
        return (await verifyDshNavigationRuntime(base.projectRoot, origin)).capabilityVersion;
      } : 0);
    return new HarnessForwarding({ receipts, projects:projects!,
      codex: new CodexAppConnection(resolve(homedir(), '.codex')), compatible: verifyCodexAppBuild,
      // Confirming a task is the moment work actually runs, and the operator is waiting for it, so
      // that path starts the host and waits. Everything else stays passive.
      startHarness: async () => {
        if (!engineProfile) return false;
        try {
          const { ensureHarnessHost } = await import('../harness/on-demand.js');
          return await ensureHarnessHost(engineProfile, log, 120000);
        } catch (error) { process.stderr.write('Harness start failed: ' + String(error).slice(0, 200) + '\n'); return false; }
      },
      harness: engineProfile ? new Proxy(harness, {
        get(target, property, receiver) {
          if (property !== 'createWorkSession') return Reflect.get(target, property, receiver);
          return async (sessionId: string, cwd: string) => {
            const { ensureHarnessHost } = await import('../harness/on-demand.js');
            await ensureHarnessHost(engineProfile, log);
            return target.createWorkSession(sessionId, cwd);
          };
        },
      }) : harness,
      nativeWork: harness, workPresetReady: () => workPresetReady(location),
      presetReady: () => relayPresetReady(location), presetId: RELAY_PRESET_ID,
      // Where Harness sessions run. The project default is a private, empty workspace under the
      // engine home; an operator who wants the pet to work in their own tree points
      // AAAAGENT_HARNESS_WORKSPACE at that directory instead.
      workspace: harnessWorkspace(engineProfile, harnessDirectory),
      recordMetrics: harnessAccounting(new EvaluationBudget(base.budgetFile, base.budgetBatchId, base.limitMicros)),
    });
  };
  if (projects) try {
    if (engineProfileInvalid) throw Error('Project engine profile changed');
    receipts = new ForwardReceipts(resolve(base.projectRoot, '.local/data/harness-relay.sqlite'));
    tasks = makeForwarding(receipts);
  } catch { process.stderr.write('Task relay unavailable; companion data unchanged.\n'); }
  let server: Awaited<ReturnType<typeof startManagementServer>>;
  try { server = await startManagementServer({ ...(emotion?{emotion}:{}), selfSetup, ...(memoryImport?{memoryImport}:{}), balances, ...(wake?{wake}:{}), uiRoot: resolve(base.projectRoot, 'code/desktop-pet/management/ui'), settings, memory, ...(wechat?{wechat}:{}), ...(projects ? { projects } : {}), ...(projectMemory ? { projectMemory, projectMemoryProcessingAvailable } : {}), ...(workbench ? { workbench } : {}), ...(nativeFrameOrigin ? { nativeFrameOrigin } : {}), ...(tasks ? { tasks } : {}), ...(pendingMemory?{pendingMemory}:{}), ...(presentation ? { presentation, presentationAssets: await presentationAssetRoutes(base.projectRoot) } : {}),
    snapshot: async () => ({ apiVersion: 1, balances:balances.snapshot(), accounting:await accountingSnapshot(base), runtime: runtime.identity(), modules: runtime.modules(), events: runtime.recentEvents(),
      settings: settings.snapshot(), adapters: availableAdapters(base, settings.registeredVoices), credentials: credentialRegistry(base).list(), characters: memory.characters() }) });
  } catch (error) { await selfSetup.close(); await tasks?.close(); workbenchStore?.close(); await t3Service?.stop(); await projectMemory?.close(); await projects?.close(); throw error; }
  if (workbench) void workbench.recoverTerminalDelivery().catch(() => undefined);
  if (dailyMountOptions && t3Service) try {
    const { startDailyNativeMount } = await import(new URL('../../../workbench/integration/engine-pins/daily-native-mount.mjs', import.meta.url).href);
    dailyMount = await startDailyNativeMount({ ...dailyMountOptions, projectRoot: base.projectRoot,
      runtimeFiles: base.runtimeFiles, service: t3Service, nodeExecutable: engineProfile?.runtime.nodeExecutable ?? process.execPath,
      managementOrigin: server.origin, managementToken: server.token,
      presentationReadPaths: [...(await presentationAssetRoutes(base.projectRoot)).keys()] });
  } catch { process.stderr.write('Daily native browser mount unavailable; native tasks retained.\n'); }
  const file = resolve(dirname(configFile), 'management-session.json');
  const descriptor = { version: 1, pid: process.pid, instanceId: runtime.instanceId, sourceRevision: base.sourceRevision, url: server.url };
  const temporary = file + '.' + runtime.instanceId + '.next';
  try {
    await writeFile(temporary, JSON.stringify(descriptor) + '\n', { mode: 0o600, flag: 'wx' });
    restrictPrivatePathSync(temporary);
    await rename(temporary, file);
  } catch (error) { try { balances.close(); await selfSetup.close(); await dailyMount?.close(); await server.close(); await memoryImport?.close(); } finally { await tasks?.close(); workbenchStore?.close(); await t3Service?.stop(); await projectMemory?.close(); await projects?.close(); } throw error; }
  finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  tasks?.startUsageObservation();
  return { ...server, tasks, projects, projectMemory, workbench, receipts, createWorkChannel(directory: string) {
    if(!projects)throw Error('Project index unavailable');
    const channelReceipts=new ForwardReceipts(resolve(directory,'harness-relay.sqlite'));
    const forwarding=makeForwarding(channelReceipts);forwarding.startUsageObservation();
    return {receipts:channelReceipts,forwarding,projects};
  }, async close() {
    try { balances.close(); await selfSetup.close(); await dailyMount?.close(); await server.close(); await memoryImport?.close(); } finally { await tasks?.close(); workbenchStore?.close(); await t3Service?.stop(); await projectMemory?.close(); await projects?.close(); }
    // The Harness host is detached, so it outlives the pet by design — right for a restart, wasteful
    // once the operator is done with it (~420 MB). Stop only the host this run started; a host from
    // 启动Harness.cmd or an earlier session is not ours to kill. AAAAGENT_KEEP_HARNESS=1 keeps it.
    if (engineProfile && process.env.AAAAGENT_KEEP_HARNESS !== '1') try {
      const { stopOwnedHarnessHost } = await import('../harness/on-demand.js');
      await stopOwnedHarnessHost(engineProfile.dshWebLog);
    } catch (error) { process.stderr.write('Harness stop skipped: ' + String(error).slice(0, 160) + '\n'); }
    try { const current = JSON.parse(await readFile(file, 'utf8')); if (current.instanceId === runtime.instanceId) await unlink(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  } };
}
