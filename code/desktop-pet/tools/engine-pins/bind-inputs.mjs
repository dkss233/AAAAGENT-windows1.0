import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { readEngineProfile } from '../../../workbench/integration/engine-pins/profile.mjs';
import { bindCodexInputs } from '../../../workbench/integration/engine-pins/codex-inputs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const [manifestFile, ...extra] = process.argv.slice(2);
if (!manifestFile || extra.length) throw Error('Usage: bind-inputs.mjs EXPLICIT_PRIVATE_INPUT_MANIFEST');
const profile = readEngineProfile(root);
if (!profile) throw Error('Install the project engine profile first');
console.log(JSON.stringify(bindCodexInputs(profile.home, JSON.parse(readFileSync(resolve(manifestFile), 'utf8')))));
