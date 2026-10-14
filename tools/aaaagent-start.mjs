// One-click launcher.
// Starts the pet. The pinned DSH host is reused when one is already running but is NOT started here:
// nothing in the chat, voice or expression path needs it, which is the on-demand behaviour described
// in 使用说明.txt. The AAAAGENT_START_HARNESS=1 opt-in that used to start it up front was removed
// because it was never exercised — the host is started from the console button or 启动Harness.cmd.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, originAlive, readOrigin, readTokenUrl } from './aaaagent-harness-host.mjs';
import { clearOrphanedPetProcesses } from './aaaagent-pet-orphans.mjs';
// Starting the host itself (spawn/openSync/engineEnvironment) lives in aaaagent-harness-host.mjs.

// tools/ sits directly under the project root, so derive it instead of hard-coding an install path.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = loadProfile(root);

// A stale lock from an earlier attempt makes the project refuse a new host; clear only ours.
for (const name of ['.aaaagent-dsh-host.lock', '.aaaagent-dsh-host.json']) {
  const p = join(profile.home, name);
  if (existsSync(p)) { try { unlinkSync(p); console.log('  已清理残留的 ' + name); } catch { /* ignore */ } }
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

const repo = join(root, 'code\\desktop-pet');

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
const logFd = openSync(join(root, '.local', 'pet-launch.log'), 'w');
const errFd = openSync(join(root, '.local', 'pet-launch.err.log'), 'w');
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
