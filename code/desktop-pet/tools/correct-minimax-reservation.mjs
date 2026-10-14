import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const oldEntry = Object.freeze({ operationId: 'W0-I:B-DANIA-MINIMAX-AUDITION-01:clone-demo',
  model: 'MiniMax/speech-2.8-hd', reservedMicros: 10_000_000, actualMicros: null, status: 'unknown' });
export const boundedEntry = Object.freeze({ ...oldEntry, reservedMicros: 19_600 });
const proofBase = 'artifacts/worktrees/W0-I-dania-minimax-audition-01/artifacts/W0-I/dania-minimax-audition-01/execution/';
const proofs = [
  { file: proofBase + 'plan.json', sha256: 'fcfd30b9b7a607b4083234051a6ef025b9cd2394dedb8a8a3b06698e07256145' },
  { file: proofBase + 'execution.json', sha256: 'b194c5743fa4230768b3b3dca33b97ad110c435fe61ce418622e92cfc47acb6a' },
];
const budgetPath = 'artifacts/W0-I/model-evaluation/budget.json';
const outputPath = 'artifacts/W0-I/minimax-default-01/budget-bound';
const json = value => JSON.stringify(value, null, 2) + '\n';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Correct only the estimate for one proven clone-demo; this does not settle its unknown bill. */
export function correctedLedger(bytes, expectedSha256) {
  if (sha(bytes) !== expectedSha256) throw Error('Ledger changed after review');
  const state = JSON.parse(bytes);
  if (state.batchId !== 'D09-S1-20260906-01' || state.currency !== 'CNY' || state.limitMicros !== 20_000_000
    || state.blocked !== false || !Array.isArray(state.entries)) throw Error('Unexpected original budget');
  const matching = state.entries.filter(entry => entry.operationId === oldEntry.operationId);
  if (matching.length !== 1 || !same(matching[0], oldEntry)) throw Error('Expected exact original unknown entry');
  return { ...state, entries: state.entries.map(entry => entry.operationId === oldEntry.operationId ? { ...boundedEntry } : entry) };
}

async function checkProofs(root) {
  const docs = [];
  for (const proof of proofs) {
    const bytes = await readFile(resolve(root, proof.file));
    if (sha(bytes) !== proof.sha256) throw Error('Original evidence changed');
    docs.push(JSON.parse(bytes));
  }
  const [plan, result] = docs;
  if (plan.request?.input?.action !== 'voice_clone' || plan.request.model !== oldEntry.model
    || [...plan.request.input.text].length !== 28 || plan.demoCharacterMicros !== 350 || plan.cloneCostMicros !== 0
    || plan.subsequentSynthesisCalls !== 0 || plan.maxCloneCalls !== 1 || plan.retries !== 0
    || result.posts !== 1 || result.stage !== 'clone-demo' || result.httpStatus !== 400
    || result.actualMicros !== null || !same(result.entries, [oldEntry])) throw Error('Original request scope is not the reviewed clone-demo');
}

export async function prepare(root) {
  await checkProofs(root);
  const bytes = await readFile(resolve(root, budgetPath));
  const ledgerSha256 = sha(bytes), next = correctedLedger(bytes, ledgerSha256);
  if (next.entries.length !== 178) throw Error('Unexpected ledger entry count');
  const plan = { version: 1, kind: 'unknown_reservation_upper_bound_correction', root,
    createdAt: new Date().toISOString(), budgetFile: resolve(root, budgetPath), ledgerSha256,
    originalEntry: oldEntry, correctedEntry: boundedEntry, proofs,
    calculation: { unicodeCodepoints: 28, conservativeMultiplier: 2, hdMicrosPerCharacter: 350, upperBoundMicros: 19_600,
      untriggeredFirstFormalSynthesisUnlockMicros: 9_900_000 },
    basis: [ 'https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide',
      'https://help.aliyun.com/zh/model-studio/minimax-synchronous-speech-synthesis-api' ],
    meaning: 'Only the reservation estimate changes. Actual charge remains unknown; no free-call or settled-bill claim.',
    calls: 0, devices: 0, otherEntries: 'byte-equivalent JSON values retained', sharedLimitMicros: 20_000_000 };
  const directory = resolve(root, outputPath); await mkdir(directory, { recursive: true });
  const filename = resolve(directory, 'plan.json'); await writeFile(filename, json(plan), { flag: 'wx', mode: 0o600 });
  return { filename, planSha256: sha(json(plan)) };
}

export async function applyCorrection(file, directory, expectedSha256, details = {}, validate = async () => {}) {
  await mkdir(directory, { recursive: true });
  const lock = await open(file + '.lock', 'wx', 0o600);
  let ownTemporary = false;
  try {
    await validate();
    const before = await readFile(file), next = correctedLedger(before, expectedSha256), after = json(next);
    await writeFile(resolve(directory, 'ledger-before.json'), before, { flag: 'wx', mode: 0o600 });
    await writeFile(resolve(directory, 'prepared.json'), json({ ...details, beforeSha256: sha(before), afterSha256: sha(after) }), { flag: 'wx', mode: 0o600 });
    const temporary = await open(file + '.next', 'wx', 0o600); ownTemporary = true;
    try { await temporary.writeFile(after); await temporary.sync(); } finally { await temporary.close(); }
    await rename(file + '.next', file); ownTemporary = false;
    await writeFile(resolve(directory, 'ledger-after.json'), after, { flag: 'wx', mode: 0o600 });
    const receipt = { ...details, status: 'applied', at: new Date().toISOString(),
      beforeSha256: sha(before), afterSha256: sha(after), originalEntry: oldEntry, correctedEntry: boundedEntry,
      knownMicros: next.entries.reduce((sum, entry) => sum + (entry.actualMicros ?? 0), 0),
      availableMicros: next.limitMicros - next.entries.reduce((sum, entry) => sum + (entry.actualMicros ?? entry.reservedMicros), 0),
      unchangedOtherEntries: next.entries.length - 1, actualChargeStillUnknown: true, calls: 0, devices: 0 };
    await writeFile(resolve(directory, 'audit.json'), json(receipt), { flag: 'wx', mode: 0o600 });
    return receipt;
  } finally {
    if (ownTemporary) await unlink(file + '.next');
    await lock.close(); await unlink(file + '.lock');
  }
}

async function execute(root, expectedPlanSha256) {
  const directory = resolve(root, outputPath), bytes = await readFile(resolve(directory, 'plan.json'));
  if (sha(bytes) !== expectedPlanSha256) throw Error('Frozen correction plan changed');
  const plan = JSON.parse(bytes);
  if (plan.root !== root || !same(plan.correctedEntry, boundedEntry) || !same(plan.proofs, proofs)) throw Error('Unexpected correction plan');
  return applyCorrection(resolve(root, budgetPath), directory, plan.ledgerSha256,
    { kind: plan.kind, planSha256: expectedPlanSha256, proofs, basis: plan.basis, calculation: plan.calculation }, () => checkProofs(root));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, root, fingerprint] = process.argv.slice(2);
  if (!root || root !== resolve(root)) throw Error('Explicit absolute project root required');
  const result = mode === '--check' ? await prepare(root) : mode === '--execute' ? await execute(root, fingerprint) : (() => { throw Error('Use --check or --execute'); })();
  process.stdout.write(json(result));
}
