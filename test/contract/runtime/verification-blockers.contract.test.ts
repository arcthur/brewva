import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { createTestConfig } from "../../fixtures/config.js";
import { requireDefined } from "../../helpers/assertions.js";
import { createTestWorkspace, writeTestConfig } from "../../helpers/workspace.js";

function writeConfig(
  workspace: string,
  config: import("@brewva/brewva-runtime").BrewvaConfig,
): void {
  writeTestConfig(workspace, config);
}

function latestOutcomePayload(runtime: BrewvaHostedRuntimePort, sessionId: string) {
  return runtime.inspect.events.records.query(sessionId, {
    type: "verification_outcome_recorded",
    last: 1,
  })[0]?.payload as
    | {
        outcome?: "pass" | "fail" | "skipped";
        commandsExecuted?: string[];
        commandsFresh?: string[];
        commandsMissing?: string[];
        missingChecks?: string[];
        checkProvenance?: Array<{
          check?: string;
          status?: "pass" | "fail" | "missing" | "skip";
          freshSinceWrite?: boolean;
        }>;
      }
    | undefined;
}

function blockerIds(runtime: BrewvaHostedRuntimePort, sessionId: string): string[] {
  return runtime.inspect.task.state.get(sessionId).blockers.map((blocker) => blocker.id);
}

describe("Verification blockers", () => {
  test("creates and resolves verifier blocker across failing->passing checks", async () => {
    const workspace = createTestWorkspace("verification-blockers");
    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "standard",
            checks: {
              quick: ["type-check"],
              standard: ["type-check", "tests"],
              strict: ["type-check", "tests"],
            },
            commands: {
              "type-check": "true",
              tests: "false",
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    }).hosted;
    const sessionId = "verify-blockers-1";

    runtime.authority.tools.tracking.markCall(sessionId, "edit");
    const report1 = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report1.passed).toBe(false);

    const state1 = runtime.inspect.task.state.get(sessionId);
    const blocker1 = requireDefined(
      state1.blockers.find((blocker) => blocker.id === "verifier:tests"),
      "expected verifier:tests blocker after failing verification",
    );
    expect(blocker1.claimId).toBe("claim:verifier:tests");
    expect(
      runtime.inspect.claim.state
        .get(sessionId)
        .claims.find((fact) => fact.id === "claim:verifier:tests")?.status,
    ).toBe("active");

    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "standard",
            checks: {
              quick: ["type-check"],
              standard: ["type-check", "tests"],
              strict: ["type-check", "tests"],
            },
            commands: {
              "type-check": "true",
              tests: "true",
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const reloaded = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    }).hosted;
    reloaded.authority.tools.tracking.markCall(sessionId, "edit");
    const report2 = await reloaded.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report2.passed).toBe(true);
    expect(blockerIds(reloaded, sessionId)).not.toContain("verifier:tests");
    expect(
      reloaded.inspect.claim.state
        .get(sessionId)
        .claims.find((fact) => fact.id === "claim:verifier:tests")?.status,
    ).toBe("resolved");
  });

  test("records governance blocker when governance verifySpec rejects", async () => {
    const workspace = createTestWorkspace("verification-governance");
    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "standard",
            checks: {
              quick: ["type-check"],
              standard: ["type-check"],
              strict: ["type-check"],
            },
            commands: {
              "type-check": "true",
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      governancePort: {
        verifySpec: () => ({ ok: false, reason: "spec_mismatch" }),
      },
    }).hosted;

    const sessionId = "verify-governance-1";
    runtime.authority.tools.tracking.markCall(sessionId, "edit");
    const report = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });

    expect(report.passed).toBe(true);
    const blockers = runtime.inspect.task.state.get(sessionId).blockers;
    expect(blockers.map((item) => item.id)).toContain("verifier:governance:verify-spec");
    const events = runtime.inspect.events.records.query(sessionId, {
      type: "governance_verify_spec_failed",
    });
    expect(events.length).toBeGreaterThan(0);
    const structured = runtime.inspect.events.records.queryStructured(sessionId, {
      type: "governance_verify_spec_failed",
    });
    expect(structured[0]?.category).toBe("governance");
  });

  test("records governance pass and clears governance blocker/fact once checks recover", async () => {
    const workspace = createTestWorkspace("verification-governance-recover");
    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "standard",
            checks: {
              quick: ["type-check"],
              standard: ["type-check"],
              strict: ["type-check"],
            },
            commands: {
              "type-check": "true",
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    let mode: "fail" | "pass" = "fail";
    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      governancePort: {
        verifySpec: () => (mode === "fail" ? { ok: false, reason: "spec_mismatch" } : { ok: true }),
      },
    }).hosted;

    const sessionId = "verify-governance-recover-1";
    runtime.authority.tools.tracking.markCall(sessionId, "edit");
    const first = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(first.passed).toBe(true);
    expect(blockerIds(runtime, sessionId)).toContain("verifier:governance:verify-spec");

    mode = "pass";
    runtime.authority.tools.tracking.markCall(sessionId, "edit");
    const second = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(second.passed).toBe(true);
    expect(blockerIds(runtime, sessionId)).not.toContain("verifier:governance:verify-spec");
    expect(
      runtime.inspect.events.records.query(sessionId, {
        type: "governance_verify_spec_passed",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      runtime.inspect.claim.state
        .get(sessionId)
        .claims.find((fact) => fact.id === "claim:governance:verify-spec")?.status,
    ).toBe("resolved");
  });

  test("records governance error event when governance verifySpec throws", async () => {
    const workspace = createTestWorkspace("verification-governance-error");
    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "standard",
            checks: {
              quick: ["type-check"],
              standard: ["type-check"],
              strict: ["type-check"],
            },
            commands: {
              "type-check": "true",
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      governancePort: {
        verifySpec: () => {
          throw new Error("governance-port-failed");
        },
      },
    }).hosted;

    const sessionId = "verify-governance-error-1";
    runtime.authority.tools.tracking.markCall(sessionId, "edit");
    const report = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report.passed).toBe(true);
    const events = runtime.inspect.events.records.query(sessionId, {
      type: "governance_verify_spec_error",
    });
    expect(events.length).toBeGreaterThan(0);
    const payload = events[0]?.payload as { error?: string } | undefined;
    expect(payload?.error).toContain("governance-port-failed");
  });

  test("records skipped outcome when verify runs in read-only mode", async () => {
    const workspace = createTestWorkspace("verification-outcome-without-write");
    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "quick",
            checks: {
              quick: ["type-check"],
              standard: ["type-check"],
              strict: ["type-check"],
            },
            commands: {
              "type-check": "true",
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    }).hosted;
    const sessionId = "verify-outcome-no-write";
    const report = await runtime.authority.verification.checks.verify(sessionId, "quick", {
      executeCommands: false,
    });

    expect(report.skipped).toBe(true);
    const outcomes = runtime.inspect.events.records.query(sessionId, {
      type: "verification_outcome_recorded",
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.payload?.outcome).toBe("skipped");
  });

  test("projects missing fresh verification evidence as a warn claim fact and resolves it after a fresh rerun", async () => {
    const workspace = createTestWorkspace("verification-missing-blocker");
    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "standard",
            checks: {
              quick: ["tests"],
              standard: ["tests"],
              strict: ["tests"],
            },
            commands: {
              tests: "true",
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    }).hosted;
    const sessionId = "verification-missing-blocker-1";
    runtime.authority.tools.tracking.markCall(sessionId, "edit");

    const first = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: false,
    });
    expect(first.passed).toBe(false);
    expect(first.failedChecks).toEqual([]);
    expect(first.missingChecks).toEqual(["tests"]);
    expect(first.missingEvidence).toEqual(["tests"]);

    const blocker = requireDefined(
      runtime.inspect.task.state
        .get(sessionId)
        .blockers.find((entry) => entry.id === "verifier:tests"),
      "expected verifier:tests blocker after missing verification evidence",
    );
    expect(blocker.message).toContain("verification missing fresh evidence: tests");
    expect(blocker.claimId).toBe("claim:verifier:tests");

    const fact = requireDefined(
      runtime.inspect.claim.state
        .get(sessionId)
        .claims.find((entry) => entry.id === "claim:verifier:tests"),
      "expected claim:verifier:tests fact after missing verification evidence",
    );
    expect(fact.kind).toBe("verification_check_missing");
    expect(fact.severity).toBe("warn");
    expect(fact.status).toBe("active");

    const firstOutcome = latestOutcomePayload(runtime, sessionId);
    expect(firstOutcome?.outcome).toBe("fail");
    expect(firstOutcome?.missingChecks).toEqual(["tests"]);
    expect(firstOutcome?.commandsMissing).toEqual(["tests"]);
    expect(firstOutcome?.checkProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "tests",
          status: "missing",
          freshSinceWrite: false,
        }),
      ]),
    );

    const second = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(second.passed).toBe(true);
    expect(blockerIds(runtime, sessionId)).not.toContain("verifier:tests");
    expect(
      runtime.inspect.claim.state
        .get(sessionId)
        .claims.find((entry) => entry.id === "claim:verifier:tests")?.status,
    ).toBe("resolved");
  });

  test("mixed command results keep pass provenance for successful checks and fail blockers for timed out checks", async () => {
    const workspace = createTestWorkspace("verification-timeout-folding");
    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "standard",
            checks: {
              quick: ["type-check"],
              standard: ["type-check", "tests"],
              strict: ["type-check", "tests"],
            },
            commands: {
              "type-check": "true",
              tests: 'node -e "setTimeout(() => {}, 250)"',
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    }).hosted;
    const sessionId = "verification-timeout-folding-1";
    runtime.authority.tools.tracking.markCall(sessionId, "edit");

    const report = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 40,
    });

    expect(report.passed).toBe(false);
    expect(report.failedChecks).toEqual(["tests"]);
    expect(report.missingChecks).toEqual([]);
    expect(report.missingEvidence).toEqual([]);
    expect(blockerIds(runtime, sessionId)).toContain("verifier:tests");
    expect(
      runtime.inspect.claim.state
        .get(sessionId)
        .claims.find((fact) => fact.id === "claim:verifier:tests")?.status,
    ).toBe("active");

    const outcome = latestOutcomePayload(runtime, sessionId);
    expect(outcome?.outcome).toBe("fail");
    expect(outcome?.commandsExecuted).toEqual(expect.arrayContaining(["type-check", "tests"]));
    expect(outcome?.commandsFresh).toEqual(expect.arrayContaining(["type-check", "tests"]));
    expect(outcome?.commandsMissing).toEqual([]);
    expect(outcome?.checkProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "type-check",
          status: "pass",
          freshSinceWrite: true,
        }),
        expect.objectContaining({
          check: "tests",
          status: "fail",
          freshSinceWrite: true,
        }),
      ]),
    );

    const verifyRows = runtime.inspect.ledger.store
      .listRows(sessionId)
      .filter((row) => row.tool === "brewva_verify" && row.metadata?.check === "tests");
    expect(verifyRows).toHaveLength(1);
    expect(verifyRows[0]?.verdict).toBe("fail");
    expect(verifyRows[0]?.metadata?.timedOut).toBe(true);
  });

  test("signal-terminated verification commands still fold into verifier blockers and failure provenance", async () => {
    const workspace = createTestWorkspace("verification-signal-kill");
    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "standard",
            checks: {
              quick: ["type-check"],
              standard: ["type-check", "tests"],
              strict: ["type-check", "tests"],
            },
            commands: {
              "type-check": "true",
              tests: 'node -e "process.kill(process.pid, \\"SIGTERM\\")"',
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    }).hosted;
    const sessionId = "verification-signal-kill-1";
    runtime.authority.tools.tracking.markCall(sessionId, "edit");

    const report = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });

    expect(report.passed).toBe(false);
    expect(report.failedChecks).toEqual(["tests"]);
    expect(report.missingChecks).toEqual([]);
    expect(report.missingEvidence).toEqual([]);
    expect(blockerIds(runtime, sessionId)).toContain("verifier:tests");

    const outcome = latestOutcomePayload(runtime, sessionId);
    expect(outcome?.outcome).toBe("fail");
    expect(outcome?.checkProvenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: "tests",
          status: "fail",
          freshSinceWrite: true,
        }),
      ]),
    );

    const verifyRows = runtime.inspect.ledger.store
      .listRows(sessionId)
      .filter((row) => row.tool === "brewva_verify" && row.metadata?.check === "tests");
    expect(verifyRows).toHaveLength(1);
    expect(verifyRows[0]?.verdict).toBe("fail");
    expect(verifyRows[0]?.metadata?.timedOut).not.toBe(true);
  });

  test("clearing session state rehydrates persisted verification write state and reruns checks", async () => {
    const workspace = createTestWorkspace("verification-clear-state");
    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "standard",
            checks: {
              quick: ["type-check"],
              standard: ["type-check", "tests"],
              strict: ["type-check", "tests"],
            },
            commands: {
              "type-check": "true",
              tests: "false",
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    }).hosted;
    const sessionId = "verification-clear-state-1";
    runtime.authority.tools.tracking.markCall(sessionId, "edit");

    const first = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(first.passed).toBe(false);
    const rowsBeforeClear = runtime.inspect.ledger.store
      .listRows(sessionId)
      .filter((row) => row.tool === "brewva_verify").length;

    runtime.operator.session.state.clear(sessionId);

    const second = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(second.passed).toBe(false);
    expect(second.skipped).toBe(false);
    expect(second.failedChecks).toEqual(["tests"]);
    expect(second.missingChecks).toEqual([]);
    expect(second.missingEvidence).toEqual([]);
    const rowsAfterClear = runtime.inspect.ledger.store
      .listRows(sessionId)
      .filter((row) => row.tool === "brewva_verify").length;
    expect(rowsAfterClear).toBeGreaterThan(rowsBeforeClear);

    const outcome = latestOutcomePayload(runtime, sessionId);
    expect(outcome?.outcome).toBe("fail");
    expect(outcome?.commandsExecuted).toEqual(expect.arrayContaining(["type-check", "tests"]));
  });

  test(
    "executes package scripts through the project package manager instead of raw script bodies",
    async () => {
      const workspace = createTestWorkspace("verification-package-script-runner");
      mkdirSync(join(workspace, "node_modules", ".bin"), { recursive: true });
      writeFileSync(
        join(workspace, "package.json"),
        JSON.stringify(
          {
            name: "verification-runner",
            packageManager: "bun@1.3.10",
            scripts: {
              test: "vitest",
            },
          },
          null,
          2,
        ),
        "utf8",
      );
      writeFileSync(
        join(workspace, "node_modules", ".bin", "vitest"),
        "#!/bin/sh\nprintf 'vitest-ok\\n'\n",
        "utf8",
      );
      chmodSync(join(workspace, "node_modules", ".bin", "vitest"), 0o755);
      writeConfig(
        workspace,
        createTestConfig(
          {
            verification: {
              defaultLevel: "standard",
              checks: {
                quick: ["tests"],
                standard: ["tests"],
                strict: ["tests"],
              },
              commands: {
                tests: "false",
              },
            },
          },
          { eventsLevel: "debug" },
        ),
      );

      const runtime = createBrewvaRuntime({
        cwd: workspace,
        configPath: ".brewva/brewva.json",
      }).hosted;
      const sessionId = "verification-package-script-runner-1";
      runtime.authority.tools.tracking.markCall(sessionId, "edit");

      const report = await runtime.authority.verification.checks.verify(sessionId, "standard", {
        executeCommands: true,
        timeoutMs: 5_000,
      });

      expect(report.passed).toBe(true);
      const verifyRow = runtime.inspect.ledger.store
        .listRows(sessionId)
        .find((row) => row.tool === "brewva_verify" && row.metadata?.check === "tests");
      expect(verifyRow?.metadata?.command).toBe("bun run test");
    },
    { timeout: 10_000 },
  );

  test("runs verification checks for every target root in a multi-root task", async () => {
    const workspace = createTestWorkspace("verification-multi-root");
    const repoA = join(workspace, "repo-a");
    const repoB = join(workspace, "repo-b");
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    mkdirSync(join(repoA, ".git"), { recursive: true });
    mkdirSync(join(repoB, ".git"), { recursive: true });
    writeFileSync(join(repoA, "app.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(repoB, "app.ts"), "export const b = 2;\n", "utf8");
    writeConfig(
      workspace,
      createTestConfig(
        {
          verification: {
            defaultLevel: "standard",
            checks: {
              quick: ["tests"],
              standard: ["tests"],
              strict: ["tests"],
            },
            commands: {
              tests: "pwd",
            },
          },
        },
        { eventsLevel: "debug" },
      ),
    );

    const runtime = createBrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
    }).hosted;
    const sessionId = "verification-multi-root-1";
    runtime.authority.task.spec.set(sessionId, {
      schema: "brewva.task.v1",
      goal: "Verify both repositories.",
      targets: {
        files: [join(repoA, "app.ts"), join(repoB, "app.ts")],
      },
    });
    runtime.authority.tools.tracking.markCall(sessionId, "edit");

    const report = await runtime.authority.verification.checks.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(2);
    const verifyRows = runtime.inspect.ledger.store
      .listRows(sessionId)
      .filter(
        (row) =>
          row.tool === "brewva_verify" &&
          typeof row.metadata?.check === "string" &&
          row.metadata.check.startsWith("tests@"),
      );
    expect(verifyRows).toHaveLength(2);
    expect(verifyRows.map((row) => row.argsSummary)).toEqual(
      expect.arrayContaining([expect.stringContaining(repoA), expect.stringContaining(repoB)]),
    );
  });
});
