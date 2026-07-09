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
