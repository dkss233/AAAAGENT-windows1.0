import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, openSync, fstatSync, closeSync, type Stats } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';

/** relative() can return a drive-qualified path when Windows volumes differ. */
export function isOutside(parent: string, target: string): boolean {
  const part = relative(resolve(parent), resolve(target));
  return part === '..' || part.startsWith('..' + sep) || isAbsolute(part);
}

// Pass paths as environment data, never PowerShell source or shell interpolation.
// One invocation answers MANY paths. Starting powershell.exe costs most of a second on this machine,
// and a management snapshot asks about every registered credential, so one process per file pushed
// the response past the console's fetch deadline. The script reports one exit code per path and the
// caller decides what a code means; file-versus-directory is the caller's lstat, not a script flag.
const aclScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = $PSHOME + '\\Modules'
$targets = @($env:AAAAGENT_ACL_PATHS -split "\`n" | Where-Object { $_ -ne '' })
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
# Codes: 0 admitted, 2 owner mismatch, 3 broad access, 4 the path itself could not be read.
$codes = New-Object System.Collections.Generic.List[int]
foreach ($p in $targets) {
  $code = 0
  try {
    $acl = Get-Acl -LiteralPath $p
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    # Elevated tokens can create files owned by their Administrators token owner.
    # Admit that exact case, not arbitrary group owners or unelevated membership.
    $adminOwner = $owner -eq 'S-1-5-32-544' -and $owner -eq $identity.Owner.Value -and $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($owner -ne $sid.Value -and -not $adminOwner) { $code = 2 }
    else {
      if ($env:AAAAGENT_ACL_ACTION -eq 'restrict') {
        $item = Get-Item -LiteralPath $p -Force
        $fresh = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
        $fresh.SetAccessRuleProtection($true, $false)
        $inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
        foreach ($id in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
          $fresh.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($id), 'FullControl', $inherit, 'None', 'Allow'))
        }
        if ($item.PSIsContainer) { [IO.Directory]::SetAccessControl($p, $fresh) } else { [IO.File]::SetAccessControl($p, $fresh) }
        $acl = Get-Acl -LiteralPath $p
      }
      foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { $code = 3; break }
      }
    }
  } catch { $code = 4 }
  $codes.Add($code)
}
[Console]::Out.Write(($codes -join ','))
exit 0
`;
const aclScriptBase64 = Buffer.from(aclScript, 'utf16le').toString('base64');
const aclStatuses = (stdout: string): number[] =>
  stdout.trim() === '' ? [] : stdout.trim().split(',').map(part => (part === '' ? 4 : Number(part)));

/** ACL verdicts by path, keyed with the file identity they were measured against.
 *  A DACL does not change with a file's contents, so the same owned file answers the same way on
 *  every request. Without this the snapshot paid a fresh powershell start per file on every call. */
const aclCache = new Map<string, { key: string; admitted: boolean }>();
function aclIdentity(filename: string): string | null {
  try {
    const info = lstatSync(filename);
    // ctime belongs in the key: re-permissioning a file rewrites its metadata and Windows updates the
    // change time, while mtime and size stay put. Without it an external `icacls /grant` left a stale
    // "admitted" verdict behind — the platform ACL test caught exactly that, so this is load-bearing,
    // not belt-and-braces.
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  } catch { return null; }
}
function cachedAcl(filename: string): boolean | undefined {
  const key = aclIdentity(filename);
  if (key === null) return undefined;
  const hit = aclCache.get(resolve(filename));
  return hit !== undefined && hit.key === key ? hit.admitted : undefined;
}
function rememberAcl(filename: string, admitted: boolean): void {
  const key = aclIdentity(filename);
  // The verdict must be stored either way. Storing only "admitted" left the previous true in place
  // after a re-measure said false, so a broad read grant kept reporting as private — the platform ACL
  // test caught it. Safety comes from the identity in the key (see aclIdentity), not from skipping
  // the negative result.
  if (key !== null) aclCache.set(resolve(filename), { key, admitted });
}
/** A restrict rewrites the DACL, so any verdict remembered for that path is stale. */
function forgetAcl(filename: string): void { aclCache.delete(resolve(filename)); }

/** One powershell start for the given paths, in order. Only paths whose DACL verdict is not already
 *  known are sent. Throws a fixed-category error, never subprocess output. */
function aclVerdicts(filenames: readonly string[]): boolean[] {
  const resolved = filenames.map(name => resolve(name));
  const answered = resolved.map(name => cachedAcl(name));
  const unknown = resolved.filter((_, index) => answered[index] === undefined);
  if (unknown.length > 0) {
    const systemRoot = process.env.SystemRoot || 'C:\\Windows';
    let stdout: string;
    try {
      stdout = execFileSync(win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', aclScriptBase64],
        { windowsHide: true, timeout: 10000, stdio: 'pipe', encoding: 'utf8',
          env: { ...process.env, AAAAGENT_ACL_PATHS: unknown.map(name => win32.toNamespacedPath(name)).join('\n'), AAAAGENT_ACL_ACTION: 'check' } });
    } catch (error) {
      // Expose only fixed failure categories, never subprocess output, paths or file contents.
      const failure = error as { status?: number; code?: string };
      throw Error(`Windows could not verify or restrict this owned file (${failure.code === 'ETIMEDOUT' ? 'timeout' : 'powershell_failure'}). Check its owner and access permissions.`);
    }
    const codes = aclStatuses(stdout);
    if (codes.length !== unknown.length) throw Error('Windows could not verify or restrict this owned file (powershell_failure). Check its owner and access permissions.');
    unknown.forEach((name, index) => rememberAcl(name, codes[index] === 0));
  }
  return resolved.map(name => cachedAcl(name) === true);
}
function windowsAcl(filename: string, action: 'check' | 'restrict'): void {
  if (action === 'check') {
    if (aclVerdicts([filename])[0]) return;
    throw Error('Windows could not verify or restrict this owned file (broad_access). Check its owner and access permissions.');
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  try {
    execFileSync(win32.join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', aclScriptBase64],
      { windowsHide: true, timeout: 10000, stdio: 'pipe', env: { ...process.env, AAAAGENT_ACL_PATHS: win32.toNamespacedPath(resolve(filename)), AAAAGENT_ACL_ACTION: 'restrict' } });
  }
  catch (error) {
    // Expose only fixed failure categories, never subprocess output, paths or file contents.
    const failure = error as { status?: number; code?: string };
    const reason = failure.status === 2 ? 'owner_mismatch'
      : failure.status === 3 ? 'broad_access'
      : failure.code === 'ETIMEDOUT' ? 'timeout' : 'powershell_failure';
    throw Error(`Windows could not verify or restrict this owned file (${reason}). Check its owner and access permissions.`);
  }
  // The DACL just changed: any verdict remembered for this path is now stale.
  forgetAcl(filename);
}

/** Metadata only. No credential contents are read. Windows checks SID-based DACLs. */
export function isPrivateFileSync(filename: string, opened?: Stats): boolean {
  try {
    const info = lstatSync(filename);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    if (opened) {
      // Some Windows Node/libuv versions report dev=0 for path-based stat,
      // but a volume serial for fstat. Compare two handles on that platform;
      // never drop the device check or read credential contents.
      let identity = info;
      if (process.platform === 'win32' && info.dev !== opened.dev) {
        const fd = openSync(filename, 'r');
        try { identity = fstatSync(fd); } finally { closeSync(fd); }
      }
      if (identity.dev !== opened.dev || identity.ino !== opened.ino) return false;
    }
    if (process.platform === 'win32') { if (!aclVerdicts([filename])[0]) return false; }
    else if ((info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) return false;
    return true;
  } catch { return false; }
}
/** Existing private storage directories must also retain their owner-only DACL. */
export function isPrivateDirectorySync(filename: string): boolean {
  try {
    const info = lstatSync(filename);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (process.platform === 'win32') { if (!aclVerdicts([filename])[0]) return false; }
    else if ((info.mode & 0o077) !== 0 || process.getuid && info.uid !== process.getuid()) return false;
    return true;
  } catch { return false; }
}
/** Same predicate as isPrivateFileSync, for many files, in one powershell start. */
export function arePrivateFilesSync(filenames: readonly string[], maxPerCall = 12): boolean[] {
  if (process.platform === 'win32' && filenames.length > 1 && filenames.length <= maxPerCall) {
    const pass = aclVerdicts(filenames);
    return filenames.map((name, index) => {
      try { const info = lstatSync(name); return pass[index] === true && info.isFile() && !info.isSymbolicLink(); }
      catch { return false; }
    });
  }
  return filenames.map(name => isPrivateFileSync(name));
}
/** One powershell start for a directory plus its files: a store that must vouch for its own directory
 *  and every key file it names would otherwise pay one process per path. */
export function arePrivateFilesAndDirectory(directory: string, filenames: readonly string[]): [boolean, ...boolean[]] {
  if (process.platform === 'win32' && filenames.length + 1 <= 12) {
    const paths = [directory, ...filenames];
    const pass = aclVerdicts(paths);
    const kinds = paths.map(name => { try { return lstatSync(name); } catch { return null; } });
    const dirInfo = kinds[0] ?? null;
    const dirOk = pass[0] === true && dirInfo !== null && dirInfo.isDirectory() && !dirInfo.isSymbolicLink();
    return [dirOk, ...filenames.map((_, index) => {
      const info = kinds[index + 1] ?? null;
      return pass[index + 1] === true && info !== null && info.isFile() && !info.isSymbolicLink();
    })] as [boolean, ...boolean[]];
  }
  return [isPrivateDirectorySync(directory), ...filenames.map(name => isPrivateFileSync(name))];
}
/** One powershell start for a mix of directories and files whose kind is read from disk.
 *  `arePrivateFilesAndDirectory` needs the caller to know which is which; this one looks, which is what
 *  lets a caller warm the verdict cache for a set of paths it did not classify — the launcher does that
 *  for the engine profile so readEngineProfile's own checks are answered from the cache instead of one
 *  powershell process each. */
export function arePrivatePathsSync(paths: readonly string[]): boolean[] {
  if (process.platform !== 'win32' || paths.length > 12) {
    return paths.map(name => {
      try { return lstatSync(name).isDirectory() ? isPrivateDirectorySync(name) : isPrivateFileSync(name); }
      catch { return false; }
    });
  }
  const pass = aclVerdicts(paths);
  return paths.map((name, index) => {
    try {
      const info = lstatSync(name);
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) return false;
      return pass[index] === true;
    } catch { return false; }
  });
}
/** Use only for files/directories created by this application or explicitly selected by the user. */
export function restrictPrivatePathSync(filename: string): void {
  const info = lstatSync(filename);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw Error('Expected an ordinary owned path');
  if (process.platform === 'win32') windowsAcl(filename, 'restrict');
  else chmodSync(filename, info.isDirectory() ? 0o700 : 0o600);
}

