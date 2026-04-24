import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  createOptimizationContinuityContextProvider,
  getOrCreateOptimizationContinuityPlane,
  resolveOptimizationContinuityStatePath,
} from "@brewva/brewva-deliberation";
import {
  BrewvaRuntime,
  CONTEXT_SOURCES,
  SKILL_COMPLETED_EVENT_TYPE,
  buildScheduleIntentFiredEvent,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { patchDateNow } from "../../helpers/global-state.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function recordGoalLoopCompletion(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  timestamp: number;
  loopKey: string;
  runKey: string;
  iterationKey: string;
  convergenceStatus?: string;
  convergenceReason?: string;
  nextOwner?: string;
  nextTrigger?: string;
  nextTiming?: string;
}): void {
  recordRuntimeEvent(input.runtime, {
    sessionId: input.sessionId,
    type: SKILL_COMPLETED_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: {
      skillName: "goal-loop",
      outputs: {
        loop_contract: {
          goal: "Raise coverage with bounded iterations.",
          scope: ["packages/brewva-runtime/src/runtime.ts"],
          cadence: {
            mode: "scheduler",
            delay: "1d",
          },
          continuity_mode: "inherit",
          loop_key: input.loopKey,
          baseline: {
            value: 72,
            source: `goal-loop:${input.loopKey}`,
          },
          metric: {
            key: "coverage_pct",
            direction: "increase",
            unit: "%",
            min_delta: 1,
          },
          guard: {
            key: "unit-tests",
          },
          convergence_condition: {
            kind: "max_runs",
            limit: 5,
          },
          max_runs: 5,
          escalation_policy: {
            owner: "design",
            trigger: "three flat runs",
          },
        },
        iteration_report: {
          run_key: input.runKey,
          iteration_key: input.iterationKey,
          outcome: "progress",
          summary: "Coverage improved while the guard stayed green.",
        },
        convergence_report: {
          run_key: input.runKey,
          status: input.convergenceStatus ?? "continue",
          reason_code: input.convergenceReason ?? "progress",
          metric_trajectory_summary: "Trajectory is positive and another bounded run is justified.",
        },
        continuation_plan: {
          loop_key: input.loopKey,
          next_owner: input.nextOwner ?? "implementation",
          next_run_trigger: input.nextTrigger ?? "schedule",
          next_run_timing: input.nextTiming ?? "tomorrow morning",
          next_run_objective: "Tighten coverage on the same runtime surface.",
        },
      },
    },
  });
}

describe("optimization continuity plane", () => {
  test("ignores legacy camelCase goal-loop outputs now that snake_case is canonical", () => {
    const workspace = createTestWorkspace("optimization-continuity-canonical-fields");
    const runtime = new BrewvaRuntime({ cwd: workspace });

    recordRuntimeEvent(runtime, {
      sessionId: "legacy-goal-loop-session",
      type: SKILL_COMPLETED_EVENT_TYPE,
      timestamp: 1_710_000_000_100,
      payload: {
        skillName: "goal-loop",
        outputs: {
          loopContract: {
            loopKey: "coverage-raise-legacy",
            continuityMode: "inherit",
          },
          iterationReport: {
            runKey: "coverage-raise-legacy/run-1",
            iterationKey: "coverage-raise-legacy/run-1/iter-1",
            outcome: "progress",
          },
        },
      },
    });

    const plane = getOrCreateOptimizationContinuityPlane(runtime, {
      minRefreshIntervalMs: 0,
    });
    const state = plane.sync();

    expect(state.lineages).toHaveLength(0);
  });

  test("refreshes provider collection live and separates inherited lineages from fresh branches", async () => {
    const restoreNow = patchDateNow(() => 1_710_000_500_000);
    try {
      const workspace = createTestWorkspace("optimization-continuity-plane");
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const statePath = resolveOptimizationContinuityStatePath(workspace);

      const parentSessionId = "opt-lineage-parent";
      const childSessionId = "opt-lineage-child";
      const freshSessionId = "opt-lineage-fresh";
      const loopKey = "coverage-raise-2026-03-23";
      const loopSource = `goal-loop:${loopKey}`;

      recordRuntimeEvent(runtime, {
        sessionId: parentSessionId,
        type: "schedule_intent",
        timestamp: 1_710_000_000_010,
        payload: {
          ...buildScheduleIntentFiredEvent({
            intentId: "coverage-inherit-run",
            parentSessionId,
            reason: "continue bounded optimization",
            goalRef: loopSource,
            continuityMode: "inherit",
            maxRuns: 5,
            runIndex: 1,
            firedAt: 1_710_000_000_010,
            nextRunAt: 1_710_000_086_400,
            childSessionId,
          }),
        },
      });
      recordRuntimeEvent(runtime, {
        sessionId: parentSessionId,
        type: "schedule_intent",
        timestamp: 1_710_000_000_020,
        payload: {
          ...buildScheduleIntentFiredEvent({
            intentId: "coverage-fresh-run",
            parentSessionId,
            reason: "detached exploration branch",
            goalRef: loopSource,
            continuityMode: "fresh",
            maxRuns: 5,
            runIndex: 2,
            firedAt: 1_710_000_000_020,
            nextRunAt: 1_710_000_172_800,
            childSessionId: freshSessionId,
          }),
        },
      });

      recordGoalLoopCompletion({
        runtime,
        sessionId: parentSessionId,
        timestamp: 1_710_000_000_100,
        loopKey,
        runKey: `${loopKey}/run-1`,
        iterationKey: `${loopKey}/run-1/iter-1`,
      });
      recordGoalLoopCompletion({
        runtime,
        sessionId: childSessionId,
        timestamp: 1_710_000_000_200,
        loopKey,
        runKey: `${loopKey}/run-2`,
        iterationKey: `${loopKey}/run-2/iter-1`,
      });

      runtime.authority.events.recordMetricObservation(parentSessionId, {
        metricKey: "coverage_pct",
        value: 72,
        unit: "%",
        source: loopSource,
        iterationKey: `${loopKey}/run-1/baseline`,
        evidenceRefs: ["task:baseline"],
        summary: "Initial baseline",
      });
      runtime.authority.events.recordMetricObservation(childSessionId, {
        metricKey: "coverage_pct",
        value: 76,
        unit: "%",
        source: loopSource,
        iterationKey: `${loopKey}/run-2/iter-1`,
        evidenceRefs: ["task:run-2"],
        summary: "Improved after implementation pass",
      });
      runtime.authority.events.recordGuardResult(childSessionId, {
        guardKey: "unit-tests",
        status: "pass",
        source: loopSource,
        iterationKey: `${loopKey}/run-2/iter-1`,
        evidenceRefs: ["verify:run-2"],
        summary: "Guard remained green",
      });

      runtime.authority.events.recordMetricObservation(freshSessionId, {
        metricKey: "coverage_pct",
        value: 99,
        unit: "%",
        source: loopSource,
        iterationKey: `${loopKey}/run-fresh/iter-1`,
        evidenceRefs: ["task:fresh"],
        summary: "Detached branch should not join inherited lineage",
      });

      const provider = createOptimizationContinuityContextProvider({
        runtime,
        maxLineages: 2,
        minRefreshIntervalMs: 0,
      });
      const beforeSyncEntries: Array<{ id: string; content: string }> = [];
      await provider.collect({
        sessionId: parentSessionId,
        promptText: "continue the goal-loop and inspect metric convergence",
        register: (entry) => {
          beforeSyncEntries.push(entry);
        },
      });

      expect(provider.source).toBe(CONTEXT_SOURCES.optimizationContinuity);
      expect(beforeSyncEntries.length).toBeGreaterThan(0);
      expect(existsSync(statePath)).toBe(true);

      const plane = getOrCreateOptimizationContinuityPlane(runtime, {
        minRefreshIntervalMs: 0,
      });
      const state = plane.sync();

      expect(existsSync(statePath)).toBe(true);
      expect(state.lineages).toHaveLength(2);

      const inheritedLineage = state.lineages.find(
        (lineage) => lineage.rootSessionId === parentSessionId,
      );
      const freshLineage = state.lineages.find(
        (lineage) => lineage.rootSessionId === freshSessionId,
      );

      expect(inheritedLineage?.metric?.latestValue).toBe(76);
      expect(inheritedLineage?.metric?.direction).toBe("increase");
      expect(inheritedLineage?.continuityMode).toBe("inherit");
      expect(inheritedLineage?.lineageSessionIds).toEqual([childSessionId, parentSessionId]);
      expect(inheritedLineage?.metadata).toEqual({
        stuckSignalCount: 0,
        latestIterationOutcome: "progress",
        nextRunAt: 1_710_000_086_400,
      });
      expect(inheritedLineage?.status).toBe("scheduled");
      expect(freshLineage?.metric?.latestValue).toBe(99);
      expect(freshLineage?.continuityMode).toBe("fresh");
      expect(freshLineage?.lineageSessionIds).toEqual([freshSessionId]);

      const afterSyncEntries: Array<{ id: string; content: string }> = [];
      await provider.collect({
        sessionId: parentSessionId,
        promptText: "continue the goal-loop and inspect metric convergence",
        register: (entry) => {
          afterSyncEntries.push(entry);
        },
      });

      expect(afterSyncEntries.length).toBeGreaterThan(0);
      expect(afterSyncEntries[0]?.content).toContain("[OptimizationContinuity]");
      expect(afterSyncEntries[0]?.content).toContain(`loop_key: ${loopKey}`);
    } finally {
      restoreNow();
    }
  });
});
