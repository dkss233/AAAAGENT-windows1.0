import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url));
export const engineLock = JSON.parse(readFileSync(join(here, 'engine-lock.json'), 'utf8'));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const engineDirectory = `artifacts/runtime/engines-codex-${engineLock.codex.version}-dsh-${engineLock.dsh.version}-${engineLock.target}`;
const within = (root, path) => { const p = relative(root, path); return !isAbsolute(p) && p !== '..' && !p.startsWith('..' + sep); };

/** Relative npm/Node links are allowed only when their real target remains inside this install. */
export function engineInventory(root) {
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw Error('Canonical engine root required');
  const files = {};
  const visit = (directory, prefix = '') => {
    for (const name of readdirSync(directory).sort()) {
      if (!prefix && name === '.aaaagent-engine.json') continue;
      const path = join(directory, name), key = prefix + name, st = lstatSync(path);
      if (st.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target) || !within(root, realpathSync(path))) throw Error('Engine link escapes install');
        files[key] = { link: target };
      } else if (st.isDirectory()) visit(path, key + '/');
      else if (st.isFile()) files[key] = { sha256: sha256(readFileSync(path)), executable: !!(st.mode & 0o111) };
      else throw Error('Unsupported engine file');
    }
  };
  visit(root); return files;
}

export function verifyEngineRuntime(directory) {
  const root = resolve(directory), markerPath = join(root, '.aaaagent-engine.json');
  if (realpathSync(root) !== root || lstatSync(markerPath).isSymbolicLink()) throw Error('Engine root/marker changed');
  const source = JSON.parse(readFileSync(join(here, 'runtime-source.json'), 'utf8'));
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (source.lockSha256 !== sha256(readFileSync(join(here, 'engine-lock.json'))) ||
      source.packageLockSha256 !== sha256(readFileSync(join(here, 'package-lock.json'))) ||
      JSON.stringify(marker.engines) !== JSON.stringify(engineLock)) throw Error('Engine source lock changed');
  const files = engineInventory(root);
  if (sha256(JSON.stringify(files)) !== source.inventorySha256 || JSON.stringify(files) !== JSON.stringify(marker.files))
    throw Error('Engine runtime changed');
  const dsh = JSON.parse(readFileSync(join(root, 'dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
  if (dsh.version !== engineLock.dsh.version) throw Error('DSH release changed');
  return { root, nodeExecutable: join(root, process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node'), codexExecutable: join(root, 'codex/bin/codex' + (process.platform === 'win32' ? '.exe' : '')),
    dshEntrypoint: join(root, 'dsh', engineLock.dsh.entrypoint), inventorySha256: source.inventorySha256,
    fileCount: Object.keys(files).length };
}

/** Use with an explicitly owned home. Never inherit daily App/DSH home or a global runtime path. */
export function engineEnvironment(runtime, home) {
  if (!isAbsolute(home)) throw Error('An explicit engine home is required');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const platformEnv = process.platform === 'win32' ? { USERPROFILE: home, SystemRoot: systemRoot,
    COMSPEC: join(systemRoot, 'System32/cmd.exe'), TEMP: process.env.TEMP, TMP: process.env.TMP,
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local') } : {};
  return { ...platformEnv, HOME: home, CODEX_HOME: join(home, '.codex'), DSH_HOME: join(home, '.dsh'),
    PATH: [dirname(runtime.nodeExecutable), ...(process.platform === 'win32'
      ? [join(systemRoot, 'System32'), systemRoot, join(systemRoot, 'System32/WindowsPowerShell/v1.0'), process.env.PATH || process.env.Path || ''] : ['/usr/bin', '/bin'])].join(delimiter), NODE_PATH: '', NODE_OPTIONS: '',
    AAAAGENT_ENGINE_RUNTIME: runtime.root };
}
