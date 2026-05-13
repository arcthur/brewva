import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getSkillCostHint,
  getSkillOutputContracts,
  listSkillFallbackTools,
  listSkillOutputs,
  listSkillPreferredTools,
  mergeOverlayContract,
  parseSkillDocument,
} from "@brewva/brewva-runtime/skills";
import { createContract, createTempSkillDocument, repoRoot } from "./skill-contract.helpers.js";

const MINIMAL_SELECTION_LINES = [
  "selection:",
  "  when_to_use: Use when the task needs the routed test skill.",
] as const;

function readOptionalValues(value: unknown, keys: readonly string[]): unknown[] {
  if (!value || typeof value !== "object") {
    return keys.map(() => undefined);
  }
  const record = value as Record<string, unknown>;
  return keys.map((key) => record[key]);
}

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
        ...MINIMAL_SELECTION_LINES,
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
        ...MINIMAL_SELECTION_LINES,
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

  test("rejects allowed effects that exceed the directory-derived tier ceiling", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-tier-ceiling-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        ...MINIMAL_SELECTION_LINES,
        "intent:",
        "  outputs: []",
        "effects:",
        "  allowed_effects: [workspace_read, external_side_effect]",
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

    expect(() => parseSkillDocument(filePath, "core")).toThrow("tier ceiling");
  });

  test("parses CRLF-authored skill documents", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-crlf-"));
    const filePath = join(workspace, "skills/core/review/SKILL.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "name: review",
        "description: review skill",
        ...MINIMAL_SELECTION_LINES,
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
      ].join("\r\n"),
      "utf8",
    );

    expect(parseSkillDocument(filePath, "core").contract.selection).toEqual({
      whenToUse: "Use when the task needs the routed test skill.",
    });
  });

  test("fails fast when frontmatter contains malformed YAML", () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-invalid-frontmatter-"));
    const filePath = join(workspace, "skills/core/review/SKILL.md");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      [
        "---",
        "name: review",
        "description: review skill",
        "selection: [unterminated",
        "---",
        "# review",
      ].join("\n"),
      "utf8",
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow("invalid frontmatter");
  });

  test("fails fast when non-overlay skills omit hard_ceiling", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-hard-ceiling-required-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        ...MINIMAL_SELECTION_LINES,
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
        ...MINIMAL_SELECTION_LINES,
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
        ...MINIMAL_SELECTION_LINES,
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

  test("parses selection metadata for loadable skills", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-selection-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        "selection:",
        "  when_to_use: Use when reviewing a change plan or diff.",
        "  paths: [packages/brewva-runtime]",
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

    const parsed = parseSkillDocument(filePath, "core");
    expect(parsed.contract.routing).toEqual({
      scope: "core",
    });
    expect(parsed.contract.selection).toEqual({
      whenToUse: "Use when reviewing a change plan or diff.",
      paths: ["packages/brewva-runtime"],
    });
  });

  test("parses loadable skills without selection or execution hints", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-compressed-non-routable-",
      "skills/core/inspect-only/SKILL.md",
      [
        "---",
        "name: inspect-only",
        "description: inspect-only skill",
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
        "consumes: []",
        "---",
        "# inspect-only",
      ],
    );

    const parsed = parseSkillDocument(filePath, "core");
    expect(readOptionalValues(parsed.contract, ["selection", "executionHints"])).toEqual([
      undefined,
      undefined,
    ]);
    expect(getSkillCostHint(parsed.contract)).toBe("medium");
  });

  test("rejects selection.examples as removed hit-rate metadata", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-examples-removed-",
      "skills/core/examples-only/SKILL.md",
      [
        "---",
        "name: examples-only",
        "description: examples-only skill",
        "selection:",
        "  examples: [review a pull request, inspect a diff]",
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
        "consumes: []",
        "---",
        "# examples-only",
      ],
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow(
      "selection contains unsupported field(s): examples",
    );
  });

  test("rejects selection.phases as removed hit-rate metadata", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-phases-removed-",
      "skills/core/phases-only/SKILL.md",
      [
        "---",
        "name: phases-only",
        "description: phases-only skill",
        "selection:",
        "  phases: [investigate, verify]",
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
        "consumes: []",
        "---",
        "# phases-only",
      ],
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow(
      "selection contains unsupported field(s): phases",
    );
  });

  test("rejects empty selection objects", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-empty-selection-",
      "skills/core/empty-selection/SKILL.md",
      [
        "---",
        "name: empty-selection",
        "description: empty selection skill",
        "selection: {}",
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
        "consumes: []",
        "---",
        "# empty-selection",
      ],
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow(
      "selection must declare at least one",
    );
  });

  test("normalizes empty execution tool arrays away", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-empty-execution-hints-",
      "skills/core/empty-hints/SKILL.md",
      [
        "---",
        "name: empty-hints",
        "description: empty hints skill",
        ...MINIMAL_SELECTION_LINES,
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
        "  preferred_tools: []",
        "  fallback_tools: []",
        "consumes: []",
        "---",
        "# empty-hints",
      ],
    );

    const parsed = parseSkillDocument(filePath, "core");
    expect(readOptionalValues(parsed.contract, ["executionHints"])).toEqual([undefined]);
    expect(listSkillPreferredTools(parsed.contract)).toEqual([]);
    expect(listSkillFallbackTools(parsed.contract)).toEqual([]);
  });

  test("parses partial execution hints", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-partial-execution-hints-",
      "skills/core/partial-hints/SKILL.md",
      [
        "---",
        "name: partial-hints",
        "description: partial hints skill",
        ...MINIMAL_SELECTION_LINES,
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
        "  cost_hint: high",
        "consumes: []",
        "---",
        "# partial-hints",
      ],
    );

    const parsed = parseSkillDocument(filePath, "core");
    expect(parsed.contract.executionHints).toEqual({ costHint: "high" });
    expect(listSkillPreferredTools(parsed.contract)).toEqual([]);
    expect(listSkillFallbackTools(parsed.contract)).toEqual([]);
  });

  test("rejects camelCase selection.whenToUse metadata", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-selection-camel-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        "selection:",
        "  whenToUse: Use when reviewing a change plan or diff.",
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

    expect(() => parseSkillDocument(filePath, "core")).toThrow("selection.whenToUse");
  });

  test("rejects removed routing.match_hints metadata", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-routing-match-hints-removed-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        "routing:",
        "  match_hints:",
        "    keywords: [review]",
        ...MINIMAL_SELECTION_LINES,
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

    expect(() => parseSkillDocument(filePath, "core")).toThrow("routing.match_hints");
  });

  test("rejects removed camelCase routing.matchHints metadata", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-routing-match-hints-camel-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        "routing:",
        "  matchHints:",
        "    keywords: [review]",
        ...MINIMAL_SELECTION_LINES,
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

    expect(() => parseSkillDocument(filePath, "core")).toThrow("routing.matchHints");
  });

  test("parses overlay resources without exposing routing scope", () => {
    const parsed = parseSkillDocument(
      `${repoRoot()}/skills/project/overlays/review/SKILL.md`,
      "overlay",
    );

    expect(parsed.category).toBe("overlay");
    expect(readOptionalValues(parsed.contract, ["routing"])).toEqual([undefined]);
    expect(parsed.resources.scripts).toEqual([]);
    expect(parsed.resources.references).toEqual(
      expect.arrayContaining([
        "skills/project/shared/package-boundaries.md",
        "skills/project/shared/migration-priority-matrix.md",
      ]),
    );
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
    expect(readOptionalValues(parsed.contract.intent, ["outputs"])).toEqual([undefined]);
    expect(readOptionalValues(parsed.contract, ["consumes", "composableWith"])).toEqual([
      undefined,
      undefined,
    ]);

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

  test("rejects structured suggested chains because workflow guidance belongs in markdown", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-suggested-chains-removed-",
      "skills/core/suggested-chain/SKILL.md",
      [
        "---",
        "name: suggested-chain",
        "description: suggested chain skill",
        "selection:",
        "  when_to_use: Use when the task needs the routed test skill.",
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
        "  suggested_chains:",
        "    - steps: [plan, implementation]",
        "consumes: []",
        "---",
        "# suggested-chain",
      ],
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow(
      "execution_hints.suggested_chains is not supported. Move workflow guidance into the skill markdown.",
    );
  });

  test("overlay parsing leaves legacy dispatch absent and still merges denied effects", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-overlay-no-dispatch-",
      "skills/project/overlays/review/SKILL.md",
      ["---", "effects:", "  denied_effects: [external_network]", "---", "# overlay"],
    );

    const parsed = parseSkillDocument(filePath, "overlay");

    const merged = mergeOverlayContract(
      createContract({
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
      }),
      parsed.contract,
    );

    expect(merged.effects?.deniedEffects).toEqual(["external_network"]);
  });

  test("rejects legacy dispatch metadata in overlays", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-overlay-legacy-dispatch-",
      "skills/project/overlays/review/SKILL.md",
      [
        "---",
        "dispatch:",
        "  suggest_threshold: 6",
        "effects:",
        "  denied_effects: [external_network]",
        "---",
        "# overlay",
      ],
    );

    expect(() => parseSkillDocument(filePath, "overlay")).toThrow("dispatch has been removed");
  });

  test("fails fast when non-overlay outputs omit output contracts", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-missing-output-contracts-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        ...MINIMAL_SELECTION_LINES,
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
            minKeys: 3,
            requiredFields: ["summary", "precedent_query_summary", "precedent_consult_status"],
            fieldContracts: {
              summary: {
                kind: "text",
                minWords: 3,
                minLength: 18,
              },
              precedent_query_summary: {
                kind: "text",
                minWords: 3,
                minLength: 18,
              },
              precedent_consult_status: {
                kind: "json",
                requiredFields: ["status"],
                fieldContracts: {
                  status: {
                    kind: "enum",
                    values: ["consulted", "no_match", "not_required"],
                  },
                },
              },
            },
          },
        },
      },
    });

    const merged = mergeOverlayContract(base, {
      intent: {
        outputs: ["review_report"],
        outputContracts: {
          review_report: {
            kind: "json",
            fieldContracts: {
              precedent_query_summary: {
                minLength: 18,
                kind: "text",
                minWords: 3,
              },
              precedent_consult_status: {
                fieldContracts: {
                  status: {
                    values: ["consulted", "no_match", "not_required"],
                    kind: "enum",
                  },
                },
                requiredFields: ["status"],
                kind: "json",
              },
              summary: {
                minLength: 18,
                kind: "text",
                minWords: 3,
              },
            },
            requiredFields: ["summary", "precedent_query_summary", "precedent_consult_status"],
            minKeys: 3,
          },
        },
      },
    });
    expect(merged.intent?.outputContracts?.review_report).toEqual(
      base.intent?.outputContracts?.review_report,
    );
  });

  test("parses nested json output contracts with required fields and field contracts", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-json-output-contracts-",
      "skills/core/review/SKILL.md",
      [
        "---",
        "name: review",
        "description: review skill",
        ...MINIMAL_SELECTION_LINES,
        "intent:",
        "  outputs: [review_report]",
        "  output_contracts:",
        "    review_report:",
        "      kind: json",
        "      min_keys: 3",
        "      required_fields: [summary, precedent_query_summary, precedent_consult_status]",
        "      field_contracts:",
        "        summary:",
        "          kind: text",
        "          min_words: 3",
        "          min_length: 18",
        "        precedent_query_summary:",
        "          kind: text",
        "          min_words: 3",
        "          min_length: 18",
        "        precedent_consult_status:",
        "          kind: json",
        "          required_fields: [status]",
        "          field_contracts:",
        "            status:",
        "              kind: enum",
        "              values: [consulted, no_match, not_required]",
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

    const parsed = parseSkillDocument(filePath, "core");
    expect(getSkillOutputContracts(parsed.contract).review_report).toEqual({
      kind: "json",
      minKeys: 3,
      requiredFields: ["summary", "precedent_query_summary", "precedent_consult_status"],
      fieldContracts: {
        summary: {
          kind: "text",
          minWords: 3,
          minLength: 18,
        },
        precedent_query_summary: {
          kind: "text",
          minWords: 3,
          minLength: 18,
        },
        precedent_consult_status: {
          kind: "json",
          requiredFields: ["status"],
          fieldContracts: {
            status: {
              kind: "enum",
              values: ["consulted", "no_match", "not_required"],
            },
          },
        },
      },
    });
  });

  test("parses semantic bindings for canonical first-party skills", () => {
    const parsed = parseSkillDocument(`${repoRoot()}/skills/core/plan/SKILL.md`, "core");

    expect(parsed.contract.intent?.semanticBindings).toEqual({
      design_spec: "planning.design_spec.v2",
      execution_plan: "planning.execution_plan.v2",
      execution_mode_hint: "planning.execution_mode_hint.v2",
      risk_register: "planning.risk_register.v2",
      implementation_targets: "planning.implementation_targets.v2",
    });
    expect(listSkillOutputs(parsed.contract)).toEqual([
      "design_spec",
      "execution_plan",
      "execution_mode_hint",
      "risk_register",
      "implementation_targets",
    ]);
    expect(readOptionalValues(parsed.contract.intent, ["outputContracts"])).toEqual([undefined]);
  });

  test("parses semantic bindings for prep skill", () => {
    const parsed = parseSkillDocument(`${repoRoot()}/skills/core/prep/SKILL.md`, "core");

    expect(parsed.contract.intent?.semanticBindings).toEqual({
      implementation_targets: "planning.implementation_targets.v2",
      success_criteria: "planning.success_criteria.v2",
      approach_simplicity_check: "planning.approach_simplicity_check.v2",
      scope_declaration: "planning.scope_declaration.v2",
    });
    expect(listSkillOutputs(parsed.contract)).toEqual([
      "implementation_targets",
      "success_criteria",
      "approach_simplicity_check",
      "scope_declaration",
    ]);
    expect(readOptionalValues(parsed.contract.intent, ["outputContracts"])).toEqual([undefined]);
  });

  test("rejects authored output contracts for semantic-bound outputs", () => {
    const filePath = createTempSkillDocument(
      "brewva-semantic-bound-authored-contract-",
      "skills/core/plan/SKILL.md",
      [
        "---",
        "name: plan",
        "description: plan skill",
        ...MINIMAL_SELECTION_LINES,
        "intent:",
        "  outputs: [design_spec]",
        "  output_contracts:",
        "    design_spec:",
        "      kind: text",
        "      min_words: 4",
        "      min_length: 24",
        "  semantic_bindings:",
        "    design_spec: planning.design_spec.v2",
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
        "# plan",
      ],
    );

    expect(() => parseSkillDocument(filePath, "core")).toThrow(
      "must not declare semantic-bound outputs",
    );
  });

  test("rejects overlays that modify outputs for semantic-bound skills", () => {
    const base = parseSkillDocument(`${repoRoot()}/skills/core/plan/SKILL.md`, "core");
    const overlayPath = createTempSkillDocument(
      "brewva-semantic-bound-overlay-",
      "skills/project/overlays/plan/SKILL.md",
      [
        "---",
        "intent:",
        "  outputs: [design_spec, execution_plan]",
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
        "# plan overlay",
      ],
    );
    const overlay = parseSkillDocument(overlayPath, "overlay");

    expect(() => mergeOverlayContract(base.contract, overlay.contract)).toThrow(
      "semantic-bound skill overlays cannot modify outputs",
    );
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

  test("parses recursive item_contract definitions for json array outputs", () => {
    const filePath = createTempSkillDocument(
      "brewva-skill-item-contract-",
      "skills/core/plan/SKILL.md",
      [
        "---",
        "name: plan",
        "description: plan skill",
        ...MINIMAL_SELECTION_LINES,
        "intent:",
        "  outputs: [execution_plan]",
        "  output_contracts:",
        "    execution_plan:",
        "      kind: json",
        "      min_items: 1",
        "      item_contract:",
        "        kind: json",
        "        required_fields: [step, intent]",
        "        field_contracts:",
        "          step:",
        "            kind: text",
        "            min_words: 2",
        "            min_length: 16",
        "          intent:",
        "            kind: text",
        "            min_words: 2",
        "            min_length: 16",
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
        "# plan",
      ],
    );

    const parsed = parseSkillDocument(filePath, "core");
    const contracts = getSkillOutputContracts(parsed.contract);

    expect(contracts.execution_plan).toEqual({
      kind: "json",
      minItems: 1,
      itemContract: {
        kind: "json",
        requiredFields: ["step", "intent"],
        fieldContracts: {
          step: {
            kind: "text",
            minWords: 2,
            minLength: 16,
          },
          intent: {
            kind: "text",
            minWords: 2,
            minLength: 16,
          },
        },
      },
    });
  });
});
