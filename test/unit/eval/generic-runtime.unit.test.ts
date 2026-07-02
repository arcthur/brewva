import { describe, expect, test } from "bun:test";
import { buildGenericScenarioPrompt, parseNamedOutputs } from "../../eval/generic-runtime.js";
import type { EvalScenario } from "../../eval/types.js";

const scenario: EvalScenario = {
  id: "sample",
  skill: "harness-fluency",
  description: "sample",
  context: {
    task_description: "Do the thing.",
    available_artifacts: { goal_state: "authorized" },
    workspace_state: "src/a.ts defines `x`.",
  },
  rubric_path: "unused",
  output_contracts: {
    decision: { kind: "json", min_keys: 1 },
    turn_plan: { kind: "text", min_words: 3 },
  },
};

describe("generic runtime prompt assembly", () => {
  test("carries scenario context and names every required output", () => {
    const prompt = buildGenericScenarioPrompt(scenario);
    expect(prompt).toContain("Do the thing.");
    expect(prompt).toContain("goal_state: authorized");
    expect(prompt).toContain("src/a.ts defines `x`.");
    expect(prompt).toContain("- decision (valid JSON)");
    expect(prompt).toContain("- turn_plan (text)");
    expect(prompt).toContain("fence info string");
  });

  test("never leaks fixture or rubric content (assembled from scenario fields only)", () => {
    const prompt = buildGenericScenarioPrompt(scenario);
    expect(prompt).not.toContain("rubric");
    expect(prompt).not.toContain("fixture");
  });
});

describe("generic runtime output parsing", () => {
  test("parses named fenced blocks with JSON coercion per contract", () => {
    const outputs = parseNamedOutputs(
      [
        "Some preamble the model wrote.",
        "```decision",
        '{ "interpreted_scope": "whole_goal", "asks_permission": false }',
        "```",
        "```turn_plan",
        "Migrate the remaining modules and run the suite.",
        "```",
      ].join("\n"),
      scenario.output_contracts,
    );
    expect(outputs.decision).toEqual({ interpreted_scope: "whole_goal", asks_permission: false });
    expect(outputs.turn_plan).toBe("Migrate the remaining modules and run the suite.");
  });

  test("keeps malformed JSON as raw text so the shape grader fails it honestly", () => {
    const outputs = parseNamedOutputs(
      "```decision\nnot json at all\n```",
      scenario.output_contracts,
    );
    expect(outputs.decision).toBe("not json at all");
  });

  test("missing blocks stay absent (no fixture fallback)", () => {
    const outputs = parseNamedOutputs("no fences here", scenario.output_contracts);
    expect(outputs).toEqual({});
  });

  test("does not confuse output names that prefix each other", () => {
    const contracts = {
      plan: { kind: "text" as const },
      plan_extra: { kind: "text" as const },
    };
    const outputs = parseNamedOutputs("```plan_extra\nEXTRA\n```\n```plan\nMAIN\n```", contracts);
    expect(outputs.plan).toBe("MAIN");
    expect(outputs.plan_extra).toBe("EXTRA");
  });
});
