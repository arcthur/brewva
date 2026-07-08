import { describe, expect, test } from "bun:test";
import {
  projectRequirementFitness,
  type RequirementFitnessInput,
} from "@brewva/brewva-vocabulary/fitness";
import type { RequirementAtom } from "@brewva/brewva-vocabulary/task";

// `independenceDebtAtoms` = high-risk (runtime/security) `must` atoms not reaching
// `satisfied` — the atoms an independent perspective is owed on (authorship taints
// verification). A presence grep clears a low-risk atom honestly, and a live fail
// is a discrepancy, not an independence gap; both are excluded.

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

  test("an independent pass AT the risk floor clears the debt (reaches satisfied)", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      independentOutcomes: [
        { atomRefs: ["a"], verdict: "pass", ref: "indep-1", evidenceKind: "static_guard" },
      ],
    });
    expect(projection.independenceDebtAtoms).toEqual([]);
  });

  test("a deterministic pass AT the risk floor clears the debt (no independent read needed)", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      deterministicEvidence: [
        { atomId: "a", verdict: "pass", ref: "g-1", evidenceKind: "static_guard" },
      ],
    });
    expect(projection.independenceDebtAtoms).toEqual([]);
  });

  test("a SUB-FLOOR presence pass leaves the debt (likelySatisfied, still owed an at-grade read)", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      independentOutcomes: [
        { atomRefs: ["a"], verdict: "pass", ref: "indep-1", evidenceKind: "presence" },
      ],
    });
    // presence on a runtime atom caps at `likelySatisfied` — the independence gap is still open
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
      // clear `c` with an at-grade independent pass so it drops out
      independentOutcomes: [
        { atomRefs: ["c"], verdict: "pass", ref: "indep-1", evidenceKind: "static_guard" },
      ],
    });
    expect(projection.independenceDebtAtoms).toEqual(["a"]);
  });

  test("a deterministic SUB-FLOOR presence pass (a machine grep, no independent) is still debt", () => {
    // A static-guard adapter ran but only reached presence grade — a runtime atom
    // still owes an AT-GRADE read; the check that ran was deterministic, not independent.
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      deterministicEvidence: [
        { atomId: "a", verdict: "pass", ref: "g-1", evidenceKind: "presence" },
      ],
    });
    expect(projection.independenceDebtAtoms).toEqual(["a"]);
    // It legitimately co-appears in the ORTHOGONAL grade-debt axis (not a contradiction).
    expect(projection.insufficientGradeAtoms.map((entry) => entry.atomId)).toEqual(["a"]);
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
    // riskClass is set but its floor is `presence`, so self-review clears it honestly —
    // guards against "any riskClass means high-risk".
    const projection = projectRequirementFitness(inputFor([mustAtom("a", "ux")]));
    expect(projection.independenceDebtAtoms).toEqual([]);
    expect(projection.unverifiedMustAtoms).toEqual(["a"]);
  });
});

describe("independenceDebtResolution — the discharge census (report:delegation-evidence)", () => {
  test("an unmet high-risk must atom is open, nothing resolved; open === independenceDebtAtoms.length", () => {
    const projection = projectRequirementFitness(inputFor([mustAtom("a", "runtime")]));
    expect(projection.independenceDebtResolution).toEqual({
      open: 1,
      reviewedSubGrade: 0, // unverified — nobody looked, so not "reviewed sub-grade"
      violated: 0,
      dischargedAtGrade: 0,
    });
    expect(projection.independenceDebtResolution.open).toBe(
      projection.independenceDebtAtoms.length,
    );
  });

  test("an at-grade deterministic pass discharges the atom -> dischargedAtGrade, open drops", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      deterministicEvidence: [
        { atomId: "a", verdict: "pass", ref: "g-1", evidenceKind: "static_guard" },
      ],
    });
    expect(projection.independenceDebtResolution).toEqual({
      open: 0,
      reviewedSubGrade: 0,
      violated: 0,
      dischargedAtGrade: 1,
    });
  });

  test("an independent FAIL on the atom -> violated, NOT open (the review→atom close-edge)", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      independentOutcomes: [{ atomRefs: ["a"], verdict: "fail", ref: "i-1" }],
    });
    expect(projection.independenceDebtResolution).toEqual({
      open: 0,
      reviewedSubGrade: 0,
      violated: 1,
      dischargedAtGrade: 0,
    });
  });

  test("an independent presence-grade pass stays open but counts as reviewedSubGrade", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      independentOutcomes: [
        { atomRefs: ["a"], verdict: "pass", ref: "i-1", evidenceKind: "presence" },
      ],
    });
    // A fresh-context reviewer DID read the atom, but presence-grade cannot clear a
    // runtime floor (grade ceiling) — so it stays `open`, yet is now visible as a
    // review that LOOKED, distinct from an atom nobody touched.
    expect(projection.independenceDebtResolution).toEqual({
      open: 1,
      reviewedSubGrade: 1,
      violated: 0,
      dischargedAtGrade: 0,
    });
    expect(projection.independenceDebtResolution.reviewedSubGrade).toBeLessThanOrEqual(
      projection.independenceDebtResolution.open,
    );
  });

  test("a DETERMINISTIC sub-floor pass is open but NOT reviewedSubGrade (a grep is not a perspective)", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      deterministicEvidence: [
        { atomId: "a", verdict: "pass", ref: "g-1", evidenceKind: "presence" },
      ],
    });
    // `reviewedSubGrade` is the INDEPENDENCE axis: a deterministic presence pass sets
    // grade debt but no independent perspective looked, so it does NOT count here.
    expect(projection.independenceDebtResolution).toEqual({
      open: 1,
      reviewedSubGrade: 0,
      violated: 0,
      dischargedAtGrade: 0,
    });
    expect(projection.insufficientGradeAtoms.map((entry) => entry.atomId)).toEqual(["a"]);
  });

  test("an author-only claim is open but NOT reviewedSubGrade (author coverage is not independent)", () => {
    const projection = projectRequirementFitness({
      ...inputFor([mustAtom("a", "runtime")]),
      authoredOutcomes: [{ atomRefs: ["a"], ref: "auth-1" }],
    });
    expect(projection.independenceDebtResolution).toEqual({
      open: 1,
      reviewedSubGrade: 0,
      violated: 0,
      dischargedAtGrade: 0,
    });
  });

  test("censuses ONLY high-risk must atoms: a mix of open/violated/discharged, low-risk excluded", () => {
    const projection = projectRequirementFitness({
      ...inputFor([
        mustAtom("open", "runtime"),
        mustAtom("broken", "security"),
        mustAtom("clean", "runtime"),
        mustAtom("low", "ux"),
      ]),
      independentOutcomes: [{ atomRefs: ["broken"], verdict: "fail", ref: "i-1" }],
      deterministicEvidence: [
        { atomId: "clean", verdict: "pass", ref: "g-1", evidenceKind: "static_guard" },
      ],
    });
    expect(projection.independenceDebtResolution).toEqual({
      open: 1,
      reviewedSubGrade: 0, // the `open` atom is unverified — no reviewer looked
      violated: 1,
      dischargedAtGrade: 1,
    });
    // The low-risk `must` atom is unverified-must but never enters the high-risk census.
    expect(projection.unverifiedMustAtoms).toContain("low");
  });
});
