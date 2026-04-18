import { describe, expect, test } from "bun:test";
import {
  normalizePlanningArtifactSet,
  PLANNING_NORMALIZER_VERSION,
} from "../../../packages/brewva-runtime/src/skills/planning-normalization.js";

describe("planning normalization", () => {
  test("accepts canonical planning artifact shapes without issues", () => {
    const normalized = normalizePlanningArtifactSet({
      design_spec: "Keep planning artifacts canonical and fail fast on drift.",
      execution_plan: [
        {
          step: "Update the planning normalizer to accept only canonical fields.",
          intent: "Remove compatibility aliases from runtime-owned planning outputs.",
          owner: "runtime.skills",
          exit_criteria: "Alias fields are rejected with blocking issues.",
          verification_intent: "Unit tests prove canonical-only acceptance.",
        },
      ],
      execution_mode_hint: "direct_patch",
      risk_register: [
        {
          risk: "Alias-based planning output could hide producer drift.",
          category: "wire_protocol",
          severity: "high",
          mitigation: "Reject non-canonical fields at normalization time.",
          required_evidence: ["planning_normalization_unit"],
          owner_lane: "review-correctness",
        },
      ],
      implementation_targets: [
        {
          target: "packages/brewva-runtime/src/skills/planning-normalization.ts",
          kind: "module",
          owner_boundary: "runtime.skills",
          reason: "Canonical-only normalization lives here.",
        },
      ],
    });

    expect(normalized.normalizerVersion).toBe(PLANNING_NORMALIZER_VERSION);
    expect(normalized.issues).toEqual([]);
    expect(normalized.artifacts.executionPlan).toHaveLength(1);
    expect(normalized.artifacts.executionModeHint).toBe("direct_patch");
    expect(normalized.artifacts.riskRegister).toHaveLength(1);
    expect(normalized.artifacts.implementationTargets).toHaveLength(1);
  });

  test("rejects compatibility aliases and drifted planning enums instead of silently normalizing them", () => {
    const normalized = normalizePlanningArtifactSet({
      execution_plan: [
        {
          action: "Use the old alias field.",
          goal: "This should no longer normalize.",
          lane: "runtime.skills",
          done_when: "A drifted plan step should fail closed.",
          verify: "Unit tests should catch the rejection.",
        },
      ],
      execution_mode_hint: "direct",
      risk_register: [
        {
          risk: "Old review alias still works.",
          category: "cross_session",
          severity: "priority_high",
          mitigation: "Reject drifted fields.",
          requiredEvidence: ["legacy_alias"],
          ownerLane: "impl",
        },
      ],
      implementation_targets: [
        {
          file: "packages/brewva-runtime/src/contracts/planning.ts",
          type: "module",
          boundary: "runtime.contracts",
          rationale: "Old aliases should not be accepted.",
        },
      ],
    });

    expect(normalized.artifacts.executionPlan).toBeUndefined();
    expect(normalized.artifacts.executionModeHint).toBeUndefined();
    expect(normalized.artifacts.riskRegister).toBeUndefined();
    expect(normalized.artifacts.implementationTargets).toBeUndefined();
    expect(normalized.blockingState.status).toBe("partial");
    expect(normalized.blockingState.unresolved).toEqual(
      expect.arrayContaining([
        "execution_plan",
        "execution_mode_hint",
        "risk_register",
        "implementation_targets",
      ]),
    );
    expect(normalized.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "execution_plan[0]", tier: "tier_b" }),
        expect.objectContaining({ path: "execution_plan[0].step", tier: "tier_b" }),
        expect.objectContaining({ path: "execution_mode_hint", tier: "tier_b" }),
        expect.objectContaining({ path: "risk_register[0]", tier: "tier_b" }),
        expect.objectContaining({ path: "risk_register[0].category", tier: "tier_c" }),
        expect.objectContaining({ path: "risk_register[0].severity", tier: "tier_c" }),
        expect.objectContaining({ path: "risk_register[0].owner_lane", tier: "tier_c" }),
        expect.objectContaining({ path: "risk_register[0].required_evidence", tier: "tier_b" }),
        expect.objectContaining({ path: "implementation_targets[0]", tier: "tier_a" }),
        expect.objectContaining({ path: "implementation_targets[0].target", tier: "tier_b" }),
      ]),
    );
  });
});
