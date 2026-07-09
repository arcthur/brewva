import { describe, expect, test } from "bun:test";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { buildTapeUnverifiedRequirementDebt } from "../../packages/brewva-cli/src/operator/inspect/requirement-fitness.js";
import { buildRunReportProjection } from "../../packages/brewva-cli/src/operator/inspect/run-report.js";

// Requirement-loop LIVENESS (RFC acceptance). The RFC ships R1/R2 only with a
// liveness fitness that the adoption predicate fires on a canonical run, and
// "surfaces ship with producers" — R3/R4 do not land until a producer is proven
// live. Each assertion here is an acceptance gate: it CATCHES the up4 anti-pattern
// (atoms recorded after the writes, never reviewed; a high-risk atom "verified" by
// a presence re-grep) rather than passing on a synthetic-healthy shape only. If a
// producer is rewired dead or the predicate inverts, this goes red.

function ev(type: string, timestamp: number, payload: Record<string, unknown>): BrewvaEventRecord {
  return {
    id: `${type}-${timestamp}`,
    sessionId: "s",
    turnId: "t",
    type,
    timestamp,
    payload,
  } as BrewvaEventRecord;
}

function atom(
  id: string,
  timestamp: number,
  opts: { statement?: string; riskClass?: string } = {},
): BrewvaEventRecord {
  return ev("task.requirement.recorded", timestamp, {
    atom: {
      id,
      statement: opts.statement ?? `${id} statement`,
      modality: "must",
      provenance: "prompt",
      ...(opts.riskClass ? { riskClass: opts.riskClass } : {}),
    },
  });
}

function write(timestamp: number, path = "src/a.swift"): BrewvaEventRecord {
  return ev("tool.committed", timestamp, {
    call: { toolName: "write", args: { path } },
    result: { outcome: { kind: "ok" } },
  });
}

describe("R1/R2 adoption liveness (acceptance)", () => {
  test("the CANONICAL shape: atoms precede the first write and a review is dispatched", () => {
    const events = [
      ev("turn.started", 0, {}),
      atom("req-1", 10),
      write(50),
      ev("review.finding.recorded", 90, {
        findingId: "f",
        severity: "low",
        category: "correctness",
        statement: "n",
        anchors: [],
        lens: null,
        targetRef: { kind: "patch_sets", patchSetRefs: ["ps"] },
        atomRefs: [],
      }),
    ];
    const life = buildRunReportProjection("s", events).requirementLifecycle;
    expect(life.atomizedBeforeFirstWrite).toBe(true);
    expect(life.reviewDispatched).toBe(true);
  });

  test("the up4 ANTI-pattern is caught: atoms recorded after the write, never reviewed", () => {
    const events = [ev("turn.started", 0, {}), write(50), atom("req-1", 100)];
    const life = buildRunReportProjection("s", events).requirementLifecycle;
    expect(life.atomizedBeforeFirstWrite).toBe(false);
    expect(life.reviewDispatched).toBe(false);
  });
});

describe("R4 debt producer liveness (acceptance)", () => {
  test("an artifact-green with fresh code + an unverified must atom surfaces the debt", () => {
    const events = [
      atom("req-1", 1),
      write(2),
      ev("verification.outcome.recorded", 3, {
        outcome: "pass",
        level: "artifact",
        perspective: "authored",
      }),
    ];
    expect(buildTapeUnverifiedRequirementDebt(events)).toEqual({
      debt: true,
      unverifiedMustCount: 1,
      reason: "ladder_below_requirements",
    });
  });
});
