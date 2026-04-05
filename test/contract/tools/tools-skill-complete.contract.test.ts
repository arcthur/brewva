import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  type DelegationRunRecord,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
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
      "selection:",
      "  when_to_use: Use when the task needs the routed test skill.",
      "  examples: [test skill]",
      "  phases: [align]",
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

function createIsolatedRuntime(name: string): BrewvaRuntime {
  const workspace = mkdtempSync(join(tmpdir(), `brewva-skill-complete-runtime-${name}-`));
  return new BrewvaRuntime({ cwd: workspace });
}

function buildImpactMap(input: {
  summary: string;
  changedFileClasses?: string[];
  changeCategories?: string[];
}) {
  return {
    summary: input.summary,
    affected_paths: ["packages/brewva-runtime/src/services/event-pipeline.ts"],
    boundaries: ["runtime.authority.events"],
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
    expect(runtime.inspect.skills.getActive(sessionId)).toBeUndefined();
  });

  test("rejects placeholder outputs for built-in design artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-design-"));
    writeSkill(join(workspace, ".brewva/skills/core/design-contract/SKILL.md"), {
      name: "design-contract",
      outputs: [
        "design_spec",
        "execution_plan",
        "execution_mode_hint",
        "risk_register",
        "implementation_targets",
      ],
      outputContracts: [
        "  design_spec:",
        "    kind: text",
        "    min_words: 4",
        "    min_length: 24",
        "  execution_plan:",
        "    kind: json",
        "    min_items: 2",
        "    item_contract:",
        "      kind: json",
        "      required_fields: [step, intent, owner, exit_criteria, verification_intent]",
        "  execution_mode_hint:",
        "    kind: enum",
        "    values: [direct_patch, test_first, coordinated_rollout]",
        "  risk_register:",
        "    kind: json",
        "    min_items: 1",
        "    item_contract:",
        "      kind: json",
        "      required_fields: [risk, category, severity, mitigation, required_evidence, owner_lane]",
        "  implementation_targets:",
        "    kind: json",
        "    min_items: 1",
        "    item_contract:",
        "      kind: json",
        "      required_fields: [target, kind, owner_boundary, reason]",
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
          implementation_targets: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("Missing required outputs: risk_register, implementation_targets");
    expect(text).toContain("Invalid required outputs:");
    expect(text).toContain("design_spec");
    expect(text).toContain("execution_plan");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("design-contract");
  });

  test("accepts informative built-in design artifacts", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-design-valid-"));
    writeSkill(join(workspace, ".brewva/skills/core/design-contract/SKILL.md"), {
      name: "design-contract",
      outputs: [
        "design_spec",
        "execution_plan",
        "execution_mode_hint",
        "risk_register",
        "implementation_targets",
      ],
      outputContracts: [
        "  design_spec:",
        "    kind: text",
        "    min_words: 4",
        "    min_length: 24",
        "  execution_plan:",
        "    kind: json",
        "    min_items: 2",
        "    item_contract:",
        "      kind: json",
        "      required_fields: [step, intent, owner, exit_criteria, verification_intent]",
        "  execution_mode_hint:",
        "    kind: enum",
        "    values: [direct_patch, test_first, coordinated_rollout]",
        "  risk_register:",
        "    kind: json",
        "    min_items: 1",
        "    item_contract:",
        "      kind: json",
        "      required_fields: [risk, category, severity, mitigation, required_evidence, owner_lane]",
        "  implementation_targets:",
        "    kind: json",
        "    min_items: 1",
        "    item_contract:",
        "      kind: json",
        "      required_fields: [target, kind, owner_boundary, reason]",
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
            {
              step: "Promote repository_snapshot and impact_map to required design inputs.",
              intent: "Ground design in current repository state before planning.",
              owner: "skill.design",
              exit_criteria:
                "Design uses repository evidence before choosing the implementation path.",
              verification_intent:
                "Contract tests prove design consumes the planning inputs explicitly.",
            },
            {
              step: "Tighten output validation so placeholder artifacts cannot complete the skill.",
              intent: "Make design outputs machine-checkable instead of prose-only.",
              owner: "runtime.authority.skills",
              exit_criteria: "Placeholder design artifacts fail completion validation.",
              verification_intent: "Skill completion tests reject weak design outputs.",
            },
          ],
          execution_mode_hint: "direct_patch",
          risk_register: [
            {
              risk: "Guard resets could still be triggered by non-epistemic control actions.",
              category: "public_api",
              severity: "medium",
              mitigation:
                "Classify lifecycle inspection as neutral and only clear on real strategy shifts.",
              required_evidence: ["design_contract_tests"],
              owner_lane: "review-boundaries",
            },
          ],
          implementation_targets: [
            {
              target: "packages/brewva-runtime/src/services/skill-lifecycle.ts",
              kind: "module",
              owner_boundary: "runtime.authority.skills",
              reason: "Skill output validation is enforced here.",
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
    expect(runtime.inspect.skills.getActive(sessionId)).toBeUndefined();
  });

  test("rejects non-canonical planning taxonomy even when a custom skill contract is looser", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-planning-taxonomy-"));
    writeSkill(join(workspace, ".brewva/skills/core/planning-loose/SKILL.md"), {
      name: "planning-loose",
      outputs: [
        "design_spec",
        "execution_plan",
        "execution_mode_hint",
        "risk_register",
        "implementation_targets",
      ],
      outputContracts: [
        "  design_spec:",
        "    kind: text",
        "    min_words: 4",
        "    min_length: 24",
        "  execution_plan:",
        "    kind: json",
        "    min_items: 1",
        "    item_contract:",
        "      kind: json",
        "      required_fields: [step, intent, owner, exit_criteria, verification_intent]",
        "  execution_mode_hint:",
        "    kind: text",
        "    min_words: 1",
        "    min_length: 8",
        "  risk_register:",
        "    kind: json",
        "    min_items: 1",
        "    item_contract:",
        "      kind: json",
        "      required_fields: [risk, category, severity, mitigation, required_evidence, owner_lane]",
        "  implementation_targets:",
        "    kind: json",
        "    min_items: 1",
        "    item_contract:",
        "      kind: json",
        "      required_fields: [target, kind, owner_boundary, reason]",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-planning-taxonomy";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-planning-taxonomy",
      { name: "planning-loose" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-planning-taxonomy",
      {
        outputs: {
          design_spec:
            "Keep planning taxonomy canonical even when a custom skill contract is only structurally typed.",
          execution_plan: [
            {
              step: "Complete a planning skill with loose local schema checks.",
              intent: "Exercise runtime semantic validation instead of per-skill enum contracts.",
              owner: "runtime.authority.skills",
              exit_criteria: "Non-canonical planning taxonomy is rejected at completion time.",
              verification_intent: "Skill completion reports risk_register as invalid.",
            },
          ],
          execution_mode_hint: "coordinated_rollout",
          risk_register: [
            {
              risk: "A custom skill could otherwise invent review taxonomy that downstream lanes do not understand.",
              category: "not_a_real_category",
              severity: "high",
              mitigation: "Reject invalid planning taxonomy in the shared runtime contract.",
              required_evidence: ["planning_taxonomy_contract_tests"],
              owner_lane: "review-ghost",
            },
          ],
          implementation_targets: [
            {
              target: "packages/brewva-runtime/src/contracts/planning.ts",
              kind: "module",
              owner_boundary: "runtime.contracts",
              reason: "Shared planning contract validation lives here.",
            },
          ],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("risk_register");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("planning-loose");
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
  - runtime.maintain.recovery
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
          boundary: "runtime.maintain.recovery",
          tags: ["wal"],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completed");
    expect(runtime.inspect.skills.getActive(sessionId)).toBeUndefined();
    expect(
      runtime.inspect.skills.getOutputs(sessionId, "learning-research-contract"),
    ).toMatchObject({
      precedent_consult_status: "matched",
      precedent_refs: ["docs/solutions/runtime-errors/wal-recovery-race.md"],
    });
    expect(
      runtime.inspect.skills.getOutputs(sessionId, "learning-research-contract")
        ?.precedent_query_summary,
    ).toContain("search_mode=solution_then_bootstrap");
    expect(
      runtime.inspect.skills.getOutputs(sessionId, "learning-research-contract")?.preventive_checks,
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
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("learning-research-contract");
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
    expect(text).toContain("Invalid required outputs:");
    expect(text).toContain("review_report");
    expect(text).toContain("review_findings");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("review-contract");
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
    expect(runtime.inspect.skills.getActive(sessionId)).toBeUndefined();
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
      runtime.inspect.events.queryStructured(sessionId, { type: "skill_activated" }).at(-1)
        ?.timestamp ?? 100;

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
        kind: "consult",
        consultKind: "review",
        summary: "Correctness lane cleared.",
        resultData: {
          kind: "consult",
          consultKind: "review",
          conclusion: "Correctness lane cleared the change.",
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
        kind: "consult",
        consultKind: "review",
        summary: "Boundary lane cleared.",
        resultData: {
          kind: "consult",
          consultKind: "review",
          conclusion: "Boundary lane cleared the change.",
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
        kind: "consult",
        consultKind: "review",
        summary: "Operability lane cleared.",
        resultData: {
          kind: "consult",
          consultKind: "review",
          conclusion: "Operability lane cleared the change.",
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
    expect(runtime.inspect.skills.getActive(sessionId)).toBeUndefined();
    expect(runtime.inspect.skills.getOutputs(sessionId, "review-contract")).toMatchObject({
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

  test("rejects QA pass verdicts that lack an adversarial probe", async () => {
    const runtime = createIsolatedRuntime("qa-no-adversarial");
    const sessionId = "skill-complete-qa-pass-without-adversarial";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-qa-no-adversarial",
      { name: "qa" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-qa-no-adversarial",
      {
        outputs: {
          qa_report: "Executed one executable smoke check, but only on the happy path.",
          qa_findings: [],
          qa_verdict: "pass",
          qa_checks: [
            {
              name: "smoke",
              result: "pass",
              command: "bun test -- smoke",
              exitCode: 0,
              observedOutput: "smoke path passed",
              probeType: "baseline",
            },
          ],
          qa_missing_evidence: [],
          qa_confidence_gaps: [],
          qa_environment_limits: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("qa_verdict");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("qa");
  });

  test("accepts QA pass verdicts backed by executable adversarial evidence", async () => {
    const runtime = createIsolatedRuntime("qa-pass-valid");
    const sessionId = "skill-complete-qa-pass-valid";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-qa-valid",
      { name: "qa" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-qa-valid",
      {
        outputs: {
          qa_report:
            "Executed an adversarial boundary probe and preserved the replayable evidence.",
          qa_findings: [],
          qa_verdict: "pass",
          qa_checks: [
            {
              name: "boundary-input",
              result: "pass",
              command: "bun test -- boundary-input",
              exitCode: 0,
              observedOutput: "boundary-input passed",
              probeType: "boundary",
              artifactRefs: ["artifacts/qa-boundary.txt"],
            },
          ],
          qa_missing_evidence: [],
          qa_confidence_gaps: [],
          qa_environment_limits: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completed");
    expect(runtime.inspect.skills.getActive(sessionId)).toBeUndefined();
  });

  test("rejects QA checks that omit command exitCode evidence", async () => {
    const runtime = createIsolatedRuntime("qa-missing-exit-code");
    const sessionId = "skill-complete-qa-missing-exit-code";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-qa-missing-exit-code",
      { name: "qa" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-qa-missing-exit-code",
      {
        outputs: {
          qa_report: "Ran the boundary check but failed to preserve complete command evidence.",
          qa_findings: [],
          qa_verdict: "pass",
          qa_checks: [
            {
              name: "boundary-input",
              result: "pass",
              command: "bun test -- boundary-input",
              observedOutput: "boundary-input passed",
              probeType: "boundary",
            },
          ],
          qa_missing_evidence: [],
          qa_confidence_gaps: [],
          qa_environment_limits: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("qa_checks[0]");
    expect(text).toContain("exitCode");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("qa");
  });

  test("rejects QA checks that omit both command and tool descriptors", async () => {
    const runtime = createIsolatedRuntime("qa-missing-descriptor");
    const sessionId = "skill-complete-qa-missing-descriptor";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-qa-missing-descriptor",
      { name: "qa" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-qa-missing-descriptor",
      {
        outputs: {
          qa_report: "Recorded a boundary probe, but failed to preserve how it was executed.",
          qa_findings: [],
          qa_verdict: "inconclusive",
          qa_checks: [
            {
              name: "boundary-input",
              result: "inconclusive",
              observedOutput: "Boundary harness state was inspected manually.",
              probeType: "boundary",
            },
          ],
          qa_missing_evidence: ["No executable or tool-backed descriptor was preserved."],
          qa_confidence_gaps: [],
          qa_environment_limits: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("qa_checks[0]");
    expect(text).toContain("command or tool descriptor");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("qa");
  });

  test("rejects QA checks that omit observed evidence", async () => {
    const runtime = createIsolatedRuntime("qa-missing-observed");
    const sessionId = "skill-complete-qa-missing-observed-evidence";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-qa-missing-observed-evidence",
      { name: "qa" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-qa-missing-observed-evidence",
      {
        outputs: {
          qa_report:
            "Executed the boundary probe, but did not preserve the actual observed evidence.",
          qa_findings: [],
          qa_verdict: "inconclusive",
          qa_checks: [
            {
              name: "boundary-input",
              result: "inconclusive",
              command: "bun test -- boundary-input",
              exitCode: 0,
              probeType: "boundary",
            },
          ],
          qa_missing_evidence: ["No observed output excerpt was preserved."],
          qa_confidence_gaps: [],
          qa_environment_limits: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("qa_checks[0]");
    expect(text).toContain("observedOutput");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("qa");
  });

  test("rejects QA fail verdicts without an evidence-backed failed check", async () => {
    const runtime = createIsolatedRuntime("qa-fail-without-evidence");
    const sessionId = "skill-complete-qa-fail-without-evidence";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    await loadTool.execute(
      "tc-load-qa-fail-without-evidence",
      { name: "qa" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-qa-fail-without-evidence",
      {
        outputs: {
          qa_report: "Recorded a failed check, but the actual evidence trail is incomplete.",
          qa_findings: ["The flow still appears broken, but the evidence packet is incomplete."],
          qa_verdict: "fail",
          qa_checks: [
            {
              name: "broken-flow",
              result: "fail",
              command: "bun test -- broken-flow",
              probeType: "adversarial",
            },
          ],
          qa_missing_evidence: [],
          qa_confidence_gaps: [],
          qa_environment_limits: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("qa_checks[0]");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("qa");
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
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("review-contract");
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

    runtime.authority.skills.activate(sessionId, "repository-analysis");
    runtime.authority.skills.complete(sessionId, {
      repository_snapshot: "runtime modules and public surfaces around event pipeline coordination",
      impact_map: buildImpactMap({
        summary: "Runtime coordination changes touch persisted protocol surfaces.",
        changedFileClasses: ["runtime_coordination", "persisted_format"],
        changeCategories: ["public_api", "persisted_format"],
      }),
      planning_posture: "complex",
      unknowns: ["No blocking repository-analysis unknowns remain for review classification."],
    });

    runtime.authority.skills.activate(sessionId, "implementation-producer");
    runtime.authority.skills.complete(sessionId, {
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
        kind: "consult",
        consultKind: "review",
        summary: "Correctness lane cleared.",
        resultData: {
          kind: "consult",
          consultKind: "review",
          conclusion: "Correctness lane cleared the change.",
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
        kind: "consult",
        consultKind: "review",
        summary: "Boundary lane cleared.",
        resultData: {
          kind: "consult",
          consultKind: "review",
          conclusion: "Boundary lane cleared the change.",
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
        kind: "consult",
        consultKind: "review",
        summary: "Operability lane cleared.",
        resultData: {
          kind: "consult",
          consultKind: "review",
          conclusion: "Operability lane cleared the change.",
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
        kind: "consult",
        consultKind: "review",
        summary: "Compatibility lane cleared.",
        resultData: {
          kind: "consult",
          consultKind: "review",
          conclusion: "Compatibility lane cleared the change.",
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
    expect(runtime.inspect.skills.getOutputs(sessionId, "review-contract")).toMatchObject({
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

  test("rejects ready review outputs when high-risk planning evidence is missing", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-review-missing-plan-"));
    writeSkill(join(workspace, ".brewva/skills/core/planning-context/SKILL.md"), {
      name: "planning-context",
      outputs: ["planning_posture"],
      outputContracts: [
        "  planning_posture:",
        "    kind: enum",
        "    values: [trivial, moderate, complex, high_risk]",
      ],
    });
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-review-missing-plan-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    runtime.authority.skills.activate(sessionId, "planning-context");
    runtime.authority.skills.complete(sessionId, {
      planning_posture: "high_risk",
    });

    await loadTool.execute(
      "tc-load-review-missing-plan",
      { name: "review" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-review-missing-plan",
      {
        outputs: {
          review_report: {
            summary: "Review claims the change is ready despite missing planning evidence.",
            activated_lanes: ["review-correctness", "review-boundaries", "review-operability"],
            activation_basis: ["High-risk planning posture widened the review surface."],
            missing_evidence: [],
            residual_blind_spots: [],
            precedent_query_summary:
              "query_intent=precedent_lookup | query=planning evidence | source_types=auto | search_mode=solution_only",
            precedent_consult_status: {
              status: "not_required",
            },
          },
          review_findings: [],
          merge_decision: "ready",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("review_report");
    expect(text).toContain("merge_decision");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("review");
  });

  test("synthesizes blocked review output when runtime verification evidence is stale", async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), "brewva-skill-complete-review-stale-verification-"),
    );
    writeSkill(join(workspace, ".brewva/skills/core/planning-context/SKILL.md"), {
      name: "planning-context",
      outputs: ["impact_map", "planning_posture"],
      outputContracts: [
        "  impact_map:",
        "    kind: json",
        "    min_keys: 1",
        "  planning_posture:",
        "    kind: enum",
        "    values: [trivial, moderate, complex, high_risk]",
      ],
    });
    writeSkill(join(workspace, ".brewva/skills/core/plan-artifacts/SKILL.md"), {
      name: "plan-artifacts",
      outputs: [
        "design_spec",
        "execution_plan",
        "execution_mode_hint",
        "risk_register",
        "implementation_targets",
      ],
      outputContracts: [
        "  design_spec:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  execution_plan:",
        "    kind: json",
        "    min_items: 1",
        "  execution_mode_hint:",
        "    kind: enum",
        "    values: [direct_patch, test_first, coordinated_rollout]",
        "  risk_register:",
        "    kind: json",
        "    min_items: 1",
        "  implementation_targets:",
        "    kind: json",
        "    min_items: 1",
      ],
    });
    writeSkill(join(workspace, ".brewva/skills/core/implementation-producer/SKILL.md"), {
      name: "implementation-producer",
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
      consumes: [
        "impact_map",
        "planning_posture",
        "design_spec",
        "execution_plan",
        "risk_register",
        "implementation_targets",
        "change_set",
        "files_changed",
        "verification_evidence",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-review-stale-verification";
    const loadTool = createSkillLoadTool({ runtime });

    runtime.authority.skills.activate(sessionId, "planning-context");
    runtime.authority.skills.complete(sessionId, {
      impact_map: buildImpactMap({
        summary: "Review should widen when verification evidence goes stale.",
        changedFileClasses: ["runtime_coordination"],
        changeCategories: ["public_api"],
      }),
      planning_posture: "moderate",
    });

    runtime.authority.skills.activate(sessionId, "plan-artifacts");
    runtime.authority.skills.complete(sessionId, {
      design_spec: "Keep review anchored to the current canonical design.",
      execution_plan: [
        {
          step: "Preserve the design contract before review.",
          intent: "Keep planning evidence complete for the review window.",
          owner: "runtime.review",
          exit_criteria: "Review can consume the bounded design inputs directly.",
          verification_intent: "The review run sees canonical design outputs.",
        },
        {
          step: "Expose stale verification evidence as a blocking review gap.",
          intent: "Do not allow merge readiness on stale executable evidence.",
          owner: "runtime.review",
          exit_criteria:
            "Review reports stale verification evidence instead of silently proceeding.",
          verification_intent: "Review synthesis blocks when verification evidence is stale.",
        },
      ],
      execution_mode_hint: "direct_patch",
      risk_register: [
        {
          risk: "Review could claim readiness after the verification evidence became stale.",
          category: "public_api",
          severity: "high",
          mitigation: "Block review readiness when verification evidence is stale.",
          required_evidence: ["runtime_verification_freshness"],
          owner_lane: "review-operability",
        },
      ],
      implementation_targets: [
        {
          target: "packages/brewva-runtime/src/services/skill-lifecycle.ts",
          kind: "module",
          owner_boundary: "runtime.review",
          reason: "The review scope is bounded to the runtime validation path.",
        },
      ],
    });

    runtime.authority.skills.activate(sessionId, "implementation-producer");
    runtime.authority.skills.complete(sessionId, {
      change_set:
        "Updated the runtime validation path and preserved executable verification evidence.",
      files_changed: ["packages/brewva-runtime/src/services/skill-lifecycle.ts"],
      verification_evidence: ["runtime_verification_freshness passed before the next mutation"],
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 100,
      payload: {
        outcome: "pass",
        level: "standard",
        activeSkill: "implementation",
        evidenceFreshness: "fresh",
        commandsExecuted: ["runtime_verification_freshness"],
        failedChecks: [],
        checkResults: [
          {
            name: "runtime_verification_freshness",
            status: "pass",
            evidence: "runtime_verification_freshness passed",
          },
        ],
      },
    });
    const laterWriteTimestamp = Date.now() + 1_000;
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "verification_write_marked",
      timestamp: laterWriteTimestamp,
      payload: {
        toolName: "edit",
      },
    });

    await loadTool.execute(
      "tc-load-review-stale-verification",
      { name: "review-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const allReviewLanes = [
      "review-correctness",
      "review-boundaries",
      "review-operability",
      "review-security",
      "review-concurrency",
      "review-compatibility",
      "review-performance",
    ] as const;
    const activationTimestamp = Date.now();
    const reviewRuns: DelegationRunRecord[] = allReviewLanes.map((lane, index) => ({
      runId: `${lane}-stale-verification`,
      delegate: lane,
      agentSpec: lane,
      parentSessionId: sessionId,
      status: "completed",
      createdAt: activationTimestamp + index * 2,
      updatedAt: activationTimestamp + index * 2 + 1,
      label: lane,
      parentSkill: "review-contract",
      kind: "consult",
      consultKind: "review",
      summary: `${lane} cleared the change.`,
      resultData: {
        kind: "consult",
        consultKind: "review",
        conclusion: `${lane} cleared the current scope.`,
        lane,
        disposition: "clear",
        primaryClaim: `${lane} cleared the current scope.`,
      },
    }));
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
      "tc-complete-review-stale-verification",
      {
        reviewEnsemble: {
          precedentQuerySummary:
            "query_intent=precedent_lookup | query=stale verification evidence | source_types=auto | search_mode=solution_only",
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
    expect(runtime.inspect.skills.getOutputs(sessionId, "review-contract")).toMatchObject({
      merge_decision: "blocked",
      review_report: expect.objectContaining({
        missing_evidence: expect.arrayContaining(["verification_evidence:stale"]),
      }),
    });
  });

  test("rejects manual review outputs when runtime verification evidence is stale even with complete planning evidence", async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), "brewva-skill-complete-review-manual-stale-verification-"),
    );
    writeSkill(join(workspace, ".brewva/skills/core/planning-context/SKILL.md"), {
      name: "planning-context",
      outputs: ["impact_map", "planning_posture"],
      outputContracts: [
        "  impact_map:",
        "    kind: json",
        "    min_keys: 1",
        "  planning_posture:",
        "    kind: enum",
        "    values: [trivial, moderate, complex, high_risk]",
      ],
    });
    writeSkill(join(workspace, ".brewva/skills/core/plan-artifacts/SKILL.md"), {
      name: "plan-artifacts",
      outputs: [
        "design_spec",
        "execution_plan",
        "execution_mode_hint",
        "risk_register",
        "implementation_targets",
      ],
      outputContracts: [
        "  design_spec:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  execution_plan:",
        "    kind: json",
        "    min_items: 1",
        "  execution_mode_hint:",
        "    kind: enum",
        "    values: [direct_patch, test_first, coordinated_rollout]",
        "  risk_register:",
        "    kind: json",
        "    min_items: 1",
        "  implementation_targets:",
        "    kind: json",
        "    min_items: 1",
      ],
    });
    writeSkill(join(workspace, ".brewva/skills/core/implementation-producer/SKILL.md"), {
      name: "implementation-producer",
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
      consumes: [
        "impact_map",
        "planning_posture",
        "design_spec",
        "execution_plan",
        "risk_register",
        "implementation_targets",
        "change_set",
        "files_changed",
        "verification_evidence",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-review-manual-stale-verification";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    runtime.authority.skills.activate(sessionId, "planning-context");
    runtime.authority.skills.complete(sessionId, {
      impact_map: buildImpactMap({
        summary: "Manual review outputs must not ignore stale executable evidence.",
        changedFileClasses: ["runtime_coordination"],
        changeCategories: ["public_api"],
      }),
      planning_posture: "moderate",
    });

    runtime.authority.skills.activate(sessionId, "plan-artifacts");
    runtime.authority.skills.complete(sessionId, {
      design_spec: "Keep review readiness tied to current planning and executable evidence.",
      execution_plan: [
        {
          step: "Preserve a complete planning handoff for review.",
          intent: "Keep planning evidence available when the manual review output is validated.",
          owner: "runtime.review",
          exit_criteria: "Review can consume canonical planning artifacts without guessing.",
          verification_intent: "The review validator sees the full planning handoff.",
        },
      ],
      execution_mode_hint: "direct_patch",
      risk_register: [
        {
          risk: "Manual review output could claim readiness after executable verification went stale.",
          category: "public_api",
          severity: "high",
          mitigation: "Reject review readiness when runtime verification is stale.",
          required_evidence: ["runtime_verification_freshness"],
          owner_lane: "review-operability",
        },
      ],
      implementation_targets: [
        {
          target: "packages/brewva-runtime/src/services/skill-lifecycle.ts",
          kind: "module",
          owner_boundary: "runtime.review",
          reason: "Review validation stays scoped to the lifecycle contract.",
        },
      ],
    });

    runtime.authority.skills.activate(sessionId, "implementation-producer");
    runtime.authority.skills.complete(sessionId, {
      change_set: "Updated review validation and preserved runtime verification evidence.",
      files_changed: ["packages/brewva-runtime/src/services/skill-lifecycle.ts"],
      verification_evidence: ["runtime_verification_freshness passed before the next mutation"],
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 100,
      payload: {
        outcome: "pass",
        level: "standard",
        activeSkill: "implementation",
        evidenceFreshness: "fresh",
        commandsExecuted: ["runtime_verification_freshness"],
        failedChecks: [],
        checkResults: [
          {
            name: "runtime_verification_freshness",
            status: "pass",
            evidence: "runtime_verification_freshness passed",
          },
        ],
      },
    });
    const laterWriteTimestamp = Date.now() + 1_000;
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "verification_write_marked",
      timestamp: laterWriteTimestamp,
      payload: {
        toolName: "edit",
      },
    });

    await loadTool.execute(
      "tc-load-review-manual-stale-verification",
      { name: "review-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-review-manual-stale-verification",
      {
        outputs: {
          review_report: {
            summary:
              "The manual review incorrectly claims readiness after verification became stale.",
            activated_lanes: ["review-correctness", "review-boundaries", "review-operability"],
            activation_basis: ["Planning evidence stayed complete through the review window."],
            missing_evidence: [],
            residual_blind_spots: [],
            precedent_query_summary:
              "query_intent=precedent_lookup | query=manual stale verification review | source_types=auto | search_mode=solution_only",
            precedent_consult_status: {
              status: "not_required",
            },
          },
          review_findings: [],
          merge_decision: "ready",
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("review_report");
    expect(text).toContain("merge_decision");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("review-contract");
  });

  test("synthesizes blocked review output when planning evidence is stale after a later write", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-skill-complete-review-stale-plan-"));
    writeSkill(join(workspace, ".brewva/skills/core/planning-context/SKILL.md"), {
      name: "planning-context",
      outputs: ["impact_map", "planning_posture"],
      outputContracts: [
        "  impact_map:",
        "    kind: json",
        "    min_keys: 1",
        "  planning_posture:",
        "    kind: enum",
        "    values: [trivial, moderate, complex, high_risk]",
      ],
    });
    writeSkill(join(workspace, ".brewva/skills/core/plan-artifacts/SKILL.md"), {
      name: "plan-artifacts",
      outputs: [
        "design_spec",
        "execution_plan",
        "execution_mode_hint",
        "risk_register",
        "implementation_targets",
      ],
      outputContracts: [
        "  design_spec:",
        "    kind: text",
        "    min_words: 3",
        "    min_length: 18",
        "  execution_plan:",
        "    kind: json",
        "    min_items: 1",
        "  execution_mode_hint:",
        "    kind: enum",
        "    values: [direct_patch, test_first, coordinated_rollout]",
        "  risk_register:",
        "    kind: json",
        "    min_items: 1",
        "  implementation_targets:",
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
      consumes: [
        "impact_map",
        "planning_posture",
        "design_spec",
        "execution_plan",
        "risk_register",
        "implementation_targets",
      ],
    });

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-review-stale-plan";
    const loadTool = createSkillLoadTool({ runtime });

    runtime.authority.skills.activate(sessionId, "planning-context");
    runtime.authority.skills.complete(sessionId, {
      impact_map: buildImpactMap({
        summary: "Review should disclose stale planning evidence after later writes.",
        changedFileClasses: ["runtime_coordination"],
        changeCategories: ["public_api"],
      }),
      planning_posture: "moderate",
    });

    runtime.authority.skills.activate(sessionId, "plan-artifacts");
    runtime.authority.skills.complete(sessionId, {
      design_spec: "Tie review synthesis to the latest canonical planning handoff.",
      execution_plan: [
        {
          step: "Keep planning evidence current for downstream review.",
          intent: "Expose stale plan artifacts instead of silently reusing them.",
          owner: "runtime.review",
          exit_criteria: "Review synthesis marks planning artifacts stale after later writes.",
          verification_intent: "Review missing_evidence records stale planning keys explicitly.",
        },
      ],
      execution_mode_hint: "direct_patch",
      risk_register: [
        {
          risk: "Review synthesis could reuse planning artifacts after a later workspace write.",
          category: "public_api",
          severity: "high",
          mitigation: "Treat planning evidence as stale once the workspace changes later.",
          required_evidence: ["stale_planning_review"],
          owner_lane: "review-boundaries",
        },
      ],
      implementation_targets: [
        {
          target: "packages/brewva-runtime/src/services/skill-lifecycle.ts",
          kind: "module",
          owner_boundary: "runtime.review",
          reason: "Review planning freshness is enforced in the runtime lifecycle path.",
        },
      ],
    });

    const laterWriteTimestamp = Date.now() + 1_000;
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "verification_write_marked",
      timestamp: laterWriteTimestamp,
      payload: {
        toolName: "edit",
      },
    });

    await loadTool.execute(
      "tc-load-review-stale-plan",
      { name: "review-contract" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const allReviewLanes = [
      "review-correctness",
      "review-boundaries",
      "review-operability",
      "review-security",
      "review-concurrency",
      "review-compatibility",
      "review-performance",
    ] as const;
    const activationTimestamp = Date.now();
    const reviewRuns: DelegationRunRecord[] = allReviewLanes.map((lane, index) => ({
      runId: `${lane}-stale-plan`,
      delegate: lane,
      agentSpec: lane,
      parentSessionId: sessionId,
      status: "completed",
      createdAt: activationTimestamp + index * 2,
      updatedAt: activationTimestamp + index * 2 + 1,
      label: lane,
      parentSkill: "review-contract",
      kind: "consult",
      consultKind: "review",
      summary: `${lane} cleared the current scope.`,
      resultData: {
        kind: "consult",
        consultKind: "review",
        conclusion: `${lane} cleared the current scope.`,
        lane,
        disposition: "clear",
        primaryClaim: `${lane} cleared the current scope.`,
      },
    }));
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
      "tc-complete-review-stale-plan",
      {
        reviewEnsemble: {
          precedentQuerySummary:
            "query_intent=precedent_lookup | query=stale planning evidence review | source_types=auto | search_mode=solution_only",
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
    expect(runtime.inspect.skills.getOutputs(sessionId, "review-contract")).toMatchObject({
      merge_decision: "blocked",
      review_report: expect.objectContaining({
        missing_evidence: expect.arrayContaining([
          "design_spec:stale",
          "execution_plan:stale",
          "risk_register:stale",
          "implementation_targets:stale",
        ]),
      }),
    });
  });

  test("rejects implementation outputs that exceed implementation_targets", async () => {
    const workspace = mkdtempSync(
      join(tmpdir(), "brewva-skill-complete-implementation-target-scope-"),
    );

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "skill-complete-implementation-target-scope-1";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    runtime.authority.skills.activate(sessionId, "design");
    runtime.authority.skills.complete(sessionId, {
      design_spec: "Keep implementation scoped to the planned module boundary.",
      execution_plan: [
        {
          step: "Apply the bounded lifecycle validator change.",
          intent: "Touch only the planned runtime skill lifecycle module.",
          owner: "runtime.authority.skills",
          exit_criteria: "The implementation stays within the declared implementation targets.",
          verification_intent: "Files changed remain scoped to the declared target.",
        },
        {
          step: "Confirm the scope stays inside the declared target set.",
          intent: "Make implementation scope drift explicit before completion.",
          owner: "runtime.authority.skills",
          exit_criteria: "Completion rejects files_changed entries outside the target boundary.",
          verification_intent: "Implementation scope guard rejects unrelated file paths.",
        },
      ],
      execution_mode_hint: "direct_patch",
      risk_register: [
        {
          risk: "Implementation may silently widen into unrelated gateway code.",
          category: "package_boundary",
          severity: "medium",
          mitigation: "Reject completion when files_changed exceeds implementation_targets.",
          required_evidence: ["implementation_scope_guard"],
          owner_lane: "implementation",
        },
      ],
      implementation_targets: [
        {
          target: "packages/brewva-runtime/src/services/skill-lifecycle.ts",
          kind: "module",
          owner_boundary: "runtime.authority.skills",
          reason: "Only skill lifecycle validation should change.",
        },
      ],
    });

    await loadTool.execute(
      "tc-load-implementation-target-scope",
      { name: "implementation" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-implementation-target-scope",
      {
        outputs: {
          change_set: "Updated the lifecycle validator and also touched an unrelated gateway path.",
          files_changed: [
            "packages/brewva-runtime/src/services/skill-lifecycle.ts",
            "packages/brewva-gateway/src/subagents/structured-outcome.ts",
          ],
          verification_evidence: ["typecheck passed"],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("files_changed");
    expect(text).toContain("implementation_targets");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("implementation");
  });

  test("rejects implementation outputs when implementation_targets are too abstract to enforce files_changed scope", async () => {
    const runtime = createIsolatedRuntime("implementation-abstract-target");
    const sessionId = "skill-complete-implementation-abstract-target";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    runtime.authority.skills.activate(sessionId, "design");
    runtime.authority.skills.complete(sessionId, {
      design_spec: "Keep implementation targets concrete enough for runtime scope enforcement.",
      execution_plan: [
        {
          step: "Declare the intended implementation scope.",
          intent: "Make the implementation boundary explicit before coding starts.",
          owner: "runtime.authority.skills",
          exit_criteria: "Implementation targets can be mapped to concrete changed files.",
          verification_intent: "Scope enforcement can compare targets against files_changed.",
        },
        {
          step: "Reject abstract targets at completion time.",
          intent: "Do not accept targets that cannot prove concrete ownership.",
          owner: "runtime.authority.skills",
          exit_criteria: "Completion rejects non-path implementation targets.",
          verification_intent: "The runtime guard reports implementation_targets as too abstract.",
        },
      ],
      execution_mode_hint: "direct_patch",
      risk_register: [
        {
          risk: "Abstract implementation targets would disable the runtime scope fence silently.",
          category: "package_boundary",
          severity: "medium",
          mitigation:
            "Reject implementation_targets that are not concrete enough to enforce files_changed ownership.",
          required_evidence: ["implementation_target_concreteness"],
          owner_lane: "implementation",
        },
      ],
      implementation_targets: [
        {
          target: "runtime.authority.skills",
          kind: "module",
          owner_boundary: "runtime.authority.skills",
          reason: "This target is intentionally too abstract for the runtime scope guard.",
        },
      ],
    });

    await loadTool.execute(
      "tc-load-implementation-abstract-target",
      { name: "implementation" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-implementation-abstract-target",
      {
        outputs: {
          change_set: "Touched the runtime skill lifecycle path.",
          files_changed: ["packages/brewva-runtime/src/services/skill-lifecycle.ts"],
          verification_evidence: ["implementation_target_concreteness asserted"],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("implementation_targets");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("implementation");
  });

  test("rejects QA pass verdicts that do not cover plan required_evidence", async () => {
    const runtime = createIsolatedRuntime("qa-required-evidence");
    const sessionId = "skill-complete-qa-required-evidence";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    runtime.authority.skills.activate(sessionId, "design");
    runtime.authority.skills.complete(sessionId, {
      design_spec: "Keep QA tied to explicit planning evidence.",
      execution_plan: [
        {
          step: "Run the canonical QA contract test.",
          intent: "Exercise the plan-required evidence directly.",
          owner: "qa.runtime",
          exit_criteria: "The QA pass verdict covers the declared required evidence.",
          verification_intent: "QA checks mention the required evidence token explicitly.",
        },
        {
          step: "Preserve the required evidence token in the executed QA artifacts.",
          intent: "Make required evidence coverage machine-checkable.",
          owner: "qa.runtime",
          exit_criteria: "QA coverage text contains the required evidence identifier.",
          verification_intent: "QA pass validation rejects uncovered required evidence.",
        },
      ],
      execution_mode_hint: "test_first",
      risk_register: [
        {
          risk: "QA could pass without exercising the required planning evidence.",
          category: "public_api",
          severity: "high",
          mitigation: "Reject QA pass verdicts unless required evidence is covered.",
          required_evidence: ["plan_contract_tests"],
          owner_lane: "qa",
        },
      ],
      implementation_targets: [
        {
          target: "packages/brewva-runtime/src/services/skill-lifecycle.ts",
          kind: "module",
          owner_boundary: "runtime.authority.skills",
          reason: "QA completion validation is enforced here.",
        },
      ],
    });

    await loadTool.execute(
      "tc-load-qa-required-evidence",
      { name: "qa" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-qa-required-evidence",
      {
        outputs: {
          qa_report: "Executed an adversarial probe, but not the required plan contract test.",
          qa_findings: [],
          qa_verdict: "pass",
          qa_checks: [
            {
              name: "boundary-input",
              result: "pass",
              command: "bun test -- boundary-input",
              exitCode: 0,
              observedOutput: "boundary-input passed",
              probeType: "boundary",
            },
          ],
          qa_missing_evidence: [],
          qa_confidence_gaps: [],
          qa_environment_limits: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completion rejected.");
    expect(text).toContain("qa_verdict");
    expect(text).toContain("plan_contract_tests");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("qa");
  });

  test("accepts QA pass verdicts when fresh runtime verification covers plan required_evidence", async () => {
    const runtime = createIsolatedRuntime("qa-runtime-verification-coverage");
    const sessionId = "skill-complete-qa-runtime-verification-coverage";
    const loadTool = createSkillLoadTool({ runtime });
    const completeTool = createSkillCompleteTool({
      runtime,
      verification: { executeCommands: false },
    });

    runtime.authority.skills.activate(sessionId, "design");
    runtime.authority.skills.complete(sessionId, {
      design_spec: "Allow QA to rely on fresh runtime verification for required evidence closure.",
      execution_plan: [
        {
          step: "Run an adversarial QA probe for the risky path.",
          intent: "Keep QA independently executable even when verification already exists.",
          owner: "qa.runtime",
          exit_criteria: "QA still preserves at least one executable adversarial check.",
          verification_intent: "The QA flow records a bounded adversarial probe.",
        },
        {
          step: "Reuse fresh runtime verification for required evidence coverage.",
          intent: "Treat authoritative verification as acceptable evidence lineage.",
          owner: "qa.runtime",
          exit_criteria: "Required evidence is satisfied by fresh runtime verification coverage.",
          verification_intent:
            "Fresh verification output names the required evidence token explicitly.",
        },
      ],
      execution_mode_hint: "test_first",
      risk_register: [
        {
          risk: "QA could ignore required evidence even when runtime verification already proved it freshly.",
          category: "public_api",
          severity: "high",
          mitigation: "Allow fresh runtime verification to close required evidence coverage.",
          required_evidence: ["plan_contract_tests"],
          owner_lane: "qa",
        },
      ],
      implementation_targets: [
        {
          target: "packages/brewva-runtime/src/services/skill-lifecycle.ts",
          kind: "module",
          owner_boundary: "runtime.authority.skills",
          reason: "The required evidence closure logic lives here.",
        },
      ],
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 100,
      payload: {
        outcome: "pass",
        level: "standard",
        activeSkill: "implementation",
        evidenceFreshness: "fresh",
        commandsExecuted: ["plan_contract_tests"],
        failedChecks: [],
        checkResults: [
          {
            name: "plan_contract_tests",
            status: "pass",
            evidence: "plan_contract_tests passed",
          },
        ],
      },
    });

    await loadTool.execute(
      "tc-load-qa-runtime-verification-coverage",
      { name: "qa" },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const result = await completeTool.execute(
      "tc-complete-qa-runtime-verification-coverage",
      {
        outputs: {
          qa_report:
            "Executed an adversarial QA probe and reused fresh runtime verification coverage.",
          qa_findings: [],
          qa_verdict: "pass",
          qa_checks: [
            {
              name: "boundary-input",
              result: "pass",
              command: "bun test -- boundary-input",
              exitCode: 0,
              observedOutput: "boundary-input passed",
              probeType: "boundary",
            },
          ],
          qa_missing_evidence: [],
          qa_confidence_gaps: [],
          qa_environment_limits: [],
        },
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result as { content: Array<{ type: string; text?: string }> });
    expect(text).toContain("Skill completed");
    expect(runtime.inspect.skills.getActive(sessionId)).toBeUndefined();
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
    expect(text).toContain("Invalid required outputs:");
    expect(text).toContain("change_set");
    expect(text).toContain("verification_evidence");
    expect(runtime.inspect.skills.getActive(sessionId)?.name).toBe("implementation-contract");
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

    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.verification.defaultLevel = "quick";
    config.verification.checks.quick = ["tests"];
    config.verification.checks.standard = ["tests"];
    config.verification.checks.strict = ["tests"];
    config.verification.commands.tests = "true";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
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

    runtime.authority.tools.markCall(sessionId, "edit");
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "PASS 3 tests",
      channelSuccess: true,
    });
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      channelSuccess: true,
    });
    const verificationReport = await runtime.authority.verification.verify(sessionId, "quick", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(verificationReport.passed).toBe(true);

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
    expect(runtime.inspect.skills.getActive(sessionId)).toBeUndefined();
    expect(runtime.inspect.skills.getOutputs(sessionId, "implementation-contract")).toEqual(
      expect.objectContaining({
        change_set:
          "Implemented the contract-preserving fix and tightened the surrounding regression coverage.",
        files_changed: ["src/example.ts"],
        verification_evidence: ["PASS 3 tests", "No diagnostics found"],
      }),
    );
  });
});
