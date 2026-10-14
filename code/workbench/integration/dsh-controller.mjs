import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat, realpath, rename, rm } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const controllerSource = JSON.parse(await readFile(resolve(directory, 'dsh-controller-source.json'), 'utf8'));

async function inventory(root) {
  const files = {};
  async function visit(path) {
    for (const name of (await readdir(path)).sort()) {
      const child = resolve(path, name), stat = await lstat(child);
      if (stat.isSymbolicLink()) throw Error('DSH controller symlink refused');
      if (stat.isDirectory()) await visit(child);
      else if (stat.isFile()) files[relative(root, child).split(sep).join('/')] = digest(await readFile(child));
      else throw Error('DSH controller non-regular file refused');
    }
  }
  await visit(root);
  return files;
}

function sameFiles(actual, expected) {
  return Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([name, hash]) => actual[name] === hash);
}

/** Read-only preflight for the native controller and the runtime used by the scoped trial guard. */
export async function verifyDshRuntime(sourceRoot, patched = false) {
  const source = await realpath(sourceRoot);
  if (source !== sourceRoot) throw Error('Canonical native controller required');
  const expected = { ...controllerSource.files, ...(patched ? controllerSource.patchedFiles : {}) };
  if (!sameFiles(await inventory(source), expected)) throw Error('Native DSH controller source changed');
  for (const [name, originalHash] of Object.entries(controllerSource.nativeRuntimeFiles)) {
    const path = resolve(dirname(source), name);
    if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw Error('Native DSH runtime path changed');
    const local = name.startsWith('dsh-api-session-controller/') ? name.slice('dsh-api-session-controller/'.length) : '';
    const expectedHash = patched && controllerSource.patchedFiles[local] || originalHash;
    if (digest(await readFile(path)) !== expectedHash) throw Error('Native DSH runtime fingerprint changed');
  }
  return { controllerFiles: Object.keys(expected).length, nativeRuntimeFiles: Object.keys(controllerSource.nativeRuntimeFiles).length, patched };
}

/** Exact native source only; this creates a candidate, never edits or starts the user's Host. */
export async function prepareDshController(sourceRoot, outputRoot) {
  const source = await realpath(sourceRoot), output = resolve(outputRoot);
  if (source !== sourceRoot || source === output || output.startsWith(source + sep)) {
    throw Error('Separate canonical native source and candidate required');
  }
  if (!sameFiles(await inventory(source), controllerSource.files)) throw Error('Native DSH controller source changed');
  await verifyDshRuntime(source);
  const metadata = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
  if (metadata.name !== controllerSource.package || metadata.version !== controllerSource.version) {
    throw Error('Native DSH controller version changed');
  }
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  if (await realpath(dirname(output)) !== dirname(output)) throw Error('Candidate parent cannot be a symlink');
  const stage = output + '.stage-' + randomUUID();
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const [name, hash] of Object.entries(controllerSource.files)) {
      let bytes = await readFile(resolve(source, name));
      if (digest(bytes) !== hash) throw Error('Native DSH source changed while preparing');
      const edits = controllerSource.edits.filter(edit => edit.file === name);
      if (edits.length) {
        let text = bytes.toString('utf8');
        for (const edit of edits) {
          if (text.split(edit.before).length !== 2) throw Error('Native DSH patch context changed');
          text = text.replace(edit.before, edit.after);
        }
        bytes = Buffer.from(text);
        if (digest(bytes) !== controllerSource.patchedFiles[name]) throw Error('Native DSH patch fingerprint mismatch');
      }
      const target = resolve(stage, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    }
    const expected = { ...controllerSource.files, ...controllerSource.patchedFiles };
    if (!sameFiles(await inventory(stage), expected)) throw Error('Prepared DSH files differ');
    // Fail if an earlier candidate exists; never replace an unreviewed directory.
    try { await lstat(output); throw Error('DSH candidate already exists'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(stage, output);
    return { package: controllerSource.package, version: controllerSource.version,
      extension: controllerSource.extension, files: expected, changedFiles: controllerSource.patchedFiles,
      originalHostModified: false, startedHost: false, modelCalls: 0 };
  } finally { await rm(stage, { recursive: true, force: true }); }
}
