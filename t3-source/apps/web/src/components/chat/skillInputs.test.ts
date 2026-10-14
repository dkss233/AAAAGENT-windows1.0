import { describe, expect, it } from "vite-plus/test";
import type { SkillContextRecord, ServerProviderSkill } from "@t3tools/contracts";
import { allowsSkillTrialSend, decodeSkillTrial, explicitSkillTokens, removeSkillMention, retainSkillSelections, skillsForMention } from "../../aaaagent/SkillInputs";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { toKindScopedComposerContextId } from "../../lib/composerContextReferences";

const selection = (path: string, id = "chosen"): SkillContextRecord => ({
  version: 1, kind: "skill", contextId: toKindScopedComposerContextId("skill", id),
  label: "Review", name: "review", path,
});
const directory: ServerProviderSkill[] = [
  { name: "review", path: "/project/.agents/skills/review/SKILL.md", enabled: true, displayName: "Project Review" },
  { name: "review", path: "/user/.codex/skills/review/SKILL.md", enabled: true, displayName: "User Review" },
];
describe("current-turn exact Skill inputs", () => {
  it("retains both explicit same-name paths without choosing a historical first entry", () => {
    const selections = directory.map((skill, index) => selection(skill.path, `selected-${index}`));
    expect(retainSkillSelections("Check ($review).", selections)).toEqual(selections);
    expect(skillsForMention("review", directory)).toHaveLength(2);
    expect(skillsForMention("review", directory, [selections[1]!])).toEqual([directory[1]]);
    expect(skillsForMention("review", directory, [selection("/stale/SKILL.md")])).toEqual([]);
  });
  it("does not retain deleted, escaped, code or currency references", () => {
    const text = '($review), $agent:tools! \\$escaped ` $inline ` $100 $5k $1e3\n```text\n$fenced\n```\n$after';
    expect(explicitSkillTokens(text).map(token => token.name)).toEqual(["review", "agent:tools", "after"]);
    expect(retainSkillSelections("`$review`", [selection(directory[0]!.path)])).toEqual([]);
    expect(retainSkillSelections("plain text", [selection(directory[0]!.path)])).toEqual([]);
    expect(removeSkillMention("Before ($review), after ` $review `.", "review"))
      .toBe("Before (), after ` $review `.");
  });
  it("adds only copied references while preserving original context and no-Skill absence", () => {
    const chosen = selection(directory[1]!.path);
    const base = { terminalContexts: [], reviewComments: [], previewAnnotations: [] };
    expect(buildMessageContext(base)).toBeUndefined();
    const result = buildMessageContext({ ...base, skillSelections: [chosen] })!;
    expect(result).toEqual({ version: 1, records: [chosen] });
    expect(result.records[0]).not.toBe(chosen);
  });
});

describe("bounded Skill trial target", () => {
  const now = Date.parse("2026-10-01T06:00:00Z");
  const envelope = { apiVersion: 1, trial: {
    mode: "bounded-codex-skill-trial", projectId: "test-project", threadIds: ["ordinary", "multi"],
    cwd: "/private/tmp/skill-trial", providerInstanceId: "codex", model: "trial-model", reasoningEffort: "high",
    parentTurnsMax: 2, parentTurnsRemaining: 2, expiresAt: "2026-10-01T06:01:00Z",
  } };
  const target = { projectId: "test-project", threadId: "ordinary", cwd: "/private/tmp/skill-trial", providerInstanceId: "codex", model: "trial-model", reasoningEffort: "high", routeKind: "server" };
  it("permits only the exact existing target and rejects every identity change", () => {
    const trial = decodeSkillTrial(envelope);
    expect(allowsSkillTrialSend(trial, target, now)).toBe(true);
    for (const key of ["projectId", "threadId", "cwd", "providerInstanceId", "model", "reasoningEffort", "routeKind"] as const) {
      expect(allowsSkillTrialSend(trial, { ...target, [key]: "another" }, now)).toBe(false);
    }
  });
  it("fails closed for unavailable, expired, exhausted and malformed capabilities", () => {
    expect(allowsSkillTrialSend(null, target, now)).toBe(false);
    expect(allowsSkillTrialSend(decodeSkillTrial(envelope), { ...target, reasoningEffort: undefined }, now)).toBe(false);
    expect(allowsSkillTrialSend(decodeSkillTrial(envelope), target, Date.parse(envelope.trial.expiresAt))).toBe(false);
    expect(allowsSkillTrialSend(decodeSkillTrial({ ...envelope, trial: { ...envelope.trial, parentTurnsRemaining: 0 } }), target, now)).toBe(false);
    for (const trial of [{ ...envelope.trial, parentTurnsRemaining: 3 }, { ...envelope.trial, threadIds: "ordinary" }, { ...envelope.trial, expiresAt: "unknown" }, { ...envelope.trial, model: null }]) {
      expect(decodeSkillTrial({ apiVersion: 1, trial })).toBeNull();
    }
    expect(decodeSkillTrial({ apiVersion: 2, trial: envelope.trial })).toBeNull();
  });
});
