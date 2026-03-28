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
    config: createRuntimeConfig(),
  });
}

describe("S-004/S-005 verification gate", () => {
  test("blocks without evidence after write and passes with evidence", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s4";

    runtime.tools.markCall(sessionId, "edit");
    const blocked = runtime.verification.evaluate(sessionId);
    expect(blocked.passed).toBe(false);
    expect(blocked.missingEvidence).toContain("test_or_build");

    runtime.tools.recordResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      channelSuccess: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "All tests passed",
      channelSuccess: true,
    });

    const passed = runtime.verification.evaluate(sessionId);
    expect(passed.passed).toBe(true);
  });

  test("read-only session skips verification checks", () => {
    const runtime = createCleanRuntime();
    const sessionId = "s4-readonly";

    const report = runtime.verification.evaluate(sessionId);
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

    runtime.tools.markCall(sessionId, "multi_edit");
    const blocked = runtime.verification.evaluate(sessionId);
    expect(blocked.passed).toBe(false);
    expect(blocked.missingEvidence).toContain("test_or_build");
  });

  test("requires pass verdict before tool results count as verification evidence", () => {
    const runtime = createCleanRuntime();
    const sessionId = "s4-explicit-verdicts";

    runtime.tools.markCall(sessionId, "edit");
    runtime.tools.recordResult({
      sessionId,
      toolName: "lsp_diagnostics",
      args: { severity: "all" },
      outputText: "No diagnostics found",
      channelSuccess: true,
      verdict: "pass",
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "Tests still running",
      channelSuccess: true,
      verdict: "inconclusive",
    });

    const inconclusive = runtime.verification.evaluate(sessionId);
    expect(inconclusive.passed).toBe(false);
    expect(inconclusive.missingEvidence).toContain("test_or_build");

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "All tests passed",
      channelSuccess: true,
      verdict: "pass",
    });

    const passed = runtime.verification.evaluate(sessionId);
    expect(passed.passed).toBe(true);
  });
});
