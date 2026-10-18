// One-click launcher.
// Starts the pet. The pinned DSH host is reused when one is already running but is NOT started here:
// nothing in the chat, voice or expression path needs it, which is the on-demand behaviour described
// in 使用说明.txt. The AAAAGENT_START_HARNESS=1 opt-in that used to start it up front was removed
// because it was never exercised — the host is started from the console's 任务转发 button.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearOrphanedPetProcesses } from './aaaagent-pet-orphans.mjs';
// aaaagent-harness-host.mjs is imported dynamically, after the preflight below. Its import chain reaches
// `desktop-pet/dist/harness/preset.js`, which does not exist until the project is built, so a static
// import would abort with an ESM resolution error before the preflight could explain what is missing.
// Starting the host itself (spawn/openSync/engineEnvironment) lives in aaaagent-harness-host.mjs.

// tools/ sits directly under the project root, so derive it instead of hard-coding an install path.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, 'code', 'desktop-pet');

// Preflight, before anything is imported from the build output. A fresh download of the source tree has
// no build output, and the failure that produces is an ESM resolution error from deep inside the code —
// `Cannot find module .../dist/harness/preset.js` — which tells the reader nothing about what to do.
// Check what the launch needs and say so plainly. The engine runtime is deliberately not checked: the
// pet starts without it, only DSH tasks need it.
const missing = [
  ['未安装依赖 (node_modules)', join(repo, 'node_modules')],
  ['未编译后端 (dist)', join(repo, 'dist', 'app', 'trial-launcher.js')],
  ['未打包界面 (desktop/build)', join(repo, 'desktop', 'build', 'renderer.js')],
].filter(([, path]) => !existsSync(path));

if (missing.length > 0) {
  const manual = [
    '',
    '  请在  命令提示符(cmd)  里依次执行这四条命令：',
    '',
    '      cd /d "' + repo + '"',
    '      npm ci',
    '      npm run build',
    '      npm run build:desktop',
    '',
    '  前提：已安装 Node.js（自带 npm）。',
    '  完成后重新双击  启动桌宠.cmd  即可。',
    '',
    '  详细说明：docs/SETUP.md 、 README-WINDOWS.md',
    '',
  ];
  console.log('');
  console.log('  ============================================');
  console.log('   还不能直接运行 —— 这是源码，需要先编译');
  console.log('  ============================================');
  console.log('');
  console.log('  缺少：');
  for (const [label] of missing) console.log('      · ' + label);
  console.log('');
  console.log('  这一步要从网上下载依赖。国内网络直连常常超时，超时后会退回本地编译，');
  console.log('  而那还需要 Python 与 Visual Studio C++ 生成工具。');
  console.log('');

  // Offered here rather than as another .cmd in the root, so installing is the default path for a
  // fresh copy instead of something the operator has to know about. The prompt is asked in Node, not
  // in 启动桌宠.cmd, because that file must stay pure ASCII: cmd.exe decodes a .cmd with the console
  // code page active when it starts reading, and UTF-8 Chinese there was executed as a command on a
  // 936 console and left the script exiting before anything ran.
  let answer = '';
  if (process.stdin.isTTY) {
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      answer = (await rl.question('  是否现在用国内镜像安装？(Y/N) ')).trim().toLowerCase();
    } finally { rl.close(); }
  } else {
    console.log('  （当前不是交互式终端，未询问。加 --mirror-install 可直接用镜像安装。）');
    console.log('');
  }

  const wantsMirror = answer === 'y' || answer === 'yes' || process.argv.includes('--mirror-install');
  if (!wantsMirror) {
    for (const line of manual) console.log(line);
    process.exit(1);
  }

  const { installWithMirror } = await import('./aaaagent-mirror-install.mjs');
  if (!await installWithMirror(root, console.log)) {
    console.log('');
    for (const line of manual) console.log(line);
    process.exit(1);
  }
  console.log('  安装完成，继续启动。');
  console.log('');
}

// Safe to load now: the build output the chain needs is present.
const { loadProfile, originAlive, readOrigin, readTokenUrl } = await import('./aaaagent-harness-host.mjs');

// The banner is the first thing the operator sees, and it is printed before anything slow runs.
// 启动桌宠.cmd must stay pure ASCII — cmd.exe decodes a .cmd with the console code page active when it
// starts reading, and UTF-8 Chinese there was executed as a command on a 936 console — so the Chinese
// lives here, where the script writes UTF-8 itself.
console.log('');
console.log('  ============================================');
console.log('    AAAAGENT 桌宠启动器');
console.log('  ============================================');
console.log('  正在启动桌宠…');

// The engine profile is needed here ONLY to report a DSH host that is already serving an address, and
// to clear its stale lock. Reading it costs loadProfile, and loadProfile runs verifyEngineRuntime, which
// hashes every file of the engine tree — measured at 11.5s for 28530 files on this machine. The pet's
// own backend performs the same verification when it starts (app/trial-backend.ts), so paying it here
// as well bought nothing but a slower launcher.
//
// The recorded origin is a line in the host's web log, so reading that log first avoids a profile. The
// log file itself proves nothing — it survives every run with the last origin still in it — so the
// cheap HTTP probe decides whether a host is really there (measured 23ms against a dead port). Only
// then is loadProfile worth its cost, to fetch the token address for the operator.
const dshWebLog = join(root, '.local', 'data', 'engine-home', 'dsh-web.log');
const recordedOrigin = existsSync(dshWebLog) ? readOrigin(dshWebLog) : null;
const dshHostUp = recordedOrigin !== null && await originAlive(recordedOrigin);
let dshLine = '';
if (dshHostUp) {
  let profile;
  try { profile = loadProfile(root); }
  catch { profile = undefined; }
  if (!profile) {
    dshLine = '  （本机没有引擎运行时 artifacts/runtime，DSH 任务不可用；详见 README-WINDOWS.md）';
  } else {
    // A stale lock from an earlier attempt makes the project refuse a new host; clear only ours.
    for (const name of ['.aaaagent-dsh-host.lock', '.aaaagent-dsh-host.json']) {
      const p = join(profile.home, name);
      if (existsSync(p)) { try { unlinkSync(p); console.log('  已清理残留的 ' + name); } catch { /* ignore */ } }
    }
    const tokenUrl = readTokenUrl(profile.dshWebLog);
    if (tokenUrl) dshLine = '  Harness 主机已在运行，界面地址: ' + tokenUrl;
  }
} else {
  // Fallback for the stale-lock cleanup the branch above used to do.
  //
  // Reaching here means the probe found no host on the recorded origin, so a leftover lock is provably
  // stale — it cannot belong to a running host, because a running host would have answered. This costs
  // only two existsSync calls and deliberately does NOT load the profile: the engine home path is
  // derived the same way readEngineProfile derives it, and the alternative was paying ~11.5s of engine
  // hashing just to find out whether two small files exist.
  //
  // Cleared only when a lock is actually present, and only the two names this project owns. A lock left
  // in place makes the project refuse to start a host with "另一个设置进程仍存在".
  const engineHome = join(root, '.local', 'data', 'engine-home');
  for (const name of ['.aaaagent-dsh-host.lock', '.aaaagent-dsh-host.json']) {
    const p = join(engineHome, name);
    if (existsSync(p)) { try { unlinkSync(p); console.log('  已清理残留的 ' + name); } catch { /* ignore */ } }
  }
}

// Keep the console open when the operator double-clicked 启动桌宠.cmd. Without this the "already
// running" branch printed and the window closed about a second later, so a second double-click looked
// like it had done nothing while the pet had been running the whole time. Skipped when stdin is not a
// console, so scripted and non-interactive runs never block.
async function pauseForOperator() {
  if (!process.stdin.isTTY) return;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { await rl.question('\n  按回车键关闭这个窗口。'); } finally { rl.close(); }
}

/** The pet already running for THIS tree, if any. Its launcher holds `.local/pet-launch.log` open for
 *  writing, so a second launch cannot even open the log — it fails with EBUSY after printing "已经运行"
 *  and the operator sees a failure while the pet is healthy. Report and leave instead. */
function runningSession() {
  try {
    const descriptor = JSON.parse(readFileSync(join(root, '.local', 'model-evaluation', 'trial', 'user-trial', 'management-session.json'), 'utf8'));
    if (descriptor.version !== 1 || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1) return null;
    if (descriptor.artifactRoot !== undefined && resolve(descriptor.artifactRoot) !== root) return null;
    try { process.kill(descriptor.pid, 0); } catch { return null; }
    return descriptor;
  } catch { return null; }
}

// Reuse a host that is already serving its recorded origin; do not start one here.
//
// Measured, not assumed: the backend starts in about 30s with the host stopped, with the host running,
// and with the host's integration descriptor deleted. So the backend brings up whatever it needs on
// its own, and starting the host here only adds a second instance and startup time. The pet window
// being unresponsive earlier was a separate problem, not this.
//
// Nothing in the chat, voice or expression path needs the host either. Start it when DSH work is
// wanted: the console's 任务转发 button, or the first task that needs it.

// A pet that was force-killed instead of exited leaves its backend and `cmd.exe /c npm start` wrapper
// behind with no window. Those leftovers hold the state this launch needs, so the new pet silently
// fails to appear. Only clean up when no pet window is running, so a live session is never touched.
const orphans = clearOrphanedPetProcesses();
let alreadyRunning = false;
if (orphans.skipped) {
  const running = runningSession();
  if (running) {
    console.log('');
    console.log('  桌宠已经在运行，本次不再启动第二个实例。');
    if (typeof running.url === 'string') console.log('  控制台: ' + running.url);
    console.log('  要重启，请先用桌宠面板的退出按钮退出。');
    alreadyRunning = true;
  }
} else if (orphans.shells > 0) {
  // Only mentioned when it happened: it explains a slower launch and a stale window that was cleared.
  console.log('  已清理上次强制关闭留下的残留进程（' + orphans.cleaned + ' 个）');
}

// Which tree Harness sessions run in. Defaults to the project's parent directory — the operator's own
// tree, which is what the pet should see instead of the engine's private empty workspace. Override
// with the first argument or AAAAGENT_HARNESS_WORKSPACE. `dirname(root)` is used rather than the home
// directory because it is the tree the operator actually works in, and it keeps the default portable
// instead of naming one machine's path.
const workspace = process.argv[2] ?? process.env.AAAAGENT_HARNESS_WORKSPACE ?? dirname(root);
const workspaceOk = existsSync(workspace);
// Only a problem is worth reporting: the normal case is an internal default the operator never chose.
if (!workspaceOk) console.log('  ⚠ Harness 工作区不存在（' + workspace + '），桌宠将回退到自带的空工作区');

// Launch the pet's entry script directly, NOT through `cmd /c npm start`.
//
// On Windows 11 the default terminal is Windows Terminal, which takes over every new console session
// and shows it as a window/tab — and it ignores windowsHide, so a hidden `cmd` still produced a
// visible "npm start" window for the pet's whole life. Measured on this machine: spawning `cmd.exe`
// added a console window, spawning `node.exe` added none.
//
// `npm start` is exactly `node dist/app/trial-launcher.js` (package.json has no pre/post step), so
// calling node directly loses nothing and creates no console session at all. The launcher sets its
// own PET_TRIAL_* environment for the backend, so nothing here has to.
//
// `detached: true` matters: `trial-launcher` is the pet's long-lived monitor — it waits for Electron
// to exit so it can release the backend lock — and it shuts the whole pet down on SIGTERM. Ending it
// here killed the pet right after it reported ready, so it must outlive this script. stdout/stderr go
// to files rather than pipes, because a live pipe would keep this script alive after its work is done.
// The pet writes its logs and session data under .local, which does not exist in a fresh download, so
// create it before opening the log files. Without this the launcher dies with a bare ENOENT on the log
// path even though everything else is ready.
const localDir = join(root, '.local');
try { mkdirSync(localDir, { recursive: true, mode: 0o700 }); } catch { /* the open below reports it */ }
// Stop here when the pet is already up. Nothing below may run: opening pet-launch.log with 'w' fails
// with EBUSY while the running launcher holds it, and a second instance is not wanted.
if (alreadyRunning) {
  await pauseForOperator();
  process.exit(0);
}
// Only the DSH line is left from the banner section; it is printed before the spawn so the operator
// sees it while the pet starts. The banner and "正在启动桌宠…" were printed at the top of the script,
// before this point, so they appear immediately instead of after the profile/cleanup work.
if (dshLine) console.log(dshLine);
const logFd = openSync(join(localDir, 'pet-launch.log'), 'w');
const errFd = openSync(join(localDir, 'pet-launch.err.log'), 'w');
let pet;
try {
  pet = spawn(process.execPath, [join(repo, 'dist', 'app', 'trial-launcher.js')], {
    cwd: repo, detached: true, stdio: ['ignore', logFd, errFd], windowsHide: true,
    env: { ...process.env, ...(workspaceOk ? { AAAAGENT_HARNESS_WORKSPACE: workspace } : {}) },
  });
} finally { closeSync(logFd); closeSync(errFd); }
pet.unref();
let spawnError = '';
pet.on('error', (error) => { spawnError = String(error); });

// Report success when the front end has actually started painting, then leave — so the console closes
// about when the pet appears instead of on a fixed timer that is either early or late.
//
// A fixed pause cannot do this: how long the launcher takes varies (a cold run pays verifyEngineRuntime
// on ~28530 engine files, a warm one does not), so any constant was wrong in one direction. The
// renderer writes its first line to pet-launch.err.log as soon as it starts, and that file is created
// empty by the spawn above, so "it has bytes" is the signal — measured about 2.5s after the spawn,
// while the management API only answers after roughly 20s.
//
// "Started" therefore does NOT mean the backend answers yet; that is what the warm-up line below says.
// Most of the remaining wait is verifyEngineRuntime hashing the engine tree, which the pet's backend
// performs for itself (app/trial-backend.ts) and is not this script's to shorten.
const sessionFile = join(root, '.local', 'model-evaluation', 'trial', 'user-trial', 'management-session.json');
const errLog = join(localDir, 'pet-launch.err.log');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// "The renderer painted" means its own log line, NOT "the file has bytes". A refused launch also writes
// to this file — 试用程序文件缺失或已变化, for example — so a size test alone reported success for a pet
// that had died, and the operator was told it had started. The renderer always emits `"type":` records,
// so requiring one is what tells a live front end apart from a failure message.
const rendererStarted = () => {
  try { return readFileSync(errLog, 'utf8').includes('"type":'); } catch { return false; }
};
// Floor: give an immediately-failing launcher time to show up in pet.exitCode. Ceiling: never hang on a
// renderer that stays silent — the warm-up message covers the case where the pet is simply slow.
// Fail only when the renderer never appeared AND the launcher is gone. `pet` is the trial launcher,
// which is detached and hands off to Electron before exiting, so pet.exitCode becoming non-null is
// NORMAL and must not be treated as failure on its own — doing that produced a false "提前退出" warning
// for a pet that had in fact started. The renderer's own output is the only positive evidence, so the
// loop keeps waiting for it even after the launcher exits.
const floorMs = 1200, ceilingMs = 15000;
const startedAt = Date.now();
while (Date.now() - startedAt < ceilingMs) {
  if (spawnError) break;
  if (rendererStarted() && Date.now() - startedAt >= floorMs) break;
  await sleep(200);
}
if (spawnError) {
  console.log('  ❌ 桌宠启动失败: ' + spawnError.slice(0, 200));
  process.exitCode = 1;
} else if (!rendererStarted() && pet.exitCode !== null) {
  console.log('  ⚠ 桌宠进程提前退出，请把下面的日志发给协助者。');
  process.exitCode = 1;
} else {
  console.log('  ✅ 桌宠已启动。');
  // Said only when already true, so this line never overstates the state.
  if (!existsSync(sessionFile)) console.log('  后端仍在预热，控制台大概十几秒后才可打开');
  console.log('  退出桌宠请用桌宠面板的退出按钮。');
}
console.log('');
console.log('  日志: .local\\pet-launch.log / pet-launch.err.log');
// Hold the window open just long enough to read the lines above.
//
// The launcher now returns about 2.5s after the click — the moment the renderer starts painting — so
// the console closed on the same tick as these messages and the "后端仍在预热" line was never seen.
// 2.5s is the operator's stated preference: the pet window is already appearing by then, and a longer
// hold keeps them waiting on a console that has said everything it has to say. The five-second
// `timeout` this replaced lived in 启动桌宠.cmd, which was deleted with the other root wrappers;
// keeping the wait here leaves that file pure ASCII and lets it cover the failure branches too.
//
// Skipped when stdin is not a console, so scripted runs are not delayed.
if (process.stdin.isTTY) await sleep(2500);
