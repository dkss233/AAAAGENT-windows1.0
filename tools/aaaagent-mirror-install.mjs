// Install and build this project against the npmmirror (Alibaba Cloud) mirrors.
//
// Why the mirror: `npm ci` otherwise fetches prebuilt binaries from GitHub releases, which times out on
// many networks; the timeout then falls back to compiling from source, which needs Python and the
// Visual Studio C++ build tools. npmmirror serves both the packages and the prebuilt binaries.
//
// This module holds the logic only, because two callers need it with different amounts of narration:
//   - tools/aaaagent-install-mirror.mjs  — the explicit entry, prints the full banner
//   - tools/aaaagent-start.mjs           — offers it once when the preflight finds a fresh source tree
// Keeping it here means both run the same four commands with the same environment.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const MIRROR = 'https://registry.npmmirror.com';

// The npm_* names must be visible to the npm child; ELECTRON_MIRROR is read by Electron's own installer
// and better_sqlite3_binary_host_mirror by prebuild-install.
export const mirrorEnv = Object.freeze({
  npm_config_registry: MIRROR,
  npm_config_disturl: 'https://npmmirror.com/mirrors/node',
  npm_config_electron_mirror: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  better_sqlite3_binary_host_mirror: 'https://registry.npmmirror.com/-/binary/better-sqlite3',
});

// npm on Windows is a .cmd shim, so it needs a shell. `shell: true` with an argument array triggers
// DEP0190 (arguments are concatenated, not escaped) and printed a deprecation warning at the operator
// during a first install, so cmd.exe is invoked explicitly instead. `command` is a constant here and
// no argument comes from operator input, so there is nothing to escape either way.
const isWindows = process.platform === 'win32';
function run(command, args, cwd, say) {
  return new Promise((done) => {
    const child = isWindows
      ? spawn('cmd.exe', ['/d', '/c', command + '.cmd', ...args], { cwd, stdio: 'inherit', windowsHide: true })
      : spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', (error) => { say('  无法执行 ' + command + '：' + error.message); done(1); });
    // cmd.exe reports a failing child as an unsigned 32-bit value (1 becomes 4294967295); keep only
    // the low byte so "did it fail" stays readable.
    child.on('close', (code) => done(code === null ? 1 : (code & 0xff)));
  });
}

/** Run a node script directly: node.exe is not a .cmd shim, so it must not go through run(). */
const runNode = (args, cwd, say) => new Promise((done) => {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true });
  child.on('error', (error) => { say('  无法执行 node：' + error.message); done(1); });
  child.on('close', (code) => done(code === null ? 1 : (code & 0xff)));
});

/**
 * Install dependencies and build, using the mirror. Returns true only when all four commands succeed.
 * `say` receives operator-facing lines, so a caller can choose how much to narrate.
 */
export async function installWithMirror(root, say = console.log) {
  const repo = join(root, 'code', 'desktop-pet');
  const env = { ...process.env, ...mirrorEnv };
  const rule = () => say('  ' + '-'.repeat(44));

  say('');
  rule();
  say('    AAAAGENT 桌宠 · 用国内镜像安装依赖');
  rule();
  say('');
  say('  适用：npm 下载超时、或 better-sqlite3 编译失败（缺 Python / C++ 生成工具）');
  say('  原理：让 npm 与预编译二进制都从 npmmirror（阿里云公共镜像）获取');
  say('');
  say('  检测到 Node.js ' + process.version);
  say('');
  rule();
  say('   第 1 步：安装依赖（从镜像下载）');
  rule();
  say('');

  if (existsSync(join(repo, 'node_modules'))) {
    say('  已存在 node_modules，npm ci 会先删除它再重新安装。');
    say('');
  }

  // `npm ci` deletes node_modules itself and refuses to run against a partial tree. An earlier version
  // of this flow instead ran `rmdir /s /q node_modules` first, which deleted the working dependencies
  // even when the reinstall then failed and there was no backup — one session lost node_modules to
  // exactly that. Let npm own that decision.
  if (await run('npm', ['ci'], repo, say) !== 0) {
    say('');
    say('  [失败] 依赖安装未成功。');
    say('');
    say('  若报错仍提到 better-sqlite3 编译失败，说明你的 Node 版本没有对应的');
    say('  预编译二进制（镜像只提供 Node 22 / 24 / 25 / 26）。');
    say('  解决办法：换成 Node.js 22 或 24 的 LTS 版再试。');
    say('');
    return false;
  }
  say('');
  say('  [1/3] 依赖安装完成。');

  // Electron 44 ships install.js but declares no postinstall, so npm never downloads the ~100 MB
  // runtime binary. The pet's launcher needs it (node_modules/electron/dist/electron.exe), and
  // without it the window cannot open even though every dependency is installed.
  const electronBinary = join(repo, 'node_modules', 'electron', 'dist',
    isWindows ? 'electron.exe' : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
  if (!existsSync(electronBinary)) {
    say('');
    rule();
    say('   第 2 步：下载 Electron 运行时（约 100 MB）');
    rule();
    say('');
    if (await runNode(['node_modules/electron/install.js'], repo, say) !== 0 || !existsSync(electronBinary)) {
      say('');
      say('  [失败] Electron 运行时未下载成功。请检查网络后重新双击启动。');
      say('');
      return false;
    }
    say('');
    say('  [2/3] Electron 运行时完成。');
  } else {
    say('  [2/3] Electron 运行时已存在，跳过。');
  }

  say('');
  rule();
  say('   第 3 步：编译后端与界面');
  rule();
  say('');
  if (await run('npm', ['run', 'build'], repo, say) !== 0) {
    say('  [失败] 后端编译未成功。');
    return false;
  }
  if (await run('npm', ['run', 'build:desktop'], repo, say) !== 0) {
    say('  [失败] 界面打包未成功。');
    return false;
  }
  say('');
  say('  [3/3] 编译完成。');
  say('');
  return true;
}
