import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createWorkflowStatusTool } from "@brewva/brewva-tools";
import { extractTextContent, mergeContext } from "./tools-flow.helpers.js";

describe("workflow_status contract", () => {
  test("reports stale review and verification after a later write", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "workflow-status-stale";

    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "review",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: "Review ready.",
          review_findings: [],
          merge_decision: "ready",
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 110,
      payload: {
        outcome: "pass",
        level: "standard",
        activeSkill: "implementation",
        failedChecks: [],
        evidenceFreshness: "fresh",
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "verification_write_marked",
      timestamp: 120,
      payload: {
        toolName: "edit",
      } as Record<string, unknown>,
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-stale",
      {
        include_artifacts: true,
        history_limit: 4,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("[WorkflowStatus]");
    expect(text).toContain("review: stale");
    expect(text).toContain("verification: stale");
    expect(text).toContain("release: blocked");
    expect(text).toContain("artifacts (latest 4):");
    expect(text).toContain("- review | state=ready | freshness=stale");
    expect(text).toContain("- verification | state=ready | freshness=stale");
    expect((result.details as { verdict?: string } | undefined)?.verdict).toBe("fail");
  });

  test("blocks release while worker results are still pending", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-pending-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "workflow-status-pending";

    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "review",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: "Ready to merge.",
          review_findings: [],
          merge_decision: "ready",
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 110,
      payload: {
        outcome: "pass",
        level: "standard",
        failedChecks: [],
        evidenceFreshness: "fresh",
      } as Record<string, unknown>,
    });
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "worker-1",
      status: "ok",
      summary: "Patch result ready for merge/apply.",
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-pending",
      {},
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("implementation: pending");
    expect(text).toContain("pending_worker_results: 1");
    expect(text).toContain("release: blocked");
    expect(text).toContain("Pending worker results require merge/apply (1 result).");
    expect(
      (result.details as { pendingWorkerResults?: Array<{ workerId: string }> } | undefined)
        ?.pendingWorkerResults?.[0]?.workerId,
    ).toBe("worker-1");
  });

  test("prefers core workflow artifacts over synthetic release readiness when artifacts are limited", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-workflow-status-limit-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "workflow-status-limit";

    runtime.events.record({
      sessionId,
      type: "skill_completed",
      timestamp: 100,
      payload: {
        skillName: "review",
        outputKeys: ["review_report", "review_findings", "merge_decision"],
        outputs: {
          review_report: "Ready to merge.",
          review_findings: [],
          merge_decision: "ready",
        },
      } as Record<string, unknown>,
    });
    runtime.events.record({
      sessionId,
      type: "verification_outcome_recorded",
      timestamp: 110,
      payload: {
        outcome: "pass",
        level: "standard",
        failedChecks: [],
        evidenceFreshness: "fresh",
      } as Record<string, unknown>,
    });

    const tool = createWorkflowStatusTool({ runtime });
    const result = await tool.execute(
      "tc-workflow-status-limit",
      {
        include_artifacts: true,
        history_limit: 1,
      },
      undefined,
      undefined,
      mergeContext(sessionId, { cwd: workspace }),
    );

    const text = extractTextContent(result);
    expect(text).toContain("artifacts (latest 1):");
    expect(text).toContain("- verification | state=ready | freshness=fresh");
    expect(text).not.toContain("- release_readiness");
    expect(
      (result.details as { artifacts?: Array<{ kind: string }> } | undefined)?.artifacts?.[0]?.kind,
    ).toBe("verification");
  });
});
