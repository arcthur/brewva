import { describe, expect, test } from "bun:test";
import { buildTapeRequirementFitness } from "@brewva/brewva-tools/runtime-port";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";

function record(
  type: string,
  timestamp: number,
  payload: Record<string, unknown>,
): BrewvaEventRecord {
  return {
    id: `e-${type}-${timestamp}`,
    sessionId: "s",
    turnId: "t",
    type,
    timestamp,
    payload,
  } as BrewvaEventRecord;
}

function atomEvent(id: string, riskClass?: string): BrewvaEventRecord {
  return record("task.requirement.recorded", 1, {
    atom: {
      id,
      statement: `${id} statement`,
      modality: "must",
      provenance: "trap",
      ...(riskClass ? { riskClass } : {}),
    },
  });
}

// R3b: graded evidence items flow receipt -> defensive reader -> assembler ->
// the R3-core join. The point: a static-guard adapter's static_guard-grade PASS
// can SATISFY a high-risk atom that a presence re-grep leaves capped.
describe("R3b: graded evidenceItems flow receipt -> assembler -> join", () => {
  test("a static_guard deterministic PASS satisfies a high-risk atom presence could not", () => {
    const events = [
      atomEvent("req-1", "runtime"),
      record("verification.outcome.recorded", 10, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
        evidenceItems: [
          {
            id: "guard-1",
            atomRefs: ["req-1"],
            evidenceKind: "static_guard",
            verdict: "pass",
            anchors: ["FnKeyMonitor.swift: keyCode gate"],
            statement: "tap suppression is keycode-scoped",
          },
        ],
      }),
    ];
    const fitness = buildTapeRequirementFitness(events);
    expect(fitness.atoms[0]?.state).toBe("satisfied");
    expect(fitness.insufficientGradeAtoms).toEqual([]);
  });

  test("an independent review's presence-grade clear leaves the same high-risk atom capped + grade debt", () => {
    // The PRODUCTION path a presence-grade signal actually takes: an independent
    // atoms-review clears req-1 via the receipt's top-level `atomRefs` (NOT an
    // evidence item — independent evidence rides atomRefs, deterministic evidence
    // rides items). That outcome grades as `presence`, which cannot satisfy a
    // `runtime`-risk atom, so it caps at likelySatisfied and surfaces grade debt.
    const events = [
      atomEvent("req-1", "runtime"),
      record("verification.outcome.recorded", 10, {
        outcome: "pass",
        level: "requirements",
        perspective: "independent",
        atomRefs: ["req-1"],
      }),
    ];
    const fitness = buildTapeRequirementFitness(events);
    expect(fitness.atoms[0]?.state).toBe("likelySatisfied");
    expect(fitness.insufficientGradeAtoms).toEqual([
      { atomId: "req-1", requiredKind: "static_guard", actualKind: "presence" },
    ]);
  });

  test("a static_guard deterministic FAIL violates the atom (deterministic_conflict)", () => {
    const events = [
      atomEvent("req-1", "runtime"),
      record("verification.outcome.recorded", 10, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
        evidenceItems: [
          {
            id: "guard-1",
            atomRefs: ["req-1"],
            evidenceKind: "static_guard",
            verdict: "fail",
            anchors: ["no tapDisabledBy handling"],
            statement: "tap never re-enables",
          },
        ],
      }),
    ];
    const fitness = buildTapeRequirementFitness(events);
    expect(fitness.atoms[0]?.state).toBe("violated");
    expect(fitness.discrepancies[0]?.grade).toBe("deterministic_conflict");
    expect(fitness.insufficientGradeAtoms).toEqual([]);
  });

  test("a malformed evidenceItem is dropped by the defensive reader (no crash)", () => {
    const events = [
      atomEvent("req-1", "runtime"),
      record("verification.outcome.recorded", 10, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
        evidenceItems: [{ id: "x" }],
      }),
    ];
    const fitness = buildTapeRequirementFitness(events);
    // The malformed item is dropped -> the atom has no live evidence -> unverified.
    expect(fitness.atoms[0]?.state).toBe("unverified");
  });
});
