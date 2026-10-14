import { isPrivateDirectorySync, isPrivateFileSync, restrictPrivatePathSync } from '../../../desktop-pet/dist/core/platform-files.js';
import { constants, chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { engineInventory, sha256 } from './runtime.mjs';

function regular(file, privateFile = false) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== file ||
      process.platform !== 'win32' && stat.uid !== process.getuid() || privateFile && !isPrivateFileSync(file)) throw Error('Unsafe explicit Codex input');
}

/** Explicit selected local inputs only. Refuses overwrite; never traverses the whole daily home. */
export function bindCodexInputs(home, { skills = [], authFile, rolloutFiles = [], sourceCodexHome } = {}) {
  const target = join(resolve(home), '.codex');
  if (realpathSync(target) !== target || !isPrivateDirectorySync(target)) throw Error('Unsafe project Codex home');
  const plan = [], names = new Set();
  for (const source of skills) {
    const root = resolve(source), name = basename(root);
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || names.has(name) || realpathSync(root) !== root) throw Error('Ambiguous selected Skill');
    regular(join(root, 'SKILL.md')); names.add(name);
    // Inventory checks all relative links; external Skill dependencies must be selected separately.
    const files = engineInventory(root);
    plan.push({ kind: 'skill', source: root, destination: join(target, 'skills', name), files });
  }
  if (authFile) { const source = resolve(authFile); regular(source, true);
    plan.push({ kind: 'account', source, destination: join(target, 'auth.json') }); }
  for (const file of rolloutFiles) {
    if (!sourceCodexHome) throw Error('Exact source Codex home required for a selected original session');
    const source = resolve(file), root = join(resolve(sourceCodexHome), 'sessions'), part = relative(root, source).replaceAll('\\', '/');
    if (part.startsWith('..') || !/^\d{4}\/\d{2}\/\d{2}\/rollout-[a-zA-Z0-9-]+\.jsonl$/.test(part)) throw Error('Original session outside exact source home');
    regular(source);
    plan.push({ kind: 'original-session', source, destination: join(target, 'sessions', part) });
  }
  const destinations = new Set();
  const receiptFile = join(target, 'selected-inputs.json');
  let previous = { version: 1, inputs: [] };
  if (existsSync(receiptFile)) { regular(receiptFile, true); previous = JSON.parse(readFileSync(receiptFile, 'utf8'));
    if (previous.version !== 1 || !Array.isArray(previous.inputs)) throw Error('Selected input receipt changed'); }
  for (const item of plan) {
    if (destinations.has(item.destination) || existsSync(item.destination)) throw Error('Project Codex input already exists; reconcile without overwriting');
    destinations.add(item.destination);
    for (let p = dirname(item.destination); p !== target; p = dirname(p)) {
      if (existsSync(p) && (lstatSync(p).isSymbolicLink() || realpathSync(p) !== p)) throw Error('Selected input destination link refused');
    }
  }
  const receipt = [];
  for (const item of plan) {
    mkdirSync(dirname(item.destination), { recursive: true, mode: 0o700 });
    if (item.kind === 'skill') cpSync(item.source, item.destination, { recursive: true, verbatimSymlinks: true, force: false, errorOnExist: true });
    else { copyFileSync(item.source, item.destination, constants.COPYFILE_EXCL); restrictPrivatePathSync(item.destination); }
    receipt.push({ kind: item.kind, source: item.source, destination: item.destination,
      ...(item.files ? { inventorySha256: sha256(JSON.stringify(item.files)) } : {}) });
  }
  restrictPrivatePathSync(target);
  // Paths and Skill fingerprints only. Account contents never enter evidence or a public source lock.
  writeFileSync(join(target, 'selected-inputs.json'), JSON.stringify({ version: 1, inputs: [...previous.inputs, ...receipt] }, null, 2) + '\n', { mode: 0o600 });
  return { selectedSkills: skills.length, accountCopied: !!authFile, selectedOriginalSessions: rolloutFiles.length, modelRequests: 0 };
}
