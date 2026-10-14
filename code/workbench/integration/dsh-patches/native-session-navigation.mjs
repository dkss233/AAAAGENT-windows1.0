import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveDshEntryFragment } from '../engine-pins/dsh-native-entry.mjs';

export const navigationSource = JSON.parse(readFileSync(new URL('./native-session-navigation-source.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Pinned native navigation seam changed');
  return source.replace(before, after);
}

/** A deterministic native client patch, no installed runtime or dependency graph writes. */
export function patchDshNativeNavigation(original) {
  if (digest(original) !== navigationSource.sourceSha256) throw Error('Pinned native workspace source changed');
  let text = original.toString('utf8');
  text = replaceOnce(text, '\t\tvar UiWorkspaceService = class',
    `\t\tconst aaaagentEntryTarget = ${resolveDshEntryFragment.toString()};\n\t\tvar UiWorkspaceService = class`);
  text = replaceOnce(text, '\t\t\tasync restoreSelection(workspaces, sessions) {\n',
    '\t\t\tasync restoreSelection(workspaces, sessions) {\n' +
    '\t\t\t\tconst entryHash = globalThis.location?.hash ?? "";\n' +
    '\t\t\t\tconst entry = aaaagentEntryTarget(entryHash, workspaces, sessions);\n' +
    '\t\t\t\tif (entry.kind !== "none") {\n' +
    '\t\t\t\t\tif (entry.kind === "session") {\n' +
    '\t\t\t\t\t\tlet reference;\n' +
    '\t\t\t\t\t\ttry {\n' +
    '\t\t\t\t\t\t\tthis.openSession(entry.sessionId);\n' +
    '\t\t\t\t\t\t\treference = this.mainReference;\n' +
    '\t\t\t\t\t\t\tconst opened = await reference.ready;\n' +
    '\t\t\t\t\t\t\tif (this.lifetime.signal.aborted || this.mainReference !== reference || globalThis.location?.hash !== entryHash) return;\n' +
    '\t\t\t\t\t\t\tconst snapshot = opened.session.getSnapshot();\n' +
    '\t\t\t\t\t\t\tif (opened.sessionId !== entry.sessionId || snapshot.sessionId !== entry.sessionId || snapshot.openState !== "open" || snapshot.openError || snapshot.removed || snapshot.subagent) throw new Error("Native entry not open");\n' +
    '\t\t\t\t\t\t}\n' +
    '\t\t\t\t\t\tcatch { if (!this.lifetime.signal.aborted && (reference === void 0 || this.mainReference === reference) && globalThis.location?.hash === entryHash) this.notify({ kind: "aaaagentEntryFailed" }); }\n' +
    '\t\t\t\t\t} else this.notify({ kind: "aaaagentEntryFailed" });\n' +
    '\t\t\t\t\treturn;\n\t\t\t\t}\n');
  text = replaceOnce(text, '\t\t\t\t\tif (this.mainReference !== void 0) {',
    '\t\t\t\t\tif (this.mainReference !== void 0 && aaaagentEntryTarget(globalThis.location?.hash ?? "", workspace, sessions).kind === "none") {');
  const subscription = '\t\t\t\tconst disposeWorkspaces = this.workspaces.list.subscribe(reconcile);';
  text = replaceOnce(text, subscription,
    '\t\t\t\tlet entryHash = globalThis.location?.hash ?? "";\n' +
    '\t\t\t\tconst entryChanged = () => {\n' +
    '\t\t\t\t\tconst hash = globalThis.location?.hash ?? "";\n' +
    '\t\t\t\t\tif (hash === entryHash) return; entryHash = hash;\n' +
    '\t\t\t\t\tif (aaaagentEntryTarget(hash, this.workspaces.list.getSnapshot(), this.sessions.list.getSnapshot()).kind === "none") return;\n' +
    '\t\t\t\t\tinitial = "waiting"; reconcile();\n\t\t\t\t};\n' +
    '\t\t\t\tglobalThis.addEventListener?.("hashchange", entryChanged);\n' + subscription);
  text = replaceOnce(text, '\t\t\t\t\tdisposeSessions();\n\t\t\t\t\tdisposeWorkspaces();',
    '\t\t\t\t\tdisposeSessions();\n\t\t\t\t\tdisposeWorkspaces();\n' +
    '\t\t\t\t\tglobalThis.removeEventListener?.("hashchange", entryChanged);');
  text = replaceOnce(text, '\t\t\t\tcase "pinFailed": return t("toast.pinFailed");',
    '\t\t\t\tcase "aaaagentEntryFailed": return t("toast.nativeEntryFailed");\n\t\t\t\tcase "pinFailed": return t("toast.pinFailed");');
  text = replaceOnce(text, '\t\t\t"toast.createFailed": "新建会话失败：{message}",',
    '\t\t\t"toast.nativeEntryFailed": "无法打开指定会话，请重新从原任务进入。",\n\t\t\t"toast.createFailed": "新建会话失败：{message}",');
  text = replaceOnce(text, '\t\t\t"toast.createFailed": "New session failed: {message}",',
    '\t\t\t"toast.nativeEntryFailed": "Unable to open the selected session. Reopen it from the original task.",\n\t\t\t"toast.createFailed": "New session failed: {message}",');
  const patched = Buffer.from(text);
  if (digest(patched) !== navigationSource.patchedSha256) throw Error('Pinned native navigation candidate changed: ' + digest(patched));
  return patched;
}

export function prepareDshNativeNavigation(sourceFile, candidateFile) {
  const stat = lstatSync(sourceFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Regular pinned native workspace source required');
  const original = readFileSync(sourceFile), patched = patchDshNativeNavigation(original);
  const sessionClient = resolve(dirname(sourceFile), '../../dsh-api-session-controller/lib/client.js');
  const sessionStat = lstatSync(sessionClient);
  if (!sessionStat.isFile() || sessionStat.isSymbolicLink() || digest(readFileSync(sessionClient)) !== navigationSource.sessionClientSha256)
    throw Error('Pinned native session controller changed');
  writeFileSync(candidateFile, patched, { flag: 'wx', mode: 0o600 });
  return { capabilityVersion: 1, sourceSha256: digest(original), sessionClientSha256: navigationSource.sessionClientSha256,
    patchedSha256: digest(patched), originalModified: false,
    currentRuntimeInstalled: false, models: 0, GUI: 0 };
}
