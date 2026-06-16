import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ReasoningCheckpointRecord,
  ReasoningRevertRecord,
} from "@brewva/brewva-vocabulary/iteration";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

// RFC WS3: the reasoning checkpoint/revert query side is a real no-cache projection
// over the durable events that record()/revert() emit — not the prior empty stubs.
describe("reasoning checkpoint/revert projection (RFC WS3)", () => {
  function adapter() {
    return createHostedRuntimeAdapter({ cwd: mkdtempSync(join(tmpdir(), "brewva-reasoning-")) });
  }

  const sessionId = "reasoning-session";

  test("records project back into list/get and gate canRevertTo", () => {
    const reasoning = adapter().ops.reasoning;
    reasoning.checkpoints.record(sessionId, {
      checkpointId: "c1",
      branchId: "main",
      boundary: "manual",
    });

    const list = reasoning.checkpoints.list(sessionId) as ReasoningCheckpointRecord[];
    expect(list.map((checkpoint) => checkpoint.checkpointId)).toEqual(["c1"]);
    expect(
      (reasoning.checkpoints.get(sessionId, "c1") as ReasoningCheckpointRecord)?.checkpointId,
    ).toBe("c1");
    expect(reasoning.checkpoints.get(sessionId, "missing") === undefined).toBe(true);
    expect(reasoning.reverts.canRevertTo(sessionId, "c1")).toBe(true);
    expect(reasoning.reverts.canRevertTo(sessionId, "missing")).toBe(false);
  });

  test("the active branch follows the latest revert", () => {
    const reasoning = adapter().ops.reasoning;
    reasoning.checkpoints.record(sessionId, {
      checkpointId: "c1",
      branchId: "main",
      boundary: "manual",
    });
    reasoning.reverts.revert(sessionId, {
      revertId: "r1",
      toCheckpointId: "c1",
      trigger: "rewind",
      newBranchId: "b1",
    });

    const reverts = reasoning.reverts.list(sessionId) as ReasoningRevertRecord[];
    expect(reverts.map((revert) => revert.revertId)).toEqual(["r1"]);

    const active = reasoning.state.getActive(sessionId);
    expect(active.activeBranchId).toBe("b1");
    expect(active.activeCheckpointId).toBe("c1");
  });
});
