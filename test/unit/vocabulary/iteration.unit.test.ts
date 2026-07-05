import { describe, expect, test } from "bun:test";
import { readVerificationOutcomeRecordedEventPayload } from "@brewva/brewva-vocabulary/iteration";

describe("readVerificationOutcomeRecordedEventPayload — perspective/independence/reviewerContext/targetRef", () => {
  test("reads a fully-populated independent receipt with reviewer context and a patch_sets target ref", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: {
        outcome: "pass",
        perspective: "independent",
        independenceBasis: ["fresh_context", "different_model"],
        reviewerContext: {
          model: "claude-opus",
          contextId: "ctx-1",
          lenses: ["security", "performance"],
        },
        targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1", "ps-2"] },
      },
    });

    expect(result.perspective).toBe("independent");
    expect(result.independenceBasis).toEqual(["fresh_context", "different_model"]);
    expect(result.reviewerContext).toEqual({
      model: "claude-opus",
      contextId: "ctx-1",
      lenses: ["security", "performance"],
    });
    expect(result.targetRef).toEqual({ kind: "patch_sets", patchSetRefs: ["ps-1", "ps-2"] });
  });

  test("reads a file_digests target ref", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: {
        targetRef: {
          kind: "file_digests",
          digests: { "src/a.ts": "sha-a", "src/b.ts": "sha-b" },
        },
      },
    });

    expect(result.targetRef).toEqual({
      kind: "file_digests",
      digests: { "src/a.ts": "sha-a", "src/b.ts": "sha-b" },
    });
  });

  test("defaults perspective to authored when the field is missing (every historical receipt was author-produced)", () => {
    const result = readVerificationOutcomeRecordedEventPayload({ payload: { outcome: "pass" } });
    expect(result.perspective).toBe("authored");
  });

  test("coerces any non-'independent' perspective value to authored", () => {
    for (const malformed of ["author", "authored ", "INDEPENDENT", 1, null, {}, ["independent"]]) {
      const result = readVerificationOutcomeRecordedEventPayload({
        payload: { perspective: malformed as never },
      });
      expect(result.perspective).toBe("authored");
    }
  });

  test("defaults independenceBasis to an empty array when missing or non-array", () => {
    for (const malformed of [undefined, null, "fresh_context", 42, {}]) {
      const result = readVerificationOutcomeRecordedEventPayload({
        payload: { independenceBasis: malformed as never },
      });
      expect(result.independenceBasis).toEqual([]);
    }
  });

  test("filters unknown independenceBasis entries, keeping only recognized bases", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: { independenceBasis: ["fresh_context", "bogus_basis", "human", 42, null] },
    });
    expect(result.independenceBasis).toEqual(["fresh_context", "human"]);
  });

  test("defaults reviewerContext to null when missing or malformed", () => {
    for (const malformed of [undefined, null, "not-an-object", 42, []]) {
      const result = readVerificationOutcomeRecordedEventPayload({
        payload: { reviewerContext: malformed as never },
      });
      expect(result.reviewerContext).toBeNull();
    }
  });

  test("defensively parses a partially-malformed reviewerContext to safe defaults", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: {
        reviewerContext: { model: 42, contextId: undefined, lenses: "not-an-array" },
      },
    });
    expect(result.reviewerContext).toEqual({ model: null, contextId: null, lenses: [] });
  });

  test("filters non-string entries out of reviewerContext.lenses", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: {
        reviewerContext: { model: null, contextId: null, lenses: ["security", 1, null, "perf"] },
      },
    });
    expect(result.reviewerContext).toEqual({
      model: null,
      contextId: null,
      lenses: ["security", "perf"],
    });
  });

  test("defaults targetRef to null when missing, malformed, or an unknown kind", () => {
    for (const malformed of [
      undefined,
      null,
      "not-an-object",
      {},
      { kind: "diff_digest", ref: "x" },
      { kind: "patch_sets" },
      { kind: "patch_sets", patchSetRefs: "not-an-array" },
      { kind: "file_digests" },
      { kind: "file_digests", digests: "not-an-object" },
      { kind: "file_digests", digests: { a: 1 } },
    ]) {
      const result = readVerificationOutcomeRecordedEventPayload({
        payload: { targetRef: malformed as never },
      });
      expect(result.targetRef).toBeNull();
    }
  });

  test("filters non-string entries out of a patch_sets targetRef.patchSetRefs", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: { targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1", 2, null, "ps-2"] } },
    });
    expect(result.targetRef).toEqual({ kind: "patch_sets", patchSetRefs: ["ps-1", "ps-2"] });
  });

  test("existing outcome/checks/missingChecks fields still read correctly alongside the new fields", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: { outcome: "fail", checks: ["a", "b"], missingChecks: ["c"] },
    });
    expect(result.outcome).toBe("fail");
    expect(result.checks).toEqual(["a", "b"]);
    expect(result.missingChecks).toEqual(["c"]);
    expect(result.perspective).toBe("authored");
    expect(result.independenceBasis).toEqual([]);
    expect(result.reviewerContext).toBeNull();
    expect(result.targetRef).toBeNull();
  });
});

describe("readVerificationOutcomeRecordedEventPayload — fitness annotation (discrepancies/unverifiedMustAtoms)", () => {
  test("reads well-formed discrepancies and unverifiedMustAtoms through", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: {
        outcome: "pass",
        discrepancies: [
          {
            atomId: "req-1",
            grade: "deterministic_conflict",
            statement: "Fn suppression must be keycode-scoped",
            evidenceRef: "gate-1",
          },
          {
            atomId: "req-2",
            grade: "advisory_conflict",
            statement: "another atom",
            evidenceRef: "finding-2",
          },
        ],
        unverifiedMustAtoms: ["req-3", "req-4"],
      },
    });
    expect(result.discrepancies).toEqual([
      {
        atomId: "req-1",
        grade: "deterministic_conflict",
        statement: "Fn suppression must be keycode-scoped",
        evidenceRef: "gate-1",
      },
      {
        atomId: "req-2",
        grade: "advisory_conflict",
        statement: "another atom",
        evidenceRef: "finding-2",
      },
    ]);
    expect(result.unverifiedMustAtoms).toEqual(["req-3", "req-4"]);
  });

  test("defaults both to [] when the fields are missing (every historical receipt predates fitness annotation)", () => {
    const result = readVerificationOutcomeRecordedEventPayload({ payload: { outcome: "pass" } });
    expect(result.discrepancies).toEqual([]);
    expect(result.unverifiedMustAtoms).toEqual([]);
  });

  test("defaults both to [] when the fields are the wrong type", () => {
    for (const malformed of ["not-an-array", 42, null, {}] as const) {
      const result = readVerificationOutcomeRecordedEventPayload({
        payload: {
          discrepancies: malformed as never,
          unverifiedMustAtoms: malformed as never,
        },
      });
      expect(result.discrepancies).toEqual([]);
      expect(result.unverifiedMustAtoms).toEqual([]);
    }
  });

  test("drops a malformed discrepancy entry (bad grade, missing fields, non-object) without crashing, keeps the good ones", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: {
        discrepancies: [
          { atomId: "req-1", grade: "deterministic_conflict", statement: "ok", evidenceRef: "e-1" },
          {
            atomId: "req-2",
            grade: "not-a-real-grade",
            statement: "bad grade",
            evidenceRef: "e-2",
          },
          { atomId: "req-3", grade: "advisory_conflict", statement: "missing evidenceRef" },
          "not-an-object",
          null,
          42,
          { atomId: 5, grade: "advisory_conflict", statement: "bad atomId", evidenceRef: "e-5" },
        ] as never,
      },
    });
    expect(result.discrepancies).toEqual([
      { atomId: "req-1", grade: "deterministic_conflict", statement: "ok", evidenceRef: "e-1" },
    ]);
  });

  test("filters non-string entries out of unverifiedMustAtoms", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: { unverifiedMustAtoms: ["req-1", 2, null, "req-2", {}] as never },
    });
    expect(result.unverifiedMustAtoms).toEqual(["req-1", "req-2"]);
  });
});

describe("readVerificationOutcomeRecordedEventPayload — atomRefs (the 'affirmatively verified' receipt fact)", () => {
  test("reads a well-formed atomRefs list through", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: { outcome: "pass", atomRefs: ["req-1", "req-2"] },
    });
    expect(result.atomRefs).toEqual(["req-1", "req-2"]);
  });

  test("defaults atomRefs to [] when the field is missing (a pre-existing receipt reads back [])", () => {
    const result = readVerificationOutcomeRecordedEventPayload({ payload: { outcome: "pass" } });
    expect(result.atomRefs).toEqual([]);
  });

  test("defaults atomRefs to [] when the field is the wrong type", () => {
    for (const malformed of ["not-an-array", 42, null, {}] as const) {
      const result = readVerificationOutcomeRecordedEventPayload({
        payload: { atomRefs: malformed as never },
      });
      expect(result.atomRefs).toEqual([]);
    }
  });

  test("filters non-string entries out of atomRefs (mirrors the review-finding coercion)", () => {
    const result = readVerificationOutcomeRecordedEventPayload({
      payload: { atomRefs: ["req-1", 2, null, "req-2", {}] as never },
    });
    expect(result.atomRefs).toEqual(["req-1", "req-2"]);
  });
});
