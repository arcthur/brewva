import { describe, expect, test } from "bun:test";
import {
  BrewvaRuntime,
  selectTopKSkills,
  type SkillTriggerPolicy,
  type SkillsIndexEntry,
} from "@brewva/brewva-runtime";

function repoRoot(): string {
  return process.cwd();
}

function createIndexEntry(
  input: Partial<SkillsIndexEntry> & Pick<SkillsIndexEntry, "name">,
): SkillsIndexEntry {
  return {
    name: input.name,
    tier: input.tier ?? "base",
    description: input.description ?? `${input.name} skill`,
    tags: input.tags ?? [],
    antiTags: input.antiTags ?? [],
    outputs: input.outputs ?? [],
    toolsRequired: input.toolsRequired ?? [],
    costHint: input.costHint ?? "medium",
    stability: input.stability ?? "stable",
    composableWith: input.composableWith ?? [],
    consumes: input.consumes ?? [],
    triggers: input.triggers,
    dispatch: input.dispatch,
  };
}

function emptyTriggers(): SkillTriggerPolicy {
  return {
    intents: [],
    topics: [],
    phrases: [],
    negatives: [],
  };
}

describe("S-001 selector inject top-k and anti-tags", () => {
  test("given query with anti-tag context, when selecting skills, then blocked skill is excluded", async () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const selected = runtime.skills.select("debug failing test regression in typescript module");
    expect(selected.length).toBeGreaterThan(0);

    const docsSelected = runtime.skills.select("implement a new feature and update docs");
    expect(docsSelected.some((skill) => skill.name === "debugging")).toBe(false);
  });

  test("does not hard-exclude review on incidental implementation mention", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const selected = runtime.skills.select(
      "Review the project in depth. Do you think current implementation has followed the philosophy of the project",
    );
    expect(selected.some((skill) => skill.name === "review")).toBe(true);
  });

  test("does not match short tags by substring", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const selected = runtime.skills.select(
      "Analyze project architecture and produce risk-ranked findings",
    );
    expect(selected.some((skill) => skill.name === "gh-issues")).toBe(false);
    expect(selected.some((skill) => skill.name === "github")).toBe(false);
  });

  test("supports chinese review intent routing", () => {
    const runtime = new BrewvaRuntime({ cwd: repoRoot() });
    const selected = runtime.skills.select("请深度审查项目实现是否符合项目哲学");
    expect(selected.some((skill) => skill.name === "review")).toBe(true);
  });

  test("does not leak intent tail token into body window after trimming imperative prefix", () => {
    const selected = selectTopKSkills(
      "Please review code. run tests",
      [
        createIndexEntry({
          name: "cross-boundary",
          description: "cross boundary matcher",
          tags: [],
          triggers: {
            ...emptyTriggers(),
            intents: ["code run"],
          },
        }),
      ],
      3,
    );
    expect(selected).toEqual([]);
  });

  test("falls back to tag matching when triggers are omitted", () => {
    const selected = selectTopKSkills(
      "Review architecture quality risks",
      [
        createIndexEntry({
          name: "review-lite",
          tags: ["review", "quality"],
          description: "architecture review helper",
        }),
      ],
      1,
    );
    expect(selected[0]?.name).toBe("review-lite");
    expect(selected[0]?.reason).toContain("tag_match");
  });

  test("expands intent aliases in lexical stage", () => {
    const selected = selectTopKSkills(
      "Please audit this change",
      [
        createIndexEntry({
          name: "review-lite",
          tags: [],
          triggers: {
            ...emptyTriggers(),
            intents: ["review"],
          },
        }),
      ],
      1,
    );

    expect(selected[0]?.name).toBe("review-lite");
    expect(selected[0]?.reason).toContain("intent_match:audit");
  });

  test("does not treat intent alias as name match", () => {
    const selected = selectTopKSkills(
      "Please audit this change",
      [
        createIndexEntry({
          name: "review",
          tags: [],
          triggers: {
            ...emptyTriggers(),
            intents: ["review"],
          },
        }),
      ],
      1,
    );

    expect(selected[0]?.reason).not.toContain("name_match:audit");
    expect(selected[0]?.reason).toContain("intent_match:audit");
  });

  test("accumulates multiple matched tags with cap for better ranking separation", () => {
    const selected = selectTopKSkills(
      "typescript runtime security",
      [
        createIndexEntry({
          name: "alpha",
          tags: ["typescript", "runtime", "security"],
          triggers: emptyTriggers(),
        }),
        createIndexEntry({
          name: "beta",
          tags: ["typescript"],
          triggers: emptyTriggers(),
        }),
      ],
      2,
    );

    expect(selected[0]?.name).toBe("alpha");
    expect(selected[0]?.score).toBeGreaterThan(selected[1]?.score ?? 0);
    expect(selected[0]?.breakdown.filter((entry) => entry.signal === "tag_match")).toHaveLength(3);
  });

  test("matches intent terms that appear in body with reduced weight", () => {
    const selected = selectTopKSkills(
      "Context about project. Please review this.",
      [
        createIndexEntry({
          name: "quality-check",
          tags: [],
          triggers: {
            ...emptyTriggers(),
            intents: ["review"],
          },
        }),
      ],
      1,
    );

    expect(selected[0]?.name).toBe("quality-check");
    expect(selected[0]?.reason).toContain("intent_body_match:review");
  });

  test("filters by negative intent rules before scoring", () => {
    const selected = selectTopKSkills(
      "Please implement this review",
      [
        createIndexEntry({
          name: "review",
          tags: ["quality", "risk"],
          triggers: {
            ...emptyTriggers(),
            intents: ["review"],
            negatives: [{ scope: "intent", terms: ["implement"] }],
          },
        }),
      ],
      1,
    );

    expect(selected).toEqual([]);
  });

  test("returns no skill for unrelated chatter without lexical signal", () => {
    const selected = selectTopKSkills(
      "camera mountain island concert festival school rain river recipe dog hotel cat school",
      [
        createIndexEntry({
          name: "review",
          tags: ["quality", "risk"],
          triggers: {
            ...emptyTriggers(),
            intents: ["review"],
            phrases: ["code review"],
          },
        }),
      ],
      2,
    );

    expect(selected).toEqual([]);
  });

  test("applies anti-tag as penalty instead of hard filtering", () => {
    const selected = selectTopKSkills(
      "review and implement this",
      [
        createIndexEntry({
          name: "review",
          tags: [],
          antiTags: ["implement"],
          triggers: {
            ...emptyTriggers(),
            intents: ["review"],
          },
        }),
      ],
      1,
    );

    expect(selected[0]?.name).toBe("review");
    expect(selected[0]?.breakdown.some((entry) => entry.signal === "anti_tag_penalty")).toBe(true);
    expect(selected[0]?.score).toBe(15);
  });

  test("emits structured score breakdown for matched skills", () => {
    const selected = selectTopKSkills(
      "review this patch with code review checklist",
      [
        createIndexEntry({
          name: "review",
          tags: ["quality"],
          triggers: {
            ...emptyTriggers(),
            intents: ["review"],
            phrases: ["code review"],
          },
        }),
      ],
      1,
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]?.breakdown.length).toBeGreaterThan(0);
    expect(selected[0]?.breakdown.some((entry) => entry.signal === "name_match")).toBe(true);
    expect(selected[0]?.breakdown.some((entry) => entry.signal === "intent_match")).toBe(true);
  });
});
