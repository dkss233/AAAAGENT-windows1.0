// Start the pinned DSH host on demand.
//
// The pet's chat, voice and expressions do not need DSH; only "使用harness干活" style tasks do. So
// the host is started by an explicit action instead of on every pet launch. Safe to run repeatedly:
// an already-running host is reused and reported.
//
// The DSH working directory defaults to the project's parent directory — the tree the operator works
// in — rather than naming one machine's path. Override with the first argument or
// AAAAGENT_HARNESS_WORKSPACE.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile, originAlive, readOrigin, readTokenUrl, startHarnessHost } from './aaaagent-harness-host.mjs';

// tools/ sits directly under the project root, so derive it instead of hard-coding an install path.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = loadProfile(root);
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
