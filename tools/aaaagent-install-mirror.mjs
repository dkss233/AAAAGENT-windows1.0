// Standalone entry for the mirror install: `node tools/aaaagent-install-mirror.mjs`.
//
// The logic lives in aaaagent-mirror-install.mjs, which aaaagent-start.mjs also calls when its preflight
// finds a fresh source tree and the operator agrees to install. This file is only the standalone entry,
// so the two callers cannot drift.
//
// Every operator-facing Chinese message is printed here or by that module, never by a .cmd wrapper.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installWithMirror } from './aaaagent-mirror-install.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!await installWithMirror(root, console.log)) process.exit(1);

if (process.argv.includes('--no-launch')) {
  console.log('');
  console.log('  ============================================');
  console.log('   安装与构建完成');
  console.log('  ============================================');
  console.log('');
  process.exit(0);
}

console.log('');
console.log('  ============================================');
console.log('   安装完成，正在启动桌宠');
console.log('  ============================================');
console.log('');

// Hand off to the launcher so a fresh install starts the pet the same way a normal double-click does.
const child = spawn(process.execPath, [join(root, 'tools', 'aaaagent-start.mjs')], { cwd: root, stdio: 'inherit' });
child.on('close', (code) => { process.exitCode = code === null ? 1 : code; });
