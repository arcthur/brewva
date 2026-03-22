import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaRuntime,
  TAPE_CHECKPOINT_EVENT_TYPE,
  buildTapeCheckpointPayload,
  resolveSkillDefaultLease,
} from "@brewva/brewva-runtime";

describe("tape checkpoint automation", () => {
  test("uses session-local checkpoint counters instead of per-event tape rescans", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-counter-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 1000;
    const sessionId = "tape-counter-1";
    const runtime = new BrewvaRuntime({ cwd: workspace, config });

    const runtimePrivate = runtime as unknown as {
      eventStore: {
        list: (sessionId: string, query?: Record<string, unknown>) => unknown[];
      };
    };
    const originalList = runtimePrivate.eventStore.list.bind(runtimePrivate.eventStore);
    let listCalls = 0;
    runtimePrivate.eventStore.list = (targetSessionId: string, query?: Record<string, unknown>) => {
      listCalls += 1;
      return originalList(targetSessionId, query);
    };

    for (let index = 0; index < 24; index += 1) {
      runtime.events.record({
        sessionId,
        type: "tool_call",
        payload: {
          toolCallId: `tc-${index}`,
          toolName: "look_at",
        },
      });
    }

    expect(listCalls).toBe(1);
    const checkpoints = originalList(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE });
    expect(checkpoints).toHaveLength(0);
    runtimePrivate.eventStore.list = originalList;
  });

  test("writes checkpoint events by interval and replays consistent state after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tape-checkpoint-"));
    const sessionId = "tape-checkpoint-1";
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 3;

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "checkpoint consistency",
    });
    runtime.truth.upsertFact(sessionId, {
      id: "truth-1",
      kind: "test",
      severity: "warn",
      summary: "first fact",
    });
    runtime.task.addItem(sessionId, { text: "item-1", status: "todo" });
    runtime.task.addItem(sessionId, { text: "item-2", status: "doing" });

    const checkpoints = runtime.events.query(sessionId, {
      type: TAPE_CHECKPOINT_EVENT_TYPE,
    });
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    const checkpointPayload = (checkpoints.at(-1)?.payload ?? {}) as {
      schema?: string;
      state?: {
        task?: { items?: Array<{ text?: string }> };
        truth?: { facts?: Array<{ id?: string }> };
      };
    };
    expect(checkpointPayload.schema).toBe("brewva.tape.checkpoint.v3");
    expect(checkpointPayload.state?.task?.items?.some((item) => item.text === "item-1")).toBe(true);
    expect(checkpointPayload.state?.truth?.facts?.some((fact) => fact.id === "truth-1")).toBe(true);

    runtime.truth.upsertFact(sessionId, {
      id: "truth-2",
      kind: "test",
      severity: "error",
      summary: "second fact",
    });
    runtime.task.addItem(sessionId, { text: "item-3", status: "todo" });

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    const taskState = reloaded.task.getState(sessionId);
    const truthState = reloaded.truth.getState(sessionId);
    expect(taskState.items.map((item) => item.text)).toEqual(["item-1", "item-2", "item-3"]);
    expect(truthState.facts.some((fact) => fact.id === "truth-1")).toBe(true);
    expect(truthState.facts.some((fact) => fact.id === "truth-2")).toBe(true);
  });

  test("rehydrates active skill and tool-call budget state from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-budget-rehydrate-"));
    mkdirSync(join(workspace, "skills/core/budgetcraft"), { recursive: true });
    writeFileSync(
      join(workspace, "skills/core/budgetcraft/SKILL.md"),
      `---
name: budgetcraft
description: budget test skill
intent:
  outputs: []
effects:
  allowed_effects: [workspace_read]
resources:
  default_lease:
    max_tool_calls: 1
    max_tokens: 10000
  hard_ceiling:
    max_tool_calls: 2
    max_tokens: 20000
execution_hints:
  preferred_tools: [read]
  fallback_tools: [look_at]
consumes: []
requires: []
---
# budgetcraft
`,
      "utf8",
    );
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 0;
    config.security.mode = "strict";
    config.skills.roots = ["./skills"];
    const sessionId = "budget-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    const activated = runtime.skills.activate(sessionId, "budgetcraft");
    expect(activated.ok).toBe(true);
    if (!activated.ok) {
      throw new Error(activated.reason);
    }
    const maxToolCalls = resolveSkillDefaultLease(activated.skill.contract)?.maxToolCalls ?? 0;
    const consumed = Math.max(1, maxToolCalls);
    for (let index = 0; index < consumed; index += 1) {
      runtime.tools.markCall(sessionId, "look_at");
    }
    const blockedBeforeRestart = runtime.tools.checkAccess(sessionId, "look_at");
    expect(blockedBeforeRestart.allowed).toBe(false);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    const blockedAfterRestart = reloaded.tools.checkAccess(sessionId, "look_at");
    expect(blockedAfterRestart.allowed).toBe(false);
    expect(blockedAfterRestart.reason).toContain("maxToolCalls");
  });

  test("rehydrates session cost budget state from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-cost-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.costTracking.actionOnExceed = "block_tools";
    config.infrastructure.costTracking.maxCostUsdPerSession = 0.001;
    const sessionId = "cost-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.002,
    });

    const blockedBeforeRestart = runtime.tools.checkAccess(sessionId, "look_at");
    expect(blockedBeforeRestart.allowed).toBe(false);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    const blockedAfterRestart = reloaded.tools.checkAccess(sessionId, "look_at");
    expect(blockedAfterRestart.allowed).toBe(false);
    expect(blockedAfterRestart.reason).toContain("Session cost exceeded");
  });

  test("rehydrates verification evidence state from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-verification-evidence-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.verification.defaultLevel = "quick";
    config.verification.checks.quick = ["type-check"];
    config.verification.checks.standard = ["type-check"];
    config.verification.checks.strict = ["type-check"];
    const sessionId = "verification-evidence-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.tools.markCall(sessionId, "edit");
    runtime.tools.recordResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: {
        filePath: "src/app.ts",
        severity: "all",
      },
      outputText: "No diagnostics found",
      channelSuccess: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: {
        command: "bun test",
      },
      outputText: "All tests passed",
      channelSuccess: true,
    });
    const beforeRestart = await runtime.verification.verify(sessionId, "quick", {
      executeCommands: false,
    });
    expect(beforeRestart.passed).toBe(true);
    expect(beforeRestart.skipped).toBe(false);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    const afterRestart = await reloaded.verification.verify(sessionId, "quick", {
      executeCommands: false,
    });
    expect(afterRestart.passed).toBe(true);
    expect(afterRestart.skipped).toBe(false);
  });

  test("rehydrates verification command runs from tape before rerunning checks", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-verification-command-rehydrate-"));
    const baseConfig = structuredClone(DEFAULT_BREWVA_CONFIG);
    baseConfig.verification.defaultLevel = "standard";
    baseConfig.verification.checks.quick = ["tests"];
    baseConfig.verification.checks.standard = ["tests"];
    baseConfig.verification.checks.strict = ["tests"];
    baseConfig.verification.commands.tests = "true";
    const sessionId = "verification-command-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config: baseConfig });
    runtime.tools.markCall(sessionId, "edit");
    const beforeRestart = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(beforeRestart.passed).toBe(true);

    const changedConfig = structuredClone(baseConfig);
    changedConfig.verification.commands.tests = "false";
    const reloaded = new BrewvaRuntime({ cwd: workspace, config: changedConfig });
    const afterRestart = await reloaded.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(afterRestart.passed).toBe(true);
  });

  test("rehydrates workflow readiness and advisory context from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-workflow-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    const sessionId = "workflow-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Promote workflow artifacts and readiness",
    });
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "design",
        outputKeys: ["design_spec", "execution_plan"],
        outputs: {
          design_spec: "Define the workflow artifact contract.",
          execution_plan: ["Derive readiness", "Publish advisory context"],
        },
      },
    });
    runtime.events.record({
      sessionId,
      type: "verification_write_marked",
      timestamp: 110,
      payload: {
        toolName: "edit",
      },
    });
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 120,
      payload: {
        skillName: "review",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: "Workflow chain looks ready.",
          review_findings: [],
          merge_decision: "ready",
        },
      },
    });
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 130,
      payload: {
        outcome: "pass",
        level: "standard",
        failedChecks: [],
        evidenceFreshness: "fresh",
      },
    });

    const beforeRestart = await runtime.context.buildInjection(
      sessionId,
      "continue",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      "workflow-rehydrate-before",
    );
    expect(beforeRestart.text).toContain("[WorkflowAdvisory]");
    expect(beforeRestart.text).toContain("planning: ready");
    expect(beforeRestart.text).toContain("implementation: ready");
    expect(beforeRestart.text).toContain("review: ready");
    expect(beforeRestart.text).toContain("verification: ready");
    expect(beforeRestart.text).toContain("release: ready");

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    const afterRestart = await reloaded.context.buildInjection(
      sessionId,
      "continue",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      "workflow-rehydrate-after",
    );

    expect(afterRestart.accepted).toBe(true);
    expect(afterRestart.text).toContain("[WorkflowAdvisory]");
    expect(afterRestart.text).toContain("planning: ready");
    expect(afterRestart.text).toContain("implementation: ready");
    expect(afterRestart.text).toContain("review: ready");
    expect(afterRestart.text).toContain("verification: ready");
    expect(afterRestart.text).toContain("release: ready");
    expect(afterRestart.text).toContain("[WorkingProjection]");
    expect(afterRestart.text).toContain("workflow.design: state=ready; freshness=unknown;");
    expect(afterRestart.text).toContain("workflow.review: state=ready; freshness=fresh;");
    expect(afterRestart.text).toContain("workflow.verification: state=ready; freshness=fresh;");
  });

  test("rehydrates pending patch worker results into workflow advisory after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-workflow-pending-worker-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    const sessionId = "workflow-pending-worker-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "review",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: "Workflow chain looks ready.",
          review_findings: [],
          merge_decision: "ready",
        },
      },
    });
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 110,
      payload: {
        outcome: "pass",
        level: "standard",
        failedChecks: [],
        evidenceFreshness: "fresh",
      },
    });
    runtime.events.record({
      sessionId,
      type: "subagent_completed",
      timestamp: 120,
      payload: {
        runId: "patch-worker-1",
        profile: "patch-worker",
        kind: "patch",
        summary: "Patch worker completed and awaits parent merge/apply.",
      },
    });

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    const injected = await reloaded.context.buildInjection(
      sessionId,
      "continue",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      "workflow-pending-worker-after",
    );

    expect(injected.accepted).toBe(true);
    expect(injected.text).toContain("[WorkflowAdvisory]");
    expect(injected.text).toContain("implementation: pending");
    expect(injected.text).toContain("release: blocked");
    expect(injected.text).toContain("pending_worker_results: 1");
  });

  test("resets checkpoint counter state when a checkpoint is manually recorded", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-manual-checkpoint-counter-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 3;
    const sessionId = "manual-checkpoint-counter-1";
    const runtime = new BrewvaRuntime({ cwd: workspace, config });

    const recordSyntheticEvent = (index: number): void => {
      runtime.events.record({
        sessionId,
        type: "tool_call",
        payload: {
          toolCallId: `manual-tc-${index}`,
          toolName: "look_at",
        },
      });
    };

    recordSyntheticEvent(1);
    recordSyntheticEvent(2);
    expect(runtime.events.query(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE })).toHaveLength(0);

    const replay = (
      runtime as unknown as {
        turnReplay: {
          getCheckpointEvidenceState: (sessionId: string) => unknown;
          getCheckpointProjectionState: (sessionId: string) => unknown;
        };
      }
    ).turnReplay;

    const payload = buildTapeCheckpointPayload({
      taskState: runtime.task.getState(sessionId),
      truthState: runtime.truth.getState(sessionId),
      costSummary: runtime.cost.getSummary(sessionId),
      evidenceState: replay.getCheckpointEvidenceState(sessionId) as Parameters<
        typeof buildTapeCheckpointPayload
      >[0]["evidenceState"],
      projectionState: replay.getCheckpointProjectionState(sessionId) as Parameters<
        typeof buildTapeCheckpointPayload
      >[0]["projectionState"],
      reason: "manual_test",
    });
    runtime.events.record({
      sessionId,
      type: TAPE_CHECKPOINT_EVENT_TYPE,
      payload: payload as unknown as Record<string, unknown>,
    });
    expect(runtime.events.query(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE })).toHaveLength(1);

    recordSyntheticEvent(3);
    recordSyntheticEvent(4);
    expect(runtime.events.query(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE })).toHaveLength(1);

    recordSyntheticEvent(5);
    expect(runtime.events.query(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE })).toHaveLength(2);
  });

  test("preserves same-turn tool cost allocation across checkpoint-based restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-cost-alloc-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.tape.checkpointIntervalEntries = 2;
    const sessionId = "cost-allocation-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "look_at");
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 100,
      costUsd: 0.001,
    });

    const checkpoints = runtime.events.query(sessionId, {
      type: TAPE_CHECKPOINT_EVENT_TYPE,
    });
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    const beforeRestart = runtime.cost.getSummary(sessionId);
    expect(beforeRestart.tools.look_at?.allocatedTokens).toBe(100);
    expect(beforeRestart.skills["(none)"]?.turns).toBe(1);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    reloaded.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 40,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 50,
      costUsd: 0.0005,
    });
    const afterRestart = reloaded.cost.getSummary(sessionId);

    expect(afterRestart.tools.look_at?.callCount).toBe(1);
    expect(afterRestart.tools.look_at?.allocatedTokens).toBe(150);
    expect(afterRestart.totalTokens).toBe(150);
    expect(afterRestart.totalCostUsd).toBeCloseTo(0.0015, 8);
    expect(afterRestart.skills["(none)"]?.turns).toBe(1);
    expect(afterRestart.tools.llm).toBeUndefined();
  });

  test("rehydrates ledger compaction cooldown turn from tape after restart", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-ledger-cooldown-rehydrate-"));
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.ledger.checkpointEveryTurns = 1;
    const sessionId = "ledger-cooldown-rehydrate-1";

    const runtime = new BrewvaRuntime({ cwd: workspace, config });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo first-a" },
      outputText: "ok",
      channelSuccess: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo first-b" },
      outputText: "ok",
      channelSuccess: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo first-c" },
      outputText: "ok",
      channelSuccess: true,
    });
    expect(runtime.events.query(sessionId, { type: "ledger_compacted" })).toHaveLength(1);

    const reloaded = new BrewvaRuntime({ cwd: workspace, config });
    reloaded.context.onTurnStart(sessionId, 1);
    reloaded.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo second" },
      outputText: "ok",
      channelSuccess: true,
    });
    expect(reloaded.events.query(sessionId, { type: "ledger_compacted" })).toHaveLength(1);
  });

  test("rebuilds working projection from tape after projection files are removed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-projection-rebuild-"));
    const sessionId = "projection-rebuild-1";

    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Recover working projection from tape",
      constraints: ["rebuild projection when files are missing"],
    });
    runtime.task.recordBlocker(sessionId, {
      message: "projection rebuild validation",
      source: "test",
    });
    const before = await runtime.context.buildInjection(sessionId, "continue");
    expect(before.text).toContain("[WorkingProjection]");

    const projectionDir = join(workspace, ".orchestrator/projection");
    rmSync(join(projectionDir, "units.jsonl"), { force: true });
    rmSync(join(projectionDir, "state.json"), { force: true });
    rmSync(join(projectionDir, "sessions"), { recursive: true, force: true });

    const reloaded = new BrewvaRuntime({ cwd: workspace });
    reloaded.context.onTurnStart(sessionId, 2);
    const after = await reloaded.context.buildInjection(sessionId, "continue");
    expect(after.text).toContain("[WorkingProjection]");
    expect(after.text).toContain("Recover working projection from tape");

    const unitsPath = join(projectionDir, "units.jsonl");
    expect(existsSync(unitsPath)).toBe(true);
    const lines = readFileSync(unitsPath, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(0);
  });
});
