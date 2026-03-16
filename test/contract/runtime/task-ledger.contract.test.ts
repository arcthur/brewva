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

  test("parseTaskSpec normalizes common verification aliases to canonical task values", () => {
    const inspectionSpec = parseTaskSpec({
      goal: "Review architecture",
      verification: {
        level: "inspection",
        commands: ["review docs only"],
      },
    });
    expect(inspectionSpec).toEqual({
      ok: true,
      spec: {
        schema: "brewva.task.v1",
        goal: "Review architecture",
        verification: {
          commands: ["review docs only"],
        },
      },
    });

    const fullSpec = parseTaskSpec({
      goal: "Validate implementation",
      verification: {
        level: "full",
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
    });

    const injection = await runtime.context.buildInjection(
      sessionId,
      "Ensure Bar is wired correctly",
    );
    expect(injection.text).toContain("[TaskLedger]");
    expect(injection.text).toContain("targets.files:");
    expect(injection.text).toContain("src/foo.ts");
    expect(injection.text).not.toContain("[Viewport]");
  });
});
