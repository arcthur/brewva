import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInspectCommandRuntimePlugin } from "@brewva/brewva-cli";
import type { RuntimePluginApi } from "@brewva/brewva-gateway/runtime-plugins";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { requireDefined } from "../../helpers/assertions.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void;
};

function createCommandApiMock(): {
  api: RuntimePluginApi;
  commands: Map<string, RegisteredCommand>;
  handlers: Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >;
} {
  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<
    string,
    Array<(event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>
  >();

  const api = {
    on(
      event: string,
      handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown,
    ) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, definition: RegisteredCommand) {
      commands.set(name, definition);
    },
  } as unknown as RuntimePluginApi;

  return { api, commands, handlers };
}

function requireCommand(commands: Map<string, RegisteredCommand>, name: string): RegisteredCommand {
  return requireDefined(commands.get(name), `Expected ${name} command to be registered.`);
}

describe("inspect interactive command runtime plugin", () => {
  test("registers inspect and renders into a widget without mutating runtime event history", async () => {
    const workspace = createTestWorkspace("inspect-command-runtime-plugin");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(workspace, "other"), { recursive: true });
    writeFileSync(join(workspace, "src", "in-scope.ts"), "export const inScope = 1;\n", "utf8");
    writeFileSync(
      join(workspace, "other", "out-of-scope.ts"),
      "export const outOfScope = 1;\n",
      "utf8",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });
    const sessionId = "inspect-command-session-1";
    runtime.events.record({
      sessionId,
      type: "session_bootstrap",
      payload: {
        managedToolMode: "runtime_plugin",
        skillLoad: {
          routingEnabled: false,
          routingScopes: ["core", "domain"],
          routableSkills: [],
          hiddenSkills: [],
        },
      },
    });
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "edit");
    runtime.tools.trackCallStart({
      sessionId,
      toolCallId: "edit-1",
      toolName: "edit",
      args: { path: "other/out-of-scope.ts" },
    });
    writeFileSync(
      join(workspace, "other", "out-of-scope.ts"),
      "export const outOfScope = 2;\n",
      "utf8",
    );
    runtime.tools.trackCallEnd({
      sessionId,
      toolCallId: "edit-1",
      toolName: "edit",
      channelSuccess: true,
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bash -lc 'if then'" },
      outputText: "bash: -c: line 1: syntax error near unexpected token `then'",
      channelSuccess: false,
    });

    const beforeEventCount = runtime.events.query(sessionId).length;
    const { api, commands } = createCommandApiMock();
    await createInspectCommandRuntimePlugin(runtime, {
      maxWidgetLines: 64,
    })(api);

    const inspectCommand = requireCommand(commands, "inspect");

    const widgets: Array<{ id: string; lines?: string[]; options?: Record<string, unknown> }> = [];
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        setWidget(id: string, lines: string[] | undefined, options?: Record<string, unknown>) {
          widgets.push({ id, lines, options });
        },
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    await inspectCommand.handler("src", ctx);

    expect(runtime.events.query(sessionId)).toHaveLength(beforeEventCount);
    expect(widgets.length).toBeGreaterThan(0);
    expect(widgets.at(-1)?.id).toBe("brewva-inspect");
    expect(widgets.at(-1)?.options?.placement).toBe("belowEditor");
    const rendered = (widgets.at(-1)?.lines ?? []).join("\n");
    expect(rendered).toContain("Analysis: directory=src");
    expect(rendered).toContain("code=shell_composition");
    expect(rendered).toContain("code=scope_drift");
    expect(notifications.at(-1)?.message).toContain("Inspect updated for src");
  });

  test("supports `/inspect clear` by removing the widget", async () => {
    const workspace = createTestWorkspace("inspect-command-clear");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });

    const { api, commands } = createCommandApiMock();
    await createInspectCommandRuntimePlugin(runtime)(api);
    const command = requireCommand(commands, "inspect");

    const widgets: Array<{ id: string; lines?: string[]; options?: Record<string, unknown> }> = [];
    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        setWidget(id: string, lines: string[] | undefined, options?: Record<string, unknown>) {
          widgets.push({ id, lines, options });
        },
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionId: () => "inspect-command-clear-session",
      },
    };

    await command.handler("clear", ctx);

    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toEqual({
      id: "brewva-inspect",
      lines: undefined,
      options: { placement: "belowEditor" },
    });
    expect(notifications).toEqual([{ message: "Inspect widget cleared.", level: "info" }]);
  });
});
