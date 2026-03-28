import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrewvaRuntime, parseTaskSpec } from "@brewva/brewva-runtime";
import type { TaskSpec } from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("Task ledger", () => {
  test("records TaskSpec and returns folded state", async () => {
    const workspace = createTestWorkspace("task-ledger-state");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-1";

    const spec: TaskSpec = {
      schema: "brewva.task.v1",
      goal: "Fix failing tests in runtime",
      targets: {
        files: ["packages/brewva-runtime/src/runtime.ts"],
      },
      constraints: ["Do not change public CLI flags"],
    };

    runtime.task.setSpec(sessionId, spec);

    const state = runtime.task.getState(sessionId);
    expect(state.spec?.schema).toBe("brewva.task.v1");
    expect(state.spec?.goal).toBe("Fix failing tests in runtime");
    expect(state.spec?.targets?.files?.[0]).toBe("packages/brewva-runtime/src/runtime.ts");
    expect(state.spec?.constraints?.[0]).toBe("Do not change public CLI flags");
  });

  test("hydrates from task events without restoring snapshot", async () => {
    const workspace = createTestWorkspace("task-ledger-hydrate");
    const sessionId = "task-2";

    const runtime1 = new BrewvaRuntime({ cwd: workspace });
    runtime1.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Refactor context injection",
    });

    const runtime2 = new BrewvaRuntime({ cwd: workspace });
    const state = runtime2.task.getState(sessionId);
    expect(state.spec?.goal).toBe("Refactor context injection");
  });

  test("parseTaskSpec rejects removed or invalid enum values", () => {
    const fullSpec = parseTaskSpec({
      goal: "Validate implementation",
      verification: {
        level: "strict",
        commands: ["bun test"],
      },
    });
    expect(fullSpec).toEqual({
      ok: true,
      spec: {
        schema: "brewva.task.v1",
        goal: "Validate implementation",
        verification: {
          level: "strict",
          commands: ["bun test"],
        },
      },
    });

    expect(
      parseTaskSpec({
        goal: "Review architecture",
        verification: {
          level: "none",
        },
      }),
    ).toEqual({
      ok: true,
      spec: {
        schema: "brewva.task.v1",
        goal: "Review architecture",
      },
    });

    expect(
      parseTaskSpec({
        goal: "Review architecture",
        verification: {
          level: "inspection",
          commands: ["review docs only"],
        },
      }),
    ).toEqual({
      ok: false,
      error: "TaskSpec verification.level must be one of: quick, standard, strict, none.",
    });

    expect(
      parseTaskSpec({
        goal: "Close with unsupported owner",
        acceptance: {
          owner: "model",
        },
      }),
    ).toEqual({
      ok: false,
      error: "TaskSpec acceptance.owner must be one of: operator.",
    });
  });

  test("injects task ledger context without neighborhood probe details", async () => {
    const workspace = createTestWorkspace("task-ledger-injection");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-ledger-injection";

    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
      join(workspace, "src/bar.ts"),
      ["export interface Bar {", "  value: string;", "}"].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(workspace, "src/foo.ts"),
      [
        'import type { Bar } from "./bar";',
        "export function useBar(bar: Bar): string {",
        "  return bar.value;",
        "}",
      ].join("\n"),
      "utf8",
    );

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Ensure Bar is wired correctly",
      targets: {
        files: ["src/foo.ts"],
      },
      verification: {
        level: "standard",
      },
    });
    runtime.task.addItem(sessionId, {
      text: "Confirm the projected task state uses agent-facing labels",
      status: "todo",
    });

    const injection = await runtime.context.buildInjection(
      sessionId,
      "Ensure Bar is wired correctly",
    );
    expect(injection.text).toContain("[TaskLedger]");
    expect(injection.text).toContain("targets.files:");
    expect(injection.text).toContain("src/foo.ts");
    expect(injection.text).toContain("verification.level=targeted");
    expect(injection.text).toContain(
      "- [pending] Confirm the projected task state uses agent-facing labels",
    );
    expect(injection.text).not.toContain("[Viewport]");
  });

  test("holds closure at ready_for_acceptance until operator acceptance is recorded", () => {
    const workspace = createTestWorkspace("task-ledger-acceptance");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-ledger-acceptance";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Close the task with explicit operator acceptance",
      verification: {
        level: "quick",
      },
      acceptance: {
        required: true,
        owner: "operator",
        criteria: ["Operator accepts the result as closure."],
      },
    });
    runtime.task.addItem(sessionId, {
      id: "item-1",
      text: "Finish the implementation",
      status: "done",
    });

    const pendingState = runtime.task.getState(sessionId);
    expect(pendingState.status?.phase).toBe("ready_for_acceptance");
    expect(pendingState.status?.health).toBe("acceptance_pending");
    expect(pendingState.acceptance).toBeUndefined();

    runtime.task.recordAcceptance(sessionId, {
      status: "accepted",
      decidedBy: "operator",
      notes: "Closure accepted.",
    });

    const acceptedState = runtime.task.getState(sessionId);
    expect(acceptedState.status?.phase).toBe("done");
    expect(acceptedState.status?.reason).toBe("acceptance_accepted");
    expect(acceptedState.acceptance?.status).toBe("accepted");
  });

  test("rejects acceptance writes when the task does not require explicit acceptance", () => {
    const workspace = createTestWorkspace("task-ledger-acceptance-disabled");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-ledger-acceptance-disabled";

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Close without a separate acceptance lane",
    });

    expect(
      runtime.task.recordAcceptance(sessionId, {
        status: "accepted",
        decidedBy: "operator",
      }),
    ).toEqual({
      ok: false,
      error: "acceptance_not_enabled",
    });
    expect(runtime.task.getState(sessionId).acceptance).toBeUndefined();
  });
});
