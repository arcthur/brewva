import { describe, expect, test } from "bun:test";
import { buildCapabilityView } from "../../../packages/brewva-gateway/src/runtime-plugins/capability-view.js";
import { resolveSupplementalContextBlocks } from "../../../packages/brewva-gateway/src/runtime-plugins/context-composer-supplemental.js";

describe("context composer supplemental", () => {
  test("derives delegation and diagnostics blocks from runtime state", () => {
    const blocks = resolveSupplementalContextBlocks({
      runtime: {
        inspect: {
          events: {
            getTapeStatus: () => ({
              tapePressure: "high",
              entriesSinceAnchor: 9,
            }),
          },
        },
        delegation: {
          listRuns: (_sessionId, query) => {
            if (query?.statuses?.includes("pending")) {
              return [
                {
                  runId: "run-pending",
                  delegate: "worker",
                  label: "search",
                  parentSessionId: "session-1",
                  status: "pending",
                  createdAt: 1,
                  updatedAt: 1,
                },
              ];
            }
            return [
              {
                runId: "run-done",
                delegate: "worker",
                label: "summarize",
                parentSessionId: "session-1",
                status: "completed",
                createdAt: 2,
                updatedAt: 2,
                summary: "done",
                delivery: {
                  mode: "text_only",
                  handoffState: "pending_parent_turn",
                  updatedAt: 2,
                  readyAt: 2,
                },
              },
            ];
          },
        },
      },
      sessionId: "session-1",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "high",
          usageRatio: 0.82,
          hardLimitRatio: 0.95,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        windowTurns: 4,
        lastCompactionTurn: null,
        turnsSinceCompaction: null,
      },
      pendingCompactionReason: "threshold_crossed",
      capabilityView: buildCapabilityView({
        prompt: "inspect $tape_info",
        allTools: [
          {
            name: "tape_info",
            description: "Inspect tape state.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: [],
      }),
    });

    expect(blocks.map((block) => block.id)).toEqual([
      "pending-delegations",
      "completed-delegation-outcomes",
      "operational-diagnostics",
    ]);
    expect(blocks[2]?.content).toContain("requested_by: $tape_info");
    expect(blocks[2]?.content).toContain("tape_pressure: high");
    expect(blocks[2]?.content).toContain("pending_delegations: 1");
  });

  test("sorts delegation diagnostics locally instead of relying on upstream order", () => {
    const blocks = resolveSupplementalContextBlocks({
      runtime: {
        inspect: {
          events: {
            getTapeStatus: () => ({
              tapePressure: "medium",
              entriesSinceAnchor: 3,
            }),
          },
        },
        delegation: {
          listRuns: (_sessionId, query) => {
            if (query?.statuses?.includes("pending")) {
              return [
                {
                  runId: "run-z",
                  delegate: "worker",
                  label: "search",
                  parentSessionId: "session-2",
                  status: "running",
                  createdAt: 2,
                  updatedAt: 2,
                },
                {
                  runId: "run-a",
                  delegate: "worker",
                  label: "review",
                  parentSessionId: "session-2",
                  status: "pending",
                  createdAt: 1,
                  updatedAt: 1,
                },
              ];
            }
            return [
              {
                runId: "run-y",
                delegate: "worker",
                label: "summarize",
                parentSessionId: "session-2",
                status: "completed",
                createdAt: 4,
                updatedAt: 4,
                summary: "later",
                delivery: {
                  mode: "text_only",
                  handoffState: "pending_parent_turn",
                  updatedAt: 4,
                  readyAt: 4,
                },
              },
              {
                runId: "run-b",
                delegate: "worker",
                label: "patch",
                parentSessionId: "session-2",
                status: "completed",
                createdAt: 3,
                updatedAt: 3,
                summary: "earlier",
                delivery: {
                  mode: "text_only",
                  handoffState: "pending_parent_turn",
                  updatedAt: 3,
                  readyAt: 3,
                },
              },
            ];
          },
        },
      },
      sessionId: "session-2",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "medium",
          usageRatio: 0.7,
          hardLimitRatio: 0.95,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        windowTurns: 4,
        lastCompactionTurn: null,
        turnsSinceCompaction: null,
      },
      pendingCompactionReason: "usage_threshold",
      capabilityView: buildCapabilityView({
        prompt: "inspect $obs_snapshot",
        allTools: [
          {
            name: "obs_snapshot",
            description: "Inspect live runtime state.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: [],
      }),
    });

    expect(blocks[0]?.content).toContain("runs: worker/review:pending, worker/search:running");
    expect(blocks[1]?.content).toContain(
      "- worker/patch: completed :: earlier\n- worker/summarize: completed :: later",
    );
    expect(blocks[2]?.content).toContain(
      "pending_delegation_runs: worker/review:pending, worker/search:running",
    );
    expect(blocks[2]?.content).toContain(
      "pending_delegation_outcome_runs: worker/patch:completed, worker/summarize:completed",
    );
  });
});
