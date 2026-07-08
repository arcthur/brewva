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

    // No requirement atoms on this tape -> nothing carried into close as independence debt.
    expect(aggregate.independenceDebt).toEqual({ open: 0, violated: 0, dischargedAtGrade: 0 });
  });

  test("failureRate is null and counts are zero on a tape with no delegations", () => {
    seq = 0;
    const report = buildDelegationEvidenceReport(runtimeFor([]));
    expect(report.aggregate.counts.total).toBe(0);
    expect(report.aggregate.failures.total).toBe(0);
    expect(report.aggregate.failureRate).toBeNull();
    expect(report.aggregate.independenceDebt).toEqual({
      open: 0,
      violated: 0,
      dischargedAtGrade: 0,
    });
    expect(report.sessions).toHaveLength(1);
  });

  test("carries high-risk unmet must atoms into the independence-debt open count (Lever 6)", () => {
    seq = 0;
    // A runtime-risk `must` atom recorded with no evidence reaches tape close still
    // owing an at-grade independent read — the channel's activation counter-signal. The
    // NON-high-risk must atom (presence floor) is deliberately excluded, proving the
    // instrument reads independenceDebtAtoms, not the broader unverifiedMustAtoms.
    const events = [
      ev("subagent_spawned", {
        runId: "r1",
        agent: "navigator",
        waitMode: "completion",
        executionPrimitive: "named",
      }),
      ev("subagent_completed", { runId: "r1", agent: "navigator" }),
      ev("task.requirement.recorded", {
        atom: {
          id: "req-runtime",
          statement: "event tap must re-arm on disable",
          modality: "must",
          provenance: "trap",
          riskClass: "runtime",
        },
      }),
      ev("task.requirement.recorded", {
        atom: {
          id: "req-ux",
          statement: "menu bar shows a mic glyph",
          modality: "must",
          provenance: "prompt",
        },
      }),
    ];
    const { aggregate, sessions } = buildDelegationEvidenceReport(runtimeFor(events));

    // One high-risk must atom unmet at close -> open 1; the presence-floor atom is excluded.
    expect(aggregate.independenceDebt).toEqual({ open: 1, violated: 0, dischargedAtGrade: 0 });
    expect(sessions[0]?.independenceDebt).toEqual({ open: 1, violated: 0, dischargedAtGrade: 0 });
    // The debt coexists with normal delegation reach in the same session report.
    expect(aggregate.counts.total).toBe(1);
  });

  test("censuses an at-grade discharge: a static_guard evidence pass reports dischargedAtGrade, not open", () => {
    seq = 0;
    // A high-risk must atom + a receipt carrying a graded static_guard evidence-item
    // pass on it -> the atom reaches `satisfied` at grade, so the census reports it
    // under dischargedAtGrade — and the aggregate sum for that field runs end to end.
    const events = [
      ev("task.requirement.recorded", {
        atom: {
          id: "req-runtime",
          statement: "event tap must re-arm on disable",
          modality: "must",
          provenance: "trap",
          riskClass: "runtime",
        },
      }),
      ev("verification.outcome.recorded", {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
        evidenceItems: [
          {
            id: "guard-1",
            atomRefs: ["req-runtime"],
            evidenceKind: "static_guard",
            verdict: "pass",
            anchors: ["FnKeyMonitor.swift: keyCode gate"],
            statement: "tap suppression is keycode-scoped",
          },
        ],
      }),
    ];
    const { aggregate } = buildDelegationEvidenceReport(runtimeFor(events));
    expect(aggregate.independenceDebt).toEqual({ open: 0, violated: 0, dischargedAtGrade: 1 });
  });

  test("sums disjoint per-session independence debt into the aggregate open count", () => {
    seq = 0;
    // Session-local atom ids: s1 owes 1 (runtime), s2 owes 2 (security + runtime). The
    // per-session values differ (1 != 2) so a Math.max/overwrite regression on the
    // aggregate sum line would NOT reproduce the expected total of 3.
    const s1Events = [
      ev("task.requirement.recorded", {
        atom: {
          id: "a1",
          statement: "event tap must re-arm on disable",
          modality: "must",
          provenance: "trap",
          riskClass: "runtime",
        },
      }),
    ];
    const s2Events = [
      ev("task.requirement.recorded", {
        atom: {
          id: "b1",
          statement: "hardened entitlement must hold",
          modality: "must",
          provenance: "trap",
          riskClass: "security",
        },
      }),
      ev("task.requirement.recorded", {
        atom: {
          id: "b2",
          statement: "audio route must survive device change",
          modality: "must",
          provenance: "trap",
          riskClass: "runtime",
        },
      }),
    ];
    const bySession: Record<string, ReturnType<typeof ev>[]> = { s1: s1Events, s2: s2Events };
    const runtime = {
      ops: {
        events: {
          records: {
            listSessionIds: () => ["s1", "s2"],
            list: (sessionId: string) => bySession[sessionId] ?? [],
          },
        },
      },
    } as never;

    const { aggregate, sessions } = buildDelegationEvidenceReport(runtime);

    const openById = Object.fromEntries(
      sessions.map((s) => [s.sessionId, s.independenceDebt.open]),
    );
    expect(openById).toEqual({ s1: 1, s2: 2 });
    expect(aggregate.independenceDebt.open).toBe(3);
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
