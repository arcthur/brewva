import { describe, expect, test } from "bun:test";
import { makeEvent } from "@brewva/brewva-vocabulary/events";
import { VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import type { ReviewTargetRef } from "@brewva/brewva-vocabulary/review";
import { TOOL_COMMITTED_EVENT_TYPE } from "@brewva/brewva-vocabulary/tool-invocations";
import { SOURCE_PATCH_APPLIED_EVENT_TYPE } from "@brewva/brewva-vocabulary/workbench";
import { buildTapeReviewDebt } from "../../../packages/brewva-cli/src/operator/inspect/review-debt.js";

// The CLI tape-fold (`buildTapeReviewDebt`) is the one place Work Card,
// inspect, and run-report all read review debt from. These tests exercise the
// fold at DETERMINISTIC timestamps (hand-built events), which the real-clock
// runtime fixture cannot guarantee for sub-millisecond ordering — the natural
// home for the per-receipt-timestamp (P1-A) and coverage (P1-C) assertions.

function writeInvocation(sessionId: string, path: string, timestamp: number) {
  // The commitment boundary the projections actually read — a bare edit that
  // ran, in the shape the hosted path emits.
  return makeEvent(
    TOOL_COMMITTED_EVENT_TYPE,
    {
      call: { sessionId, toolName: "edit", args: { file_path: path } },
      result: { outcome: { kind: "ok" } },
    },
    { timestamp, id: `write-${path}-${timestamp}` },
  );
}

function patchApplied(
  sessionId: string,
  patchSetId: string,
  appliedPaths: readonly string[],
  timestamp: number,
) {
  return makeEvent(
    SOURCE_PATCH_APPLIED_EVENT_TYPE,
    {
      sessionId,
      ok: true,
      planId: `plan-${patchSetId}`,
      patchSetId,
      appliedPaths,
      failedPaths: [],
    },
    { timestamp, id: `patch-${patchSetId}-${timestamp}` },
  );
}

function outcome(
  sessionId: string,
  opts: {
    timestamp: number;
    perspective: "authored" | "independent";
    targetRef?: ReviewTargetRef;
  },
) {
  return makeEvent(
    VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
    {
      sessionId,
      outcome: "pass",
      level: "requirements",
      perspective: opts.perspective,
      ...(opts.targetRef ? { targetRef: opts.targetRef } : {}),
    },
    { timestamp: opts.timestamp, id: `outcome-${opts.perspective}-${opts.timestamp}` },
  );
}

describe("buildTapeReviewDebt — per-receipt timestamp (Finding P1-A)", () => {
  const sessionId = "review-debt-fold-p1a";

  test("a file_digests receipt is stale when a mutation lands after ITS timestamp but before the claim", () => {
    const events = [
      writeInvocation(sessionId, "a.ts", 800),
      // t1=900: independent file_digests receipt over a.ts.
      outcome(sessionId, {
        timestamp: 900,
        perspective: "independent",
        targetRef: { kind: "file_digests", digests: { "a.ts": "sha-a" } },
      }),
      // t2=950: a patch mutates the tree AFTER the receipt but BEFORE the claim.
      patchApplied(sessionId, "ps-1", ["a.ts"], 950),
      // t3=1000: the authored claim being judged.
      outcome(sessionId, { timestamp: 1_000, perspective: "authored" }),
    ];

    const debt = buildTapeReviewDebt(events);

    // Judged against the receipt's OWN timestamp (900), the t2 mutation (950)
    // makes it stale. The pre-fix bug judged it against the claim (1000) as
    // fresh and wrongly cleared debt.
    expect(debt.debt).toBe(true);
    expect(debt.reason).toBe("independent_receipts_stale");
  });

  test("control: the same receipt is fresh (debt cleared) when NO mutation lands after its own timestamp", () => {
    const events = [
      writeInvocation(sessionId, "a.ts", 800),
      patchApplied(sessionId, "ps-1", ["a.ts"], 850),
      // t1=900: independent receipt AFTER the only mutation.
      outcome(sessionId, {
        timestamp: 900,
        perspective: "independent",
        targetRef: { kind: "file_digests", digests: { "a.ts": "sha-a" } },
      }),
      outcome(sessionId, { timestamp: 1_000, perspective: "authored" }),
    ];

    const debt = buildTapeReviewDebt(events);

    expect(debt.debt).toBe(false);
    expect(debt.reason).toBeNull();
  });
});

describe("buildTapeReviewDebt — coverage over the fresh-touched universe (Finding P1-C)", () => {
  const sessionId = "review-debt-fold-p1c";

  test("a file_digests receipt covering only a.ts leaves debt when b.ts was also touched", () => {
    const events = [
      writeInvocation(sessionId, "a.ts", 800),
      writeInvocation(sessionId, "b.ts", 810),
      outcome(sessionId, {
        timestamp: 900,
        perspective: "independent",
        targetRef: { kind: "file_digests", digests: { "a.ts": "sha-a" } },
      }),
      outcome(sessionId, { timestamp: 1_000, perspective: "authored" }),
    ];

    const debt = buildTapeReviewDebt(events);

    expect(debt.debt).toBe(true);
    expect(debt.reason).toBe("independent_receipts_stale");
  });

  test("a file_digests receipt covering both touched files clears debt", () => {
    const events = [
      writeInvocation(sessionId, "a.ts", 800),
      writeInvocation(sessionId, "b.ts", 810),
      outcome(sessionId, {
        timestamp: 900,
        perspective: "independent",
        targetRef: { kind: "file_digests", digests: { "a.ts": "sha-a", "b.ts": "sha-b" } },
      }),
      outcome(sessionId, { timestamp: 1_000, perspective: "authored" }),
    ];

    const debt = buildTapeReviewDebt(events);

    expect(debt.debt).toBe(false);
    expect(debt.reason).toBeNull();
  });

  test("a session_diff patch_sets receipt over all applied sets covers all patch-applied files", () => {
    const events = [
      // The fresh writes are exactly the patch-applied files (no bare write
      // outside a patch set), so the session_diff review covers the change.
      patchApplied(sessionId, "ps-1", ["a.ts"], 800),
      patchApplied(sessionId, "ps-2", ["b.ts"], 810),
      outcome(sessionId, {
        timestamp: 900,
        perspective: "independent",
        targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1", "ps-2"] },
      }),
      outcome(sessionId, { timestamp: 1_000, perspective: "authored" }),
    ];

    const debt = buildTapeReviewDebt(events);

    expect(debt.debt).toBe(false);
    expect(debt.reason).toBeNull();
  });

  test("a session_diff patch_sets receipt does NOT cover a bare write outside any patch set (honest)", () => {
    const events = [
      patchApplied(sessionId, "ps-1", ["a.ts"], 800),
      // A bare edit of c.ts that no patch set covers.
      writeInvocation(sessionId, "c.ts", 810),
      outcome(sessionId, {
        timestamp: 900,
        perspective: "independent",
        targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
      }),
      outcome(sessionId, { timestamp: 1_000, perspective: "authored" }),
    ];

    const debt = buildTapeReviewDebt(events);

    // c.ts is in the universe but not attested by the patch_sets ref -> debt.
    expect(debt.debt).toBe(true);
    expect(debt.reason).toBe("independent_receipts_stale");
  });

  test("a single-file session clears debt with a file_digests receipt over that file", () => {
    const events = [
      writeInvocation(sessionId, "a.ts", 800),
      outcome(sessionId, {
        timestamp: 900,
        perspective: "independent",
        targetRef: { kind: "file_digests", digests: { "a.ts": "sha-a" } },
      }),
      outcome(sessionId, { timestamp: 1_000, perspective: "authored" }),
    ];

    const debt = buildTapeReviewDebt(events);

    expect(debt.debt).toBe(false);
    expect(debt.reason).toBeNull();
  });
});

describe("buildTapeReviewDebt — a bare write/edit ages the tree (Finding P1)", () => {
  const sessionId = "review-debt-fold-p1-bare-write";

  test("a file_digests receipt at t1 is STALED by a bare edit at t2 > t1 (the fix)", () => {
    const events = [
      // t1=900: an independent file_digests receipt over a.ts (a full-coverage review).
      outcome(sessionId, {
        timestamp: 900,
        perspective: "independent",
        targetRef: { kind: "file_digests", digests: { "a.ts": "sha-a" } },
      }),
      // t2=950: a bare edit of a.ts AFTER the receipt. Before the fix this did not
      // advance latestTreeMutationAt (only patch/rollback did), so the receipt was
      // wrongly judged fresh and cleared debt. A bare write mutates the tree.
      writeInvocation(sessionId, "a.ts", 950),
      // t3=1000: the authored claim being judged.
      outcome(sessionId, { timestamp: 1_000, perspective: "authored" }),
    ];

    const debt = buildTapeReviewDebt(events);

    expect(debt.debt).toBe(true);
    expect(debt.reason).toBe("independent_receipts_stale");
  });

  test("negative: a bare edit BEFORE the receipt (t2 < t1) does NOT stale it", () => {
    const events = [
      // t2=800: a bare edit of a.ts BEFORE the receipt — the reviewer saw this write.
      writeInvocation(sessionId, "a.ts", 800),
      // t1=900: independent file_digests receipt over the (already-written) a.ts.
      outcome(sessionId, {
        timestamp: 900,
        perspective: "independent",
        targetRef: { kind: "file_digests", digests: { "a.ts": "sha-a" } },
      }),
      outcome(sessionId, { timestamp: 1_000, perspective: "authored" }),
    ];

    const debt = buildTapeReviewDebt(events);

    // latestTreeMutationAt (800) <= receiptTimestamp (900): nothing changed since
    // the reviewer looked, so the receipt is fresh and clears debt.
    expect(debt.debt).toBe(false);
    expect(debt.reason).toBeNull();
  });
});
