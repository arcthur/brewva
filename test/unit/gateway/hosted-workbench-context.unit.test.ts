import { describe, expect, test } from "bun:test";
import type { TapeStatusState } from "@brewva/brewva-vocabulary/session";
import { buildLatestContinuationAnchorBlock } from "../../../packages/brewva-gateway/src/hosted/internal/context/workbench-context.js";
import type { HostedRuntimeAdapterPort } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

function runtimeWithTapeStatus(status: TapeStatusState): HostedRuntimeAdapterPort {
  return {
    ops: {
      tape: {
        status: {
          get: () => status,
        },
      },
    },
  } as unknown as HostedRuntimeAdapterPort;
}

function tapeStatus(lastAnchor: TapeStatusState["lastAnchor"]): TapeStatusState {
  return {
    lastAnchor,
    lastCheckpointId: null,
    tapePressure: "none",
    totalEntries: 1,
    entriesSinceAnchor: 0,
    entriesSinceCheckpoint: 1,
    thresholds: {
      low: 0.35,
      medium: 0.65,
      high: 0.85,
    },
  };
}

describe("hosted workbench context continuation anchor block", () => {
  test("renders latest continuation anchor metadata as bounded baseline context", () => {
    const block = buildLatestContinuationAnchorBlock(
      runtimeWithTapeStatus(
        tapeStatus({
          id: "anchor-1",
          name: "Review anchor",
          summary: "The Work Card path is wired.",
          nextSteps: "Run docs verification.",
        }),
      ),
      "sess_1",
    );

    expect(block?.id).toBe("latest-continuation-anchor");
    expect(block?.content).toContain("[LatestContinuationAnchor]");
    expect(block?.content).toContain("anchor: anchor-1");
    expect(block?.content).toContain("summary: The Work Card path is wired.");
    expect(block?.content).toContain("next_steps: Run docs verification.");
  });

  test("does not render checkpoint-only anchors as continuation anchor context", () => {
    const block = buildLatestContinuationAnchorBlock(
      runtimeWithTapeStatus(tapeStatus({ id: "checkpoint-1" })),
      "sess_1",
    );

    expect(block).toBeNull();
  });
});
