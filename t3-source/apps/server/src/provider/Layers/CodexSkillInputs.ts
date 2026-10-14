import type { CodexSkillReference } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";

type Inventory = {
  readonly data: ReadonlyArray<{
    readonly cwd: string;
    readonly errors: ReadonlyArray<unknown>;
    readonly skills: ReadonlyArray<{ readonly name: string; readonly path: string; readonly enabled: boolean }>;
  }>;
};

/** Resolves exact current-turn references against the active app-server's own cwd. */
export function resolveCodexSkillInputs(
  inventory: Inventory,
  cwd: string,
  refs: ReadonlyArray<CodexSkillReference>,
): Array<{ type: "skill"; name: string; path: string }> {
  const entries = inventory.data.filter((entry) => entry.cwd === cwd);
  const onlyUnselectedText = refs.every(ref => ref.fromText === true);
  if (entries.length !== 1) {
    if (onlyUnselectedText) return [];
    throw new Error("Skill discovery did not return one directory for the active session cwd.");
  }
  const entry = entries[0]!;
  if (entry.errors.length > 0) {
    if (onlyUnselectedText) return [];
    throw new Error("Skill discovery reported directory errors; no Skill turn was started.");
  }
  const result: Array<{ type: "skill"; name: string; path: string }> = [];
  for (const ref of refs) {
    const matches = entry.skills.filter((skill) => skill.name === ref.name && (ref.path === undefined || skill.path === ref.path));
    const unique = [...new Map(matches.map((skill) => [skill.path, skill])).values()];
    if (unique.length === 0) {
      if (ref.fromText === true) continue;
      throw new Error(`Skill '${ref.name}' is unknown or its selected path is no longer in this session directory.`);
    }
    if (unique.length > 1) throw new Error(`Skill '${ref.name}' has multiple paths; select its exact source before sending.`);
    const skill = unique[0]!;
    if (!skill.enabled || matches.some((row) => !row.enabled)) throw new Error(`Skill '${ref.name}' is disabled in this session.`);
    if (!/^(?:\/|[A-Za-z]:[\\/])/.test(skill.path) || !/[\\/]SKILL\.md$/.test(skill.path)) throw new Error(`Skill '${ref.name}' did not provide an absolute SKILL.md path.`);
    if (!result.some((item) => item.name === skill.name && item.path === skill.path)) result.push({ type: "skill", name: skill.name, path: skill.path });
  }
  return result;
}

export function discoverCodexSkillInputs(
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  cwd: string,
  refs: ReadonlyArray<CodexSkillReference>,
) {
  if (refs.length === 0) return Effect.succeed([]);
  return client.request("skills/list", { cwds: [cwd], forceReload: true }).pipe(
    Effect.catch((cause) => refs.every(ref => ref.fromText === true) ? Effect.succeed({ data: [] }) : Effect.fail(cause)),
    Effect.flatMap((inventory) => Effect.try({
      try: () => resolveCodexSkillInputs(inventory, cwd, refs),
      catch: (cause) => CodexErrors.CodexAppServerRequestError.invalidRequest(cause instanceof Error ? cause.message : "Skill directory validation failed."),
    })),
  );
}
