import { describe, expect, test } from "bun:test";
import type { ReviewLaneName, SubagentOutcome } from "@brewva/brewva-tools";
import {
  ALL_REVIEW_LANES,
  ALWAYS_ON_REVIEW_LANES,
  buildReviewLaneDelegationTasks,
  classifyReviewChangedFiles,
  deriveReviewLaneActivationPlan,
  materializeReviewLaneOutcomes,
  synthesizeReviewEnsemble,
} from "@brewva/brewva-tools";

function buildReviewOutcome(
  lane: ReviewLaneName,
  input: {
    disposition?: "clear" | "concern" | "blocked" | "inconclusive";
    primaryClaim?: string;
    findings?: Array<{
      summary: string;
      severity?: "critical" | "high" | "medium" | "low";
      evidenceRefs?: string[];
    }>;
    missingEvidence?: string[];
    openQuestions?: string[];
    strongestCounterpoint?: string;
    summary?: string;
  } = {},
): SubagentOutcome {
  return {
    ok: true,
    runId: `${lane}-run`,
    delegate: lane,
    agentSpec: lane,
    label: lane,
    kind: "review",
    status: "ok",
    summary: input.summary ?? `${lane} completed`,
    assistantText: input.summary ?? `${lane} completed`,
    data: {
      kind: "review",
      lane,
      ...(input.disposition ? { disposition: input.disposition } : {}),
      ...(input.primaryClaim ? { primaryClaim: input.primaryClaim } : {}),
      ...(input.findings ? { findings: input.findings } : {}),
      ...(input.missingEvidence ? { missingEvidence: input.missingEvidence } : {}),
      ...(input.openQuestions ? { openQuestions: input.openQuestions } : {}),
      ...(input.strongestCounterpoint
        ? { strongestCounterpoint: input.strongestCounterpoint }
        : {}),
    },
    metrics: {
      durationMs: 5,
    },
    evidenceRefs: [],
  };
}

describe("review ensemble protocol", () => {
  test("classifies changed files into canonical fallback classes", () => {
    expect(
      classifyReviewChangedFiles([
        "packages/brewva-runtime/src/services/event-pipeline.ts",
        "packages/brewva-runtime/src/contracts/review.ts",
      ]),
    ).toEqual(expect.arrayContaining(["runtime_coordination", "persisted_format"]));

    expect(classifyReviewChangedFiles(["docs/reference/runtime.md"])).toEqual(["docs_only"]);
  });

  test("widens to all conditional lanes when evidence is missing", () => {
    const plan = deriveReviewLaneActivationPlan({
      planningPosture: "moderate",
      changedFileClasses: ["runtime_coordination"],
      evidenceState: {
        design_spec: "missing",
        verification_evidence: "stale",
      },
    });

    expect(plan.activatedLanes).toEqual([...ALL_REVIEW_LANES]);
    expect(plan.activationBasis).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Always-on lanes"),
        expect.stringContaining("design_spec:missing"),
      ]),
    );
    expect(plan.missingEvidence).toEqual(["design_spec:missing", "verification_evidence:stale"]);
  });

  test("builds canonical lane delegation tasks with lane-specific guidance", () => {
    const plan = deriveReviewLaneActivationPlan({
      planningPosture: "trivial",
    });

    const tasks = buildReviewLaneDelegationTasks({
      activationPlan: plan,
      packet: {
        objective: "Review the runtime merge path.",
        sharedNotes: ["Parent review scope is runtime recovery."],
      },
    });

    expect(tasks).toHaveLength(ALWAYS_ON_REVIEW_LANES.length);
    expect(tasks[0]).toEqual(
      expect.objectContaining({
        label: "review-correctness",
        activeSkillName: "review",
      }),
    );
    expect(tasks[0]?.objective).toContain("Lane focus:");
    expect(tasks[0]?.sharedNotes).toEqual(
      expect.arrayContaining([
        "Parent review scope is runtime recovery.",
        "Lane identity: review-correctness",
        "Set the structured review outcome lane field to the active review lane.",
      ]),
    );
  });

  test("synthesizes blocked review output when evidence gaps remain", () => {
    const activationPlan = deriveReviewLaneActivationPlan({
      planningPosture: "complex",
      changeCategories: ["wal_replay", "rollback"],
      evidenceState: {
        verification_evidence: "missing",
      },
    });

    const synthesis = synthesizeReviewEnsemble({
      activationPlan,
      outcomes: [
        buildReviewOutcome("review-correctness", {
          disposition: "concern",
          primaryClaim: "The replay cursor update is not proven against recovery order.",
          findings: [
            {
              summary: "Recovery can replay duplicate effect authorization after cursor drift.",
              severity: "high",
              evidenceRefs: ["event:1"],
            },
          ],
        }),
        buildReviewOutcome("review-boundaries", {
          disposition: "clear",
          primaryClaim: "The ownership boundary remains stable.",
        }),
        buildReviewOutcome("review-operability", {
          disposition: "inconclusive",
          primaryClaim: "Rollback posture is under-specified for this path.",
          missingEvidence: ["No fresh recovery verification evidence was attached."],
        }),
        buildReviewOutcome("review-security", {
          disposition: "clear",
          primaryClaim: "No new security exposure is visible from the changed path set.",
        }),
        buildReviewOutcome("review-concurrency", {
          disposition: "blocked",
          primaryClaim: "Recovery ordering remains under-specified.",
          strongestCounterpoint:
            "If replay is serialized externally, the observed race may stay latent.",
        }),
        buildReviewOutcome("review-compatibility", {
          disposition: "clear",
          primaryClaim: "No compatibility surface changed.",
        }),
        buildReviewOutcome("review-performance", {
          disposition: "clear",
          primaryClaim: "No hot-path regression signal is visible in the diff alone.",
          openQuestions: [
            "No throughput regression evidence was attached for replay-heavy scenarios.",
          ],
        }),
      ],
      precedentQuerySummary:
        "query_intent=precedent_lookup | query=wal replay rollback | source_types=auto | search_mode=solution_only",
      precedentConsultStatus: {
        status: "consulted",
        precedent_refs: ["docs/solutions/runtime-errors/wal-recovery-race.md"],
      },
    });

    expect(synthesis.mergeDecision).toBe("blocked");
    expect(synthesis.reviewFindings).toEqual([
      expect.objectContaining({
        summary: "Recovery can replay duplicate effect authorization after cursor drift.",
        severity: "high",
      }),
    ]);
    expect(synthesis.reviewReport.activated_lanes).toEqual([...ALL_REVIEW_LANES]);
    expect(synthesis.reviewReport.precedent_query_summary).toContain(
      "query_intent=precedent_lookup",
    );
    expect(synthesis.reviewReport.missing_evidence).toEqual(
      expect.arrayContaining([
        "verification_evidence:missing",
        "review-operability: No fresh recovery verification evidence was attached.",
      ]),
    );
    expect(synthesis.reviewReport.lane_disagreements).toEqual(
      expect.arrayContaining([expect.stringContaining("review-concurrency")]),
    );
    expect(synthesis.reviewReport.residual_blind_spots).toEqual(
      expect.arrayContaining([
        "review-performance: No throughput regression evidence was attached for replay-heavy scenarios.",
      ]),
    );
  });

  test("synthesizes ready when all activated lanes clear without findings", () => {
    const activationPlan = deriveReviewLaneActivationPlan({
      planningPosture: "trivial",
    });

    const synthesis = synthesizeReviewEnsemble({
      activationPlan,
      outcomes: activationPlan.activatedLanes.map((lane) =>
        buildReviewOutcome(lane, {
          disposition: "clear",
          primaryClaim: `${lane} cleared the change.`,
        }),
      ),
      precedentQuerySummary: "precedent consult not required for trivial review posture",
      precedentConsultStatus: {
        status: "not_required",
      },
    });

    expect(synthesis.mergeDecision).toBe("ready");
    expect(synthesis.reviewFindings).toEqual([]);
    expect(synthesis.reviewReport.missing_evidence).toEqual([]);
    expect(synthesis.reviewReport.residual_blind_spots).toEqual([]);
    expect(synthesis.laneOutcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lane: "review-correctness",
          disposition: "clear",
        }),
      ]),
    );
  });

  test("materializes durable review lane runs into review outcomes", () => {
    const outcomes = materializeReviewLaneOutcomes([
      {
        runId: "lane-clear",
        delegate: "review-boundaries",
        agentSpec: "review-boundaries",
        parentSessionId: "parent-session",
        status: "completed",
        createdAt: 100,
        updatedAt: 112,
        label: "review-boundaries",
        parentSkill: "review",
        kind: "review",
        summary: "Boundary lane completed cleanly.",
        resultData: {
          kind: "review",
          lane: "review-boundaries",
          disposition: "clear",
          primaryClaim: "The boundary remains stable.",
        },
      },
      {
        runId: "lane-failed",
        delegate: "review-concurrency",
        agentSpec: "review-concurrency",
        parentSessionId: "parent-session",
        status: "failed",
        createdAt: 120,
        updatedAt: 135,
        label: "review-concurrency",
        parentSkill: "review",
        kind: "review",
        summary: "Concurrency lane failed.",
        error: "delegated reviewer crashed",
      },
    ]);

    expect(outcomes).toEqual([
      expect.objectContaining({
        ok: true,
        runId: "lane-clear",
        kind: "review",
        status: "ok",
        data: {
          kind: "review",
          lane: "review-boundaries",
          disposition: "clear",
          primaryClaim: "The boundary remains stable.",
        },
      }),
      expect.objectContaining({
        ok: false,
        runId: "lane-failed",
        status: "error",
        error: "delegated reviewer crashed",
      }),
    ]);
  });

  test("activates canonical conditional lanes from change categories", () => {
    const plan = deriveReviewLaneActivationPlan({
      planningPosture: "moderate",
      changeCategories: ["authn", "public_api", "hot_path"],
    });

    expect(plan.activatedLanes).toEqual(
      expect.arrayContaining(["review-security", "review-compatibility", "review-performance"]),
    );
    expect(plan.activatedLanes).not.toContain("review-concurrency");
  });
});
