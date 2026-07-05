import { describe, expect, test } from "bun:test";
import type { FitnessDiscrepancy } from "@brewva/brewva-vocabulary/fitness";
import { readReceiptFitnessSummary } from "../../../packages/brewva-cli/src/operator/inspect/fitness-summary.js";

// Task 15 (W4): the ONE receipt->fitness-summary computation both run-report
// and the Work Card fitness line call — a pure function of the latest
// `verification.outcome.recorded` receipt's already-committed `discrepancies`/
// `unverifiedMustAtoms` fields (Task 13's claim-time annotation), never a
// re-run of `projectRequirementFitness`. It carries ONLY what a receipt
// legitimately owns (violated via discrepancies, unverifiedMust) — no
// satisfied/likelySatisfied/notApplicable counts, which are re-derivable
// projection results that belong in the view, not commitment memory.

function discrepancy(
  atomId: string,
  grade: FitnessDiscrepancy["grade"],
  evidenceRef: string,
): FitnessDiscrepancy {
  return { atomId, grade, statement: `${atomId} statement`, evidenceRef };
}

describe("readReceiptFitnessSummary", () => {
  test("an empty annotation (no receipt, or a receipt below the annotation gate) summarizes as all-zero", () => {
    const summary = readReceiptFitnessSummary({ discrepancies: [], unverifiedMustAtoms: [] });

    expect(summary).toEqual({
      violated: 0,
      unverifiedMust: 0,
      discrepanciesByGrade: { deterministic_conflict: 0, advisory_conflict: 0 },
    });
  });

  test("tallies violated (one per discrepancy) and unverifiedMust, by grade", () => {
    const summary = readReceiptFitnessSummary({
      discrepancies: [
        discrepancy("req-1", "deterministic_conflict", "gate-1"),
        discrepancy("req-2", "advisory_conflict", "finding-1"),
        discrepancy("req-3", "deterministic_conflict", "gate-2"),
      ],
      unverifiedMustAtoms: ["req-4"],
    });

    expect(summary.violated).toBe(3);
    expect(summary.unverifiedMust).toBe(1);
    expect(summary.discrepanciesByGrade).toEqual({
      deterministic_conflict: 2,
      advisory_conflict: 1,
    });
  });

  test("discrepanciesByGrade is a TOTAL map even when one grade never occurs", () => {
    const summary = readReceiptFitnessSummary({
      discrepancies: [discrepancy("req-1", "advisory_conflict", "finding-1")],
      unverifiedMustAtoms: [],
    });

    // deterministic_conflict must be present (as 0), not merely absent — a
    // future third grade must show up the same way, by construction.
    expect(summary.discrepanciesByGrade).toEqual({
      deterministic_conflict: 0,
      advisory_conflict: 1,
    });
  });
});
