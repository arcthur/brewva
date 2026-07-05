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

  test("surfaces the LATEST receipt's discrepancies and unverifiedMustAtoms counts, by grade", () => {
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
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "requirements",
        perspective: "authored",
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
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.fitness.atomsTotal).toBe(3);
    expect(report.fitness.violatedAtoms).toBe(2);
    expect(report.fitness.unverifiedMustAtoms).toBe(1);
    expect(report.fitness.discrepanciesByGrade).toEqual({
      deterministic_conflict: 1,
      advisory_conflict: 1,
    });
    expect(report.verification.latestDiscrepancies).toHaveLength(2);
    expect(report.verification.latestDiscrepancies.map((entry) => entry.atomId)).toEqual([
      "req-1",
      "req-2",
    ]);

    const text = formatRunReportText(report);
    expect(text).toContain("Fitness:");
    expect(text).toContain("atoms=3");
    expect(text).toContain("violated=2");
    expect(text).toContain("unverifiedMust=1");
    expect(text).toContain("deterministic_conflict=1");
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

  test("a receipt below the requirements rung (or a non-pass claim) carries no fitness annotation — zero counts, no crash", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 0, {}),
      record("task.requirement.recorded", 10, {
        atom: requirementAtom("req-1", "must hold"),
      }),
      record("verification.outcome.recorded", 100, {
        outcome: "pass",
        level: "artifact",
        perspective: "authored",
      }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.fitness.atomsTotal).toBe(1);
    expect(report.fitness.violatedAtoms).toBe(0);
    expect(report.fitness.unverifiedMustAtoms).toBe(0);
    expect(report.verification.latestDiscrepancies).toEqual([]);
  });
});
