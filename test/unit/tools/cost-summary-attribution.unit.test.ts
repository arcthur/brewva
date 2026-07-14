import { describe, expect, test } from "bun:test";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("session cost summary attribution", () => {
  test("populates per-tool rows and splits the cost pool by result-token share", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("cost-summary-attribution"),
    });
    const sessionId = "cost-attribution-session";

    runtime.ops.cost.usage.recordAssistant({
      sessionId,
      model: "openai/gpt-5",
      inputTokens: 100,
      outputTokens: 100,
      totalTokens: 200,
      costUsd: 0.4,
    });
    runtime.ops.tools.invocation.recordResult({
      sessionId,
      toolCallId: "call-1",
      toolName: "Read",
      verdict: "pass",
      failureClass: "none",
      resultTokenEstimate: 100,
    });
    runtime.ops.tools.invocation.recordResult({
      sessionId,
      toolCallId: "call-2",
      toolName: "Bash",
      verdict: "pass",
      failureClass: "none",
      resultTokenEstimate: 300,
    });

    const summary = runtime.ops.cost.summary.get(sessionId);

    expect(summary.tools.Read).toMatchObject({ callCount: 1, allocatedTokens: 100 });
    expect(summary.tools.Bash).toMatchObject({ callCount: 1, allocatedTokens: 300 });
    // The per-turn cost pool ($0.40) splits by result-token share: Read 100/400,
    // Bash 300/400. Estimated, not measured (no provider per-tool cost exists).
    expect(summary.tools.Read?.allocatedCostUsd ?? 0).toBeCloseTo(0.1, 5);
    expect(summary.tools.Bash?.allocatedCostUsd ?? 0).toBeCloseTo(0.3, 5);
  });

  test("attributes per-turn spend to the skills surfaced by the active selection", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("cost-summary-skill-attribution"),
    });
    const sessionId = "cost-skill-session";

    // Faithful to the real SKILL_SELECTION_RECORDED payload: entries are
    // RenderedSkillReason, whose skill name lives on `name` (see skill-selection.ts
    // and the existing skill-projections consumer), not `skillName`.
    runtime.ops.skills.selection.record(sessionId, {
      selectionId: "sel-1",
      renderedSkillReasons: [{ name: "investigate" }],
    });
    runtime.ops.cost.usage.recordAssistant({
      sessionId,
      model: "openai/gpt-5",
      inputTokens: 50,
      outputTokens: 50,
      totalTokens: 100,
      costUsd: 0.2,
    });

    const summary = runtime.ops.cost.summary.get(sessionId);
    expect(summary.skills.investigate).toMatchObject({ usageCount: 1, turns: 1, totalTokens: 100 });
    expect(summary.skills.investigate?.totalCostUsd ?? 0).toBeCloseTo(0.2, 5);
  });

  test("includeAttribution:false returns totals only and skips the breakdown scans", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("cost-summary-totals-only"),
    });
    const sessionId = "cost-totals-only-session";

    runtime.ops.skills.selection.record(sessionId, {
      selectionId: "sel-1",
      renderedSkillReasons: [{ name: "investigate" }],
    });
    runtime.ops.tools.invocation.recordResult({
      sessionId,
      toolCallId: "call-1",
      toolName: "Read",
      verdict: "pass",
      failureClass: "none",
      resultTokenEstimate: 100,
    });
    runtime.ops.cost.usage.recordAssistant({
      sessionId,
      model: "openai/gpt-5",
      inputTokens: 50,
      outputTokens: 50,
      totalTokens: 100,
      costUsd: 0.2,
    });

    // Full read populates the breakdown.
    const full = runtime.ops.cost.summary.get(sessionId);
    expect(Object.keys(full.tools)).toHaveLength(1);
    expect(Object.keys(full.skills)).toHaveLength(1);

    // Totals-only read (the hot-path contract) skips the breakdown while keeping
    // session totals correct. Guards that getRuntimeCostSummary stays cheap.
    const totals = runtime.ops.cost.summary.get(sessionId, { includeAttribution: false });
    expect(Object.keys(totals.tools)).toHaveLength(0);
    expect(Object.keys(totals.skills)).toHaveLength(0);
    expect(totals.totalCostUsd).toBeCloseTo(0.2, 5);
    expect(totals.totalTokens).toBe(100);
  });

  test("splits a turn's cost equally across all skills in the active selection", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("cost-summary-multi-skill"),
    });
    const sessionId = "cost-multi-skill-session";

    runtime.ops.skills.selection.record(sessionId, {
      selectionId: "sel-1",
      renderedSkillReasons: [{ name: "investigate" }, { name: "test-driven-development" }],
    });
    runtime.ops.cost.usage.recordAssistant({
      sessionId,
      model: "openai/gpt-5",
      inputTokens: 50,
      outputTokens: 50,
      totalTokens: 100,
      costUsd: 0.2,
    });

    const summary = runtime.ops.cost.summary.get(sessionId);
    // Equal split (share = 1/names.length): each of the 2 skills gets half the
    // turn's cost and tokens.
    expect(summary.skills.investigate?.totalCostUsd ?? 0).toBeCloseTo(0.1, 5);
    expect(summary.skills["test-driven-development"]?.totalCostUsd ?? 0).toBeCloseTo(0.1, 5);
    expect(summary.skills.investigate?.totalTokens ?? 0).toBeCloseTo(50, 5);
    expect(summary.skills["test-driven-development"]?.totalTokens ?? 0).toBeCloseTo(50, 5);
  });

  test("leaves tool rows empty when no tool results were recorded", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: createTestWorkspace("cost-summary-attribution-empty"),
    });
    const sessionId = "cost-attribution-empty-session";

    runtime.ops.cost.usage.recordAssistant({
      sessionId,
      model: "openai/gpt-5",
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20,
      costUsd: 0.01,
    });

    const summary = runtime.ops.cost.summary.get(sessionId);
    expect(Object.keys(summary.tools)).toHaveLength(0);
    expect(summary.totalCostUsd).toBeCloseTo(0.01, 5);
  });
});
