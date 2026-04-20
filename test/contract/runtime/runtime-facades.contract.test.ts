import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  buildScheduleIntentFiredEvent,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { setStaticContextPressureThresholds } from "../../fixtures/config.js";
import { patchDateNow } from "../../helpers/global-state.js";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("runtime facade coverage", () => {
  test("session.pollStall records and deduplicates watchdog detection through the public session API", () => {
    let now = 1_740_000_000_000;
    const restoreNow = patchDateNow(() => now);

    try {
      const runtime = new BrewvaRuntime({
        cwd: createTestWorkspace("runtime-facade-poll-stall"),
        config: createOpsRuntimeConfig(),
      });
      const sessionId = "runtime-facade-poll-stall-1";

      now = 1_740_000_000_100;
      runtime.authority.task.setSpec(sessionId, {
        schema: "brewva.task.v1",
        goal: "Detect stalled execution through the public runtime facade",
      });

      runtime.maintain.session.pollStall(sessionId, {
        now: now + 1_001,
        thresholdMs: 1_000,
      });

      const state = runtime.inspect.task.getState(sessionId);
      expect(state.blockers).toEqual([]);

      const detected = runtime.inspect.events.query(sessionId, {
        type: "task_stuck_detected",
      });
      expect(detected).toHaveLength(1);
      expect(detected[0]?.payload).toMatchObject({
        schema: "brewva.task-watchdog.v1",
        thresholdMs: 1_000,
        idleMs: 1_001,
      });

      runtime.maintain.session.pollStall(sessionId, {
        now: now + 1_500,
        thresholdMs: 1_000,
      });

      expect(runtime.inspect.events.query(sessionId, { type: "task_stuck_detected" })).toHaveLength(
        1,
      );
    } finally {
      restoreNow();
    }
  });

  test("session.onClearState listeners can unsubscribe and listener failures do not block teardown", () => {
    const runtime = new BrewvaRuntime({ cwd: createTestWorkspace("runtime-facade-clear-state") });
    const sessionId = "runtime-facade-clear-state-1";
    const observed: string[] = [];

    const unsubscribeObserved = runtime.maintain.session.onClearState((id) => {
      observed.push(id);
    });
    runtime.maintain.session.onClearState(() => {
      throw new Error("listener exploded");
    });

    runtime.maintain.session.recordWorkerResult(sessionId, {
      workerId: "worker-1",
      status: "ok",
      summary: "first worker result",
      patches: {
        id: "ps-worker-1",
        createdAt: Date.now(),
        changes: [{ path: "src/worker-1.ts", action: "modify" }],
      },
    });

    runtime.maintain.session.clearState(sessionId);

    expect(observed).toEqual([sessionId]);
    expect(runtime.inspect.session.listWorkerResults(sessionId)).toHaveLength(0);

    unsubscribeObserved();
    unsubscribeObserved();

    runtime.maintain.session.recordWorkerResult(sessionId, {
      workerId: "worker-2",
      status: "ok",
      summary: "second worker result",
      patches: {
        id: "ps-worker-2",
        createdAt: Date.now(),
        changes: [{ path: "src/worker-2.ts", action: "modify" }],
      },
    });

    runtime.maintain.session.clearState(sessionId);

    expect(observed).toEqual([sessionId]);
    expect(runtime.inspect.session.listWorkerResults(sessionId)).toHaveLength(0);
  });

  test("session.getIntegrity aggregates session and WAL durability issues", () => {
    const workspace = createTestWorkspace("runtime-facade-session-integrity");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "runtime-facade-session-integrity-1";
    const walDir = join(workspace, DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal.dir);
    mkdirSync(walDir, { recursive: true });
    writeFileSync(join(walDir, "runtime.jsonl"), '{"broken":\n', "utf8");

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_output_artifact_persist_failed",
      payload: {
        reason: "artifact_store_unavailable",
      },
    });

    const integrity = runtime.inspect.session.getIntegrity(sessionId);
    expect(integrity.status).toBe("unavailable");
    expect(integrity.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          domain: "recovery_wal",
          severity: "unavailable",
          reason: "recovery_wal_malformed_row",
        }),
        expect.objectContaining({
          domain: "artifact",
          severity: "degraded",
          reason: "artifact_store_unavailable",
          sessionId,
        }),
      ]),
    );
  });

  test("session inspection exposes unclean shutdown reconciliation and open tool calls", () => {
    let now = 1_740_000_000_000;
    const restoreNow = patchDateNow(() => now);

    try {
      const workspace = createTestWorkspace("runtime-facade-unclean-shutdown");
      const config = createOpsRuntimeConfig();
      const sessionId = "runtime-facade-unclean-shutdown-1";
      const runtime = new BrewvaRuntime({ cwd: workspace, config });

      runtime.maintain.context.onTurnStart(sessionId, 1);
      expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);
      recordRuntimeEvent(runtime, {
        sessionId,
        type: "tool_execution_start",
        turn: 1,
        timestamp: now,
        payload: {
          toolCallId: "read-1",
          toolName: "read",
          args: {
            path: "README.md",
          },
        },
      });

      now += 10_000;
      const reloaded = new BrewvaRuntime({ cwd: workspace, config });

      expect(reloaded.inspect.recovery.listPending()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId,
            source: "tool",
            status: "inflight",
          }),
        ]),
      );
      expect(reloaded.inspect.session.getOpenToolCalls(sessionId)).toEqual([
        expect.objectContaining({
          toolCallId: "read-1",
          toolName: "read",
        }),
      ]);
      expect(reloaded.inspect.session.getUncleanShutdownDiagnostic(sessionId)).toMatchObject({
        reasons: expect.arrayContaining([
          "open_tool_calls_without_terminal_receipt",
          "active_skill_without_terminal_receipt",
        ]),
        openToolCalls: [
          expect.objectContaining({
            toolCallId: "read-1",
            toolName: "read",
          }),
        ],
        activeSkill: expect.objectContaining({
          skillName: "design",
          phase: "active",
        }),
        latestEventType: "tool_execution_start",
      });
      expect(
        reloaded.inspect.events.query(sessionId, { type: "unclean_shutdown_reconciled" }),
      ).toHaveLength(1);
      expect(reloaded.inspect.recovery.getPosture(sessionId)).toEqual(
        expect.objectContaining({
          mode: "degraded",
          degradedReason: expect.stringContaining("active_skill_without_terminal_receipt"),
        }),
      );
      expect(reloaded.inspect.lifecycle.getSnapshot(sessionId)).toEqual(
        expect.objectContaining({
          execution: expect.objectContaining({
            kind: "tool_executing",
            toolCallId: "read-1",
            toolName: "read",
          }),
          summary: expect.objectContaining({
            kind: "degraded",
          }),
        }),
      );
    } finally {
      restoreNow();
    }
  });

  test("inspect.lifecycle exposes blocked approval posture from durable approval state", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-lifecycle-approval"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "runtime-facade-lifecycle-approval-1";

    runtime.maintain.context.onTurnStart(sessionId, 1);
    const started = runtime.authority.tools.start({
      sessionId,
      toolCallId: "tool-lifecycle-1",
      toolName: "exec",
      args: { command: "echo hi" },
    });
    expect(started.allowed).toBe(false);

    expect(runtime.inspect.lifecycle.getSnapshot(sessionId)).toEqual(
      expect.objectContaining({
        execution: expect.objectContaining({
          kind: "waiting_approval",
          requestId: started.effectCommitmentRequestId,
          toolCallId: "tool-lifecycle-1",
          toolName: "exec",
        }),
        approval: expect.objectContaining({
          status: "pending",
          pendingCount: 1,
          requestId: started.effectCommitmentRequestId,
          toolCallId: "tool-lifecycle-1",
          toolName: "exec",
        }),
        summary: expect.objectContaining({
          kind: "blocked",
          reason: "approval_requested",
          detail: expect.any(String),
        }),
      }),
    );
  });

  test("inspect.lifecycle exposes recovery transition source facts for reasoning resume adapters", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-lifecycle-recovery"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "runtime-facade-lifecycle-recovery-1";

    runtime.maintain.context.onTurnStart(sessionId, 8);
    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 8,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-lifecycle-recovery-1",
        trigger: "recovery",
        promptText: "Resume the interrupted attempt",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 8,
      type: "session_turn_transition",
      payload: {
        reason: "reasoning_revert_resume",
        status: "entered",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: "reasoning-revert-event-1",
        sourceEventType: "reasoning_revert_recorded",
        error: null,
        breakerOpen: false,
        model: null,
      },
    });

    expect(runtime.inspect.lifecycle.getSnapshot(sessionId)).toEqual(
      expect.objectContaining({
        execution: expect.objectContaining({
          kind: "recovering",
          reason: "reasoning_revert_resume",
          family: "recovery",
        }),
        recovery: expect.objectContaining({
          latestReason: "reasoning_revert_resume",
          latestStatus: "entered",
          pendingFamily: "recovery",
          latestSourceEventId: "reasoning-revert-event-1",
          latestSourceEventType: "reasoning_revert_recorded",
        }),
        summary: expect.objectContaining({
          kind: "recovering",
          reason: "reasoning_revert_resume",
        }),
      }),
    );
  });

  test("inspect.lifecycle invalidates cached snapshots on new events and returns defensive copies", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-lifecycle-cache"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "runtime-facade-lifecycle-cache-1";

    const initialSnapshot = runtime.inspect.lifecycle.getSnapshot(sessionId);
    expect(initialSnapshot.execution.kind).toBe("idle");

    initialSnapshot.summary.kind = "closed";

    const cachedSnapshot = runtime.inspect.lifecycle.getSnapshot(sessionId);
    expect(cachedSnapshot.summary.kind).toBe("idle");
    expect(cachedSnapshot.execution.kind).toBe("idle");

    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "tool_execution_start",
      payload: {
        toolCallId: "cache-tool-1",
        toolName: "read",
      },
    });

    expect(runtime.inspect.lifecycle.getSnapshot(sessionId)).toEqual(
      expect.objectContaining({
        execution: expect.objectContaining({
          kind: "tool_executing",
          toolCallId: "cache-tool-1",
          toolName: "read",
        }),
        summary: expect.objectContaining({
          kind: "degraded",
        }),
      }),
    );
  });

  test("inspect.lifecycle invalidates cached snapshots on prompt stability changes", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-lifecycle-prompt-stability-cache"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "runtime-facade-lifecycle-prompt-stability-cache-1";

    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-lifecycle-prompt-stability-cache",
      sanitizedSummary: "[CompactSummary]\nKeep the resumable baseline.",
      summaryDigest: sha256("[CompactSummary]\nKeep the resumable baseline."),
      sourceTurn: 1,
      leafEntryId: "leaf-lifecycle-prompt-stability-cache",
      referenceContextDigest: "prefix-old",
      fromTokens: 720,
      toTokens: 260,
      origin: "extension_api",
    });

    expect(runtime.inspect.lifecycle.getSnapshot(sessionId)).toEqual(
      expect.objectContaining({
        recovery: expect.objectContaining({
          mode: "idle",
          degradedReason: null,
        }),
        summary: expect.objectContaining({
          kind: "idle",
        }),
      }),
    );

    runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-new",
      dynamicTailHash: "tail-new",
      turn: 1,
      timestamp: 1_740_000_000_100,
    });

    expect(runtime.inspect.lifecycle.getSnapshot(sessionId)).toEqual(
      expect.objectContaining({
        recovery: expect.objectContaining({
          mode: "diagnostic_only",
          degradedReason: "reference_context_digest_mismatch",
        }),
        summary: expect.objectContaining({
          kind: "degraded",
          reason: "reference_context_digest_mismatch",
        }),
      }),
    );
  });

  test("inspect.lifecycle retains more than a dozen recent transitions for recovery adapters", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-lifecycle-transition-window"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "runtime-facade-lifecycle-transition-window-1";

    for (let index = 0; index < 16; index += 1) {
      recordRuntimeEvent(runtime, {
        sessionId,
        turn: 3,
        type: "session_turn_transition",
        payload: {
          reason: "provider_fallback_retry",
          status: index === 15 ? "entered" : "completed",
          sequence: index + 1,
          family: "recovery",
          attempt: 1,
          sourceEventId: `transition-source-${index + 1}`,
          sourceEventType: "tool_result_recorded",
          error: null,
          breakerOpen: false,
          model: null,
        },
      });
    }

    expect(runtime.inspect.lifecycle.getSnapshot(sessionId).recovery.recentTransitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceEventId: "transition-source-1",
        }),
        expect.objectContaining({
          sourceEventId: "transition-source-16",
        }),
      ]),
    );
    expect(
      runtime.inspect.lifecycle.getSnapshot(sessionId).recovery.recentTransitions,
    ).toHaveLength(16);
  });

  test("tool execution terminal receipts clear tool recovery wal rows", () => {
    const workspace = createTestWorkspace("runtime-facade-tool-recovery-wal");
    const config = createOpsRuntimeConfig();
    const sessionId = "runtime-facade-tool-recovery-wal-1";
    const runtime = new BrewvaRuntime({ cwd: workspace, config });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_execution_start",
      turn: 1,
      payload: {
        toolCallId: "grep-1",
        toolName: "grep",
      },
    });

    expect(runtime.inspect.recovery.listPending()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          source: "tool",
          status: "inflight",
        }),
      ]),
    );

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_execution_end",
      turn: 1,
      payload: {
        toolCallId: "grep-1",
        toolName: "grep",
        isError: false,
      },
    });

    expect(
      runtime.inspect.recovery.listPending().filter((row) => row.sessionId === sessionId),
    ).toEqual([]);
  });

  test("reasoning facade records durable branch state and rehydrates after clearState", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-reasoning"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "runtime-facade-reasoning-1";
    runtime.maintain.context.onTurnStart(sessionId, 1);

    const checkpointA = runtime.authority.reasoning.recordCheckpoint(sessionId, {
      boundary: "operator_marker",
      leafEntryId: "leaf-a",
    });
    const checkpointB = runtime.authority.reasoning.recordCheckpoint(sessionId, {
      boundary: "verification_boundary",
      leafEntryId: "leaf-b",
    });
    const revert = runtime.authority.reasoning.revert(sessionId, {
      toCheckpointId: checkpointA.checkpointId,
      trigger: "operator_request",
      continuity: "Resume from the earlier verified checkpoint only.",
      linkedRollbackReceiptIds: ["rollback-1", "rollback-1", "rollback-2"],
    });

    const beforeClear = runtime.inspect.reasoning.getActiveState(sessionId);
    expect(beforeClear.activeCheckpointId).toBe(checkpointA.checkpointId);
    expect(beforeClear.activeLineageCheckpointIds).toEqual([checkpointA.checkpointId]);
    expect(beforeClear.checkpoints.map((entry) => entry.checkpointId)).toEqual([
      checkpointA.checkpointId,
      checkpointB.checkpointId,
    ]);
    expect(beforeClear.reverts).toEqual([
      expect.objectContaining({
        revertId: revert.revertId,
        toCheckpointId: checkpointA.checkpointId,
        fromCheckpointId: checkpointB.checkpointId,
        linkedRollbackReceiptIds: ["rollback-1", "rollback-2"],
      }),
    ]);
    expect(runtime.inspect.reasoning.canRevertTo(sessionId, checkpointA.checkpointId)).toBe(true);
    expect(runtime.inspect.reasoning.canRevertTo(sessionId, checkpointB.checkpointId)).toBe(false);

    runtime.maintain.session.clearState(sessionId);

    const afterClear = runtime.inspect.reasoning.getActiveState(sessionId);
    expect(afterClear.activeBranchId).toBe(revert.newBranchId);
    expect(afterClear.activeCheckpointId).toBe(checkpointA.checkpointId);
    expect(afterClear.activeLineageCheckpointIds).toEqual([checkpointA.checkpointId]);
    expect(afterClear.latestContinuityPacket?.text).toBe(
      "Resume from the earlier verified checkpoint only.",
    );
    expect(afterClear.reverts).toEqual([
      expect.objectContaining({
        revertId: revert.revertId,
        toCheckpointId: checkpointA.checkpointId,
      }),
    ]);
  });

  test("session inspection exposes unclean shutdown reconciliation for open turns without tool calls", () => {
    let now = 1_740_000_100_000;
    const restoreNow = patchDateNow(() => now);

    try {
      const workspace = createTestWorkspace("runtime-facade-unclean-open-turn");
      const config = createOpsRuntimeConfig();
      const sessionId = "runtime-facade-unclean-open-turn-1";
      const runtime = new BrewvaRuntime({ cwd: workspace, config });

      runtime.maintain.context.onTurnStart(sessionId, 2);
      recordRuntimeEvent(runtime, {
        sessionId,
        type: "turn_start",
        turn: 2,
        timestamp: now,
        payload: {
          turnId: "turn-2",
        },
      });
      expect(runtime.authority.skills.activate(sessionId, "design").ok).toBe(true);

      now += 10_000;
      const reloaded = new BrewvaRuntime({ cwd: workspace, config });

      expect(reloaded.inspect.session.getOpenToolCalls(sessionId)).toEqual([]);
      expect(reloaded.inspect.session.getUncleanShutdownDiagnostic(sessionId)).toMatchObject({
        reasons: expect.arrayContaining([
          "open_turn_without_terminal_receipt",
          "active_skill_without_terminal_receipt",
        ]),
        openToolCalls: [],
        openTurns: [
          expect.objectContaining({
            turn: 2,
          }),
        ],
        activeSkill: expect.objectContaining({
          skillName: "design",
          phase: "active",
        }),
        latestEventType: "skill_activated",
      });
      expect(
        reloaded.inspect.events.query(sessionId, { type: "unclean_shutdown_reconciled" }),
      ).toHaveLength(1);
    } finally {
      restoreNow();
    }
  });

  test("events.toStructured mirrors structured queries through the public events facade", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    config.infrastructure.events.level = "debug";
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-structured-events"),
      config,
    });
    const sessionId = "runtime-facade-structured-events-1";

    const recorded = recordRuntimeEvent(runtime, {
      sessionId,
      type: "governance_cost_anomaly_detected",
      turn: 3,
      timestamp: 1_740_000_123_456,
      payload: {
        reason: "looping_token_burn",
      },
    });

    if (!recorded) {
      throw new Error("expected governance event to be recorded at debug level");
    }

    const structured = runtime.inspect.events.toStructured(recorded);
    const listed = runtime.inspect.events.queryStructured(sessionId, {
      type: "governance_cost_anomaly_detected",
    });
    const listedStructured = listed[0];

    if (!listedStructured) {
      throw new Error("expected structured governance event to be queryable");
    }

    expect(structured).toEqual(listedStructured);
    expect(structured).toMatchObject({
      schema: "brewva.event.v1",
      sessionId,
      type: "governance_cost_anomaly_detected",
      category: "governance",
      turn: 3,
      payload: {
        reason: "looping_token_burn",
      },
    });
  });

  test("events facade records typed metric and guard facts and exposes them as state events", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-iteration-facts"),
    });
    const sessionId = "runtime-facade-iteration-facts-1";

    const metricEvent = runtime.authority.events.recordMetricObservation(sessionId, {
      metricKey: "latency_ms",
      value: 118,
      unit: "ms",
      aggregation: "p95",
      iterationKey: "iter-1",
      source: "goal-loop",
      evidenceRefs: ["verification:latency"],
      summary: "Measured after the first causal unit.",
    });
    const guardEvent = runtime.authority.events.recordGuardResult(sessionId, {
      guardKey: "error_budget",
      status: "pass",
      iterationKey: "iter-1",
      source: "goal-loop",
      evidenceRefs: ["slo:error-budget"],
      summary: "Error budget stayed green.",
    });

    expect(metricEvent?.type).toBe("iteration_metric_observed");
    expect(guardEvent?.type).toBe("iteration_guard_recorded");

    expect(
      runtime.inspect.events.listMetricObservations(sessionId, { metricKey: "latency_ms" }),
    ).toEqual([
      expect.objectContaining({
        metricKey: "latency_ms",
        value: 118,
        unit: "ms",
        aggregation: "p95",
        iterationKey: "iter-1",
        source: "goal-loop",
      }),
    ]);
    expect(
      runtime.inspect.events.listGuardResults(sessionId, { guardKey: "error_budget" }),
    ).toEqual([
      expect.objectContaining({
        guardKey: "error_budget",
        status: "pass",
        iterationKey: "iter-1",
        source: "goal-loop",
      }),
    ]);

    const structuredMetric = runtime.inspect.events.queryStructured(sessionId, {
      type: "iteration_metric_observed",
    })[0];
    expect(structuredMetric).toMatchObject({
      type: "iteration_metric_observed",
      category: "state",
      payload: {
        schema: "brewva.iteration-facts.v1",
        kind: "metric_observation",
        metricKey: "latency_ms",
      },
    });
  });

  test("skills.refresh returns structured rebuild details and records an ops receipt when session-bound", () => {
    const workspace = createTestWorkspace("runtime-facade-skill-refresh");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "runtime-facade-skill-refresh-1";

    const refreshed = runtime.maintain.skills.refresh({
      sessionId,
      reason: "unit_test_refresh",
    });

    expect(refreshed.indexPath).toBe(join(workspace, ".brewva", "skills_index.json"));
    expect(refreshed.systemInstall.systemRoot).toContain("/skills/.system");
    expect(refreshed.loadReport.roots.some((entry) => entry.source === "system_root")).toBe(true);
    expect(typeof refreshed.generatedAt).toBe("string");

    const writtenIndex = JSON.parse(readFileSync(refreshed.indexPath, "utf8")) as {
      schemaVersion?: number;
    };
    expect(writtenIndex.schemaVersion).toBe(1);

    expect(
      runtime.inspect.events.query(sessionId, { type: "skill_refresh_recorded" })[0]?.payload,
    ).toMatchObject({
      reason: "unit_test_refresh",
      indexPath: refreshed.indexPath,
      systemInstall: {
        systemRoot: refreshed.systemInstall.systemRoot,
        fingerprint: refreshed.systemInstall.fingerprint,
      },
      summary: {
        loadedSkills: refreshed.loadReport.loadedSkills.length,
        routableSkills: refreshed.loadReport.routableSkills.length,
        hiddenSkills: refreshed.loadReport.hiddenSkills.length,
        overlaySkills: refreshed.loadReport.overlaySkills.length,
      },
    });
  });

  test("tools.start exact-call guard resets when tool name or args change", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-exact-call-guard"),
      config: createOpsRuntimeConfig((config) => {
        config.security.loopDetection.exactCall.enabled = true;
        config.security.loopDetection.exactCall.threshold = 3;
        config.security.loopDetection.exactCall.mode = "block";
      }),
    });
    const sessionId = "runtime-facade-exact-call-guard-1";
    runtime.maintain.tools.registerActionPolicy("browser_snapshot", {
      actionClass: "runtime_observe",
      riskLevel: "low",
      defaultAdmission: "allow",
      maxAdmission: "allow",
      receiptPolicy: { kind: "audit", required: false },
      recoveryPolicy: { kind: "none" },
      effectClasses: ["runtime_observe"],
    });
    runtime.maintain.tools.registerActionPolicy("browser_get", {
      actionClass: "runtime_observe",
      riskLevel: "low",
      defaultAdmission: "allow",
      maxAdmission: "allow",
      receiptPolicy: { kind: "audit", required: false },
      recoveryPolicy: { kind: "none" },
      effectClasses: ["runtime_observe"],
    });

    const start = (toolCallId: string, toolName: string, args: Record<string, unknown>) =>
      runtime.authority.tools.start({
        sessionId,
        toolCallId,
        toolName,
        args,
        cwd: runtime.cwd,
      });

    expect(start("tc-1", "browser_snapshot", { interactive: true }).allowed).toBe(true);
    expect(start("tc-2", "browser_snapshot", { interactive: true }).allowed).toBe(true);
    expect(start("tc-3", "browser_snapshot", { interactive: false }).allowed).toBe(true);
    expect(start("tc-4", "browser_snapshot", { interactive: true }).allowed).toBe(true);
    expect(start("tc-5", "browser_get", { field: "text" }).allowed).toBe(true);
    expect(start("tc-6", "browser_snapshot", { interactive: true }).allowed).toBe(true);
    expect(start("tc-7", "browser_snapshot", { interactive: true }).allowed).toBe(true);

    const blocked = start("tc-8", "browser_snapshot", { interactive: true });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain("identical arguments 3 times consecutively");

    expect(
      runtime.inspect.events.listGuardResults(sessionId, { guardKey: "exact_call_loop" }),
    ).toEqual([
      expect.objectContaining({
        guardKey: "exact_call_loop",
        status: "fail",
      }),
    ]);

    runtime.maintain.tools.unregisterActionPolicy("browser_snapshot");
    runtime.maintain.tools.unregisterActionPolicy("browser_get");
  });

  test("iteration fact helpers stay scoped to the current session", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-iteration-lineage"),
    });
    const parentSessionId = "runtime-facade-iteration-lineage-parent";
    const childSessionId = "runtime-facade-iteration-lineage-child-a";
    const siblingSessionId = "runtime-facade-iteration-lineage-child-b";
    const freshChildSessionId = "runtime-facade-iteration-lineage-fresh";
    const loopSource = "goal-loop:coverage-raise-2026-03-22";

    recordRuntimeEvent(runtime, {
      sessionId: parentSessionId,
      type: "schedule_intent",
      timestamp: 10,
      payload: {
        ...buildScheduleIntentFiredEvent({
          intentId: "coverage-lineage-inherit-a",
          parentSessionId,
          reason: "continue bounded optimization",
          goalRef: loopSource,
          continuityMode: "inherit",
          maxRuns: 5,
          runIndex: 1,
          firedAt: 10,
          nextRunAt: 20,
          childSessionId,
        }),
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId: parentSessionId,
      type: "schedule_intent",
      timestamp: 11,
      payload: {
        ...buildScheduleIntentFiredEvent({
          intentId: "coverage-lineage-inherit-b",
          parentSessionId,
          reason: "continue bounded optimization",
          goalRef: loopSource,
          continuityMode: "inherit",
          maxRuns: 5,
          runIndex: 2,
          firedAt: 11,
          nextRunAt: 21,
          childSessionId: siblingSessionId,
        }),
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId: parentSessionId,
      type: "schedule_intent",
      timestamp: 12,
      payload: {
        ...buildScheduleIntentFiredEvent({
          intentId: "coverage-lineage-fresh",
          parentSessionId,
          reason: "detached follow-up",
          goalRef: loopSource,
          continuityMode: "fresh",
          maxRuns: 5,
          runIndex: 3,
          firedAt: 12,
          nextRunAt: 22,
          childSessionId: freshChildSessionId,
        }),
      },
    });

    const metricSessions = [
      {
        sessionId: parentSessionId,
        value: 72,
        iterationKey: "coverage-loop/run-0/iter-0",
        timestamp: 100,
      },
      {
        sessionId: childSessionId,
        value: 74,
        iterationKey: "coverage-loop/run-1/iter-1",
        timestamp: 110,
      },
      {
        sessionId: siblingSessionId,
        value: 76,
        iterationKey: "coverage-loop/run-2/iter-1",
        timestamp: 120,
      },
      {
        sessionId: freshChildSessionId,
        value: 99,
        iterationKey: "coverage-loop/run-fresh/iter-1",
        timestamp: 130,
      },
    ] as const;

    for (const entry of metricSessions) {
      runtime.authority.events.recordMetricObservation(entry.sessionId, {
        metricKey: "coverage_pct",
        value: entry.value,
        unit: "%",
        aggregation: "last",
        iterationKey: entry.iterationKey,
        source: loopSource,
        timestamp: entry.timestamp,
      });
      runtime.authority.events.recordGuardResult(entry.sessionId, {
        guardKey: "typecheck",
        status: "pass",
        iterationKey: entry.iterationKey,
        source: loopSource,
        timestamp: entry.timestamp + 1,
      });
    }

    runtime.authority.events.recordMetricObservation(childSessionId, {
      metricKey: "coverage_pct",
      value: 55,
      unit: "%",
      aggregation: "last",
      iterationKey: "other-loop/run-1/iter-1",
      source: "goal-loop:other-loop",
      timestamp: 140,
    });

    expect(
      runtime.inspect.events.listMetricObservations(childSessionId, {
        metricKey: "coverage_pct",
        source: loopSource,
        sessionScope: "current_session",
      }),
    ).toEqual([
      expect.objectContaining({
        sessionId: childSessionId,
        value: 74,
      }),
    ]);

    expect(
      runtime.inspect.events.listMetricObservations(childSessionId, {
        metricKey: "coverage_pct",
        source: loopSource,
        sessionScope: "current_session",
      }),
    ).toEqual([
      expect.objectContaining({
        sessionId: childSessionId,
        value: 74,
      }),
    ]);

    expect(
      runtime.inspect.events.listMetricObservations(parentSessionId, {
        metricKey: "coverage_pct",
        source: loopSource,
        sessionScope: "current_session",
      }),
    ).toEqual([expect.objectContaining({ sessionId: parentSessionId, value: 72 })]);

    expect(
      runtime.inspect.events.listGuardResults(childSessionId, {
        guardKey: "typecheck",
        source: loopSource,
        sessionScope: "current_session",
      }),
    ).toHaveLength(1);
  });

  test("context facade normalizes usage ratios, reads stored pressure, and exposes compaction window turns", () => {
    const config = structuredClone(DEFAULT_BREWVA_CONFIG);
    setStaticContextPressureThresholds(config, {
      hardLimitPercent: 0.8,
      compactionThresholdPercent: 0.7,
    });
    config.infrastructure.contextBudget.compaction.minTurnsBetween = 5;
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-context"),
      config,
    });
    const sessionId = "runtime-facade-context-1";

    expect(runtime.inspect.context.getUsageRatio(undefined)).toBeNull();
    expect(
      runtime.inspect.context.getUsageRatio({
        tokens: 950,
        contextWindow: 1_000,
        percent: 95,
      }),
    ).toBe(0.95);

    runtime.maintain.context.observeUsage(sessionId, {
      tokens: 950,
      contextWindow: 1_000,
      percent: 95,
    });

    expect(runtime.inspect.context.getPressureLevel(sessionId)).toBe("critical");
    expect(runtime.inspect.context.getCompactionWindowTurns()).toBe(5);
  });

  test("context facade exposes live prompt stability state without a durable event dependency", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-prompt-stability"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "runtime-facade-prompt-stability-1";

    expect(runtime.inspect.context.getPromptStability(sessionId)).toBeUndefined();

    const observed = runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: sha256("system-prefix"),
      dynamicTailHash: sha256("dynamic-tail"),
      injectionScopeId: "leaf-one",
      turn: 4,
      timestamp: 1_740_000_000_400,
    });

    expect(observed).toEqual({
      turn: 4,
      updatedAt: 1_740_000_000_400,
      scopeKey: "runtime-facade-prompt-stability-1::leaf-one",
      stablePrefixHash: sha256("system-prefix"),
      dynamicTailHash: sha256("dynamic-tail"),
      stablePrefix: true,
      stableTail: true,
    });
    expect(runtime.inspect.context.getPromptStability(sessionId)).toEqual(observed);

    runtime.maintain.session.clearState(sessionId);

    expect(runtime.inspect.context.getPromptStability(sessionId)).toBeUndefined();
  });

  test("context facade exposes transient outbound reduction state without a durable event dependency", () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-transient-reduction"),
      config: createOpsRuntimeConfig(),
    });
    const sessionId = "runtime-facade-transient-reduction-1";

    expect(runtime.inspect.context.getTransientReduction(sessionId)).toBeUndefined();

    const observed = runtime.maintain.context.observeTransientReduction(sessionId, {
      status: "completed",
      reason: null,
      eligibleToolResults: 5,
      clearedToolResults: 1,
      clearedChars: 1536,
      estimatedTokenSavings: 431,
      pressureLevel: "high",
      turn: 5,
      timestamp: 1_740_000_000_500,
    });

    expect(observed).toEqual({
      turn: 5,
      updatedAt: 1_740_000_000_500,
      status: "completed",
      reason: null,
      eligibleToolResults: 5,
      clearedToolResults: 1,
      clearedChars: 1536,
      estimatedTokenSavings: 431,
      pressureLevel: "high",
    });
    expect(runtime.inspect.context.getTransientReduction(sessionId)).toEqual(observed);

    runtime.maintain.session.clearState(sessionId);

    expect(runtime.inspect.context.getTransientReduction(sessionId)).toBeUndefined();
  });

  test("context lifecycle hooks hydrate cold sessions and clear turn-local injection reservations", async () => {
    const runtime = new BrewvaRuntime({
      cwd: createTestWorkspace("runtime-facade-context-lifecycle"),
    });
    const sessionId = "runtime-facade-context-lifecycle-1";
    const sessionState = (
      runtime as unknown as {
        sessionState: {
          getExistingCell(sessionId: string):
            | {
                hydration: { status: string };
                reservedContextInjectionTokensByScope: Map<string, unknown>;
              }
            | undefined;
        };
      }
    ).sessionState;

    expect(sessionState.getExistingCell(sessionId)).toBeUndefined();

    runtime.maintain.context.onUserInput(sessionId);

    expect(sessionState.getExistingCell(sessionId)?.hydration.status).toBe("ready");

    runtime.maintain.context.onTurnStart(sessionId, 1);
    await runtime.maintain.context.buildInjection(
      sessionId,
      "Summarize the current runtime posture.",
      {
        tokens: 256,
        contextWindow: 8_192,
        percent: 0.03,
      },
    );

    expect(
      sessionState.getExistingCell(sessionId)?.reservedContextInjectionTokensByScope.size ?? 0,
    ).toBeGreaterThan(0);

    runtime.maintain.context.onTurnEnd(sessionId);

    expect(sessionState.getExistingCell(sessionId)?.hydration.status).toBe("ready");
    expect(
      sessionState.getExistingCell(sessionId)?.reservedContextInjectionTokensByScope.size ?? 0,
    ).toBe(0);
  });

  test("cost.getSummary returns zeroed state for untouched sessions and keeps per-session totals isolated", () => {
    const runtime = new BrewvaRuntime({ cwd: createTestWorkspace("runtime-facade-cost-summary") });
    const sessionA = "runtime-facade-cost-a";
    const sessionB = "runtime-facade-cost-b";

    expect(runtime.inspect.cost.getSummary(sessionA)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      models: {},
      skills: {},
      tools: {},
      alerts: [],
      budget: {
        action: DEFAULT_BREWVA_CONFIG.infrastructure.costTracking.actionOnExceed,
        sessionExceeded: false,
        blocked: false,
      },
    });

    runtime.maintain.context.onTurnStart(sessionA, 1);
    runtime.authority.tools.markCall(sessionA, "read");
    runtime.authority.cost.recordAssistantUsage({
      sessionId: sessionA,
      model: "test/model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.0002,
    });

    const summaryA = runtime.inspect.cost.getSummary(sessionA);
    const summaryB = runtime.inspect.cost.getSummary(sessionB);

    expect(summaryA.totalTokens).toBe(15);
    expect(summaryA.totalCostUsd).toBe(0.0002);
    expect(summaryA.models["test/model"]?.totalTokens).toBe(15);
    expect(summaryB).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      models: {},
      skills: {},
      tools: {},
      alerts: [],
      budget: {
        action: DEFAULT_BREWVA_CONFIG.infrastructure.costTracking.actionOnExceed,
        sessionExceeded: false,
        blocked: false,
      },
    });
  });

  test("session.applyMergedWorkerResults publishes a merged worker patch and clears transient worker state", () => {
    const workspace = createTestWorkspace("runtime-facade-worker-apply");
    mkdirSync(join(workspace, "src"), { recursive: true });

    const beforeText = "export const facade = 'before';\n";
    const afterText = "export const facade = 'after';\n";
    const filePath = join(workspace, "src", "facade.ts");
    const artifactPath = join(
      workspace,
      ".orchestrator",
      "subagent-patch-artifacts",
      "facade-ps",
      "facade.ts",
    );

    writeFileSync(filePath, beforeText, "utf8");
    mkdirSync(join(workspace, ".orchestrator", "subagent-patch-artifacts", "facade-ps"), {
      recursive: true,
    });
    writeFileSync(artifactPath, afterText, "utf8");

    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "runtime-facade-worker-apply-1";
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.maintain.session.recordWorkerResult(sessionId, {
      workerId: "worker-a",
      status: "ok",
      summary: "worker apply candidate",
      patches: {
        id: "facade-ps",
        createdAt: Date.now(),
        changes: [
          {
            path: "src/facade.ts",
            action: "modify",
            beforeHash: sha256(beforeText),
            afterHash: sha256(afterText),
            artifactRef: ".orchestrator/subagent-patch-artifacts/facade-ps/facade.ts",
          },
        ],
      },
    });

    const report = runtime.authority.session.applyMergedWorkerResults(sessionId, {
      toolName: "worker_results_apply",
      toolCallId: "tc-runtime-facade-worker-apply",
    });

    expect(report.status).toBe("applied");
    expect(report.appliedPaths).toEqual(["src/facade.ts"]);
    expect(readFileSync(filePath, "utf8")).toBe(afterText);
    expect(runtime.inspect.session.listWorkerResults(sessionId)).toHaveLength(0);
  });
});
