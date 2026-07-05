import { describe, expect, test } from "bun:test";
import { commitReviewReceipts } from "@brewva/brewva-tools/delegation";
import type { DelegationReviewDispatch } from "@brewva/brewva-vocabulary/delegation";
import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import {
  readReviewFindingRecordedEventPayload,
  REVIEW_FINDING_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/review";
import { buildRunReportProjection } from "../../../packages/brewva-cli/src/operator/inspect/run-report.js";
import { createBundledToolRuntime, createRuntimeFixture } from "../../helpers/runtime.js";

// W1 liveness fitness (Task 6): the static event-contract-liveness fitness
// (test/fitness/event-contract-liveness.fitness.test.ts) only proves a
// producer EXISTS somewhere in a 4-line emit window around the constant — it
// cannot prove the producer actually runs end-to-end or that a downstream
// projection reads what it wrote. This is the complementary BEHAVIORAL check:
// drive a real, stubbed-but-real session through the REAL record paths that
// Tasks 2-5 wired (verification_record's authored path via
// runtime.ops.verification.checks.verify, and review_request's independent
// path via the shared `commitReviewReceipts` — the exact function
// review_request and the gateway's finalization observer both call), then
// assert both new receipt kinds (`verification.outcome.recorded` with a
// perspective, `review.finding.recorded`) land on the real tape AND that
// Task 6's own run-report projection counts them correctly. Placement: this
// needs package src imports across gateway (the runtime fixture), tools (the
// shared receipt-commit function), and cli (the projection under test) — the
// same cross-package shape as the existing gateway liveness-style tests
// (verification-runtime-ops.unit.test.ts, review-receipt-observer.unit.test.ts),
// so it lives in test/unit/gateway/ rather than test/fitness/ (which is
// static-scan only, no runtime execution) or test/unit/cli/ (which does not
// import the tools delegation seam).
describe("W1 liveness: perspective-tagged receipts land on tape and project", () => {
  test("an authored receipt (verification_record path) and an independent receipt + findings (review_request path) both commit through real record paths and both project through run-report", () => {
    const runtime = createRuntimeFixture();
    const bundledRuntime = createBundledToolRuntime(runtime);
    const sessionId = "w1-liveness-session-1";

    // 1. Authored receipt: the real ops-builder write seam
    // (`verification_record`'s producer path), exactly as the tool commits it.
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "artifact",
      checks: ["make build"],
    });

    // 2. Independent receipt + two findings: the REAL shared commit function
    // (`commitReviewReceipts`) both `review_request` and the gateway's
    // finalization observer call — not a hand-built payload literal.
    const dispatch: DelegationReviewDispatch = {
      targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
      lenses: ["security"],
      stanceOverridden: false,
    };
    const receipts = commitReviewReceipts({
      runtime: bundledRuntime,
      sessionId,
      runId: "w1-liveness-run-1",
      routedModel: "reviewer-model",
      dispatch,
      source: {
        kind: "reviewer_outcome",
        ok: true,
        data: {
          kind: "consult",
          consultKind: "review",
          conclusion: "issues found",
          disposition: "concern",
          findings: [
            { summary: "unchecked null deref", severity: "critical", category: "correctness" },
            { summary: "log line leaks a token", severity: "high", category: "security" },
          ],
        },
      },
    });
    expect(receipts.committed).toBe(true);

    // --- Assert BOTH receipt kinds land on the real tape. ---
    const outcomeEvents = runtime.ops.events.records.query(sessionId, {
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
    });
    expect(outcomeEvents).toHaveLength(2);
    const outcomes = outcomeEvents.map((event) =>
      readVerificationOutcomeRecordedEventPayload(event as { payload?: Record<string, unknown> }),
    );
    expect(outcomes[0]).toMatchObject({ outcome: "pass", perspective: "authored" });
    expect(outcomes[1]).toMatchObject({
      outcome: "fail",
      perspective: "independent",
      level: "requirements",
      targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
    });
    expect(outcomes[1]?.independenceBasis).toContain("fresh_context");
    expect(outcomes[1]?.independenceBasis).toContain("preloaded_lens");

    const findingEvents = runtime.ops.events.records.query(sessionId, {
      type: REVIEW_FINDING_RECORDED_EVENT_TYPE,
    });
    expect(findingEvents).toHaveLength(2);
    const findings = findingEvents.map((event) =>
      readReviewFindingRecordedEventPayload(event as { payload?: Record<string, unknown> }),
    );
    expect(findings.map((finding) => finding?.statement)).toEqual(
      expect.arrayContaining(["unchecked null deref", "log line leaks a token"]),
    );
    expect(findings.map((finding) => finding?.category)).toEqual(
      expect.arrayContaining(["correctness", "security"]),
    );

    // --- Assert the RAW TAPE, read through the same query port every read
    // surface uses, projects correctly through Task 6's own run-report. ---
    const allEvents = runtime.ops.events.records.query(sessionId);
    const report = buildRunReportProjection(sessionId, allEvents);

    expect(report.verification.receiptCount).toBe(2);
    expect(report.verification.authoredReceipts).toBe(1);
    expect(report.verification.independentReceipts).toBe(1);
    expect(report.verification.findingsRecorded).toBe(2);
  });
});

/**
 * Finding P3: `commitReviewReceipts` must be HONEST about what actually landed.
 * A runtime whose `verification.findings.record` returns `undefined` (findings
 * capability absent) must NOT let the function claim an independent review with
 * N recorded findings — the tape would hold the outcome but zero findings, and
 * fitness would then see no reviewer counter-evidence. The commit must instead
 * fail (findings could not be recorded) before writing a misleading outcome.
 */
describe("commitReviewReceipts — honest finding-commit accounting (Finding P3)", () => {
  const DISPATCH: DelegationReviewDispatch = {
    targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
    lenses: [],
    stanceOverridden: false,
  };

  const CONCERN_WITH_FINDINGS = {
    kind: "consult",
    consultKind: "review",
    conclusion: "issues found",
    disposition: "concern",
    findings: [
      { summary: "unchecked null deref", severity: "critical", category: "correctness" },
      { summary: "log line leaks a token", severity: "high", category: "security" },
    ],
  } as const;

  /**
   * Wrap the real fixture runtime but REMOVE the `verification.findings.record`
   * seam — modeling the findings capability being absent (the runtime-port
   * `recordReviewFinding` returns undefined precisely because `?.record` is
   * absent). `verification.checks.verify` and the events port stay real, so the
   * outcome COULD commit — the point is that it must NOT when findings would be
   * lost.
   */
  function runtimeWithoutFindingsCapability(runtime: ReturnType<typeof createRuntimeFixture>) {
    const bundled = createBundledToolRuntime(runtime);
    return {
      ...bundled,
      capabilities: {
        ...bundled.capabilities,
        verification: {
          ...bundled.capabilities.verification,
          findings: {},
        },
      },
    } as typeof bundled;
  }

  test("findings capability absent + a non-empty finding set -> does NOT claim success; commits NOTHING", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "p3-findings-absent-1";

    const result = commitReviewReceipts({
      runtime: runtimeWithoutFindingsCapability(runtime),
      sessionId,
      runId: "p3-run-1",
      routedModel: "reviewer-model",
      dispatch: DISPATCH,
      source: { kind: "reviewer_outcome", ok: true, data: CONCERN_WITH_FINDINGS },
    });

    // NOT a success claiming N findings recorded.
    expect(result.committed).toBe(false);
    // And it must NOT have written a misleading independent outcome with lost
    // findings: preflight fails BEFORE the outcome is committed.
    const outcomeEvents = runtime.ops.events.records.query(sessionId, {
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
    });
    expect(outcomeEvents).toHaveLength(0);
    const findingEvents = runtime.ops.events.records.query(sessionId, {
      type: REVIEW_FINDING_RECORDED_EVENT_TYPE,
    });
    expect(findingEvents).toHaveLength(0);
  });

  test("findings capability present -> records all and reports the TRUE recorded count", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "p3-findings-present-1";

    const result = commitReviewReceipts({
      runtime: createBundledToolRuntime(runtime),
      sessionId,
      runId: "p3-run-2",
      routedModel: "reviewer-model",
      dispatch: DISPATCH,
      source: { kind: "reviewer_outcome", ok: true, data: CONCERN_WITH_FINDINGS },
    });

    expect(result.committed).toBe(true);
    if (result.committed) {
      // The TRUE recorded count, not findings.length by assumption.
      expect(result.recordedFindingCount).toBe(2);
    }
    expect(
      runtime.ops.events.records.query(sessionId, { type: REVIEW_FINDING_RECORDED_EVENT_TYPE }),
    ).toHaveLength(2);
  });

  test("a zero-finding CLEAR review still commits its independent outcome (unaffected by P3)", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "p3-clear-1";

    // A clear review has no findings to record even with the capability absent —
    // there is nothing to lose, so the outcome must still commit.
    const result = commitReviewReceipts({
      runtime: runtimeWithoutFindingsCapability(runtime),
      sessionId,
      runId: "p3-run-3",
      routedModel: "reviewer-model",
      dispatch: DISPATCH,
      source: {
        kind: "reviewer_outcome",
        ok: true,
        data: {
          kind: "consult",
          consultKind: "review",
          conclusion: "no material issues",
          disposition: "clear",
        },
      },
    });

    expect(result.committed).toBe(true);
    if (result.committed) {
      expect(result.recordedFindingCount).toBe(0);
    }
    expect(
      runtime.ops.events.records.query(sessionId, {
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      }),
    ).toHaveLength(1);
  });

  test("capability PRESENT but an individual record returns undefined -> commit succeeds, recordedFindingCount reflects reality", () => {
    // The mid-loop case: the seam exists (preflight passes) but a write returns
    // undefined (e.g. a targetRef that will not parse). The outcome commits and
    // the reported count is the TRUE number that landed, not findings.length.
    const runtime = createRuntimeFixture();
    const bundled = createBundledToolRuntime(runtime);
    let calls = 0;
    const withFlakyRecord = {
      ...bundled,
      capabilities: {
        ...bundled.capabilities,
        verification: {
          ...bundled.capabilities.verification,
          findings: {
            // First finding records for real; second returns undefined.
            record: (
              sessionId: string,
              findingInput: Parameters<
                NonNullable<typeof bundled.capabilities.verification.findings>["record"]
              >[1],
            ) => {
              calls += 1;
              return calls === 1
                ? bundled.capabilities.verification.findings.record(sessionId, findingInput)
                : undefined;
            },
          },
        },
      },
    } as typeof bundled;

    const result = commitReviewReceipts({
      runtime: withFlakyRecord,
      sessionId: "p3-flaky-1",
      runId: "p3-run-4",
      routedModel: "reviewer-model",
      dispatch: DISPATCH,
      source: { kind: "reviewer_outcome", ok: true, data: CONCERN_WITH_FINDINGS },
    });

    expect(result.committed).toBe(true);
    if (result.committed) {
      // Two findings parsed, but only one actually landed.
      expect(result.findings).toHaveLength(2);
      expect(result.recordedFindingCount).toBe(1);
    }
  });
});
