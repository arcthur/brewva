import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHarnessTraceSnapshot,
  clusterHarnessTraceSnapshots,
  compareHarnessCandidate,
  executeHarnessCandidateComparison,
} from "@brewva/brewva-gateway/harness";
import { createHostedRuntimeAdapter } from "@brewva/brewva-gateway/hosted";
import type { CanonicalEvent } from "@brewva/brewva-runtime";
import { buildHarnessManifest, type HarnessTraceSnapshot } from "@brewva/brewva-vocabulary/harness";

function snapshot(input: {
  id: string;
  manifestId: string;
  signalKinds: HarnessTraceSnapshot["signals"][number]["kind"][];
}): HarnessTraceSnapshot {
  return {
    schema: "brewva.harness.trace_snapshot.v1",
    snapshotId: input.id,
    sessionId: `session-${input.id}`,
    turn: 1,
    attempt: 1,
    manifestId: input.manifestId,
    eventIds: [`event-${input.id}`],
    provider: {
      provider: "faux",
      api: "faux",
      model: "faux-model",
      attempts: 1,
      failures: input.signalKinds.includes("provider_failure") ? 1 : 0,
      fallbackActive: false,
    },
    context: {
      usageRatio: input.signalKinds.includes("context_pressure") ? 0.96 : null,
      gateRequired: input.signalKinds.includes("context_pressure"),
    },
    cache: {
      status: input.signalKinds.includes("cache_regression") ? "break" : null,
      unexpectedBreak: input.signalKinds.includes("cache_regression"),
      changedFields: input.signalKinds.includes("cache_regression") ? ["stablePrefixHash"] : [],
    },
    skills: {
      selectionId: input.signalKinds.includes("skill_surface_miss") ? null : "skill-selection-1",
      selectedSkillIds: [],
      omittedCount: input.signalKinds.includes("skill_surface_miss") ? 1 : 0,
    },
    tools: {
      activeToolNames: ["exec"],
      requestedUnknownToolNames: input.signalKinds.includes("tool_surface_miss")
        ? ["missing_tool"]
        : [],
      committed: input.signalKinds.includes("tool_contract") ? 1 : 0,
      errors: input.signalKinds.includes("tool_contract") ? 1 : 0,
      inconclusive: 0,
    },
    verification: {
      weakEvidence: input.signalKinds.includes("verification_hygiene"),
    },
    outcome: {
      status: input.signalKinds.includes("provider_failure") ? "error" : "ok",
    },
    signals: input.signalKinds.map((kind) => ({
      kind,
      severity: kind === "provider_failure" ? "high" : "medium",
      reason: `${kind}:detected`,
      eventIds: [`event-${input.id}`],
    })),
  };
}

describe("harness patrol", () => {
  test("clusters deterministic candidate classes with evidence refs", () => {
    const candidates = clusterHarnessTraceSnapshots(
      [
        snapshot({ id: "a", manifestId: "manifest-a", signalKinds: ["provider_failure"] }),
        snapshot({ id: "b", manifestId: "manifest-b", signalKinds: ["provider_failure"] }),
        snapshot({ id: "c", manifestId: "manifest-c", signalKinds: ["tool_contract"] }),
        snapshot({ id: "d", manifestId: "manifest-d", signalKinds: ["context_pressure"] }),
        snapshot({ id: "e", manifestId: "manifest-e", signalKinds: ["skill_surface_miss"] }),
        snapshot({ id: "f", manifestId: "manifest-f", signalKinds: ["tool_surface_miss"] }),
        snapshot({ id: "g", manifestId: "manifest-g", signalKinds: ["verification_hygiene"] }),
        snapshot({ id: "h", manifestId: "manifest-h", signalKinds: ["cache_regression"] }),
      ],
      { minOccurrences: 1 },
    );

    expect(candidates.map((candidate) => candidate.kind).toSorted()).toEqual([
      "cache_regression",
      "context_pressure",
      "provider_failure",
      "skill_surface_miss",
      "tool_contract",
      "tool_surface_miss",
      "verification_hygiene",
    ]);
    expect(candidates.find((candidate) => candidate.kind === "provider_failure")).toMatchObject({
      occurrenceCount: 2,
      severity: "high",
      confidence: "high",
      promotionPath: "governed_harness_candidate",
    });
  });

  test("compares manifests without executing provider or tool effects by default", () => {
    const report = compareHarnessCandidate({
      mode: "manifest",
      sourceSessionId: "source-session",
      targetSessionId: "candidate-session",
      divergeAt: "event-diverge",
      baseManifestId: "manifest-base",
      candidateManifestId: "manifest-candidate",
      changedFields: ["prompt.systemPromptHash", "tools.toolSchemaSnapshotHash"],
    });

    expect(report).toMatchObject({
      schema: "brewva.harness.eval_report.v1",
      mode: "manifest",
      sourceSessionId: "source-session",
      targetSessionId: "candidate-session",
      divergeAt: "event-diverge",
      baseManifestId: "manifest-base",
      candidateManifestId: "manifest-candidate",
      sideEffectPolicy: "no_provider_or_tool_execution",
      promotion: {
        recommendation: "review_required",
      },
    });
  });

  test("does not infer active provider fallback from fallback identity hash", () => {
    const inactive = buildHarnessTraceSnapshot({
      manifest: buildHarnessManifest({
        sessionId: "source-session",
        attempt: 1,
        provider: {
          providerFallbackHash: "hash:fallback-route",
        },
      }),
    });
    const active = buildHarnessTraceSnapshot({
      manifest: buildHarnessManifest({
        sessionId: "source-session",
        attempt: 1,
        provider: {
          providerFallbackHash: "hash:fallback-route",
          providerFallbackActive: true,
        },
      }),
    });

    expect(inactive.provider.fallbackActive).toBe(false);
    expect(active.provider.fallbackActive).toBe(true);
  });

  test("requires an explicit target session for real comparisons", () => {
    expect(() =>
      compareHarnessCandidate({
        mode: "real",
        sourceSessionId: "source-session",
        divergeAt: "event-diverge",
        baseManifestId: "manifest-base",
        candidateManifestId: "manifest-candidate",
      }),
    ).toThrow("harness_real_compare_target_session_required");
  });

  test("executes fixture comparison through a replay-then-real target fork", async () => {
    const runtime = createHostedRuntimeAdapter({
      cwd: mkdtempSync(join(tmpdir(), "brewva-harness-fixture-compare-")),
    });
    const sourceEvents: CanonicalEvent[] = [
      {
        id: "event-source-start",
        sessionId: "source-session",
        type: "turn.started",
        timestamp: 1,
        payload: {
          prompt: "recorded task",
          content: [{ type: "text", text: "recorded task" }],
        },
      },
      {
        id: "event-source-msg",
        sessionId: "source-session",
        type: "msg.committed",
        timestamp: 2,
        payload: { text: "recorded answer" },
      },
    ];
    const baseManifest = buildHarnessManifest({
      sessionId: "source-session",
      attempt: 1,
      refs: { sourceEventIds: sourceEvents.map((event) => event.id) },
    });
    const candidateManifest = buildHarnessManifest({
      ...baseManifest,
      manifestId: undefined,
      runtime: { configHash: "runtime_config:candidate" },
    });

    const report = await executeHarnessCandidateComparison({
      mode: "fixture",
      runtime,
      sourceSessionId: "source-session",
      targetSessionId: "target-session",
      divergeAt: "event-source-msg",
      baseManifest,
      candidateManifest,
      sourceEvents,
      changedFields: ["runtime.configHash"],
    });

    expect(report).toMatchObject({
      mode: "fixture",
      targetSessionId: "target-session",
      sideEffectPolicy: "fixture_provider_and_noop_tools",
      promotion: { recommendation: "review_required" },
    });
    expect(report.metrics.execution).toMatchObject({
      replayEventCount: 2,
      providerExecuted: true,
      toolExecutorMode: "fixture_noop",
      promptSource: "synthetic",
      toolCallFrameCount: 1,
      toolProgressFrameCount: 1,
    });
    expect(runtime.runtime.tape.list("source-session")).toEqual([]);
    expect(runtime.runtime.tape.list("target-session").map((event) => event.type)).toEqual([
      "turn.started",
      "msg.committed",
      "turn.started",
      "reason.committed",
      "tool.proposed",
      "tool.committed",
      "msg.committed",
      "turn.ended",
    ]);
  });

  test("rejects replay comparison when the target tape already has events", async () => {
    const runtime = createHostedRuntimeAdapter({
      cwd: mkdtempSync(join(tmpdir(), "brewva-harness-target-nonempty-")),
    });
    runtime.runtime.kernel.recordAdvisoryEvent({
      sessionId: "target-session",
      namespace: "runtime.ops",
      kind: "preexisting_target_event",
      version: 1,
      payload: {},
    });
    const sourceEvents: CanonicalEvent[] = [
      {
        id: "event-source-start",
        sessionId: "source-session",
        type: "turn.started",
        timestamp: 1,
        payload: {
          prompt: "recorded task",
          content: [{ type: "text", text: "recorded task" }],
        },
      },
    ];
    const baseManifest = buildHarnessManifest({
      sessionId: "source-session",
      attempt: 1,
      refs: { sourceEventIds: sourceEvents.map((event) => event.id) },
    });
    const candidateManifest = buildHarnessManifest({
      ...baseManifest,
      manifestId: undefined,
      runtime: { configHash: "runtime_config:candidate" },
    });

    expect(
      executeHarnessCandidateComparison({
        mode: "fixture",
        runtime,
        sourceSessionId: "source-session",
        targetSessionId: "target-session",
        divergeAt: "event-source-start",
        baseManifest,
        candidateManifest,
        sourceEvents,
      }),
    ).rejects.toThrow("harness_compare_target_session_must_be_empty");
  });
});
