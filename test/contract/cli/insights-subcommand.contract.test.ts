import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runInsightsCli } from "@brewva/brewva-cli";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  createOperatorRuntimePort,
  createHostedRuntimePort,
} from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

async function runInsights(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalEnv = process.env;
  console.log = (...values: unknown[]) => {
    stdoutLines.push(values.map((value) => String(value)).join(" "));
  };
  console.error = (...values: unknown[]) => {
    stderrLines.push(values.map((value) => String(value)).join(" "));
  };
  process.env = { ...originalEnv, ...env };
  try {
    const exitCode = await runInsightsCli(args);
    return {
      exitCode,
      stdout: stdoutLines.join("\n"),
      stderr: stderrLines.join("\n"),
    };
  } finally {
    process.env = originalEnv;
    console.log = originalLog;
    console.error = originalError;
  }
}

function recordWriteSession(
  runtime: BrewvaRuntime,
  input: {
    workspace: string;
    sessionId: string;
    goal: string;
    path: string;
    content: string;
  },
): void {
  createHostedRuntimePort(runtime).extensions.hosted.events.record({
    sessionId: input.sessionId,
    type: "session_bootstrap",
    payload: {
      managedToolMode: "direct",
    },
  });
  createOperatorRuntimePort(runtime).operator.context.lifecycle.onTurnStart(input.sessionId, 1);
  runtime.authority.task.spec.set(input.sessionId, {
    schema: "brewva.task.v1",
    goal: input.goal,
  });
  runtime.authority.tools.tracking.markCall(input.sessionId, "edit");
  runtime.authority.tools.tracking.trackCallStart({
    sessionId: input.sessionId,
    toolCallId: `${input.sessionId}-edit-1`,
    toolName: "edit",
    args: { path: input.path },
  });
  writeFileSync(join(input.workspace, input.path), input.content, "utf8");
  runtime.authority.tools.tracking.trackCallEnd({
    sessionId: input.sessionId,
    toolCallId: `${input.sessionId}-edit-1`,
    toolName: "edit",
    channelSuccess: true,
  });
}

describe("insights subcommand", () => {
  test("prints help text", async () => {
    const result = await runInsights(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Brewva Insights - multi-session aggregation engine");
    expect(result.stdout).toContain("brewva insights [directory] [options]");
  });

  test(
    "aggregates actual activity directories across sessions instead of collapsing to the target scope",
    async () => {
      const workspace = createTestWorkspace("insights-json-report");
      const xdgConfigHome = join(workspace, ".xdg");
      mkdirSync(join(xdgConfigHome, "brewva"), { recursive: true });
      writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
      mkdirSync(join(workspace, "src"), { recursive: true });
      mkdirSync(join(workspace, "packages", "tool"), { recursive: true });
      writeFileSync(join(workspace, "src", "app.ts"), "export const app = 1;\n", "utf8");
      writeFileSync(
        join(workspace, "packages", "tool", "index.ts"),
        "export const tool = 1;\n",
        "utf8",
      );

      const runtime = new BrewvaRuntime({
        cwd: workspace,
        config: structuredClone(DEFAULT_BREWVA_CONFIG),
      });

      recordWriteSession(runtime, {
        workspace,
        sessionId: "insights-session-src",
        goal: "Update src app",
        path: "src/app.ts",
        content: "export const app = 2;\n",
      });
      recordWriteSession(runtime, {
        workspace,
        sessionId: "insights-session-tool",
        goal: "Update tool package",
        path: "packages/tool/index.ts",
        content: "export const tool = 2;\n",
      });

      const result = await runInsights(
        ["--cwd", workspace, "--config", ".brewva/brewva.json", "--json", "."],
        {
          ...process.env,
          XDG_CONFIG_HOME: xdgConfigHome,
        },
      );
      expect(result.exitCode).toBe(0);

      const payload = JSON.parse(result.stdout) as {
        window: { analyzedSessions: number; failedSessions: number };
        overview: {
          topDirectories: Array<{ path: string; sessionCount: number; writeCount: number }>;
        };
      };

      expect(payload.window.analyzedSessions).toBe(2);
      expect(payload.window.failedSessions).toBe(0);
      expect(payload.overview.topDirectories).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "src", sessionCount: 1, writeCount: 1 }),
          expect.objectContaining({ path: "packages/tool", sessionCount: 1, writeCount: 1 }),
        ]),
      );
    },
    { timeout: 20_000 },
  );
});
