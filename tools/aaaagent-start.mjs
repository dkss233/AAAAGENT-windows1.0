// One-click launcher.
// Starts the pet. The pinned DSH host is reused when one is already running but is NOT started here:
// nothing in the chat, voice or expression path needs it, which is the on-demand behaviour described
// in 使用说明.txt. The AAAAGENT_START_HARNESS=1 opt-in that used to start it up front was removed
// because it was never exercised — the host is started from the console button or 启动Harness.cmd.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
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
  const lines = [
    '',
    '  ============================================',
    '   还不能直接运行 —— 这是源码，需要先编译',
    '  ============================================',
    '',
    '  缺少：',
    ...missing.map(([label]) => '      · ' + label),
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
  for (const line of lines) console.log(line);
  process.exit(1);
}

// Safe to load now: the build output the chain needs is present.
const { loadProfile, originAlive, readOrigin, readTokenUrl } = await import('./aaaagent-harness-host.mjs');

// The engine profile is optional here. Everything that uses it concerns DSH, and the pet's own
// features — chat, voice, expressions, cursor following, pointer lock — do not need DSH at all. The
// engine runtime is a large separate download, so requiring it would stop a built tree from starting
// the pet. 启动Harness.cmd and the console's button still require it and say so themselves.
let profile;
try { profile = loadProfile(root); }
catch { profile = undefined; }
if (profile) {
  // A stale lock from an earlier attempt makes the project refuse a new host; clear only ours.
  for (const name of ['.aaaagent-dsh-host.lock', '.aaaagent-dsh-host.json']) {
    const p = join(profile.home, name);
    if (existsSync(p)) { try { unlinkSync(p); console.log('  已清理残留的 ' + name); } catch { /* ignore */ } }
  }
}

// Reuse a host that is already serving its recorded origin; do not start one here.
//
// Measured, not assumed: the backend starts in about 30s with the host stopped, with the host running,
// and with the host's integration descriptor deleted. So the backend brings up whatever it needs on
// its own, and starting the host here only adds a second instance and startup time. The pet window
// being unresponsive earlier was a separate problem, not this.
//
// Nothing in the chat, voice or expression path needs the host either. Start it when DSH work is
// wanted: the console's button, 启动Harness.cmd, or the first task that needs it.
if (!profile) {
  console.log('  Harness 主机未启动，本机也没有引擎运行时（artifacts/runtime）。');
  console.log('  对话、语音、表情、注视都不需要引擎，桌宠会照常启动。');
  console.log('  需要让桌宠执行 DSH 任务时，请先按 README-WINDOWS.md 准备引擎运行时。');
} else {
  const existing = readOrigin(profile.dshWebLog);
  const alive = await originAlive(existing);
  if (alive) {
    console.log('  Harness 主机已在运行: ' + existing);
  } else {
    console.log('  Harness 主机未启动（对话、语音、表情都不需要它）。');
    console.log('  需要让桌宠执行 DSH 任务时，用以下任一方式启动它：');
    console.log('    · 控制台「任务转发」页 → 点【启动 Harness】');
    console.log('    · 双击 启动Harness.cmd');
    console.log('    · 直接下达任务 —— 确认执行时会自动启动');
  }

  // The token URL the browser needs, because the pet opens a token-free address on purpose.
  const tokenUrl = readTokenUrl(profile.dshWebLog);
  if (alive && tokenUrl) console.log('  Harness 界面地址（含 token，可粘贴到浏览器）: ' + tokenUrl);
}

// A pet that was force-killed instead of exited leaves its backend and `cmd.exe /c npm start` wrapper
// behind with no window. Those leftovers hold the state this launch needs, so the new pet silently
// fails to appear. Only clean up when no pet window is running, so a live session is never touched.
const orphans = clearOrphanedPetProcesses();
if (orphans.skipped) console.log('  检测到桌宠已在运行，跳过残留清理');
else if (orphans.shells > 0) console.log('  已清理上次强制关闭留下的残留进程（' + orphans.cleaned + ' 个）');

// Which tree Harness sessions run in. Defaults to the project's parent directory — the operator's own
// tree, which is what the pet should see instead of the engine's private empty workspace. Override
// with the first argument or AAAAGENT_HARNESS_WORKSPACE. `dirname(root)` is used rather than the home
// directory because it is the tree the operator actually works in, and it keeps the default portable
// instead of naming one machine's path.
const workspace = process.argv[2] ?? process.env.AAAAGENT_HARNESS_WORKSPACE ?? dirname(root);
const workspaceOk = existsSync(workspace);
if (workspaceOk) console.log('  Harness 工作区: ' + workspace);
else console.log('  ⚠ Harness 工作区不存在（' + workspace + '），桌宠将回退到自带的空工作区');

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

// Wait for the backend to publish its management session. That file is the same signal the console
// uses, so a launcher that reports success here is reporting something already proven reachable —
// and a failure is reported instead of exiting silently while the pet never appears.
const sessionFile = join(root, '.local', 'model-evaluation', 'trial', 'user-trial', 'management-session.json');
console.log('  正在启动桌宠（后台运行，无窗口），等待后端就绪…');
const deadline = Date.now() + 120000;
let ready = false;
while (Date.now() < deadline) {
  if (spawnError) break;
  if (pet.exitCode !== null) break;
  if (existsSync(sessionFile)) { ready = true; break; }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (ready) {
  console.log('  ✅ 桌宠已就绪。');
} else if (spawnError) {
  console.log('  ❌ 桌宠启动失败: ' + spawnError.slice(0, 200));
  process.exitCode = 1;
} else {
  console.log('  ⚠ 桌宠未在 120 秒内就绪，请把下面的日志发给协助者。');
  process.exitCode = 1;
}
console.log('');
console.log('  日志: .local\\pet-launch.log / pet-launch.err.log');
console.log('  退出桌宠请用桌宠面板的退出按钮。');
