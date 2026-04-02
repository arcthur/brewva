import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.projection.enabled = true;
  config.infrastructure.contextBudget.enabled = true;
  return config;
}

describe("system: workflow recovery", () => {
  test("rebuilds workflow projection artifacts from tape when projection state is missing", async () => {
    const workspace = createTestWorkspace("workflow-recovery-system");
    const config = createConfig();
    const sessionId = "workflow-system-recovery-1";

    try {
      const runtime = new BrewvaRuntime({ cwd: workspace, config });
      runtime.context.onTurnStart(sessionId, 1);
      runtime.task.setSpec(sessionId, {
        schema: "brewva.task.v1",
        goal: "Recover workflow state after projection loss",
      });
      runtime.events.record({
        sessionId,
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
            design_spec: "Recover workflow artifacts from tape.",
            execution_plan: [
              {
                step: "Replay durable events",
                intent: "Recover workflow posture strictly from durable session history.",
                owner: "runtime.workflow",
                exit_criteria: "Replay rebuilds canonical workflow artifacts after recovery.",
                verification_intent:
                  "Workflow recovery tests compare replayed posture against the pre-crash state.",
              },
              {
                step: "Rebuild advisory context",
                intent: "Restore working projection without hidden workflow controllers.",
                owner: "runtime.context",
                exit_criteria:
                  "Recovered session exposes workflow context through advisory surfaces.",
                verification_intent:
                  "Recovered sessions keep workflow context available through the working projection.",
              },
            ],
            execution_mode_hint: "coordinated_rollout",
            risk_register: [
              {
                risk: "Recovery may replay events but fail to reconstruct planning evidence.",
                category: "wal_replay",
                severity: "high",
                mitigation: "Persist canonical planning artifacts and recover them from tape.",
                required_evidence: ["workflow_recovery_system_test"],
                owner_lane: "review-concurrency",
              },
            ],
            implementation_targets: [
              {
                target: "packages/brewva-runtime/src/workflow/derivation.ts",
                kind: "module",
                owner_boundary: "runtime.workflow",
                reason: "Recovery workflow artifacts are derived here.",
              },
            ],
          },
        },
      });
      runtime.events.record({
        sessionId,
        type: "verification_write_marked",
        timestamp: 110,
        payload: {
          toolName: "edit",
        },
      });
      runtime.events.record({
        sessionId,
        type: "skill_completed",
        timestamp: 120,
        payload: {
          skillName: "review",
          outputKeys: ["review_report", "review_findings", "merge_decision"],
          outputs: {
            review_report: {
              summary:
                "Recovered workflow chain is ready after lane disclosure and precedent consult were rebuilt from tape.",
              activated_lanes: ["review-correctness", "review-boundaries", "review-operability"],
              activation_basis: [
                "Projection recovery changes workflow-facing artifacts.",
                "Verification evidence is fresh after replay.",
              ],
              missing_evidence: [],
              residual_blind_spots: [
                "No security lane was needed because replay recovery stays local to the repository.",
              ],
              precedent_query_summary:
                "query_intent=precedent_lookup | query=workflow recovery projection rebuild | source_types=auto | search_mode=solution_only",
              precedent_consult_status: {
                status: "consulted",
                precedent_refs: ["docs/solutions/workflow/review-disclosure-shape.md"],
              },
            },
            review_findings: [],
            merge_decision: "ready",
          },
        },
      });
      runtime.events.record({
        sessionId,
        type: "verification_outcome_recorded",
        timestamp: 130,
        payload: {
          outcome: "pass",
          level: "standard",
          failedChecks: [],
          evidenceFreshness: "fresh",
        },
      });

      const projectionRoot = join(workspace, ".orchestrator", "projection");
      rmSync(projectionRoot, { recursive: true, force: true });

      const reloaded = new BrewvaRuntime({ cwd: workspace, config });
      reloaded.context.onTurnStart(sessionId, 1);
      const injected = await reloaded.context.buildInjection(
        sessionId,
        "continue",
        { tokens: 320, contextWindow: 16_000, percent: 0.02 },
        "workflow-system-recovery",
      );

      expect(injected.accepted).toBe(true);
      expect(injected.text).toContain("[WorkingProjection]");
      expect(injected.text).toContain(
        "workflow.design: state=ready; freshness=stale; Recover workflow artifacts from tape.",
      );
      expect(injected.text).toContain(
        "workflow.review: state=ready; freshness=fresh; decision=ready; Recovered workflow chain is ready after lane disclosure and precedent consult were rebuilt from tape.",
      );
      expect(injected.text).toContain(
        "workflow.verification: state=ready; freshness=fresh; Verification pass (standard).",
      );
      expect(existsSync(join(projectionRoot, "sessions"))).toBe(true);
    } finally {
      cleanupTestWorkspace(workspace);
    }
  });
});
