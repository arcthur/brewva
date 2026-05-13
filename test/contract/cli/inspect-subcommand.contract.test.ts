import { describe, expect, test } from "bun:test";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  createOperatorRuntimePort,
  createHostedRuntimePort,
} from "@brewva/brewva-runtime";
import { createRecoveryWalStore } from "@brewva/brewva-runtime/recovery";
import { buildToolCallBlockedPayload } from "../../helpers/events.js";
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

        createHostedRuntimePort(runtime).extensions.hosted.events.record({
          sessionId,
          type: "session_bootstrap",
          payload: {
            managedToolMode: "direct",
          },
        });
        createOperatorRuntimePort(runtime).operator.context.lifecycle.onTurnStart(sessionId, 1);
        runtime.authority.task.spec.set(sessionId, {
          schema: "brewva.task.v1",
          goal: "Inspect persisted runtime state",
        });
        runtime.authority.task.blockers.record(sessionId, {
          message: "verification still failing",
          source: "test",
        });
        runtime.authority.claim.facts.upsert(sessionId, {
          id: "claim:inspect",
          kind: "diagnostic",
          severity: "warn",
          summary: "inspect claim fact",
        });
        createHostedRuntimePort(runtime).extensions.hosted.events.record({
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
        runtime.authority.tools.invocation.recordResult({
          sessionId,
          toolName: "exec",
          args: { command: "bun test" },
          outputText: "Error: test failure",
          channelSuccess: false,
        });
        createHostedRuntimePort(runtime).extensions.hosted.events.record({
          sessionId,
          type: "tool_call_blocked",
          payload: buildToolCallBlockedPayload(),
        });
        createHostedRuntimePort(runtime).extensions.hosted.events.record({
          sessionId,
          type: "session_turn_transition",
          payload: {
            reason: "compaction_retry",
            status: "failed",
            sequence: 1,
            family: "recovery",
            attempt: 1,
            sourceEventId: null,
            sourceEventType: null,
            error: "resume_failed",
            breakerOpen: false,
            model: null,
          },
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
          claim: { activeClaims: number };
          verification: { outcome: string | null; failedChecks: string[]; missingChecks: string[] };
          hostedTransitions: {
            sequence: number;
            pendingFamily: string | null;
            operatorVisibleFactGeneration: number;
            latest: {
              reason: string;
              status: string;
              attempt: number | null;
            } | null;
          };
          ledger: { integrityValid: boolean; rows: number };
          consistency: { ledgerIntegrity: string };
          bootstrap: { workspaceRoot: string | null; configPath: string | null };
          analysis?: {
            directory: string;
            verdict: string;
            findings: Array<{ code: string }>;
          };
        };

        expect(payload.sessionId).toBe(sessionId);
        expect(payload.task.goal).toBe("Inspect persisted runtime state");
        expect(payload.task.blockers).toBeGreaterThanOrEqual(1);
        expect(payload.claim.activeClaims).toBeGreaterThanOrEqual(1);
        expect(payload.verification.outcome).toBe("fail");
        expect(payload.verification.failedChecks).toEqual(["tests"]);
        expect(payload.verification.missingChecks).toEqual([]);
        expect(payload.hostedTransitions.sequence).toBe(1);
        expect(payload.hostedTransitions.pendingFamily).toBeNull();
        expect(payload.hostedTransitions.operatorVisibleFactGeneration).toBe(1);
        expect(payload.hostedTransitions.latest).toMatchObject({
          reason: "compaction_retry",
          status: "failed",
          attempt: 1,
        });
        expect(payload.ledger.rows).toBeGreaterThan(0);
        expect(payload.ledger.integrityValid).toBe(true);
        expect(payload.consistency.ledgerIntegrity).toBe("ok");
        expect("routingEnabled" in payload.bootstrap).toBe(false);
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

  test(
    "prefers a bootstrapped replay session even when many newer synthetic runtime-only sessions exist",
    () => {
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

        createHostedRuntimePort(runtime).extensions.hosted.events.record({
          sessionId: interactiveSessionId,
          type: "session_bootstrap",
          payload: {
            managedToolMode: "direct",
          },
        });
        createHostedRuntimePort(runtime).extensions.hosted.events.record({
          sessionId: interactiveSessionId,
          type: "session_start",
          payload: {
            cwd: workspace,
          },
        });
        createHostedRuntimePort(runtime).extensions.hosted.events.record({
          sessionId: interactiveSessionId,
          type: "message_end",
          payload: {
            role: "assistant",
            contentItems: 1,
            contentTextChars: 12,
          },
        });

        const result = runInspect(
          ["--cwd", workspace, "--config", ".brewva/brewva.json", "--json"],
          {
            ...process.env,
            XDG_CONFIG_HOME: xdgConfigHome,
          },
        );
        expect(result.status).toBe(0);

        const payload = JSON.parse(result.stdout) as { sessionId: string };
        expect(payload.sessionId).toBe(interactiveSessionId);
      } finally {
        restoreEnv();
      }
    },
    { timeout: 20_000 },
  );

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

        createHostedRuntimePort(runtime).extensions.hosted.events.record({
          sessionId,
          type: "session_bootstrap",
          payload: {
            managedToolMode: "direct",
          },
        });
        createOperatorRuntimePort(runtime).operator.context.lifecycle.onTurnStart(sessionId, 1);
        runtime.authority.task.spec.set(sessionId, {
          schema: "brewva.task.v1",
          goal: "Inspect session behavior in src",
        });
        runtime.authority.tools.tracking.markCall(sessionId, "edit");
        runtime.authority.tools.tracking.trackCallStart({
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
        runtime.authority.tools.tracking.trackCallEnd({
          sessionId,
          toolCallId: "edit-1",
          toolName: "edit",
          channelSuccess: true,
        });
        runtime.authority.tools.invocation.recordResult({
          sessionId,
          toolName: "exec",
          args: {
            command: "bash -lc 'if then'",
          },
          outputText: "bash: -c: line 1: syntax error near unexpected token `then'",
          channelSuccess: false,
        });
        createHostedRuntimePort(runtime).extensions.hosted.events.record({
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

  test("defaults to forensic config merge and preserves valid global overrides while stripping drift", () => {
    const workspace = createTestWorkspace("inspect-forensic-default-config");
    const xdgConfigHome = join(workspace, ".xdg");
    mkdirSync(join(xdgConfigHome, "brewva"), { recursive: true });
    writeFileSync(
      join(xdgConfigHome, "brewva", "brewva.json"),
      JSON.stringify(
        {
          projection: {
            dir: ".custom-projection",
          },
          skills: {
            selector: {
              mode: "llm_auto",
            },
          },
        },
        null,
        2,
      ),
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
      const sessionId = "inspect-forensic-default-config-1";
      createHostedRuntimePort(runtime).extensions.hosted.events.record({
        sessionId,
        type: "session_bootstrap",
        payload: {
          managedToolMode: "direct",
        },
      });
      createHostedRuntimePort(runtime).extensions.hosted.events.record({
        sessionId,
        type: "session_start",
        payload: {
          cwd: workspace,
        },
      });

      const result = runInspect(["--cwd", workspace, "--session", sessionId, "--json"], {
        ...process.env,
        XDG_CONFIG_HOME: xdgConfigHome,
      });
      expect(result.status).toBe(0);

      const payload = JSON.parse(result.stdout) as {
        sessionId: string;
        configLoad: {
          mode: string;
          paths: string[];
          warningCount: number;
        };
        projection: {
          rootDir: string;
        };
      };

      expect(payload.sessionId).toBe(sessionId);
      expect(payload.configLoad.mode).toBe("forensic_default");
      expect(payload.configLoad.paths).toEqual(
        expect.arrayContaining([
          join(xdgConfigHome, "brewva", "brewva.json"),
          join(workspace, ".brewva", "brewva.json"),
        ]),
      );
      expect(payload.configLoad.warningCount).toBeGreaterThanOrEqual(1);
      expect(payload.projection.rootDir).toBe(join(workspace, ".custom-projection"));
    } finally {
      restoreEnv();
    }
  });

  test("forensic inspect strips removed and unknown config fields for diagnostics only", () => {
    const workspace = createTestWorkspace("inspect-forensic-config-strip");
    const xdgConfigHome = join(workspace, ".xdg");
    mkdirSync(join(xdgConfigHome, "brewva"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva", "brewva.json"),
      JSON.stringify(
        {
          skills: {
            roots: ["./skills"],
            cascade: {
              enabled: true,
            },
            selector: {
              mode: "llm_auto",
            },
            routing: {
              profile: "legacy",
            },
          },
          security: {
            execution: {
              commandDenyList: ["node"],
            },
          },
          infrastructure: {
            contextBudget: {
              hardLimitPercent: 0.9,
            },
          },
        },
        null,
        2,
      ),
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
      const sessionId = "inspect-forensic-config-strip-1";
      createHostedRuntimePort(runtime).extensions.hosted.events.record({
        sessionId,
        type: "session_bootstrap",
        payload: {
          managedToolMode: "direct",
        },
      });

      const result = runInspect(["--cwd", workspace, "--session", sessionId, "--json"], {
        ...process.env,
        XDG_CONFIG_HOME: xdgConfigHome,
      });
      expect(result.status).toBe(0);

      const payload = JSON.parse(result.stdout) as {
        sessionId: string;
        configLoad: {
          warningCount: number;
          warnings: Array<{
            code: string;
            fields: string[];
          }>;
        };
      };

      expect(payload.sessionId).toBe(sessionId);
      expect(payload.configLoad.warningCount).toBeGreaterThanOrEqual(1);
      expect(payload.configLoad.warnings.map((warning) => warning.code)).toContain(
        "config_removed_fields_stripped",
      );
      const strippedFields = payload.configLoad.warnings.flatMap((warning) => warning.fields ?? []);
      expect(strippedFields).toEqual(
        expect.arrayContaining([
          "/skills/cascade",
          "/skills/selector",
          "/skills/routing/profile",
          "/security/execution/commandDenyList",
          "/infrastructure/contextBudget/hardLimitPercent",
        ]),
      );
    } finally {
      restoreEnv();
    }
  });

  test("session bootstrap provenance drives inspect recovery-wal paths", () => {
    const workspace = createTestWorkspace("inspect-bootstrap-recovery-wal");
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
      const sessionId = "inspect-bootstrap-recovery-wal-1";
      createHostedRuntimePort(runtime).extensions.hosted.events.record({
        sessionId,
        type: "session_bootstrap",
        payload: {
          managedToolMode: "direct",
          runtimeConfig: {
            workspaceRoot: workspace,
            artifactRoots: {
              recoveryWalDir: ".bootstrap-recovery-wal",
            },
          },
        },
      });
      createHostedRuntimePort(runtime).extensions.hosted.events.record({
        sessionId,
        type: "session_start",
        payload: {
          cwd: workspace,
        },
      });

      const recoveryWalStore = createRecoveryWalStore({
        workspaceRoot: workspace,
        config: {
          ...structuredClone(DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal),
          dir: ".bootstrap-recovery-wal",
        },
        scope: "runtime",
      });
      recoveryWalStore.appendPending(
        {
          schema: "brewva.turn.v1",
          kind: "tool",
          sessionId,
          turnId: "tool:read-1",
          channel: "tool_lifecycle",
          conversationId: sessionId,
          timestamp: 1_700_000_000_000,
          parts: [{ type: "text", text: "read (read-1)" }],
          meta: {
            toolCallId: "read-1",
            toolName: "read",
          },
        },
        "tool",
      );

      const result = runInspect(["--cwd", workspace, "--session", sessionId, "--json"], {
        ...process.env,
        XDG_CONFIG_HOME: xdgConfigHome,
      });
      expect(result.status).toBe(0);

      const payload = JSON.parse(result.stdout) as {
        bootstrap: {
          recoveryWalDir: string | null;
        };
        recoveryWal: {
          filePath: string;
          pendingSessionCount: number;
        };
      };

      expect(payload.bootstrap.recoveryWalDir).toBe(".bootstrap-recovery-wal");
      expect(payload.recoveryWal.filePath).toBe(
        join(workspace, ".bootstrap-recovery-wal", "runtime.jsonl"),
      );
      expect(payload.recoveryWal.pendingSessionCount).toBe(1);
    } finally {
      restoreEnv();
    }
  });

  test(
    "rejects the removed single-session alias before prompt execution",
    () => {
      const result = runSubcommand("insight", []);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unknown subcommand");
      expect(result.stderr).toContain("brewva inspect");
    },
    { timeout: 20_000 },
  );
});
