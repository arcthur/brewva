import { describe, expect, test } from "bun:test";
import type {
  DelegationOutcomeFinding,
  ExplorerReviewSubagentOutcomeData,
  ReviewLaneConfidence,
  ReviewLaneDisposition,
  ReviewLaneName,
  SubagentOutcome,
} from "../../../packages/brewva-tools/src/contracts/index.js";
import {
  synthesizeReviewEnsemble,
  type ReviewEnsembleSynthesisInput,
  type ReviewLaneActivationPlan,
} from "../../../packages/brewva-tools/src/shared/review-ensemble/index.js";

interface ReviewSpec {
  nickname: string;
  lane: ReviewLaneName;
  disposition: ReviewLaneDisposition;
  findings?: DelegationOutcomeFinding[];
  confidence?: ReviewLaneConfidence;
  strongestCounterpoint?: string;
  missingEvidence?: string[];
}

function reviewOutcome(spec: ReviewSpec): SubagentOutcome {
  const data: ExplorerReviewSubagentOutcomeData = {
    kind: "consult",
    consultKind: "review",
    conclusion: `${spec.lane} review`,
    primaryClaim: `${spec.nickname} on ${spec.lane}`,
    lane: spec.lane,
    disposition: spec.disposition,
    ...(spec.findings ? { findings: spec.findings } : {}),
    ...(spec.confidence ? { confidence: spec.confidence } : {}),
    ...(spec.strongestCounterpoint ? { strongestCounterpoint: spec.strongestCounterpoint } : {}),
    ...(spec.missingEvidence ? { missingEvidence: spec.missingEvidence } : {}),
  };
  return {
    ok: true,
    runId: `run-${spec.nickname}`,
    agent: "explorer",
    taskName: "review",
    taskPath: "review",
    nickname: spec.nickname,
    delegate: spec.lane,
    kind: "consult",
    consultKind: "review",
    status: "ok",
    summary: `${spec.nickname} reviewed ${spec.lane}`,
    data,
    metrics: { durationMs: 1 },
    evidenceRefs: [],
  };
}

function failedReviewer(nickname: string, lane: ReviewLaneName): SubagentOutcome {
  return {
    ok: false,
    runId: `run-${nickname}`,
    delegate: lane,
    label: lane,
    nickname,
    status: "error",
    error: "reviewer crashed",
    metrics: { durationMs: 1 },
  };
}

function planFor(lanes: readonly ReviewLaneName[]): ReviewLaneActivationPlan {
  return {
    planningPosture: "moderate",
    activatedLanes: [...lanes],
    activationBasis: ["test"],
    missingEvidence: [],
  };
}

function inputFor(
  lanes: readonly ReviewLaneName[],
  outcomes: readonly SubagentOutcome[],
): ReviewEnsembleSynthesisInput {
  return {
    activationPlan: planFor(lanes),
    outcomes,
    precedentQuerySummary: "none",
    precedentConsultStatus: "skipped",
  };
}

const LANE: ReviewLaneName = "review-correctness";

function laneOf(result: ReturnType<typeof synthesizeReviewEnsemble>, lane: ReviewLaneName) {
  const summary = result.laneOutcomes.find((laneOutcome) => laneOutcome.lane === lane);
  if (!summary) {
    throw new Error(`missing lane outcome for ${lane}`);
  }
  return summary;
}

function reportStrings(
  result: ReturnType<typeof synthesizeReviewEnsemble>,
  key: string,
): readonly string[] {
  const value = result.reviewReport[key];
  return Array.isArray(value) ? (value as string[]) : [];
}

describe("review ensemble synthesis aggregates every reviewer per lane", () => {
  test("preserves a finding only one of three reviewers saw", () => {
    const finding: DelegationOutcomeFinding = {
      summary: "off-by-one in offset calculation",
      severity: "high",
    };
    const result = synthesizeReviewEnsemble(
      inputFor(
        [LANE],
        [
          reviewOutcome({ nickname: "r1", lane: LANE, disposition: "clear" }),
          reviewOutcome({ nickname: "r2", lane: LANE, disposition: "clear" }),
          reviewOutcome({
            nickname: "r3",
            lane: LANE,
            disposition: "concern",
            findings: [finding],
          }),
        ],
      ),
    );

    expect(result.reviewFindings.map((entry) => entry.summary)).toContain(
      "off-by-one in offset calculation",
    );
    const lane = laneOf(result, LANE);
    expect(lane.reviewerCount).toBe(3);
    expect(lane.successfulReviewerCount).toBe(3);
    expect(lane.consensus).toBe("split");
    expect(lane.disposition).toBe("concern");
    expect(result.mergeDecision).toBe("needs_changes");
  });

  test("merges evidence across reviewers that raised the same finding", () => {
    const result = synthesizeReviewEnsemble(
      inputFor(
        [LANE],
        [
          reviewOutcome({
            nickname: "r1",
            lane: LANE,
            disposition: "concern",
            findings: [{ summary: "races on the cache", severity: "high", evidenceRefs: ["ev-a"] }],
          }),
          reviewOutcome({
            nickname: "r2",
            lane: LANE,
            disposition: "concern",
            findings: [
              { summary: "races on the cache", severity: "critical", evidenceRefs: ["ev-b"] },
            ],
          }),
        ],
      ),
    );

    const merged = result.reviewFindings.filter((entry) => entry.summary === "races on the cache");
    expect(merged).toHaveLength(1);
    expect(merged[0]!.severity).toBe("critical");
    expect([...(merged[0]!.evidenceRefs ?? [])].toSorted()).toEqual(["ev-a", "ev-b"]);
  });

  test("a single blocking reviewer blocks the lane fail-closed and keeps dissent", () => {
    const result = synthesizeReviewEnsemble(
      inputFor(
        [LANE],
        [
          reviewOutcome({ nickname: "r1", lane: LANE, disposition: "clear" }),
          reviewOutcome({
            nickname: "r2",
            lane: LANE,
            disposition: "blocked",
            strongestCounterpoint: "unsafe cast on the hot path",
          }),
        ],
      ),
    );

    const lane = laneOf(result, LANE);
    expect(lane.successfulReviewerCount).toBe(2);
    expect(lane.disposition).toBe("blocked");
    expect(lane.consensus).toBe("split");
    expect(result.mergeDecision).toBe("blocked");
    expect(
      reportStrings(result, "lane_disagreements").some((entry) =>
        entry.includes("unsafe cast on the hot path"),
      ),
    ).toBe(true);
  });

  test("unanimous clear lanes are ready; confidence is lowest-reported and reports its coverage", () => {
    const result = synthesizeReviewEnsemble(
      inputFor(
        [LANE],
        [
          reviewOutcome({ nickname: "r1", lane: LANE, disposition: "clear", confidence: "high" }),
          reviewOutcome({ nickname: "r2", lane: LANE, disposition: "clear", confidence: "low" }),
        ],
      ),
    );

    const lane = laneOf(result, LANE);
    expect(lane.disposition).toBe("clear");
    expect(lane.consensus).toBe("unanimous");
    expect(lane.confidence).toBe("low");
    expect(lane.confidenceReportedBy).toBe(2);
    // Confidence is advisory metadata, never a gate: low confidence does not block.
    expect(result.mergeDecision).toBe("ready");
  });

  test("partial confidence reporting is visible and does not fake a confident lane", () => {
    const result = synthesizeReviewEnsemble(
      inputFor(
        [LANE],
        [
          reviewOutcome({ nickname: "r1", lane: LANE, disposition: "clear", confidence: "high" }),
          reviewOutcome({ nickname: "r2", lane: LANE, disposition: "clear" }),
        ],
      ),
    );

    const lane = laneOf(result, LANE);
    expect(lane.reviewerCount).toBe(2);
    expect(lane.confidence).toBe("high");
    // Only one of the two reviewers actually reported confidence — that gap is visible.
    expect(lane.confidenceReportedBy).toBe(1);
  });

  test("a crashed reviewer is execution health, not a block, when another reviewer cleared", () => {
    const result = synthesizeReviewEnsemble(
      inputFor(
        [LANE],
        [
          reviewOutcome({ nickname: "r1", lane: LANE, disposition: "clear" }),
          failedReviewer("r2", LANE),
        ],
      ),
    );

    const lane = laneOf(result, LANE);
    expect(lane.successfulReviewerCount).toBe(1);
    expect(lane.executionFailureCount).toBe(1);
    expect(lane.disposition).toBe("clear");
    // A transient reviewer crash must not block a lane another reviewer cleared.
    expect(result.mergeDecision).toBe("ready");
    expect(
      reportStrings(result, "residual_blind_spots").some((entry) => entry.includes("r2")),
    ).toBe(true);
  });

  test("a lane where every reviewer failed blocks on zero coverage", () => {
    const result = synthesizeReviewEnsemble(
      inputFor([LANE], [failedReviewer("r1", LANE), failedReviewer("r2", LANE)]),
    );

    const lane = laneOf(result, LANE);
    expect(lane.successfulReviewerCount).toBe(0);
    expect(lane.executionFailureCount).toBe(2);
    expect(lane.disposition).toBe("blocked");
    expect(lane.consensus).toBe("none");
    expect(result.mergeDecision).toBe("blocked");
  });

  test("an outcome that states no verdict counts as execution failure, not inferred clear", () => {
    // A reviewer that returns only a lane (no disposition, findings, or
    // missing-evidence) establishes nothing and must not be inferred as clear.
    const verdictless: SubagentOutcome = {
      ok: true,
      runId: "run-r1",
      agent: "explorer",
      taskName: "review",
      taskPath: "review",
      nickname: "r1",
      delegate: LANE,
      kind: "consult",
      consultKind: "review",
      status: "ok",
      summary: "r1 reviewed nothing structured",
      data: { kind: "consult", consultKind: "review", conclusion: "looked around", lane: LANE },
      metrics: { durationMs: 1 },
      evidenceRefs: [],
    };
    const result = synthesizeReviewEnsemble(inputFor([LANE], [verdictless]));

    const lane = laneOf(result, LANE);
    expect(lane.successfulReviewerCount).toBe(0);
    expect(lane.executionFailureCount).toBe(1);
    expect(lane.disposition).toBe("blocked");
    expect(result.mergeDecision).toBe("blocked");
  });

  test("a missing activated lane blocks with consensus none", () => {
    const result = synthesizeReviewEnsemble(inputFor([LANE], []));

    const lane = laneOf(result, LANE);
    expect(lane.reviewerCount).toBe(0);
    expect(lane.successfulReviewerCount).toBe(0);
    expect(lane.executionFailureCount).toBe(0);
    expect(lane.consensus).toBe("none");
    expect(lane.disposition).toBe("blocked");
    expect(result.mergeDecision).toBe("blocked");
  });

  test("a single reviewer reports consensus single", () => {
    const result = synthesizeReviewEnsemble(
      inputFor([LANE], [reviewOutcome({ nickname: "r1", lane: LANE, disposition: "clear" })]),
    );

    const lane = laneOf(result, LANE);
    expect(lane.reviewerCount).toBe(1);
    expect(lane.successfulReviewerCount).toBe(1);
    expect(lane.consensus).toBe("single");
  });
});
