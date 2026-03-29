import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInsightsCommandRuntimePlugin } from "@brewva/brewva-cli";
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

function recordWriteSession(
  runtime: BrewvaRuntime,
  input: {
    workspace: string;
    sessionId: string;
    path: string;
    content: string;
  },
): void {
  runtime.events.record({
    sessionId: input.sessionId,
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
  runtime.context.onTurnStart(input.sessionId, 1);
  runtime.tools.markCall(input.sessionId, "edit");
  runtime.tools.trackCallStart({
    sessionId: input.sessionId,
    toolCallId: `${input.sessionId}-edit-1`,
    toolName: "edit",
    args: { path: input.path },
  });
  writeFileSync(join(input.workspace, input.path), input.content, "utf8");
  runtime.tools.trackCallEnd({
    sessionId: input.sessionId,
    toolCallId: `${input.sessionId}-edit-1`,
    toolName: "edit",
    channelSuccess: true,
  });
}

describe("insights interactive command runtime plugin", () => {
  test("renders aggregated project insights into a widget", async () => {
    const workspace = createTestWorkspace("insights-command-runtime-plugin");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(workspace, "packages", "tool"), { recursive: true });
    writeFileSync(join(workspace, "src", "index.ts"), "export const src = 1;\n", "utf8");
    writeFileSync(
      join(workspace, "packages", "tool", "index.ts"),
      "export const tool = 1;\n",
      "utf8",
    );

    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });

    recordWriteSession(runtime, {
      workspace,
      sessionId: "insights-command-session-1",
      path: "src/index.ts",
      content: "export const src = 2;\n",
    });
    recordWriteSession(runtime, {
      workspace,
      sessionId: "insights-command-session-2",
      path: "packages/tool/index.ts",
      content: "export const tool = 2;\n",
    });

    const { api, commands } = createCommandApiMock();
    await createInsightsCommandRuntimePlugin(runtime)(api);

    const command = requireDefined(
      commands.get("insights"),
      "expected insights command registration",
    );

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
    };

    await command.handler(".", ctx);

    expect(widgets.length).toBeGreaterThan(0);
    expect(widgets.at(-1)?.id).toBe("brewva-insights");
    expect(widgets.at(-1)?.options?.placement).toBe("belowEditor");
    const rendered = (widgets.at(-1)?.lines ?? []).join("\n");
    expect(rendered).toContain("Brewva Project Insights");
    expect(rendered).toContain("Top directories:");
    expect(rendered).toContain("src: 1 session(s), 1 write(s)");
    expect(rendered).toContain("packages/tool: 1 session(s), 1 write(s)");
    expect(notifications.at(-1)?.message).toContain("Insights updated for .");
  });

  test("supports `/insights clear` by removing the widget", async () => {
    const workspace = createTestWorkspace("insights-command-clear");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });

    const { api, commands } = createCommandApiMock();
    await createInsightsCommandRuntimePlugin(runtime)(api);
    const command = requireDefined(
      commands.get("insights"),
      "expected insights command registration",
    );

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
    };

    await command.handler("clear", ctx);

    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toEqual({
      id: "brewva-insights",
      lines: undefined,
      options: { placement: "belowEditor" },
    });
    expect(notifications).toEqual([{ message: "Insights widget cleared.", level: "info" }]);
  });
});
