import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, delimiter, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function verifyNativeReadAssetPaths(html) {
  const modules = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]);
  const styles = [...html.matchAll(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)]
    .filter(match => /\brel=["'](?:stylesheet|modulepreload)["']/i.test(match[0])).map(match => match[1]);
  if (!modules.length || [...modules, ...styles].some(path => !path.startsWith('/native/') || /[?#\\]/.test(path)))
    throw Error('Expected the native-read renderer and all entry assets under /native/');
}

export function buildNativeReadRenderer(source, nodeExecutable = process.execPath) {
  source = resolve(source);
  const assemblyPath = join(source, process.platform === 'win32' ? '.aaaagent-prepared.json' : '.aaa-native-ui.json');
  const assembly = JSON.parse(readFileSync(assemblyPath, 'utf8'));
  if (process.platform === 'win32') {
    const lock = JSON.parse(readFileSync(new URL('../t3-source.json', import.meta.url), 'utf8'));
    if (assembly.commit !== lock.commit || assembly.licenseSha256 !== lock.licenseSha256) throw Error('Expected prepared Windows public source');
  } else if (assembly.output !== source || assembly.env_auth_state_copied !== false) throw Error('Expected registered public UI assembly');
  const web = join(source, 'apps/web');
  const vp = join(web, 'node_modules/vite-plus/bin/vp');
  if (!existsSync(vp)) throw Error('Expected the existing cached build dependency');
  execFileSync(nodeExecutable, [vp, 'build'], { cwd: web, stdio: 'inherit', env: {
    ...process.env, PATH: dirname(nodeExecutable) + delimiter + process.env.PATH,
    VITE_AAA_NATIVE_READ: '1',
  } });
  const html = readFileSync(join(web, 'dist/index.html'), 'utf8');
  verifyNativeReadAssetPaths(html);
  const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const receipt = { version: 1, mode: 'native-read', base: '/native/',
    assemblySha256: sha(assemblyPath),
    nativeReadBoundarySha256: sha(join(web, 'src/aaaagent/NativeReadBoundary.tsx')),
    indexSha256: sha(join(web, 'dist/index.html')), buildEnvironment: { VITE_AAA_NATIVE_READ: '1' } };
  writeFileSync(join(web, 'dist/aaa-native-read-build.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(buildNativeReadRenderer(process.argv[2], process.argv[3])));
}
