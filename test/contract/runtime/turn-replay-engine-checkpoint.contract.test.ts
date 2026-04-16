import { describe, expect, test } from "bun:test";
import {
  TAPE_CHECKPOINT_EVENT_TYPE,
  asBrewvaSessionId,
  buildTapeCheckpointPayload,
  type BrewvaEventRecord,
} from "@brewva/brewva-runtime";
import { TurnReplayEngine } from "@brewva/brewva-runtime/internal";
import { checkpointEvent, taskEvent } from "./turn-replay-engine.helpers.js";

describe("TurnReplayEngine checkpoint replay", () => {
  test("observeEvent applies checkpoint payload and resets folded slices", () => {
    const sessionId = asBrewvaSessionId("replay-engine-observe-checkpoint");
    const events: BrewvaEventRecord[] = [
      taskEvent({
        sessionId,
        id: "evt-task-before",
        timestamp: 1,
        text: "before",
      }),
      {
        id: "evt-cost-before",
        sessionId,
        type: "cost_update",
        timestamp: 2,
        turn: 1,
        payload: {
          model: "test/model",
          skill: "repository-analysis",
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
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const first = engine.replay(sessionId);
    expect(first.taskState.items.map((item) => item.text)).toEqual(["before"]);
    expect(first.costState.summary.totalTokens).toBe(15);

    const checkpoint = checkpointEvent({
      sessionId,
      id: "evt-checkpoint-new",
      timestamp: 3,
      taskState: {
        items: [
          {
            id: "item-after",
            text: "after",
            status: "todo",
            createdAt: 3,
            updatedAt: 3,
          },
        ],
        blockers: [],
        updatedAt: 3,
      },
      truthState: {
        facts: [],
        updatedAt: 3,
      },
    });
    const checkpointPayload = checkpoint.payload as {
      state?: {
        cost?: {
          totalTokens?: number;
        };
        evidence?: {
          totalRecords?: number;
        };
        projection?: {
          unitCount?: number;
        };
      };
    };
    if (
      !checkpointPayload.state?.cost ||
      !checkpointPayload.state.evidence ||
      !checkpointPayload.state.projection
    ) {
      throw new Error("expected checkpoint payload state");
    }
    checkpointPayload.state.cost.totalTokens = 7;
    checkpointPayload.state.evidence.totalRecords = 2;
    checkpointPayload.state.projection.unitCount = 1;

    events.push(checkpoint);
    engine.observeEvent(checkpoint);

    const second = engine.replay(sessionId);
    expect(second.latestEventId).toBe("evt-checkpoint-new");
    expect(second.checkpointEventId).toBe("evt-checkpoint-new");
    expect(second.taskState.items.map((item) => item.text)).toEqual(["after"]);
    expect(second.costState.summary.totalTokens).toBe(7);
    expect(second.evidenceState.totalRecords).toBe(2);
    expect(second.projectionState.unitCount).toBe(1);
  });

  test("checkpoint skill turn map prevents same-turn double count after checkpoint", () => {
    const sessionId = asBrewvaSessionId("replay-engine-checkpoint-cost-turn-map");
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-checkpoint-cost",
        sessionId,
        type: TAPE_CHECKPOINT_EVENT_TYPE,
        timestamp: 1,
        turn: 1,
        payload: buildTapeCheckpointPayload({
          taskState: {
            items: [],
            blockers: [],
            updatedAt: 1,
          },
          truthState: {
            facts: [],
            updatedAt: 1,
          },
          costSummary: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 15,
            totalCostUsd: 0.001,
            models: {
              "test/model": {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 15,
                totalCostUsd: 0.001,
              },
            },
            skills: {
              analysis: {
                inputTokens: 10,
                outputTokens: 5,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                totalTokens: 15,
                totalCostUsd: 0.001,
                usageCount: 1,
                turns: 1,
              },
            },
            tools: {},
            alerts: [],
            budget: {
              action: "warn",
              sessionExceeded: false,
              blocked: false,
            },
          },
          costSkillLastTurnByName: {
            analysis: 1,
          },
          evidenceState: {
            totalRecords: 0,
            failureRecords: 0,
            anchorEpoch: 0,
            recentFailures: [],
            failureClassCounts: {
              execution: 0,
              invocation_validation: 0,
              shell_syntax: 0,
              script_composition: 0,
            },
          },
          projectionState: {
            updatedAt: null,
            unitCount: 0,
          },
          reason: "unit_test",
        }) as unknown as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-cost-tail-same-turn",
        sessionId,
        type: "cost_update",
        timestamp: 2,
        turn: 1,
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
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const view = engine.replay(sessionId);
    expect(view.costState.summary.skills.analysis?.usageCount).toBe(2);
    expect(view.costState.summary.skills.analysis?.turns).toBe(1);
  });

  test("uses event timestamp for budget alert replay", () => {
    const sessionId = asBrewvaSessionId("replay-engine-budget-alert");
    const events: BrewvaEventRecord[] = [
      {
        id: "evt-budget-1",
        sessionId,
        type: "budget_alert",
        timestamp: 42,
        turn: 1,
        payload: {
          kind: "session_threshold",
          scope: "session",
          costUsd: 0.9,
          thresholdUsd: 0.8,
          action: "block_tools",
        } as BrewvaEventRecord["payload"],
      },
      {
        id: "evt-budget-2",
        sessionId,
        type: "budget_alert",
        timestamp: 43,
        turn: 1,
        payload: {
          kind: "session_cap",
          scope: "session",
          costUsd: 1.1,
          thresholdUsd: 1,
          action: "block_tools",
        } as BrewvaEventRecord["payload"],
      },
    ];
    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const first = engine.replay(sessionId);
    expect(first.costState.summary.alerts[0]?.timestamp).toBe(42);
    expect(first.costState.summary.budget.action).toBe("block_tools");
    expect(first.costState.summary.budget.sessionExceeded).toBe(true);
    expect(first.costState.summary.budget.blocked).toBe(true);

    engine.invalidate(sessionId);
    const second = engine.replay(sessionId);
    expect(second.costState.summary.alerts[0]?.timestamp).toBe(42);
  });

  test("ignores checkpoints that still use removed evidence-state fields", () => {
    const sessionId = asBrewvaSessionId("replay-engine-invalid-checkpoint");
    const invalidCheckpoint = checkpointEvent({
      sessionId,
      id: "evt-checkpoint-invalid",
      timestamp: 2,
      taskState: {
        items: [
          {
            id: "item-checkpoint",
            text: "checkpoint-state",
            status: "todo",
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        blockers: [],
        updatedAt: 2,
      },
      truthState: {
        facts: [],
        updatedAt: 2,
      },
    });
    const checkpointPayload = invalidCheckpoint.payload as {
      state?: {
        evidence?: {
          failureClassCounts?: unknown;
        };
      };
    };
    if (!checkpointPayload.state?.evidence) {
      throw new Error("expected checkpoint evidence state");
    }
    delete checkpointPayload.state.evidence.failureClassCounts;

    const events: BrewvaEventRecord[] = [
      taskEvent({
        sessionId,
        id: "evt-task-before-invalid-checkpoint",
        timestamp: 1,
        text: "before",
      }),
      invalidCheckpoint,
      taskEvent({
        sessionId,
        id: "evt-task-after-invalid-checkpoint",
        timestamp: 3,
        text: "after",
      }),
    ];

    const engine = new TurnReplayEngine({
      listEvents: () => events,
      getTurn: () => 1,
    });

    const view = engine.replay(sessionId);
    expect(view.checkpointEventId).toBeNull();
    expect(view.latestEventId).toBe("evt-task-after-invalid-checkpoint");
    expect(view.taskState.items.map((item) => item.text)).toEqual(["before", "after"]);
  });
});
