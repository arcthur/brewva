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
        files: ["packages/brewva-runtime/src/runtime/runtime.ts"],
      },
      constraints: ["Do not change public CLI flags"],
    };

    runtime.authority.task.setSpec(sessionId, spec);

    const state = runtime.inspect.task.getState(sessionId);
    expect(state.spec?.schema).toBe("brewva.task.v1");
    expect(state.spec?.goal).toBe("Fix failing tests in runtime");
    expect(state.spec?.targets?.files?.[0]).toBe("packages/brewva-runtime/src/runtime/runtime.ts");
    expect(state.spec?.constraints?.[0]).toBe("Do not change public CLI flags");
  });

  test("hydrates from task events without restoring snapshot", async () => {
    const workspace = createTestWorkspace("task-ledger-hydrate");
    const sessionId = "task-2";

    const runtime1 = new BrewvaRuntime({ cwd: workspace });
    runtime1.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Refactor context injection",
    });

    const runtime2 = new BrewvaRuntime({ cwd: workspace });
    const state = runtime2.inspect.task.getState(sessionId);
    expect(state.spec?.goal).toBe("Refactor context injection");
  });

  test("parseTaskSpec accepts command-only verification and rejects removed kernel-owned fields", () => {
    const explicitCommands = parseTaskSpec({
      goal: "Validate implementation",
      verification: {
        commands: ["bun test"],
      },
    });
    expect(explicitCommands).toEqual({
      ok: true,
      spec: {
        schema: "brewva.task.v1",
        goal: "Validate implementation",
        verification: {
          commands: ["bun test"],
        },
      },
    });

    expect(
      parseTaskSpec({
        goal: "Review architecture",
        verification: {},
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
          level: "strict",
          commands: ["review docs only"],
        },
      }),
    ).toEqual({
      ok: false,
      reason:
        "TaskSpec verification.level has been removed. Verification profile is skill-owned; use verification.commands only when you need explicit command checks.",
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
      reason:
        "TaskSpec acceptance.owner has been removed. Acceptance is always operator-owned when enabled.",
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

    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Ensure Bar is wired correctly",
      targets: {
        files: ["src/foo.ts"],
      },
      verification: {
        commands: ["bun test test/quality/docs"],
      },
    });
    runtime.authority.task.addItem(sessionId, {
      text: "Confirm the projected task state uses agent-facing labels",
      status: "todo",
    });

    const injection = await runtime.maintain.context.buildInjection(
      sessionId,
      "Ensure Bar is wired correctly",
    );
    expect(injection.text).toContain("[TaskLedger]");
    expect(injection.text).toContain("targets.files:");
    expect(injection.text).toContain("src/foo.ts");
    expect(injection.text).toContain("verification.commands:");
    expect(injection.text).toContain("- bun test test/quality/docs");
    expect(injection.text).toContain(
      "- [pending] Confirm the projected task state uses agent-facing labels",
    );
    expect(injection.text).not.toContain("[Viewport]");
  });

  test("holds closure at ready_for_acceptance until operator acceptance is recorded", () => {
    const workspace = createTestWorkspace("task-ledger-acceptance");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-ledger-acceptance";

    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Close the task with explicit operator acceptance",
      acceptance: {
        required: true,
        criteria: ["Operator accepts the result as closure."],
      },
    });
    runtime.authority.task.addItem(sessionId, {
      id: "item-1",
      text: "Finish the implementation",
      status: "done",
    });

    const pendingState = runtime.inspect.task.getState(sessionId);
    expect(pendingState.status?.phase).toBe("ready_for_acceptance");
    expect(pendingState.status?.health).toBe("acceptance_pending");
    expect(pendingState.acceptance).toBeUndefined();

    runtime.authority.task.recordAcceptance(sessionId, {
      status: "accepted",
      decidedBy: "operator",
      notes: "Closure accepted.",
    });

    const acceptedState = runtime.inspect.task.getState(sessionId);
    expect(acceptedState.status?.phase).toBe("done");
    expect(acceptedState.status?.reason).toBe("acceptance_accepted");
    expect(acceptedState.acceptance?.status).toBe("accepted");
  });

  test("rejects acceptance writes when the task does not require explicit acceptance", () => {
    const workspace = createTestWorkspace("task-ledger-acceptance-disabled");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "task-ledger-acceptance-disabled";

    runtime.authority.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Close without a separate acceptance lane",
    });

    expect(
      runtime.authority.task.recordAcceptance(sessionId, {
        status: "accepted",
        decidedBy: "operator",
      }),
    ).toEqual({
      ok: false,
      reason: "acceptance_not_enabled",
    });
    expect(runtime.inspect.task.getState(sessionId).acceptance).toBeUndefined();
  });
});
