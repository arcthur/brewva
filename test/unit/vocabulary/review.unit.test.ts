import { describe, expect, test } from "bun:test";
import {
  attestedFilesForRef,
  deriveFreshTouchedFileUniverse,
  INDEPENDENCE_BASES,
  projectReviewDebt,
  projectTapeReviewDebt,
  projectUnaddressedReviewFindings,
  readReviewFindingRecordedEventPayload,
  REVIEW_FINDING_CATEGORIES,
  REVIEW_FINDING_RECORDED_EVENT_TYPE,
  reviewAnchorFilePath,
  reviewTargetRefMatchesTapeOnly,
  reviewTargetRefMatchesTree,
  universeCoveredBy,
  VERIFICATION_PERSPECTIVES,
  VERIFICATION_RUNGS,
  type FreshTouchedFileUniverse,
  type ReviewDebtInput,
  type ReviewFindingRecordedEventPayload,
  type ReviewTargetRef,
  type TapeReviewDebtInput,
  type TapeReviewFinding,
  type TapeVerificationReceipt,
} from "@brewva/brewva-vocabulary/review";

describe("verification perspective / independence vocabulary", () => {
  test("pins the wire values", () => {
    expect(VERIFICATION_PERSPECTIVES).toEqual(["authored", "independent"]);
    expect(INDEPENDENCE_BASES).toEqual([
      "fresh_context",
      "different_model",
      "preloaded_lens",
      "human",
      "deterministic_adapter",
    ]);
  });
});

describe("REVIEW_FINDING_RECORDED_EVENT_TYPE", () => {
  test("pins the wire value", () => {
    expect(REVIEW_FINDING_RECORDED_EVENT_TYPE).toBe("review.finding.recorded");
  });
});

describe("readReviewFindingRecordedEventPayload", () => {
  const validTargetRef: ReviewTargetRef = {
    kind: "patch_sets",
    patchSetRefs: ["ps-1"],
  };

  test("reads a fully-populated valid finding", () => {
    const result = readReviewFindingRecordedEventPayload({
      payload: {
        findingId: "finding-1",
        severity: "high",
        category: "correctness",
        statement: "Off-by-one in the loop bound.",
        anchors: ["src/a.ts:10"],
        lens: "correctness",
        targetRef: validTargetRef,
        atomRefs: ["atom-1", "atom-2"],
      },
    });

    expect(result).toEqual({
      findingId: "finding-1",
      severity: "high",
      category: "correctness",
      statement: "Off-by-one in the loop bound.",
      anchors: ["src/a.ts:10"],
      lens: "correctness",
      targetRef: validTargetRef,
      atomRefs: ["atom-1", "atom-2"],
    } satisfies ReviewFindingRecordedEventPayload);
  });

  test("reads a finding with a file_digests targetRef and a null lens", () => {
    const result = readReviewFindingRecordedEventPayload({
      payload: {
        findingId: "finding-2",
        severity: "low",
        category: "style",
        statement: "Prefer const over let.",
        anchors: [],
        lens: null,
        targetRef: { kind: "file_digests", digests: { "src/b.ts": "sha-b" } },
        atomRefs: [],
      },
    });

    expect(result?.lens).toBeNull();
    expect(result?.targetRef).toEqual({
      kind: "file_digests",
      digests: { "src/b.ts": "sha-b" },
    });
    expect(result?.anchors).toEqual([]);
    expect(result?.atomRefs).toEqual([]);
  });

  test("returns null for the WHOLE payload when targetRef is missing (a finding that cannot say what it reviewed is not evidence)", () => {
    const result = readReviewFindingRecordedEventPayload({
      payload: {
        findingId: "finding-3",
        severity: "high",
        category: "correctness",
        statement: "Some statement.",
        anchors: [],
        lens: null,
        atomRefs: [],
      },
    });
    expect(result).toBeNull();
  });

  test("returns null for the WHOLE payload when targetRef is malformed or an unknown kind", () => {
    for (const malformed of [
      null,
      "not-an-object",
      {},
      { kind: "diff_digest", ref: "x" },
      { kind: "patch_sets", patchSetRefs: "not-an-array" },
      { kind: "file_digests", digests: "not-an-object" },
    ]) {
      const result = readReviewFindingRecordedEventPayload({
        payload: {
          findingId: "finding-4",
          severity: "high",
          category: "correctness",
          statement: "Some statement.",
          anchors: [],
          lens: null,
          targetRef: malformed as never,
          atomRefs: [],
        },
      });
      expect(result).toBeNull();
    }
  });

  test("returns null for the whole payload when the event has no payload at all", () => {
    expect(readReviewFindingRecordedEventPayload({})).toBeNull();
  });

  test("coerces a non-string findingId/statement/lens and non-array anchors/atomRefs to safe defaults", () => {
    const result = readReviewFindingRecordedEventPayload({
      payload: {
        findingId: 42,
        severity: "bogus_severity",
        category: "bogus_category",
        statement: null,
        anchors: "not-an-array",
        lens: 42,
        targetRef: validTargetRef,
        atomRefs: "not-an-array",
      },
    });
    expect(result).not.toBeNull();
    expect(result?.findingId).toBe("");
    expect(result?.statement).toBe("");
    expect(result?.lens).toBeNull();
    expect(result?.anchors).toEqual([]);
    expect(result?.atomRefs).toEqual([]);
  });

  test("filters non-string entries out of anchors and atomRefs", () => {
    const result = readReviewFindingRecordedEventPayload({
      payload: {
        findingId: "finding-5",
        severity: "medium",
        category: "correctness",
        statement: "Statement.",
        anchors: ["a.ts:1", 2, null],
        lens: null,
        targetRef: validTargetRef,
        atomRefs: ["atom-1", 3, undefined],
      },
    });
    expect(result?.anchors).toEqual(["a.ts:1"]);
    expect(result?.atomRefs).toEqual(["atom-1"]);
  });
});

describe("reviewTargetRefMatchesTree", () => {
  test("patch_sets: matches on set-equality, order-insensitive", () => {
    const ref: ReviewTargetRef = {
      kind: "patch_sets",
      patchSetRefs: ["ps-1", "ps-2"],
    };
    expect(
      reviewTargetRefMatchesTree(ref, {
        appliedPatchSetRefs: ["ps-2", "ps-1"],
        fileDigest: () => null,
      }),
    ).toBe(true);
  });

  test("patch_sets: extra applied patches since the snapshot means stale", () => {
    const ref: ReviewTargetRef = { kind: "patch_sets", patchSetRefs: ["ps-1"] };
    expect(
      reviewTargetRefMatchesTree(ref, {
        appliedPatchSetRefs: ["ps-1", "ps-2"],
        fileDigest: () => null,
      }),
    ).toBe(false);
  });

  test("patch_sets: a missing recorded patch means stale", () => {
    const ref: ReviewTargetRef = {
      kind: "patch_sets",
      patchSetRefs: ["ps-1", "ps-2"],
    };
    expect(
      reviewTargetRefMatchesTree(ref, {
        appliedPatchSetRefs: ["ps-1"],
        fileDigest: () => null,
      }),
    ).toBe(false);
  });

  test("file_digests: matches when every recorded path's current digest equals the recorded digest", () => {
    const ref: ReviewTargetRef = {
      kind: "file_digests",
      digests: { "src/a.ts": "sha-a", "src/b.ts": "sha-b" },
    };
    const digestMap: Record<string, string> = {
      "src/a.ts": "sha-a",
      "src/b.ts": "sha-b",
    };
    expect(
      reviewTargetRefMatchesTree(ref, {
        appliedPatchSetRefs: [],
        fileDigest: (path) => digestMap[path] ?? null,
      }),
    ).toBe(true);
  });

  test("file_digests: a changed digest means stale", () => {
    const ref: ReviewTargetRef = {
      kind: "file_digests",
      digests: { "src/a.ts": "sha-a" },
    };
    expect(
      reviewTargetRefMatchesTree(ref, {
        appliedPatchSetRefs: [],
        fileDigest: () => "sha-changed",
      }),
    ).toBe(false);
  });

  test("file_digests: a missing file means stale", () => {
    const ref: ReviewTargetRef = {
      kind: "file_digests",
      digests: { "src/a.ts": "sha-a" },
    };
    expect(
      reviewTargetRefMatchesTree(ref, {
        appliedPatchSetRefs: [],
        fileDigest: () => null,
      }),
    ).toBe(false);
  });
});

describe("projectReviewDebt", () => {
  const matchesNothing: ReviewDebtInput["matchesTree"] = () => false;
  const matchesEverything: ReviewDebtInput["matchesTree"] = () => true;
  const patchSetRef: ReviewTargetRef = {
    kind: "patch_sets",
    patchSetRefs: ["ps-1"],
  };

  function baseInput(overrides: Partial<ReviewDebtInput> = {}): ReviewDebtInput {
    return {
      freshCodeWritten: true,
      claim: { outcome: "pass", level: "requirements" },
      independentReceipts: [],
      matchesTree: matchesNothing,
      // Default: an empty, fully-known universe — coverage is trivially
      // satisfied, so the pre-coverage tests below exercise only the tree-match
      // gate exactly as they did before P1-C.
      freshTouchedUniverse: { files: new Set<string>(), fullyKnown: true },
      covers: () => true,
      ...overrides,
    };
  }

  test("no debt when no fresh code was written this session", () => {
    const result = projectReviewDebt(baseInput({ freshCodeWritten: false }));
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("no debt when the claim outcome is fail", () => {
    const result = projectReviewDebt(
      baseInput({ claim: { outcome: "fail", level: "requirements" } }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("no debt when the claim outcome is skipped", () => {
    const result = projectReviewDebt(
      baseInput({ claim: { outcome: "skipped", level: "requirements" } }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("no debt when the claim level is null (no ladder rung recorded)", () => {
    const result = projectReviewDebt(baseInput({ claim: { outcome: "pass", level: null } }));
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("no debt when the claim level is an unrecognized string", () => {
    const result = projectReviewDebt(
      baseInput({ claim: { outcome: "pass", level: "not_a_real_rung" } }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("no debt below the requirements rung: exit_code", () => {
    const result = projectReviewDebt(baseInput({ claim: { outcome: "pass", level: "exit_code" } }));
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("no debt below the requirements rung: diagnostics", () => {
    const result = projectReviewDebt(
      baseInput({ claim: { outcome: "pass", level: "diagnostics" } }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("no debt below the requirements rung: artifact", () => {
    const result = projectReviewDebt(baseInput({ claim: { outcome: "pass", level: "artifact" } }));
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("debt fires exactly at the requirements rung boundary", () => {
    const result = projectReviewDebt(
      baseInput({ claim: { outcome: "pass", level: "requirements" } }),
    );
    expect(result).toEqual({ debt: true, reason: "no_independent_receipt" });
  });

  test("debt still fires above requirements: runtime_smoke", () => {
    const result = projectReviewDebt(
      baseInput({ claim: { outcome: "pass", level: "runtime_smoke" } }),
    );
    expect(result).toEqual({ debt: true, reason: "no_independent_receipt" });
  });

  test("no_independent_receipt: no independent receipts exist at all", () => {
    const result = projectReviewDebt(baseInput({ independentReceipts: [] }));
    expect(result).toEqual({ debt: true, reason: "no_independent_receipt" });
  });

  test("independent_receipts_stale: receipts exist but none match the current tree", () => {
    const result = projectReviewDebt(
      baseInput({
        independentReceipts: [{ targetRef: patchSetRef }, { targetRef: null }],
        matchesTree: matchesNothing,
      }),
    );
    expect(result).toEqual({
      debt: true,
      reason: "independent_receipts_stale",
    });
  });

  test("independent_receipts_stale: a receipt with a null targetRef never counts as a match", () => {
    const result = projectReviewDebt(
      baseInput({
        independentReceipts: [{ targetRef: null }],
        matchesTree: matchesEverything,
      }),
    );
    expect(result).toEqual({
      debt: true,
      reason: "independent_receipts_stale",
    });
  });

  test("no debt when an independent receipt's targetRef matches the current tree", () => {
    const result = projectReviewDebt(
      baseInput({
        independentReceipts: [{ targetRef: patchSetRef }],
        matchesTree: matchesEverything,
      }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("no debt when at least one of several independent receipts matches", () => {
    let calls = 0;
    const result = projectReviewDebt(
      baseInput({
        independentReceipts: [{ targetRef: patchSetRef }, { targetRef: patchSetRef }],
        matchesTree: () => {
          calls += 1;
          return calls === 2;
        },
      }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("rank ordering follows VERIFICATION_RUNGS exactly (sanity check on the fixture)", () => {
    expect(VERIFICATION_RUNGS.indexOf("requirements")).toBe(3);
    expect(VERIFICATION_RUNGS.indexOf("runtime_smoke")).toBe(4);
    expect(VERIFICATION_RUNGS.indexOf("artifact")).toBe(2);
  });

  // Finding P1-C on the LIVE core: a receipt that matches the tree but does NOT
  // cover the fresh-touched universe leaves debt (reason stays
  // independent_receipts_stale — a receipt exists but does not clear).
  test("P1-C live: a matching receipt that does not cover the universe leaves debt", () => {
    const result = projectReviewDebt(
      baseInput({
        independentReceipts: [{ targetRef: patchSetRef }],
        matchesTree: matchesEverything,
        covers: () => false,
      }),
    );
    expect(result).toEqual({ debt: true, reason: "independent_receipts_stale" });
  });

  test("P1-C live: a receipt that both matches and covers clears debt", () => {
    const result = projectReviewDebt(
      baseInput({
        independentReceipts: [{ targetRef: patchSetRef }],
        matchesTree: matchesEverything,
        covers: () => true,
      }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("P1-C live: a receipt that covers but is stale (no tree match) leaves debt", () => {
    const result = projectReviewDebt(
      baseInput({
        independentReceipts: [{ targetRef: patchSetRef }],
        matchesTree: matchesNothing,
        covers: () => true,
      }),
    );
    expect(result).toEqual({ debt: true, reason: "independent_receipts_stale" });
  });
});

describe("reviewTargetRefMatchesTapeOnly", () => {
  test("patch_sets: same set-equality rule as the filesystem-backed variant", () => {
    const ref: ReviewTargetRef = { kind: "patch_sets", patchSetRefs: ["ps-1", "ps-2"] };
    expect(
      reviewTargetRefMatchesTapeOnly(ref, {
        appliedPatchSetRefs: ["ps-2", "ps-1"],
        receiptTimestamp: 1_000,
        latestTreeMutationAt: null,
      }),
    ).toBe(true);
    expect(
      reviewTargetRefMatchesTapeOnly(ref, {
        appliedPatchSetRefs: ["ps-1"],
        receiptTimestamp: 1_000,
        latestTreeMutationAt: null,
      }),
    ).toBe(false);
  });

  test("file_digests: matches when no patch has landed since the receipt (nothing on tape could have changed the tree)", () => {
    const ref: ReviewTargetRef = {
      kind: "file_digests",
      digests: { "src/a.ts": "sha-a" },
    };
    expect(
      reviewTargetRefMatchesTapeOnly(ref, {
        appliedPatchSetRefs: [],
        receiptTimestamp: 1_000,
        latestTreeMutationAt: null,
      }),
    ).toBe(true);
    expect(
      reviewTargetRefMatchesTapeOnly(ref, {
        appliedPatchSetRefs: [],
        receiptTimestamp: 1_000,
        latestTreeMutationAt: 500,
      }),
    ).toBe(true);
  });

  test("file_digests: a patch applied after the receipt's timestamp is stale, even if it never touched the reviewed files (under-claims freshness, never over-claims)", () => {
    const ref: ReviewTargetRef = {
      kind: "file_digests",
      digests: { "src/a.ts": "sha-a" },
    };
    expect(
      reviewTargetRefMatchesTapeOnly(ref, {
        appliedPatchSetRefs: [],
        receiptTimestamp: 1_000,
        latestTreeMutationAt: 1_001,
      }),
    ).toBe(false);
  });

  test("file_digests: a patch applied at exactly the receipt's own timestamp still matches (the receipt's own commit does not stale itself)", () => {
    const ref: ReviewTargetRef = {
      kind: "file_digests",
      digests: { "src/a.ts": "sha-a" },
    };
    expect(
      reviewTargetRefMatchesTapeOnly(ref, {
        appliedPatchSetRefs: [],
        receiptTimestamp: 1_000,
        latestTreeMutationAt: 1_000,
      }),
    ).toBe(true);
  });
});

describe("projectTapeReviewDebt", () => {
  const independentPatchSetReceipt: TapeVerificationReceipt = {
    timestamp: 900,
    outcome: "pass",
    level: "requirements",
    perspective: "independent",
    targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
  };

  function baseInput(overrides: Partial<TapeReviewDebtInput> = {}): TapeReviewDebtInput {
    return {
      freshCodeWritten: true,
      receipts: [],
      appliedPatchSetRefs: ["ps-1"],
      latestTreeMutationAt: null,
      // Defaults: an empty fully-known universe (coverage trivially satisfied)
      // and no patch-set path map — so the pre-P1-C tape tests below exercise
      // only the freshness gate, exactly as before. P1-C cases override these.
      freshTouchedUniverse: { files: new Set<string>(), fullyKnown: true },
      patchSetAppliedPaths: {},
      ...overrides,
    };
  }

  test("no debt when the tape holds no verification receipt at all", () => {
    const result = projectTapeReviewDebt(baseInput({ receipts: [] }));
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("no debt when the latest receipt is below the requirements rung", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "artifact",
            perspective: "authored",
            targetRef: null,
          },
        ],
      }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("debt fires for the latest authored pass at requirements+ with no independent receipt at all", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
      }),
    );
    expect(result).toEqual({ debt: true, reason: "no_independent_receipt" });
  });

  test("no debt when an independent receipt's targetRef still matches under the tape-only rule", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          independentPatchSetReceipt,
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
        appliedPatchSetRefs: ["ps-1"],
      }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("independent_receipts_stale: an independent receipt exists but a later patch set landed since (patch_sets drift)", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          independentPatchSetReceipt,
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
        appliedPatchSetRefs: ["ps-1", "ps-2"],
      }),
    );
    expect(result).toEqual({ debt: true, reason: "independent_receipts_stale" });
  });

  test("independent_receipts_stale: a file_digests independent receipt is stale once a later patch lands on the tape", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 900,
            outcome: "pass",
            level: "requirements",
            perspective: "independent",
            targetRef: { kind: "file_digests", digests: { "src/a.ts": "sha-a" } },
          },
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
        latestTreeMutationAt: 1_500,
      }),
    );
    expect(result).toEqual({ debt: true, reason: "independent_receipts_stale" });
  });

  test("no debt when fresh code was not written this session", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        freshCodeWritten: false,
        receipts: [
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
      }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("judges only the LATEST receipt as the claim: an earlier fail does not mask a later pass's debt", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 500,
            outcome: "fail",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
      }),
    );
    expect(result).toEqual({ debt: true, reason: "no_independent_receipt" });
  });

  // Finding P1-A: each independent receipt's freshness must be judged against
  // ITS OWN timestamp, not the latest claim's. A file_digests receipt reviewed
  // at t1, a tree mutation at t2 > t1, then a later authored claim at t3 > t2
  // must leave debt: the receipt is stale (a mutation landed after the reviewer
  // looked), even though the mutation predates the claim.
  test("P1-A: a file_digests receipt is stale when a tree mutation lands after ITS timestamp, though before the claim", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 900,
            outcome: "pass",
            level: "requirements",
            perspective: "independent",
            targetRef: { kind: "file_digests", digests: { "src/a.ts": "sha-a" } },
          },
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
        // The mutation (t=950) is AFTER the receipt (t=900) but BEFORE the claim
        // (t=1000). Judged against the claim's timestamp it would look fresh
        // (the pre-fix bug); judged against the receipt's own timestamp it is
        // correctly stale.
        latestTreeMutationAt: 950,
        // No writes we can map to files here, so coverage is not the gate under
        // test — freshness is. Provide a covering universe so the ONLY reason
        // debt can fire is staleness, isolating the P1-A fix.
        freshTouchedUniverse: { files: new Set(["src/a.ts"]), fullyKnown: true },
      }),
    );
    expect(result).toEqual({ debt: true, reason: "independent_receipts_stale" });
  });

  test("P1-A control: the same receipt is fresh when NO mutation lands after its own timestamp", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 900,
            outcome: "pass",
            level: "requirements",
            perspective: "independent",
            targetRef: { kind: "file_digests", digests: { "src/a.ts": "sha-a" } },
          },
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
        latestTreeMutationAt: 800,
        freshTouchedUniverse: { files: new Set(["src/a.ts"]), fullyKnown: true },
      }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  // Finding P1-C: coverage over the fresh-touched-file universe, tape-derived.
  test("P1-C: a file_digests receipt covering only a.ts does NOT clear debt when the session also touched b.ts", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 900,
            outcome: "pass",
            level: "requirements",
            perspective: "independent",
            targetRef: { kind: "file_digests", digests: { "src/a.ts": "sha-a" } },
          },
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
        latestTreeMutationAt: null,
        freshTouchedUniverse: { files: new Set(["src/a.ts", "src/b.ts"]), fullyKnown: true },
      }),
    );
    expect(result).toEqual({ debt: true, reason: "independent_receipts_stale" });
  });

  test("P1-C: a file_digests receipt covering {a.ts, b.ts} clears debt when the session touched both", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 900,
            outcome: "pass",
            level: "requirements",
            perspective: "independent",
            targetRef: {
              kind: "file_digests",
              digests: { "src/a.ts": "sha-a", "src/b.ts": "sha-b" },
            },
          },
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
        latestTreeMutationAt: null,
        freshTouchedUniverse: { files: new Set(["src/a.ts", "src/b.ts"]), fullyKnown: true },
      }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("P1-C single-file session: file_digests{a.ts} clears debt when only a.ts was touched", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 900,
            outcome: "pass",
            level: "requirements",
            perspective: "independent",
            targetRef: { kind: "file_digests", digests: { "src/a.ts": "sha-a" } },
          },
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
        latestTreeMutationAt: null,
        freshTouchedUniverse: { files: new Set(["src/a.ts"]), fullyKnown: true },
      }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("P1-C: a session_diff patch_sets receipt over all applied sets covers all patch-applied files", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 900,
            outcome: "pass",
            level: "requirements",
            perspective: "independent",
            targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1", "ps-2"] },
          },
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
        appliedPatchSetRefs: ["ps-1", "ps-2"],
        latestTreeMutationAt: null,
        freshTouchedUniverse: { files: new Set(["src/a.ts", "src/b.ts"]), fullyKnown: true },
        // patch_sets attested files come from the applied receipts' appliedPaths.
        patchSetAppliedPaths: { "ps-1": ["src/a.ts"], "ps-2": ["src/b.ts"] },
      }),
    );
    expect(result).toEqual({ debt: false, reason: null });
  });

  test("P1-C conservative: a not-fully-known universe never clears debt, even with a matching receipt", () => {
    const result = projectTapeReviewDebt(
      baseInput({
        receipts: [
          {
            timestamp: 900,
            outcome: "pass",
            level: "requirements",
            perspective: "independent",
            targetRef: { kind: "file_digests", digests: { "src/a.ts": "sha-a" } },
          },
          {
            timestamp: 1_000,
            outcome: "pass",
            level: "requirements",
            perspective: "authored",
            targetRef: null,
          },
        ],
        latestTreeMutationAt: null,
        // A write whose path could not be parsed: fullyKnown=false. Coverage can
        // never be proven, so debt must show (never falsely clear).
        freshTouchedUniverse: { files: new Set<string>(), fullyKnown: false },
      }),
    );
    expect(result).toEqual({ debt: true, reason: "independent_receipts_stale" });
  });
});

describe("REVIEW_FINDING_CATEGORIES (P3 taxonomy)", () => {
  test("covers the review-lane dimensions plus the explicit unknown member", () => {
    expect(REVIEW_FINDING_CATEGORIES).toEqual([
      "correctness",
      "security",
      "performance",
      "concurrency",
      "compatibility",
      "operability",
      "style",
      "test_coverage",
      "documentation",
      "unknown",
    ]);
  });
});

describe("deriveFreshTouchedFileUniverse (P1-C)", () => {
  test("unions patch appliedPaths and write-invocation paths, normalized", () => {
    const universe = deriveFreshTouchedFileUniverse({
      appliedPaths: ["src/a.ts", "./src/b.ts"],
      writeInvocationPaths: [{ path: "src/c.ts", cwd: null }],
    });
    expect(universe.fullyKnown).toBe(true);
    expect([...universe.files].toSorted()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("relativizes an absolute write path against its cwd so it matches a workspace-relative attested path", () => {
    const universe = deriveFreshTouchedFileUniverse({
      appliedPaths: [],
      writeInvocationPaths: [{ path: "/repo/src/a.ts", cwd: "/repo" }],
    });
    expect(universe.fullyKnown).toBe(true);
    expect([...universe.files]).toEqual(["src/a.ts"]);
  });

  test("a null write path marks the universe not-fully-known (conservative)", () => {
    const universe = deriveFreshTouchedFileUniverse({
      appliedPaths: ["src/a.ts"],
      writeInvocationPaths: [{ path: null, cwd: null }],
    });
    expect(universe.fullyKnown).toBe(false);
    // The known files are still surfaced; fullyKnown is the gate.
    expect([...universe.files]).toEqual(["src/a.ts"]);
  });

  test("an empty universe with no unparseable writes is fully known", () => {
    const universe = deriveFreshTouchedFileUniverse({
      appliedPaths: [],
      writeInvocationPaths: [],
    });
    expect(universe.fullyKnown).toBe(true);
    expect(universe.files.size).toBe(0);
  });
});

describe("attestedFilesForRef (P1-C)", () => {
  test("file_digests: attested files are the normalized digest keys", () => {
    const attested = attestedFilesForRef(
      { kind: "file_digests", digests: { "src/a.ts": "sha-a", "./src/b.ts": "sha-b" } },
      () => [],
    );
    expect([...attested].toSorted()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("patch_sets: attested files are the union of appliedPaths for the ref's patch sets", () => {
    const attested = attestedFilesForRef(
      { kind: "patch_sets", patchSetRefs: ["ps-1", "ps-2"] },
      (id) => (id === "ps-1" ? ["src/a.ts"] : id === "ps-2" ? ["src/b.ts"] : []),
    );
    expect([...attested].toSorted()).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("universeCoveredBy (P1-C)", () => {
  const knownAB: FreshTouchedFileUniverse = {
    files: new Set(["src/a.ts", "src/b.ts"]),
    fullyKnown: true,
  };

  test("covered when attested ⊇ universe", () => {
    expect(universeCoveredBy(new Set(["src/a.ts", "src/b.ts", "src/c.ts"]), knownAB)).toBe(true);
  });

  test("not covered when a universe file is missing from attested", () => {
    expect(universeCoveredBy(new Set(["src/a.ts"]), knownAB)).toBe(false);
  });

  test("an empty fully-known universe is trivially covered by any attested set", () => {
    expect(universeCoveredBy(new Set<string>(), { files: new Set(), fullyKnown: true })).toBe(true);
  });

  test("a not-fully-known universe is never covered (conservative, never falsely clear)", () => {
    expect(
      universeCoveredBy(new Set(["src/a.ts", "src/b.ts"]), { ...knownAB, fullyKnown: false }),
    ).toBe(false);
  });
});

describe("projectUnaddressedReviewFindings — the act-on-review closure signal", () => {
  function finding(
    overrides: Partial<ReviewFindingRecordedEventPayload> & { findingId: string },
  ): ReviewFindingRecordedEventPayload {
    return {
      findingId: overrides.findingId,
      severity: overrides.severity ?? "high",
      category: overrides.category ?? "correctness",
      statement: overrides.statement ?? `statement ${overrides.findingId}`,
      anchors: overrides.anchors ?? [],
      lens: overrides.lens ?? null,
      targetRef: overrides.targetRef ?? { kind: "file_digests", digests: { "a.swift": "sha-a" } },
      atomRefs: overrides.atomRefs ?? [],
    };
  }
  const at = (
    payload: ReviewFindingRecordedEventPayload,
    receiptTimestamp: number,
  ): TapeReviewFinding => ({
    finding: payload,
    receiptTimestamp,
  });
  const empty = new Map<string, number>();

  test("reviewAnchorFilePath strips line/col spans and normalizes; empty yields null", () => {
    expect(reviewAnchorFilePath("Sources/VoiceBar/FnKeyMonitor.swift:50-53")).toBe(
      "Sources/VoiceBar/FnKeyMonitor.swift",
    );
    expect(reviewAnchorFilePath("Makefile:10")).toBe("Makefile");
    expect(reviewAnchorFilePath("src/a.ts:10:5")).toBe("src/a.ts"); // line:col
    expect(reviewAnchorFilePath("bare.swift")).toBe("bare.swift"); // no span
    expect(reviewAnchorFilePath("./a.swift")).toBe("a.swift");
    expect(reviewAnchorFilePath("")).toBeNull();
    expect(reviewAnchorFilePath("   ")).toBeNull();
  });

  test("a fresh finding whose anchor file was NOT touched since is unaddressed and surfaces", () => {
    const result = projectUnaddressedReviewFindings({
      findings: [
        at(finding({ findingId: "f-1", anchors: ["a.swift:1-5"], atomRefs: ["req-1"] }), 100),
      ],
      // a.swift last mutated BEFORE the finding (the reviewed version) -> still live.
      fileMutationTimeline: new Map([["a.swift", 50]]),
      appliedPatchSetRefs: [],
      latestTreeMutationAt: 50,
    });
    expect(result.findings).toEqual([
      { findingId: "f-1", severity: "high", statement: "statement f-1", atomRefs: ["req-1"] },
    ]);
    expect(result.countBySeverity).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
    expect(result.atomRefs).toEqual(["req-1"]);
  });

  test("ANCHOR-scoped: an unrelated file changing does NOT clear a finding (the game_8 dodge, fixed)", () => {
    // Finding flags a.swift; the model edits b.swift after. Whole-tree freshness
    // would wrongly clear it; anchor-scoped keeps it live because a.swift stands.
    const result = projectUnaddressedReviewFindings({
      findings: [at(finding({ findingId: "f-open", anchors: ["a.swift:1"] }), 100)],
      fileMutationTimeline: new Map([["b.swift", 200]]),
      appliedPatchSetRefs: [],
      latestTreeMutationAt: 200,
    });
    expect(result.findings.map((entry) => entry.findingId)).toEqual(["f-open"]);
  });

  test("a finding whose OWN anchor file changed after it is ADDRESSED and dropped", () => {
    const result = projectUnaddressedReviewFindings({
      findings: [at(finding({ findingId: "f-fixed", anchors: ["a.swift:1"] }), 100)],
      fileMutationTimeline: new Map([["a.swift", 200]]), // touched after -> acted on
      appliedPatchSetRefs: [],
      latestTreeMutationAt: 200,
    });
    expect(result.findings).toEqual([]);
  });

  test("per-finding timestamp (P1-A): the anchor's mutation ages only the finding recorded before it", () => {
    const result = projectUnaddressedReviewFindings({
      findings: [
        at(finding({ findingId: "old", anchors: ["a.swift:1"], atomRefs: ["req-1"] }), 100), // <200 -> addressed
        at(finding({ findingId: "new", anchors: ["a.swift:9"], atomRefs: ["req-2"] }), 300), // >200 -> live
      ],
      fileMutationTimeline: new Map([["a.swift", 200]]),
      appliedPatchSetRefs: [],
      latestTreeMutationAt: 200,
    });
    expect(result.findings.map((entry) => entry.findingId)).toEqual(["new"]);
    expect(result.atomRefs).toEqual(["req-2"]);
  });

  test("a multi-anchor finding is addressed if ANY anchor file was touched", () => {
    expect(
      projectUnaddressedReviewFindings({
        findings: [at(finding({ findingId: "f", anchors: ["a.swift:1", "b.swift:2"] }), 100)],
        fileMutationTimeline: new Map([["b.swift", 200]]), // one of two touched -> addressed
        appliedPatchSetRefs: [],
        latestTreeMutationAt: 200,
      }).findings,
    ).toEqual([]);
  });

  test("an ANCHORLESS finding falls back to the coarse whole-tree rule", () => {
    // No anchor to scope to: any mutation after the finding ages it (fallback).
    const addressed = projectUnaddressedReviewFindings({
      findings: [at(finding({ findingId: "f", anchors: [] }), 100)],
      fileMutationTimeline: empty,
      appliedPatchSetRefs: [],
      latestTreeMutationAt: 200,
    });
    expect(addressed.findings).toEqual([]);
    const live = projectUnaddressedReviewFindings({
      findings: [at(finding({ findingId: "f", anchors: [] }), 100)],
      fileMutationTimeline: empty,
      appliedPatchSetRefs: [],
      latestTreeMutationAt: null,
    });
    expect(live.findings.map((entry) => entry.findingId)).toEqual(["f"]);
  });

  test("unattributed live findings (atomRefs: []) are counted — the gap the fitness discrepancies cannot see", () => {
    const result = projectUnaddressedReviewFindings({
      findings: [
        at(
          finding({
            findingId: "f-crit",
            severity: "critical",
            anchors: ["a.swift:1"],
            atomRefs: [],
          }),
          100,
        ),
        at(
          finding({
            findingId: "f-attr",
            severity: "high",
            anchors: ["b.swift:1"],
            atomRefs: ["req-1"],
          }),
          100,
        ),
        at(
          finding({ findingId: "f-low", severity: "low", anchors: ["c.swift:1"], atomRefs: [] }),
          100,
        ),
      ],
      fileMutationTimeline: empty, // nothing touched -> all live
      appliedPatchSetRefs: [],
      latestTreeMutationAt: null,
    });
    expect(result.countBySeverity).toEqual({ critical: 1, high: 1, medium: 0, low: 1 });
    expect(result.atomRefs).toEqual(["req-1"]);
    expect(result.unattributedCount).toBe(2);
  });

  test("no findings -> an empty, silent signal", () => {
    expect(
      projectUnaddressedReviewFindings({
        findings: [],
        fileMutationTimeline: empty,
        appliedPatchSetRefs: [],
        latestTreeMutationAt: null,
      }),
    ).toEqual({
      findings: [],
      countBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      atomRefs: [],
      unattributedCount: 0,
    });
  });
});
