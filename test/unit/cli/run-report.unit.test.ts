import { describe, expect, test } from "bun:test";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  buildRunReportProjection,
  formatRunReportText,
} from "../../../packages/brewva-cli/src/operator/inspect/run-report.js";

const SESSION = "run-report-session";

function record(
  type: string,
  timestamp: number,
  payload: Record<string, unknown>,
): BrewvaEventRecord {
  return {
    id: `evt-${type}-${timestamp}`,
    sessionId: SESSION,
    turnId: "turn-0",
    type,
    timestamp,
    payload,
  } as BrewvaEventRecord;
}

function toolCall(
  toolCallId: string,
  toolName: string,
  proposedAt: number,
  committedAt: number,
  outcome: "ok" | "err" | "inconclusive",
  args: Record<string, unknown> = {},
): BrewvaEventRecord[] {
  const call = { toolCallId, toolName, args };
  return [
    record("tool.proposed", proposedAt, { call }),
    record("tool.committed", committedAt, {
      call,
      result: { outcome: { kind: outcome } },
    }),
  ];
}

describe("buildRunReportProjection", () => {
  test("reconstructs span, tool mix, wait attribution, and fix cycles from the tape", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 1_000, { prompt: "build the app" }),
      ...toolCall("call-1", "write", 2_000, 2_100, "ok"),
      // Model gap between commit (2100) and next proposal (5100): 3s.
      ...toolCall("call-2", "exec", 5_100, 5_200, "err", {
        command: "make build",
      }),
      ...toolCall("call-3", "edit", 6_000, 6_050, "ok"),
      ...toolCall("call-4", "exec", 7_000, 40_000, "ok", {
        command: "make build",
      }),
      record("msg.committed", 41_000, { text: "done" }),
      record("turn.ended", 41_100, { cause: "terminal_commit" }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.durationMs).toBe(40_100);
    expect(report.turns).toBe(1);
    expect(report.assistantMessages).toBe(1);
    expect(report.toolCalls).toBe(4);

    const exec = report.toolStats.find((stat) => stat.toolName === "exec");
    expect(exec).toEqual({
      toolName: "exec",
      calls: 2,
      ok: 1,
      err: 1,
      inconclusive: 0,
    });

    // The failed make build recovered via the later ok make build.
    expect(report.errorFixCycles).toHaveLength(1);
    expect(report.errorFixCycles[0]?.recovered).toBe(true);

    // Both exec calls carried a verification-class command; one went green,
    // and no verification receipt was recorded — that is verification debt.
    expect(report.verification.verificationCommandsObserved).toBe(2);
    expect(report.verification.verificationCommandsGreen).toBe(1);
    expect(report.verification.unreceiptedGreenVerification).toBe(true);

    // Wait attribution: model gaps cover commit->next-proposal spans.
    expect(report.waits.modelGapMs).toBe(3_000 + 800 + 950);
    expect(report.waits.toolExecutionMs).toBe(100 + 100 + 50 + 33_000);
  });

  test("reads approvals, receipts, skills, and cost from port-flattened ops events", () => {
    // The events port flattens runtime-ops customs into kind-typed records;
    // the projection consumes exactly that shape (no local unwrapping).
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("approval.requested", 100, { id: "req-1", toolName: "exec" }),
      record("approval.decided", 400, {
        requestId: "req-1",
        decision: "accept",
      }),
      record("verification.outcome.recorded", 500, {
        outcome: "pass",
        level: "artifact",
        checks: ["make build"],
      }),
      record("skill.selection.recorded", 600, {
        renderedSkillReasons: [{ name: "review", filePath: "skills/core/review/SKILL.md" }],
        demotedSkillNames: ["telegram"],
        forcedCandidates: [{ skillName: "review", reason: "post_green_review" }],
      }),
      record("cost.observed", 700, { totalTokens: 1_234, estimated: true }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.approvals).toEqual({
      requested: 1,
      decided: 1,
      meanLatencyMs: 300,
      maxLatencyMs: 300,
    });
    expect(report.verification.receiptCount).toBe(1);
    expect(report.verification.latestRung).toBe("artifact");
    expect(report.verification.unreceiptedGreenVerification).toBe(false);
    expect(report.skills.renderedSkillNames).toEqual(["review"]);
    expect(report.skills.demotedSkillNames).toEqual(["telegram"]);
    expect(report.skills.forcedCandidates).toBe(1);
    expect(report.cost).toEqual({
      totalTokens: 1_234,
      includesEstimates: true,
    });

    const text = formatRunReportText(report);
    expect(text).toContain("Run Report: schema=brewva.run-report.v1");
    expect(text).toContain("latest=pass@artifact");
    expect(text).toContain("forcedCandidates=1");
  });

  test("does not book cross-turn idle as model gap and skips execution time for unstarted aborts", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      ...toolCall("call-1", "write", 1_000, 1_100, "ok"),
      // 30 minutes of user idle between turns must not count as model gap.
      record("turn.started", 1_801_100, {}),
      ...toolCall("call-2", "write", 1_801_200, 1_801_300, "ok"),
      // Denied approval: proposed + aborted, never started. The 10-minute
      // approval wait must not be double-booked as execution time.
      record("tool.proposed", 1_802_000, {
        call: {
          toolCallId: "call-3",
          toolName: "exec",
          args: { command: "rm -rf /" },
        },
      }),
      record("approval.requested", 1_802_000, { id: "req-deny" }),
      record("approval.decided", 2_402_000, {
        requestId: "req-deny",
        decision: "deny",
      }),
      record("tool.aborted", 2_402_100, {
        call: {
          toolCallId: "call-3",
          toolName: "exec",
          args: { command: "rm -rf /" },
        },
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    // Only the intra-turn gap counts: commit(1_801_300) -> propose(1_802_000).
    expect(report.waits.modelGapMs).toBe(700);
    // Execution time is the two writes only; the unstarted abort adds none.
    expect(report.waits.toolExecutionMs).toBe(100 + 100);
    expect(report.waits.approvalMs).toBe(600_000);
    const exec = report.toolStats.find((stat) => stat.toolName === "exec");
    expect(exec?.err).toBe(1);
  });

  test("splits verification receipts by perspective and counts findings recorded", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "artifact",
        perspective: "authored",
      }),
      record("verification.outcome.recorded", 200, {
        outcome: "pass",
        level: "requirements",
        perspective: "independent",
        independenceBasis: ["fresh_context"],
        reviewerContext: {
          model: "reviewer-model",
          contextId: "run-1",
          lenses: [],
        },
        targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
      }),
      record("review.finding.recorded", 210, {
        findingId: "run-1-finding-1",
        severity: "high",
        category: "correctness",
        statement: "unchecked null deref",
        anchors: [],
        lens: null,
        targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
        atomRefs: [],
      }),
      record("review.finding.recorded", 211, {
        findingId: "run-1-finding-2",
        severity: "medium",
        category: "security",
        statement: "second finding",
        anchors: [],
        lens: null,
        targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
        atomRefs: [],
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.verification.receiptCount).toBe(2);
    expect(report.verification.authoredReceipts).toBe(1);
    expect(report.verification.independentReceipts).toBe(1);
    expect(report.verification.findingsRecorded).toBe(2);

    const text = formatRunReportText(report);
    expect(text).toContain("authored=1");
    expect(text).toContain("independent=1");
    expect(text).toContain("findings=2");
  });

  test("a receipt carrying no perspective field defaults to authored (historical-receipt semantic default)", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "artifact",
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.verification.authoredReceipts).toBe(1);
    expect(report.verification.independentReceipts).toBe(0);
  });

  test("reviewDebt: an authored pass at requirements+ on fresh code with no independent receipt at all", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("tool.committed", 50, {
        call: { toolName: "write", args: { path: "src/a.ts" } },
        result: { outcome: { kind: "ok" } },
      }),
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.verification.reviewDebt).toBe(true);
    expect(formatRunReportText(report)).toContain("reviewDebt=true");
  });

  test("reviewDebt is false once a matching independent receipt lands (patch_sets set-equal)", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      // The fresh-touched file is exactly the patch-applied file, so the
      // patch_sets receipt over ps-1 covers the whole change (Finding P1-C).
      record("tool.committed", 50, {
        call: { toolName: "write", args: { path: "src/a.ts" } },
        result: { outcome: { kind: "ok" } },
      }),
      record("source_patch_applied", 70, {
        ok: true,
        patchSetId: "ps-1",
        appliedPaths: ["src/a.ts"],
      }),
      record("verification.outcome.recorded", 200, {
        outcome: "pass",
        level: "requirements",
        perspective: "independent",
        targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
      }),
      record("verification.outcome.recorded", 300, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.verification.reviewDebt).toBe(false);
    expect(formatRunReportText(report)).toContain("reviewDebt=false");
  });

  test("reviewDebt is false when no fresh code was written this session, even at a bare requirements pass", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.verification.reviewDebt).toBe(false);
  });

  test("reviewDebt is true when a rollback lands after a file_digests independent receipt (a rollback mutates the tree, so the review is stale)", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      // The fresh-touched file IS the reviewed file, so coverage is satisfied
      // and the ONLY thing that can fire debt here is the rollback aging the
      // review (Finding P1-C isolates coverage from the freshness gate).
      record("tool.committed", 50, {
        call: { toolName: "write", args: { path: "src/a.ts" } },
        result: { outcome: { kind: "ok" } },
      }),
      // A patch applied BEFORE the review does not stale it.
      record("source_patch_applied", 70, {
        ok: true,
        patchSetId: "ps-1",
        appliedPaths: ["src/a.ts"],
      }),
      // The independent review — the latest receipt, so it is the judged claim.
      record("verification.outcome.recorded", 200, {
        outcome: "pass",
        level: "requirements",
        perspective: "independent",
        targetRef: { kind: "file_digests", digests: { "src/a.ts": "sha-a" } },
      }),
      // A successful rollback AFTER the review rewrites files: the review's
      // file digests no longer describe the tree, so debt must reappear.
      record("rollback.recorded", 300, { ok: true, patchSetId: "ps-1" }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.verification.reviewDebt).toBe(true);
    expect(formatRunReportText(report)).toContain("reviewDebt=true");
  });

  test("reviewDebt stays false when the rollback after a file_digests receipt failed (a failed rollback never touched the tree)", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("tool.committed", 50, {
        call: { toolName: "write", args: { path: "src/a.ts" } },
        result: { outcome: { kind: "ok" } },
      }),
      record("source_patch_applied", 70, {
        ok: true,
        patchSetId: "ps-1",
        appliedPaths: ["src/a.ts"],
      }),
      record("verification.outcome.recorded", 200, {
        outcome: "pass",
        level: "requirements",
        perspective: "independent",
        targetRef: { kind: "file_digests", digests: { "src/a.ts": "sha-a" } },
      }),
      // ok: false — the rollback never restored anything, so it must not age
      // the review, exactly as a failed apply does not.
      record("rollback.recorded", 300, { ok: false, patchSetId: "ps-1" }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.verification.reviewDebt).toBe(false);
  });
});

// THE fitness read-surface: run-report is a PURE projection over the event
// tape — it reads the committed receipts' `discrepancies`/`unverifiedMustAtoms`
// fields (already annotated by `verification_record` per Task 13) and folds
// requirement atoms via the shared vocabulary fold. It never re-runs
// `projectRequirementFitness` — the per-atom evidence join happened once, at
// claim time, and its result is what the LATEST receipt carries.
function requirementAtom(
  id: string,
  statement: string,
  modality: "must" | "should" | "nice" = "must",
): Record<string, unknown> {
  return { id, statement, modality, provenance: "prompt" };
}

describe("buildRunReportProjection — fitness section", () => {
  test("no requirement atoms recorded: the fitness section is empty/zeroed and the summary line is omitted", () => {
    const events: BrewvaEventRecord[] = [record("turn.started", 0, {})];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.fitness.atomsTotal).toBe(0);
    expect(report.fitness.violatedAtoms).toBe(0);
    expect(report.fitness.unverifiedMustAtoms).toBe(0);
    expect(report.fitness.discrepanciesByGrade).toEqual({
      deterministic_conflict: 0,
      advisory_conflict: 0,
    });
    expect(report.verification.latestDiscrepancies).toEqual([]);
    expect(formatRunReportText(report)).not.toContain("Fitness:");
  });

  test("atoms total folds every distinct recorded requirement atom (amendments do not double-count)", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-1", "first wording"),
      }),
      // Same id, later event -> amendment in place, not a second atom.
      record("task.requirement.recorded", 20, {
        atom: requirementAtom("req-1", "amended wording"),
      }),
      record("task.requirement.recorded", 30, {
        atom: requirementAtom("req-2", "second atom"),
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.fitness.atomsTotal).toBe(2);
  });

  test("re-derives the CURRENT fitness over the whole tape: satisfied (independent pass), violated (live finding), unverifiedMust, by grade", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-1", "must be atomic"),
      }),
      record("task.requirement.recorded", 11, {
        atom: requirementAtom("req-2", "must be fast"),
      }),
      record("task.requirement.recorded", 12, {
        atom: requirementAtom("req-3", "must log"),
      }),
      // req-1 carries a live LLM review finding -> advisory_conflict violation.
      // The file_digests targetRef is fresh tape-only (nothing mutates the tree
      // after it); the digest value itself is never read off disk on this path.
      record("review.finding.recorded", 90, {
        findingId: "finding-1",
        severity: "high",
        category: "correctness",
        statement: "must be atomic",
        anchors: [],
        lens: "correctness",
        targetRef: { kind: "file_digests", digests: { "a.ts": "digest-a" } },
        atomRefs: ["req-1"],
      }),
      // req-2 is cleared by an INDEPENDENT atoms-review pass naming it -> satisfied.
      // This is the positive channel the old receipt-read surface never showed.
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "requirements",
        perspective: "independent",
        atomRefs: ["req-2"],
      }),
      // req-3 has no evidence at all -> unverified (and it is a `must`).
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.fitness.atomsTotal).toBe(3);
    expect(report.fitness.satisfiedAtoms).toBe(1);
    expect(report.fitness.violatedAtoms).toBe(1);
    expect(report.fitness.unverifiedMustAtoms).toBe(1);
    expect(report.fitness.discrepanciesByGrade).toEqual({
      deterministic_conflict: 0,
      advisory_conflict: 1,
    });

    const text = formatRunReportText(report);
    expect(text).toContain("Fitness:");
    expect(text).toContain("atoms=3");
    expect(text).toContain("satisfied=1");
    expect(text).toContain("violated=1");
    expect(text).toContain("unverifiedMust=1");
    expect(text).toContain("advisory_conflict=1");
  });

  test("only the LATEST verification.outcome.recorded receipt's fitness fields count — an earlier receipt's discrepancies do not linger", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-1", "must hold"),
      }),
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
        discrepancies: [
          {
            atomId: "req-1",
            grade: "deterministic_conflict",
            statement: "must hold",
            evidenceRef: "gate-1",
          },
        ],
        unverifiedMustAtoms: [],
      }),
      // A later claim re-ran the fitness join over current tape state and
      // found the atom clean this time — the fresh receipt is the truth.
      record("verification.outcome.recorded", 200, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
        discrepancies: [],
        unverifiedMustAtoms: [],
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.fitness.violatedAtoms).toBe(0);
    expect(report.verification.latestDiscrepancies).toEqual([]);
  });

  test("latent-bug fix: after an independent atoms-review, re-deriving still reports the true unverifiedMust and surfaces satisfied — reading the latest (empty) independent receipt reported both zero", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-clear", "must be atomic"),
      }),
      record("task.requirement.recorded", 11, {
        atom: requirementAtom("req-open", "must be fast"),
      }),
      // The author's own pass@requirements: at claim time both atoms are still
      // unverified, so this frozen annotation names them in unverifiedMustAtoms.
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
        discrepancies: [],
        unverifiedMustAtoms: ["req-clear", "req-open"],
      }),
      // THEN a clear independent atoms-review lands, clearing ONLY req-clear. Its
      // own claim-time annotation is empty by design (a receipt commits only the
      // negative side, computed before its own outcome is on the tape). This is
      // now the LATEST receipt — reading it wholesale reports unverifiedMust=0.
      record("verification.outcome.recorded", 200, {
        outcome: "pass",
        level: "requirements",
        perspective: "independent",
        atomRefs: ["req-clear"],
        discrepancies: [],
        unverifiedMustAtoms: [],
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    // Re-derived: req-clear is satisfied by the independent pass; req-open remains
    // an unverified `must`. Reading the latest (independent, empty) receipt would
    // have falsely reported satisfied=0 AND unverifiedMust=0.
    expect(report.fitness.atomsTotal).toBe(2);
    expect(report.fitness.satisfiedAtoms).toBe(1);
    expect(report.fitness.unverifiedMustAtoms).toBe(1);
    expect(report.fitness.violatedAtoms).toBe(0);

    const text = formatRunReportText(report);
    expect(text).toContain("satisfied=1");
    expect(text).toContain("unverifiedMust=1");
  });

  test("requirement debt: an artifact-level green with fresh code + an unverified must atom surfaces the debt line (ladder_below_requirements)", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-1", "must be keycode-scoped"),
      }),
      // Fresh code written, then a pass recorded only at the `artifact` rung — the
      // ladder never climbed to `requirements`, so req-1 was never graded.
      ...toolCall("w1", "write", 20, 30, "ok", { file: "Sources/FnKeyMonitor.swift" }),
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "artifact",
        perspective: "authored",
      }),
      record("turn.ended", 200, { cause: "terminal_commit" }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.fitness.unverifiedRequirementDebt).toEqual({
      debt: true,
      unverifiedMustCount: 1,
      reason: "ladder_below_requirements",
    });

    const text = formatRunReportText(report);
    expect(text).toContain("Requirement debt:");
    expect(text).toContain("unverifiedMust=1");
    expect(text).toContain("reason=ladder_below_requirements");
  });

  test("requirement debt: no fresh code -> no debt and no debt line, even with an unverified must atom", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-1", "must hold"),
      }),
      // No write/edit commitment -> no fresh code -> the debt is inert.
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "artifact",
        perspective: "authored",
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.fitness.unverifiedRequirementDebt.debt).toBe(false);
    expect(formatRunReportText(report)).not.toContain("Requirement debt:");
  });
});

// R5a baseline requirement lifecycle: the tape-only timeline the routing/atomize
// adoption liveness reads — atoms-vs-first-write ordering, review-dispatched, and
// each atom's re-derived state — with NO dependency on R3's structured evidence.
describe("buildRunReportProjection — requirement lifecycle (R5a)", () => {
  test("atomized-after-the-write (the up4 shape): atomizedBeforeFirstWrite=false and the lifecycle line renders", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      // Generation writes first...
      ...toolCall("w1", "write", 20, 30, "ok", { path: "Sources/FnKeyMonitor.swift" }),
      // ...and only atomizes the spec afterwards (171s-late in the real trace).
      record("task.requirement.recorded", 50, {
        atom: requirementAtom("req-1", "must be keycode-scoped"),
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.requirementLifecycle.firstSourceMutationAt).toBe(30);
    expect(report.requirementLifecycle.firstAtomizedAt).toBe(50);
    expect(report.requirementLifecycle.atomizedBeforeFirstWrite).toBe(false);
    expect(report.requirementLifecycle.reviewDispatched).toBe(false);
    expect(report.requirementLifecycle.atoms).toEqual([
      {
        atomId: "req-1",
        modality: "must",
        provenance: "prompt",
        riskClass: null,
        createdAt: 50,
        state: "unverified",
        evidence: [],
      },
    ]);

    const text = formatRunReportText(report);
    expect(text).toContain("Requirement lifecycle: atomizedBeforeFirstWrite=no");
    expect(text).toContain("reviewDispatched=no");
    expect(text).toContain("req-1(must/prompt/unclassified)");
    expect(text).toContain("state=unverified");
  });

  test("healthy shape: atoms precede the first write and a review is dispatched", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-1", "must be fast"),
      }),
      ...toolCall("w1", "write", 50, 60, "ok", { path: "src/a.ts" }),
      record("review.finding.recorded", 90, {
        findingId: "f-1",
        severity: "low",
        category: "correctness",
        statement: "n/a",
        anchors: [],
        lens: null,
        targetRef: { kind: "patch_sets", patchSetRefs: ["ps-1"] },
        atomRefs: [],
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.requirementLifecycle.firstAtomizedAt).toBe(10);
    expect(report.requirementLifecycle.firstSourceMutationAt).toBe(60);
    expect(report.requirementLifecycle.atomizedBeforeFirstWrite).toBe(true);
    expect(report.requirementLifecycle.reviewDispatched).toBe(true);
    expect(formatRunReportText(report)).toContain("atomizedBeforeFirstWrite=yes");
  });

  test("createdAt is the FIRST recording (amendments do not move it) and riskClass carries through", () => {
    const trapAtom = {
      id: "req-1",
      statement: "must re-enable the tap",
      modality: "must",
      provenance: "trap",
      riskClass: "runtime",
    };
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, { atom: trapAtom }),
      // Amendment (same id) later must not move createdAt.
      record("task.requirement.recorded", 40, { atom: trapAtom }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.requirementLifecycle.atoms).toEqual([
      {
        atomId: "req-1",
        modality: "must",
        provenance: "trap",
        riskClass: "runtime",
        createdAt: 10,
        state: "unverified",
        evidence: [],
      },
    ]);
  });

  test("an independent atoms-review's satisfied state joins into the per-atom lifecycle", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-1", "must be atomic"),
      }),
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "requirements",
        perspective: "independent",
        atomRefs: ["req-1"],
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.requirementLifecycle.atoms[0]?.state).toBe("satisfied");
    expect(report.requirementLifecycle.reviewDispatched).toBe(true);
  });

  test("no requirement atoms: lifecycle is empty, the predicate is null, and no lifecycle line renders", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      ...toolCall("w1", "write", 20, 30, "ok", { path: "src/a.ts" }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.requirementLifecycle.atoms).toEqual([]);
    expect(report.requirementLifecycle.atomizedBeforeFirstWrite).toBe(null);
    expect(report.requirementLifecycle.firstAtomizedAt).toBe(null);
    expect(report.requirementLifecycle.firstSourceMutationAt).toBe(30);
    expect(formatRunReportText(report)).not.toContain("Requirement lifecycle:");
  });

  test("equal timestamps: atomization at the same instant as the first write reads as adopted (<= boundary)", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 100, {
        atom: requirementAtom("req-1", "must hold"),
      }),
      ...toolCall("w1", "write", 90, 100, "ok", { path: "src/a.ts" }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.requirementLifecycle.firstAtomizedAt).toBe(100);
    expect(report.requirementLifecycle.firstSourceMutationAt).toBe(100);
    expect(report.requirementLifecycle.atomizedBeforeFirstWrite).toBe(true);
  });

  test("atoms present but no write yet: the predicate is null (undefined, not false)", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 100, {
        atom: requirementAtom("req-1", "must hold"),
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.requirementLifecycle.firstAtomizedAt).toBe(100);
    expect(report.requirementLifecycle.firstSourceMutationAt).toBe(null);
    expect(report.requirementLifecycle.atomizedBeforeFirstWrite).toBe(null);
  });
});

// R5b: the evidence-anchored layer — per-atom graded evidence items (claimed-by
// anchors / closed-by kind+source+verdict), read from receipts once R3's
// structured evidence flows.
describe("buildRunReportProjection — requirement lifecycle evidence (R5b)", () => {
  test("a receipt's graded evidenceItems surface per-atom with anchors + a closedBy render", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-1", "must be keycode-scoped"),
      }),
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
        evidenceItems: [
          {
            id: "static-guard:event_tap_keycode_scoped:req-1",
            atomRefs: ["req-1"],
            evidenceKind: "static_guard",
            verdict: "pass",
            anchors: ["FnKeyMonitor.swift: keyCode gate"],
            statement: "keycode-scoped",
          },
        ],
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.requirementLifecycle.atoms[0]?.evidence).toEqual([
      {
        verdict: "pass",
        anchors: ["FnKeyMonitor.swift: keyCode gate"],
      },
    ]);
    expect(formatRunReportText(report)).toContain(
      "closedBy=[pass@FnKeyMonitor.swift: keyCode gate]",
    );
  });

  test("an atom with no evidence items has empty evidence and no closedBy suffix", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-1", "must hold"),
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);
    expect(report.requirementLifecycle.atoms[0]?.evidence).toEqual([]);
    expect(formatRunReportText(report)).not.toContain("closedBy=");
  });
});
