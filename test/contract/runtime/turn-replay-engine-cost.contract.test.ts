import { describe, expect, test } from "bun:test";
import { TurnReplayEngine, type BrewvaEventRecord } from "@brewva/brewva-runtime";
import { anchorEvent, toolResultFailureEvent } from "./turn-replay-engine.helpers.js";

describe("TurnReplayEngine cost and evidence folding", () => {
  test("folds cost, projection, and stale failures after anchor expiry", () => {
    const sessionId = "replay-engine-folded-extended";
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-cost-1",
        sessionId,
        type: "cost_update",
        timestamp: 1,
        turn: 1,
        payload: {
          model: "test/model",
          skill: "test/replay",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
          costUsd: 0.001,
          budget: {
            action: "warn",
            sessionExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
      toolResultFailureEvent({
        sessionId,
        id: "evt-tool-fail-1",
        timestamp: 2,
        turn: 1,
        toolName: "exec",
      }),
      {
        id: "evt-projection-refresh-1",
        sessionId,
        type: "projection_refreshed",
        timestamp: 3,
        payload: {
          unitCount: 2,
          updatedAt: 3,
        } as BrewvaEventRecord["payload"],
      },
      anchorEvent({
        sessionId,
        id: "evt-anchor-1",
        timestamp: 4,
      }),
      anchorEvent({
        sessionId,
        id: "evt-anchor-2",
        timestamp: 5,
      }),
      anchorEvent({
        sessionId,
        id: "evt-anchor-3",
        timestamp: 6,
      }),
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const view = engine.replay(sessionId);
    expect(view.costState.summary.totalTokens).toBe(15);
    expect(view.costState.summary.totalCostUsd).toBeCloseTo(0.001, 8);
    expect(view.projectionState.unitCount).toBe(2);
    expect(view.evidenceState.failureRecords).toBe(1);
    expect(view.evidenceState.failureClassCounts.execution).toBe(1);
    expect(view.evidenceState.recentFailures).toHaveLength(0);
  });

  test("preserves failure class in recent tool failures", () => {
    const sessionId = "replay-engine-failure-class";
    const events: BrewvaEventRecord[] = [
      toolResultFailureEvent({
        sessionId,
        id: "evt-tool-failure-class-1",
        timestamp: 1,
        turn: 7,
        toolName: "exec",
        failureClass: "shell_syntax",
      }),
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 7,
    });

    const failures = engine.getRecentToolFailures(sessionId);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.failureClass).toBe("shell_syntax");

    const view = engine.replay(sessionId);
    expect(view.evidenceState.failureClassCounts.shell_syntax).toBe(1);
    expect(view.evidenceState.failureClassCounts.execution).toBe(0);
  });

  test("derives invocation validation counts from failure context when failureClass is missing", () => {
    const sessionId = "replay-engine-derived-invocation-validation";
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-tool-failure-derived-1",
        sessionId,
        type: "tool_result_recorded",
        timestamp: 1,
        turn: 4,
        payload: {
          toolName: "grep",
          verdict: "fail",
          channelSuccess: false,
          failureContext: {
            args: {
              query: "needle",
              case: "loud",
            },
            outputText: "Schema validation failed: case must be equal to constant",
            turn: 4,
            failureClass: null,
          },
        } as BrewvaEventRecord["payload"],
      },
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 4,
    });

    const failures = engine.getRecentToolFailures(sessionId);
    expect(failures[0]?.failureClass).toBe("invocation_validation");

    const view = engine.replay(sessionId);
    expect(view.evidenceState.failureClassCounts.invocation_validation).toBe(1);
    expect(view.evidenceState.failureClassCounts.execution).toBe(0);
  });

  test("folded cost turns count is deduplicated by turn", () => {
    const sessionId = "replay-engine-cost-turns";
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-cost-same-turn-1",
        sessionId,
        type: "cost_update",
        timestamp: 1,
        turn: 2,
        payload: {
          model: "test/model",
          skill: "analysis",
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
          costUsd: 0.001,
          budget: {
            action: "warn",
            sessionExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-cost-same-turn-2",
        sessionId,
        type: "cost_update",
        timestamp: 2,
        turn: 2,
        payload: {
          model: "test/model",
          skill: "analysis",
          inputTokens: 20,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 30,
          costUsd: 0.002,
          budget: {
            action: "warn",
            sessionExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-cost-next-turn",
        sessionId,
        type: "cost_update",
        timestamp: 3,
        turn: 3,
        payload: {
          model: "test/model",
          skill: "analysis",
          inputTokens: 5,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 10,
          costUsd: 0.0005,
          budget: {
            action: "warn",
            sessionExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 3,
    });

    const view = engine.replay(sessionId);
    expect(view.costState.summary.skills.analysis?.usageCount).toBe(3);
    expect(view.costState.summary.skills.analysis?.turns).toBe(2);
  });

  test("folds tool cost allocation from tool_call_marked plus cost_update", () => {
    const sessionId = "replay-engine-cost-tools";
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-tool-call-1",
        sessionId,
        type: "tool_call_marked",
        timestamp: 1,
        turn: 4,
        payload: {
          toolName: "read",
        } as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-tool-call-2",
        sessionId,
        type: "tool_call_marked",
        timestamp: 2,
        turn: 4,
        payload: {
          toolName: "grep",
        } as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-tool-call-3",
        sessionId,
        type: "tool_call_marked",
        timestamp: 3,
        turn: 4,
        payload: {
          toolName: "read",
        } as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-cost-tools",
        sessionId,
        type: "cost_update",
        timestamp: 4,
        turn: 4,
        payload: {
          model: "test/model",
          skill: "analysis",
          inputTokens: 40,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 60,
          costUsd: 0.006,
          budget: {
            action: "warn",
            sessionExceeded: false,
            blocked: false,
          },
        } as BrewvaEventRecord["payload"],
      },
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 4,
    });

    const view = engine.replay(sessionId);
    expect(view.costState.summary.tools.read?.callCount).toBe(2);
    expect(view.costState.summary.tools.grep?.callCount).toBe(1);
    expect(view.costState.summary.tools.read?.allocatedTokens).toBeCloseTo(40, 3);
    expect(view.costState.summary.tools.grep?.allocatedTokens).toBeCloseTo(20, 3);
    expect(view.costState.summary.tools.read?.allocatedCostUsd).toBeCloseTo(0.004, 6);
    expect(view.costState.summary.tools.grep?.allocatedCostUsd).toBeCloseTo(0.002, 6);
  });
});
