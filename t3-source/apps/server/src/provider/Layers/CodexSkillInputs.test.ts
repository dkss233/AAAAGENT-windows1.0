import { describe, it, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ComposerContextId, SkillContextRecord, ProviderSendTurnInput, ThreadId } from "@t3tools/contracts";
import { collectCodexSkillReferences } from "@t3tools/shared/codexSkillReferences";
import { discoverCodexSkillInputs, resolveCodexSkillInputs } from "./CodexSkillInputs.ts";
import { buildTurnStartParams } from "./CodexSessionRuntime.ts";

const cwd = "/tmp/public-fixture";
const skill = { name: "review", path: "/skills/review/SKILL.md", enabled: true };
const inventory = { data: [{ cwd, skills: [skill], errors: [] }] };
describe("current-turn Codex Skill input", () => {
  it("retains exact path through schema encoding and decoding, with old history readable", () => {
    const record = { version: 1, kind: "skill", contextId: ComposerContextId.make("skill-1"), label: "Review", name: skill.name, path: skill.path };
    const decoded = Schema.decodeUnknownSync(SkillContextRecord)(JSON.parse(JSON.stringify(record)));
    expect(decoded).toEqual(record);
    const { path, ...legacy } = record;
    expect(Schema.decodeUnknownSync(SkillContextRecord)(legacy)).toEqual(legacy);
    expect(() => Schema.decodeUnknownSync(SkillContextRecord)({ ...record, path: "" })).toThrow();
  });
  it("keeps exact selection and merges its body marker without a name-only override", () => {
    expect(collectCodexSkillReferences("$review，检查", [{ kind: "skill", ...skill }])).toEqual([{ name: skill.name, path: skill.path }]);
    expect(collectCodexSkillReferences("$review $other-skill", [])).toEqual([{ name: "review", fromText: true }, { name: "other-skill", fromText: true }]);
  });
  for (const text of ["环境变量 $HOME 为什么不对", "比较 $PATH", "价格 $123 与 $20k", "`$review`", "```sh\n$review\n```", "\\$review"]) {
    it(`does not invoke a Skill for ordinary prose: ${text}`, () => {
      expect(collectCodexSkillReferences(text)).toEqual([]);
    });
  }
  it("leaves unselected ordinary lowercase variables unchanged while selected unknown references fail", () => {
    const refs = collectCodexSkillReferences("环境变量 $http_proxy 为什么不对");
    expect(resolveCodexSkillInputs(inventory, cwd, refs)).toEqual([]);
    expect(() => resolveCodexSkillInputs(inventory, cwd, [{ name: "http_proxy" }])).toThrow(/unknown/);
    expect(resolveCodexSkillInputs(inventory, cwd, [{ name: "review", fromText: true }])).toEqual([{ type: "skill", name: skill.name, path: skill.path }]);
  });
  it("resolves only the active cwd, never a different directory fallback", () => {
    expect(() => resolveCodexSkillInputs(inventory, "/tmp/other", [{ name: "review" }])).toThrow(/active session cwd/);
    expect(() => resolveCodexSkillInputs({ data: [inventory.data[0]!, inventory.data[0]!] }, cwd, [{ name: "review" }])).toThrow();
  });
  it("rejects unknown, forged, disabled and failed discovery before any turn start", () => {
    expect(() => resolveCodexSkillInputs(inventory, cwd, [{ name: "unknown" }])).toThrow(/unknown/);
    expect(() => resolveCodexSkillInputs(inventory, cwd, [{ name: "review", path: "/forged/SKILL.md" }])).toThrow(/selected path/);
    expect(() => resolveCodexSkillInputs({ data: [{ ...inventory.data[0]!, errors: [{}] }] }, cwd, [{ name: "review" }])).toThrow(/directory errors/);
    expect(() => resolveCodexSkillInputs({ data: [{ cwd, skills: [{ ...skill, enabled: false }], errors: [] }] }, cwd, [{ name: "review" }])).toThrow(/disabled/);
  });
  it("never chooses the first same-name source, while an exact pick disambiguates", () => {
    const duplicate = { data: [{ cwd, errors: [], skills: [skill, { ...skill, path: "/repo/review/SKILL.md" }] }] };
    expect(() => resolveCodexSkillInputs(duplicate, cwd, [{ name: "review" }])).toThrow(/multiple paths/);
    expect(resolveCodexSkillInputs(duplicate, cwd, [{ name: "review", path: skill.path }])).toEqual([{ type: "skill", name: skill.name, path: skill.path }]);
  });
  it("reads fresh metadata and sends structured instructions with original text/images", async () => {
    const requests: unknown[] = [];
    const client = { request: (method: string, params: unknown) => { requests.push({ method, params }); return Effect.succeed(inventory); } } as unknown as Parameters<typeof discoverCodexSkillInputs>[0];
    const refs = collectCodexSkillReferences("$review，检查原文", [{ kind: "skill", ...skill }]);
    const decoded = Schema.decodeSync(ProviderSendTurnInput)({ threadId: ThreadId.make("test"), input: "$review，检查原文", skills: refs });
    const skills = await Effect.runPromise(discoverCodexSkillInputs(client, cwd, decoded.skills!));
    const params = await Effect.runPromise(buildTurnStartParams({ threadId: "native", runtimeMode: "full-access", prompt: decoded.input!, attachments: [{ type: "localImage", path: "/fixture/image.png" }], skills }));
    expect(requests).toEqual([{ method: "skills/list", params: { cwds: [cwd], forceReload: true } }]);
    expect(params.input).toEqual([{ type: "text", text: "$review，检查原文" }, { type: "localImage", path: "/fixture/image.png" }, { type: "skill", name: "review", path: skill.path }]);
  });
  it("adds no discovery or extra item for ordinary continuation", async () => {
    const client = { request: () => { throw new Error("No discovery expected"); } } as unknown as Parameters<typeof discoverCodexSkillInputs>[0];
    for (const prompt of ["环境变量 $HOME 为什么不对", "比较 $PATH", "继续原任务"]) {
      const skills = await Effect.runPromise(discoverCodexSkillInputs(client, cwd, collectCodexSkillReferences(prompt)));
      const params = await Effect.runPromise(buildTurnStartParams({ threadId: "native", runtimeMode: "full-access", prompt, skills }));
      expect(params.input).toEqual([{ type: "text", text: prompt }]);
    }
  });
});
