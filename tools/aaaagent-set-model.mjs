// Replace the pet's Live2D model from a folder on disk.
//
// The console exposes this only during first-run setup, so after初始化 there is no UI for it.
// This calls the pet's own importer, which validates the rig, clears the previous one, copies it
// into both asset directories, renames the entry to pet.model3.json and rewrites presets.json.
//
// Usage:
//   node tools\aaaagent-set-model.mjs "D:\path\to\my-model"     replace the model
//   node tools\aaaagent-set-model.mjs --inspect "D:\path\to"    check a folder without changing anything
//   node tools\aaaagent-set-model.mjs                           show the model in use
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { inspectLive2dModel, importLive2dModel, ModelImportError } from '../code/desktop-pet/dist/app/local-model-import.js';

// The importer resolves 'desktop/assets/...' against the project root, which is the desktop-pet
// package directory, not the repository root.
const windowsRoot = join(import.meta.dirname, '..');
const root = join(windowsRoot, 'code', 'desktop-pet');
const assetDir = join(root, 'desktop', 'assets', 'local-model');
const presetFile = join(assetDir, 'presets.json');

const showCurrent = () => {
  if (!existsSync(presetFile)) { console.log('  当前没有已安装的模型（未找到 presets.json）。'); return; }
  try {
    const preset = JSON.parse(readFileSync(presetFile, 'utf8'));
    const entries = existsSync(assetDir)
      ? readFileSync(join(assetDir, 'pet.model3.json'), 'utf8')
      : '';
    const expressions = (preset.items ?? []).filter((i) => i.category === 'expression').map((i) => i.label);
    console.log('  当前模型目录: ' + assetDir);
    console.log('  模型标识    : ' + preset.modelId);
    console.log('  指纹        : ' + String(preset.modelFingerprint).slice(0, 24) + '…');
    console.log('  表情        : ' + (expressions.length ? expressions.join('、') : '（无）'));
    console.log('  入口文件    : ' + (entries ? 'pet.model3.json 存在' : '缺失'));
  } catch (error) {
    console.log('  无法读取当前模型: ' + String(error.message).slice(0, 120));
  }
};

// VTS exports are commonly wrapped in an extra folder of the same name, so the path an operator
// drags in often holds no entry document. Descend to the single child directory that does, instead
// of failing with "没有 *.model3.json".
const hasEntry = (dir) => {
  try { return readdirSync(dir).some((name) => name.endsWith('.model3.json')); } catch { return false; }
};
const descendToModel = (dir) => {
  if (hasEntry(dir)) return dir;
  let children;
  try { children = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name)); }
  catch { return dir; }
  const withEntry = children.filter(hasEntry);
  if (withEntry.length !== 1) return dir;
  console.log('  ⚠ 这个文件夹里没有模型入口，自动进入子文件夹：' + basename(withEntry[0]));
  return descendToModel(withEntry[0]);
};

const args = process.argv.slice(2);
const inspectOnly = args[0] === '--inspect';
const directory = inspectOnly ? args[1] : args[0];

if (!args.length || args[0] === '--help' || args[0] === '-h') {
  console.log('=== 当前 Live2D 模型 ===');
  showCurrent();
  console.log('');
  console.log('  换模型:  node tools\\aaaagent-set-model.mjs "你的模型文件夹"');
  console.log('  先检查:  node tools\\aaaagent-set-model.mjs --inspect "你的模型文件夹"');
  process.exit(0);
}

if (!directory) {
  console.log('  用法:');
  console.log('    node tools\\aaaagent-set-model.mjs "D:\\path\\to\\my-model"     安装这个模型');
  console.log('    node tools\\aaaagent-set-model.mjs --inspect "D:\\path\\to"    只检查，不改动');
  console.log('    node tools\\aaaagent-set-model.mjs                            查看当前模型');
  process.exit(2);
}

if (!existsSync(directory)) {
  console.log('  ❌ 找不到这个文件夹：' + directory);
  process.exit(1);
}

// VTS and similar tools keep their expression list in a .vtube.json sidecar, so the exported
// model3.json often lacks FileReferences.Expressions and the importer rejects it. Rather than make
// the operator run a second tool, stage a copy with the references injected from the *.exp3.json
// files that are actually present. The original model folder is never modified.
const { cpSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
const stageModel = (source) => {
  const stageRoot = join(windowsRoot, '.local', 'model-staging');
  mkdirSync(stageRoot, { recursive: true });
  const stage = join(stageRoot, basename(resolve(source)));
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  console.log('  → 复制到暂存目录并补全表情引用（原目录不动）');
  cpSync(source, stage, { recursive: true, force: true });
  const entries = readdirSync(stage).filter((name) => name.endsWith('.model3.json'));
  if (entries.length !== 1) return { ok: false, reason: '期望恰好一个 .model3.json，实际 ' + entries.length + ' 个' };
  const expressionFiles = readdirSync(stage).filter((name) => name.endsWith('.exp3.json')).sort();
  if (!expressionFiles.length) return { ok: false, reason: '目录里没有 .exp3.json 表情文件，无法补全' };
  const entryPath = join(stage, entries[0]);
  const entry = JSON.parse(readFileSync(entryPath, 'utf8'));
  entry.FileReferences ??= {};
  entry.FileReferences.Expressions = expressionFiles.map((file) => ({ Name: file.replace(/\.exp3\.json$/, ''), File: file }));
  writeFileSync(entryPath, JSON.stringify(entry, null, 2) + '\n', 'utf8');
  console.log('     补上 ' + expressionFiles.length + ' 个表情引用: ' + expressionFiles.map((f) => f.replace(/\.exp3\.json$/, '')).join('、'));
  return { ok: true, stage };
};

console.log('=== 检查 ' + directory + ' ===');
// Swapping while the pet runs is possible (no file is locked), but the running renderer keeps the
// old rig in memory and will not reload it, so a restart is required either way. Say so up front
// instead of letting the operator wonder why nothing changed.
const { execFileSync: execSync } = await import('node:child_process');
const petRunning = (() => {
  // Check the command lines directly: Electron's own processes are the only ones whose command line
  // mentions the desktop package, so no window-title heuristics are needed.
  for (const [command, args] of [
    ['wmic', ['process', 'where', "name='electron.exe'", 'get', 'commandline']],
    ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }']],
  ]) {
    try {
      const out = execSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      if (String(out).includes('desktop-pet')) return true;
    } catch { /* try the next probe */ }
  }
  return false;
})();
if (petRunning) {
  console.log('  ℹ 桌宠正在运行。换模型不会损坏它，但运行中的桌宠不会重新加载模型，');
  console.log('    所以完成之后一定要重启桌宠（先退出，再双击 启动桌宠.cmd）。');
  console.log('');
}

let target = descendToModel(resolve(directory));
let info;
try {
  info = await inspectLive2dModel(target);
} catch (error) {
  console.log('  ❌ ' + (error instanceof ModelImportError ? error.message : String(error.message).slice(0, 200)));
  process.exit(1);
}
// The inspection is a discriminated union: failures carry a reason instead of the fields.
let staged = false;
if (!info?.ok) {
  console.log('  ⚠ ' + (info?.reason ?? '未知原因'));
  console.log('     这个模型缺少必需的表情声明，尝试自动补全…');
  const prepared = stageModel(target);
  if (!prepared.ok) { console.log('  ❌ ' + prepared.reason); process.exit(1); }
  target = prepared.stage; staged = true;
  console.log('');
  console.log('=== 重新检查暂存副本 ===');
  try {
    info = await inspectLive2dModel(target);
  } catch (error) {
    console.log('  ❌ ' + (error instanceof ModelImportError ? error.message : String(error.message).slice(0, 200)));
    process.exit(1);
  }
}
if (!info?.ok) {
  console.log('  ❌ 这个文件夹不能用作模型：' + (info?.reason ?? '未知原因'));
  process.exit(1);
}
console.log('  入口文件  : ' + info.entryFile + (info.willRename ? '（将重命名为 pet.model3.json）' : '') + (staged ? '（来自暂存副本）' : ''));
console.log('  文件数    : ' + info.files);
console.log('  表情      : ' + (info.expressions?.length ? info.expressions.join('、') : '（无）'));
console.log('  动作      : ' + (info.hasMotions ? '有' : '无') + '   自动眨眼: ' + (info.hasBlink ? '支持' : '不支持'));

if (inspectOnly) { console.log('\n  只检查，未做任何改动。'); process.exit(0); }

console.log('\n=== 安装 ===');
try {
  const result = await importLive2dModel(root, target);
  const count = result.expressions ?? result.files ?? 0;
  console.log('  ✅ 已安装: ' + count + ' 个表情' + (result.automatic?.length ? '，自动行为: ' + result.automatic.join('、') : ''));
  if (result.modelFingerprint) console.log('     指纹: ' + String(result.modelFingerprint).slice(0, 24) + '…');
} catch (error) {
  console.log('  ❌ 安装失败: ' + (error instanceof ModelImportError ? error.message : String(error.message).slice(0, 200)));
  process.exit(1);
}
// The staging copy only exists to feed the importer; the installed assets are independent of it.
if (staged) rmSync(target, { recursive: true, force: true });

console.log('');
console.log('=== 安装后 ===');
showCurrent();

// presets.json is imported at build time, so the renderer has to be rebuilt or the pet refuses to
// start with 模型与预设目录版本不一致. The runtime fingerprint covers these files too, so it must be
// re-pinned afterwards. Both steps run here so replacing a model stays a single command.
const { execFileSync } = await import('node:child_process');

const step = (label, args) => {
  console.log('');
  console.log('  → ' + label);
  try {
    execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    return true;
  } catch (error) {
    console.log('  ❌ ' + label + ' 失败: ' + String(error.message).slice(0, 160));
    return false;
  }
};

console.log('');
console.log('=== 让改动生效 ===');
const built = step('重新构建网页素材（把新 presets.json 烘焙进渲染器）', [join(root, 'desktop', 'build-web.mjs')])
  && step('重新构建预览素材', [join(root, 'desktop', 'build-presentation-preview.mjs')]);
if (!built) {
  console.log('');
  console.log('     请手动执行: cd ' + root + '  然后  npm run build:desktop');
  process.exit(1);
}
if (!step('重新固定运行时指纹', [join(root, 'tools', 'repin-config.mjs'), '--activate'])) {
  console.log('');
  console.log('     请手动执行: cd ' + root + '  然后  node tools\\repin-config.mjs --activate');
  process.exit(1);
}

console.log('');
console.log('  ✅ 全部完成。');
console.log('');
console.log('  请重启桌宠以加载新模型（先退出当前桌宠，再双击 启动桌宠.cmd）。');
console.log('  新模型的表情会自动出现在控制台的「表情与动作」页，可设置情绪映射与持续启用。');;
