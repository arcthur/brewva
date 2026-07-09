import { describe, expect, test } from "bun:test";
import { buildDelegationEvidenceReport } from "@brewva/brewva-gateway/hosted";

let seq = 0;
function ev(type: string, payload: Record<string, unknown>) {
  seq += 1;
  return { id: `e${seq}`, sessionId: "s1", turnId: "t", type, timestamp: seq, payload };
}

// buildDelegationEvidenceReport reads only runtime.ops.events.records.{listSessionIds,list}.
function runtimeFor(events: ReturnType<typeof ev>[]) {
  return {
    ops: {
      events: {
        records: {
          listSessionIds: () => ["s1"],
          list: () => events,
        },
      },
    },
  } as never;
}

describe("buildDelegationEvidenceReport (Lever 6 instrument)", () => {
  test("aggregates reach, rejections, the failure counter-signal, and adoption from the tape", () => {
    seq = 0;
    const events = [
      ev("subagent_spawned", {
        runId: "r1",
        agent: "navigator",
        waitMode: "completion",
        executionPrimitive: "named",
      }),
      ev("subagent_completed", { runId: "r1", agent: "navigator" }),
      ev("subagent_spawned", {
        runId: "r2",
        agent: "explorer",
        waitMode: "start",
        executionPrimitive: "fork",
      }),
      ev("subagent_failed", { runId: "r2", agent: "explorer" }),
      ev("subagent_outcome_parse_failed", { runId: "r2" }),
      ev("subagent_slot_rejected", { reason: "max_concurrent_reached" }),
      ev("subagent_slot_rejected", { reason: "session_total_exhausted" }),
      ev("worker.results.applied", { workerIds: ["w1", "w2"] }),
      ev("worker.results.rejected", { workerIds: ["w3"] }),
    ];
    const { aggregate } = buildDelegationEvidenceReport(runtimeFor(events));

    // Reach: two runs, one per role and per primitive.
    expect(aggregate.counts.total).toBe(2);
    expect(aggregate.counts.byRole).toEqual({ navigator: 1, explorer: 1 });
    expect(aggregate.counts.byPrimitive).toEqual({ named: 1, fork: 1 });
    expect(Object.values(aggregate.counts.byStatus).reduce((sum, n) => sum + n, 0)).toBe(2);

    // Parallel-gate rejections split by reason.
    expect(aggregate.parallelRejections).toEqual({
      total: 2,
      byReason: { max_concurrent_reached: 1, session_total_exhausted: 1 },
    });

    // The reliability counter-signal, deduped to a true [0,1] rate: r2 raises TWO
    // failure events but is ONE failed run, so failureRate is 1/2, not 2/2.
    expect(aggregate.failures).toEqual({ total: 2, dispatch: 1, consult: 1, failedRuns: 1 });
    expect(aggregate.failureRate).toBe(0.5);

    // Adoption counts worker RESULTS, not events: the batch-apply of [w1, w2] is 2.
    expect(aggregate.adoption).toEqual({ applied: 2, applyFailed: 0, rejected: 1 });
  });

  test("failureRate is null and counts are zero on a tape with no delegations", () => {
    seq = 0;
    const report = buildDelegationEvidenceReport(runtimeFor([]));
    expect(report.aggregate.counts.total).toBe(0);
    expect(report.aggregate.failures.total).toBe(0);
    expect(report.aggregate.failureRate).toBeNull();
    expect(report.sessions).toHaveLength(1);
  });

  test("counts unaddressed (still-live) review findings — the act-on-review loop-close signal", () => {
    seq = 0;
    const events = [
      ev("review.finding.recorded", {
        findingId: "f-1",
        severity: "high",
        category: "correctness",
        statement: "Fn suppression not keycode-scoped",
        anchors: [],
        lens: null,
        targetRef: { kind: "file_digests", digests: { "a.swift": "sha-a" } },
        atomRefs: ["req-1"],
      }),
      ev("review.finding.recorded", {
        findingId: "f-2",
        severity: "low",
        category: "style",
        statement: "nit",
        anchors: [],
        lens: null,
        targetRef: { kind: "file_digests", digests: { "b.swift": "sha-b" } },
        atomRefs: [],
      }),
    ];
    // No tree mutation after either finding -> both stay live (unaddressed).
    const { aggregate, sessions } = buildDelegationEvidenceReport(runtimeFor(events));
    expect(sessions[0]?.unaddressedReviewFindings).toEqual({
      total: 2,
      highOrCritical: 1,
      unattributed: 1,
    });
    expect(aggregate.unaddressedReviewFindings).toEqual({
      total: 2,
      highOrCritical: 1,
      unattributed: 1,
    });
  });
});
