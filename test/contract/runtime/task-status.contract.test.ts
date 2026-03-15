import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("Task status alignment", () => {
  test("computes phase/health before agent start", async () => {
    const workspace = createTestWorkspace("task-status");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-1";

    const injection1 = await runtime.context.buildInjection(sessionId, "hello");
    expect(injection1.text).toContain("[TaskLedger]");
    expect(injection1.text).toContain("status.phase=investigate");
    expect(injection1.text).toContain("status.health=exploring");
    expect(injection1.text).toContain("status.reason=exploring_without_spec");

    runtime.task.setSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    const stateAfterSpec = runtime.task.getState(sessionId);
    expect(stateAfterSpec.status?.phase).toBe("investigate");
    expect(stateAfterSpec.status?.health).toBe("ok");
    const injection2 = await runtime.context.buildInjection(sessionId, "next");
    expect(injection2.text).toContain("status.phase=investigate");

    runtime.task.addItem(sessionId, { text: "Implement the fix" });
    const stateAfterItem = runtime.task.getState(sessionId);
    expect(stateAfterItem.status?.phase).toBe("execute");
    expect(stateAfterItem.status?.health).toBe("ok");
    const injection3 = await runtime.context.buildInjection(sessionId, "next");
    expect(injection3.text).toContain("status.phase=execute");
  });

  test("keeps health as ok for sub-1 percentage-point telemetry", async () => {
    const workspace = createTestWorkspace("task-status-percent");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-2";

    runtime.task.setSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    runtime.task.addItem(sessionId, { text: "Implement the fix" });

    const injection = await runtime.context.buildInjection(sessionId, "next", {
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

    runtime.task.setSpec(sessionId, { schema: "brewva.task.v1", goal: "Do a thing" });
    runtime.task.addItem(sessionId, { text: "Implement the fix" });

    const injection = await runtime.context.buildInjection(sessionId, "next", {
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

    runtime.task.recordBlocker(sessionId, {
      id: "blocker:no-spec",
      message: "Command failed before spec setup",
      source: "truth_extractor",
    });

    const state = runtime.task.getState(sessionId);
    expect(state.status?.phase).toBe("blocked");
    expect(state.status?.health).toBe("blocked");
    expect(state.status?.reason).toBe("blockers_present_without_spec");

    const injection = await runtime.context.buildInjection(sessionId, "next");
    expect(injection.text).toContain("status.phase=blocked");
    expect(injection.text).toContain("status.health=blocked");
  });

  test("keeps execute phase when task items exist before spec is defined", async () => {
    const workspace = createTestWorkspace("task-status-no-spec-items");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-status-4";

    runtime.task.addItem(sessionId, { text: "Capture the current investigation plan" });

    const state = runtime.task.getState(sessionId);
    expect(state.status?.phase).toBe("execute");
    expect(state.status?.health).toBe("exploring");
    expect(state.status?.reason).toBe("spec_missing_open_items=1");

    const injection = await runtime.context.buildInjection(sessionId, "next");
    expect(injection.text).toContain("status.phase=execute");
    expect(injection.text).toContain("status.health=exploring");
  });
});
