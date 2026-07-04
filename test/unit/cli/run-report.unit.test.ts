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
    record("tool.committed", committedAt, { call, result: { outcome: { kind: outcome } } }),
  ];
}

describe("buildRunReportProjection", () => {
  test("reconstructs span, tool mix, wait attribution, and fix cycles from the tape", () => {
    const events: BrewvaEventRecord[] = [
      record("turn.started", 1_000, { prompt: "build the app" }),
      ...toolCall("call-1", "write", 2_000, 2_100, "ok"),
      // Model gap between commit (2100) and next proposal (5100): 3s.
      ...toolCall("call-2", "exec", 5_100, 5_200, "err", { command: "make build" }),
      ...toolCall("call-3", "edit", 6_000, 6_050, "ok"),
      ...toolCall("call-4", "exec", 7_000, 40_000, "ok", { command: "make build" }),
      record("msg.committed", 41_000, { text: "done" }),
      record("turn.ended", 41_100, { cause: "terminal_commit" }),
    ];
    const report = buildRunReportProjection(SESSION, events);

    expect(report.durationMs).toBe(40_100);
    expect(report.turns).toBe(1);
    expect(report.assistantMessages).toBe(1);
    expect(report.toolCalls).toBe(4);

    const exec = report.toolStats.find((stat) => stat.toolName === "exec");
    expect(exec).toEqual({ toolName: "exec", calls: 2, ok: 1, err: 1, inconclusive: 0 });

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
      record("approval.decided", 400, { requestId: "req-1", decision: "accept" }),
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
    expect(report.cost).toEqual({ totalTokens: 1_234, includesEstimates: true });

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
        call: { toolCallId: "call-3", toolName: "exec", args: { command: "rm -rf /" } },
      }),
      record("approval.requested", 1_802_000, { id: "req-deny" }),
      record("approval.decided", 2_402_000, { requestId: "req-deny", decision: "deny" }),
      record("tool.aborted", 2_402_100, {
        call: { toolCallId: "call-3", toolName: "exec", args: { command: "rm -rf /" } },
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
});
