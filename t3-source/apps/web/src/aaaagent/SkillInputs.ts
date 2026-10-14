import { SkillContextRecord, type ServerProviderSkill } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export function skillIdentity(skill: Pick<ServerProviderSkill, "name" | "path">): string {
  return JSON.stringify([skill.name, skill.path]);
}

/** Only current prose mentions retain a selection; code and escaped dollars do not. */
export function explicitSkillTokens(text: string): Array<{ name: string; start: number; end: number }> {
  const tokens: Array<{ name: string; start: number; end: number }> = [];
  const boundary = /[\s.,!?;()\[\]{}<>"'，。！？；：“”‘’]/u;
  let fence: string | null = null;
  let inlineTicks = 0;
  for (let i = 0; i < text.length;) {
    const lineStart = i === 0 || text[i - 1] === "\n";
    if (lineStart) {
      const marker = /^( {0,3})(`{3,}|~{3,})/.exec(text.slice(i));
      if (marker) {
        const run = marker[2]!;
        if (!fence) fence = run;
        else if (run[0] === fence[0] && run.length >= fence.length) fence = null;
        const end = text.indexOf("\n", i);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
    }
    if (fence) { i++; continue; }
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === "`") {
      let end = i + 1;
      while (text[end] === "`") end++;
      const count = end - i;
      if (!inlineTicks) inlineTicks = count;
      else if (inlineTicks === count) inlineTicks = 0;
      i = end; continue;
    }
    if (!inlineTicks && text[i] === "$" && (i === 0 || boundary.test(text[i - 1]!))) {
      const name = /^[a-zA-Z0-9:_-]+/.exec(text.slice(i + 1))?.[0];
      if (name && /[a-zA-Z]/.test(name) && !/^\d[\d_]*(?:[kKmMbBtT]|[eE]\d+)?$/.test(name)) {
        const end = i + 1 + name.length;
        if (end === text.length || boundary.test(text[end]!)) {
          tokens.push({ name, start: i, end }); i = end; continue;
        }
      }
    }
    i++;
  }
  return tokens;
}

export function retainSkillSelections(text: string, selections: ReadonlyArray<SkillContextRecord> = []): SkillContextRecord[] {
  const names = new Set(explicitSkillTokens(text).map(token => token.name));
  const seen = new Set<string>();
  return selections.filter(selection => {
    if (!Schema.is(SkillContextRecord)(selection) || !names.has(selection.name)) return false;
    const key = JSON.stringify([selection.name, selection.path ?? null]);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(selection => ({ ...selection }));
}

export function removeSkillMention(text: string, name: string): string {
  return explicitSkillTokens(text).filter(token => token.name === name).reverse()
    .reduce((value, token) => value.slice(0, token.start) + value.slice(token.end), text);
}

/** A historical name-only chip may open a file only when the directory is unambiguous. */
export function skillsForMention(name: string, skills: ReadonlyArray<ServerProviderSkill>, selections: ReadonlyArray<SkillContextRecord> = []): ServerProviderSkill[] {
  const chosen = selections.filter(selection => selection.name === name && selection.path);
  const candidates = skills.filter(skill => skill.name === name &&
    (chosen.length === 0 || chosen.some(selection => selection.path === skill.path)));
  const seen = new Set<string>();
  return candidates.filter(skill => {
    const key = skillIdentity(skill);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export interface SkillTrial {
  mode: "bounded-codex-skill-trial";
  projectId: string;
  threadIds: string[];
  cwd: string;
  providerInstanceId: string;
  model: string;
  reasoningEffort: string;
  parentTurnsMax: 2;
  parentTurnsRemaining: number;
  expiresAt: string;
}
export interface SkillTrialTarget {
  projectId: string | null | undefined;
  threadId: string | null | undefined;
  cwd: string | null | undefined;
  providerInstanceId: string | null | undefined;
  model: string | null | undefined;
  reasoningEffort: string | null | undefined;
  routeKind: string;
}
export function decodeSkillTrial(value: unknown): SkillTrial | null {
  if (!value || typeof value !== "object") return null;
  const envelope = value as { apiVersion?: unknown; trial?: unknown };
  if (envelope.apiVersion !== 1 || !envelope.trial || typeof envelope.trial !== "object") return null;
  const trial = envelope.trial as SkillTrial;
  if (trial.mode !== "bounded-codex-skill-trial" || trial.parentTurnsMax !== 2 ||
      !Number.isInteger(trial.parentTurnsRemaining) || trial.parentTurnsRemaining < 0 || trial.parentTurnsRemaining > 2 ||
      !Array.isArray(trial.threadIds) || trial.threadIds.length === 0 || trial.threadIds.length > 2 ||
      !trial.threadIds.every(id => typeof id === "string" && id.trim().length > 0) ||
      ![trial.projectId, trial.cwd, trial.providerInstanceId, trial.model, trial.reasoningEffort, trial.expiresAt]
        .every(field => typeof field === "string" && field.trim().length > 0) ||
      !trial.cwd.startsWith("/") || !Number.isFinite(Date.parse(trial.expiresAt))) return null;
  return trial;
}
export function allowsSkillTrialSend(trial: SkillTrial | null, target: SkillTrialTarget, now = Date.now()): boolean {
  return trial !== null && trial.parentTurnsRemaining > 0 && Date.parse(trial.expiresAt) > now &&
    target.routeKind === "server" && trial.projectId === target.projectId &&
    trial.threadIds.includes(target.threadId ?? "") && trial.cwd === target.cwd &&
    trial.providerInstanceId === target.providerInstanceId && trial.model === target.model &&
    trial.reasoningEffort === target.reasoningEffort;
}
