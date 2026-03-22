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
  test("rebuilds workflow advisory and projection artifacts from tape when projection state is missing", async () => {
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
          outputKeys: ["design_spec", "execution_plan"],
          outputs: {
            design_spec: "Recover workflow artifacts from tape.",
            execution_plan: ["Replay durable events", "Rebuild advisory context"],
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
            review_report: "Recovered workflow chain is ready.",
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
      expect(injected.text).toContain("[WorkflowAdvisory]");
      expect(injected.text).toContain("planning: ready");
      expect(injected.text).toContain("implementation: ready");
      expect(injected.text).toContain("review: ready");
      expect(injected.text).toContain("verification: ready");
      expect(injected.text).toContain("release: ready");
      expect(injected.text).toContain("[WorkingProjection]");
      expect(injected.text).toContain(
        "workflow.design: state=ready; freshness=unknown; Recover workflow artifacts from tape.",
      );
      expect(injected.text).toContain(
        "workflow.review: state=ready; freshness=fresh; decision=ready; Recovered workflow chain is ready.",
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
