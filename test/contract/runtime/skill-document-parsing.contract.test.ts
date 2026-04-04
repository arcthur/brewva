import { describe, expect, test } from "bun:test";
import {
  getSkillOutputContracts,
  listSkillOutputs,
  mergeOverlayContract,
  parseSkillDocument,
} from "@brewva/brewva-runtime";
import { createContract, createTempSkillDocument, repoRoot } from "./skill-contract.helpers.js";

const MINIMAL_SELECTION_LINES = [
  "selection:",
  "  when_to_use: Use when the task needs the routed test skill.",
  "  examples: [test skill]",
  "  phases: [align]",
] as const;

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
        "  examples: [review this change, assess merge readiness]",
        "  paths: [packages/brewva-runtime]",
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
      examples: ["review this change", "assess merge readiness"],
      paths: ["packages/brewva-runtime"],
      phases: ["investigate", "verify"],
    });
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
        "  examples: [review this change]",
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

    expect(() =>
      mergeOverlayContract(base, {
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
      }),
    ).not.toThrow();
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
      "skills/core/design/SKILL.md",
      [
        "---",
        "name: design",
        "description: design skill",
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
        "# design",
      ],
    );

    const parsed = parseSkillDocument(filePath, "core");
    const contracts = getSkillOutputContracts(parsed.contract);

    expect(contracts.execution_plan).toEqual({
      kind: "json",
      minItems: 1,
      minKeys: undefined,
      requiredFields: [],
      fieldContracts: undefined,
      itemContract: {
        kind: "json",
        minKeys: undefined,
        minItems: undefined,
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
        itemContract: undefined,
      },
    });
  });
});
