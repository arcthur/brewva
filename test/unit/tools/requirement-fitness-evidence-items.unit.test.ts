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

// Evidence items flow receipt -> defensive reader -> assembler -> the fitness
// join. The point: a deterministic PASS keyed to an atom SATISFIES it; a
// deterministic FAIL violates it (deterministic_conflict).
describe("evidenceItems flow receipt -> assembler -> join", () => {
  test("a deterministic PASS keyed to a high-risk atom satisfies it", () => {
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
            verdict: "pass",
            anchors: ["FnKeyMonitor.swift: keyCode gate"],
            statement: "tap suppression is keycode-scoped",
          },
        ],
      }),
    ];
    const fitness = buildTapeRequirementFitness(events);
    expect(fitness.atoms[0]?.state).toBe("satisfied");
  });

  test("a deterministic FAIL violates the atom (deterministic_conflict)", () => {
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
