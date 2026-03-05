import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestConfig } from "../fixtures/config.js";
import { createTestWorkspace, writeTestConfig } from "../helpers/workspace.js";

function createWorkspace(name: string): string {
  return createTestWorkspace(name);
}

function writeConfig(
  workspace: string,
  config: import("@brewva/brewva-runtime").BrewvaConfig,
): void {
  writeTestConfig(workspace, config);
}

describe("Verification blockers", () => {
  test("creates and resolves verifier blocker across failing->passing checks", async () => {
    const workspace = createWorkspace("verification-blockers");
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const sessionId = "verify-blockers-1";

    runtime.tools.markCall(sessionId, "edit");
    const report1 = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report1.passed).toBe(false);

    const state1 = runtime.task.getState(sessionId);
    const blocker1 = state1.blockers.find((blocker) => blocker.id === "verifier:tests");
    expect(blocker1).toBeDefined();
    expect(blocker1?.truthFactId).toBe("truth:verifier:tests");

    runtime.config.verification.commands.tests = "true";
    runtime.tools.markCall(sessionId, "edit");
    const report2 = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report2.passed).toBe(true);
    expect(
      runtime.task.getState(sessionId).blockers.some((item) => item.id === "verifier:tests"),
    ).toBe(false);
  });

  test("records governance blocker when governance verifySpec rejects", async () => {
    const workspace = createWorkspace("verification-governance");
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

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      governancePort: {
        verifySpec: () => ({ ok: false, reason: "spec_mismatch" }),
      },
    });

    const sessionId = "verify-governance-1";
    runtime.tools.markCall(sessionId, "edit");
    const report = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });

    expect(report.passed).toBe(true);
    const blockers = runtime.task.getState(sessionId).blockers;
    expect(blockers.some((item) => item.id === "verifier:governance:verify-spec")).toBe(true);
    const events = runtime.events.query(sessionId, { type: "governance_verify_spec_failed" });
    expect(events.length).toBeGreaterThan(0);
    const structured = runtime.events.queryStructured(sessionId, {
      type: "governance_verify_spec_failed",
    });
    expect(structured[0]?.category).toBe("governance");
  });

  test("records governance pass and clears governance blocker/fact once checks recover", async () => {
    const workspace = createWorkspace("verification-governance-recover");
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
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      governancePort: {
        verifySpec: () => (mode === "fail" ? { ok: false, reason: "spec_mismatch" } : { ok: true }),
      },
    });

    const sessionId = "verify-governance-recover-1";
    runtime.tools.markCall(sessionId, "edit");
    const first = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(first.passed).toBe(true);
    expect(
      runtime.task
        .getState(sessionId)
        .blockers.some((item) => item.id === "verifier:governance:verify-spec"),
    ).toBe(true);

    mode = "pass";
    runtime.tools.markCall(sessionId, "edit");
    const second = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(second.passed).toBe(true);
    expect(
      runtime.task
        .getState(sessionId)
        .blockers.some((item) => item.id === "verifier:governance:verify-spec"),
    ).toBe(false);
    expect(
      runtime.events.query(sessionId, {
        type: "governance_verify_spec_passed",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      runtime.truth
        .getState(sessionId)
        .facts.find((fact) => fact.id === "truth:governance:verify-spec")?.status,
    ).toBe("resolved");
  });

  test("records governance error event when governance verifySpec throws", async () => {
    const workspace = createWorkspace("verification-governance-error");
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

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      configPath: ".brewva/brewva.json",
      governancePort: {
        verifySpec: () => {
          throw new Error("governance-port-failed");
        },
      },
    });

    const sessionId = "verify-governance-error-1";
    runtime.tools.markCall(sessionId, "edit");
    const report = await runtime.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report.passed).toBe(true);
    const events = runtime.events.query(sessionId, { type: "governance_verify_spec_error" });
    expect(events.length).toBeGreaterThan(0);
    const payload = events[0]?.payload as { error?: string } | undefined;
    expect(payload?.error).toContain("governance-port-failed");
  });

  test("records skipped outcome when verify runs in read-only mode", async () => {
    const workspace = createWorkspace("verification-outcome-without-write");
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

    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const sessionId = "verify-outcome-no-write";
    const report = await runtime.verification.verify(sessionId, "quick", {
      executeCommands: false,
    });

    expect(report.skipped).toBe(true);
    const outcomes = runtime.events.query(sessionId, { type: "verification_outcome_recorded" });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.payload?.outcome).toBe("skipped");
  });
});
