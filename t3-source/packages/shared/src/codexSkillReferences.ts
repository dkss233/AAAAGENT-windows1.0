import type { CodexSkillReference } from "@t3tools/contracts";

/** Only the frozen current user body and its explicit context records are inputs. */
export function collectCodexSkillReferences(
  text: string,
  records: ReadonlyArray<{ readonly kind: string }> = [],
): CodexSkillReference[] {
  const selections = records.filter((record) => record.kind === "skill") as unknown as ReadonlyArray<{
    readonly name: string;
    readonly path?: string;
  }>;
  const refs: CodexSkillReference[] = selections.map(({ name, path }) => ({
    name,
    ...(path !== undefined ? { path } : {}),
  }));
  // Code examples and escaped dollars are prose, not current-turn invocations.
  const prose = text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`/g, " ");
  const marker = /(^|[\s([{“"'])\$(?=[A-Za-z0-9:_-]*[A-Za-z])([A-Za-z0-9][A-Za-z0-9:_-]*)(?=$|[\s)\]},.!?;，。！？；”"'])/gu;
  for (const match of prose.matchAll(marker)) {
    const name = match[2]!;
    if (/^[0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?$/.test(name)) continue;
    // Conventional shell environment variables are prose unless selected in the UI.
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    if (!refs.some((ref) => ref.name === name)) refs.push({ name, fromText: true });
  }
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = JSON.stringify([ref.name, ref.path ?? null]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
