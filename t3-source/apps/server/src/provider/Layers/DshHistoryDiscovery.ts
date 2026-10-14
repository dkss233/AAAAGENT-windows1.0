// @effect-diagnostics globalDate:off -- Pure conversion of original native event timestamps.
// @effect-diagnostics nodeBuiltinImport:off -- Original native-file identity is part of this imperative provider transport.
import { readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import type { DshSessionRpc } from "./DshHostProtocol.ts";

export interface DshHistorySource {
  readonly sessionId: string; readonly cwd: string; readonly title: string;
  readonly preset: string; readonly model: string | null; readonly createdAt: string; readonly updatedAt: string;
  readonly filePath: string; readonly mtimeMs: number;
}
const object = (v: unknown): Record<string, any> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : null;
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const iso = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? new Date(value).toISOString() : null;

/** One initial/user-requested metadata reconciliation. Detailed history stays in the original Session. */
export async function discoverDshHistory(rpc: DshSessionRpc, home: string): Promise<readonly DshHistorySource[]> {
  if (!isAbsolute(home) || realpathSync(home) !== resolve(home)) throw Error("Original DSH data home unavailable");
  const listed = object(await rpc.call("session/list", { _request: {} }));
  if (!Array.isArray(listed?.items)) throw Error("Original DSH metadata unavailable");
  const candidates: Record<string, any>[] = [];
  for (const row of listed.items) {
    if (!id(row?.sessionId) || typeof row.cwd !== "string" || !isAbsolute(row.cwd) || row.parentSessionId || row.origin === "subagent") continue;
    // The real Host omits projections for some cold v3 metadata rows. The exact-SID
    // readonly endpoint observes their original history without promoting an Agent.
    const projections = object(row.projections)?.values ? row.projections :
      object(await rpc.call("session/projections", { request: { sessionId: row.sessionId } }));
    const preset = projections?.values?.agentPreset;
    if (typeof preset !== "string" || !preset.trim() || preset.length > 256 || /[\0\r\n]/.test(preset)) continue;
    candidates.push({ ...row, projections });
  }
  const selected = new Set(candidates.map(row => row.sessionId)), files = new Map<string, string[]>();
  const directory = join(home, "sessions");
  for (const folder of readdirSync(directory, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
    for (const session of readdirSync(join(directory, folder.name), { withFileTypes: true })) {
      if (!session.isDirectory() || session.isSymbolicLink() || !selected.has(session.name)) continue;
      const root = join(directory, folder.name, session.name);
      for (const name of ["session.v4.jsonl.zstd", "session.v3.jsonl.zstd"]) {
        const file = join(root, name); let stat;
        try { stat = lstatSync(file); } catch { continue; }
        if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file) !== file) continue;
        const paths = files.get(session.name) ?? []; paths.push(file); files.set(session.name, paths); break;
      }
    }
  }
  const result: DshHistorySource[] = [], seen = new Set<string>();
  for (const row of candidates) {
    if (seen.has(row.sessionId)) throw Error("Original DSH session identity is duplicated"); seen.add(row.sessionId);
    const paths = files.get(row.sessionId); if (paths?.length !== 1 || !iso(row.updatedAt)) continue;
    const first = object(await rpc.call("session/page", { request: { address: { kind: "session", sessionId: row.sessionId }, throughSeq: 0, maxMessages: 1 } }));
    const event = Array.isArray(first?.records) && first.records.length === 1 ? object(first.records[0]?.event) : null;
    const createdAt = event?.seq === 0 ? iso(event.time) : null; if (!createdAt) continue;
    const selection = object(row.projections.values.modelSelection?.next ?? row.projections.values.modelSelection?.lastUsed);
    const model = typeof selection?.provider === "string" && typeof selection.model === "string" ? `${encodeURIComponent(selection.provider)}/${encodeURIComponent(selection.model)}` : null;
    const filePath = paths[0]!, stat = lstatSync(filePath);
    result.push({ sessionId: row.sessionId, cwd: row.cwd, preset: row.projections.values.agentPreset,
      title: typeof row.projections.values.title === "string" && row.projections.values.title.trim() ? row.projections.values.title : row.sessionId,
      model, createdAt, updatedAt: iso(row.updatedAt)!, filePath, mtimeMs: stat.mtimeMs });
  }
  return result;
}
