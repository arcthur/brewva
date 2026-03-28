import { describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { patchProcessEnv } from "../../helpers/global-state.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function runInspect(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  return spawnSync("bun", ["run", "start", "inspect", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

function runSubcommand(
  subcommand: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  return spawnSync("bun", ["run", "start", subcommand, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

describe("inspect subcommand", () => {
  test(
    "rebuilds a replay-first session report from persisted artifacts",
    () => {
      const workspace = createTestWorkspace("inspect-json-report");
      const xdgConfigHome = join(workspace, ".xdg");
      mkdirSync(join(xdgConfigHome, "brewva"), { recursive: true });
      writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
      const restoreEnv = patchProcessEnv({
        XDG_CONFIG_HOME: xdgConfigHome,
      });

      try {
        const runtime = new BrewvaRuntime({
          cwd: workspace,
          config: structuredClone(DEFAULT_BREWVA_CONFIG),
        });
        const sessionId = "inspect-session-1";

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
          goal: "Inspect persisted runtime state",
        });
        runtime.task.recordBlocker(sessionId, {
          message: "verification still failing",
          source: "test",
        });
        runtime.truth.upsertFact(sessionId, {
          id: "truth:inspect",
          kind: "diagnostic",
          severity: "warn",
          summary: "inspect truth fact",
        });
        runtime.events.record({
          sessionId,
          type: "verification_outcome_recorded",
          payload: {
            schema: "brewva.verification.outcome.v1",
            level: "standard",
            outcome: "fail",
            failedChecks: ["tests"],
            missingEvidence: [],
            reason: "tests_failed",
          },
        });
        runtime.tools.recordResult({
          sessionId,
          toolName: "exec",
          args: { command: "bun test" },
          outputText: "Error: test failure",
          channelSuccess: false,
        });

        const result = runInspect(
          ["--cwd", workspace, "--config", ".brewva/brewva.json", "--session", sessionId, "--json"],
          {
            ...process.env,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
        );
        expect(result.status).toBe(0);

        const payload = JSON.parse(result.stdout) as {
          sessionId: string;
          task: { goal: string | null; blockers: number };
          truth: { activeFacts: number };
          verification: { outcome: string | null; failedChecks: string[] };
          ledger: { integrityValid: boolean; rows: number };
          consistency: { ledgerIntegrity: string };
          bootstrap: { routingEnabled: boolean | null };
          analysis?: {
            directory: string;
            verdict: string;
            findings: Array<{ code: string }>;
          };
        };

        expect(payload.sessionId).toBe(sessionId);
        expect(payload.task.goal).toBe("Inspect persisted runtime state");
        expect(payload.task.blockers).toBeGreaterThanOrEqual(1);
        expect(payload.truth.activeFacts).toBeGreaterThanOrEqual(1);
        expect(payload.verification.outcome).toBe("fail");
        expect(payload.verification.failedChecks).toEqual(["tests"]);
        expect(payload.ledger.rows).toBeGreaterThan(0);
        expect(payload.ledger.integrityValid).toBe(true);
        expect(payload.consistency.ledgerIntegrity).toBe("ok");
        expect(payload.bootstrap.routingEnabled).toBe(false);
        expect(payload.analysis?.directory).toBe(".");
        expect(payload.analysis?.verdict).toBe("mixed");
        expect(
          payload.analysis?.findings.some((finding) => finding.code === "verification_hygiene"),
        ).toBe(true);
      } finally {
        restoreEnv();
      }
    },
    { timeout: 20_000 },
  );

  test("prefers a bootstrapped replay session even when many newer synthetic runtime-only sessions exist", () => {
    const workspace = createTestWorkspace("inspect-default-session");
    const xdgConfigHome = join(workspace, ".xdg");
    mkdirSync(join(xdgConfigHome, "brewva"), { recursive: true });
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    const restoreEnv = patchProcessEnv({
      XDG_CONFIG_HOME: xdgConfigHome,
    });

    try {
      const runtime = new BrewvaRuntime({
        cwd: workspace,
        config: structuredClone(DEFAULT_BREWVA_CONFIG),
      });
      const interactiveSessionId = "inspect-default-real-1";

      runtime.events.record({
        sessionId: interactiveSessionId,
        type: "session_bootstrap",
        payload: {
          managedToolMode: "direct",
        },
      });
      runtime.events.record({
        sessionId: interactiveSessionId,
        type: "session_start",
        payload: {
          cwd: workspace,
        },
      });
      runtime.events.record({
        sessionId: interactiveSessionId,
        type: "message_end",
        payload: {
          role: "assistant",
          contentItems: 1,
          contentTextChars: 12,
        },
      });

      for (let index = 0; index < 60; index += 1) {
        const syntheticSessionId = `output-reg-${index}`;
        runtime.skills.activate(syntheticSessionId, "repository-analysis");
        runtime.skills.complete(syntheticSessionId, {
          repository_snapshot: `synthetic registry session ${index}`,
          impact_map: `synthetic impact map ${index}`,
          unknowns: ["synthetic only"],
        });
      }

      const result = runInspect(["--cwd", workspace, "--config", ".brewva/brewva.json", "--json"], {
        ...process.env,
        XDG_CONFIG_HOME: xdgConfigHome,
      });
      expect(result.status).toBe(0);

      const payload = JSON.parse(result.stdout) as { sessionId: string };
      expect(payload.sessionId).toBe(interactiveSessionId);
    } finally {
      restoreEnv();
    }
  });

  test(
    "can inspect a directory-scoped deterministic analysis directly from inspect",
    () => {
      const workspace = createTestWorkspace("inspect-directory-analysis");
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
      const restoreEnv = patchProcessEnv({
        XDG_CONFIG_HOME: xdgConfigHome,
      });

      try {
        const runtime = new BrewvaRuntime({
          cwd: workspace,
          config: structuredClone(DEFAULT_BREWVA_CONFIG),
        });
        const sessionId = "inspect-analysis-session-1";

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

        const result = runInspect(
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
          analysis: {
            directory: string;
            coverage: {
              writeAttribution: string;
              readAttribution: string;
              opsTelemetryAvailable: boolean;
            };
            scope: {
              writesInDir: number;
              writesOutOfDir: number;
            };
            findings: Array<{ code: string }>;
            evidenceGaps: string[];
            verdict: string;
          };
          snapshots: { patchHistoryExists: boolean };
        };

        expect(payload.analysis.directory).toBe("src");
        expect(payload.analysis.coverage.writeAttribution).toBe("strong");
        expect(payload.analysis.coverage.readAttribution).toBe("heuristic");
        expect(payload.analysis.coverage.opsTelemetryAvailable).toBe(false);
        expect(payload.analysis.scope.writesInDir).toBe(0);
        expect(payload.analysis.scope.writesOutOfDir).toBeGreaterThanOrEqual(1);
        expect(payload.snapshots.patchHistoryExists).toBe(true);
        expect(payload.analysis.findings.some((finding) => finding.code === "tool_contract")).toBe(
          true,
        );
        expect(
          payload.analysis.findings.some((finding) => finding.code === "shell_composition"),
        ).toBe(true);
        expect(payload.analysis.findings.some((finding) => finding.code === "scope_drift")).toBe(
          true,
        );
        expect(
          payload.analysis.findings.some((finding) => finding.code === "verification_hygiene"),
        ).toBe(true);
        expect(payload.analysis.verdict).toBe("questionable");
        expect(
          payload.analysis.evidenceGaps.some((gap) => gap.includes("audit-level events only")),
        ).toBe(true);
      } finally {
        restoreEnv();
      }
    },
    { timeout: 20_000 },
  );

  test("rejects the removed single-session alias before prompt execution", () => {
    const result = runSubcommand("insight", []);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown subcommand");
    expect(result.stderr).toContain("brewva inspect");
  });
});
