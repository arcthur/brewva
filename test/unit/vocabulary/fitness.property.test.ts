import { expect } from "bun:test";
import {
  projectRequirementFitness,
  type DeterministicFitnessEvidence,
  type FitnessAuthoredOutcome,
  type FitnessIndependentOutcome,
  type FitnessReviewFinding,
  type RequirementFitnessInput,
} from "@brewva/brewva-vocabulary/fitness";
import type { RequirementAtom } from "@brewva/brewva-vocabulary/task";
import fc, { type Arbitrary } from "fast-check";
import { propertyTest } from "../../helpers/property.js";

const ATOM_IDS = ["a", "b", "c", "d"] as const;

const atomArbitrary: Arbitrary<RequirementAtom> = fc.record({
  id: fc.constantFrom(...ATOM_IDS),
  statement: fc.constantFrom("s-a", "s-b", "s-c", "s-d"),
  modality: fc.constantFrom<RequirementAtom["modality"]>("must", "should", "nice"),
  provenance: fc.constantFrom<RequirementAtom["provenance"]>("prompt", "trap", "review"),
  // Exercise the high-risk (runtime/security) branch so independenceDebtAtoms is
  // property-covered — `ux` and `undefined` are the presence-floor (non-high-risk)
  // controls that must stay OUT of the debt set.
  riskClass: fc.constantFrom<RequirementAtom["riskClass"]>(undefined, "runtime", "security", "ux"),
});

const targetRefArbitrary = fc.oneof(
  fc.record({
    kind: fc.constant<"patch_sets">("patch_sets"),
    patchSetRefs: fc.subarray(["ps-1", "ps-OLD"], { minLength: 0, maxLength: 2 }),
  }),
  fc.record({
    kind: fc.constant<"file_digests">("file_digests"),
    digests: fc.constant({ "src/a.ts": "d1" }),
  }),
);

const findingArbitrary: Arbitrary<FitnessReviewFinding> = fc.record({
  finding: fc.record({
    findingId: fc.constantFrom("f-1", "f-2", "f-3"),
    severity: fc.constantFrom<"critical" | "high" | "medium" | "low">(
      "critical",
      "high",
      "medium",
      "low",
    ),
    category: fc.constant<"correctness">("correctness"),
    statement: fc.constant("finding"),
    anchors: fc.constant([] as readonly string[]),
    lens: fc.constant(null),
    targetRef: targetRefArbitrary,
    atomRefs: fc.subarray([...ATOM_IDS], { minLength: 0, maxLength: 4 }),
  }),
  receiptTimestamp: fc.integer({ min: 0, max: 200 }),
});

const independentArbitrary: Arbitrary<FitnessIndependentOutcome> = fc.record({
  atomRefs: fc.subarray([...ATOM_IDS], { minLength: 0, maxLength: 4 }),
  verdict: fc.constantFrom<"pass" | "fail">("pass", "fail"),
  ref: fc.constantFrom("indep-1", "indep-2"),
});

const authoredArbitrary: Arbitrary<FitnessAuthoredOutcome> = fc.record({
  atomRefs: fc.subarray([...ATOM_IDS], { minLength: 0, maxLength: 4 }),
  ref: fc.constantFrom("auth-1", "auth-2"),
});

const deterministicArbitrary: Arbitrary<DeterministicFitnessEvidence> = fc.record({
  atomId: fc.constantFrom(...ATOM_IDS),
  verdict: fc.constantFrom<"pass" | "fail">("pass", "fail"),
  ref: fc.constantFrom("g-1", "g-2", "g-3"),
});

const inputArbitrary: Arbitrary<RequirementFitnessInput> = fc.record({
  atoms: fc.uniqueArray(atomArbitrary, {
    minLength: 0,
    maxLength: 4,
    selector: (entry) => entry.id,
  }),
  findings: fc.array(findingArbitrary, { maxLength: 5 }),
  independentOutcomes: fc.array(independentArbitrary, { maxLength: 5 }),
  authoredOutcomes: fc.array(authoredArbitrary, { maxLength: 5 }),
  deterministicEvidence: fc.array(deterministicArbitrary, { maxLength: 5 }),
  appliedPatchSetRefs: fc.constant(["ps-1"] as readonly string[]),
  latestTreeMutationAt: fc.option(fc.integer({ min: 0, max: 200 }), { nil: null }),
});

function shuffleEvidenceArrays(input: RequirementFitnessInput): RequirementFitnessInput {
  // Reverse every evidence array; the projection must be order-independent, so
  // the resulting projection must be byte-identical.
  return {
    ...input,
    findings: input.findings.toReversed(),
    independentOutcomes: input.independentOutcomes.toReversed(),
    authoredOutcomes: input.authoredOutcomes.toReversed(),
    deterministicEvidence: input.deterministicEvidence.toReversed(),
  };
}

propertyTest<[RequirementFitnessInput]>(
  "requirement-fitness projection is order-independent in its evidence arrays",
  {
    propertyId: "vocabulary.requirement_fitness.order_independent",
    layer: "unit",
    arbitraries: [inputArbitrary],
    predicate(input) {
      const base = projectRequirementFitness(input);
      const shuffled = projectRequirementFitness(shuffleEvidenceArrays(input));

      expect(shuffled).toEqual(base);

      // Invariants that must hold for every input.
      const counted =
        base.counts.satisfied +
        base.counts.likelySatisfied +
        base.counts.violated +
        base.counts.unverified +
        base.counts.notApplicable;
      expect(counted).toBe(base.atoms.length);
      expect(base.counts.notApplicable).toBe(0);

      const violatedIds = new Set(
        base.atoms.filter((entry) => entry.state === "violated").map((entry) => entry.atomId),
      );
      for (const discrepancy of base.discrepancies) {
        expect(violatedIds.has(discrepancy.atomId)).toBe(true);
      }

      const mustUnverified = base.atoms
        .filter((entry) => entry.state === "unverified")
        .map((entry) => entry.atomId)
        .filter((id) => input.atoms.find((a) => a.id === id)?.modality === "must");
      expect([...base.unverifiedMustAtoms].toSorted()).toEqual(mustUnverified.toSorted());

      // independenceDebtAtoms = exactly the high-risk (runtime/security) `must` atoms
      // whose state never reached `satisfied` (independently re-derived from the RFC
      // definition, not by copying the projection's internal predicate).
      const highRisk = new Set<RequirementAtom["riskClass"]>(["runtime", "security"]);
      const expectedDebt = base.atoms
        .filter((entry) => {
          const atom = input.atoms.find((candidate) => candidate.id === entry.atomId);
          return (
            atom?.modality === "must" &&
            highRisk.has(atom.riskClass) &&
            (entry.state === "unverified" || entry.state === "likelySatisfied")
          );
        })
        .map((entry) => entry.atomId);
      expect([...base.independenceDebtAtoms].toSorted()).toEqual(expectedDebt.toSorted());

      // independenceDebtResolution census: `open` is exactly the debt list length, and
      // the three buckets PARTITION every high-risk `must` atom (independently
      // re-derived, not copied). `notApplicable` is unreachable, so the partition sum
      // must equal the full high-risk-must count — this locks that assumption.
      const highRiskMustStates = base.atoms
        .filter((entry) => {
          const atom = input.atoms.find((candidate) => candidate.id === entry.atomId);
          return atom?.modality === "must" && highRisk.has(atom.riskClass);
        })
        .map((entry) => entry.state);
      const resolution = base.independenceDebtResolution;
      expect(resolution.open).toBe(base.independenceDebtAtoms.length);
      expect(resolution.violated).toBe(
        highRiskMustStates.filter((state) => state === "violated").length,
      );
      expect(resolution.dischargedAtGrade).toBe(
        highRiskMustStates.filter((state) => state === "satisfied").length,
      );
      expect(resolution.open + resolution.violated + resolution.dischargedAtGrade).toBe(
        highRiskMustStates.length,
      );
    },
  },
);
