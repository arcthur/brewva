import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestConfig } from "../../fixtures/config.js";
import { writeTestConfig } from "../../helpers/workspace.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("Task status alignment", () => {
  test("computes phase/health before agent start", async () => {
    const workspace = createTestWorkspace("task-status");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-1";

    const injection1 = await runtime.maintain.context.buildInjection(sessionId, "hello");
    expect(injection1.text).toContain("[TaskLedger]");
    expect(injection1.text).toContain("status.phase=investigate");
    expect(injection1.text).toContain("status.health=exploring");
    expect(injection1.text).toContain("status.reason=exploring_without_spec");

    runtime.authority.task.setSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    const stateAfterSpec = runtime.inspect.task.getState(sessionId);
    expect(stateAfterSpec.status?.phase).toBe("investigate");
    expect(stateAfterSpec.status?.health).toBe("ok");
    const injection2 = await runtime.maintain.context.buildInjection(sessionId, "next");
    expect(injection2.text).toContain("status.phase=investigate");

    runtime.authority.task.addItem(sessionId, { text: "Implement the fix" });
    const stateAfterItem = runtime.inspect.task.getState(sessionId);
    expect(stateAfterItem.status?.phase).toBe("execute");
    expect(stateAfterItem.status?.health).toBe("ok");
    const injection3 = await runtime.maintain.context.buildInjection(sessionId, "next");
    expect(injection3.text).toContain("status.phase=execute");
  });

  test("keeps health as ok for sub-1 percentage-point telemetry", async () => {
    const workspace = createTestWorkspace("task-status-percent");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-2";

    runtime.authority.task.setSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    runtime.authority.task.addItem(sessionId, { text: "Implement the fix" });

    const injection = await runtime.maintain.context.buildInjection(sessionId, "next", {
      tokens: 2688,
      contextWindow: 272000,
      percent: 0.9886,
    });
    expect(injection.text).toContain("status.phase=execute");
    expect(injection.text).toContain("status.health=ok");
    expect(injection.text).not.toContain("status.health=budget_pressure");
  });

  test("falls back to token telemetry when percent is missing for budget pressure", async () => {
    const workspace = createTestWorkspace("task-status-null-percent");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-null-percent-1";

    runtime.authority.task.setSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    runtime.authority.task.addItem(sessionId, { text: "Implement the fix" });

    const injection = await runtime.maintain.context.buildInjection(sessionId, "next", {
      tokens: 183000,
      contextWindow: 200000,
      percent: null,
    });
    expect(injection.text).toContain("status.phase=execute");
    expect(injection.text).toContain("status.health=budget_pressure");
    expect(injection.text).toContain("status.reason=context_usage_pressure");
  });

  test("surfaces blockers even when task spec is missing", async () => {
    const workspace = createTestWorkspace("task-status-with-blocker-no-spec");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-3";

    runtime.authority.task.recordBlocker(sessionId, {
      id: "blocker:no-spec",
      message: "Command failed before spec setup",
      source: "truth_extractor",
    });

    const state = runtime.inspect.task.getState(sessionId);
    expect(state.status?.phase).toBe("blocked");
    expect(state.status?.health).toBe("blocked");
    expect(state.status?.reason).toBe("blockers_present_without_spec");

    const injection = await runtime.maintain.context.buildInjection(sessionId, "next");
    expect(injection.text).toContain("status.phase=blocked");
    expect(injection.text).toContain("status.health=blocked");
  });

  test("keeps execute phase when task items exist before spec is defined", async () => {
    const workspace = createTestWorkspace("task-status-no-spec-items");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-4";

    runtime.authority.task.addItem(sessionId, { text: "Capture the current investigation plan" });

    const state = runtime.inspect.task.getState(sessionId);
    expect(state.status?.phase).toBe("execute");
    expect(state.status?.health).toBe("exploring");
    expect(state.status?.reason).toBe("spec_missing_open_items=1");

    const injection = await runtime.maintain.context.buildInjection(sessionId, "next");
    expect(injection.text).toContain("status.phase=execute");
    expect(injection.text).toContain("status.health=exploring");
  });

  test("hard blockers dominate open task items", async () => {
    const workspace = createTestWorkspace("task-status-hard-blocker");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-hard-blocker-1";

    runtime.authority.task.setSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    runtime.authority.task.addItem(sessionId, { text: "Implement the fix" });
    runtime.authority.task.recordBlocker(sessionId, {
      id: "blocker:environment",
      message: "Missing runtime dependency",
      source: "environment",
    });

    const state = runtime.inspect.task.getState(sessionId);
    expect(state.status?.phase).toBe("blocked");
    expect(state.status?.health).toBe("blocked");
    expect(state.status?.reason).toBe("blockers_present");
  });

  test("governance blockers are treated as hard blockers even when work remains", async () => {
    const workspace = createTestWorkspace("task-status-governance-blocker");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-governance-blocker-1";

    runtime.authority.task.setSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    runtime.authority.task.addItem(sessionId, { text: "Implement the fix" });
    runtime.authority.truth.upsertFact(sessionId, {
      id: "truth:governance:verify-spec",
      kind: "governance_verify_spec_failed",
      severity: "error",
      summary: "Spec rejected by governance",
    });
    runtime.authority.task.recordBlocker(sessionId, {
      id: "verifier:governance:verify-spec",
      message: "Spec rejected by governance",
      source: "governance",
      truthFactId: "truth:governance:verify-spec",
    });

    const state = runtime.inspect.task.getState(sessionId);
    expect(state.status?.phase).toBe("blocked");
    expect(state.status?.health).toBe("blocked");
    expect(state.status?.reason).toBe("blockers_present");
  });

  test("rejects non-canonical verifier blockers that omit a truth fact", async () => {
    const workspace = createTestWorkspace("task-status-verifier-blocker-contract");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-verifier-blocker-contract-1";

    const result = runtime.authority.task.recordBlocker(sessionId, {
      id: "verifier:tests",
      message: "verification missing fresh evidence: tests",
      source: "verification_gate",
    });

    expect(result).toEqual({
      ok: false,
      error: "verifier_blocker_requires_truth_fact",
    });
  });

  test("surfaces verification_missing when work is done but fresh verification evidence is absent", async () => {
    const workspace = createTestWorkspace("task-status-verification-missing");
    writeTestConfig(
      workspace,
      createTestConfig({
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
      }),
    );
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const sessionId = "task-status-verification-missing-1";

    runtime.authority.task.setSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    const added = runtime.authority.task.addItem(sessionId, { text: "Implement the fix" });
    if (!added.ok) {
      throw new Error("expected task item to be created");
    }
    runtime.authority.task.updateItem(sessionId, { id: added.itemId, status: "done" });
    runtime.authority.tools.markCall(sessionId, "edit");

    const report = await runtime.authority.verification.verify(sessionId, "standard", {
      executeCommands: false,
    });
    expect(report.passed).toBe(false);
    expect(report.failedChecks).toEqual([]);
    expect(report.missingChecks).toEqual(["tests"]);

    const state = runtime.inspect.task.getState(sessionId);
    expect(state.status?.phase).toBe("verify");
    expect(state.status?.health).toBe("verification_missing");
    expect(state.status?.reason).toBe("verification_missing");

    const injection = await runtime.maintain.context.buildInjection(sessionId, "next");
    expect(injection.text).toContain("status.phase=verify");
    expect(injection.text).toContain("status.health=verification_missing");
  });

  test("surfaces verification_failed when a fresh verification check actually fails", async () => {
    const workspace = createTestWorkspace("task-status-verification-failed");
    writeTestConfig(
      workspace,
      createTestConfig({
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
      }),
    );
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: ".brewva/brewva.json" });
    const sessionId = "task-status-verification-failed-1";

    runtime.authority.task.setSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    const added = runtime.authority.task.addItem(sessionId, { text: "Implement the fix" });
    if (!added.ok) {
      throw new Error("expected task item to be created");
    }
    runtime.authority.task.updateItem(sessionId, { id: added.itemId, status: "done" });
    runtime.authority.tools.markCall(sessionId, "edit");

    const report = await runtime.authority.verification.verify(sessionId, "standard", {
      executeCommands: true,
      timeoutMs: 5_000,
    });
    expect(report.passed).toBe(false);
    expect(report.failedChecks).toEqual(["tests"]);
    expect(report.missingChecks).toEqual([]);

    const state = runtime.inspect.task.getState(sessionId);
    expect(state.status?.phase).toBe("verify");
    expect(state.status?.health).toBe("verification_failed");
    expect(state.status?.reason).toBe("verification_failed");

    const injection = await runtime.maintain.context.buildInjection(sessionId, "next");
    expect(injection.text).toContain("status.phase=verify");
    expect(injection.text).toContain("status.health=verification_failed");
  });
});
