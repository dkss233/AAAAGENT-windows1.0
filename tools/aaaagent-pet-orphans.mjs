// Recover from a pet that was killed instead of exited.
//
// "退出桌宠" shuts down the backend gracefully, but a force-kill (Task Manager, a crash, or a killed
// console) leaves the backend and its `cmd.exe /c npm start` wrapper alive with no window. Those
// orphans then hold the state a fresh launch needs and the next start fails with no visible reason.
//
// The test is deliberately narrow: only when NO pet Electron process is running is a surviving
// launcher/backend proven orphaned. If Electron is up, a stray helper is left alone rather than
// risking the operator's live session. Plain JavaScript: this file is imported by a .mjs launcher,
// so Node does not strip type annotations here.
import { execFileSync } from 'node:child_process';

const QUERY =
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='cmd.exe' or Name='electron.exe'\" | " +
  "ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.CommandLine)\" }";

/** Read process rows. Never throws: an unreadable table means "nothing found". */
function processTable() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', QUERY],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    return out.split(/\r?\n/).map((line) => {
      const [pid, parent, name, ...rest] = line.split('\t');
      return { pid: Number(pid), parent: Number(parent), name: String(name ?? '').toLowerCase(), command: rest.join('\t') };
    }).filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0);
  } catch { return []; }
}

const petElectron = (rows) =>
  rows.filter((row) => row.name === 'electron.exe' && /desktop-pet/i.test(row.command));

const npmStartShell = (rows) =>
  rows.filter((row) => row.name === 'cmd.exe' && /npm(\.cmd)?\s+start/i.test(row.command));

/**
 * Terminate a leftover launcher: the trial launcher/backend under it first (so npm cannot respawn
 * them), then the npm wrapper itself.
 */
function killLeftover(shell, rows) {
  let killed = 0;
  for (const row of rows) {
    if (row.pid === shell.pid) continue;
    if (!/trial-launcher|trial-backend/i.test(row.command)) continue;
    try { process.kill(row.pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
  }
  try { process.kill(shell.pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
  return killed;
}

/** Kill orphaned pet launchers. Returns what happened so the launcher can report it. */
export function clearOrphanedPetProcesses() {
  const rows = processTable();
  if (rows.length === 0) return { cleaned: 0, shells: 0, skipped: false };
  if (petElectron(rows).length > 0) return { cleaned: 0, shells: 0, skipped: true };
  const shells = npmStartShell(rows);
  let cleaned = 0;
  for (const shell of shells) cleaned += killLeftover(shell, rows);
  return { cleaned, shells: shells.length, skipped: false };
}
