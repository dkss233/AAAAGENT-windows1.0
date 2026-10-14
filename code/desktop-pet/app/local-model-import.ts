/**
 * Install a user-supplied Live2D rig into the desktop app.
 *
 * Distribution flow: a shipped copy of the app has no model of its own, so the first-run setup
 * asks the user for a folder. Everything the renderer and the management server need is derived
 * here:
 *   - the rig is copied into BOTH asset directories the two consumers read
 *     (`local-model` for the renderer, `jellyfish` for the presentation catalog);
 *   - `presets.json` is generated and bound to the rig with a fingerprint;
 *   - the fingerprint is recomputed the same way `readPresentationCatalog` verifies it.
 *
 * Nothing is downloaded, decrypted or altered: the operator is responsible for holding the
 * rights to whatever rig they point this at.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const CATALOG_SCHEMA_VERSION = 1;
const ENTRY_FILE = 'pet.model3.json';
const MODEL_DIRS = ['desktop/assets/local-model', 'desktop/assets/jellyfish'];
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

interface ModelReference { File?: string; Name?: string }
interface ModelEntry {
  FileReferences?: {
    Moc?: string; Physics?: string; DisplayInfo?: string;
    Textures?: string[]; Expressions?: ModelReference[]; Motions?: Record<string, ModelReference[]>;
  };
  Groups?: { Target?: string; Name?: string; Ids?: string[] }[];
}
interface CatalogItem {
  id: string; label: string; category: 'expression' | 'pose' | 'appearance' | 'idle';
  source: 'model-expression' | 'model-motion' | 'procedural';
  availability: 'automatic' | 'manual' | 'unavailable';
  defaultEnabled: boolean; previewable: boolean;
  /** The rig's own expression name. Required for the renderer to apply it and for the console's
   *  emotion editor to offer it, so it is written for every model expression. */
  expressionName?: string;
  /** Parameters this expression drives. The console shows them so an operator can see exactly what
   *  a "隐藏" choice neutralises (for example the author watermark's parameter). */
  parameters?: readonly string[];
  emotions?: readonly string[]; gestures?: readonly string[];
}
interface Catalog { schemaVersion: number; modelId: string; modelFingerprint: string; items: CatalogItem[] }

export class ModelImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelImportError';
  }
}

const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/** Reject absolute, traversing or otherwise unsafe model-relative references. */
function assertSafeReference(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path || path.startsWith('/') || isAbsolute(path)
    || /[:%\\]/.test(path) || path.split('/').some((part: string) => !part || part === '.' || part === '..'))
    throw new ModelImportError(`模型引用了不安全的路径：${String(path)}`);
}

async function listFiles(root: string, current: string = root, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = resolve(current, entry.name);
    if (entry.isSymbolicLink()) throw new ModelImportError('模型目录中不允许符号链接。');
    if (entry.isDirectory()) await listFiles(root, full, out);
    else if (entry.isFile()) out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

/** Find the rig's entry document, tolerating any single *.model3.json name. */
async function findEntryFile(source: string): Promise<{ file: string; rename: boolean }> {
  const names = await readdir(source);
  if (names.includes(ENTRY_FILE)) return { file: ENTRY_FILE, rename: false };
  const candidates = names.filter((name: string) => name.endsWith('.model3.json'));
  if (candidates.length === 1) return { file: candidates[0]!, rename: true };
  if (!candidates.length) throw new ModelImportError(`这个文件夹里没有 *.model3.json：${source}`);
  throw new ModelImportError(`这个文件夹里有多个模型文件，请只保留一个：${candidates.join(', ')}`);
}

function requiredReferences(entry: ModelEntry): NonNullable<ModelEntry['FileReferences']> {
  const refs = entry.FileReferences;
  const missing: string[] = [];
  if (!refs?.Moc) missing.push('FileReferences.Moc');
  if (!refs?.Physics) missing.push('FileReferences.Physics');
  if (!refs?.DisplayInfo) missing.push('FileReferences.DisplayInfo');
  if (!Array.isArray(refs?.Textures) || !refs.Textures.length) missing.push('FileReferences.Textures[]');
  if (!Array.isArray(refs?.Expressions) || !refs.Expressions.length) missing.push('FileReferences.Expressions[]');
  if (missing.length) {
    throw new ModelImportError(
      `模型缺少必需字段：${missing.join('、')}。当前版本只支持带物理和表情的 Cubism 3/4 模型。`);
  }
  // The guards above prove every required member is present.
  return refs!;
}

/**
 * Fingerprint exactly as the runtime verifies it: sorted "path\0hash" lines over the entry
 * document, Moc, Physics, expressions and motions, then SHA-256 of that listing.
 */
async function fingerprintRig(directory: string, entryFile: string, refs: NonNullable<ModelEntry['FileReferences']>): Promise<string> {
  const motions: ModelReference[] = refs.Motions ? Object.values(refs.Motions).flat() : [];
  const files = [...new Set<string>([
    entryFile,
    refs.Moc!,
    refs.Physics!,
    ...refs.Expressions!.map((item: ModelReference) => item?.File),
    ...motions.map((item: ModelReference) => item?.File),
  ].filter((value): value is string => typeof value === 'string'))].sort();
  let binding = '';
  for (const file of files) {
    assertSafeReference(file);
    const actual = resolve(directory, file);
    if (relative(directory, actual).startsWith('..')) throw new ModelImportError(`模型引用越出目录：${file}`);
    let content: Buffer;
    try { content = await readFile(actual); }
    catch { throw new ModelImportError(`模型缺少被引用的文件：${file}`); }
    binding += `${file}\0${sha256(content)}\n`;
  }
  return sha256(Buffer.from(binding, 'utf8'));
}

const slug = (value: unknown): string =>
  String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

function buildCatalog(modelId: string, modelFingerprint: string, entry: ModelEntry, parameters: Map<string, string[]>): Catalog {
  const refs = requiredReferences(entry);
  const items: CatalogItem[] = [];
  const used = new Set<string>();
  const hasBlink = (entry.Groups ?? []).some((group) =>
    group?.Target === 'Parameter' && group?.Name === 'EyeBlink' && Array.isArray(group.Ids) && group.Ids.length > 0);
  // Automatic idle behaviours come first; both are optional for a given rig.
  if (hasBlink) {
    items.push({ id: 'proc-blink', label: '自动眨眼', category: 'idle', source: 'procedural', availability: 'automatic', defaultEnabled: true, previewable: true });
  }
  refs.Expressions!.forEach((expression: ModelReference, index: number) => {
    const base = slug(expression?.Name) || `expression-${index + 1}`;
    let id = `expr-${base}`;
    let suffix = 2;
    while (used.has(id)) id = `expr-${base}-${suffix++}`;
    if (!ID_PATTERN.test(id)) id = `expr-${index + 1}`;
    while (used.has(id)) id = `expr-${index + 1}-${suffix++}`;
    used.add(id);
    const label = String(expression?.Name ?? '').trim() || `表情 ${index + 1}`;
    items.push({
      id,
      label,
      category: 'expression',
      source: 'model-expression',
      availability: 'manual',
      defaultEnabled: false,
      previewable: true,
      // The renderer looks expressions up by this name, and the emotion editor requires it, so it
      // must be recorded here rather than reconstructed from the label later.
      expressionName: label,
      // Recorded so the console can show what a "隐藏" choice neutralises.
      parameters: parameters.get(label) ?? [],
    });
  });
  if (!items.length) throw new ModelImportError('模型没有可用表情，无法生成目录清单。');
  return { schemaVersion: CATALOG_SCHEMA_VERSION, modelId, modelFingerprint, items };
}

export interface ModelImportResult {
  modelFingerprint: string;
  modelId: string;
  expressions: number;
  automatic: string[];
  files: number;
}

/**
 * Install the rig at `sourceDirectory` into both asset directories under `projectRoot`,
 * replacing whatever was there, and bind a fresh catalog to it.
 */
export async function importLive2dModel(
  projectRoot: string, sourceDirectory: string, options: { modelId?: string } = {},
): Promise<ModelImportResult> {
  const root = resolve(projectRoot);
  const source = resolve(sourceDirectory);
  const info = await stat(source).catch(() => null);
  if (!info?.isDirectory()) throw new ModelImportError(`不是一个文件夹：${source}`);
  for (const dir of MODEL_DIRS) {
    if (resolve(root, dir) === source) throw new ModelImportError('请选择包外的模型文件夹，不要直接选择程序内的素材目录。');
  }

  const { file: entryFile, rename } = await findEntryFile(source);
  const entry = JSON.parse(await readFile(resolve(source, entryFile), 'utf8')) as ModelEntry;
  const refs = requiredReferences(entry);
  const files = await listFiles(source);
  for (const ref of [refs.Moc, refs.Physics, ...refs.Textures!, ...refs.Expressions!.map((item) => item?.File)]) {
    if (ref !== undefined) assertSafeReference(ref);
  }

  // Replace each destination wholesale so no file from a previous rig survives.
  for (const dir of MODEL_DIRS) await rm(resolve(root, dir), { recursive: true, force: true });
  // Copy into the primary location, then mirror it: the two consumers must stay byte-identical.
  const primary = resolve(root, MODEL_DIRS[0]!);
  await mkdir(primary, { recursive: true });
  await cp(source, primary, { recursive: true, dereference: false, force: true });
  if (rename) {
    await rm(resolve(primary, entryFile), { force: true });
    await writeFile(resolve(primary, ENTRY_FILE), `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  }
  for (const dir of MODEL_DIRS.slice(1)) {
    await rm(resolve(root, dir), { recursive: true, force: true });
    await cp(primary, resolve(root, dir), { recursive: true, dereference: false, force: true });
  }

  const modelFingerprint = await fingerprintRig(primary, ENTRY_FILE, refs);
  // Read what each expression drives straight from the installed rig, so the console can name the
  // parameters a "隐藏" choice will neutralise.
  const expressionParameters = new Map<string, string[]>();
  for (const expression of refs.Expressions!) {
    const name = String(expression?.Name ?? '').trim();
    if (!name || typeof expression?.File !== 'string') continue;
    try {
      const body = JSON.parse(await readFile(resolve(primary, expression.File), 'utf8')) as { Parameters?: { Id?: string }[] };
      expressionParameters.set(name, (body.Parameters ?? []).map((item) => item?.Id).filter((id): id is string => typeof id === 'string'));
    } catch { expressionParameters.set(name, []); }
  }
  const catalog = buildCatalog(options.modelId ?? 'local-model', modelFingerprint, entry, expressionParameters);
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  for (const dir of MODEL_DIRS) await writeFile(resolve(root, dir, 'presets.json'), serialized, { mode: 0o600 });

  return {
    modelFingerprint,
    modelId: catalog.modelId,
    expressions: catalog.items.filter((item) => item.category === 'expression').length,
    automatic: catalog.items.filter((item) => item.availability === 'automatic').map((item) => item.id),
    files: files.length,
  };
}

export interface ModelInspection {
  ok: boolean; reason?: string; entryFile?: string; willRename?: boolean;
  files?: number; expressions?: string[]; hasMotions?: boolean; hasBlink?: boolean;
}

/** Report what a folder contains without changing anything; used to validate a pick. */
export async function inspectLive2dModel(sourceDirectory: string): Promise<ModelInspection> {
  const source = resolve(sourceDirectory);
  const info = await stat(source).catch(() => null);
  if (!info?.isDirectory()) return { ok: false, reason: `不是一个文件夹：${source}` };
  try {
    const { file, rename } = await findEntryFile(source);
    const entry = JSON.parse(await readFile(resolve(source, file), 'utf8')) as ModelEntry;
    const refs = requiredReferences(entry);
    const files = await listFiles(source);
    return {
      ok: true,
      entryFile: file,
      willRename: rename,
      files: files.length,
      expressions: refs.Expressions!.map((item) => String(item?.Name ?? '')).filter(Boolean),
      hasMotions: !!refs.Motions,
      hasBlink: (entry.Groups ?? []).some((group) => group?.Name === 'EyeBlink' && Array.isArray(group.Ids) && group.Ids.length > 0),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
