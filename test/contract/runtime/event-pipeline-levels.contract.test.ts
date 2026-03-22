import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

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

    runtime.events.record({
      sessionId,
      type: "tool_output_observed",
      payload: {
        toolName: "exec",
        rawTokens: 3,
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_execution_end",
      payload: {
        toolName: "exec",
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "exec",
        strategy: "exec_heuristic",
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef: ".orchestrator/tool-output-artifacts/sample.txt",
      },
    });
    runtime.events.record({
      sessionId,
      type: "observability_query_executed",
      payload: {
        toolName: "obs_query",
        queryCount: 1,
        matchCount: 3,
      },
    });
    runtime.events.record({
      sessionId,
      type: "observability_assertion_recorded",
      payload: {
        verdict: "pass",
        metric: "latencyMs",
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_search",
      payload: {
        queryCount: 1,
        resultCount: 2,
        throttleLevel: "normal",
      },
    });

    expect(runtime.events.query(sessionId, { type: "tool_output_observed" })).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "tool_output_distilled" })).toHaveLength(1);
    expect(
      runtime.events.query(sessionId, { type: "tool_output_artifact_persisted" }),
    ).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "observability_query_executed" })).toHaveLength(
      1,
    );
    expect(
      runtime.events.query(sessionId, { type: "observability_assertion_recorded" }),
    ).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "tool_output_search" })).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "tool_execution_end" })).toHaveLength(1);
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
      runtime.events.record({
        sessionId,
        type,
        payload: {
          reason: "unit-test",
        },
      });
    }

    for (const type of governanceTypes) {
      const events = runtime.events.query(sessionId, { type });
      expect(events).toHaveLength(1);
      const structured = runtime.events.queryStructured(sessionId, { type });
      expect(structured[0]?.category).toBe("governance");
    }
  });

  test("keeps observability query telemetry visible at ops level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-observability-")),
      config: createOpsConfig(),
    });
    const sessionId = "ops-level-observability-session";

    runtime.events.record({
      sessionId,
      type: "observability_query_executed",
      payload: {
        toolName: "obs_query",
        queryCount: 1,
        matchCount: 3,
      },
    });

    expect(runtime.events.query(sessionId, { type: "observability_query_executed" })).toHaveLength(
      1,
    );
  });

  test("keeps verification governance verdicts at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-governance-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-governance-session";

    runtime.events.record({
      sessionId,
      type: "governance_verify_spec_failed",
      payload: {
        reason: "spec_mismatch",
      },
    });

    expect(runtime.events.query(sessionId, { type: "governance_verify_spec_failed" })).toHaveLength(
      1,
    );
    expect(
      runtime.events.queryStructured(sessionId, { type: "governance_verify_spec_failed" })[0]
        ?.category,
    ).toBe("governance");
  });

  test("isolates listener failures and records durable telemetry at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-listener-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-listener-error-session";
    const deliveredTypes: string[] = [];

    runtime.events.subscribe((event) => {
      if (event.type === "governance_verify_spec_failed") {
        throw new Error("listener exploded");
      }
    });
    runtime.events.subscribe((event) => {
      deliveredTypes.push(event.type);
    });

    runtime.events.record({
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
    const listenerErrors = runtime.events.query(sessionId, { type: "event_listener_error" });
    expect(listenerErrors).toHaveLength(1);
    expect(listenerErrors[0]?.payload?.sourceEventType).toBe("governance_verify_spec_failed");
    expect(listenerErrors[0]?.payload?.errorMessage).toBe("listener exploded");
  });

  test("drops non-authoritative governance telemetry at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-governance-telemetry-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-governance-telemetry-session";

    runtime.events.record({
      sessionId,
      type: "governance_cost_anomaly_detected",
      payload: {
        reason: "unit-test",
      },
    });

    expect(
      runtime.events.query(sessionId, { type: "governance_cost_anomaly_detected" }),
    ).toHaveLength(0);
  });

  test("keeps normalization telemetry at ops level but drops it at audit level", () => {
    const auditRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-normalizer-")),
      config: createAuditConfig(),
    });
    const opsRuntime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-normalizer-")),
      config: createOpsConfig(),
    });
    const sessionId = "normalizer-level-session";

    auditRuntime.events.record({
      sessionId,
      type: "tool_call_normalized",
      payload: {
        toolCallId: "tc-1",
        toolName: "exec",
        repairKinds: ["double_stringified_arguments"],
      },
    });
    auditRuntime.events.record({
      sessionId,
      type: "tool_call_normalization_failed",
      payload: {
        reason: "invalid_arguments",
        candidateToolName: "exec",
      },
    });
    opsRuntime.events.record({
      sessionId,
      type: "tool_call_normalized",
      payload: {
        toolCallId: "tc-1",
        toolName: "exec",
        repairKinds: ["double_stringified_arguments"],
      },
    });
    opsRuntime.events.record({
      sessionId,
      type: "tool_call_normalization_failed",
      payload: {
        reason: "invalid_arguments",
        candidateToolName: "exec",
      },
    });
    auditRuntime.events.record({
      sessionId,
      type: "model_capability_profile_selected",
      payload: {
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
        profileId: "openai-responses-default",
      },
    });
    opsRuntime.events.record({
      sessionId,
      type: "model_request_patched",
      payload: {
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4",
        profileId: "anthropic-default",
        patchKinds: ["anthropic_named_tool_choice_wrapper_fixed"],
      },
    });

    expect(auditRuntime.events.query(sessionId, { type: "tool_call_normalized" })).toHaveLength(0);
    expect(
      auditRuntime.events.query(sessionId, { type: "tool_call_normalization_failed" }),
    ).toHaveLength(0);
    expect(opsRuntime.events.query(sessionId, { type: "tool_call_normalized" })).toHaveLength(1);
    expect(
      opsRuntime.events.query(sessionId, { type: "tool_call_normalization_failed" }),
    ).toHaveLength(1);
    expect(
      auditRuntime.events.query(sessionId, { type: "model_capability_profile_selected" }),
    ).toHaveLength(0);
    expect(auditRuntime.events.query(sessionId, { type: "model_request_patched" })).toHaveLength(0);
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
      "subagent_completed",
      "subagent_failed",
      "subagent_cancelled",
      "worker_results_applied",
      "worker_results_apply_failed",
    ] as const;

    for (const type of replayCriticalTypes) {
      runtime.events.record({
        sessionId,
        type,
        payload: {
          marker: type,
        },
      });
    }

    for (const type of replayCriticalTypes) {
      expect(runtime.events.query(sessionId, { type })).toHaveLength(1);
    }
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

    auditRuntime.events.record({
      sessionId,
      type: "custom_probe_event",
      payload: {
        source: "contract-test",
      },
    });
    auditRuntime.events.record({
      sessionId,
      type: "context_future_probe",
      payload: {
        source: "contract-test",
      },
    });
    opsRuntime.events.record({
      sessionId,
      type: "custom_probe_event",
      payload: {
        source: "contract-test",
      },
    });
    opsRuntime.events.record({
      sessionId,
      type: "context_future_probe",
      payload: {
        source: "contract-test",
      },
    });

    expect(auditRuntime.events.query(sessionId, { type: "custom_probe_event" })).toHaveLength(1);
    expect(auditRuntime.events.query(sessionId, { type: "context_future_probe" })).toHaveLength(0);
    expect(opsRuntime.events.query(sessionId, { type: "custom_probe_event" })).toHaveLength(1);
    expect(opsRuntime.events.query(sessionId, { type: "context_future_probe" })).toHaveLength(1);
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

    auditRuntime.events.record({
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
    opsRuntime.events.record({
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

    expect(auditRuntime.events.query(sessionId, { type: "task_stuck_detected" })).toHaveLength(0);
    expect(opsRuntime.events.query(sessionId, { type: "task_stuck_detected" })).toHaveLength(1);
  });

  test("classifies model compatibility telemetry as session events at ops level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-ops-model-compat-")),
      config: createOpsConfig(),
    });
    const sessionId = "ops-level-model-compat-session";

    runtime.events.record({
      sessionId,
      type: "model_capability_profile_selected",
      payload: {
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
        profileId: "openai-responses-default",
      },
    });
    runtime.events.record({
      sessionId,
      type: "model_request_patched",
      payload: {
        provider: "openai-codex",
        api: "openai-codex-responses",
        model: "codex-mini-latest",
        profileId: "openai-codex-default",
        patchKinds: ["codex_parallel_tool_calls_defaulted"],
      },
    });

    expect(
      runtime.events.query(sessionId, { type: "model_capability_profile_selected" }),
    ).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "model_request_patched" })).toHaveLength(1);
    expect(
      runtime.events.queryStructured(sessionId, { type: "model_capability_profile_selected" })[0]
        ?.category,
    ).toBe("session");
    expect(
      runtime.events.queryStructured(sessionId, { type: "model_request_patched" })[0]?.category,
    ).toBe("session");
  });
});
