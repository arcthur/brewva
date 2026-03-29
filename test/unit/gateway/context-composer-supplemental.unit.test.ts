import { describe, expect, test } from "bun:test";
import { buildCapabilityView } from "../../../packages/brewva-gateway/src/runtime-plugins/capability-view.js";
import { resolveSupplementalContextBlocks } from "../../../packages/brewva-gateway/src/runtime-plugins/context-composer-supplemental.js";

describe("context composer supplemental", () => {
  test("derives delegation and diagnostics blocks from runtime state", () => {
    const blocks = resolveSupplementalContextBlocks({
      runtime: {
        events: {
          getTapeStatus: () => ({
            tapePressure: "high",
            entriesSinceAnchor: 9,
          }),
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
});
