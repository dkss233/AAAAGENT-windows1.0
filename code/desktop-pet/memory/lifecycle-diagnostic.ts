import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

/** Lifecycle facts must be recorded without any opt-in switch.
 *
 *  A spawned backend does not inherit operator-set trace flags, so gated diagnostics produced empty
 *  logs three times in a row and the investigation concluded from silence. This writer always emits:
 *  one line on stderr, one line in a file next to the active trial configuration (the same directory
 *  as events.jsonl). When no trial configuration is set - unit tests - it writes to the OS temp
 *  directory so a test run never litters the repository. A diagnostic failure must never change a
 *  memory decision, so every write is best effort. */
export function lifecycleDiagnostic(line: string): void {
  const record = new Date().toISOString() + ' ' + line;
  try { process.stderr.write('[lifecycle] ' + record + '\n'); } catch {}
  try {
    const config = process.env.PET_TRIAL_CONFIG;
    appendFileSync(resolve(config ? dirname(config) : tmpdir(), 'memory-lifecycle.log'), record + '\n');
  } catch {}
}
