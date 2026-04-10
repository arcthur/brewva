import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  CONTEXT_SOURCES,
  DEFAULT_BREWVA_CONFIG,
  type BrewvaConfig,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { setStaticContextInjectionBudget } from "../../fixtures/config.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.projection.enabled = true;
  config.infrastructure.contextBudget.enabled = true;
  setStaticContextInjectionBudget(config, 4_000);
  return config;
}

function blockIndex(text: string, block: string): number {
  return text.indexOf(`[${block}]`);
}

function writeAgentProfile(
  workspace: string,
  fileName: "identity.md" | "constitution.md" | "memory.md",
  content: string,
): void {
  const root = join(workspace, ".brewva", "agents", "default");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, fileName), `${content.trim()}\n`, "utf8");
}

describe("recovery context baseline integration", () => {
  test("registers history-view baseline and recovery working-set as first-class context sources", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("recovery-context-baseline-sources"),
      config: createConfig(),
    });

    expect(runtime.inspect.context.listProviders()).toEqual(
      expect.arrayContaining([
        {
          source: CONTEXT_SOURCES.historyViewBaseline,
          category: "narrative",
          budgetClass: "core",
          order: 14,
        },
        {
          source: CONTEXT_SOURCES.recoveryWorkingSet,
          category: "constraint",
          budgetClass: "working",
          order: 45,
        },
      ]),
    );
  });

  test("admits history-view baseline and recovery working-set through normal injection ordering", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("recovery-context-baseline-ordering"),
      config: createConfig(),
    });
    const sessionId = "recovery-context-baseline-ordering";

    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Continue after compaction without replaying completed effects",
    });
    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-baseline",
      sanitizedSummary: "[CompactSummary]\nKeep current task intent and latest failures only.",
      summaryDigest: "digest-baseline",
      sourceTurn: 1,
      leafEntryId: "leaf-baseline",
      referenceContextDigest: "prefix-baseline",
      fromTokens: 800,
      toTokens: 300,
      origin: "extension_api",
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      payload: {
        reason: "compaction_retry",
        status: "entered",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: "ev-source",
        sourceEventType: "session_compact",
        error: null,
        breakerOpen: false,
        model: null,
      } as Record<string, unknown>,
    });

    const injected = await runtime.maintain.context.buildInjection(
      sessionId,
      "resume safely after compaction",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      { injectionScopeId: "leaf-baseline" },
    );

    expect(injected.accepted).toBe(true);
    const historyBaselinePosition = blockIndex(injected.text, "HistoryViewBaseline");
    const taskLedgerPosition = blockIndex(injected.text, "TaskLedger");
    const recoveryWorkingSetPosition = blockIndex(injected.text, "RecoveryWorkingSet");
    expect(historyBaselinePosition).toBeGreaterThanOrEqual(0);
    expect(taskLedgerPosition).toBeGreaterThan(historyBaselinePosition);
    expect(recoveryWorkingSetPosition).toBeGreaterThan(taskLedgerPosition);
  });

  test("rejects history-view baselines whose reference digest no longer matches", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("recovery-context-reference-mismatch"),
      config: createConfig(),
    });
    const sessionId = "recovery-context-reference-mismatch";

    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-reference-mismatch",
      sanitizedSummary: "[CompactSummary]\nKeep only the safe continuation baseline.",
      summaryDigest: "digest-reference-mismatch",
      sourceTurn: 1,
      leafEntryId: "leaf-reference-mismatch",
      referenceContextDigest: "prefix-old",
      fromTokens: 720,
      toTokens: 260,
      origin: "extension_api",
    });
    runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-new",
      dynamicTailHash: "tail-new",
      turn: 1,
    });

    const injected = await runtime.maintain.context.buildInjection(
      sessionId,
      "resume safely after a system contract change",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      {
        injectionScopeId: "leaf-reference-mismatch",
        referenceContextDigest: "prefix-new",
      },
    );

    expect(injected.text).not.toContain("[HistoryViewBaseline]");
    expect(runtime.inspect.recovery.getPosture(sessionId)).toEqual(
      expect.objectContaining({
        mode: "diagnostic_only",
        degradedReason: "reference_context_digest_mismatch",
      }),
    );
  });

  test("preserves the history-view baseline under core-context pressure", async () => {
    const workspace = createTestWorkspace("recovery-context-baseline-reserved-slice");
    writeAgentProfile(workspace, "identity.md", `# Identity\n${"identity ".repeat(240)}`);
    writeAgentProfile(
      workspace,
      "constitution.md",
      `# Constitution\n${"constitution ".repeat(240)}`,
    );
    writeAgentProfile(workspace, "memory.md", `# Memory\n${"memory ".repeat(240)}`);

    const config = createConfig();
    setStaticContextInjectionBudget(config, 240);
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config,
      agentId: "default",
    });
    const sessionId = "recovery-context-baseline-reserved-slice";

    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-reserved-slice",
      sanitizedSummary: "[CompactSummary]\nPreserve only the safe baseline.",
      summaryDigest: "digest-reserved-slice",
      sourceTurn: 1,
      leafEntryId: "leaf-reserved-slice",
      referenceContextDigest: "prefix-reserved-slice",
      fromTokens: 640,
      toTokens: 180,
      origin: "extension_api",
    });

    const injected = await runtime.maintain.context.buildInjection(
      sessionId,
      "resume under heavy core pressure",
      { tokens: 320, contextWindow: 16_000, percent: 0.02 },
      {
        injectionScopeId: "leaf-reserved-slice",
        referenceContextDigest: "prefix-reserved-slice",
      },
    );

    expect(injected.accepted).toBe(true);
    expect(injected.text).toContain("[HistoryViewBaseline]");
    expect(injected.text).toContain("Preserve only the safe baseline.");
  });

  test("derives recovery posture and working set from durable transition receipts", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("recovery-context-posture"),
      config: createConfig(),
    });
    const sessionId = "recovery-context-posture";

    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Resume after compaction retry",
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      payload: {
        reason: "compaction_retry",
        status: "entered",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: "ev-source",
        sourceEventType: "session_compact",
        error: null,
        breakerOpen: false,
        model: null,
      } as Record<string, unknown>,
    });

    expect(runtime.inspect.recovery.getPosture(sessionId)).toEqual(
      expect.objectContaining({
        mode: "resumable",
        pendingFamily: "recovery",
        latestReason: "compaction_retry",
      }),
    );
    expect(runtime.inspect.recovery.getWorkingSet(sessionId)).toEqual(
      expect.objectContaining({
        latestReason: "compaction_retry",
        pendingFamily: "recovery",
        taskGoal: "Resume after compaction retry",
      }),
    );
  });

  test("surfaces duplicate side-effect suppression counts from durable replay-guard receipts", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("recovery-context-duplicate-effect-guards"),
      config: createConfig(),
    });
    const sessionId = "recovery-context-duplicate-effect-guards";

    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Resume safely without replaying an already-consumed effect commitment",
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_call_blocked",
      payload: {
        toolName: "exec",
        reason: "effect_commitment_request_in_flight:req-1",
      } as Record<string, unknown>,
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_call_blocked",
      payload: {
        toolName: "exec",
        reason: "effect_commitment_operator_approval_consumed:req-1",
      } as Record<string, unknown>,
    });

    expect(runtime.inspect.recovery.getPosture(sessionId)).toEqual(
      expect.objectContaining({
        mode: "idle",
        duplicateSideEffectSuppressionCount: 2,
      }),
    );
    expect(runtime.inspect.recovery.getWorkingSet(sessionId)).toBeUndefined();

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      payload: {
        reason: "wal_recovery_resume",
        status: "entered",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: "ev-source",
        sourceEventType: "unclean_shutdown_reconciled",
        error: null,
        breakerOpen: false,
        model: null,
      } as Record<string, unknown>,
    });

    expect(runtime.inspect.recovery.getPosture(sessionId)).toEqual(
      expect.objectContaining({
        mode: "resumable",
        pendingFamily: "recovery",
        duplicateSideEffectSuppressionCount: 2,
      }),
    );
    expect(runtime.inspect.recovery.getWorkingSet(sessionId)).toEqual(
      expect.objectContaining({
        pendingFamily: "recovery",
        duplicateSideEffectSuppressionCount: 2,
      }),
    );
  });

  test("treats persisted unclean-shutdown diagnostics as superseded once recovery resume enters", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("recovery-context-persisted-diagnostic-superseded"),
      config: createConfig(),
    });
    const sessionId = "recovery-context-persisted-diagnostic-superseded";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "unclean_shutdown_reconciled",
      payload: {
        detectedAt: 5,
        reasons: ["open_turn_without_terminal_receipt"],
        openToolCalls: [],
        openTurns: [
          {
            turn: 1,
            startedAt: 1,
            eventId: "ev-turn-start-1",
          },
        ],
        latestEventType: "turn_start",
        latestEventAt: 1,
      } as Record<string, unknown>,
    });

    expect(runtime.inspect.recovery.getPosture(sessionId)).toEqual(
      expect.objectContaining({
        mode: "degraded",
        degradedReason: "open_turn_without_terminal_receipt",
      }),
    );

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_turn_transition",
      payload: {
        reason: "wal_recovery_resume",
        status: "entered",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: "ev-source",
        sourceEventType: "unclean_shutdown_reconciled",
        error: null,
        breakerOpen: false,
        model: null,
      } as Record<string, unknown>,
    });

    expect(runtime.inspect.recovery.getPosture(sessionId)).toEqual(
      expect.objectContaining({
        mode: "resumable",
        pendingFamily: "recovery",
        latestReason: "wal_recovery_resume",
      }),
    );
  });

  test("falls back to exact history when no compaction receipt exists and caches the derived baseline", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("recovery-context-exact-history"),
      config: createConfig(),
    });
    const sessionId = "recovery-context-exact-history";

    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-1",
        trigger: "user_submit",
        promptText: "Resume from the exact durable transcript.",
      } as Record<string, unknown>,
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "turn_render_committed",
      payload: {
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "Continuing from the committed reply only.",
        toolOutputs: [],
      } as Record<string, unknown>,
    });

    const firstBaseline = runtime.inspect.context.getHistoryViewBaseline(sessionId);
    expect(firstBaseline).toEqual(
      expect.objectContaining({
        rebuildSource: "exact_history",
        origin: "exact_history",
      }),
    );
    expect(firstBaseline?.sanitizedSummary).toContain("Resume from the exact durable transcript.");
    expect(firstBaseline?.sanitizedSummary).toContain("Continuing from the committed reply only.");

    const secondBaseline = runtime.inspect.context.getHistoryViewBaseline(sessionId);
    expect(secondBaseline).toEqual(
      expect.objectContaining({
        rebuildSource: "cache",
      }),
    );
  });

  test("ignores corrupted compaction receipts and degrades through exact-history fallback", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("recovery-context-digest-mismatch"),
      config: createConfig(),
    });
    const sessionId = "recovery-context-digest-mismatch";

    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-1",
        trigger: "user_submit",
        promptText: "Recover from the corrupted compaction receipt.",
      } as Record<string, unknown>,
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "turn_render_committed",
      payload: {
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "Use exact history because the latest compact receipt is invalid.",
        toolOutputs: [],
      } as Record<string, unknown>,
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "session_compact",
      payload: {
        compactId: "cmp-digest-mismatch",
        sanitizedSummary: "[CompactSummary]\nPreserve only the durable baseline.",
        summaryDigest: "not-the-real-digest",
        sourceTurn: 2,
        leafEntryId: "leaf-mismatch",
        referenceContextDigest: "prefix-mismatch",
        fromTokens: 900,
        toTokens: 250,
        origin: "extension_api",
        integrityViolations: null,
      } as Record<string, unknown>,
    });

    const baseline = runtime.inspect.context.getHistoryViewBaseline(sessionId);
    expect(baseline).toEqual(
      expect.objectContaining({
        rebuildSource: "exact_history",
      }),
    );
    expect(baseline?.diagnostics).toContain("summary_digest_mismatch");
    expect(runtime.inspect.recovery.getPosture(sessionId)).toEqual(
      expect.objectContaining({
        mode: "degraded",
        degradedReason: "summary_digest_mismatch",
      }),
    );
  });

  test("enters diagnostic-only posture when no safe baseline can be rebuilt", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("recovery-context-diagnostic-only"),
      config: createConfig(),
    });
    const sessionId = "recovery-context-diagnostic-only";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "reasoning_revert",
      payload: {
        schema: "brewva.reasoning.revert.v1",
        revertId: "revert-1",
        revertSequence: 1,
        toCheckpointId: "checkpoint-1",
        fromCheckpointId: null,
        fromBranchId: "branch-0",
        newBranchId: "branch-1",
        newBranchSequence: 1,
        trigger: "operator_request",
        continuityPacket: {
          schema: "brewva.reasoning.continuity.v1",
          text: "resume from diagnostic state",
        },
        linkedRollbackReceiptIds: [],
        targetLeafEntryId: "leaf-1",
        createdAt: new Date(0).toISOString(),
      } as Record<string, unknown>,
    });

    expect(runtime.inspect.context.getHistoryViewBaseline(sessionId)).toBeUndefined();
    expect(runtime.inspect.recovery.getPosture(sessionId)).toEqual(
      expect.objectContaining({
        mode: "diagnostic_only",
        degradedReason: "exact_history_branch_ambiguous",
      }),
    );
    expect(runtime.inspect.recovery.getWorkingSet(sessionId)).toBeUndefined();
  });

  test("enters diagnostic-only posture when exact-history fallback exceeds the reserved baseline budget", () => {
    const config = createConfig();
    setStaticContextInjectionBudget(config, 48);
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("recovery-context-exact-history-over-budget"),
      config,
    });
    const sessionId = "recovery-context-exact-history-over-budget";

    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-1",
        trigger: "user_submit",
        promptText: "x".repeat(2_000),
      } as Record<string, unknown>,
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "turn_render_committed",
      payload: {
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "y".repeat(2_000),
        toolOutputs: [],
      } as Record<string, unknown>,
    });

    expect(runtime.inspect.context.getHistoryViewBaseline(sessionId)).toBeUndefined();
    expect(runtime.inspect.recovery.getPosture(sessionId)).toEqual(
      expect.objectContaining({
        mode: "diagnostic_only",
        degradedReason: "exact_history_over_budget",
      }),
    );
  });
});
