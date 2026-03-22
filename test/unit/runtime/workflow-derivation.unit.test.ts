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

    expect(status.readiness.implementation).toBe("ready");
    expect(status.readiness.review).toBe("stale");
    expect(status.readiness.verification).toBe("stale");
    expect(status.readiness.release).toBe("blocked");
    expect(status.readiness.blockers).toContain(
      "Review artifact is stale after later workspace mutations.",
    );
    expect(status.readiness.blockers).toContain(
      "Verification artifact is stale after later workspace mutations.",
    );
    expect(status.artifacts[0]?.kind).toBe("release_readiness");
  });

  test("blocks release when worker results are still pending", () => {
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

    expect(status.readiness.implementation).toBe("pending");
    expect(status.readiness.review).toBe("ready");
    expect(status.readiness.verification).toBe("ready");
    expect(status.readiness.release).toBe("blocked");
    expect(status.readiness.blockers).toContain(
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
            profile: "patch-worker",
            kind: "patch",
            summary: "Patch worker completed and awaits parent merge/apply.",
          },
        }),
      ],
    });

    expect(status.readiness.implementation).toBe("pending");
    expect(status.readiness.release).toBe("blocked");
    expect(status.readiness.blockers).toContain(
      "Worker patch result is pending parent merge/apply.",
    );
  });

  test("does not mark release freshness stale from unrelated blocker wording", () => {
    const status = deriveWorkflowStatus({
      sessionId: "workflow-release-freshness",
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
          sessionId: "workflow-release-freshness",
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
          sessionId: "workflow-release-freshness",
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

    expect(status.readiness.review).toBe("ready");
    expect(status.readiness.verification).toBe("ready");
    expect(status.readiness.release).toBe("blocked");
    expect(status.artifacts[0]?.kind).toBe("release_readiness");
    expect(status.artifacts[0]?.freshness).toBe("unknown");
  });
});
