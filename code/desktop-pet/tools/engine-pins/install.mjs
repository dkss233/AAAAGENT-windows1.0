import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareEngines } from '../../../workbench/integration/engine-pins/prepare.mjs';
import { installEngineProfile } from '../../../workbench/integration/engine-pins/profile.mjs';
import { installRelayPreset, installWorkPreset } from '../../dist/harness/preset.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const [action, t3Home, ...extra] = process.argv.slice(2);
if (action !== '--new-isolated-home' || !t3Home || extra.length) throw Error('Usage: install.mjs --new-isolated-home T3_HOME');
const runtime = await prepareEngines(root);
const profile = installEngineProfile(root, runtime.root, resolve(t3Home));
const location = { dshHome: resolve(profile.home, '.dsh'), projectRoot: root, nodeExecutable: runtime.nodeExecutable,
  managementDescriptor: resolve(root, '.local/model-evaluation/trial/user-trial/management-session.json') };
await installRelayPreset(location); await installWorkPreset(location);
console.log(JSON.stringify({ status: 'isolated-profile-installed', runtimeRoot: runtime.root, t3Home: resolve(t3Home),
  codex: '0.160.0', dsh: '0.2.0-rc.2', userDataMigrated: false, modelRequests: 0 }, null, 2));
