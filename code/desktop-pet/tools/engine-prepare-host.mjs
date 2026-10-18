// Prepare the pinned DSH engine runtime on the console's request.
//
// This is the same assembly the deploy-time tools/engine-pins/install.mjs performs. The difference is
// who asks: an operator on the command line versus the console, through a background task that cannot
// block the management server. Downloads stay pinned and hash-checked by assembleEngines, and an
// existing runtime is reused instead of rebuilt, so a second click is harmless.
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareEngines } from '../../workbench/integration/engine-pins/prepare.mjs';
import { installEngineProfile, readEngineProfile } from '../../workbench/integration/engine-pins/profile.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const say = (line) => console.log(line);
const ready = () => { try { return !!readEngineProfile(root); } catch { return false; } };

if (ready()) {
  say('ENGINE_PRESENT 引擎运行时已就绪，未做任何改动。');
  process.exit(0);
}

const t3Home = resolve(root, '.local/data/t3-home');
for (const name of ['.aaaagent-t3-host.json', '.aaaagent-t3-host.lock', '.aaaagent-t3-owner.json']) {
  if (existsSync(resolve(t3Home, name))) {
    say('ENGINE_FAILED 有一个正在运行的 T3 工作台占用了引擎目录，请先退出它再重试。');
    process.exit(1);
  }
}

say('ENGINE_START 开始准备 DSH 引擎运行时（下载与校验约 1 GB，可能持续数分钟）。');
try {
  const runtime = await prepareEngines(root);
  say('ENGINE_ASSEMBLED ' + runtime.status + '，文件数 ' + (runtime.fileCount ?? '未知') + '。');
  // Derived binding files are regenerated from the profile, so a stale one must not block a repair.
  const bindings = resolve(root, 'artifacts/runtime/engine-bindings');
  if (existsSync(bindings)) rmSync(bindings, { recursive: true, force: true });
  installEngineProfile(root, runtime.root, t3Home, { preserveSettings: existsSync(resolve(t3Home, 'userdata/settings.json')) });
  if (!ready()) throw Error('引擎配置写入后仍无法读取');
  say('ENGINE_PREPARED 引擎运行时已就绪，重启桌宠后生效。');
} catch (error) {
  say('ENGINE_FAILED ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
