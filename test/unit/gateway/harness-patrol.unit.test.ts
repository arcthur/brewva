import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPreflightHarnessTraceSnapshot,
  clusterHarnessTraceSnapshots,
  compareHarnessCandidate,
  executeHarnessCandidateComparison,
  type HarnessRuntimeFactory,
  toHarnessRuntimeFactory,
} from "@brewva/brewva-gateway/harness";
import { createHostedRuntimeAdapter } from "@brewva/brewva-gateway/hosted";
import type { BrewvaRuntime, CanonicalEvent } from "@brewva/brewva-runtime";
import {
  buildHarnessManifest,
  buildHarnessTraceSnapshotId,
  type HarnessTraceSnapshot,
} from "@brewva/brewva-vocabulary/harness";

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
    const providerFailure = candidates.find((candidate) => candidate.kind === "provider_failure");
    expect(providerFailure).toMatchObject({
      occurrenceCount: 2,
      severity: "high",
      confidence: "high",
      promotionPath: "governed_harness_candidate",
    });
    // Evidence refs: a candidate must point back at the snapshots/events that justify it. The
    // test name claims "with evidence refs", so pin them — silently emptying them now reds.
    expect(providerFailure?.sourceSnapshotIds.toSorted()).toEqual(["a", "b"]);
    expect(providerFailure?.sourceEventIds.toSorted()).toEqual(["event-a", "event-b"]);
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
    const inactive = buildPreflightHarnessTraceSnapshot({
      manifest: buildHarnessManifest({
        sessionId: "source-session",
        attempt: 1,
        provider: {
          providerFallbackHash: "hash:fallback-route",
        },
      }),
    });
    const active = buildPreflightHarnessTraceSnapshot({
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

  test("uses the shared Harness snapshot id basis for preflight snapshots", () => {
    const manifest = buildHarnessManifest({
      sessionId: "source-session",
      turn: 2,
      turnId: "turn-2",
      attempt: 1,
    });
    const preflight = buildPreflightHarnessTraceSnapshot({
      manifest,
      eventIds: ["event-preflight"],
      signals: [
        {
          kind: "provider_failure",
          severity: "high",
          reason: "provider_failure:detected",
          eventIds: ["event-preflight"],
        },
      ],
    });

    expect(preflight.snapshotId).toBe(
      buildHarnessTraceSnapshotId({
        sessionId: manifest.sessionId,
        turn: manifest.turn,
        turnId: manifest.turnId,
        attempt: manifest.attempt,
        manifestId: manifest.manifestId,
      }),
    );
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
      runtime: toHarnessRuntimeFactory(runtime),
      sourceSessionId: "source-session",
      targetSessionId: "target-session",
      divergeAt: "event-source-msg",
      baseManifest,
      candidateManifest,
      executedManifestId: candidateManifest.manifestId,
      workspace: { mode: "shared_operator_cwd" },
      sourceEvents,
      changedFields: ["runtime.configHash"],
    });

    expect(report).toMatchObject({
      mode: "fixture",
      targetSessionId: "target-session",
      sideEffectPolicy: "fixture_provider_and_noop_tools",
      promotion: { recommendation: "review_required" },
    });
    // The harness fork is an independent replay-then-real runtime: WS1 removed
    // the createRuntime swap, so the fork no longer becomes the adapter's
    // runtime. Its target tape (replay + real events) is verified through the
    // report metrics; replay events live only in the fork's in-memory tape.
    expect(report.metrics.execution).toMatchObject({
      executedManifestId: candidateManifest.manifestId,
      workspaceMode: "shared_operator_cwd",
      replayEventCount: 2,
      targetEventCount: 8,
      providerExecuted: true,
      toolExecutorMode: "fixture_noop",
      promptSource: "synthetic",
      toolCallFrameCount: 1,
      toolProgressFrameCount: 1,
    });
    // The adapter's own runtime stays isolated from the fork.
    expect(runtime.runtime.tape.list("source-session")).toEqual([]);
  });

  function forkComparisonInput(behavior: { startThrows?: boolean; turnThrows?: boolean }): {
    runtime: HarnessRuntimeFactory;
    closeCount: () => number;
    input: Parameters<typeof executeHarnessCandidateComparison>[0];
  } {
    let closes = 0;
    const fork = {
      async start() {
        if (behavior.startThrows) {
          throw new Error("harness_fork_start_failed");
        }
        return { recoveredSessions: [] };
      },
      // eslint-disable-next-line require-yield
      async *turn() {
        if (behavior.turnThrows) {
          throw new Error("harness_fork_turn_failed");
        }
      },
      tape: { list: () => [] },
      async close() {
        closes += 1;
      },
    } as unknown as BrewvaRuntime;
    const runtime: HarnessRuntimeFactory = {
      runtime: { tape: { list: () => [] } as unknown as BrewvaRuntime["tape"] },
      createRuntime: () => fork,
    };
    const sourceEvents: CanonicalEvent[] = [
      {
        id: "event-source-start",
        sessionId: "source-session",
        type: "turn.started",
        timestamp: 1,
        payload: { prompt: "recorded task", content: [{ type: "text", text: "recorded task" }] },
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
    return {
      runtime,
      closeCount: () => closes,
      input: {
        mode: "fixture",
        runtime,
        sourceSessionId: "source-session",
        targetSessionId: "target-session",
        divergeAt: "event-source-msg",
        baseManifest,
        candidateManifest,
        executedManifestId: candidateManifest.manifestId,
        workspace: { mode: "shared_operator_cwd" } as const,
        sourceEvents,
        changedFields: ["runtime.configHash"],
      },
    };
  }

  test("a report that did not execute its candidate records the mismatch as a rejecting regression", async () => {
    const { input } = forkComparisonInput({});
    const report = await executeHarnessCandidateComparison({
      ...input,
      executedManifestId: input.baseManifest.manifestId,
    });

    expect(report.metrics.execution).toMatchObject({
      executedManifestId: input.baseManifest.manifestId,
    });
    expect(report.metrics.regressions).toEqual([
      `execution_candidate_delta_not_executed:${input.candidateManifest.manifestId}`,
    ]);
    expect(report.promotion.recommendation).toBe("reject");
  });

  test("execution echoes the materialization and trial-world evidence fields", async () => {
    const { input } = forkComparisonInput({});
    const report = await executeHarnessCandidateComparison({
      ...input,
      workspace: {
        mode: "trial_world",
        root: "/tmp/brewva-harness-trial-x/workspace",
        basisWorldId: "sha256:trial-basis",
        source: "git",
      },
      materializedFields: ["provider.model"],
    });

    expect(report.metrics.execution).toMatchObject({
      workspaceMode: "trial_world",
      materializedFields: ["provider.model"],
      trialWorldBasisId: "sha256:trial-basis",
      trialWorldSource: "git",
    });
  });

  test("real mode re-derives the materialization proof and rejects unmaterializable deltas", async () => {
    const { input } = forkComparisonInput({});
    const report = await executeHarnessCandidateComparison({
      ...input,
      mode: "real",
      ports: {
        provider: {
          async *stream() {
            yield { type: "text" as const, delta: "real probe" };
          },
        },
        toolExecutor: {
          async execute() {
            return { outcome: { kind: "ok" as const, value: {} }, content: "noop" };
          },
        },
      },
      candidateManifest: buildHarnessManifest({
        ...input.baseManifest,
        manifestId: undefined,
        tools: { activeToolNames: ["only-read"] },
      }),
      executedManifestId: input.baseManifest.manifestId,
    });

    // The base fixture carries no tools section, so the candidate's addition
    // diffs at the section level and refuses through the fail-closed
    // unclassified default — equally valid proof the API enforces the seam.
    expect(report.metrics.regressions).toContain(
      "execution_candidate_field_not_materializable:tools",
    );
    expect(report.promotion.recommendation).toBe("reject");
  });

  test("closes the forked harness runtime exactly once on success", async () => {
    const { closeCount, input } = forkComparisonInput({});
    await executeHarnessCandidateComparison(input);
    expect(closeCount()).toBe(1);
  });

  test("closes the forked harness runtime exactly once when start() fails", async () => {
    const { closeCount, input } = forkComparisonInput({ startThrows: true });
    let message: string | undefined;
    try {
      await executeHarnessCandidateComparison(input);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("harness_fork_start_failed");
    expect(closeCount()).toBe(1);
  });

  test("closes the forked harness runtime exactly once when turn() fails", async () => {
    const { closeCount, input } = forkComparisonInput({ turnThrows: true });
    const report = await executeHarnessCandidateComparison(input);
    expect(report.metrics.regressions).toContain("execution_error:harness_fork_turn_failed");
    expect(closeCount()).toBe(1);
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
        runtime: toHarnessRuntimeFactory(runtime),
        sourceSessionId: "source-session",
        targetSessionId: "target-session",
        divergeAt: "event-source-start",
        baseManifest,
        candidateManifest,
        executedManifestId: candidateManifest.manifestId,
        workspace: { mode: "shared_operator_cwd" },
        sourceEvents,
      }),
    ).rejects.toThrow("harness_compare_target_session_must_be_empty");
  });
});
