import { describe, expect, test } from "bun:test";
import {
  applyDelegationFinalizationReceipt,
  buildDelegationLifecyclePayload,
  buildDelegationRunRecordSeed,
  buildDelegationTaskIdentity,
  type DelegationFinalizationReceipt,
  type HostedDelegationTarget,
} from "@brewva/brewva-gateway/delegation";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type { SubagentOutcome } from "@brewva/brewva-tools/contracts";
import type {
  DelegationReviewDispatch,
  DelegationRunRecord,
} from "@brewva/brewva-vocabulary/delegation";
import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import {
  readReviewFindingRecordedEventPayload,
  REVIEW_FINDING_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/review";
import { createRuntimeFixture, type HostedRuntimeAdapterPort } from "../../helpers/runtime.js";

const REVIEW_TARGET: HostedDelegationTarget = {
  name: "explorer-review",
  agent: "explorer",
  targetName: "explorer",
  description: "review target",
  visibility: "public",
  resultMode: "consult",
  modelCategory: "standard",
  gateReason: "review",
  consultKind: "review",
  producesPatches: false,
  isolationStrategy: "shared",
};

const DISPATCH: DelegationReviewDispatch = {
  targetRef: {
    kind: "file_digests",
    digests: { "reviewed.ts": "digest-at-dispatch-time" },
  },
  lenses: ["hunt for rollback gaps"],
  stanceOverridden: false,
};

interface ReceiptFixtureOptions {
  readonly sessionId: string;
  readonly runId: string;
  /** Omit to build a run that is NOT tagged as a review dispatch. */
  readonly reviewDispatch?: DelegationReviewDispatch;
  readonly terminal:
    | { readonly status: "completed"; readonly resultData: Record<string, unknown> }
    | { readonly status: "failed" | "cancelled"; readonly error: string };
}

/**
 * Builds a finalization receipt around a stubbed run record, shaped exactly the
 * way the orchestrator/background runner hand it to
 * `applyDelegationFinalizationReceipt` — the REAL post-terminal funnel under
 * test. Only the record/outcome are stubbed; the observer wiring is not.
 */
function buildReceiptFixture(options: ReceiptFixtureOptions): DelegationFinalizationReceipt {
  const createdAt = Date.now() - 50;
  const finishedAt = Date.now();
  const taskIdentity = buildDelegationTaskIdentity({
    target: REVIEW_TARGET,
    label: "independent-review",
  });
  const seed = buildDelegationRunRecordSeed({
    runId: options.runId,
    target: REVIEW_TARGET,
    parentSessionId: asBrewvaSessionId(options.sessionId),
    createdAt,
    taskIdentity,
    modelRoute: { selectedModel: "openai/gpt-5.5:medium" },
  });
  const record: DelegationRunRecord =
    options.terminal.status === "completed"
      ? {
          ...seed,
          status: "completed",
          updatedAt: finishedAt,
          summary: "Independent review completed.",
          resultData: options.terminal.resultData,
          ...(options.reviewDispatch ? { reviewDispatch: options.reviewDispatch } : {}),
        }
      : {
          ...seed,
          status: options.terminal.status,
          updatedAt: finishedAt,
          summary: options.terminal.error,
          error: options.terminal.error,
          ...(options.reviewDispatch ? { reviewDispatch: options.reviewDispatch } : {}),
        };
  const outcome: SubagentOutcome =
    options.terminal.status === "completed"
      ? {
          ok: true,
          runId: options.runId,
          agent: "explorer",
          taskName: taskIdentity.taskName,
          taskPath: taskIdentity.taskPath,
          nickname: taskIdentity.nickname,
          delegate: "explorer",
          kind: "consult",
          consultKind: "review",
          status: "ok",
          summary: "Independent review completed.",
          data: options.terminal.resultData as never,
          metrics: { durationMs: finishedAt - createdAt },
          evidenceRefs: [],
        }
      : {
          ok: false,
          runId: options.runId,
          agent: "explorer",
          delegate: "explorer",
          consultKind: "review",
          status: options.terminal.status === "cancelled" ? "cancelled" : "error",
          error: options.terminal.error,
          metrics: { durationMs: finishedAt - createdAt },
        };
  return {
    runId: options.runId,
    parentSessionId: options.sessionId,
    outcome,
    record,
    lifecycleEvent: {
      type:
        options.terminal.status === "completed"
          ? "subagent_completed"
          : options.terminal.status === "cancelled"
            ? "subagent_cancelled"
            : "subagent_failed",
      payload: buildDelegationLifecyclePayload(record),
    },
    lineageOutcome: record,
    adoptLineageOutcome: false,
    slotReleaseIntent: "release_in_finally",
  };
}

function applyReceipt(runtime: HostedRuntimeAdapterPort, receipt: DelegationFinalizationReceipt) {
  applyDelegationFinalizationReceipt({
    runtime,
    receipt,
    recordLineageOutcome: () => {},
  });
}

function outcomeEvents(runtime: HostedRuntimeAdapterPort, sessionId: string) {
  return runtime.ops.events.records
    .query(sessionId, { type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE })
    .map((event) =>
      readVerificationOutcomeRecordedEventPayload(event as { payload?: Record<string, unknown> }),
    );
}

function findingEvents(runtime: HostedRuntimeAdapterPort, sessionId: string) {
  return runtime.ops.events.records
    .query(sessionId, { type: REVIEW_FINDING_RECORDED_EVENT_TYPE })
    .map((event) =>
      readReviewFindingRecordedEventPayload(event as { payload?: Record<string, unknown> }),
    );
}

const REVIEW_RESULT_DATA = {
  kind: "consult",
  consultKind: "review",
  conclusion: "issues found",
  disposition: "concern",
  findings: [
    { summary: "unchecked null deref", severity: "critical" },
    { summary: "log line leaks a token", severity: "high" },
  ],
} as const;

describe("delegation finalization — review receipt observer", () => {
  test("a completed review-tagged run commits findings plus exactly one independent outcome", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "observer-completed-1";
    const receipt = buildReceiptFixture({
      sessionId,
      runId: "review-run-observer-1",
      reviewDispatch: DISPATCH,
      terminal: { status: "completed", resultData: { ...REVIEW_RESULT_DATA } },
    });

    applyReceipt(runtime, receipt);

    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("fail");
    expect(outcomes[0]?.perspective).toBe("independent");
    expect(outcomes[0]?.level).toBe("requirements");
    // The snapshot from DISPATCH time is preserved verbatim — never re-derived
    // from the completion-time tree.
    expect(outcomes[0]?.targetRef).toEqual(DISPATCH.targetRef);
    expect(outcomes[0]?.reviewerContext?.contextId).toBe("review-run-observer-1");
    expect(outcomes[0]?.reviewerContext?.model).toBe("openai/gpt-5.5:medium");
    expect(outcomes[0]?.reviewerContext?.lenses).toEqual(["hunt for rollback gaps"]);
    expect(outcomes[0]?.independenceBasis).toContain("fresh_context");
    expect(outcomes[0]?.independenceBasis).toContain("preloaded_lens");

    const findings = findingEvents(runtime, sessionId);
    expect(findings).toHaveLength(2);
    for (const finding of findings) {
      expect(finding?.targetRef).toEqual(DISPATCH.targetRef);
    }
  });

  test("observer start-mode: a CLEAR review whose reviewDispatch carries reviewedAtomIds commits an independent pass with those atomRefs (round-trips off the run record)", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "observer-clear-atomrefs-1";
    // The atoms-target dispatch anchor rode onto the run record at dispatch time;
    // the observer reads it back (readDelegationReviewDispatch) and must populate
    // the clear outcome's atomRefs from it — this is the start-mode half of the
    // loop that the in-tool completion path also covers.
    const receipt = buildReceiptFixture({
      sessionId,
      runId: "review-run-observer-clear-1",
      reviewDispatch: { ...DISPATCH, reviewedAtomIds: ["req-1", "req-2"] },
      terminal: {
        status: "completed",
        resultData: {
          kind: "consult",
          consultKind: "review",
          conclusion: "the atoms are realized",
          disposition: "clear",
        },
      },
    });

    applyReceipt(runtime, receipt);

    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("pass");
    expect(outcomes[0]?.perspective).toBe("independent");
    // The affirmative signal survives the run-record round-trip.
    expect(outcomes[0]?.atomRefs).toEqual(["req-1", "req-2"]);
    // A clear review produces no findings.
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("observer: a CONCERN review with reviewedAtomIds still commits an EMPTY outcome atomRefs (fail never lists atoms; findings own violations)", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "observer-concern-empty-atomrefs-1";
    const receipt = buildReceiptFixture({
      sessionId,
      runId: "review-run-observer-concern-1",
      reviewDispatch: { ...DISPATCH, reviewedAtomIds: ["req-1", "req-2"] },
      terminal: { status: "completed", resultData: { ...REVIEW_RESULT_DATA } },
    });

    applyReceipt(runtime, receipt);

    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("fail");
    // Even though the dispatch named atoms, a fail outcome carries NO atomRefs.
    expect(outcomes[0]?.atomRefs).toEqual([]);
  });

  test("double-firing the finalization funnel commits receipts exactly once", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "observer-idempotent-1";
    const receipt = buildReceiptFixture({
      sessionId,
      runId: "review-run-observer-2",
      reviewDispatch: DISPATCH,
      terminal: { status: "completed", resultData: { ...REVIEW_RESULT_DATA } },
    });

    applyReceipt(runtime, receipt);
    // Observer re-entry (e.g. a duplicated terminal transition): the tape
    // already holds an independent outcome for this runId, so nothing new
    // commits — idempotency is derived from tape state, not an in-memory flag.
    applyReceipt(runtime, receipt);

    expect(outcomeEvents(runtime, sessionId)).toHaveLength(1);
    expect(findingEvents(runtime, sessionId)).toHaveLength(2);
  });

  test("a failed review-tagged run commits only a skipped outcome carrying the failure reason", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "observer-failed-1";
    const receipt = buildReceiptFixture({
      sessionId,
      runId: "review-run-observer-3",
      reviewDispatch: DISPATCH,
      terminal: { status: "failed", error: "reviewer session crashed" },
    });

    applyReceipt(runtime, receipt);

    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("skipped");
    expect(outcomes[0]?.reason).toContain("reviewer session crashed");
    expect(outcomes[0]?.targetRef).toEqual(DISPATCH.targetRef);
    // Never fabricate findings for a run that produced no verdict.
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("a cancelled review-tagged run commits only a skipped outcome", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "observer-cancelled-1";
    const receipt = buildReceiptFixture({
      sessionId,
      runId: "review-run-observer-4",
      reviewDispatch: DISPATCH,
      terminal: { status: "cancelled", error: "cancelled_by_parent" },
    });

    applyReceipt(runtime, receipt);

    const outcomes = outcomeEvents(runtime, sessionId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome).toBe("skipped");
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });

  test("a run without a reviewDispatch tag commits no review receipts", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "observer-untagged-1";
    const receipt = buildReceiptFixture({
      sessionId,
      runId: "plain-run-1",
      terminal: { status: "completed", resultData: { ...REVIEW_RESULT_DATA } },
    });

    applyReceipt(runtime, receipt);

    expect(outcomeEvents(runtime, sessionId)).toHaveLength(0);
    expect(findingEvents(runtime, sessionId)).toHaveLength(0);
  });
});
