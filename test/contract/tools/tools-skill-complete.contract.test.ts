import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DelegationRunRecord } from "@brewva/brewva-runtime";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createSkillCompleteTool, createSkillLoadTool } from "@brewva/brewva-tools";

type ToolExecutionContext = Parameters<ReturnType<typeof createSkillLoadTool>["execute"]>[4];

function writeSkill(
  filePath: string,
  input: { name: string; outputs: string[]; outputContracts?: string[]; consumes?: string[] },
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      "---",
      `name: ${input.name}`,
      `description: ${input.name} skill`,
      "intent:",
      `  outputs: [${input.outputs.join(", ")}]`,
      ...(input.outputContracts && input.outputContracts.length > 0
        ? ["  output_contracts:", ...input.outputContracts.map((line) => `  ${line}`)]
        : []),
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
      `consumes: [${(input.consumes ?? []).join(", ")}]`,
      "---",
      `# ${input.name}`,
      "",
      "## Intent",
      "",
      "Test skill.",
    ].join("\n"),
    "utf8",
  );
}

function extractTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function fakeContext(sessionId: string): ToolExecutionContext {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  } as unknown as ToolExecutionContext;
}

function buildImpactMap(input: {
  summary: string;
  changedFileClasses?: string[];
  changeCategories?: string[];
}) {
  return {
    summary: input.summary,
    affected_paths: ["packages/brewva-runtime/src/services/event-pipeline.ts"],
    boundaries: ["runtime.events"],
    high_risk_touchpoints: ["review lane classification"],
    change_categories: input.changeCategories ?? [],
    changed_file_classes: input.changedFileClasses ?? ["runtime_coordination"],
  };
}

describe("skill_complete tool", () => {
  test("allows omitted outputs for skills whose contract declares no outputs", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-empty-"));
    writeSkill(join(workspace, ".brewva/skills/core/noop/SKILL.md"), {
      name: "noop",
      outputs: [],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-empty-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load",
      { name: "noop" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completed");
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
  });

  test("rejects placeholder outputs for built-in design artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-design-"));
    writeSkill(join(workspace, ".brewva/skills/core/design-contract/SKILL.md"), {
      name: "design-contract",
      outputs: ["design_spec", "execution_plan", "execution_mode_hint", "risk_register"],
      outputContracts: [
        "  design_spec:",
        "    kind: text",
        "    min_words: 4",
        "    min_length: 24",
        "  execution_plan:",
        "    kind: json",
        "    min_items: 2",
        "  execution_mode_hint:",
        "    kind: enum",
        "    values: [direct_patch, test_first, coordinated_rollout]",
        "  risk_register:",
        "    kind: json",
        "    min_items: 1",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-design-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-design",
      { name: "design-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-design",
      {
        outputs: {
          design_spec: "test",
          execution_plan: ["a"],
          execution_mode_hint: "direct_patch",
          risk_register: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("Missing required outputs: risk_register");
    expect(text).toContain("Invalid required outputs: design_spec, execution_plan");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("design-contract");
  });

  test("accepts informative built-in design artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-design-valid-"));
    writeSkill(join(workspace, ".brewva/skills/core/design-contract/SKILL.md"), {
      name: "design-contract",
      outputs: ["design_spec", "execution_plan", "execution_mode_hint", "risk_register"],
      outputContracts: [
        "  design_spec:",
        "    kind: text",
        "    min_words: 4",
        "    min_length: 24",
        "  execution_plan:",
        "    kind: json",
        "    min_items: 2",
        "  execution_mode_hint:",
        "    kind: enum",
        "    values: [direct_patch, test_first, coordinated_rollout]",
        "  risk_register:",
        "    kind: json",
        "    min_items: 1",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-design-2";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-design-valid",
      { name: "design-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-design-valid",
      {
        outputs: {
          design_spec:
            "Keep runtime-owned guard semantics in the kernel and move repository discovery ahead of design work.",
          execution_plan: [
            "Promote repository_snapshot and impact_map to required design inputs.",
            "Tighten output validation so placeholder artifacts cannot complete the skill.",
          ],
          execution_mode_hint: "direct_patch",
          risk_register: [
            {
              risk: "Guard resets could still be triggered by non-epistemic control actions.",
              mitigation:
                "Classify lifecycle inspection as neutral and only clear on real strategy shifts.",
            },
          ],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completed");
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
  });

  test("synthesizes canonical learning-research outputs from repository precedent search", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-learning-research-"));
    writeSkill(join(workspace, ".brewva/skills/core/learning-research-contract/SKILL.md"), {
      name: "learning-research-contract",
      outputs: [
        "knowledge_brief",
        "precedent_refs",
        "preventive_checks",
        "precedent_query_summary",
        "precedent_consult_status",
      ],
      outputContracts: [
        "  knowledge_brief:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  precedent_refs:",
        "    kind: json",
        "    min_items: 1",
        "  preventive_checks:",
        "    kind: json",
        "    min_items: 1",
        "  precedent_query_summary:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  precedent_consult_status:",
        "    kind: enum",
        "    values: [matched, no_relevant_precedent_found]",
      ],
    });
    mkdirSync(join(workspace, "docs/solutions/runtime-errors"), { recursive: true });
    writeFileSync(
      join(workspace, "docs/solutions/runtime-errors/wal-recovery-race.md"),
      `---
title: WAL recovery race during replay
status: active
problem_kind: bugfix
module: brewva-runtime
boundaries:
  - runtime.turnWal
tags:
  - wal
  - recovery
updated_at: 2026-03-31
---

# WAL recovery race during replay

## Problem

Replay resumed before the WAL cursor was pinned.

## Prevention

- Pin the WAL cursor before replay crosses an effectful boundary.
- Verify rollback receipts remain aligned with the resumed cursor.
`,
      "utf8",
    );
    mkdirSync(join(workspace, "docs/architecture"), { recursive: true });
    writeFileSync(
      join(workspace, "docs/architecture/wal.md"),
      `# WAL Architecture

The WAL boundary must keep replay ordering deterministic.
`,
      "utf8",
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-learning-research-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-learning-research",
      { name: "learning-research-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-learning-research",
      {
        learningResearch: {
          query: "wal recovery replay",
          module: "brewva-runtime",
          boundary: "runtime.turnWal",
          tags: ["wal"],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completed");
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
    expect(runtime.skills.getOutputs(sessionId, "learning-research-contract")).toMatchObject({
      precedent_consult_status: "matched",
      precedent_refs: ["docs/solutions/runtime-errors/wal-recovery-race.md"],
    });
    expect(
      runtime.skills.getOutputs(sessionId, "learning-research-contract")?.precedent_query_summary,
    ).toContain("search_mode=solution_then_bootstrap");
    expect(
      runtime.skills.getOutputs(sessionId, "learning-research-contract")?.preventive_checks,
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Pin the WAL cursor before replay crosses an effectful boundary."),
      ]),
    );
  });

  test("rejects manual learning-research outputs when learningResearch synthesis is enabled", async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), "brewva-skill-complete-learning-research-reject-"),
    );
    writeSkill(join(workspace, ".brewva/skills/core/learning-research-contract/SKILL.md"), {
      name: "learning-research-contract",
      outputs: [
        "knowledge_brief",
        "precedent_refs",
        "preventive_checks",
        "precedent_query_summary",
        "precedent_consult_status",
      ],
      outputContracts: [
        "  knowledge_brief:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  precedent_refs:",
        "    kind: json",
        "    min_items: 0",
        "  preventive_checks:",
        "    kind: json",
        "    min_items: 0",
        "  precedent_query_summary:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  precedent_consult_status:",
        "    kind: enum",
        "    values: [matched, no_relevant_precedent_found]",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-learning-research-2";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-learning-research-reject",
      { name: "learning-research-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-learning-research-reject",
      {
        outputs: {
          knowledge_brief: "Manual output should be rejected when synthesis is enabled.",
        },
        learningResearch: {
          query: "wal recovery replay",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Learning research synthesis rejected.");
    expect(text).toContain("manual learning-research outputs");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("learning-research-contract");
  });

  test("rejects placeholder outputs for built-in review artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-review-"));
    writeSkill(join(workspace, ".brewva/skills/core/review-contract/SKILL.md"), {
      name: "review-contract",
      outputs: ["review_report", "review_findings", "merge_decision"],
      outputContracts: [
        "  review_report:",
        "    kind: json",
        "    min_keys: 7",
        "    required_fields: [summary, activated_lanes, activation_basis, missing_evidence, residual_blind_spots, precedent_query_summary, precedent_consult_status]",
        "    field_contracts:",
        "      summary:",
        "        kind: text",
        "        min_words: 3",
        "        min_length: 18",
        "      activated_lanes:",
        "        kind: json",
        "        min_items: 1",
        "      activation_basis:",
        "        kind: json",
        "        min_items: 1",
        "      missing_evidence:",
        "        kind: json",
        "        min_items: 0",
        "      residual_blind_spots:",
        "        kind: json",
        "        min_items: 0",
        "      precedent_query_summary:",
        "        kind: text",
        "        min_words: 3",
        "        min_length: 18",
        "      precedent_consult_status:",
        "        kind: json",
        "        required_fields: [status]",
        "        field_contracts:",
        "          status:",
        "            kind: enum",
        "            values: [consulted, no_match, not_required]",
        "  review_findings:",
        "    kind: json",
        "    min_items: 1",
        "  merge_decision:",
        "    kind: enum",
        "    values: [ready, needs_changes, blocked]",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-review-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-review",
      { name: "review-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-review",
      {
        outputs: {
          review_report: {
            summary: "test",
            activated_lanes: [],
            activation_basis: [],
            missing_evidence: [],
            residual_blind_spots: [],
            precedent_query_summary: "test",
            precedent_consult_status: {},
          },
          review_findings: "summary",
          merge_decision: "needs_changes",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("Invalid required outputs: review_report, review_findings");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("review-contract");
  });

  test("accepts structured review artifacts with disclosure metadata", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-review-valid-"));
    writeSkill(join(workspace, ".brewva/skills/core/review-contract/SKILL.md"), {
      name: "review-contract",
      outputs: ["review_report", "review_findings", "merge_decision"],
      outputContracts: [
        "  review_report:",
        "    kind: json",
        "    min_keys: 7",
        "    required_fields: [summary, activated_lanes, activation_basis, missing_evidence, residual_blind_spots, precedent_query_summary, precedent_consult_status]",
        "    field_contracts:",
        "      summary:",
        "        kind: text",
        "        min_words: 3",
        "        min_length: 18",
        "      activated_lanes:",
        "        kind: json",
        "        min_items: 1",
        "      activation_basis:",
        "        kind: json",
        "        min_items: 1",
        "      missing_evidence:",
        "        kind: json",
        "        min_items: 0",
        "      residual_blind_spots:",
        "        kind: json",
        "        min_items: 0",
        "      precedent_query_summary:",
        "        kind: text",
        "        min_words: 3",
        "        min_length: 18",
        "      precedent_consult_status:",
        "        kind: json",
        "        required_fields: [status]",
        "        field_contracts:",
        "          status:",
        "            kind: enum",
        "            values: [consulted, no_match, not_required]",
        "          precedent_refs:",
        "            kind: json",
        "            min_items: 1",
        "  review_findings:",
        "    kind: json",
        "    min_items: 1",
        "  merge_decision:",
        "    kind: enum",
        "    values: [ready, needs_changes, blocked]",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-review-2";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-review-valid",
      { name: "review-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-review-valid",
      {
        outputs: {
          review_report: {
            summary:
              "Review found no merge blocker after checking the active lanes and consulting the relevant repository precedent.",
            activated_lanes: ["review-correctness", "review-boundaries", "review-operability"],
            activation_basis: [
              "The diff changes workflow artifacts and package-facing boundaries.",
              "Verification evidence is current relative to the latest write.",
            ],
            missing_evidence: [],
            residual_blind_spots: [
              "Security lane was not activated because no new trust boundary is exposed.",
            ],
            precedent_query_summary:
              "Searched repository precedents for workflow review drift and prior advisory review patterns.",
            precedent_consult_status: {
              status: "consulted",
              precedent_refs: ["docs/solutions/workflow/review-disclosure-shape.md"],
            },
          },
          review_findings: [
            {
              finding:
                "No material blocker remains after the consulted precedent and current evidence agree.",
            },
          ],
          merge_decision: "ready",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completed");
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
  });

  test("synthesizes canonical review outputs from delegated review lanes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-review-ensemble-"));
    writeSkill(join(workspace, ".brewva/skills/core/review-contract/SKILL.md"), {
      name: "review-contract",
      outputs: ["review_report", "review_findings", "merge_decision"],
      outputContracts: [
        "  review_report:",
        "    kind: json",
        "    min_keys: 7",
        "    required_fields: [summary, activated_lanes, activation_basis, missing_evidence, residual_blind_spots, precedent_query_summary, precedent_consult_status]",
        "    field_contracts:",
        "      summary:",
        "        kind: text",
        "        min_words: 3",
        "        min_length: 18",
        "      activated_lanes:",
        "        kind: json",
        "        min_items: 1",
        "      activation_basis:",
        "        kind: json",
        "        min_items: 1",
        "      missing_evidence:",
        "        kind: json",
        "        min_items: 0",
        "      residual_blind_spots:",
        "        kind: json",
        "        min_items: 0",
        "      precedent_query_summary:",
        "        kind: text",
        "        min_words: 3",
        "        min_length: 18",
        "      precedent_consult_status:",
        "        kind: json",
        "        required_fields: [status]",
        "        field_contracts:",
        "          status:",
        "            kind: enum",
        "            values: [consulted, no_match, not_required]",
        "  review_findings:",
        "    kind: json",
        "    min_items: 0",
        "  merge_decision:",
        "    kind: enum",
        "    values: [ready, needs_changes, blocked]",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-review-ensemble-1";
    const loadTool = createSkillLoadTool({ runtime });

    await loadTool.execute(
      "tc-load-review-ensemble",
      { name: "review-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const activationTimestamp =
      runtime.events.queryStructured(sessionId, { type: "skill_activated" }).at(-1)?.timestamp ??
      100;

    const reviewRuns: DelegationRunRecord[] = [
      {
        runId: "lane-correctness",
        delegate: "review-correctness",
        agentSpec: "review-correctness",
        parentSessionId: sessionId,
        status: "completed",
        createdAt: activationTimestamp + 1,
        updatedAt: activationTimestamp + 2,
        label: "review-correctness",
        parentSkill: "review-contract",
        kind: "review",
        summary: "Correctness lane cleared.",
        resultData: {
          kind: "review",
          lane: "review-correctness",
          disposition: "clear",
          primaryClaim: "Correctness lane cleared the change.",
        },
      },
      {
        runId: "lane-boundaries",
        delegate: "review-boundaries",
        agentSpec: "review-boundaries",
        parentSessionId: sessionId,
        status: "completed",
        createdAt: activationTimestamp + 3,
        updatedAt: activationTimestamp + 4,
        label: "review-boundaries",
        parentSkill: "review-contract",
        kind: "review",
        summary: "Boundary lane cleared.",
        resultData: {
          kind: "review",
          lane: "review-boundaries",
          disposition: "clear",
          primaryClaim: "Boundary lane cleared the change.",
        },
      },
      {
        runId: "lane-operability",
        delegate: "review-operability",
        agentSpec: "review-operability",
        parentSessionId: sessionId,
        status: "completed",
        createdAt: activationTimestamp + 5,
        updatedAt: activationTimestamp + 6,
        label: "review-operability",
        parentSkill: "review-contract",
        kind: "review",
        summary: "Operability lane cleared.",
        resultData: {
          kind: "review",
          lane: "review-operability",
          disposition: "clear",
          primaryClaim: "Operability lane cleared the change.",
        },
      },
    ];

    const completeTool = createSkillCompleteTool({
      runtime: Object.assign(runtime, {
        delegation: {
          listRuns() {
            return reviewRuns;
          },
        },
      }),
      verification: { executeCommands: false },
    });

    const result = await completeTool.execute(
      "tc-complete-review-ensemble",
      {
        reviewEnsemble: {
          planningPosture: "trivial",
          precedentQuerySummary:
            "query_intent=precedent_lookup | query=none | source_types=auto | search_mode=solution_only",
          precedentConsultStatus: {
            status: "not_required",
          },
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completed");
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
    expect(runtime.skills.getOutputs(sessionId, "review-contract")).toMatchObject({
      merge_decision: "ready",
      review_findings: [],
      review_report: {
        activated_lanes: ["review-correctness", "review-boundaries", "review-operability"],
        precedent_query_summary:
          "query_intent=precedent_lookup | query=none | source_types=auto | search_mode=solution_only",
        precedent_consult_status: {
          status: "not_required",
        },
      },
    });
  });

  test("rejects manual review outputs when reviewEnsemble synthesis is enabled", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-review-ensemble-reject-"));
    writeSkill(join(workspace, ".brewva/skills/core/review-contract/SKILL.md"), {
      name: "review-contract",
      outputs: ["review_report", "review_findings", "merge_decision"],
      outputContracts: [
        "  review_report:",
        "    kind: json",
        "    min_keys: 7",
        "    required_fields: [summary, activated_lanes, activation_basis, missing_evidence, residual_blind_spots, precedent_query_summary, precedent_consult_status]",
        "  review_findings:",
        "    kind: json",
        "    min_items: 0",
        "  merge_decision:",
        "    kind: enum",
        "    values: [ready, needs_changes, blocked]",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-review-ensemble-2";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime: Object.assign(runtime, {
        delegation: {
          listRuns() {
            return [];
          },
        },
      }),
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-review-ensemble-reject",
      { name: "review-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-review-ensemble-reject",
      {
        outputs: {
          merge_decision: "ready",
        },
        reviewEnsemble: {
          planningPosture: "trivial",
          precedentQuerySummary:
            "query_intent=precedent_lookup | query=none | source_types=auto | search_mode=solution_only",
          precedentConsultStatus: {
            status: "not_required",
          },
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Review ensemble synthesis rejected.");
    expect(text).toContain("manual review outputs");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("review-contract");
  });

  test("derives review classification from consumed impact_map and files_changed when manual classifier input is omitted", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-review-derived-"));
    writeSkill(join(workspace, ".brewva/skills/core/implementation-producer/SKILL.md"), {
      name: "implementation-producer",
      outputs: ["change_set", "files_changed"],
      outputContracts: [
        "  change_set:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  files_changed:",
        "    kind: json",
        "    min_items: 1",
      ],
    });
    writeSkill(join(workspace, ".brewva/skills/core/review-contract/SKILL.md"), {
      name: "review-contract",
      outputs: ["review_report", "review_findings", "merge_decision"],
      outputContracts: [
        "  review_report:",
        "    kind: json",
        "    min_keys: 7",
        "    required_fields: [summary, activated_lanes, activation_basis, missing_evidence, residual_blind_spots, precedent_query_summary, precedent_consult_status]",
        "  review_findings:",
        "    kind: json",
        "    min_items: 0",
        "  merge_decision:",
        "    kind: enum",
        "    values: [ready, needs_changes, blocked]",
      ],
      consumes: ["impact_map", "files_changed", "planning_posture"],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-review-derived-1";
    const loadTool = createSkillLoadTool({ runtime });

    runtime.skills.activate(sessionId, "repository-analysis");
    runtime.skills.complete(sessionId, {
      repository_snapshot: "runtime modules and public surfaces around event pipeline coordination",
      impact_map: buildImpactMap({
        summary: "Runtime coordination changes touch persisted protocol surfaces.",
        changedFileClasses: ["runtime_coordination", "persisted_format"],
        changeCategories: ["public_api", "persisted_format"],
      }),
      planning_posture: "complex",
      unknowns: ["No blocking repository-analysis unknowns remain for review classification."],
    });

    runtime.skills.activate(sessionId, "implementation-producer");
    runtime.skills.complete(sessionId, {
      change_set:
        "Updated runtime coordination around the event pipeline and persisted review disclosure records.",
      files_changed: [
        "packages/brewva-runtime/src/services/event-pipeline.ts",
        "packages/brewva-runtime/src/contracts/review.ts",
      ],
    });

    await loadTool.execute(
      "tc-load-review-derived",
      { name: "review-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const activationTimestamp = Date.now();
    const reviewRuns: DelegationRunRecord[] = [
      {
        runId: "lane-correctness-derived",
        delegate: "review-correctness",
        agentSpec: "review-correctness",
        parentSessionId: sessionId,
        status: "completed",
        createdAt: activationTimestamp + 1,
        updatedAt: activationTimestamp + 2,
        label: "review-correctness",
        parentSkill: "review-contract",
        kind: "review",
        summary: "Correctness lane cleared.",
        resultData: {
          kind: "review",
          lane: "review-correctness",
          disposition: "clear",
          primaryClaim: "Correctness lane cleared the change.",
        },
      },
      {
        runId: "lane-boundaries-derived",
        delegate: "review-boundaries",
        agentSpec: "review-boundaries",
        parentSessionId: sessionId,
        status: "completed",
        createdAt: activationTimestamp + 3,
        updatedAt: activationTimestamp + 4,
        label: "review-boundaries",
        parentSkill: "review-contract",
        kind: "review",
        summary: "Boundary lane cleared.",
        resultData: {
          kind: "review",
          lane: "review-boundaries",
          disposition: "clear",
          primaryClaim: "Boundary lane cleared the change.",
        },
      },
      {
        runId: "lane-operability-derived",
        delegate: "review-operability",
        agentSpec: "review-operability",
        parentSessionId: sessionId,
        status: "completed",
        createdAt: activationTimestamp + 5,
        updatedAt: activationTimestamp + 6,
        label: "review-operability",
        parentSkill: "review-contract",
        kind: "review",
        summary: "Operability lane cleared.",
        resultData: {
          kind: "review",
          lane: "review-operability",
          disposition: "clear",
          primaryClaim: "Operability lane cleared the change.",
        },
      },
      {
        runId: "lane-compatibility-derived",
        delegate: "review-compatibility",
        agentSpec: "review-compatibility",
        parentSessionId: sessionId,
        status: "completed",
        createdAt: activationTimestamp + 7,
        updatedAt: activationTimestamp + 8,
        label: "review-compatibility",
        parentSkill: "review-contract",
        kind: "review",
        summary: "Compatibility lane cleared.",
        resultData: {
          kind: "review",
          lane: "review-compatibility",
          disposition: "clear",
          primaryClaim: "Compatibility lane cleared the change.",
        },
      },
    ];

    const completeTool = createSkillCompleteTool({
      runtime: Object.assign(runtime, {
        delegation: {
          listRuns() {
            return reviewRuns;
          },
        },
      }),
      verification: { executeCommands: false },
    });

    const result = await completeTool.execute(
      "tc-complete-review-derived",
      {
        reviewEnsemble: {
          precedentQuerySummary:
            "query_intent=precedent_lookup | query=review disclosure | source_types=auto | search_mode=solution_only",
          precedentConsultStatus: {
            status: "consulted",
            precedentRefs: ["docs/solutions/workflow/review-disclosure.md"],
          },
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completed");
    expect(runtime.skills.getOutputs(sessionId, "review-contract")).toMatchObject({
      merge_decision: "ready",
      review_report: {
        activated_lanes: [
          "review-correctness",
          "review-boundaries",
          "review-operability",
          "review-compatibility",
        ],
        activation_basis: expect.arrayContaining([
          expect.stringContaining("canonical change categories"),
          expect.stringContaining("review-compatibility"),
        ]),
      },
    });
  });

  test("rejects placeholder outputs for built-in implementation artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-implementation-"));
    writeSkill(join(workspace, ".brewva/skills/core/implementation-contract/SKILL.md"), {
      name: "implementation-contract",
      outputs: ["change_set", "files_changed", "verification_evidence"],
      outputContracts: [
        "  change_set:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  files_changed:",
        "    kind: json",
        "    min_items: 1",
        "  verification_evidence:",
        "    kind: json",
        "    min_items: 1",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-implementation-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-implementation",
      { name: "implementation-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-implementation",
      {
        outputs: {
          change_set: "test",
          files_changed: [],
          verification_evidence: "todo",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("Missing required outputs: files_changed");
    expect(text).toContain("Invalid required outputs: change_set, verification_evidence");
    expect(runtime.skills.getActive(sessionId)?.name).toBe("implementation-contract");
  });

  test("accepts verified implementation artifacts and clears the active skill", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-implementation-valid-"));
    writeSkill(join(workspace, ".brewva/skills/core/implementation-contract/SKILL.md"), {
      name: "implementation-contract",
      outputs: ["change_set", "files_changed", "verification_evidence"],
      outputContracts: [
        "  change_set:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  files_changed:",
        "    kind: json",
        "    min_items: 1",
        "  verification_evidence:",
        "    kind: json",
        "    min_items: 1",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-implementation-2";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-implementation-valid",
      { name: "implementation-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    runtime.tools.markCall(sessionId, "edit");
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "PASS 3 tests",
      channelSuccess: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      channelSuccess: true,
    });

    const result = await completeTool.execute(
      "tc-complete-implementation-valid",
      {
        outputs: {
          change_set:
            "Implemented the contract-preserving fix and tightened the surrounding regression coverage.",
          files_changed: ["src/example.ts"],
          verification_evidence: ["PASS 3 tests", "No diagnostics found"],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completed");
    expect(runtime.skills.getActive(sessionId)).toBeUndefined();
    expect(runtime.skills.getOutputs(sessionId, "implementation-contract")).toEqual(
      expect.objectContaining({
        change_set:
          "Implemented the contract-preserving fix and tightened the surrounding regression coverage.",
        files_changed: ["src/example.ts"],
        verification_evidence: ["PASS 3 tests", "No diagnostics found"],
      }),
    );
  });
});
