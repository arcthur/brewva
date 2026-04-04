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
            outputKeys: [
              "strategy_review",
              "scope_decision",
              "strategic_risks",
              "planning_posture",
            ],
            outputs: {
              strategy_review: "Hold scope around advisory workflow visibility first.",
              scope_decision: "Do not build a kernel-owned planner.",
              strategic_risks: ["Too much duplicated workflow state"],
              planning_posture: "complex",
            },
          },
        }),
        event({
          id: "evt-learning-research",
          type: "skill_completed",
          sessionId: "workflow-expanded-stages",
          timestamp: 115,
          payload: {
            skillName: "learning-research",
            outputKeys: [
              "knowledge_brief",
              "precedent_refs",
              "preventive_checks",
              "precedent_query_summary",
              "precedent_consult_status",
            ],
            outputs: {
              knowledge_brief:
                "Consulted replay precedents before design to preserve explicit workflow posture.",
              precedent_refs: ["docs/solutions/workflow/review-disclosure-shape.md"],
              preventive_checks: ["Keep lane disclosure stable in review outputs."],
              precedent_query_summary:
                "query=workflow review precedent | source_types=auto | search_mode=solution_only",
              precedent_consult_status: "matched",
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
            outputKeys: ["qa_report", "qa_findings", "qa_verdict", "qa_checks"],
            outputs: {
              qa_report: "Exercised the main path and confirmed the UI state.",
              qa_findings: [],
              qa_verdict: "pass",
              qa_checks: [
                {
                  name: "ui-smoke",
                  result: "pass",
                  command: "bun test",
                  exitCode: 0,
                  observedOutput: "ui smoke passed",
                  probeType: "adversarial",
                  artifactRefs: ["snapshots/main-flow.json"],
                },
              ],
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
    const strategyArtifact = status.artifacts.find(
      (artifact) => artifact.kind === "strategy_review",
    );
    expect(strategyArtifact?.summary).toContain("planning_posture=complex");
    expect(strategyArtifact?.outputKeys).toEqual(
      expect.arrayContaining([
        "strategy_review",
        "scope_decision",
        "strategic_risks",
        "planning_posture",
      ]),
    );
    expect(strategyArtifact?.metadata?.planningPosture).toBe("complex");
    const learningArtifact = status.artifacts.find(
      (artifact) => artifact.kind === "learning_research",
    );
    expect(learningArtifact?.summary).toContain("consult_status=matched");
    expect(learningArtifact?.outputKeys).toEqual(
      expect.arrayContaining([
        "knowledge_brief",
        "precedent_refs",
        "preventive_checks",
        "precedent_query_summary",
        "precedent_consult_status",
      ]),
    );
    expect(learningArtifact?.metadata?.precedentConsultStatus).toBe("matched");
    expect(status.artifacts.map((artifact) => artifact.kind)).toEqual(
      expect.arrayContaining([
        "discovery",
        "strategy_review",
        "learning_research",
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

  test("derives planning assurance metadata from canonical design and QA artifacts", () => {
    const status = deriveWorkflowStatus({
      sessionId: "workflow-planning-assurance",
      events: [
        event({
          id: "evt-strategy",
          type: "skill_completed",
          timestamp: 90,
          payload: {
            skillName: "strategy-review",
            outputKeys: ["planning_posture"],
            outputs: {
              planning_posture: "high_risk",
            },
          },
        }),
        event({
          id: "evt-design",
          type: "skill_completed",
          timestamp: 100,
          payload: {
            skillName: "design",
            outputKeys: [
              "design_spec",
              "execution_plan",
              "execution_mode_hint",
              "risk_register",
              "implementation_targets",
            ],
            outputs: {
              design_spec: "Lock planning into a typed contract with explicit evidence.",
              execution_plan: [
                {
                  step: "Promote plan to a first-class delegated result.",
                  intent: "Stop routing planning through exploration.",
                  owner: "gateway.subagents",
                  exit_criteria: "Delegated plan outcomes parse into a dedicated shape.",
                  verification_intent:
                    "Plan parsing tests confirm canonical skill output synthesis.",
                },
              ],
              execution_mode_hint: "coordinated_rollout",
              risk_register: [
                {
                  risk: "Required evidence could be declared but never exercised.",
                  category: "public_api",
                  severity: "high",
                  mitigation: "Make QA pass depend on required_evidence coverage.",
                  required_evidence: ["plan_contract_tests"],
                  owner_lane: "qa",
                },
              ],
              implementation_targets: [
                {
                  target: "packages/brewva-gateway/src/subagents/structured-outcome.ts",
                  kind: "module",
                  owner_boundary: "gateway.subagents",
                  reason: "Plan result parsing is implemented here.",
                },
              ],
            },
          },
        }),
        event({
          id: "evt-implementation",
          type: "skill_completed",
          timestamp: 110,
          payload: {
            skillName: "implementation",
            outputKeys: ["change_set", "files_changed"],
            outputs: {
              change_set:
                "Promoted plan outcomes and rewired design synthesis to the canonical contract.",
              files_changed: ["packages/brewva-gateway/src/subagents/structured-outcome.ts"],
            },
          },
        }),
        event({
          id: "evt-qa",
          type: "skill_completed",
          timestamp: 120,
          payload: {
            skillName: "qa",
            outputKeys: ["qa_report", "qa_findings", "qa_verdict", "qa_checks"],
            outputs: {
              qa_report: "Executed the canonical plan contract tests and preserved the evidence.",
              qa_findings: [],
              qa_verdict: "pass",
              qa_checks: [
                {
                  name: "plan-contract-tests",
                  result: "pass",
                  command: "bun test plan_contract_tests",
                  exitCode: 0,
                  observedOutput: "plan_contract_tests passed",
                  probeType: "adversarial",
                  artifactRefs: ["artifacts/plan_contract_tests.txt"],
                },
              ],
            },
          },
        }),
      ],
    });

    expect(status.posture.plan_complete).toBe(true);
    expect(status.posture.plan_fresh).toBe(false);
    expect(status.posture.review_required).toBe(true);
    expect(status.posture.qa_required).toBe(true);
    expect(status.posture.unsatisfied_required_evidence).toEqual([]);
  });

  test("treats fresh runtime verification as valid required-evidence coverage even without QA artifacts", () => {
    const status = deriveWorkflowStatus({
      sessionId: "workflow-required-evidence-verification",
      events: [
        event({
          id: "evt-design-verification",
          type: "skill_completed",
          timestamp: 100,
          payload: {
            skillName: "design",
            outputKeys: [
              "design_spec",
              "execution_plan",
              "execution_mode_hint",
              "risk_register",
              "implementation_targets",
            ],
            outputs: {
              design_spec: "Allow fresh runtime verification to satisfy plan-declared evidence.",
              execution_plan: [
                {
                  step: "Run the canonical verification contract checks.",
                  intent: "Keep required evidence machine-checkable at the verification layer.",
                  owner: "runtime.verification",
                  exit_criteria:
                    "Verification emits the required evidence token in fresh metadata.",
                  verification_intent:
                    "Workflow posture consumes fresh verification coverage texts.",
                },
              ],
              execution_mode_hint: "test_first",
              risk_register: [
                {
                  risk: "Required evidence could be considered unsatisfied when only verification proved it.",
                  category: "public_api",
                  severity: "high",
                  mitigation: "Union fresh verification coverage with QA coverage.",
                  required_evidence: ["plan_contract_tests"],
                  owner_lane: "qa",
                },
              ],
              implementation_targets: [
                {
                  target: "packages/brewva-runtime/src/workflow/derivation.ts",
                  kind: "module",
                  owner_boundary: "runtime.workflow",
                  reason: "Required evidence closure is derived here.",
                },
              ],
            },
          },
        }),
        event({
          id: "evt-verification-coverage",
          type: "verification_outcome_recorded",
          timestamp: 120,
          payload: {
            outcome: "pass",
            level: "standard",
            activeSkill: "implementation",
            failedChecks: [],
            evidenceFreshness: "fresh",
            commandsExecuted: ["plan_contract_tests"],
            checkResults: [
              {
                name: "plan_contract_tests",
                status: "pass",
                evidence: "plan_contract_tests passed",
              },
            ],
          },
        }),
      ],
    });

    expect(status.posture.unsatisfied_required_evidence).toEqual([]);
    expect(
      status.artifacts.find((artifact) => artifact.kind === "verification")?.metadata,
    ).toMatchObject({
      coverageTexts: expect.arrayContaining(["plan_contract_tests", "plan_contract_tests passed"]),
    });
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

  test("keeps missing verification checks as explicit blocked verification debt", () => {
    const status = deriveWorkflowStatus({
      sessionId: "workflow-verification-missing",
      events: [
        event({
          id: "evt-review",
          type: "skill_completed",
          sessionId: "workflow-verification-missing",
          timestamp: 100,
          payload: {
            skillName: "review",
            outputKeys: ["review_report", "review_findings", "merge_decision"],
            outputs: {
              review_report: "Review is ready.",
              review_findings: [],
              merge_decision: "ready",
            },
          },
        }),
        event({
          id: "evt-qa",
          type: "skill_completed",
          sessionId: "workflow-verification-missing",
          timestamp: 110,
          payload: {
            skillName: "qa",
            outputKeys: ["qa_report", "qa_findings", "qa_verdict", "qa_checks"],
            outputs: {
              qa_report: "QA passed.",
              qa_findings: [],
              qa_verdict: "pass",
              qa_checks: [
                {
                  name: "ui-smoke",
                  result: "pass",
                  command: "bun test",
                  exitCode: 0,
                  observedOutput: "ui smoke passed",
                  probeType: "adversarial",
                  artifactRefs: ["artifacts/ui-smoke.txt"],
                },
              ],
            },
          },
        }),
        event({
          id: "evt-verify",
          type: "verification_outcome_recorded",
          sessionId: "workflow-verification-missing",
          timestamp: 120,
          payload: {
            outcome: "fail",
            level: "standard",
            failedChecks: [],
            missingChecks: ["tests"],
            missingEvidence: ["tests"],
            evidenceFreshness: "none",
          },
        }),
      ],
    });

    expect(status.posture.review).toBe("ready");
    expect(status.posture.qa).toBe("ready");
    expect(status.posture.verification).toBe("blocked");
    expect(status.posture.ship).toBe("blocked");
    expect(status.posture.blockers).toContain("Verification missing fresh evidence for tests.");
    const verificationArtifact = status.artifacts.find(
      (artifact) => artifact.kind === "verification",
    );
    expect(verificationArtifact?.state).toBe("blocked");
    expect(verificationArtifact?.summary).toContain("Missing fresh evidence: tests.");
    expect(verificationArtifact?.metadata).toMatchObject({
      failedChecks: [],
      missingChecks: ["tests"],
    });
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

  test("captures structured review disclosure in workflow artifact metadata", () => {
    const artifacts = deriveWorkflowArtifacts([
      event({
        id: "evt-review-structured",
        type: "skill_completed",
        timestamp: 100,
        payload: {
          skillName: "review",
          outputKeys: ["review_report", "review_findings", "merge_decision"],
          outputs: {
            review_report: {
              summary:
                "Review cleared the merge after lane analysis and precedent consult matched the current change.",
              activated_lanes: ["review-correctness", "review-boundaries", "review-operability"],
              activation_basis: [
                "The diff changes workflow-facing package boundaries.",
                "Verification evidence is fresh.",
              ],
              missing_evidence: [],
              residual_blind_spots: [
                "Security lane was not activated because no new external surface is exposed.",
              ],
              precedent_query_summary:
                "query_intent=precedent_lookup | query=workflow review disclosure | source_types=auto | search_mode=solution_only",
              precedent_consult_status: {
                status: "consulted",
                precedent_refs: ["docs/solutions/workflow/review-disclosure-shape.md"],
              },
              lane_disagreements: [
                "Performance lane was not activated because no hot path changed.",
              ],
            },
            review_findings: [],
            merge_decision: "ready",
          },
        },
      }),
    ]);

    const reviewArtifact = artifacts.find((artifact) => artifact.kind === "review");
    expect(reviewArtifact?.summary).toContain("Review cleared the merge");
    expect(reviewArtifact?.metadata).toEqual(
      expect.objectContaining({
        mergeDecision: "ready",
        activatedLanes: ["review-correctness", "review-boundaries", "review-operability"],
        activationBasis: [
          "The diff changes workflow-facing package boundaries.",
          "Verification evidence is fresh.",
        ],
        missingEvidence: [],
        residualBlindSpots: [
          "Security lane was not activated because no new external surface is exposed.",
        ],
        precedentQuerySummary:
          "query_intent=precedent_lookup | query=workflow review disclosure | source_types=auto | search_mode=solution_only",
        precedentConsultStatus: {
          status: "consulted",
          precedent_refs: ["docs/solutions/workflow/review-disclosure-shape.md"],
        },
        laneDisagreements: ["Performance lane was not activated because no hot path changed."],
      }),
    );
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
