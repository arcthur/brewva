import { describe, expect, test } from "bun:test";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type { ReviewTargetRef } from "@brewva/brewva-vocabulary/review";
import { buildTapeCoverageAttributionMiss } from "../../../packages/brewva-tools/src/runtime-port/verification.js";
import { committedToolEvent } from "../../helpers/tool-events.js";

// The independence census's blind spot, surfaced by `buildTapeCoverageAttributionMiss`:
// an independent-perspective FAIL review that COVERED the session's fresh-touched
// universe yet named ZERO atoms moves no census bucket (its own atomRefs are dropped to
// avoid blanket-violation, and no finding pins the owed atom), so it reads identically to
// "no review ran" — game_7's failure form. Only flagged while high-risk debt is OPEN.

const WORKSPACE_ROOT = "/workspace/app";

// Write events carry ABSOLUTE paths (the real hosted tape shape); the coverage universe
// relativizes them against the workspace root.
function writeRecord(relPath: string, ts: number): BrewvaEventRecord {
  return committedToolEvent({
    toolName: "write",
    args: { path: `${WORKSPACE_ROOT}/${relPath}` },
    timestamp: ts,
  }) as unknown as BrewvaEventRecord;
}

function requirementRecord(id: string, riskClass: string, ts: number): BrewvaEventRecord {
  return {
    id: `e-req-${id}`,
    sessionId: "s",
    turnId: "t",
    type: "task.requirement.recorded",
    timestamp: ts,
    payload: {
      atom: { id, statement: `${id} statement`, modality: "must", provenance: "trap", riskClass },
    },
  } as BrewvaEventRecord;
}

function fileDigestsRef(paths: readonly string[]): ReviewTargetRef {
  return {
    kind: "file_digests",
    digests: Object.fromEntries(paths.map((path) => [path, `hash-${path}`])),
  };
}

function independentOutcome(
  outcome: "pass" | "fail",
  targetRef: ReviewTargetRef,
  ts: number,
  perspective: "independent" | "authored" = "independent",
): BrewvaEventRecord {
  return {
    id: `e-outcome-${ts}`,
    sessionId: "s",
    turnId: "t",
    type: "verification.outcome.recorded",
    timestamp: ts,
    payload: {
      outcome,
      level: "requirements",
      perspective,
      checks: [],
      reviewerContext: { contextId: `run-${ts}`, model: null, lenses: [] },
      targetRef,
      // A fail's affirmative atomRefs are dropped at the producer; a pass on a high-risk
      // atom only reaches likelySatisfied (grade ceiling). Neither convicts an atom here.
      atomRefs: outcome === "pass" ? ["req-1"] : [],
    },
  } as BrewvaEventRecord;
}

function findingRecord(
  targetRef: ReviewTargetRef,
  atomRefs: readonly string[],
  ts: number,
): BrewvaEventRecord {
  return {
    id: `e-finding-${ts}`,
    sessionId: "s",
    turnId: "t",
    type: "review.finding.recorded",
    timestamp: ts,
    payload: {
      findingId: `f-${ts}`,
      severity: "high",
      category: "correctness",
      statement: "finding",
      anchors: [],
      lens: null,
      targetRef,
      atomRefs,
    },
  } as BrewvaEventRecord;
}

describe("buildTapeCoverageAttributionMiss — the census's silent-miss counter", () => {
  test("a covering independent FAIL that names no atom is an attribution-miss", () => {
    const events: BrewvaEventRecord[] = [
      writeRecord("a.swift", 1),
      requirementRecord("req-1", "runtime", 2),
      independentOutcome("fail", fileDigestsRef(["a.swift"]), 3),
    ];
    expect(buildTapeCoverageAttributionMiss(events, WORKSPACE_ROOT)).toBe(1);
  });

  test("a covering independent FAIL whose finding DID name an atom is not a miss", () => {
    // req-1 is convicted by the finding (-> violated, leaves the debt set); req-2 stays
    // open so the debt gate still passes, proving the miss is excluded via the ATTRIBUTION
    // path (the covering fail's targetRef carried an atom-naming finding), not the gate.
    const targetRef = fileDigestsRef(["a.swift", "b.swift"]);
    const events: BrewvaEventRecord[] = [
      writeRecord("a.swift", 1),
      writeRecord("b.swift", 2),
      requirementRecord("req-1", "runtime", 3),
      requirementRecord("req-2", "security", 4),
      independentOutcome("fail", targetRef, 5),
      findingRecord(targetRef, ["req-1"], 6),
    ];
    expect(buildTapeCoverageAttributionMiss(events, WORKSPACE_ROOT)).toBe(0);
  });

  test("a covering independent PASS is not a miss (only FAIL reviews under-attribute)", () => {
    const events: BrewvaEventRecord[] = [
      writeRecord("a.swift", 1),
      requirementRecord("req-1", "runtime", 2),
      independentOutcome("pass", fileDigestsRef(["a.swift"]), 3),
    ];
    expect(buildTapeCoverageAttributionMiss(events, WORKSPACE_ROOT)).toBe(0);
  });

  test("a NON-covering independent FAIL is not a miss (coverage gate)", () => {
    // b.swift is in the universe but the review only attests a.swift -> not covering.
    const events: BrewvaEventRecord[] = [
      writeRecord("a.swift", 1),
      writeRecord("b.swift", 2),
      requirementRecord("req-1", "runtime", 3),
      independentOutcome("fail", fileDigestsRef(["a.swift"]), 4),
    ];
    expect(buildTapeCoverageAttributionMiss(events, WORKSPACE_ROOT)).toBe(0);
  });

  test("an AUTHORED (non-independent) covering FAIL is not a miss (perspective gate)", () => {
    const events: BrewvaEventRecord[] = [
      writeRecord("a.swift", 1),
      requirementRecord("req-1", "runtime", 2),
      independentOutcome("fail", fileDigestsRef(["a.swift"]), 3, "authored"),
    ];
    expect(buildTapeCoverageAttributionMiss(events, WORKSPACE_ROOT)).toBe(0);
  });

  test("no owed high-risk debt -> a covering fail under-attributes nothing", () => {
    // A presence-floor (ux) atom owes no independent read, so the debt set is empty.
    const events: BrewvaEventRecord[] = [
      writeRecord("a.swift", 1),
      requirementRecord("req-1", "ux", 2),
      independentOutcome("fail", fileDigestsRef(["a.swift"]), 3),
    ];
    expect(buildTapeCoverageAttributionMiss(events, WORKSPACE_ROOT)).toBe(0);
  });

  test("no fresh code -> nothing a coverage review could under-attribute", () => {
    const events: BrewvaEventRecord[] = [
      requirementRecord("req-1", "runtime", 1),
      independentOutcome("fail", fileDigestsRef(["a.swift"]), 2),
    ];
    expect(buildTapeCoverageAttributionMiss(events, WORKSPACE_ROOT)).toBe(0);
  });
});
