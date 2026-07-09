import { describe, expect, test } from "bun:test";
import {
  projectRequirementFitness,
  type RequirementFitnessInput,
} from "@brewva/brewva-vocabulary/fitness";
import type { RequirementAtom } from "@brewva/brewva-vocabulary/task";

// `independenceDebtAtoms` = high-risk (runtime/security) `must` atoms not reaching
// `satisfied` — the atoms an independent perspective is owed on (authorship taints
// verification). Any deterministic OR independent pass clears the debt (there is no
// grade floor); an author-only self-claim (likelySatisfied) does NOT — the authoring
// stream cannot mint the independent perspective on its own work. A presence grep
// clears a low-risk atom honestly, and a live fail is a discrepancy, not an
// independence gap; both are excluded.

function mustAtom(id: string, riskClass?: RequirementAtom["riskClass"]): RequirementAtom {
  return {
    id,
    statement: `s-${id}`,
    modality: "must",
    provenance: "prompt",
    ...(riskClass ? { riskClass } : {}),
  };
}

function inputFor(atoms: readonly RequirementAtom[]): RequirementFitnessInput {
  return {
    atoms,
    findings: [],
    independentOutcomes: [],
    authoredOutcomes: [],
    deterministicEvidence: [],
    appliedPatchSetRefs: [],
    latestTreeMutationAt: null,
  };
}

describe("independenceDebtAtoms — high-risk must atoms owed an independent read", () => {
  test("a high-risk (runtime) must atom with no evidence carries independence debt", () => {
    const projection = projectRequirementFitness(inputFor([mustAtom("a", "runtime")]));
    expect(projection.independenceDebtAtoms).toEqual(["a"]);
  });

  test("a security-class must atom with no evidence carries independence debt", () => {
    const projection = projectRequirementFitness(inputFor([mustAtom("a", "security")]));
    expect(projection.independenceDebtAtoms).toEqual(["a"]);
  });

  test("an independent pass clears the debt (reaches satisfied)", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      independentOutcomes: [{ atomRefs: ["a"], verdict: "pass", ref: "indep-1" }],
    });
    expect(projection.atoms[0]?.state).toBe("satisfied");
    expect(projection.independenceDebtAtoms).toEqual([]);
  });

  test("a deterministic pass clears the debt (no independent read needed)", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      deterministicEvidence: [{ atomId: "a", verdict: "pass", ref: "g-1" }],
    });
    expect(projection.atoms[0]?.state).toBe("satisfied");
    expect(projection.independenceDebtAtoms).toEqual([]);
  });

  test("an author-only self-claim (likelySatisfied) does NOT clear the debt", () => {
    // The core of authorship-taints-verification: a high-risk atom the author
    // merely claims to cover still owes an independent read — a self-attestation
    // is not the perspective the authoring stream cannot mint on its own work.
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      authoredOutcomes: [{ atomRefs: ["a"], ref: "authored-1" }],
    });
    expect(projection.atoms[0]?.state).toBe("likelySatisfied");
    expect(projection.independenceDebtAtoms).toEqual(["a"]);
  });

  test("a violated high-risk must atom is NOT independence debt (it is a discrepancy)", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      deterministicEvidence: [{ atomId: "a", verdict: "fail", ref: "g-1" }],
    });
    expect(projection.independenceDebtAtoms).toEqual([]);
    expect(projection.discrepancies).toHaveLength(1);
  });

  test("a non-high-risk must atom is unverified-must but NOT independence debt", () => {
    const projection = projectRequirementFitness(inputFor([mustAtom("a")])); // presence floor
    expect(projection.unverifiedMustAtoms).toEqual(["a"]);
    expect(projection.independenceDebtAtoms).toEqual([]);
  });

  test("a high-risk should/nice atom is NOT independence debt (only must-modality)", () => {
    const projection = projectRequirementFitness({
      ...inputFor([]),
      atoms: [
        {
          id: "a",
          statement: "s-a",
          modality: "should",
          provenance: "prompt",
          riskClass: "runtime",
        },
        {
          id: "b",
          statement: "s-b",
          modality: "nice",
          provenance: "prompt",
          riskClass: "security",
        },
      ],
    });
    expect(projection.independenceDebtAtoms).toEqual([]);
  });

  test("mixed atoms: only high-risk unmet must atoms land in debt, first-appearance order", () => {
    const projection = projectRequirementFitness({
      ...inputFor([
        mustAtom("a", "runtime"), // debt
        mustAtom("b"), // non-high-risk → not debt
        mustAtom("c", "security"), // debt
      ]),
      // clear `c` with an independent pass so it drops out
      independentOutcomes: [{ atomRefs: ["c"], verdict: "pass", ref: "indep-1" }],
    });
    expect(projection.independenceDebtAtoms).toEqual(["a"]);
  });

  test("an independent FAIL (the second violation channel) also excludes the atom", () => {
    // violated via the finding/independent-fail channel, distinct from the
    // deterministic-fail channel already covered above.
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      independentOutcomes: [{ atomRefs: ["a"], verdict: "fail", ref: "indep-1" }],
    });
    expect(projection.independenceDebtAtoms).toEqual([]);
    expect(projection.discrepancies).toHaveLength(1);
  });

  test("an EXPLICIT low-risk class (ux, presence floor) must atom is NOT debt", () => {
    // riskClass is set but it is not a high-risk class, so self-review clears it
    // honestly — guards against "any riskClass means high-risk".
    const projection = projectRequirementFitness(inputFor([mustAtom("a", "ux")]));
    expect(projection.independenceDebtAtoms).toEqual([]);
    expect(projection.unverifiedMustAtoms).toEqual(["a"]);
  });
});
