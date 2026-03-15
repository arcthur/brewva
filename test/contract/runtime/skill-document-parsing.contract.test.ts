import { describe, expect, test } from "bun:test";
import {
  getSkillOutputContracts,
  listSkillOutputs,
  mergeOverlayContract,
  parseSkillDocument,
} from "@brewva/brewva-runtime";
import { createContract, createTempSkillDocument, repoRoot } from "./skill-contract.helpers.js";

describe("skill document parsing", () => {
  test("fails fast when forbidden tier frontmatter field is present", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-tier-forbidden-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        "tier: base",
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 20",
        "    max_tokens: 20000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# review",
      ],
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("tier");
  });

  test("fails fast when forbidden category frontmatter field is present", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-category-forbidden-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        "category: core",
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 20",
        "    max_tokens: 20000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# review",
      ],
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("category");
  });

  test("fails fast when non-overlay skills omit hard_ceiling", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-hard-ceiling-required-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# review",
      ],
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("resources.hard_ceiling");
  });

  test("fails fast when hard_ceiling is lower than default_lease", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-hard-ceiling-lower-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 8",
        "    max_tokens: 9000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# review",
      ],
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("resources.hard_ceiling");
  });

  test("rejects removed continuity routing metadata", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-continuity-removed-",
      "skills/domain/goal-loop/SKILL.md",
      [
        "---",
        "name: goal-loop",
        "description: goal loop skill",
        "routing:",
        "  continuity_required: true",
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 20",
        "    max_tokens: 20000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# goal-loop",
      ],
    );

    expect(() => parseSkillDocument(filePath, "domain")).toThrow("continuity_required");
  });

  test("parses overlay resources without exposing routing scope", () => {
    const parsed = parseSkillDocument(
      `${repoRoot()}/skills/project/overlays/review/SKILL.md`,
      "overlay",
    );

    expect(parsed.category).toBe("overlay");
    expect(parsed.contract.routing).toBeUndefined();
    expect(parsed.resources.scripts).toContain("skills/project/scripts/check-skill-dod.sh");
  });

  test("overlay parsing leaves omitted array fields undefined so base contracts can inherit them", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-overlay-inherit-",
      "skills/project/overlays/implementation/SKILL.md",
      [
        "---",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 20",
        "    max_tokens: 20000",
        "execution_hints:",
        "  preferred_tools: [read, edit]",
        "---",
        "# overlay",
      ],
    );

    const parsed = parseSkillDocument(filePath, "overlay");
    expect(parsed.contract.intent?.outputs).toBeUndefined();
    expect(parsed.contract.consumes).toBeUndefined();
    expect(parsed.contract.composableWith).toBeUndefined();

    const merged = mergeOverlayContract(
      createContract({
        name: "implementation",
        category: "core",
        routing: { scope: "core" },
        intent: {
          outputs: ["change_set"],
          outputContracts: {
            change_set: {
              kind: "text",
              minWords: 3,
              minLength: 18,
            },
          },
        },
        requires: ["root_cause"],
        consumes: ["root_cause"],
        composableWith: ["debugging"],
      }),
      parsed.contract,
    );

    expect(listSkillOutputs(merged)).toEqual(["change_set"]);
    expect(getSkillOutputContracts(merged)).toEqual({
      change_set: {
        kind: "text",
        minWords: 3,
        minLength: 18,
      },
    });
    expect(merged.consumes).toEqual(["root_cause"]);
    expect(merged.composableWith).toEqual(["debugging"]);
  });

  test("overlay parsing leaves omitted dispatch undefined so base thresholds can inherit unchanged", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-overlay-dispatch-inherit-",
      "skills/project/overlays/review/SKILL.md",
      ["---", "effects:", "  denied_effects: [external_network]", "---", "# overlay"],
    );

    const parsed = parseSkillDocument(filePath, "overlay");
    expect(parsed.contract.dispatch).toBeUndefined();

    const merged = mergeOverlayContract(
      createContract({
        name: "review",
        category: "core",
        routing: { scope: "core" },
        dispatch: {
          suggestThreshold: 6,
          autoThreshold: 11,
        },
        intent: {
          outputs: ["review_report"],
          outputContracts: {
            review_report: {
              kind: "text",
              minWords: 3,
              minLength: 18,
            },
          },
        },
      }),
      parsed.contract,
    );

    expect(merged.dispatch).toEqual({
      suggestThreshold: 6,
      autoThreshold: 11,
    });
    expect(merged.effects?.deniedEffects).toEqual(["external_network"]);
  });

  test("fails fast when non-overlay outputs omit output contracts", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-missing-output-contracts-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        "intent:",
        "  outputs: [review_report]",
        "effects:",
        "  allowed_effects: [workspace_read]",
        "resources:",
        "  default_lease:",
        "    max_tool_calls: 10",
        "    max_tokens: 10000",
        "  hard_ceiling:",
        "    max_tool_calls: 20",
        "    max_tokens: 20000",
        "execution_hints:",
        "  preferred_tools: [read]",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# review",
      ],
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("output_contracts");
  });

  test("rejects overlays that attempt to replace a base output contract", () => {
    const base = createContract({
      name: "review",
      category: "core",
      routing: { scope: "core" },
      intent: {
        outputs: ["review_report"],
        outputContracts: {
          review_report: {
            kind: "text",
            minWords: 3,
            minLength: 18,
          },
        },
      },
    });

    expect(() =>
      mergeOverlayContract(base, {
        intent: {
          outputs: ["review_report"],
          outputContracts: {
            review_report: {
              kind: "text",
              minWords: 2,
              minLength: 12,
            },
          },
        },
      }),
    ).toThrow("cannot replace the base contract");
  });

  test("accepts equivalent json output contracts even when object key order differs", () => {
    const base = createContract({
      name: "review",
      category: "core",
      routing: { scope: "core" },
      intent: {
        outputs: ["review_report"],
        outputContracts: {
          review_report: {
            kind: "json",
            minKeys: 1,
            minItems: 1,
          },
        },
      },
    });

    expect(() =>
      mergeOverlayContract(base, {
        intent: {
          outputs: ["review_report"],
          outputContracts: {
            review_report: {
              minItems: 1,
              kind: "json",
              minKeys: 1,
            },
          },
        },
      }),
    ).not.toThrow();
  });

  test("parses skill-local resources with relative paths", () => {
    const parsed = parseSkillDocument(`${repoRoot()}/skills/meta/skill-authoring/SKILL.md`, "meta");

    expect(parsed.category).toBe("meta");
    expect(parsed.resources.references).toEqual(
      expect.arrayContaining(["references/output-patterns.md", "references/workflows.md"]),
    );
    expect(parsed.resources.scripts).toEqual(
      expect.arrayContaining([
        "scripts/init_skill.py",
        "scripts/fork_skill.py",
        "scripts/package_skill.py",
        "scripts/quick_validate.py",
      ]),
    );
  });
});
