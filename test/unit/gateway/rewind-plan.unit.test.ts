import { describe, expect, test } from "bun:test";
import { deriveRewindPlan } from "../../../packages/brewva-gateway/src/hosted/internal/session/recovery/rewind-plan.js";

describe("rewind plan derivation (RFC WS3)", () => {
  test("conversation-only rewind is a compensation-free fork", () => {
    const plan = deriveRewindPlan({
      mode: "conversation",
      checkpointId: "cp1",
      patchSetIdsAfterCheckpoint: ["p1", "p2"],
    });

    expect(plan.costClass).toBe("fork");
    expect(plan.movesLineage).toBe(true);
    expect(plan.rollbackPatchSetIds).toEqual([]);
    expect(plan.requiresCompensation).toBe(false);
  });

  test("code rewind rolls patch sets back in reverse order and requires compensation", () => {
    const plan = deriveRewindPlan({
      mode: "code",
      checkpointId: "cp1",
      patchSetIdsAfterCheckpoint: ["p1", "p2", "p3"],
    });

    expect(plan.costClass).toBe("transaction");
    expect(plan.rollbackPatchSetIds).toEqual(["p3", "p2", "p1"]);
    expect(plan.requiresCompensation).toBe(true);
    expect(plan.movesLineage).toBe(false);
  });

  test("both rewind moves lineage and rolls workspace back in one transaction", () => {
    const plan = deriveRewindPlan({
      mode: "both",
      checkpointId: "cp1",
      patchSetIdsAfterCheckpoint: ["p1"],
    });

    expect(plan.costClass).toBe("transaction");
    expect(plan.movesLineage).toBe(true);
    expect(plan.rollbackPatchSetIds).toEqual(["p1"]);
    expect(plan.requiresCompensation).toBe(true);
  });

  test("a workspace rewind with no patch sets after the checkpoint needs no compensation", () => {
    const plan = deriveRewindPlan({
      mode: "both",
      checkpointId: "cp1",
      patchSetIdsAfterCheckpoint: [],
    });

    expect(plan.costClass).toBe("transaction");
    expect(plan.rollbackPatchSetIds).toEqual([]);
    expect(plan.requiresCompensation).toBe(false);
  });
});
