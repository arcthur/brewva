import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";

function createAuditConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.events.level = "audit";
  return config;
}

function createOpsConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.events.level = "ops";
  return config;
}

describe("event pipeline level classification", () => {
  test("keeps explicit inspection and recovery receipts visible at audit level while dropping adaptive telemetry", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-session";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_output_observed",
      payload: {
        toolName: "exec",
        rawTokens: 3,
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_execution_end",
      payload: {
        toolName: "exec",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "exec",
        strategy: "exec_heuristic",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef: ".orchestrator/tool-output-artifacts/sample.txt",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "observability_query_executed",
      payload: {
        toolName: "obs_query",
        queryCount: 1,
        matchCount: 3,
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "observability_assertion_recorded",
      payload: {
        verdict: "pass",
        metric: "latencyMs",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "tool_output_search",
      payload: {
        queryCount: 1,
        resultCount: 2,
        throttleLevel: "normal",
      },
    });

    expect(runtime.inspect.events.query(sessionId, { type: "tool_output_observed" })).toHaveLength(
      1,
    );
    expect(runtime.inspect.events.query(sessionId, { type: "tool_output_distilled" })).toHaveLength(
      1,
    );
    expect(
      runtime.inspect.events.query(sessionId, { type: "tool_output_artifact_persisted" }),
    ).toHaveLength(1);
    expect(
      runtime.inspect.events.query(sessionId, { type: "observability_query_executed" }),
    ).toHaveLength(1);
    expect(
      runtime.inspect.events.query(sessionId, { type: "observability_assertion_recorded" }),
    ).toHaveLength(1);
    expect(runtime.inspect.events.query(sessionId, { type: "tool_output_search" })).toHaveLength(1);
    expect(runtime.inspect.events.query(sessionId, { type: "tool_execution_end" })).toHaveLength(1);
  });

  test("keeps governance events visible at ops level with governance category", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-")),
      config: createOpsConfig(),
    });
    const sessionId = "ops-level-governance-session";

    const governanceTypes = [
      "governance_verify_spec_failed",
      "governance_verify_spec_passed",
      "governance_verify_spec_error",
      "governance_cost_anomaly_detected",
      "governance_cost_anomaly_error",
      "governance_compaction_integrity_checked",
      "governance_compaction_integrity_failed",
      "governance_compaction_integrity_error",
    ] as const;

    for (const type of governanceTypes) {
      recordRuntimeEvent(runtime, {
        sessionId,
        type,
        payload: {
          reason: "unit-test",
        },
      });
    }

    for (const type of governanceTypes) {
      const events = runtime.inspect.events.query(sessionId, { type });
      expect(events).toHaveLength(1);
      const structured = runtime.inspect.events.queryStructured(sessionId, { type });
      expect(structured[0]?.category).toBe("governance");
    }
  });

  test("keeps observability query telemetry visible at ops level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-observability-")),
      config: createOpsConfig(),
    });
    const sessionId = "ops-level-observability-session";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "observability_query_executed",
      payload: {
        toolName: "obs_query",
        queryCount: 1,
        matchCount: 3,
      },
    });

    expect(
      runtime.inspect.events.query(sessionId, { type: "observability_query_executed" }),
    ).toHaveLength(1);
  });

  test("keeps verification governance verdicts at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-governance-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-governance-session";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "governance_verify_spec_failed",
      payload: {
        reason: "spec_mismatch",
      },
    });

    expect(
      runtime.inspect.events.query(sessionId, { type: "governance_verify_spec_failed" }),
    ).toHaveLength(1);
    expect(
      runtime.inspect.events.queryStructured(sessionId, {
        type: "governance_verify_spec_failed",
      })[0]?.category,
    ).toBe("governance");
  });

  test("keeps skill promotion lifecycle events visible at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-skill-promotion-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-skill-promotion-session";

    const promotionTypes = [
      "skill_promotion_draft_derived",
      "skill_promotion_reviewed",
      "skill_promotion_promoted",
      "skill_promotion_materialized",
    ] as const;

    for (const type of promotionTypes) {
      recordRuntimeEvent(runtime, {
        sessionId,
        type,
        payload: {
          draftId: "spd:test",
        },
      });
    }

    for (const type of promotionTypes) {
      expect(runtime.inspect.events.query(sessionId, { type })).toHaveLength(1);
      const structured = runtime.inspect.events.queryStructured(sessionId, { type })[0];
      expect(structured?.type).toBe(type);
      expect(structured?.category).toBe("control");
    }
  });

  test("keeps hosted compaction warning events visible at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-compaction-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-compaction-session";

    const compactionTypes = [
      "context_compaction_advisory",
      "context_compaction_requested",
      "context_compaction_gate_armed",
      "critical_without_compact",
    ] as const;

    for (const type of compactionTypes) {
      recordRuntimeEvent(runtime, {
        sessionId,
        type,
        payload: {
          reason: "unit-test",
          requiredTool: "session_compact",
        },
      });
    }

    for (const type of compactionTypes) {
      expect(runtime.inspect.events.query(sessionId, { type })).toHaveLength(1);
    }
  });

  test("keeps read-path and skill diagnosis protocol receipts at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-hosted-protocol-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-hosted-protocol-session";

    for (const type of [
      "tool_read_path_gate_armed",
      "tool_read_path_discovery_observed",
      "skill_diagnosis_derived",
    ] as const) {
      recordRuntimeEvent(runtime, {
        sessionId,
        type,
        payload: {
          reason: "unit-test",
        },
      });
    }

    expect(
      runtime.inspect.events.query(sessionId, { type: "tool_read_path_gate_armed" }),
    ).toHaveLength(1);
    expect(
      runtime.inspect.events.query(sessionId, { type: "tool_read_path_discovery_observed" }),
    ).toHaveLength(1);
    expect(
      runtime.inspect.events.query(sessionId, { type: "skill_diagnosis_derived" }),
    ).toHaveLength(1);
  });

  test("keeps skill refresh receipts at ops level while excluding them from audit retention", () => {
    const auditRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-skill-refresh-")),
      config: createAuditConfig(),
    });
    const opsRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-skill-refresh-")),
      config: createOpsConfig(),
    });

    recordRuntimeEvent(auditRuntime, {
      sessionId: "audit-skill-refresh-session",
      type: "skill_refresh_recorded",
      payload: {
        reason: "audit",
      },
    });
    recordRuntimeEvent(opsRuntime, {
      sessionId: "ops-skill-refresh-session",
      type: "skill_refresh_recorded",
      payload: {
        reason: "ops",
      },
    });

    expect(
      auditRuntime.inspect.events.query("audit-skill-refresh-session", {
        type: "skill_refresh_recorded",
      }),
    ).toHaveLength(0);
    expect(
      opsRuntime.inspect.events.query("ops-skill-refresh-session", {
        type: "skill_refresh_recorded",
      }),
    ).toHaveLength(1);
    expect(
      opsRuntime.inspect.events.queryStructured("ops-skill-refresh-session", {
        type: "skill_refresh_recorded",
      })[0]?.category,
    ).toBe("control");
  });

  test("classifies narrative memory and semantic recall receipts as control events", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-narrative-control-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-narrative-control-session";

    const receiptTypes = [
      "narrative_memory_recorded",
      "narrative_memory_reviewed",
      "narrative_memory_promoted",
      "narrative_memory_archived",
      "narrative_memory_forgotten",
      "semantic_extraction_invoked",
      "semantic_rerank_invoked",
    ] as const;

    for (const type of receiptTypes) {
      recordRuntimeEvent(runtime, {
        sessionId,
        type,
        payload: {
          source: "unit-test",
        },
      });
    }

    for (const type of receiptTypes) {
      expect(runtime.inspect.events.query(sessionId, { type })).toHaveLength(1);
      expect(runtime.inspect.events.queryStructured(sessionId, { type })[0]?.category).toBe(
        "control",
      );
    }
  });

  test("isolates listener failures and records durable telemetry at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-listener-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-listener-error-session";
    const deliveredTypes: string[] = [];

    runtime.inspect.events.subscribe((event) => {
      if (event.type === "governance_verify_spec_failed") {
        throw new Error("listener exploded");
      }
    });
    runtime.inspect.events.subscribe((event) => {
      deliveredTypes.push(event.type);
    });

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "governance_verify_spec_failed",
      payload: {
        reason: "listener-isolation-test",
      },
    });

    expect(deliveredTypes).toContain("governance_verify_spec_failed");
    expect(deliveredTypes.filter((type) => type === "governance_verify_spec_failed")).toHaveLength(
      1,
    );
    const listenerErrors = runtime.inspect.events.query(sessionId, {
      type: "event_listener_error",
    });
    expect(listenerErrors).toHaveLength(1);
    expect(listenerErrors[0]?.payload?.sourceEventType).toBe("governance_verify_spec_failed");
    expect(listenerErrors[0]?.payload?.errorMessage).toBe("listener exploded");
  });

  test("keeps governance anomaly and integrity telemetry at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-governance-telemetry-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-governance-telemetry-session";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "governance_cost_anomaly_detected",
      payload: {
        reason: "unit-test",
      },
    });

    expect(
      runtime.inspect.events.query(sessionId, { type: "governance_cost_anomaly_detected" }),
    ).toHaveLength(1);
  });

  test("keeps approval and delegation lifecycle events at audit level because replay depends on them", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-replay-critical-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-replay-critical-session";
    const replayCriticalTypes = [
      "effect_commitment_approval_requested",
      "effect_commitment_approval_decided",
      "effect_commitment_approval_consumed",
      "subagent_spawned",
      "subagent_running",
      "subagent_completed",
      "subagent_failed",
      "subagent_cancelled",
      "worker_results_applied",
      "worker_results_apply_failed",
    ] as const;

    for (const type of replayCriticalTypes) {
      recordRuntimeEvent(runtime, {
        sessionId,
        type,
        payload: {
          marker: type,
        },
      });
    }

    for (const type of replayCriticalTypes) {
      expect(runtime.inspect.events.query(sessionId, { type })).toHaveLength(1);
    }
    expect(
      runtime.inspect.events.queryStructured(sessionId, {
        type: "effect_commitment_approval_requested",
      })[0]?.category,
    ).toBe("governance");
  });

  test("classifies operator questionnaire receipts as governance at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-operator-question-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-operator-question-session";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "operator_question_answered",
      payload: {
        questionId: "q-1",
        answer: "approved",
      },
    });

    expect(
      runtime.inspect.events.query(sessionId, { type: "operator_question_answered" }),
    ).toHaveLength(1);
    expect(
      runtime.inspect.events.queryStructured(sessionId, { type: "operator_question_answered" })[0]
        ?.category,
    ).toBe("governance");
  });

  test("keeps custom domain events at audit level while reserved runtime prefixes stay fail-closed", () => {
    const auditRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-unknown-")),
      config: createAuditConfig(),
    });
    const opsRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-unknown-")),
      config: createOpsConfig(),
    });
    const sessionId = "unknown-level-session";

    recordRuntimeEvent(auditRuntime, {
      sessionId,
      type: "custom_probe_event",
      payload: {
        source: "contract-test",
      },
    });
    recordRuntimeEvent(auditRuntime, {
      sessionId,
      type: "context_future_probe",
      payload: {
        source: "contract-test",
      },
    });
    recordRuntimeEvent(opsRuntime, {
      sessionId,
      type: "custom_probe_event",
      payload: {
        source: "contract-test",
      },
    });
    recordRuntimeEvent(opsRuntime, {
      sessionId,
      type: "context_future_probe",
      payload: {
        source: "contract-test",
      },
    });

    expect(
      auditRuntime.inspect.events.query(sessionId, { type: "custom_probe_event" }),
    ).toHaveLength(1);
    expect(
      auditRuntime.inspect.events.query(sessionId, { type: "context_future_probe" }),
    ).toHaveLength(0);
    expect(opsRuntime.inspect.events.query(sessionId, { type: "custom_probe_event" })).toHaveLength(
      1,
    );
    expect(
      opsRuntime.inspect.events.query(sessionId, { type: "context_future_probe" }),
    ).toHaveLength(1);
  });

  test("keeps task watchdog events at ops level and drops them at audit level", () => {
    const auditRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-watchdog-")),
      config: createAuditConfig(),
    });
    const opsRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-watchdog-")),
      config: createOpsConfig(),
    });
    const sessionId = "watchdog-events-session";

    recordRuntimeEvent(auditRuntime, {
      sessionId,
      type: "task_stuck_detected",
      payload: {
        schema: "brewva.task-watchdog.v1",
        thresholdMs: 300000,
        baselineProgressAt: 1000,
        detectedAt: 301000,
        idleMs: 300000,
        openItemCount: 0,
      },
    });
    recordRuntimeEvent(opsRuntime, {
      sessionId,
      type: "task_stuck_detected",
      payload: {
        schema: "brewva.task-watchdog.v1",
        thresholdMs: 300000,
        baselineProgressAt: 1000,
        detectedAt: 301000,
        idleMs: 300000,
        openItemCount: 0,
      },
    });

    expect(
      auditRuntime.inspect.events.query(sessionId, { type: "task_stuck_detected" }),
    ).toHaveLength(0);
    expect(
      opsRuntime.inspect.events.query(sessionId, { type: "task_stuck_detected" }),
    ).toHaveLength(1);
  });

  test("keeps task stall adjudication at audit level because inspection surfaces depend on it", () => {
    const auditRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-stall-adjudication-")),
      config: createAuditConfig(),
    });
    const opsRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-stall-adjudication-")),
      config: createOpsConfig(),
    });
    const sessionId = "stall-adjudication-level-session";

    for (const runtime of [auditRuntime, opsRuntime]) {
      recordRuntimeEvent(runtime, {
        sessionId,
        type: "task_stall_adjudicated",
        payload: {
          schema: "brewva.task-stall-adjudication.v1",
          detectedAt: 301000,
          baselineProgressAt: 1000,
          adjudicatedAt: 301500,
          decision: "nudge",
          source: "heuristic",
          rationale: "Recorded blockers explain the stall.",
          signalSummary: ["blockers=1"],
          tapePressure: "low",
          blockerCount: 1,
          blockedToolCount: 0,
          failureCount: 0,
          pendingWorkerResults: 0,
          verificationLastOutcome: null,
          verificationPassed: false,
          verificationSkipped: false,
        },
      });
    }

    expect(
      auditRuntime.inspect.events.query(sessionId, { type: "task_stall_adjudicated" }),
    ).toHaveLength(1);
    expect(
      opsRuntime.inspect.events.query(sessionId, { type: "task_stall_adjudicated" }),
    ).toHaveLength(1);
    expect(
      auditRuntime.inspect.events.queryStructured(sessionId, { type: "task_stall_adjudicated" })[0]
        ?.category,
    ).toBe("state");
  });
});
