import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  absolutizeHarnessDataRoots,
  buildHarnessCandidatePatch,
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
  wrapHarnessManifestRecordedAdvisoryPayload,
  type HarnessManifest,
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

function candidateIdFor(base: HarnessManifest, candidate: HarnessManifest): string {
  return buildHarnessCandidatePatch({ base, candidate }).candidateId;
}

describe("harness patrol", () => {
  test("clusters deterministic pattern classes with evidence refs", () => {
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
    // A pattern is a report artifact, never a decidable candidate: its id is
    // namespaced apart from candidate ids so lifecycle verbs can refuse it.
    expect(providerFailure?.patternId.startsWith("harness_pattern:")).toBe(true);
    // Evidence refs: a candidate must point back at the snapshots/events that justify it. The
    // test name claims "with evidence refs", so pin them — silently emptying them now reds.
    expect(providerFailure?.sourceSnapshotIds.toSorted()).toEqual(["a", "b"]);
    expect(providerFailure?.sourceEventIds.toSorted()).toEqual(["event-a", "event-b"]);
  });

  test("compares manifests without executing provider or tool effects by default", () => {
    const report = compareHarnessCandidate({
      mode: "manifest",
      candidateId: "harness_candidate:manifest-diff-test",
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
      candidateId: "harness_candidate:manifest-diff-test",
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
        candidateId: "harness_candidate:x",
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
      workspace: { mode: "shared_operator_cwd" },
      sourceEvents,
      changedFields: ["runtime.configHash"],
    });

    expect(report).toMatchObject({
      mode: "fixture",
      candidateId: candidateIdFor(baseManifest, candidateManifest),
      targetSessionId: "target-session",
      sideEffectPolicy: "fixture_provider_and_noop_tools",
      promotion: { recommendation: "review_required" },
    });
    // The harness fork is an independent replay-then-real runtime: WS1 removed
    // the createRuntime swap, so the fork no longer becomes the adapter's
    // runtime. Its target tape (replay + real events) is verified through the
    // report metrics; replay events live only in the fork's in-memory tape.
    // A fixture pipeline records no provider manifest, so the executed
    // identity is honestly null — never the candidate's id by assertion.
    expect(report.metrics.execution).toMatchObject({
      executedManifestId: null,
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

  function sourceFixture(): {
    sourceEvents: CanonicalEvent[];
    baseManifest: HarnessManifest;
  } {
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
      provider: { model: "model-base" },
      refs: { sourceEventIds: sourceEvents.map((event) => event.id) },
    });
    return { sourceEvents, baseManifest };
  }

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
    const { sourceEvents, baseManifest } = sourceFixture();
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
        workspace: { mode: "shared_operator_cwd" } as const,
        sourceEvents,
        changedFields: ["runtime.configHash"],
      },
    };
  }

  interface AttachedForkController {
    readonly runtime: BrewvaRuntime;
    bindPorts: (ports: unknown) => void;
    startCount: () => number;
    turnCount: () => number;
    closeCount: () => number;
    boundPorts: () => unknown;
  }

  function attachedFork(targetEvents: () => CanonicalEvent[]): AttachedForkController {
    let starts = 0;
    let turns = 0;
    let closes = 0;
    let bound: unknown;
    let turned = false;
    const runtime = {
      async start() {
        starts += 1;
        return { recoveredSessions: [] };
      },
      // eslint-disable-next-line require-yield
      async *turn() {
        turns += 1;
        turned = true;
      },
      tape: { list: () => (turned ? targetEvents() : []) },
      async close() {
        closes += 1;
      },
    } as unknown as BrewvaRuntime;
    return {
      runtime,
      bindPorts: (ports: unknown) => {
        bound = ports;
      },
      startCount: () => starts,
      turnCount: () => turns,
      closeCount: () => closes,
      boundPorts: () => bound,
    };
  }

  function realPorts(): NonNullable<
    Parameters<typeof executeHarnessCandidateComparison>[0]["ports"]
  > {
    return {
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
    };
  }

  function manifestAdvisoryEvent(manifest: HarnessManifest, id: string): CanonicalEvent {
    const advisory = wrapHarnessManifestRecordedAdvisoryPayload(manifest);
    return {
      id,
      sessionId: manifest.sessionId,
      type: "custom",
      timestamp: 10,
      payload: {
        namespace: advisory.namespace,
        kind: advisory.kind,
        version: advisory.version,
        authority: advisory.authority,
        payload: manifest as unknown as Record<string, unknown>,
      },
    } as CanonicalEvent;
  }

  function realComparisonInput(input: {
    fork: AttachedForkController;
    baseManifest: HarnessManifest;
    candidateManifest: HarnessManifest;
    sourceEvents: CanonicalEvent[];
  }): Parameters<typeof executeHarnessCandidateComparison>[0] {
    return {
      mode: "real",
      runtime: {
        runtime: { tape: { list: () => [] } as unknown as BrewvaRuntime["tape"] },
        createRuntime: () => {
          throw new Error("real_mode_must_not_create_a_second_runtime");
        },
      },
      attachedRuntime: {
        runtime: input.fork.runtime,
        bindPorts: input.fork.bindPorts,
      },
      ports: realPorts(),
      sourceSessionId: "source-session",
      targetSessionId: "target-session",
      divergeAt: "event-source-msg",
      baseManifest: input.baseManifest,
      candidateManifest: input.candidateManifest,
      workspace: {
        mode: "trial_world",
        root: "/tmp/brewva-harness-trial-x/workspace",
        basisWorldId: "sha256:trial-basis",
        source: "git",
        settingsHash: "harness_trial_settings:abc",
      },
      sourceEvents: input.sourceEvents,
      changedFields: ["provider.model"],
    };
  }

  test("real mode verifies the executed delta from the target tape", async () => {
    const { sourceEvents, baseManifest } = sourceFixture();
    const candidateManifest = buildHarnessManifest({
      ...baseManifest,
      manifestId: undefined,
      provider: { model: "model-next" },
    });
    const executedManifest = buildHarnessManifest({
      sessionId: "target-session",
      attempt: 1,
      provider: { model: "model-next" },
    });
    const fork = attachedFork(() => [manifestAdvisoryEvent(executedManifest, "event-manifest")]);

    const report = await executeHarnessCandidateComparison(
      realComparisonInput({ fork, baseManifest, candidateManifest, sourceEvents }),
    );

    // The bound ports are the API's probed view — the probe wrapper adds
    // providerExecuted, proving instrumentation cannot be wired around.
    expect(
      typeof (fork.boundPorts() as { providerExecuted?: unknown } | undefined)?.providerExecuted,
    ).toBe("function");
    expect(fork.startCount()).toBe(1);
    expect(report.metrics.execution).toMatchObject({
      executedManifestId: executedManifest.manifestId,
      deltaVerifiedFields: ["provider.model"],
      materializedFields: ["provider.model"],
      workspaceMode: "trial_world",
      trialWorldBasisId: "sha256:trial-basis",
      trialWorldSource: "git",
      trialSettingsHash: "harness_trial_settings:abc",
    });
    expect(report.metrics.regressions).toEqual([]);
    // The caller owns the attached runtime's lifecycle.
    expect(fork.closeCount()).toBe(0);
  });

  test("real mode records a regression when the tape's manifest contradicts the delta", async () => {
    const { sourceEvents, baseManifest } = sourceFixture();
    const candidateManifest = buildHarnessManifest({
      ...baseManifest,
      manifestId: undefined,
      provider: { model: "model-next" },
    });
    const executedManifest = buildHarnessManifest({
      sessionId: "target-session",
      attempt: 1,
      provider: { model: "model-base" },
    });
    const fork = attachedFork(() => [manifestAdvisoryEvent(executedManifest, "event-manifest")]);

    const report = await executeHarnessCandidateComparison(
      realComparisonInput({ fork, baseManifest, candidateManifest, sourceEvents }),
    );

    expect(report.metrics.execution?.executedManifestId).toBe(executedManifest.manifestId);
    expect(report.metrics.regressions).toEqual([
      "execution_candidate_delta_not_executed:provider.model",
    ]);
    expect(report.promotion.recommendation).toBe("reject");
  });

  test("real mode with no recorded manifest cannot claim the delta executed", async () => {
    const { sourceEvents, baseManifest } = sourceFixture();
    const candidateManifest = buildHarnessManifest({
      ...baseManifest,
      manifestId: undefined,
      provider: { model: "model-next" },
    });
    const fork = attachedFork(() => []);

    const report = await executeHarnessCandidateComparison(
      realComparisonInput({ fork, baseManifest, candidateManifest, sourceEvents }),
    );

    expect(report.metrics.execution?.executedManifestId).toBeNull();
    expect(report.metrics.regressions).toEqual([
      "execution_candidate_delta_not_executed:provider.model",
    ]);
    expect(report.promotion.recommendation).toBe("reject");
  });

  test("a manifest advisory in the REPLAYED prefix is history, not this run's record", async () => {
    const { sourceEvents, baseManifest } = sourceFixture();
    const candidateManifest = buildHarnessManifest({
      ...baseManifest,
      manifestId: undefined,
      provider: { model: "model-next" },
    });
    // The source session recorded a manifest whose model happens to equal the
    // candidate's claim. The fork replays it into the target under a
    // fork-replay id; a continuation that never dispatched must NOT be able
    // to pass delta verification off the replayed history.
    const replayedSourceManifest = buildHarnessManifest({
      sessionId: "target-session",
      attempt: 1,
      provider: { model: "model-next" },
    });
    const replayedAdvisory = {
      ...manifestAdvisoryEvent(replayedSourceManifest, "ignored"),
      id: `evt_replay_${encodeURIComponent("target-session")}_event-source-manifest`,
    } as CanonicalEvent;
    const fork = attachedFork(() => [replayedAdvisory]);

    const report = await executeHarnessCandidateComparison(
      realComparisonInput({ fork, baseManifest, candidateManifest, sourceEvents }),
    );

    expect(report.metrics.execution?.executedManifestId).toBeNull();
    expect(report.metrics.regressions).toEqual([
      "execution_candidate_delta_not_executed:provider.model",
    ]);
    expect(report.promotion.recommendation).toBe("reject");
  });

  test("real mode refuses an unmaterializable delta before any runtime or port exists", async () => {
    const { sourceEvents, baseManifest } = sourceFixture();
    const candidateManifest = buildHarnessManifest({
      ...baseManifest,
      manifestId: undefined,
      tools: { activeToolNames: ["only-read"] },
    });
    const fork = attachedFork(() => []);
    let providerCalls = 0;

    let message: string | undefined;
    try {
      await executeHarnessCandidateComparison({
        ...realComparisonInput({ fork, baseManifest, candidateManifest, sourceEvents }),
        ports: {
          provider: {
            async *stream() {
              providerCalls += 1;
              yield { type: "text" as const, delta: "must never run" };
            },
          },
          toolExecutor: {
            async execute() {
              throw new Error("must never run");
            },
          },
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("harness_candidate_not_materializable");
    expect(message).toContain("tools");
    // Zero side effects: no runtime start, no turn, no provider stream, and
    // the ports were never even bound into the physics.
    expect(fork.startCount()).toBe(0);
    expect(fork.turnCount()).toBe(0);
    expect(providerCalls).toBe(0);
    expect(fork.boundPorts() ?? null).toBe(null);
  });

  test("real mode requires a trial world workspace", async () => {
    const { sourceEvents, baseManifest } = sourceFixture();
    const candidateManifest = buildHarnessManifest({
      ...baseManifest,
      manifestId: undefined,
      provider: { model: "model-next" },
    });
    const fork = attachedFork(() => []);

    expect(
      executeHarnessCandidateComparison({
        ...realComparisonInput({ fork, baseManifest, candidateManifest, sourceEvents }),
        workspace: { mode: "shared_operator_cwd" },
      }),
    ).rejects.toThrow("harness_real_compare_requires_trial_world");
  });

  test("real mode requires the attached single-writer trial runtime", async () => {
    const { sourceEvents, baseManifest } = sourceFixture();
    const candidateManifest = buildHarnessManifest({
      ...baseManifest,
      manifestId: undefined,
      provider: { model: "model-next" },
    });
    const fork = attachedFork(() => []);
    const input = realComparisonInput({ fork, baseManifest, candidateManifest, sourceEvents });

    expect(
      executeHarnessCandidateComparison({
        ...input,
        attachedRuntime: undefined,
      }),
    ).rejects.toThrow("harness_real_compare_requires_attached_runtime");
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

  test("a trial adapter owns fork-rooted identity while durable evidence stays in the operator store", async () => {
    const operatorRoot = mkdtempSync(join(tmpdir(), "brewva-harness-operator-"));
    const trialRoot = mkdtempSync(join(tmpdir(), "brewva-harness-trial-"));
    const operator = createHostedRuntimeAdapter({ cwd: operatorRoot });
    const trialAdapter = createHostedRuntimeAdapter({
      cwd: trialRoot,
      agentId: operator.identity.agentId,
      config: absolutizeHarnessDataRoots(operator),
      toolTargetRootGrants: "descriptor_only",
    });
    try {
      // TrialRunOwner invariant 1: the whole identity roots at the fork, so
      // task descriptors and tool allowed roots resolve inside it and the
      // descriptor seals prompt-derived grants.
      expect(trialAdapter.identity.cwd).toBe(resolve(trialRoot));
      expect(trialAdapter.identity.workspaceRoot).toBe(resolve(trialRoot));
      expect(trialAdapter.ops.task.target.getDescriptor("trial-target-session")).toEqual({
        primaryRoot: resolve(trialRoot),
        roots: [resolve(trialRoot)],
        rootGrants: "descriptor_only",
      });

      // TrialRunOwner invariant 2: durable evidence written through the trial
      // adapter lands in the OPERATOR store (the fork is disposable).
      trialAdapter.runtime.kernel.recordAdvisoryEvent({
        sessionId: "trial-target-session",
        namespace: "runtime.ops",
        kind: "harness_trial_probe",
        version: 1,
        payload: {},
      });
      const operatorTapeDir = join(operatorRoot, ".brewva", "tape");
      const trialTapeDir = join(trialRoot, ".brewva", "tape");
      expect(existsSync(operatorTapeDir)).toBe(true);
      expect(readdirSync(operatorTapeDir).some((name) => name.includes("trial-target"))).toBe(true);
      expect(existsSync(trialTapeDir)).toBe(false);
    } finally {
      await trialAdapter.runtime.close();
      await operator.runtime.close();
    }
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
        workspace: { mode: "shared_operator_cwd" },
        sourceEvents,
      }),
    ).rejects.toThrow("harness_compare_target_session_must_be_empty");
  });
});
