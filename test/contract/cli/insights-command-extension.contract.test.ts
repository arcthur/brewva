import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInsightsCommandExtension } from "@brewva/brewva-cli";
import type { HostedExtensionApi } from "@brewva/brewva-gateway/extensions";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  createOperatorRuntimePort,
  createHostedRuntimePort,
} from "@brewva/brewva-runtime";
import { requireDefined } from "../../helpers/assertions.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createHostedTestRuntime(options: ConstructorParameters<typeof BrewvaRuntime>[0]) {
  return createHostedRuntimePort(new BrewvaRuntime(options));
}

type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void;
};

function createCommandApiMock(): {
  api: HostedExtensionApi;
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
  } as unknown as HostedExtensionApi;

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
  createHostedRuntimePort(runtime).extensions.hosted.events.record({
    sessionId: input.sessionId,
    type: "session_bootstrap",
    payload: {
      managedToolMode: "hosted",
    },
  });
  createOperatorRuntimePort(runtime).operator.context.lifecycle.onTurnStart(input.sessionId, 1);
  runtime.authority.tools.tracking.markCall(input.sessionId, "edit");
  runtime.authority.tools.tracking.trackCallStart({
    sessionId: input.sessionId,
    toolCallId: `${input.sessionId}-edit-1`,
    toolName: "edit",
    args: { path: input.path },
  });
  writeFileSync(join(input.workspace, input.path), input.content, "utf8");
  runtime.authority.tools.tracking.trackCallEnd({
    sessionId: input.sessionId,
    toolCallId: `${input.sessionId}-edit-1`,
    toolName: "edit",
    channelSuccess: true,
  });
}

describe("insights interactive command extension", () => {
  test("publishes aggregated project insights into a notification", async () => {
    const workspace = createTestWorkspace("insights-command-extension");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(workspace, "packages", "tool"), { recursive: true });
    writeFileSync(join(workspace, "src", "index.ts"), "export const src = 1;\n", "utf8");
    writeFileSync(
      join(workspace, "packages", "tool", "index.ts"),
      "export const tool = 1;\n",
      "utf8",
    );

    const runtime = createHostedTestRuntime({
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
    await createInsightsCommandExtension(runtime).register(api);

    const command = requireDefined(
      commands.get("insights"),
      "expected insights command registration",
    );

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
    };

    await command.handler(".", ctx);

    const rendered = notifications.at(-1)?.message ?? "";
    expect(rendered).toContain("Insights report for .");
    expect(rendered).toContain("Brewva Project Insights");
    expect(rendered).toContain("Top directories:");
    expect(rendered).toContain("src: 1 session(s), 1 write(s)");
    expect(rendered).toContain("packages/tool: 1 session(s), 1 write(s)");
    expect(notifications.at(-1)?.level).toBe("info");
  });
});
