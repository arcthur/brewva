import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInspectReport } from "../../../packages/brewva-cli/src/operator/inspect.js";
import { createRuntimeInstanceFixture } from "../../helpers/runtime.js";

// Task 6 (W1 read surfaces): `InspectVerification` gains the perspective and
// independence basis of the latest `verification.outcome.recorded` receipt,
// so `brewva inspect` shows whether the last recorded verification was
// authored or independent without requiring a run-report.
describe("inspect report — verification perspective", () => {
  test("a bare verification_record call reads back as authored with no independence basis", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-verification-perspective-")),
    });
    const sessionId = "inspect-verification-perspective-authored-1";

    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "artifact",
      checks: ["make build"],
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.verification.outcome).toBe("pass");
    expect(report.verification.perspective).toBe("authored");
    expect(report.verification.independenceBasis).toEqual([]);
  });

  test("an independent receipt reads back with its perspective and independence basis", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-verification-perspective-independent-")),
    });
    const sessionId = "inspect-verification-perspective-independent-1";

    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      independenceBasis: ["fresh_context", "preloaded_lens"],
      reviewerContext: { model: "reviewer-model", contextId: "run-1", lenses: ["security"] },
      targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.verification.perspective).toBe("independent");
    expect(report.verification.independenceBasis).toEqual(["fresh_context", "preloaded_lens"]);
  });

  test("only the LATEST receipt's perspective/basis surface, not an earlier one", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-verification-perspective-latest-")),
    });
    const sessionId = "inspect-verification-perspective-latest-1";

    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      independenceBasis: ["fresh_context"],
    });
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "artifact",
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.verification.perspective).toBe("authored");
    expect(report.verification.independenceBasis).toEqual([]);
  });

  test("no verification receipt at all reads as authored with an empty basis (never null/undefined)", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-verification-perspective-empty-")),
    });
    const sessionId = "inspect-verification-perspective-empty-1";

    const report = buildInspectReport(runtime, sessionId);

    expect(report.verification.outcome).toBeNull();
    expect(report.verification.perspective).toBe("authored");
    expect(report.verification.independenceBasis).toEqual([]);
  });
});

// Task 15 (W4): `InspectVerification` gains the latest receipt's fitness
// annotation (`discrepancies`/`unverifiedMustAtoms`, Task 13's claim-time
// write) — read straight off the same `latest` payload perspective/basis
// already come from, never re-derived. This is the raw receipt field the
// shared `readReceiptFitnessSummary` helper (Work Card, run-report) tallies.
describe("inspect report — verification fitness annotation", () => {
  test("a receipt with discrepancies and unverifiedMustAtoms surfaces both verbatim", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-verification-fitness-")),
    });
    const sessionId = "inspect-verification-fitness-1";

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
      ],
      unverifiedMustAtoms: ["req-2"],
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.verification.discrepancies).toHaveLength(1);
    expect(report.verification.discrepancies[0]).toEqual({
      atomId: "req-1",
      grade: "deterministic_conflict",
      statement: "must be atomic",
      evidenceRef: "gate-1",
    });
    expect(report.verification.unverifiedMustAtoms).toEqual(["req-2"]);
  });

  test("no receipt at all surfaces empty discrepancies and unverifiedMustAtoms, never null/undefined", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-verification-fitness-empty-")),
    });
    const sessionId = "inspect-verification-fitness-empty-1";

    const report = buildInspectReport(runtime, sessionId);

    expect(report.verification.discrepancies).toEqual([]);
    expect(report.verification.unverifiedMustAtoms).toEqual([]);
  });

  test("a receipt below the fitness annotation gate (e.g. artifact rung) carries no annotation", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-verification-fitness-ungated-")),
    });
    const sessionId = "inspect-verification-fitness-ungated-1";

    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "artifact",
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.verification.discrepancies).toEqual([]);
    expect(report.verification.unverifiedMustAtoms).toEqual([]);
  });
});

describe("inspect report — tape-only review debt (shared with Work Card and run-report)", () => {
  test("debt: an authored requirements+ pass on fresh code with no independent receipt at all", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-review-debt-none-")),
    });
    const sessionId = "inspect-review-debt-none-1";

    runtime.ops.tools.invocation.start({ sessionId, toolName: "write", callId: "call-1" });
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.reviewDebt.debt).toBe(true);
    expect(report.reviewDebt.reason).toBe("no_independent_receipt");
  });

  test("no debt once a matching independent receipt lands (patch_sets set-equal, tape-only)", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-review-debt-cleared-")),
    });
    const sessionId = "inspect-review-debt-cleared-1";

    // The only fresh-touched file is the one the patch applied, so the
    // patch_sets receipt over ps-1 covers the whole change (Finding P1-C).
    runtime.ops.tools.invocation.start({
      sessionId,
      toolName: "write",
      callId: "call-1",
      args: { path: "src/a.ts" },
    });
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

    expect(report.reviewDebt.debt).toBe(false);
    expect(report.reviewDebt.reason).toBeNull();
  });

  test("no debt when no fresh code was written this session", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-review-debt-no-fresh-code-")),
    });
    const sessionId = "inspect-review-debt-no-fresh-code-1";

    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.reviewDebt.debt).toBe(false);
  });

  // Finding P1-C (tape path): a subset review must not clear whole-session
  // fresh-code debt. The session wrote a.ts AND b.ts; a file_digests receipt
  // attesting only a.ts (tree-fresh) does NOT cover the change -> debt persists.
  test("P1-C: a file_digests receipt covering only a.ts leaves debt when b.ts was also touched", () => {
    const runtime = createRuntimeInstanceFixture({
      cwd: mkdtempSync(join(tmpdir(), "brewva-cli-inspect-review-debt-partial-")),
    });
    const sessionId = "inspect-review-debt-partial-1";

    runtime.ops.tools.invocation.start({
      sessionId,
      toolName: "edit",
      callId: "call-a",
      args: { file_path: "a.ts" },
    });
    runtime.ops.tools.invocation.start({
      sessionId,
      toolName: "edit",
      callId: "call-b",
      args: { file_path: "b.ts" },
    });
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
      perspective: "independent",
      // Only a.ts reviewed; no patch landed so a file_digests ref is tree-fresh.
      targetRef: { kind: "file_digests", digests: { "a.ts": "sha-a" } },
    });
    void runtime.ops.verification.checks.verify(sessionId, {
      outcome: "pass",
      level: "requirements",
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.reviewDebt.debt).toBe(true);
    expect(report.reviewDebt.reason).toBe("independent_receipts_stale");
  });
});
