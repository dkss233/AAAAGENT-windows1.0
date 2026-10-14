import { isAbsolute } from 'node:path';
import { resolveDshHistoryBinding } from './dsh-native-history.mjs';

function requireBinding(binding, capability) {
  if (capability !== 1 || !binding || Object.keys(binding).sort().join(',') !== 'cwd,preset,sessionId' ||
      typeof binding.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(binding.sessionId) || typeof binding.cwd !== 'string' ||
      !isAbsolute(binding.cwd) || binding.cwd.length > 4096 || /[\0\r\n]/.test(binding.cwd) ||
      typeof binding.preset !== 'string' || !binding.preset.trim() || binding.preset.length > 256 || /[\0\r\n]/.test(binding.preset)) throw Error('Exact native session entry unavailable');
}

/** Only existing bound metadata; never create, resume, fork, prompt or change a model. */
export function validateDshEntryBinding(binding, listed, capability) {
  requireBinding(binding, capability);
  const matches = Array.isArray(listed?.items) ? listed.items.filter(row => row?.sessionId === binding.sessionId) : [];
  if (matches.length !== 1) throw Error('Exact native session entry unavailable');
  const row = matches[0];
  if (row.cwd !== binding.cwd || row.projections?.values?.agentPreset !== binding.preset ||
      row.parentSessionId != null || row.origin === 'subagent' || typeof row.running !== 'boolean' ||
      !Number.isSafeInteger(row.projections?.asOfSeq) || row.projections.asOfSeq < 0)
    throw Error('Exact native session entry unavailable');
  return { ...binding };
}

/** A clean local URL relies on the original browser cookie, never a credential in the returned URL. */
export function dshSessionEntryUrl(origin, binding, capability) {
  requireBinding(binding, capability);
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || url.origin !== origin)
    throw Error('Exact native session entry unavailable');
  url.hash = new URLSearchParams({ 'aaaagent-session': '1', sid: binding.sessionId, cwd: binding.cwd }).toString();
  return url.href;
}

/** The caller supplies the same trusted DB/environment used by the native history reader. */
export async function originalDshSessionEntry({ database, environmentId, rpc, origin, capability }, query) {
  if (capability !== 1) throw Error('Exact native session entry unavailable');
  const binding = resolveDshHistoryBinding(database, environmentId, query);
  // Validate the authority before performing even the metadata read.
  const url = dshSessionEntryUrl(origin, binding, capability);
  validateDshEntryBinding(binding, await rpc.call('session/list', { _request: {} }), capability);
  const current = resolveDshHistoryBinding(database, environmentId, query);
  if (current.sessionId !== binding.sessionId || current.cwd !== binding.cwd || current.preset !== binding.preset)
    throw Error('Exact native session entry unavailable');
  return url;
}

/** Self-contained: this exact function is inserted into the pinned native client bundle. */
export function resolveDshEntryFragment(hash, workspaces, sessions) {
  const params = new URLSearchParams(typeof hash === 'string' ? hash.slice(1) : '');
  if (!params.has('aaaagent-session') && !(typeof hash === 'string' && hash.startsWith('#aaaagent-session')))
    return { kind: 'none' };
  const rejected = { kind: 'rejected' };
  if (hash !== '#' + params.toString() || params.getAll('aaaagent-session').length !== 1 ||
      params.get('aaaagent-session') !== '1' || params.getAll('sid').length !== 1 || params.getAll('cwd').length !== 1 ||
      [...params.keys()].some(key => !['aaaagent-session', 'sid', 'cwd'].includes(key))) return rejected;
  const sessionId = params.get('sid'), cwd = params.get('cwd');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId ?? '') || !(typeof cwd === 'string' && /^(?:[A-Za-z]:[\\/]|\/)/.test(cwd)) || cwd.length > 4096 || /[\0\r\n]/.test(cwd) ||
      !Array.isArray(sessions?.ids) || sessions.ids.filter(id => id === sessionId).length !== 1 ||
      !sessions.byId || !Object.hasOwn(sessions.byId, sessionId) || !Array.isArray(workspaces?.archivedSessionIds)) return rejected;
  const summary = sessions.byId[sessionId];
  if (summary?.id !== sessionId || summary.cwd !== cwd || summary.parentId != null || summary.parentSessionId != null || summary.origin === 'subagent' ||
      workspaces.archivedSessionIds.includes(sessionId)) return rejected;
  return { kind: 'session', sessionId, cwd };
}
