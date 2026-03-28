import { describe, expect, test } from "bun:test";
import { createOptimizationContinuityContextProvider } from "@brewva/brewva-deliberation";
import {
  CONTEXT_SOURCES,
  BrewvaRuntime,
  SKILL_COMPLETED_EVENT_TYPE,
  buildScheduleIntentFiredEvent,
} from "@brewva/brewva-runtime";
import { createOptimizationContinuityTool } from "@brewva/brewva-tools";
import { patchDateNow } from "../../helpers/global-state.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return (
    result.content.find((item) => item.type === "text" && typeof item.text === "string")?.text ?? ""
  );
}

function recordGoalLoopState(runtime: BrewvaRuntime): { loopKey: string; parentSessionId: string } {
  const parentSessionId = "optimization-tool-parent";
  const childSessionId = "optimization-tool-child";
  const freshSessionId = "optimization-tool-fresh";
  const loopKey = "scheduler-verification-2026-03-23";
  const loopSource = `goal-loop:${loopKey}`;

  runtime.events.record({
    sessionId: parentSessionId,
    type: "schedule_intent",
    timestamp: 1_710_100_000_010,
    payload: {
      ...buildScheduleIntentFiredEvent({
        intentId: "verification-inherit",
        parentSessionId,
        reason: "continue bounded verification",
        goalRef: loopSource,
        continuityMode: "inherit",
        maxRuns: 4,
        runIndex: 1,
        firedAt: 1_710_100_000_010,
        nextRunAt: 1_710_100_086_400,
        childSessionId,
      }),
    },
  });
  runtime.events.record({
    sessionId: parentSessionId,
    type: "schedule_intent",
    timestamp: 1_710_100_000_020,
    payload: {
      ...buildScheduleIntentFiredEvent({
        intentId: "verification-fresh",
        parentSessionId,
        reason: "detached experiment",
        goalRef: loopSource,
        continuityMode: "fresh",
        maxRuns: 4,
        runIndex: 2,
        firedAt: 1_710_100_000_020,
        nextRunAt: 1_710_100_172_800,
        childSessionId: freshSessionId,
      }),
    },
  });

  for (const [sessionId, runKey, value] of [
    [parentSessionId, `${loopKey}/run-1`, 3],
    [childSessionId, `${loopKey}/run-2`, 2],
    [freshSessionId, `${loopKey}/run-fresh`, 9],
  ] as const) {
    runtime.events.record({
      sessionId,
      type: SKILL_COMPLETED_EVENT_TYPE,
      timestamp: 1_710_100_000_100 + value,
      payload: {
        skillName: "goal-loop",
        outputs: {
          loop_contract: {
            goal: "Reduce verification failures with bounded retries.",
            scope: ["packages/brewva-runtime/src/services/event-pipeline.ts"],
            cadence: {
              mode: "scheduler",
            },
            continuity_mode: "inherit",
            loop_key: loopKey,
            baseline: {
              value: 3,
              source: loopSource,
            },
            metric: {
              key: "failed_checks",
              direction: "decrease",
            },
            guard: {
              key: "bun-test",
            },
            escalation_policy: {
              owner: "runtime-forensics",
              trigger: "repeated regressions",
            },
            convergence_condition: {
              kind: "max_runs",
              limit: 4,
            },
            max_runs: 4,
          },
          iteration_report: {
            run_key: runKey,
            iteration_key: `${runKey}/iter-1`,
            outcome: value <= 3 ? "progress" : "no_improvement",
            summary: "Recorded another bounded verification run.",
          },
          convergence_report: {
            run_key: runKey,
            status: "continue",
            reason_code: value <= 3 ? "progress" : "detached_branch",
            metric_trajectory_summary: "The inherited lineage still has room to improve.",
          },
          continuation_plan: {
            loop_key: loopKey,
            next_owner: "implementation",
            next_run_trigger: "schedule",
            next_run_timing: "later today",
            next_run_objective: "Reduce remaining failed checks.",
          },
        },
      },
    });
    runtime.events.recordMetricObservation(sessionId, {
      metricKey: "failed_checks",
      value,
      source: loopSource,
      iterationKey: `${runKey}/iter-1`,
      evidenceRefs: [`metric:${sessionId}`],
    });
  }

  return { loopKey, parentSessionId };
}

describe("optimization continuity tool", () => {
  test("lists and shows lineages while keeping provider state aligned with live refresh", async () => {
    const restoreNow = patchDateNow(() => 1_710_100_500_000);
    try {
      const workspace = createTestWorkspace("optimization-continuity-tool");
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const { loopKey, parentSessionId } = recordGoalLoopState(runtime);

      const provider = createOptimizationContinuityContextProvider({
        runtime,
        maxLineages: 2,
        minRefreshIntervalMs: 0,
      });
      const beforeListEntries: Array<{ id: string; content: string }> = [];
      provider.collect({
        sessionId: parentSessionId,
        promptText: "continue the goal-loop and inspect convergence",
        register: (entry) => {
          beforeListEntries.push(entry);
        },
      });
      expect(provider.source).toBe(CONTEXT_SOURCES.optimizationContinuity);
      expect(beforeListEntries.length).toBeGreaterThan(0);

      const tool = createOptimizationContinuityTool({ runtime });
      const listResult = await tool.execute(
        "tc-optimization-continuity-list",
        { action: "list", loop_key: loopKey } as never,
        undefined,
        undefined,
        {} as never,
      );
      const listText = extractText(
        listResult as { content: Array<{ type: string; text?: string }> },
      );
      const listDetails = listResult.details as { lineages?: Array<{ id: string }> } | undefined;
      expect(listText).toContain("# Optimization Continuity Lineages");
      expect(listDetails?.lineages).toHaveLength(2);

      const afterListEntries: Array<{ id: string; content: string }> = [];
      provider.collect({
        sessionId: parentSessionId,
        promptText: "continue the goal-loop and inspect convergence",
        register: (entry) => {
          afterListEntries.push(entry);
        },
      });
      expect(afterListEntries.length).toBeGreaterThan(0);

      const inheritedLineageId = listDetails?.lineages?.find((entry) =>
        entry.id.includes(parentSessionId),
      )?.id;
      expect(typeof inheritedLineageId).toBe("string");

      const showResult = await tool.execute(
        "tc-optimization-continuity-show",
        { action: "show", lineage_id: inheritedLineageId! } as never,
        undefined,
        undefined,
        {} as never,
      );
      const showText = extractText(
        showResult as { content: Array<{ type: string; text?: string }> },
      );
      expect(showText).toContain("# Optimization Continuity");
      expect(showText).toContain("## Continuation");
      expect(showText).toContain("status: scheduled");

      const ambiguousResult = await tool.execute(
        "tc-optimization-continuity-ambiguous",
        { action: "show", loop_key: loopKey } as never,
        undefined,
        undefined,
        {} as never,
      );
      const ambiguousText = extractText(
        ambiguousResult as { content: Array<{ type: string; text?: string }> },
      );
      expect(ambiguousText).toContain("Multiple lineages share loop_key");
      expect((ambiguousResult.details as { error?: string } | undefined)?.error).toBe(
        "multiple_lineages_for_loop_key",
      );
    } finally {
      restoreNow();
    }
  });

  test("surfaces operator attention when a lineage is overdue or running too long", async () => {
    const workspace = createTestWorkspace("optimization-continuity-attention");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const { loopKey } = recordGoalLoopState(runtime);
    const tool = createOptimizationContinuityTool({ runtime });

    const attentionResult = await tool.execute(
      "tc-optimization-continuity-attention",
      {
        action: "attention",
        loop_key: loopKey,
        run_count_floor: 2,
        stale_after_days: 1,
        as_of_ms: 1_710_100_172_800 + 5 * 24 * 60 * 60 * 1000,
      } as never,
      undefined,
      undefined,
      {} as never,
    );
    const attentionText = extractText(
      attentionResult as { content: Array<{ type: string; text?: string }> },
    );
    expect(attentionText).toContain("# Optimization Continuity Attention");
    expect(attentionText).toContain("scheduled continuation is overdue");
    expect(attentionText).toContain("lineage has already consumed 2 run(s)");
    expect(
      (attentionResult.details as { attention?: Array<{ severity: string }> } | undefined)
        ?.attention?.length,
    ).toBeGreaterThan(0);
  });
});
