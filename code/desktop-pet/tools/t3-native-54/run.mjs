import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.versions.node !== '24.13.1') throw new Error('Use fixed Node 24.13.1');
const taskRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const extra = process.argv.slice(3);
const outputAt = extra.indexOf('--output');
const output = resolve(taskRoot, outputAt < 0 ? 'artifacts/runtime/t3-native-ui-54' : extra[outputAt + 1]);
if (!output.startsWith(join(taskRoot, 'artifacts/runtime') + '/')) throw new Error('Output must stay in this worktree runtime');
if (outputAt >= 0) extra.splice(outputAt, 2);
const command = process.argv[2] ?? 'build';
const nativeRead = process.argv.includes('--native-read');
if (!['build', 'typecheck', 'test'].includes(command)) throw new Error('Only build/typecheck/bounded test supported');
const receipt = JSON.parse(readFileSync(join(output, '.aaa-native-ui.json'), 'utf8'));
const args = command === 'typecheck' ? [join(output, 'node_modules/typescript/bin/tsc'), '--noEmit']
  : ['--import', join(taskRoot, 'code/desktop-pet/tools/t3-native-54/offline.mjs'), join(output, 'apps/web/node_modules/vite-plus/bin/vp'), ...(command === 'build' ? ['build', '--configLoader', 'runner'] : ['test', 'run', '--project', 'unit', ...extra.filter(arg => arg !== '--native-read')])];
const env = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '/tmp', PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', CI: '1', T3CODE_SINGLE_ORIGIN_DEV: '1', VITE_AAA_PREVIEW: nativeRead ? '0' : '1', VITE_AAA_NATIVE_READ: nativeRead ? '1' : '0', T3CODE_WEB_SOURCEMAP: '0' };
console.log(JSON.stringify({ command, source: receipt.upstream_commit, isolated_output: output, node: process.versions.node, vp: realpathSync(join(output, 'apps/web/node_modules/vite-plus')), private_env_inherited: false }));
const child = spawn(process.execPath, args, { cwd: join(output, 'apps/web'), env, stdio: 'inherit' });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
