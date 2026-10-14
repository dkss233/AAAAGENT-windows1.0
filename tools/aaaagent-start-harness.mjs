// Start the pinned DSH host on demand.
//
// The pet's chat, voice and expressions do not need DSH; only "使用harness干活" style tasks do. So
// the host is started by an explicit action instead of on every pet launch. Safe to run repeatedly:
// an already-running host is reused and reported.
//
// The DSH working directory defaults to the project's parent directory — the tree the operator works
// in — rather than naming one machine's path. Override with the first argument or
// AAAAGENT_HARNESS_WORKSPACE.
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadProfile, originAlive, readOrigin, readTokenUrl, startHarnessHost } from './aaaagent-harness-host.mjs';

// tools/ sits directly under the project root, so derive it instead of hard-coding an install path.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(root, 'code', 'desktop-pet');

// This entry point does need the build output, because loadProfile reads the pinned engine bindings.
// Say so plainly rather than letting the import chain fail with an ESM resolution error.
if (!existsSync(join(repo, 'dist', 'app', 'trial-launcher.js'))) {
  console.log('  ============================================');
  console.log('   还不能启动 —— 项目尚未编译');
  console.log('  ============================================');
  console.log('');
  console.log('  请在  命令提示符(cmd)  里依次执行：');
  console.log('');
  console.log('      cd /d "' + repo + '"');
  console.log('      npm ci');
  console.log('      npm run build');
  console.log('      npm run build:desktop');
  console.log('');
  console.log('  完成后重新双击  启动Harness.cmd。');
  console.log('  详细说明：docs/SETUP.md 、 README-WINDOWS.md');
  console.log('');
  process.exit(1);
}

// The engine runtime is a separate ~1.3 GB download and is genuinely required here: this script starts
// the pinned DSH host itself. Report that instead of "引擎档案无效", which does not say what to obtain.
const profile = (() => {
  try { return loadProfile(root); }
  catch {
    console.log('  ============================================');
    console.log('   缺少引擎运行时，无法启动 Harness 主机');
    console.log('  ============================================');
    console.log('');
    console.log('  这个脚本要在  artifacts/runtime/  里启动 DSH 主机，');
    console.log('  而该目录（约 1.3 GB）不随仓库提供，需要单独准备。');
    console.log('');
    console.log('  准备方法与引擎版本要求见：');
    console.log('      README-WINDOWS.md');
    console.log('      code/workbench/integration/engine-pins/README.md');
    console.log('');
    console.log('  说明：桌宠的对话、语音、表情、注视都不需要引擎，');
    console.log('        只有「使用harness干活」这类 DSH 任务才需要它。');
    console.log('');
    process.exit(1);
  }
})();
const workspace = process.argv[2] ?? process.env.AAAAGENT_HARNESS_WORKSPACE ?? dirname(root);

console.log('=== 启动 Harness 主机 ===');
console.log('  工作区（DSH 会话运行目录）: ' + workspace);

const existing = readOrigin(profile.dshWebLog);
if (await originAlive(existing)) {
  console.log('  ✅ 主机已在运行: ' + existing);
} else {
  const result = await startHarnessHost({ profile, root, onNote: (note) => console.log('  ' + note) });
  if (!result.origin) {
    console.log('  ❌ 主机未能在 120 秒内就绪。');
    console.log('     请把本窗口的信息发给协助者。');
    process.exitCode = 1;
  } else {
    console.log('  ✅ 主机已就绪: ' + result.origin);
  }
}

const tokenUrl = readTokenUrl(profile.dshWebLog);
if (tokenUrl) {
  console.log('');
  console.log('  Harness 界面地址（含 token，可粘贴到浏览器）:');
  console.log('    ' + tokenUrl);
}
console.log('');
console.log('  现在可以启动桌宠了；桌宠会自动复用这个主机。');
console.log('  主机是独立进程，关闭本窗口不会停止它。');
