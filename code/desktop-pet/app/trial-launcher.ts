import { assertCompanionDataConfiguration } from './companion-data.js';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActiveTrialConfiguration, TrialNotReadyError, type TrialConfiguration } from './trial-config.js';

export function trialFiles(projectRoot: string) {
  const directory = resolve(projectRoot, process.platform === 'win32' ? '.local/model-evaluation/trial/user-trial' : 'artifacts/W0-I/model-evaluation/trial/user-trial');
  return { configFile: resolve(directory, 'config.json'), activationFile: resolve(directory, 'activation.json') };
}

/** Pin the actual launch artifacts, including ignored compiled output, before starting a process. */
export async function verifyTrialRuntime(configuration: TrialConfiguration): Promise<void> {
  for (const [path, digest] of Object.entries(configuration.runtimeFiles)) {
    try {
      const directory = path.startsWith('code/desktop-pet/') ? 'code/desktop-pet'
        : path.startsWith('code/workbench/integration/') ? 'code/workbench/integration' : 'artifacts/runtime';
      const root = await realpath(resolve(configuration.projectRoot, directory));
      const actual = await realpath(resolve(configuration.projectRoot, path));
      const local = relative(root, actual);
      if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('Outside runtime');
      if (createHash('sha256').update(await readFile(actual)).digest('hex') !== digest) throw new Error('Changed runtime');
    } catch { throw new TrialNotReadyError('试用程序文件缺失或已变化，请使用集成后的同一版本。'); }
  }
}

export async function preparedWorkbenchEnvironment(configuration: TrialConfiguration): Promise<NodeJS.ProcessEnv> {
  const paths = Object.keys(configuration.runtimeFiles);
  const platform = process.platform === 'win32' ? `win32-${process.arch}` : 'darwin-arm64';
  const engines = `artifacts/runtime/engines-codex-0.160.0-dsh-0.2.0-rc.2-${platform}`;
  if (paths.includes('artifacts/runtime/engine-profile.json')) {
    try {
      const required = ['engine-lock.json','runtime-source.json','package-lock.json','runtime.mjs','profile.mjs',
        'launch.mjs','prepare-t3-adapter.mjs','t3-adapter-source.json','dsh-service.mjs','dsh-worker.mjs'];
      if (!required.every(name => paths.includes('code/workbench/integration/engine-pins/' + name)) ||
          ![`artifacts/runtime/engine-bindings/${process.platform === 'win32' ? 'codex.cmd' : 'codex'}`,'artifacts/runtime/engine-bindings/dsh-presets.patch.yml',
            'code/desktop-pet/dist/harness/preset.js',
            `${engines}/.aaaagent-engine.json`,
            `${engines}/node/${process.platform === 'win32' ? 'node.exe' : 'bin/node'}`,
            'artifacts/runtime/engine-pin-54/t3-runtime/apps/server/dist/bin.mjs'].every(path => paths.includes(path)))
        throw Error('Incomplete project engine registration');
      const { readEngineProfile } = await import(new URL('../../../workbench/integration/engine-pins/profile.mjs', import.meta.url).href);
      const { verifyT3EngineAdapter } = await import(new URL('../../../workbench/integration/engine-pins/prepare-t3-adapter.mjs', import.meta.url).href);
      const profile = readEngineProfile(configuration.projectRoot);
      if (!profile) throw Error('Project engine profile unavailable');
      const sourceDir = resolve(configuration.projectRoot, 'artifacts/runtime/engine-pin-54/t3-runtime');
      verifyT3EngineAdapter(sourceDir);
      return { AAAAGENT_T3_PREPARED_DIR: sourceDir, AAAAGENT_T3_NODE_EXECUTABLE: profile.runtime.nodeExecutable,
        AAAAGENT_ENGINE_PROJECT_ROOT: configuration.projectRoot };
    } catch { throw new TrialNotReadyError('项目引擎运行文件缺失或已变化。'); }
  }
  const markers = paths.filter(path => /^artifacts\/runtime\/t3-[a-f0-9]{8}-[a-f0-9]{12}\/\.aaaagent-prepared\.json$/.test(path));
  const nodes = paths.filter(path => /^artifacts\/runtime\/(?:toolchain\/node-v24\.13\.1-(?:darwin-arm64|win32-(?:x64|arm64))|engines-codex-0\.160\.0-dsh-0\.2\.0-rc\.2-(?:darwin-arm64|win32-(?:x64|arm64))\/node)\/(?:bin\/node|node\.exe)$/.test(path));
  if (paths.some(path => path.startsWith('artifacts/runtime/codex-') || path === 'code/workbench/integration/codex-source.json') &&
      !markers.length) throw new TrialNotReadyError('工作台运行文件登记不完整。');
  if (!markers.length && !nodes.length) return {}; // Existing B55 installation has no workbench runtime.
  if (markers.length !== 1 || nodes.length !== 1 ||
      !['t3-source.json', 't3-local-service.mjs', 't3-http-client.mjs', 't3-child-service.mjs', 't3-host.mjs', 't3-browser.mjs'].every(name =>
        paths.includes(`code/workbench/integration/${name}`)))
    throw new TrialNotReadyError('工作台运行文件登记不完整。');
  try {
    const sourceDir = resolve(configuration.projectRoot, dirname(markers[0]!));
    const nodeExecutable = resolve(configuration.projectRoot, nodes[0]!);
    const marker = JSON.parse(await readFile(resolve(sourceDir, '.aaaagent-prepared.json'), 'utf8'));
    const lock = JSON.parse(await readFile(resolve(configuration.projectRoot, 'code/workbench/integration/t3-source.json'), 'utf8'));
    if (marker.commit !== lock.commit || marker.licenseSha256 !== lock.licenseSha256 ||
        !Array.isArray(marker.patches) || !/^[a-f0-9]{64}$/.test(marker.patchSha256) ||
        !/^[a-f0-9]{64}$/.test(marker.appliedDiffSha256) ||
        dirname(markers[0]!) !== `artifacts/runtime/t3-${lock.commit.slice(0, 8)}-${marker.patchSha256.slice(0, 12)}`)
      throw new Error('Prepared marker disagrees with source lock');
    const patchDigest = createHash('sha256');
    for (const path of marker.patches) {
      if (typeof path !== 'string' || !/^code\/workbench\/(?:integration\/)?patches\/[a-zA-Z0-9-]+\.patch$/.test(path))
        throw new Error('Unexpected prepared patch');
      patchDigest.update(path);
      patchDigest.update(await readFile(resolve(configuration.projectRoot, path)));
    }
    if (patchDigest.digest('hex') !== marker.patchSha256 ||
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim() !== lock.commit ||
        createHash('sha256').update(await readFile(resolve(sourceDir, 'LICENSE'))).digest('hex') !== lock.licenseSha256 ||
        createHash('sha256').update(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: sourceDir, encoding: 'utf8' }).trim()).digest('hex') !== marker.appliedDiffSha256)
      throw new Error('Prepared source changed');
    await readFile(resolve(sourceDir, 'apps/server/dist/bin.mjs'));
    const codexMarkers = paths.filter(path => path.endsWith('/.aaaagent-codex.json'));
    if ((codexMarkers.length || paths.includes('code/workbench/integration/codex-source.json'))) {
      if (codexMarkers.length !== 1 || !paths.includes('code/workbench/integration/codex-source.json')) throw Error('Incomplete Codex pins');
      const codex = JSON.parse(await readFile(resolve(configuration.projectRoot, codexMarkers[0]!), 'utf8'));
      const source = JSON.parse(await readFile(resolve(configuration.projectRoot, 'code/workbench/integration/codex-source.json'), 'utf8'));
      const directory = dirname(codexMarkers[0]!);
      if (JSON.stringify(codex.source) !== JSON.stringify(source) ||
          directory !== `artifacts/runtime/codex-${source.version}-${source.target}-${source.archiveSha256.slice(0,12)}` ||
          source.entrypoint !== (process.platform === 'win32' ? 'bin/codex.exe' : 'bin/codex') || !codex.files?.[source.entrypoint] || !codex.files?.[process.platform === 'win32' ? 'bin/codex-code-mode-host.exe' : 'bin/codex-code-mode-host'] ||
          Object.entries(codex.files).some(([file, hash]) => configuration.runtimeFiles[`${directory}/${file}`] !== hash))
        throw Error('Codex runtime pins changed');
    }
    return { AAAAGENT_T3_PREPARED_DIR: sourceDir, AAAAGENT_T3_NODE_EXECUTABLE: nodeExecutable };
  } catch { throw new TrialNotReadyError('工作台本地运行文件缺失或已变化，请联系集成任务。'); }
}

/**
 * The backend takes ackend.lock with an exclusive create, so a lock whose owner was
 * killed or orphaned blocks every later start with "对话服务连接失败" until someone deletes
 * the file by hand. Clear only locks proven dead before launching; a lock whose pid is still
 * alive is left alone because that backend really is running.
 */
async function clearStaleRuntimeLocks(projectRoot: string): Promise<void> {
  const evidenceRoot = resolve(projectRoot, '.local', 'model-evaluation', 'trial');
  const targets = [resolve(evidenceRoot, '..', 'backend.lock'), resolve(evidenceRoot, 'user-trial', 'management-session.json')];
  for (const file of targets) {
    let pid: unknown;
    try { pid = (JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown }).pid; }
    catch { continue; }
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) continue;
    let live = true;
    try { process.kill(pid, 0); } catch (error) { live = (error as NodeJS.ErrnoException).code === 'EPERM'; }
    if (live) continue;
    await rm(file, { force: true });
    process.stdout.write(`  \u5df2\u6e05\u7406\u9648\u65e7\u8fd0\u884c\u6587\u4ef6 ${file} (pid ${pid} \u5df2\u4e0d\u5b58\u5728)\n`);
  }
}
/** How long the launcher waits for the setup screen before returning control. */
const SETUP_WAIT_MS = 30 * 60 * 1000;

/**
 * Remove a setup lock whose owning process is gone. Setup refuses to start while any lock file
 * exists, so a crashed or killed setup run would otherwise block every later attempt.
 */
async function clearDeadSetupLock(file: string): Promise<void> {
  let owner: { pid?: unknown };
  try { owner = JSON.parse(await readFile(file, 'utf8')) as { pid?: unknown }; }
  catch { return; }
  const pid = typeof owner.pid === 'number' ? owner.pid : undefined;
  if (pid === undefined) return;
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code === 'EPERM'; }
  if (alive) throw new TrialNotReadyError('另一个设置窗口仍在运行。请使用它完成设置，或关闭后重试。');
  await rm(file, { force: true });
  process.stdout.write('已清理上次未正常结束的设置锁。\n');
}
/** Hand the setup URL to the OS browser. Failure is not fatal: the URL is printed either way. */
function openInBrowser(url: string): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { execFile(command, args, { windowsHide: true }, () => {}); } catch { /* the operator can copy the URL */ }
}

/** True once a prepared configuration pair exists, regardless of activation status. */
export async function hasConfiguration(projectRoot: string): Promise<boolean> {
  const files = trialFiles(projectRoot);
  for (const file of [files.configFile, files.activationFile]) {
    try { await readFile(file); } catch { return false; }
  }
  return true;
}

/**
 * First run on a freshly unpacked copy: there is no configuration yet, so open the local setup
 * screen instead of failing. The screen collects the operator's own API keys and installs the
 * Live2D rig they point it at; finishing it writes the configuration pair for THIS directory,
 * which is what makes the packaged build relocatable. We wait for that pair and then continue
 * into a normal launch, so the operator never sees a command line.
 */
/**
 * Setup takes an exclusive lock and refuses to start while a live owner holds it, so a first run
 * that the operator simply closed must not keep holding it for the rest of SETUP_WAIT_MS.
 *
 * This launcher is spawned detached so it can outlive the console during a normal launch. During
 * first-run setup that same property is a trap: closing the window leaves the process waiting with
 * the lock, and the next attempt is refused with "另一个设置进程仍存在".
 *
 * The launcher that spawned us (`tools/aaaagent-start.mjs`) is not detached, so it dies with its
 * window. When it told us its pid, watch that pid and give up as soon as it is gone. Harnesses that
 * do not set the variable keep the previous behaviour exactly.
 */
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function configureFirstRun(projectRoot: string): Promise<void> {
  const files = trialFiles(projectRoot);
  // Setup takes an exclusive lock. A lock whose owner is gone would otherwise make every
  // attempt fail with '另一个设置进程仍存在' until someone deleted the file by hand.
  await clearDeadSetupLock(resolve(dirname(files.configFile), 'first-run.lock'));
  const { startFirstRunSetup } = await import('./self-setup.js');
  process.stdout.write('这是首次启动，正在打开本机设置页面...\n');
  let service: Awaited<ReturnType<typeof startFirstRunSetup>> | undefined;
  try {
    service = await startFirstRunSetup(projectRoot);
  } catch (error) {
    // A second launcher (or a window that respawned the shortcut) can reach this point after the
    // first one has already written the pair. That is success for our purposes, not a failure.
    if (await hasConfiguration(projectRoot)) {
      await activateIfPrepared(projectRoot);
      process.stdout.write('设置已由另一个窗口完成，正在启动桌宠...\n');
      return;
    }
    throw error;
  }
  process.stdout.write(`\n请在浏览器中完成设置（填写 API Key、选择 Live2D 模型文件夹）：\n` + service.url + `\n\n`);
  openInBrowser(service.url);
  const parentPid = Number(process.env.AAAAGENT_LAUNCHER_PARENT_PID);
  const watched = Number.isSafeInteger(parentPid) && parentPid > 1 ? parentPid : undefined;
  let parentExit: ReturnType<typeof setInterval> | undefined;
  try {
    // Wait for the pair to appear. The timeout only stops an indefinite wait; the URL is
    // already printed, so the operator can finish in the browser at their own pace.
    await new Promise<void>((done, reject) => {
      const deadline = Date.now() + SETUP_WAIT_MS;
      const timer = setInterval(() => {
        void hasConfiguration(projectRoot).then((ready) => {
          if (ready || Date.now() > deadline) { clearInterval(timer); done(); }
        });
      }, 1000);
      if (watched !== undefined) {
        parentExit = setInterval(() => {
          if (processAlive(watched)) return;
          clearInterval(timer); clearInterval(parentExit);
          reject(new TrialNotReadyError('设置窗口已关闭，本次设置未完成；重新运行 启动桌宠.cmd 会重新打开设置页面。'));
        }, 1000);
      }
    });
  } finally {
    if (parentExit !== undefined) clearInterval(parentExit);
    await service.close();
  }
  if (!await hasConfiguration(projectRoot)) {
    throw new TrialNotReadyError('设置尚未完成。请重新运行以继续完成设置页面。');
  }
  await activateIfPrepared(projectRoot);
  process.stdout.write('\n设置已完成，正在启动桌宠...\n');
}

/** The setup server writes the pair as 'prepared'; the launcher only accepts 'active'. */
export async function activateIfPrepared(projectRoot: string): Promise<void> {
  const files = trialFiles(projectRoot);
  const activation = JSON.parse(await readFile(files.activationFile, 'utf8')) as { status?: string };
  if (activation.status === 'active') return;
  const { writeFile, rename } = await import('node:fs/promises');
  const temporary = `${files.activationFile}.${process.pid}.next`;
  await writeFile(temporary, `${JSON.stringify({ ...activation, status: 'active' })}\n`, { mode: 0o600 });
  await rename(temporary, files.activationFile);
}
export async function prepareTrialLaunch(projectRoot: string, nodePath: string, environment: NodeJS.ProcessEnv = {}) {
  const files = trialFiles(projectRoot);
  const configuration = await readActiveTrialConfiguration(files.configFile, files.activationFile);
  if (configuration.purpose !== 'user-trial') throw new TrialNotReadyError('当前是集成检查配置，用户试用入口尚未启用。');
  assertCompanionDataConfiguration(configuration);
  if (resolve(configuration.projectRoot) !== resolve(projectRoot)) throw new TrialNotReadyError('试用配置与当前项目不一致。');
  await verifyTrialRuntime(configuration);
  const workbenchEnvironment = await preparedWorkbenchEnvironment(configuration);
  const { AAAAGENT_T3_PREPARED_DIR: _oldT3Dir, AAAAGENT_T3_NODE_EXECUTABLE: _oldT3Node, AAAAGENT_ENGINE_PROJECT_ROOT: _oldEngineRoot, ELECTRON_RUN_AS_NODE: _electronNode, ...launchEnvironment } = environment;
  const desktop = resolve(projectRoot, 'code/desktop-pet/desktop');
  const electron = process.platform === 'win32';
  return {
    version: configuration.sourceRevision,
    executable: electron ? desktopExecutable(environment) : resolve(desktop, 'build/星月陪伴.app/Contents/MacOS/DesktopPet'),
    arguments: [...(electron ? [resolve(desktop,'electron/main.mjs')] : []), '--root', desktop, '--backend', resolve(projectRoot, 'code/desktop-pet/dist/app/trial-backend.js'), '--node', nodePath],
    environment: { ...launchEnvironment, ...workbenchEnvironment, PET_TRIAL_CONFIG: files.configFile, PET_TRIAL_ACTIVATION: files.activationFile },
  };
}

/**
 * Where the desktop window's Electron lives.
 *
 * `require('electron')` cannot be used from a packaged shell: the shell *is* Electron, so the
 * built-in module wins over the `node_modules/electron` stub and returns Electron's API object
 * instead of a path — which then reaches spawn() as an object. Prefer an explicit path from the
 * environment, then the known portable layout, and only fall back to the development resolution.
 */
function desktopExecutable(environment: NodeJS.ProcessEnv): string {
  const explicit = environment.AAAAGENT_DESKTOP_EXECUTABLE;
  if (explicit && existsSync(explicit)) return explicit;
  const portable = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../runtime/electron/electron.exe');
  if (existsSync(portable)) return portable;
  const resolved: unknown = createRequire(import.meta.url)('electron');
  if (typeof resolved === 'string') return resolved;
  throw new TrialNotReadyError('找不到桌宠运行程序（Electron）。请重新解压完整的分发包。');
}

export async function launchTrial(projectRoot: string): Promise<void> {
  // failing, so the packaged build never needs a command line.
  await clearStaleRuntimeLocks(projectRoot);
  const plan = await prepareTrialLaunch(projectRoot, process.execPath, process.env);
  process.stdout.write(`正在启动AAAAGENT试用版 ${plan.version.slice(0, 7)}。退出请用桌宠面板的退出按钮。\n`);
  const child = spawn(plan.executable, plan.arguments, { env: plan.environment, stdio: 'inherit', windowsHide:true });
  await new Promise<void>((done, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new TrialNotReadyError('试用程序未正常退出，请保留这个窗口的信息。')));
  });
}

/**
 * Entry used by every launcher: a packaged shell and the repo's `npm start` both call this, so a
 * freshly unpacked copy reaches the setup screen instead of failing with "配置尚未就绪".
 */
export async function startPet(projectRoot: string): Promise<void> {
  if (!await hasConfiguration(projectRoot)) await configureFirstRun(projectRoot);
  await launchTrial(projectRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  startPet(root).catch(error => {
    // Surface the real reason: a generic fallback here once hid a stale setup lock and made the
    // launcher look like it had frozen.
    const message = error instanceof Error && error.message ? error.message : '试用启动失败，请检查已登记的程序与配置。';
    process.stderr.write(message + '\n');
    process.exitCode = 1;
  });
}
