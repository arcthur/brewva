import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { buildProjectInsightsReport } from "../../../packages/brewva-cli/src/insights.js";
import { resolveInspectDirectory } from "../../../packages/brewva-cli/src/inspect-analysis.js";
import { buildSessionInspectReport } from "../../../packages/brewva-cli/src/inspect.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("project insights aggregation", () => {
  test("tracks failed session analyses separately from excluded sessions", () => {
    const workspace = createTestWorkspace("insights-failure-accounting");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });

    for (const sessionId of ["insights-ok-session", "insights-broken-session"]) {
      runtime.events.record({
        sessionId,
        type: "session_bootstrap",
        payload: {
          managedToolMode: "direct",
          skillLoad: {
            routingEnabled: false,
            routingScopes: ["core", "domain"],
            routableSkills: [],
            hiddenSkills: [],
          },
        },
      });
      runtime.context.onTurnStart(sessionId, 1);
    }

    const directory = resolveInspectDirectory(runtime, ".", undefined);
    const report = buildProjectInsightsReport({
      runtime,
      directory,
      analyzeSession: (input) => {
        if (input.sessionId === "insights-broken-session") {
          throw new Error("corrupted replay state");
        }
        return buildSessionInspectReport(input);
      },
    });

    expect(report.window.analyzedSessions).toBe(1);
    expect(report.window.failedSessions).toBe(1);
    expect(report.window.excludedSessions).toBe(0);
    expect(report.analysisFailures).toEqual([
      {
        sessionId: "insights-broken-session",
        error: "corrupted replay state",
      },
    ]);
  });

  test("derives refactor work type from the task goal even when task phase is absent", () => {
    const workspace = createTestWorkspace("insights-work-type-refactor");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    writeFileSync(join(workspace, "src.ts"), "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });

    const sessionId = "insights-refactor-session";
    runtime.events.record({
      sessionId,
      type: "session_bootstrap",
      payload: {
        managedToolMode: "direct",
        skillLoad: {
          routingEnabled: false,
          routingScopes: ["core", "domain"],
          routableSkills: [],
          hiddenSkills: [],
        },
      },
    });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Refactor the src module layout",
    });
    runtime.tools.markCall(sessionId, "edit");
    runtime.tools.trackCallStart({
      sessionId,
      toolCallId: "edit-1",
      toolName: "edit",
      args: { path: "src.ts" },
    });
    writeFileSync(join(workspace, "src.ts"), "export const value = 2;\n", "utf8");
    runtime.tools.trackCallEnd({
      sessionId,
      toolCallId: "edit-1",
      toolName: "edit",
      channelSuccess: true,
    });

    const directory = resolveInspectDirectory(runtime, ".", undefined);
    const report = buildProjectInsightsReport({
      runtime,
      directory,
    });

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]?.workType).toBe("refactor");
  });
});
