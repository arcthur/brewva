import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { buildProjectInsightsReport } from "../../../packages/brewva-cli/src/insights.js";
import { resolveInspectDirectory } from "../../../packages/brewva-cli/src/inspect-analysis.js";
import {
  buildInspectReport,
  buildSessionInspectReport,
  formatInspectText,
} from "../../../packages/brewva-cli/src/inspect.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("project insights aggregation", () => {
  test("exposes the active model preset from replayed session events", () => {
    const workspace = createTestWorkspace("inspect-model-preset");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });
    const sessionId = "inspect-model-preset-session";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "model_preset_select",
      payload: {
        presetName: "Claude Lead",
        previousPresetName: "Default",
        source: "tui",
        mainModel: "anthropic/claude-main:high",
        subagentModels: {
          advisor: "openai/gpt-5.5:medium",
        },
      },
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.modelPreset).toMatchObject({
      activeName: "Claude Lead",
      previousName: "Default",
      source: "tui",
      mainModel: "anthropic/claude-main:high",
      subagentModels: {
        advisor: "openai/gpt-5.5:medium",
      },
    });
  });

  test("surfaces unmatched model preset subagent keys in inspect output", () => {
    const workspace = createTestWorkspace("inspect-model-preset-unmatched-subagents");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });
    const sessionId = "inspect-model-preset-unmatched-subagents-session";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "model_preset_select",
      payload: {
        presetName: "Mixed Stack",
        source: "tui",
        subagentModels: {
          advisor: "openai/gpt-5.5:medium",
          "ghost-reviewer": "anthropic/claude-main:high",
        },
      },
    });

    const report = buildInspectReport(runtime, sessionId);

    expect(report.modelPreset.unmatchedSubagentModelKeys).toEqual(["ghost-reviewer"]);
    expect(formatInspectText(report)).toContain(
      "Model preset diagnostic: unmatchedSubagentModels=ghost-reviewer",
    );
  });

  test("tracks failed session analyses separately from excluded sessions", async () => {
    const workspace = createTestWorkspace("insights-failure-accounting");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });

    for (const sessionId of ["insights-ok-session", "insights-broken-session"]) {
      recordRuntimeEvent(runtime, {
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
      runtime.maintain.context.onTurnStart(sessionId, 1);
    }

    const directory = resolveInspectDirectory(runtime, ".", undefined);
    const report = await buildProjectInsightsReport({
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

  test("derives refactor work type from the task goal even when task phase is absent", async () => {
    const workspace = createTestWorkspace("insights-work-type-refactor");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    writeFileSync(join(workspace, "src.ts"), "export const value = 1;\n", "utf8");

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });

    const sessionId = "insights-refactor-session";
    recordRuntimeEvent(runtime, {
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
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Refactor the src module layout",
    });
    runtime.authority.tools.markCall(sessionId, "edit");
    runtime.authority.tools.trackCallStart({
      sessionId,
      toolCallId: "edit-1",
      toolName: "edit",
      args: { path: "src.ts" },
    });
    writeFileSync(join(workspace, "src.ts"), "export const value = 2;\n", "utf8");
    runtime.authority.tools.trackCallEnd({
      sessionId,
      toolCallId: "edit-1",
      toolName: "edit",
      channelSuccess: true,
    });

    const directory = resolveInspectDirectory(runtime, ".", undefined);
    const report = await buildProjectInsightsReport({
      runtime,
      directory,
    });

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]?.workType).toBe("refactor");
  });

  test("reports unavailable session index instead of scanning replay sessions", async () => {
    const workspace = createTestWorkspace("insights-index-unavailable");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    mkdirSync(join(workspace, ".brewva", "session-index"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva", "session-index", "session-index.duckdb"),
      "not a duckdb database",
      "utf8",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });
    recordRuntimeEvent(runtime, {
      sessionId: "insights-corrupt-index-session",
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

    const directory = resolveInspectDirectory(runtime, ".", undefined);
    const report = await buildProjectInsightsReport({
      runtime,
      directory,
    });

    expect(report.index.status).toBe("unavailable");
    expect(report.window.analyzedSessions).toBe(0);
    expect(report.sessions).toEqual([]);
  });
});
