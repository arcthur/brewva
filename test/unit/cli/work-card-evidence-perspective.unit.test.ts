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

// The Work Card fitness line — SAME counts as run-report's Fitness section,
// now RE-DERIVED over the whole tape (`report.requirementFitness` =
// `summarizeRequirementFitness(buildTapeRequirementFitness)`), not read off the
// latest receipt (superseding the earlier W3 "read the frozen receipt" ruling,
// per the satisfied-timing fix). Re-deriving is what surfaces `satisfied` — a
// clear independent atoms-review's affirmative half, which lands AFTER the
// authored verify — and it fixes the bug where the latest receipt after ANY
// review is the independent one whose claim-time annotation is empty by design.
// The receipt still commits only the negative side; this view rebuilds from
// receipts (axiom 6) and stores nothing new. Nothing here gates (axiom 18).
describe("Work Card evidence — fitness line", () => {
  test("re-derives the whole-tape fitness: the line renders satisfied (independent pass), violated (live finding) by grade, and unverifiedMust", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-work-card-fitness-seeded-")),
    });
    const sessionId = "work-card-fitness-seeded-1";

    // Three `must` atoms: one violated by a live finding, one cleared by an
    // independent atoms-review, one left with no evidence. The line re-derives
    // all three from the tape — it no longer reads a single receipt's annotation.
    runtime.ops.task.requirements.record(sessionId, [
      { id: "req-1", statement: "must be atomic", modality: "must", provenance: "prompt" },
      { id: "req-2", statement: "must be fast", modality: "must", provenance: "prompt" },
      { id: "req-3", statement: "must log", modality: "must", provenance: "prompt" },
    ]);
    // req-1: a live LLM review finding -> advisory_conflict violation (tape-only
    // fresh: nothing mutates the tree after it, so the digest is never read).
    runtime.ops.verification.findings.record(sessionId, {
      findingId: "finding-1",
      severity: "high",
      category: "correctness",
      statement: "must be atomic",
      anchors: [],
      lens: "correctness",
      targetRef: { kind: "file_digests", digests: { "a.ts": "digest-a" } },
      atomRefs: ["req-1"],
    });
    // req-2: an independent atoms-review pass naming it -> satisfied. The receipt
    // carries a tape-fresh targetRef (nothing mutates the tree after it) so it
    // survives the assembler's mirror rule (STALENESS NEVER SATISFIES) — a
    // targetRef-less pass cannot demonstrate freshness and would be dropped.
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      targetRef: { kind: "file_digests", digests: { "b.ts": "digest-b" } },
      atomRefs: ["req-2"],
    });

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);

    expect(workCard.evidence.fitness).toEqual({
      satisfied: 1,
      violated: 1,
      unverifiedMust: 1,
      discrepanciesByGrade: { deterministic_conflict: 0, advisory_conflict: 1 },
    });

    const text = formatTaskWorkCardText(workCard);
    expect(text).toContain("fitness:");
    expect(text).toContain("satisfied=1");
    expect(text).toContain("violated=1");
    expect(text).toContain("unverifiedMust=1");
    expect(text).toContain("advisory_conflict=1");
  });

  test("a session with no requirement atoms renders the line honestly empty (all zero), not omitted or fabricated", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-work-card-fitness-empty-")),
    });
    const sessionId = "work-card-fitness-empty-1";

    const report = buildInspectReport(runtime, sessionId);
    const workCard = buildTaskWorkCardProjection(report);

    expect(workCard.evidence.fitness).toEqual({
      satisfied: 0,
      violated: 0,
      unverifiedMust: 0,
      discrepanciesByGrade: { deterministic_conflict: 0, advisory_conflict: 0 },
    });

    const text = formatTaskWorkCardText(workCard);
    expect(text).toContain("satisfied=0");
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
