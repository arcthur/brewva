import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildInspectReport,
  buildTaskWorkCardProjection,
  formatTaskWorkCardText,
} from "../../../packages/brewva-cli/src/operator/inspect.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";
import { committedToolEvent, seedCommittedToolEvents } from "../../helpers/tool-events.js";

// Task 6 (W1 read surfaces): Work Card evidence gains verificationPerspective,
// independenceBasis, and reviewDebt — all read straight off `InspectReport`
// (report.ts already computes the tape-only judgment shared with run-report),
// never re-derived here and never touching the filesystem.
describe("Work Card evidence — verification perspective and review debt", () => {
  test("a bare verification_record call surfaces as authored with no independence basis, no debt below requirements", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-work-card-perspective-authored-")),
    });
    const sessionId = "work-card-perspective-authored-1";

    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "artifact",
      checks: ["make build"],
    });

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);

    expect(workCard.evidence.verificationOutcome).toBe("pass");
    expect(workCard.evidence.verificationPerspective).toBe("authored");
    expect(workCard.evidence.independenceBasis).toEqual([]);
    expect(workCard.evidence.reviewDebt).toBe(false);

    const text = formatTaskWorkCardText(workCard);
    expect(text).toContain("perspective=authored");
    expect(text).toContain("reviewDebt=false");
  });

  test("an independent receipt surfaces its perspective and independence basis", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-work-card-perspective-independent-")),
    });
    const sessionId = "work-card-perspective-independent-1";

    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      independenceBasis: ["fresh_context", "preloaded_lens"],
      reviewerContext: { model: "reviewer-model", contextId: "run-1", lenses: ["security"] },
      targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
    });

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);

    expect(workCard.evidence.verificationPerspective).toBe("independent");
    expect(workCard.evidence.independenceBasis).toEqual(["fresh_context", "preloaded_lens"]);

    const text = formatTaskWorkCardText(workCard);
    expect(text).toContain("perspective=independent");
    expect(text).toContain("basis=fresh_context,preloaded_lens");
  });

  test("reviewDebt is true for an authored requirements+ pass on fresh code with no independent receipt", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-work-card-review-debt-true-")),
    });
    const sessionId = "work-card-review-debt-true-1";

    seedCommittedToolEvents(runtime, [
      committedToolEvent({ sessionId, toolName: "write", timestamp: 1 }),
    ]);
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
    });

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);

    expect(workCard.evidence.reviewDebt).toBe(true);
    expect(formatTaskWorkCardText(workCard)).toContain("reviewDebt=true");
  });

  test("reviewDebt is false once a matching independent receipt lands (tape-only patch_sets match)", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-work-card-review-debt-cleared-")),
    });
    const sessionId = "work-card-review-debt-cleared-1";

    // The only fresh-touched file is the one the patch applied, so the
    // patch_sets receipt over ps-1 covers the whole change (Finding P1-C).
    seedCommittedToolEvents(runtime, [
      committedToolEvent({
        sessionId,
        toolName: "write",
        args: { path: "src/a.ts" },
        timestamp: 1,
      }),
    ]);
    runtime.ops.tools.sourcePatch.plans.apply(sessionId, {
      ok: true,
      planId: "plan-1",
      patchSetId: "ps-1",
      appliedPaths: ["src/a.ts"],
      failedPaths: [],
    });
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
    });
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
    });

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);

    expect(workCard.evidence.reviewDebt).toBe(false);
  });

  test("no verification receipt at all surfaces as authored, empty basis, no debt", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-work-card-perspective-empty-")),
    });
    const sessionId = "work-card-perspective-empty-1";

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);

    expect(workCard.evidence.verificationOutcome).toBeNull();
    expect(workCard.evidence.verificationPerspective).toBe("authored");
    expect(workCard.evidence.independenceBasis).toEqual([]);
    expect(workCard.evidence.reviewDebt).toBe(false);
  });
});

// Task 15 (W4): the Work Card fitness line — SAME counts as run-report's
// Fitness section (violated, unverifiedMust, discrepancies-by-grade), from
// the SAME latest `verification.outcome.recorded` receipt's committed
// `discrepancies`/`unverifiedMustAtoms` fields, via the SHARED
// `readReceiptFitnessSummary` helper both surfaces call. Per the W3 wave
// review's binding ruling, this is deliberately PARTIAL — no
// satisfied/likelySatisfied/notApplicable counts, which are re-derivable
// projection output that does not belong on a receipt. Nothing here re-runs
// `projectRequirementFitness` and nothing here gates (axiom 18): this is a
// read-only pressure surface.
describe("Work Card evidence — fitness line", () => {
  test("a seeded latest receipt with discrepancies and unverifiedMustAtoms renders violated/unverifiedMust/by-grade", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-work-card-fitness-seeded-")),
    });
    const sessionId = "work-card-fitness-seeded-1";

    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      discrepancies: [
        {
          atomId: "req-1",
          grade: "deterministic_conflict",
          statement: "must be atomic",
          evidenceRef: "gate-1",
        },
        {
          atomId: "req-2",
          grade: "advisory_conflict",
          statement: "must be fast",
          evidenceRef: "finding-1",
        },
      ],
      unverifiedMustAtoms: ["req-3"],
    });

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);

    expect(workCard.evidence.fitness).toEqual({
      violated: 2,
      unverifiedMust: 1,
      discrepanciesByGrade: { deterministic_conflict: 1, advisory_conflict: 1 },
    });

    const text = formatTaskWorkCardText(workCard);
    expect(text).toContain("fitness:");
    expect(text).toContain("violated=2");
    expect(text).toContain("unverifiedMust=1");
    expect(text).toContain("deterministic_conflict=1");
    expect(text).toContain("advisory_conflict=1");
  });

  test("a session with no fitness annotation renders the line honestly empty (all zero), not omitted or fabricated", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-work-card-fitness-empty-")),
    });
    const sessionId = "work-card-fitness-empty-1";

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);

    expect(workCard.evidence.fitness).toEqual({
      violated: 0,
      unverifiedMust: 0,
      discrepanciesByGrade: { deterministic_conflict: 0, advisory_conflict: 0 },
    });

    const text = formatTaskWorkCardText(workCard);
    expect(text).toContain("violated=0");
    expect(text).toContain("unverifiedMust=0");
  });

  test("a receipt below the fitness annotation gate (artifact rung) renders the same honest zero line", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-work-card-fitness-ungated-")),
    });
    const sessionId = "work-card-fitness-ungated-1";

    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "artifact",
    });

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);

    expect(workCard.evidence.fitness.violated).toBe(0);
    expect(workCard.evidence.fitness.unverifiedMust).toBe(0);
  });
});
