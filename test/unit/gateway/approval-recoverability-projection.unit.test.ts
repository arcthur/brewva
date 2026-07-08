import { describe, expect, test } from "bun:test";
import { deriveApprovalReversibility } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/proposal-requests/read-model.js";

// Coupled world rewind RFC, Phase 4: the operator's approval card carries the
// kernel's already-derived recoverability tier (stop dropping it at the
// boundary) plus a coarse workspace-rewindability advisory the world lane
// enables. This is the pure projection over the authority payload; the
// world-availability wiring (previewWorkspaceRewind) is covered by the Phase 2
// world-lane tests.

function authority(input: {
  readonly recoverability?: string;
  readonly effects?: readonly string[];
}): Record<string, unknown> {
  return {
    boundary: "effectful",
    effects: input.effects ?? [],
    riskLevel: "medium",
    manifestBasis: {
      schema: "brewva.effect_authority_basis.v2",
      ...(input.recoverability
        ? { commitmentPosture: { recoverability: input.recoverability } }
        : {}),
    },
  };
}

describe("approval-card reversibility projection (coupled world rewind RFC, Phase 4)", () => {
  test("lifts the kernel recoverability tier off the authority payload", () => {
    expect(
      deriveApprovalReversibility(authority({ recoverability: "manual_recovery" }), false),
    ).toEqual({ recoverability: "manual_recovery" });
  });

  test("carries every kernel tier through unchanged", () => {
    for (const tier of [
      "observe_only",
      "reversible",
      "compensatable",
      "manual_recovery",
      "irreversible",
    ]) {
      expect(deriveApprovalReversibility(authority({ recoverability: tier }), false)).toEqual({
        recoverability: tier,
      });
    }
  });

  test("adds the workspace-rewindable advisory for a workspace-mutating effect under world coverage", () => {
    expect(
      deriveApprovalReversibility(
        authority({ recoverability: "manual_recovery", effects: ["local_exec"] }),
        true,
      ),
    ).toEqual({ recoverability: "manual_recovery", workspaceRewindable: true });
  });

  test("withholds the advisory for a non-workspace effect even under world coverage", () => {
    expect(
      deriveApprovalReversibility(
        authority({ recoverability: "irreversible", effects: ["external_network"] }),
        true,
      ),
    ).toEqual({ recoverability: "irreversible" });
  });

  test("withholds the advisory for a workspace effect when the world lane does not cover the turn", () => {
    expect(
      deriveApprovalReversibility(
        authority({ recoverability: "manual_recovery", effects: ["workspace_write"] }),
        false,
      ),
    ).toEqual({ recoverability: "manual_recovery" });
  });

  test("omits recoverability entirely when the authority payload has no posture", () => {
    expect(deriveApprovalReversibility(authority({ effects: ["local_exec"] }), true)).toEqual({
      workspaceRewindable: true,
    });
  });
});
