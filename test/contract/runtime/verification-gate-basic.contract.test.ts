import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("verification-gate-contract");
});

afterEach(() => {
  if (workspace) cleanupWorkspace(workspace);
});

function createCleanRuntime(): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: workspace,
    config: createRuntimeConfig((config) => {
      config.verification.defaultLevel = "quick";
      config.verification.checks.quick = ["tests"];
      config.verification.checks.standard = ["tests"];
      config.verification.checks.strict = ["tests"];
      config.verification.commands.tests = "true";
    }),
  });
}

describe("S-004/S-005 verification gate", () => {
  test("blocks without authoritative check runs after write and passes after verification executes", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s4";

    runtime.authority.tools.markCall(sessionId, "edit");
    const blocked = runtime.authority.verification.evaluate(sessionId, "quick");
    expect(blocked.passed).toBe(false);
    expect(blocked.failedChecks).toEqual([]);
    expect(blocked.missingChecks).toEqual(["tests"]);
    expect(blocked.missingEvidence).toContain("tests");
    expect(blocked.checks).toEqual([
      expect.objectContaining({
        name: "tests",
        status: "missing",
      }),
    ]);

    const verified = await runtime.authority.verification.verify(sessionId, "quick", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(verified.passed).toBe(true);

    const passed = runtime.authority.verification.evaluate(sessionId, "quick");
    expect(passed.passed).toBe(true);
  });

  test("read-only session skips verification checks", () => {
    const runtime = createCleanRuntime();
    const sessionId = "s4-readonly";

    const report = runtime.authority.verification.evaluate(sessionId, "quick");
    expect(report.passed).toBe(true);
    expect(report.readOnly).toBe(true);
    expect(report.skipped).toBe(true);
    expect(report.reason).toBe("read_only");
    expect(report.checks.map((check) => check.status)).toEqual(
      Array(report.checks.length).fill("skip"),
    );
  });

  test("treats multi_edit as a mutation tool for verification gating", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s4-multi-edit";

    runtime.authority.tools.markCall(sessionId, "multi_edit");
    const blocked = runtime.authority.verification.evaluate(sessionId, "quick");
    expect(blocked.passed).toBe(false);
    expect(blocked.failedChecks).toEqual([]);
    expect(blocked.missingChecks).toEqual(["tests"]);
    expect(blocked.missingEvidence).toContain("tests");
  });

  test("ignores raw exec results until runtime verification records an authoritative check run", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s4-explicit-verdicts";

    runtime.authority.tools.markCall(sessionId, "edit");
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "true" },
      outputText: "All tests passed",
      channelSuccess: true,
      verdict: "pass",
    });
    runtime.authority.tools.recordResult({
      sessionId,
      toolName: "brewva_verify",
      args: { check: "tests", command: "true" },
      outputText: "Tests still running",
      channelSuccess: true,
      verdict: "inconclusive",
      metadata: {
        check: "tests",
        command: "true",
        exitCode: 0,
      },
    });

    const inconclusive = runtime.authority.verification.evaluate(sessionId, "quick");
    expect(inconclusive.passed).toBe(false);
    expect(inconclusive.failedChecks).toEqual([]);
    expect(inconclusive.missingChecks).toEqual(["tests"]);
    expect(inconclusive.missingEvidence).toContain("tests");

    const verified = await runtime.authority.verification.verify(sessionId, "quick", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(verified.passed).toBe(true);

    const passed = runtime.authority.verification.evaluate(sessionId, "quick");
    expect(passed.passed).toBe(true);
  });
});
