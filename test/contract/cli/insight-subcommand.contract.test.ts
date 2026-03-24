import { describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

function runInsight(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  return spawnSync("bun", ["run", "start", "insight", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

describe("insight subcommand", () => {
  test("prints help text", () => {
    const result = runInsight(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Brewva Insight - cutoff-aware session review for a directory");
    expect(result.stdout).toContain("brewva insight [directory] [options]");
  });

  test(
    "builds a directory-scoped report with deterministic non-model findings",
    () => {
      const workspace = createTestWorkspace("insight-json-report");
      const xdgConfigHome = join(workspace, ".xdg");
      mkdirSync(join(xdgConfigHome, "brewva"), { recursive: true });
      writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
      mkdirSync(join(workspace, "src"), { recursive: true });
      mkdirSync(join(workspace, "other"), { recursive: true });
      writeFileSync(join(workspace, "src", "in-scope.ts"), "export const inScope = 1;\n", "utf8");
      writeFileSync(
        join(workspace, "other", "out-of-scope.ts"),
        "export const outOfScope = 1;\n",
        "utf8",
      );
      const previousXdgConfigHome = process.env["XDG_CONFIG_HOME"];

      try {
        process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
        const runtime = new BrewvaRuntime({
          cwd: workspace,
          config: structuredClone(DEFAULT_BREWVA_CONFIG),
        });
        const sessionId = "insight-session-1";

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
          goal: "Inspect session behavior in src",
        });
        runtime.tools.markCall(sessionId, "edit");
        runtime.tools.trackCallStart({
          sessionId,
          toolCallId: "edit-1",
          toolName: "edit",
          args: {
            path: "other/out-of-scope.ts",
          },
        });
        writeFileSync(
          join(workspace, "other", "out-of-scope.ts"),
          "export const outOfScope = 2;\n",
          "utf8",
        );
        runtime.tools.trackCallEnd({
          sessionId,
          toolCallId: "edit-1",
          toolName: "edit",
          channelSuccess: true,
        });
        runtime.tools.recordResult({
          sessionId,
          toolName: "exec",
          args: {
            command: "bash -lc 'if then'",
          },
          outputText: "bash: -c: line 1: syntax error near unexpected token `then'",
          channelSuccess: false,
        });
        runtime.events.record({
          sessionId,
          type: "tool_contract_warning",
          payload: {
            skill: "repository-analysis",
            toolName: "grep",
            reason: "Prefer structural navigation before broad text search.",
          },
        });

        const result = runInsight(
          [
            "--cwd",
            workspace,
            "--config",
            ".brewva/brewva.json",
            "--session",
            sessionId,
            "--json",
            "src",
          ],
          {
            ...process.env,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
        );
        expect(result.status).toBe(0);

        const payload = JSON.parse(result.stdout) as {
          sessionId: string;
          directory: string;
          verdict: string;
          coverage: {
            writeAttribution: string;
            readAttribution: string;
            opsTelemetryAvailable: boolean;
          };
          scope: {
            writesInDir: number;
            writesOutOfDir: number;
          };
          base: {
            snapshots: { patchHistoryExists: boolean };
          };
          findings: Array<{ code: string }>;
          evidenceGaps: string[];
        };

        expect(payload.sessionId).toBe(sessionId);
        expect(payload.directory).toBe("src");
        expect(payload.coverage.writeAttribution).toBe("strong");
        expect(payload.coverage.readAttribution).toBe("heuristic");
        expect(payload.coverage.opsTelemetryAvailable).toBe(false);
        expect(payload.scope.writesInDir).toBe(0);
        expect(payload.scope.writesOutOfDir).toBeGreaterThanOrEqual(1);
        expect(payload.base.snapshots.patchHistoryExists).toBe(true);
        expect(payload.findings.some((finding) => finding.code === "tool_contract")).toBe(true);
        expect(payload.findings.some((finding) => finding.code === "shell_composition")).toBe(true);
        expect(payload.findings.some((finding) => finding.code === "scope_drift")).toBe(true);
        expect(payload.findings.some((finding) => finding.code === "verification_hygiene")).toBe(
          true,
        );
        expect(payload.verdict).toBe("questionable");
        expect(payload.evidenceGaps.some((gap) => gap.includes("audit-level events only"))).toBe(
          true,
        );
      } finally {
        if (previousXdgConfigHome === undefined) {
          delete process.env["XDG_CONFIG_HOME"];
        } else {
          process.env["XDG_CONFIG_HOME"] = previousXdgConfigHome;
        }
      }
    },
    { timeout: 20_000 },
  );

  test(
    "surfaces ops-environment and runtime-pressure findings when ops telemetry is available",
    () => {
      const workspace = createTestWorkspace("insight-ops-report");
      const xdgConfigHome = join(workspace, ".xdg");
      mkdirSync(join(xdgConfigHome, "brewva"), { recursive: true });
      writeFileSync(
        join(workspace, ".brewva", "brewva.json"),
        JSON.stringify({ infrastructure: { events: { level: "ops" } } }, null, 2),
        "utf8",
      );
      mkdirSync(join(workspace, "src"), { recursive: true });
      writeFileSync(join(workspace, "src", "ops.ts"), "export const ops = true;\n", "utf8");
      const previousXdgConfigHome = process.env["XDG_CONFIG_HOME"];

      try {
        process.env["XDG_CONFIG_HOME"] = xdgConfigHome;
        const config = structuredClone(DEFAULT_BREWVA_CONFIG);
        config.infrastructure.events.level = "ops";
        const runtime = new BrewvaRuntime({
          cwd: workspace,
          config,
        });
        const sessionId = "insight-ops-session-1";

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
        runtime.events.record({
          sessionId,
          type: "exec_sandbox_error",
          payload: {
            reason: "sandbox_execution_error",
            error: "connection refused",
          },
        });
        runtime.events.record({
          sessionId,
          type: "exec_fallback_host",
          payload: {
            reason: "sandbox_execution_error",
          },
        });
        runtime.events.record({
          sessionId,
          type: "tool_call_normalization_failed",
          payload: {
            reason: "invalid_tool_call_shape",
          },
        });
        runtime.events.record({
          sessionId,
          type: "skill_budget_warning",
          payload: {
            skill: "repository-analysis",
            budget: "tokens",
            mode: "warn",
            usedTokens: 1200,
            maxTokens: 1000,
          },
        });
        runtime.events.record({
          sessionId,
          type: "skill_parallel_warning",
          payload: {
            skill: "repository-analysis",
            activeRuns: 3,
            maxParallel: 2,
            mode: "warn",
          },
        });
        runtime.events.record({
          sessionId,
          type: "parallel_slot_rejected",
          payload: {
            runId: "run-1",
            skill: "repository-analysis",
            reason: "skill_max_parallel",
          },
        });
        runtime.events.record({
          sessionId,
          type: "context_compaction_gate_blocked_tool",
          payload: {
            blockedTool: "exec",
            reason: "critical_context_pressure_without_compaction",
          },
        });

        const result = runInsight(
          [
            "--cwd",
            workspace,
            "--config",
            ".brewva/brewva.json",
            "--session",
            sessionId,
            "--json",
            "src",
          ],
          {
            ...process.env,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
        );
        expect(result.status).toBe(0);

        const payload = JSON.parse(result.stdout) as {
          verdict: string;
          coverage: {
            opsTelemetryAvailable: boolean;
          };
          findings: Array<{ code: string; summary: string }>;
          evidenceGaps: string[];
        };

        expect(payload.coverage.opsTelemetryAvailable).toBe(true);
        expect(payload.findings.some((finding) => finding.code === "ops_environment")).toBe(true);
        expect(payload.findings.some((finding) => finding.code === "runtime_pressure")).toBe(true);
        expect(
          payload.findings.some((finding) => finding.summary.includes("exec_sandbox_error=1")),
        ).toBe(true);
        expect(
          payload.findings.some((finding) => finding.summary.includes("parallel_slot_rejected=1")),
        ).toBe(true);
        expect(payload.verdict).toBe("questionable");
        expect(payload.evidenceGaps.some((gap) => gap.includes("audit-level events only"))).toBe(
          false,
        );
      } finally {
        if (previousXdgConfigHome === undefined) {
          delete process.env["XDG_CONFIG_HOME"];
        } else {
          process.env["XDG_CONFIG_HOME"] = previousXdgConfigHome;
        }
      }
    },
    { timeout: 20_000 },
  );
});
