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
