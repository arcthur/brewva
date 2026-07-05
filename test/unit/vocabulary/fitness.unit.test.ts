import { describe, expect, test } from "bun:test";
import {
  ATOM_FITNESS_STATES,
  projectRequirementFitness,
  type FitnessReviewFinding,
  type RequirementFitnessInput,
} from "@brewva/brewva-vocabulary/fitness";
import type { ReviewFindingRecordedEventPayload } from "@brewva/brewva-vocabulary/review";
import type { RequirementAtom } from "@brewva/brewva-vocabulary/task";

function atom(id: string, overrides: Partial<Omit<RequirementAtom, "id">> = {}): RequirementAtom {
  return {
    id,
    statement: `statement for ${id}`,
    modality: overrides.modality ?? "must",
    provenance: overrides.provenance ?? "prompt",
    ...overrides,
  };
}

function finding(
  overrides: Partial<ReviewFindingRecordedEventPayload> & { atomRefs: readonly string[] },
): ReviewFindingRecordedEventPayload {
  return {
    findingId: overrides.findingId ?? "finding-1",
    severity: overrides.severity ?? "high",
    category: overrides.category ?? "correctness",
    statement: overrides.statement ?? "finding statement",
    anchors: overrides.anchors ?? [],
    lens: overrides.lens ?? null,
    targetRef: overrides.targetRef ?? { kind: "patch_sets", patchSetRefs: ["ps-1"] },
    atomRefs: overrides.atomRefs,
  };
}

/** A finding paired with its own receipt timestamp, wrapped for the input. */
function findingReceipt(
  payload: ReviewFindingRecordedEventPayload,
  receiptTimestamp = 100,
): FitnessReviewFinding {
  return { finding: payload, receiptTimestamp };
}

/** Base input: a current tree at patch-set `ps-1`, no evidence at all. */
function baseInput(atoms: readonly RequirementAtom[]): RequirementFitnessInput {
  return {
    atoms,
    findings: [],
    independentOutcomes: [],
    authoredOutcomes: [],
    deterministicEvidence: [],
    appliedPatchSetRefs: ["ps-1"],
    latestTreeMutationAt: null,
  };
}

describe("ATOM_FITNESS_STATES", () => {
  test("pins the exact state vocabulary and order", () => {
    expect(ATOM_FITNESS_STATES).toEqual([
      "satisfied",
      "likelySatisfied",
      "violated",
      "unverified",
      "notApplicable",
    ]);
  });
});

describe("projectRequirementFitness: unverified (no evidence)", () => {
  test("an atom with no evidence is unverified", () => {
    const projection = projectRequirementFitness(baseInput([atom("a")]));

    expect(projection.atoms).toEqual([{ atomId: "a", state: "unverified", evidence: [] }]);
    expect(projection.counts).toEqual({
      satisfied: 0,
      likelySatisfied: 0,
      violated: 0,
      unverified: 1,
      notApplicable: 0,
    });
    expect(projection.discrepancies).toEqual([]);
    expect(projection.unverifiedMustAtoms).toEqual(["a"]);
  });
});

describe("projectRequirementFitness: satisfied", () => {
  test("deterministic pass keyed to the atom satisfies it", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      deterministicEvidence: [{ atomId: "a", verdict: "pass", ref: "gate-1" }],
    });

    expect(projection.atoms[0]?.state).toBe("satisfied");
    expect(projection.atoms[0]?.evidence).toEqual([
      { kind: "deterministic", ref: "gate-1", verdict: "pass" },
    ]);
    expect(projection.unverifiedMustAtoms).toEqual([]);
    expect(projection.discrepancies).toEqual([]);
  });

  test("independent outcome naming the atom satisfies it", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      independentOutcomes: [{ atomRefs: ["a"], verdict: "pass", ref: "indep-1" }],
    });

    expect(projection.atoms[0]?.state).toBe("satisfied");
    expect(projection.atoms[0]?.evidence).toEqual([
      { kind: "independent_outcome", ref: "indep-1", verdict: "pass" },
    ]);
  });

  test("an independent outcome that does NOT name the atom does not satisfy it", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      independentOutcomes: [{ atomRefs: ["other"], verdict: "pass", ref: "indep-1" }],
    });

    expect(projection.atoms[0]?.state).toBe("unverified");
  });
});

describe("projectRequirementFitness: likelySatisfied", () => {
  test("author-claimed coverage alone yields at most likelySatisfied", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      authoredOutcomes: [{ atomRefs: ["a"], ref: "authored-1" }],
    });

    expect(projection.atoms[0]?.state).toBe("likelySatisfied");
    expect(projection.atoms[0]?.evidence).toEqual([{ kind: "authored", ref: "authored-1" }]);
    expect(projection.unverifiedMustAtoms).toEqual([]);
  });

  test("independent evidence upgrades authored coverage to satisfied", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      authoredOutcomes: [{ atomRefs: ["a"], ref: "authored-1" }],
      independentOutcomes: [{ atomRefs: ["a"], verdict: "pass", ref: "indep-1" }],
    });

    expect(projection.atoms[0]?.state).toBe("satisfied");
  });
});

describe("projectRequirementFitness: violated + graded discrepancies", () => {
  test("deterministic fail -> violated graded deterministic_conflict", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a", { statement: "atom a statement" })]),
      deterministicEvidence: [{ atomId: "a", verdict: "fail", ref: "gate-1" }],
    });

    expect(projection.atoms[0]?.state).toBe("violated");
    expect(projection.discrepancies).toEqual([
      {
        atomId: "a",
        grade: "deterministic_conflict",
        statement: "atom a statement",
        evidenceRef: "gate-1",
      },
    ]);
  });

  test("review finding -> violated graded advisory_conflict", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a", { statement: "atom a statement" })]),
      findings: [findingReceipt(finding({ findingId: "f-1", atomRefs: ["a"] }))],
    });

    expect(projection.atoms[0]?.state).toBe("violated");
    expect(projection.discrepancies).toEqual([
      {
        atomId: "a",
        grade: "advisory_conflict",
        statement: "atom a statement",
        evidenceRef: "f-1",
      },
    ]);
  });

  test("a finding with severity below error still violates (any live finding on the atom is a conflict)", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      findings: [findingReceipt(finding({ findingId: "f-low", severity: "low", atomRefs: ["a"] }))],
    });

    expect(projection.atoms[0]?.state).toBe("violated");
    expect(projection.discrepancies[0]?.grade).toBe("advisory_conflict");
  });
});

describe("projectRequirementFitness: both-evidence conflict (fail dominates pass)", () => {
  test("a satisfying independent pass AND a violating deterministic fail -> violated, not masked", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a", { statement: "atom a statement" })]),
      independentOutcomes: [{ atomRefs: ["a"], verdict: "pass", ref: "indep-1" }],
      deterministicEvidence: [{ atomId: "a", verdict: "fail", ref: "gate-1" }],
    });

    expect(projection.atoms[0]?.state).toBe("violated");
    // The deterministic fail is what grades the conflict.
    expect(projection.discrepancies).toEqual([
      {
        atomId: "a",
        grade: "deterministic_conflict",
        statement: "atom a statement",
        evidenceRef: "gate-1",
      },
    ]);
  });

  test("a violating finding AND a satisfying deterministic pass -> violated (advisory), pass never masks it", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      findings: [findingReceipt(finding({ findingId: "f-1", atomRefs: ["a"] }))],
      deterministicEvidence: [{ atomId: "a", verdict: "pass", ref: "gate-1" }],
    });

    expect(projection.atoms[0]?.state).toBe("violated");
    expect(projection.discrepancies.map((d) => d.grade)).toEqual(["advisory_conflict"]);
  });

  test("deterministic conflict is preferred over advisory when BOTH a fail-finding and a fail-deterministic exist", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      findings: [findingReceipt(finding({ findingId: "f-1", atomRefs: ["a"] }))],
      deterministicEvidence: [{ atomId: "a", verdict: "fail", ref: "gate-1" }],
    });

    expect(projection.atoms[0]?.state).toBe("violated");
    // Only deterministic evidence can produce deterministic_conflict; prefer it.
    expect(projection.discrepancies).toEqual([
      {
        atomId: "a",
        grade: "deterministic_conflict",
        statement: "statement for a",
        evidenceRef: "gate-1",
      },
    ]);
  });
});

describe("projectRequirementFitness: staleness never violates", () => {
  test("a finding that WOULD violate but whose targetRef is stale -> atom unverified, no discrepancy", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      // Finding reviewed patch-set ps-OLD; current tree is ps-1 -> stale by set inequality.
      findings: [
        findingReceipt(
          finding({
            findingId: "f-1",
            atomRefs: ["a"],
            targetRef: { kind: "patch_sets", patchSetRefs: ["ps-OLD"] },
          }),
        ),
      ],
    });

    expect(projection.atoms[0]?.state).toBe("unverified");
    expect(projection.discrepancies).toEqual([]);
    expect(projection.unverifiedMustAtoms).toEqual(["a"]);
  });

  test("a file_digests finding older than a later tree mutation is stale (tape-only rule)", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      findings: [
        findingReceipt(
          finding({
            findingId: "f-1",
            atomRefs: ["a"],
            targetRef: { kind: "file_digests", digests: { "src/a.ts": "d1" } },
          }),
          50,
        ),
      ],
      // A tree mutation landed at t=90, after the finding's receipt at t=50.
      latestTreeMutationAt: 90,
    });

    expect(projection.atoms[0]?.state).toBe("unverified");
    expect(projection.discrepancies).toEqual([]);
  });

  test("a stale finding does NOT block a separate deterministic satisfaction", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      findings: [
        findingReceipt(
          finding({
            findingId: "f-stale",
            atomRefs: ["a"],
            targetRef: { kind: "patch_sets", patchSetRefs: ["ps-OLD"] },
          }),
        ),
      ],
      deterministicEvidence: [{ atomId: "a", verdict: "pass", ref: "gate-1" }],
    });

    expect(projection.atoms[0]?.state).toBe("satisfied");
    expect(projection.discrepancies).toEqual([]);
  });
});

describe("projectRequirementFitness: unverifiedMustAtoms", () => {
  test("enumerates only must-modality atoms in unverified state", () => {
    const projection = projectRequirementFitness(
      baseInput([
        atom("must-unverified", { modality: "must" }),
        atom("should-unverified", { modality: "should" }),
        atom("nice-unverified", { modality: "nice" }),
      ]),
    );

    expect(projection.unverifiedMustAtoms).toEqual(["must-unverified"]);
  });

  test("a must atom that is satisfied is NOT listed", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a", { modality: "must" }), atom("b", { modality: "must" })]),
      deterministicEvidence: [{ atomId: "a", verdict: "pass", ref: "gate-1" }],
    });

    expect(projection.unverifiedMustAtoms).toEqual(["b"]);
  });

  test("a must atom that is violated is NOT listed (it is not unverified)", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a", { modality: "must" })]),
      deterministicEvidence: [{ atomId: "a", verdict: "fail", ref: "gate-1" }],
    });

    expect(projection.unverifiedMustAtoms).toEqual([]);
  });
});

describe("projectRequirementFitness: counts", () => {
  test("tally covers every atom across the reachable states", () => {
    const projection = projectRequirementFitness({
      ...baseInput([
        atom("satisfied-det"),
        atom("likely"),
        atom("violated-det"),
        atom("unverified"),
      ]),
      deterministicEvidence: [
        { atomId: "satisfied-det", verdict: "pass", ref: "g-pass" },
        { atomId: "violated-det", verdict: "fail", ref: "g-fail" },
      ],
      authoredOutcomes: [{ atomRefs: ["likely"], ref: "authored-1" }],
    });

    expect(projection.counts).toEqual({
      satisfied: 1,
      likelySatisfied: 1,
      violated: 1,
      unverified: 1,
      notApplicable: 0,
    });
  });
});

describe("projectRequirementFitness: notApplicable is unreachable from this join", () => {
  test("no normal input ever produces notApplicable (documented-unreachable)", () => {
    // Exercise every evidence channel at once; notApplicable must never appear,
    // since the RequirementAtom shape carries no explicit notApplicable marker.
    const projection = projectRequirementFitness({
      ...baseInput([
        atom("a", { modality: "must" }),
        atom("b", { modality: "should" }),
        atom("c", { modality: "nice" }),
      ]),
      findings: [findingReceipt(finding({ findingId: "f-1", atomRefs: ["b"] }))],
      independentOutcomes: [{ atomRefs: ["a"], verdict: "pass", ref: "indep-1" }],
      authoredOutcomes: [{ atomRefs: ["c"], ref: "authored-1" }],
      deterministicEvidence: [{ atomId: "a", verdict: "pass", ref: "gate-1" }],
    });

    expect(projection.counts.notApplicable).toBe(0);
    for (const entry of projection.atoms) {
      expect(entry.state).not.toBe("notApplicable");
    }
  });
});

describe("projectRequirementFitness: deterministic ordering", () => {
  test("atoms appear in first-appearance order of the atoms input", () => {
    const projection = projectRequirementFitness(baseInput([atom("z"), atom("a"), atom("m")]));

    expect(projection.atoms.map((entry) => entry.atomId)).toEqual(["z", "a", "m"]);
  });

  test("discrepancies are sorted by atomId then evidenceRef", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("b"), atom("a")]),
      deterministicEvidence: [
        { atomId: "b", verdict: "fail", ref: "g-b" },
        { atomId: "a", verdict: "fail", ref: "g-a2" },
        { atomId: "a", verdict: "fail", ref: "g-a1" },
      ],
    });

    expect(projection.discrepancies.map((d) => `${d.atomId}:${d.evidenceRef}`)).toEqual([
      "a:g-a1",
      "b:g-b",
    ]);
  });

  test("evidence entries within an atom are order-independent (sorted deterministically)", () => {
    const forward = projectRequirementFitness({
      ...baseInput([atom("a")]),
      deterministicEvidence: [
        { atomId: "a", verdict: "pass", ref: "g-2" },
        { atomId: "a", verdict: "pass", ref: "g-1" },
      ],
    });
    const reversed = projectRequirementFitness({
      ...baseInput([atom("a")]),
      deterministicEvidence: [
        { atomId: "a", verdict: "pass", ref: "g-1" },
        { atomId: "a", verdict: "pass", ref: "g-2" },
      ],
    });

    expect(forward.atoms[0]?.evidence).toEqual(reversed.atoms[0]?.evidence);
  });

  test("an atom referenced by evidence but absent from atoms input is ignored", () => {
    const projection = projectRequirementFitness({
      ...baseInput([atom("a")]),
      deterministicEvidence: [{ atomId: "ghost", verdict: "fail", ref: "g-1" }],
    });

    expect(projection.atoms.map((entry) => entry.atomId)).toEqual(["a"]);
    expect(projection.discrepancies).toEqual([]);
  });
});
