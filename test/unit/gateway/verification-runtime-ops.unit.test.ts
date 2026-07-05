import { describe, expect, test } from "bun:test";
import {
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import { createRuntimeFixture } from "./hosted-behavior/fixtures/runtime.js";

describe("verification runtime ops seam", () => {
  test("checks.verify commits verification.outcome.recorded and evaluate projects it (producer seam)", () => {
    // The builder was a stub returning {ok:true} without emitting, which kept
    // every outcome consumer (stall adjudication summary, hygiene finding,
    // harness projection, observability snapshot) silently blind.
    const runtime = createRuntimeFixture();
    const sessionId = "verification-ops-1";

    expect(runtime.ops.verification.checks.evaluate(sessionId)).toMatchObject({
      ok: true,
      reason: "no_verification_recorded",
    });

    const failed = runtime.ops.verification.checks.verify(sessionId, {
      outcome: "fail",
      level: "commands",
      failedChecks: ["bun test"],
      reason: "suite_red",
    });
    expect(failed).toMatchObject({ ok: false, reason: "verification_failed" });
    expect(runtime.ops.verification.checks.evaluate(sessionId)).toMatchObject({ ok: false });

    const passed = runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "commands",
    });
    expect(passed).toMatchObject({ ok: true });

    // Consumer contract: the same typed reader the stall adjudicator and
    // inspect report parse the receipt with.
    const outcomes = runtime.ops.events.records
      .query(sessionId, { type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE })
      .map((event) =>
        readVerificationOutcomeRecordedEventPayload(event as { payload?: Record<string, unknown> }),
      );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]).toMatchObject({
      outcome: "fail",
      level: "commands",
      failedChecks: ["bun test"],
      reason: "suite_red",
    });
    expect(outcomes[1]).toMatchObject({ outcome: "pass", failedChecks: [] });
  });

  test("checks.verify defensively maps perspective/independenceBasis/reviewerContext/targetRef, defaulting to authored", () => {
    // Non-tool callers (this ops-builder write side) must not be able to
    // silently produce a malformed receipt: missing or invalid evidence
    // fields must coerce to the authored defaults, and well-formed fields
    // must carry through, exactly as `readVerificationOutcomeRecordedEventPayload`
    // would coerce them on read.
    const runtime = createRuntimeFixture();
    const sessionId = "verification-ops-perspective-1";

    // Call 1: caller supplies nothing for the four fields -> authored defaults.
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "commands",
    });

    // Call 2: caller supplies a fully-formed independent receipt.
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "commands",
      perspective: "independent",
      independenceBasis: ["fresh_context", "different_model"],
      reviewerContext: { model: "reviewer-model", contextId: "ctx-9", lenses: ["security"] },
      targetRef: { kind: "patch_sets", patchSetRefs: ["patch-1", "patch-2"] },
    });

    // Call 3: caller supplies garbage for every field -> must not throw and
    // must coerce to authored defaults (fail-closed, not silently malformed).
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "commands",
      perspective: "not-a-real-perspective",
      independenceBasis: "not-an-array",
      reviewerContext: "not-an-object",
      targetRef: { kind: "unknown_kind" },
    });

    const outcomes = runtime.ops.events.records
      .query(sessionId, { type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE })
      .map((event) =>
        readVerificationOutcomeRecordedEventPayload(event as { payload?: Record<string, unknown> }),
      );
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toMatchObject({
      perspective: "authored",
      independenceBasis: [],
      reviewerContext: null,
      targetRef: null,
    });
    expect(outcomes[1]).toMatchObject({
      perspective: "independent",
      independenceBasis: ["fresh_context", "different_model"],
      reviewerContext: { model: "reviewer-model", contextId: "ctx-9", lenses: ["security"] },
      targetRef: { kind: "patch_sets", patchSetRefs: ["patch-1", "patch-2"] },
    });
    expect(outcomes[2]).toMatchObject({
      perspective: "authored",
      independenceBasis: [],
      reviewerContext: null,
      targetRef: null,
    });
  });

  test("checks.verify defensively maps discrepancies/unverifiedMustAtoms, defaulting to [] and dropping malformed entries", () => {
    // The fitness annotation must round-trip through the write seam exactly like
    // the perspective/targetRef fields: a non-tool caller that omits or malforms
    // them lands on the same [] defaults a consumer derives on read, and a
    // malformed discrepancy entry is dropped, never persisted as garbage.
    const runtime = createRuntimeFixture();
    const sessionId = "verification-ops-fitness-1";

    // Call 1: caller supplies nothing -> both default to [].
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
    });

    // Call 2: caller supplies well-formed fitness annotation.
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      discrepancies: [
        {
          atomId: "req-1",
          grade: "deterministic_conflict",
          statement: "keycode-scoped suppression",
          evidenceRef: "gate-1",
        },
      ],
      unverifiedMustAtoms: ["req-2"],
    });

    // Call 3: caller supplies garbage -> must not throw; malformed dropped, [].
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      discrepancies: [{ atomId: "req-3", grade: "not-a-grade" }, "junk", 42],
      unverifiedMustAtoms: "not-an-array",
    });

    const outcomes = runtime.ops.events.records
      .query(sessionId, { type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE })
      .map((event) =>
        readVerificationOutcomeRecordedEventPayload(event as { payload?: Record<string, unknown> }),
      );
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toMatchObject({ discrepancies: [], unverifiedMustAtoms: [] });
    expect(outcomes[1]).toMatchObject({
      discrepancies: [
        {
          atomId: "req-1",
          grade: "deterministic_conflict",
          statement: "keycode-scoped suppression",
          evidenceRef: "gate-1",
        },
      ],
      unverifiedMustAtoms: ["req-2"],
    });
    expect(outcomes[2]).toMatchObject({ discrepancies: [], unverifiedMustAtoms: [] });
  });

  test("a successfully applied source patch marks the write for verification hygiene", () => {
    const runtime = createRuntimeFixture();
    const sessionId = "verification-write-marked-1";

    runtime.ops.tools.sourcePatch.plans.apply(sessionId, {
      ok: true,
      planId: "plan-1",
      patchSetId: "patch-1",
      appliedPaths: ["src/a.ts", "src/b.ts"],
      failedPaths: [],
    });
    runtime.ops.tools.sourcePatch.plans.apply(sessionId, {
      ok: false,
      planId: "plan-2",
      appliedPaths: [],
      failedPaths: ["src/c.ts"],
      reason: "preflight_changed",
    });

    const marked = runtime.ops.events.records.query(sessionId, {
      type: VERIFICATION_WRITE_MARKED_EVENT_TYPE,
    });
    expect(marked).toHaveLength(1);
    expect(marked[0]?.payload).toMatchObject({
      planId: "plan-1",
      patchSetId: "patch-1",
      paths: ["src/a.ts", "src/b.ts"],
    });
  });
});
