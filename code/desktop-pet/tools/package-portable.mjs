/**
 * Build a portable, no-install distribution of the desktop pet.
 *
 * The result is a folder the user unzips and double-clicks. Nothing is installed and no Node.js
 * is required on the machine: the distribution carries both an Electron runtime and a Node
 * runtime. First launch opens the local setup screen (API keys + a Live2D model folder), which
 * writes the configuration pair for *that* directory, so the copy is relocatable.
 *
 * Runtime layout (the launcher derives the project root as `../../../..` from its own file):
 *
 *   <install>/AAAAGENT.cmd              double-click entry
 *   <install>/package.json              electron main = shell.mjs
 *   <install>/shell.mjs                 sets process.execPath, then starts the launcher
 *   <install>/runtime/electron/         Electron binary + assets
 *   <install>/runtime/node/node.exe     Node used for the backend (keeps native ABI stable)
 *   <install>/code/desktop-pet/…        the application, dependencies and assets
 *
 * The backend is deliberately run by the bundled plain Node rather than Electron's bundled Node:
 * `better-sqlite3` is compiled for the Node ABI, so this avoids an ABI rebuild.
 *
 * Usage: node tools/package-portable.mjs [--keep-stage]
 */
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const outRoot = resolve(repo, 'build', 'portable');
const stage = resolve(repo, 'build', 'portable-stage');
const appDir = resolve(stage, 'code', 'desktop-pet');
const keepStage = process.argv.includes('--keep-stage');
const NODE_VERSION = process.version;

const log = (message) => process.stdout.write(message + '\n');
const step = (message) => process.stdout.write('  ' + message + '\n');

const SKIP_DIRS = new Set(['node_modules', '.cache', '.git', 'artifacts', '.local', 'coverage', 'out']);
/**
 * Paths that never ship. `build` needs care: the repo's own output directory is skipped, but
 * `desktop/build/renderer.js` is a required runtime artifact produced by `npm run build:desktop`,
 * and the setup readiness check refuses to finish without it.
 */
function shouldSkip(source) {
  const name = source.split(/[\\/]/).pop();
  if (SKIP_DIRS.has(name)) return true;
  // Debugging aids are dropped before the build-directory rule can trip over them.
  if (name.endsWith('.map')) return true;
  if (name !== 'build') return false;
  const rel = relative(repo, source).split('\\').join('/');
  if (rel === 'build') return true;                       // the packager's own output
  return !(rel.startsWith('desktop/build') || rel.startsWith('tools/build'));
}
/** Source directories that make up the application. */
const APP_DIRS = ['dist', 'desktop', 'tools', 'contracts', 'management', 'config',
  'app', 'core', 'providers', 'memory', 'companion', 'harness', 'media', 'projects', 'workbench'];

async function copyTree(from, to) {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, {
    recursive: true, dereference: false, force: true,
    filter: (source) => !shouldSkip(source),
  });
}

async function dirSize(dir) {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(full);
    else if (entry.isFile()) total += (await stat(full)).size;
  }
  return total;
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`下载失败 ${response.status}: ${url}`);
  await mkdir(dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
}

// ---------------------------------------------------------------- clean
log('打包 AAAAGENT 桌宠（绿色免安装）');
const electronVersion = JSON.parse(readFileSync(resolve(repo, 'node_modules/electron/package.json'), 'utf8')).version;
step(`Electron ${electronVersion} · Node ${NODE_VERSION}`);
await rm(outRoot, { recursive: true, force: true });
await rm(stage, { recursive: true, force: true });
await mkdir(appDir, { recursive: true });

// ---------------------------------------------------------------- application
step('复制应用代码…');
for (const name of [...APP_DIRS, 'package.json']) {
  const from = resolve(repo, name);
  if (existsSync(from)) await copyTree(from, resolve(appDir, name));
}

// ---------------------------------------------------------------- dependencies
step('安装生产依赖…');
const sourcePackage = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8'));
if (existsSync(resolve(appDir, 'node_modules'))) await rm(resolve(appDir, 'node_modules'), { recursive: true, force: true });
await writeFile(resolve(appDir, 'package.json'), JSON.stringify({
  name: sourcePackage.name, version: sourcePackage.version, private: true, type: 'module',
  dependencies: sourcePackage.dependencies ?? {},
}, null, 2) + '\n', 'utf8');
const npm = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: appDir, encoding: 'utf8', shell: process.platform === 'win32' });
if (npm.status !== 0) {
  step('npm 输出尾部: ' + String(npm.stdout ?? '').split('\n').slice(-4).join(' | '));
  step('npm 错误尾部: ' + String(npm.stderr ?? '').split('\n').slice(-4).join(' | '));
  throw new Error('生产依赖安装失败');
}
step('依赖就绪');

// ---------------------------------------------------------------- electron stub
// The launcher asks `require('electron')` for the desktop executable. Inside the distribution
// that must resolve to the shipped runtime rather than trigger a download.
const electronStub = resolve(appDir, 'node_modules', 'electron');
await rm(electronStub, { recursive: true, force: true });
await mkdir(electronStub, { recursive: true });
await writeFile(resolve(electronStub, 'package.json'),
  JSON.stringify({ name: 'electron', version: electronVersion, main: 'index.js' }, null, 2) + '\n', 'utf8');
// The stub lives at <install>/code/desktop-pet/node_modules/electron/index.js. Derive the hop by
// asking the path library for the real relationship, so no separator counting can drift.
const stubToRoot = relative(electronStub, resolve(stage, 'runtime', 'electron'))
  .split(/[\\/]/).filter((part) => part === '..');
await writeFile(resolve(electronStub, 'index.js'),
  "// Points at the Electron binary shipped with this distribution.\n" +
  "const path = require('node:path');\n" +
  `module.exports = path.resolve(__dirname, ${stubToRoot.map((s) => `'${s}'`).join(', ')}, 'runtime', 'electron',\n` +
  "  process.platform === 'win32' ? 'electron.exe' : 'electron');\n", 'utf8');
// Fail loudly rather than shipping a distribution that cannot find its own runtime. Checked
// after the runtimes are copied, below.

// ---------------------------------------------------------------- runtimes
step('复制 Electron 运行时…');
const probe = spawnSync(process.execPath, ['-e', "process.stdout.write(require('electron'))"], { cwd: repo, encoding: 'utf8' });
const electronBinary = String(probe.stdout ?? '').trim();
if (!electronBinary || !existsSync(electronBinary)) throw new Error('找不到 Electron 运行时: ' + electronBinary);
await cp(dirname(electronBinary), resolve(stage, 'runtime', 'electron'), { recursive: true, force: true });
step('Electron: ' + (await readdir(resolve(stage, 'runtime', 'electron'))).length + ' 项');

step(`准备 Node ${NODE_VERSION} 运行时…`);
const nodeTarget = resolve(stage, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
await mkdir(dirname(nodeTarget), { recursive: true });
// The packaging host already runs this exact Node version, so copy it. That guarantees the ABI
// the production dependencies were installed for, without depending on an external download.
if (existsSync(process.execPath)) {
  await cp(process.execPath, nodeTarget, { force: true });
  step('使用打包机的 Node: ' + process.execPath);
} else {
  // Fallback: fetch the official build. Note the archive is named `win-x64`, not `win32-x64`.
  const archive = `node-${NODE_VERSION}-win-x64`;
  const cache = resolve(repo, 'build', 'cache', `${archive}.zip`);
  const extracted = resolve(repo, 'build', 'cache', archive);
  if (!existsSync(cache)) {
    step('下载 ' + archive + '…');
    await download(`https://nodejs.org/dist/${NODE_VERSION}/${archive}.zip`, cache);
  }
  if (!existsSync(join(extracted, archive, 'node.exe'))) {
    await rm(extracted, { recursive: true, force: true });
    await mkdir(extracted, { recursive: true });
    const unzip = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${cache}' -DestinationPath '${extracted}' -Force`], { encoding: 'utf8' });
    if (unzip.status !== 0) throw new Error('解压 Node 失败: ' + String(unzip.stderr ?? '').slice(0, 200));
  }
  await cp(join(extracted, archive, 'node.exe'), nodeTarget, { force: true });
}
step('Node: ' + (await stat(nodeTarget)).size + ' bytes');

// Authoritative check: load the stub the way the launcher will and confirm it names a real file.
const stubTarget = createRequire(resolve(electronStub, 'index.js'))('electron');
if (typeof stubTarget !== 'string' || !existsSync(stubTarget)) {
  throw new Error('electron 定位桩解析失败: ' + String(stubTarget));
}
step('electron 定位桩 → ' + stubTarget);

// ---------------------------------------------------------------- entry
step('写入启动入口…');
await writeFile(resolve(stage, 'package.json'), JSON.stringify({
  name: 'aaaagent-pet-portable', version: sourcePackage.version, private: true,
  type: 'module', main: 'shell.mjs',
}, null, 2) + '\n', 'utf8');
// Keep the launcher's assumption intact: it treats process.execPath as the "system node" used for
// the backend. Pointing that at the bundled plain Node preserves better-sqlite3's Node ABI.
await writeFile(resolve(stage, 'shell.mjs'),
  `// Portable entry point. Electron runs this file as its main process; startPet then opens the
// setup screen on first run and spawns the pet and the backend. process.execPath is re-pointed at
// the bundled Node so the backend runs on the Node ABI its native modules were built for.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
process.execPath = resolve(here, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
// Tells the pet to keep its window state inside this folder. Without it every copy on the machine
// shares one userData directory and Electron's single-instance lock makes the second copy exit
// silently with no window.
process.env.AAAAGENT_PORTABLE_ROOT = here;
// This shell is itself Electron, so a plain require('electron') here would return Electron's own
// API object rather than the desktop binary's path. Hand the launcher the path explicitly.
process.env.AAAAGENT_DESKTOP_EXECUTABLE = resolve(here, 'runtime', 'electron',
  process.platform === 'win32' ? 'electron.exe' : 'electron');

const { startPet } = await import('./code/desktop-pet/dist/app/trial-launcher.js');
try {
  await startPet(here);
} catch (error) {
  // Never leave the operator with a silent window: name the reason and keep it visible.
  process.stderr.write((error instanceof Error && error.message ? error.message : String(error)) + '\\n');
  await new Promise((done) => setTimeout(done, 15000));
  process.exitCode = 1;
}
`, 'utf8');
if (process.platform === 'win32') {
  const launcher = '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nstart "" "%~dp0runtime\\electron\\electron.exe" "%~dp0"\r\n';
  await writeFile(resolve(stage, 'AAAAGENT.cmd'), launcher, 'utf8');
  await writeFile(resolve(stage, '启动桌宠.cmd'), launcher, 'utf8');
}
await mkdir(resolve(stage, '.local', 'model-evaluation', 'trial'), { recursive: true });
await mkdir(resolve(stage, '.local', 'data'), { recursive: true });
await writeFile(resolve(stage, '使用说明.txt'), [
  'AAAAGENT 桌宠 · 绿色免安装版',
  '================================',
  '',
  '【怎么启动】',
  '  双击本目录下的「启动桌宠.cmd」（或 AAAAGENT.cmd）。',
  '  不需要安装任何东西，也不需要预先装 Node.js。',
  '',
  '【第一次启动】',
  '  程序会自动打开一个浏览器设置页面，请按顺序完成：',
  '    1. 填写 API Key —— 两个都需要（缺任一个都无法完成设置）',
  '       · DeepSeek Key ：负责文本对话、摘要、记忆维护',
  '       · 阿里云百炼 Key：负责语音合成、语音识别、视频情绪',
  '       Key 只保存在本机，不会上传，页面也不回显。',
  '    2. 在「选择模型与音色」里，为每个模块选择对应供应商的凭据',
  '       （保存 Key 只完成一半，槽位必须绑定）',
  '    3. 选择 Live2D 模型',
  '       填入你电脑上 Live2D 模型文件夹的完整路径，例如 D:\\Live2D\\MyModel。',
  '       要求：Cubism 3/4 模型，文件夹里要有 .model3.json、.moc3、物理文件',
  '       和至少一个表情文件（.exp3.json）。',
  '       点击「检查这个文件夹」确认识别结果，再点「安装并使用这个模型」。',
  '       程序会把模型复制到素材目录，原文件夹不会被修改。',
  '    4. 点「完成设置，准备重启」，然后关闭页面并重新双击启动。',
  '',
  '  模型版权归你所有：请自行确认你有权使用所选素材。',
  '',
  '【重要 · Live2D 授权须知】',
  '  本程序内置 Live2D Cubism SDK 运行库，并且允许载入使用者自备的模型。',
  '  按 Live2D Inc. 的官方定义，这类「可以添加/组合文件从而产生无限多个模型」的',
  '  作品属于「可扩展应用（Expandable Application）」。',
  '',
  '  官方原文（https://www.live2d.com/en/sdk/license/expandable/ ）：',
  '    "Expandable Application means any work having significant expandability ...',
  '     In particular, it includes the Derivative Work which uses and generates any',
  '     indefinite numbers of models by adding or combining files or data (e.g. avatar)"',
  '    "every Expandable Application needs to be reviewed for approval and enter into',
  '     a special Publication License Agreement before its release. These requirements',
  '     are applied to all publishers including General Users and Small-Scale',
  '     Enterprises who are normally exempted from the Publication License Agreement',
  '     for non-Expandable Applications."',
  '',
  '  这意味着：个人或小微企业通常享有的免费豁免【不适用于】本程序。',
  '  在对外发布之前，需要先经 Live2D Inc. 审核并签订专门的发布许可协议，',
  '  且审核条件之一是「存在有效的营收模式（通常情况下完全免费不予批准）」，',
  '  并按销售分成（个人/小微企业为每笔 300 日元或销售额 20% 取高者）。',
  '',
  '  因此本说明页【不构成法律意见】。请你在分发本程序之前，',
  '  自行核对最新条款，或通过官方表单咨询：',
  '    https://www.live2d.jp/eng/application-publication-license/',
  '  官方条款可能随时变更，请以官网为准。',
  '',
  '【日常使用】',
  '  · 退出请用桌宠面板上的退出按钮。',
  '  · 设置页面：再次启动时会自动打开运行控制台。',
  '  · 所有数据保存在本目录的 .local 文件夹内；',
  '    删除 .local 即恢复到「全新未配置」状态。',
  '  · 同一台电脑上同时只能运行一个本程序。若已经开着，',
  '    再次双击不会有任何反应（这是有意防止两个实例抢同一份数据）。',
  '',
  '【常见问题】',
  '  · 双击后没有反应：多半是已经有一个实例在运行。',
  '    先在任务管理器结束 electron.exe，或先退出原来那个桌宠。',
  '  · 页面提示「本机已有配置」：说明已经配置过了，直接重新双击启动即可。',
  '  · 页面提示「请保存所需 Key」但明明存过了：',
  '    还需要在「选择模型与音色」里把每个模块的凭据选上，只存 Key 不算完成。',
  '  · 提示「另一个设置窗口仍在运行」：',
  '    关闭其他设置页面，或删除 .local/model-evaluation/trial/user-trial/first-run.lock。',
  '  · 杀毒软件报警：Electron 应用偶发误报，允许即可。',
  '',
  '【系统要求】',
  '  Windows 10/11 64 位。本目录可以整个移动到任意位置（路径不要含特殊字符）。',
  '  如果移动过位置，首次在新位置启动会重新走一次设置（数据不通用）。',
  '',
].join('\r\n'), 'utf8');

// ---------------------------------------------------------------- move into place
step('整理输出目录…');
await mkdir(outRoot, { recursive: true });
for (const entry of await readdir(stage)) {
  await cp(resolve(stage, entry), resolve(outRoot, entry), { recursive: true, force: true, dereference: false });
}
if (!keepStage) await rm(stage, { recursive: true, force: true });

// ---------------------------------------------------------------- archive
// A folder is awkward to hand over; ship a single zip next to it as the thing you actually send.
const zipPath = resolve(repo, 'build', `AAAAGENT-pet-portable-${sourcePackage.version}.zip`);
step('压缩为 zip（这一步较慢）…');
await rm(zipPath, { force: true });
const zip = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  `Compress-Archive -Path '${outRoot}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`],
  { encoding: 'utf8' });
const zipOk = zip.status === 0 && existsSync(zipPath);
if (!zipOk) step('压缩失败: ' + String(zip.stderr ?? '').slice(0, 200));

log('');
log('✅ 打包完成');
log('   目录: ' + outRoot);
log('   体积: ' + ((await dirSize(outRoot)) / 1024 / 1024).toFixed(1) + ' MB');
if (zipOk) log('   压缩包: ' + zipPath + '  (' + ((await stat(zipPath)).size / 1024 / 1024).toFixed(1) + ' MB)');
log('   入口: 启动桌宠.cmd');
