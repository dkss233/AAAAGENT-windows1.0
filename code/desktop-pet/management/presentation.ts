import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ManagementError } from '../contracts/management.js';
import type { PresentationCatalog, PresentationPolicy, PresentationControls } from '../contracts/presentation-presets.js';
import { PRESENTATION_EMOTIONS, PRESENTATION_GESTURES } from '../contracts/presentation.js';
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const fail = (message: string): never => { throw new ManagementError('invalid_request', message); };
export function validatePresentationCatalog(value: unknown): PresentationCatalog {
  const c = value as PresentationCatalog;
  if (!c || c.schemaVersion !== 1 || !idPattern.test(c.modelId) || !/^[a-f0-9]{64}$/.test(c.modelFingerprint)
    || !Array.isArray(c.items) || !c.items.length || c.items.length > 200) fail('模型预设目录无效。');
  const ids = new Set<string>();
  for (const p of c.items) {
    if (!p || typeof p.id !== 'string' || !idPattern.test(p.id) || ids.has(p.id)
      || typeof p.label !== 'string' || !p.label.trim() || p.label.length > 100
      || !['expression','pose','appearance','idle'].includes(p.category)
      || !['model-expression','model-motion','procedural'].includes(p.source)
      || !['automatic','manual','unavailable'].includes(p.availability)
      || typeof p.defaultEnabled !== 'boolean' || typeof p.previewable !== 'boolean'
      || (p.defaultEnabled && p.availability !== 'automatic')
      || (p.availability === 'automatic' && (p.category === 'appearance' || !p.previewable))
      || (p.emotions && (!Array.isArray(p.emotions) || p.emotions.some(x => !PRESENTATION_EMOTIONS.includes(x as never))))
      || (p.gestures && (!Array.isArray(p.gestures) || p.gestures.some(x => !PRESENTATION_GESTURES.includes(x as never))))) fail('模型预设条目无效。');
    ids.add(p.id);
  }
  return structuredClone(c);
}
export async function readPresentationCatalog(projectRoot: string): Promise<PresentationCatalog> {
  const base = resolve(projectRoot, 'code/desktop-pet/desktop/assets/jellyfish');
  const manifest = await readFile(resolve(base, 'pet.model3.json'));
  const catalog = validatePresentationCatalog(JSON.parse(await readFile(resolve(base, 'presets.json'), 'utf8')));
  const refs = JSON.parse(manifest.toString('utf8')).FileReferences;
  // Motions are optional: expression-only rigs ship no motion files.
  const motionPaths: string[] = refs.Motions ? Object.values(refs.Motions as Record<string, { File: string }[]>).flat().map(x => x.File) : [];
  const paths = [...new Set(['pet.model3.json', refs.Moc, refs.Physics, ...refs.Expressions.map((x: { File: string }) => x.File), ...motionPaths].filter(Boolean))] as string[];
  const pieces: string[] = [];
  for (const path of paths.sort()) {
    if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid model reference');
    pieces.push(path + '\0' + createHash('sha256').update(await readFile(resolve(base, path))).digest('hex') + '\n');
  }
  if (createHash('sha256').update(pieces.join('')).digest('hex') !== catalog.modelFingerprint) throw new ManagementError('unavailable', '模型已变化，预设目录需要重新核对。');
  return catalog;
}
/** Does a stored policy reference catalog entries this model no longer has? */
function refersToUnknownItem(policy: PresentationPolicy, catalog: PresentationCatalog): boolean {
  const known = new Set(catalog.items.map((item) => item.id));
  const referenced = [
    ...(Array.isArray(policy.enabledIds) ? policy.enabledIds : []),
    ...(Array.isArray(policy.hiddenIds) ? policy.hiddenIds : []),
    ...Object.keys(policy.hiddenValues ?? {}),
    ...Object.values(policy.emotions ?? {}),
  ];
  return referenced.some((id) => typeof id !== 'string' || !known.has(id));
}
type Stored = { schemaVersion: 1; models: Record<string, PresentationPolicy> };
/** An emotion assignment is valid only for an emotion the renderer knows and a preset that has a
 *  real expression name, so nothing can point at a procedural row. */
function validEmotions(value: unknown, catalog: PresentationCatalog): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('情绪映射无效。');
  const assignable = new Set(catalog.items.filter(p => p.expressionName && p.category === 'expression').map(p => p.id));
  const result: Record<string, string> = {};
  for (const [emotion, rawId] of Object.entries(value as Record<string, unknown>)) {
    if (!PRESENTATION_EMOTIONS.includes(emotion as never)) return fail('情绪名称无效。');
    if (emotion === 'neutral') return fail('neutral 不需要指定表情。');
    if (typeof rawId !== 'string' || !assignable.has(rawId)) return fail('只能把表情挂到本模型的表情条目上。');
    result[emotion] = rawId;
  }
  return result;
}
/**
 * Read the stored settings. A malformed file is an error, but a policy that simply refers to
 * catalog entries this model no longer has is NOT: replacing the model rebuilds the catalog while
 * the stored policy keeps its model id, so stale ids are expected. Those policies are dropped
 * instead of raising, because raising here would abort backend startup and leave the operator with
 * no console at all ("暂时无法打开控制台").
 */
function parse(raw: string, catalog: PresentationCatalog): { state: Stored; dropped: string[] } {
  const state = JSON.parse(raw) as Stored;
  if (!state || state.schemaVersion !== 1 || !state.models || typeof state.models !== 'object' || Array.isArray(state.models)) fail('已保存的表现设置无效。');
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(state.models)) {
    const wellFormed = idPattern.test(key) && value.modelId === key && Number.isSafeInteger(value.revision) && value.revision >= 0
      && Array.isArray(value.enabledIds) && value.enabledIds.every(x => typeof x === 'string' && idPattern.test(x))
      && new Set(value.enabledIds).size === value.enabledIds.length;
    if (!wellFormed) fail('已保存的表现设置无效。');
    // Entries for another model cannot be checked against this catalog; keep them verbatim.
    // Older files predate the emotion map, so a missing key is treated as "no assignments".
    if (key === catalog.modelId) {
      try { validEmotions(value.emotions, catalog); } catch { dropped.push(key); }
    }
  }
  return { state, dropped };
}
/** Dedicated user settings, never a chat or memory record. One backend owns writes. */
export class PresentationSettingsStore implements PresentationControls {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(readonly file: string, readonly catalog: PresentationCatalog, private state: Stored,
    private readonly changed: (policy: PresentationPolicy) => void) {}
  static async open(file: string, catalog: PresentationCatalog, changed: (policy: PresentationPolicy) => void = () => {}) {
    const validated = validatePresentationCatalog(catalog);
    let state: Stored;
    let invalid: string[] = [];
    try {
      const read = parse(await readFile(file, 'utf8'), validated);
      state = read.state;
      invalid = read.dropped;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      state = { schemaVersion: 1, models: {} };
    }
    // Replacing the model rebuilds the catalog, and the stored policy is keyed by a model id that
    // does not change with it. Any id the current catalog no longer offers would both fail to parse
    // and make every later save fail validation ("只能隐藏本模型的预设条目"), so drop such a policy.
    const stored = state.models[validated.modelId];
    if (invalid.includes(validated.modelId) || (stored && refersToUnknownItem(stored, validated))) {
      const { [validated.modelId]: _discarded, ...models } = state.models;
      state = { schemaVersion: 1, models };
    }
    const store = new PresentationSettingsStore(resolve(file), validated, state, changed);
    store.validEnabled(store.snapshot().enabledIds); return store;
  }
  snapshot(): PresentationPolicy {
    const stored = this.state.models[this.catalog.modelId];
    return structuredClone(stored ?? { modelId: this.catalog.modelId, revision: 0, emotions: {}, hiddenIds: [], hiddenValues: {},
      enabledIds: this.catalog.items.filter(p => p.availability === 'automatic' && p.defaultEnabled).map(p => p.id) });
  }
  /** Any catalog preset can be hidden; hiding only mutes it, it never rewrites the catalog. */
  private validHidden(value: unknown): string[] {
    if (value === undefined) return [];
    const known = new Set(this.catalog.items.map(p => p.id));
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !known.has(id)) || new Set(value).size !== value.length)
      fail('只能隐藏本模型的预设条目。');
    return [...(value as string[])].sort();
  }
  private validEnabled(value: unknown): string[] {
    // Eligible for the enabled set: an automatic preset, or an expression the operator can assign
    // an emotion to. The renderer applies the same rule.
    const allowed = new Set(this.catalog.items.filter(p => p.availability === 'automatic' || !!p.expressionName).map(p => p.id));
    if (!Array.isArray(value) || value.length > allowed.size || value.some(id => typeof id !== 'string' || !allowed.has(id)) || new Set(value).size !== value.length) fail('只能更改当前模型已接入的自动表现。');
    return [...(value as string[])].sort();
  }
  /** Hiding forces a preset's parameters to this value. 0 suits most rigs, but a rig may invert the
   *  control, so the operator can set it per preset. */
  private validHiddenValues(value: unknown, hidden: readonly string[]): Record<string, number> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('隐藏值无效。');
    const known = new Set(hidden);
    const result: Record<string, number> = {};
    for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < -1000 || raw > 1000) fail('隐藏值必须是 -1000 到 1000 之间的数字。');
      if (!known.has(id)) fail('只能为已隐藏的条目设置隐藏值。');
      result[id] = raw as number;
    }
    return result;
  }
  save(modelId: string, expectedRevision: number, enabledIds: unknown, emotions?: unknown, hiddenIds?: unknown, hiddenValues?: unknown): Promise<PresentationPolicy> {
    const run = this.queue.then(async () => {
      const current = this.snapshot();
      if (modelId !== this.catalog.modelId) fail('模型已变化，请刷新后再保存。');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) throw new ManagementError('version_conflict', '表现设置已更新，请刷新后重试。');
      const enabled = this.validEnabled(enabledIds);
      // Omitting an argument leaves that part untouched, so an older save call keeps working.
      const nextEmotions = emotions === undefined ? { ...current.emotions } : validEmotions(emotions, this.catalog);
      // A hidden preset must not stay enabled, so hiding also drops it from the enabled set.
      const hidden = hiddenIds === undefined ? [...current.hiddenIds] : this.validHidden(hiddenIds);
      const hiddenSet = new Set(hidden);
      const nextHiddenValues = this.validHiddenValues(hiddenValues === undefined ? current.hiddenValues : hiddenValues, hidden);
      // Assigning an emotion is what makes an expression eligible, so keep it in enabledIds too.
      const withAssigned = [...new Set([...enabled, ...Object.values(nextEmotions)])].filter(id => !hiddenSet.has(id));
      const policy = { modelId, revision: current.revision + 1, enabledIds: this.validEnabled(withAssigned),
        emotions: nextEmotions, hiddenIds: hidden, hiddenValues: nextHiddenValues };
      const next: Stored = { schemaVersion: 1, models: { ...this.state.models, [modelId]: policy } };
      await mkdir(dirname(this.file), { recursive: true }); const temporary = this.file + '.' + randomUUID() + '.next';
      try { await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, this.file); }
      finally { await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
      this.state = next; this.changed(this.snapshot()); return this.snapshot();
    });
    this.queue = run.catch(() => {}); return run;
  }
  allowedIntent() {
    const policy = this.snapshot();
    const hidden = new Set(policy.hiddenIds);
    const enabled = new Set(policy.enabledIds);
    const items = this.catalog.items.filter(p => p.availability === 'automatic' && enabled.has(p.id) && !hidden.has(p.id));
    // Runtime assignments win over the catalog's shipped ones, and an assignment makes its preset
    // eligible even when the operator never ticked the automatic box.
    for (const id of Object.values(policy.emotions)) {
      if (hidden.has(id)) continue;
      const item = this.catalog.items.find(p => p.id === id);
      if (item && !items.includes(item)) items.push(item);
    }
    const assigned = Object.keys(policy.emotions).filter(emotion => !hidden.has(policy.emotions[emotion]!));
    return { emotions: [...new Set(['neutral', ...assigned, ...items.flatMap(p => p.emotions ?? [])])],
      gestures: [...new Set(items.flatMap(p => p.gestures ?? []))],
      presets: items.filter(p => p.category === "expression" || p.category === "pose").map(p => ({ id: p.id, label: p.label })) };
  }
  async drain() { await this.queue; }
}
