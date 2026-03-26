import { describe, expect, test } from "bun:test";
import {
  deriveWorkflowArtifacts,
  deriveWorkflowStatus,
  type BrewvaEventRecord,
} from "@brewva/brewva-runtime";

function event(input: {
  id: string;
  type: string;
  sessionId?: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId ?? "workflow-derivation-session",
    type: input.type,
    timestamp: input.timestamp,
    payload: input.payload as BrewvaEventRecord["payload"],
  };
}

describe("workflow derivation", () => {
  test("derives discovery, strategy, qa, ship, and retro artifacts from skill outputs", () => {
    const status = deriveWorkflowStatus({
      sessionId: "workflow-expanded-stages",
      events: [
        event({
          id: "evt-discovery",
          type: "skill_completed",
          sessionId: "workflow-expanded-stages",
          timestamp: 100,
          payload: {
            skillName: "discovery",
            outputKeys: [
              "problem_frame",
              "user_pains",
              "scope_recommendation",
              "design_seed",
              "open_questions",
            ],
            outputs: {
              problem_frame: "Operators need a fast view of workflow posture drift.",
              user_pains: ["Hard to see missing stages", "Runtime state is easy to misread"],
              scope_recommendation: "Start with advisory-only state.",
              design_seed: "Project workflow state from durable events.",
              open_questions: ["Should ship depend on explicit QA?"],
            },
          },
        }),
        event({
          id: "evt-strategy",
          type: "skill_completed",
          sessionId: "workflow-expanded-stages",
          timestamp: 110,
          payload: {
            skillName: "strategy-review",
            outputKeys: ["strategy_review", "scope_decision", "strategic_risks"],
            outputs: {
              strategy_review: "Hold scope around advisory workflow visibility first.",
              scope_decision: "Do not build a kernel-owned planner.",
              strategic_risks: ["Too much duplicated workflow state"],
            },
          },
        }),
        event({
          id: "evt-review",
          type: "skill_completed",
          sessionId: "workflow-expanded-stages",
          timestamp: 120,
          payload: {
            skillName: "review",
            outputKeys: ["review_report", "review_findings", "merge_decision"],
            outputs: {
              review_report: "Review is clean.",
              review_findings: [],
              merge_decision: "ready",
            },
          },
        }),
        event({
          id: "evt-qa",
          type: "skill_completed",
          sessionId: "workflow-expanded-stages",
          timestamp: 130,
          payload: {
            skillName: "qa",
            outputKeys: ["qa_report", "qa_findings", "qa_verdict", "qa_artifacts"],
            outputs: {
              qa_report: "Exercised the main path and confirmed the UI state.",
              qa_findings: [],
              qa_verdict: "pass",
              qa_artifacts: ["snapshots/main-flow.json"],
            },
          },
        }),
        event({
          id: "evt-verify",
          type: "verification_outcome_recorded",
          sessionId: "workflow-expanded-stages",
          timestamp: 140,
          payload: {
            outcome: "pass",
            level: "standard",
            failedChecks: [],
            evidenceFreshness: "fresh",
          },
        }),
        event({
          id: "evt-ship",
          type: "skill_completed",
          sessionId: "workflow-expanded-stages",
          timestamp: 150,
          payload: {
            skillName: "ship",
            outputKeys: ["ship_report", "release_checklist", "ship_decision"],
            outputs: {
              ship_report: "Ready for PR handoff.",
              release_checklist: ["CI green", "Review ready"],
              ship_decision: "ready",
            },
          },
        }),
        event({
          id: "evt-retro",
          type: "skill_completed",
          sessionId: "workflow-expanded-stages",
          timestamp: 160,
          payload: {
            skillName: "retro",
            outputKeys: ["retro_summary", "retro_findings", "followup_recommendation"],
            outputs: {
              retro_summary: "The workflow chain stayed visible end-to-end.",
              retro_findings: ["Need a stronger QA protocol next."],
              followup_recommendation: "Make QA consume risk_register by default.",
            },
          },
        }),
      ],
    });

    expect(status.posture.discovery).toBe("ready");
    expect(status.posture.strategy).toBe("ready");
    expect(status.posture.review).toBe("ready");
    expect(status.posture.qa).toBe("ready");
    expect(status.posture.verification).toBe("ready");
    expect(status.posture.ship).toBe("ready");
    expect(status.posture.retro).toBe("ready");
    expect(status.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining([
        "discovery",
        "strategy_review",
        "qa",
        "ship",
        "retro",
        "ship_posture",
      ]),
    );
  });

  test("marks superseded planning artifacts as stale and links the replacement", () => {
    const artifacts = deriveWorkflowArtifacts([
      event({
        id: "evt-design-1",
        type: "skill_completed",
        timestamp: 100,
        payload: {
          skillName: "design",
          outputKeys: ["design_spec"],
          outputs: {
            design_spec: "First design draft",
          },
        },
      }),
      event({
        id: "evt-design-2",
        type: "skill_completed",
        timestamp: 200,
        payload: {
          skillName: "design",
          outputKeys: ["design_spec"],
          outputs: {
            design_spec: "Revised design draft",
          },
        },
      }),
    ]);

    const designArtifacts = artifacts.filter((artifact) => artifact.kind === "design");
    expect(designArtifacts).toHaveLength(2);
    expect(designArtifacts[0]?.summary).toContain("Revised design draft");
    expect(designArtifacts[0]?.supersedesArtifactId).toBe(designArtifacts[1]?.artifactId);
    expect(designArtifacts[0]?.freshness).toBe("unknown");
    expect(designArtifacts[1]?.freshness).toBe("stale");
  });

  test("marks review and verification stale after a later workspace mutation", () => {
    const status = deriveWorkflowStatus({
      sessionId: "workflow-stale-session",
      events: [
        event({
          id: "evt-review",
          type: "skill_completed",
          sessionId: "workflow-stale-session",
          timestamp: 100,
          payload: {
            skillName: "review",
            outputKeys: ["review_report", "review_findings", "merge_decision"],
            outputs: {
              review_report: "Looks good.",
              review_findings: [],
              merge_decision: "ready",
            },
          },
        }),
        event({
          id: "evt-verify",
          type: "verification_outcome_recorded",
          sessionId: "workflow-stale-session",
          timestamp: 110,
          payload: {
            outcome: "pass",
            level: "standard",
            activeSkill: "implementation",
            failedChecks: [],
            evidenceFreshness: "fresh",
          },
        }),
        event({
          id: "evt-write",
          type: "verification_write_marked",
          sessionId: "workflow-stale-session",
          timestamp: 120,
          payload: {
            toolName: "edit",
          },
        }),
      ],
    });

    expect(status.posture.implementation).toBe("ready");
    expect(status.posture.review).toBe("stale");
    expect(status.posture.qa).toBe("missing");
    expect(status.posture.verification).toBe("stale");
    expect(status.posture.ship).toBe("blocked");
    expect(status.posture.blockers).toContain(
      "Review artifact is stale after later workspace mutations.",
    );
    expect(status.posture.blockers).toContain(
      "Verification artifact is stale after later workspace mutations.",
    );
    expect(status.artifacts[0]?.kind).toBe("ship_posture");
  });

  test("blocks ship posture when worker results are still pending", () => {
    const status = deriveWorkflowStatus({
      sessionId: "workflow-pending-workers",
      pendingWorkerResults: 2,
      events: [
        event({
          id: "evt-review-ready",
          type: "skill_completed",
          sessionId: "workflow-pending-workers",
          timestamp: 100,
          payload: {
            skillName: "review",
            outputKeys: ["review_report", "review_findings", "merge_decision"],
            outputs: {
              review_report: "Ready to merge.",
              review_findings: [],
              merge_decision: "ready",
            },
          },
        }),
        event({
          id: "evt-verify-ready",
          type: "verification_outcome_recorded",
          sessionId: "workflow-pending-workers",
          timestamp: 110,
          payload: {
            outcome: "pass",
            level: "standard",
            failedChecks: [],
            evidenceFreshness: "fresh",
          },
        }),
      ],
    });

    expect(status.posture.implementation).toBe("pending");
    expect(status.posture.review).toBe("ready");
    expect(status.posture.qa).toBe("missing");
    expect(status.posture.verification).toBe("ready");
    expect(status.posture.ship).toBe("blocked");
    expect(status.posture.blockers).toContain(
      "Pending worker results require merge/apply (2 results).",
    );
  });

  test("treats pending worker patch artifacts as pending implementation even without hydrated worker results", () => {
    const status = deriveWorkflowStatus({
      sessionId: "workflow-pending-patch-artifact",
      events: [
        event({
          id: "evt-review-ready",
          type: "skill_completed",
          sessionId: "workflow-pending-patch-artifact",
          timestamp: 100,
          payload: {
            skillName: "review",
            outputKeys: ["review_report", "review_findings", "merge_decision"],
            outputs: {
              review_report: "Ready to merge.",
              review_findings: [],
              merge_decision: "ready",
            },
          },
        }),
        event({
          id: "evt-verify-ready",
          type: "verification_outcome_recorded",
          sessionId: "workflow-pending-patch-artifact",
          timestamp: 110,
          payload: {
            outcome: "pass",
            level: "standard",
            failedChecks: [],
            evidenceFreshness: "fresh",
          },
        }),
        event({
          id: "evt-subagent-patch",
          type: "subagent_completed",
          sessionId: "workflow-pending-patch-artifact",
          timestamp: 120,
          payload: {
            runId: "patch-worker-1",
            delegate: "patch-worker",
            skillName: "review",
            kind: "patch",
            summary: "Patch worker completed and awaits parent merge/apply.",
          },
        }),
      ],
    });

    expect(status.posture.implementation).toBe("pending");
    expect(status.posture.ship).toBe("blocked");
    expect(status.posture.blockers).toContain("Worker patch result is pending parent merge/apply.");
    expect(
      status.artifacts.find((artifact) => artifact.kind === "worker_patch")?.sourceSkillNames,
    ).toEqual(["review"]);
  });

  test("does not mark ship posture freshness stale from unrelated blocker wording", () => {
    const status = deriveWorkflowStatus({
      sessionId: "workflow-ship-posture-freshness",
      blockers: [
        {
          id: "blocker-1",
          message: "stale operator note about a follow-up task",
        },
      ],
      events: [
        event({
          id: "evt-review-ready",
          type: "skill_completed",
          sessionId: "workflow-ship-posture-freshness",
          timestamp: 100,
          payload: {
            skillName: "review",
            outputKeys: ["review_report", "review_findings", "merge_decision"],
            outputs: {
              review_report: "Ready to merge.",
              review_findings: [],
              merge_decision: "ready",
            },
          },
        }),
        event({
          id: "evt-verify-ready",
          type: "verification_outcome_recorded",
          sessionId: "workflow-ship-posture-freshness",
          timestamp: 110,
          payload: {
            outcome: "pass",
            level: "standard",
            failedChecks: [],
            evidenceFreshness: "fresh",
          },
        }),
      ],
    });

    expect(status.posture.review).toBe("ready");
    expect(status.posture.qa).toBe("missing");
    expect(status.posture.verification).toBe("ready");
    expect(status.posture.ship).toBe("blocked");
    expect(status.artifacts[0]?.kind).toBe("ship_posture");
    expect(status.artifacts[0]?.freshness).toBe("unknown");
  });

  test("marks ship artifacts stale when later QA or verification evidence changes ship posture", () => {
    const status = deriveWorkflowStatus({
      sessionId: "workflow-ship-stale",
      events: [
        event({
          id: "evt-review",
          type: "skill_completed",
          sessionId: "workflow-ship-stale",
          timestamp: 100,
          payload: {
            skillName: "review",
            outputKeys: ["review_report", "review_findings", "merge_decision"],
            outputs: {
              review_report: "Looks good.",
              review_findings: [],
              merge_decision: "ready",
            },
          },
        }),
        event({
          id: "evt-ship",
          type: "skill_completed",
          sessionId: "workflow-ship-stale",
          timestamp: 110,
          payload: {
            skillName: "ship",
            outputKeys: ["ship_report", "release_checklist", "ship_decision"],
            outputs: {
              ship_report: "Ready for merge.",
              release_checklist: ["Merge after verification"],
              ship_decision: "ready",
            },
          },
        }),
        event({
          id: "evt-verify",
          type: "verification_outcome_recorded",
          sessionId: "workflow-ship-stale",
          timestamp: 120,
          payload: {
            outcome: "pass",
            level: "standard",
            failedChecks: [],
            evidenceFreshness: "fresh",
          },
        }),
      ],
    });

    expect(status.posture.ship).toBe("stale");
    expect(status.posture.blockers).toContain(
      "Ship artifact is stale after later workflow evidence changed.",
    );
    const shipArtifact = status.artifacts.find((artifact) => artifact.kind === "ship");
    expect(shipArtifact?.freshness).toBe("stale");
  });

  test("derives iteration metric and guard artifacts from durable events", () => {
    const artifacts = deriveWorkflowArtifacts([
      event({
        id: "evt-metric",
        type: "iteration_metric_observed",
        timestamp: 100,
        payload: {
          schema: "brewva.iteration-facts.v1",
          kind: "metric_observation",
          metricKey: "latency_ms",
          value: 94,
          unit: "ms",
          aggregation: "p95",
          iterationKey: "iter-2",
          source: "goal-loop",
          evidenceRefs: ["verification:latency"],
          summary: "Latency dropped after the second causal unit.",
        },
      }),
      event({
        id: "evt-guard",
        type: "iteration_guard_recorded",
        timestamp: 110,
        payload: {
          schema: "brewva.iteration-facts.v1",
          kind: "guard_result",
          guardKey: "error_budget",
          status: "pass",
          iterationKey: "iter-2",
          source: "goal-loop",
          evidenceRefs: ["slo:error-budget"],
          summary: "Error budget stayed green.",
        },
      }),
    ]);

    expect(artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining(["iteration_metric", "iteration_guard"]),
    );
    expect(artifacts.find((artifact) => artifact.kind === "iteration_metric")?.summary).toContain(
      "Metric latency_ms observed at 94 ms",
    );
    expect(artifacts.find((artifact) => artifact.kind === "iteration_guard")?.state).toBe("ready");
  });
});
