import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUpdateCommandRuntimePlugin } from "@brewva/brewva-cli";
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
  sentMessages: Array<{ content: string; options?: Record<string, unknown> }>;
} {
  const commands = new Map<string, RegisteredCommand>();
  const sentMessages: Array<{ content: string; options?: Record<string, unknown> }> = [];

  const api = {
    on() {
      return;
    },
    registerCommand(name: string, definition: RegisteredCommand) {
      commands.set(name, definition);
    },
    sendUserMessage(content: string, options?: Record<string, unknown>) {
      sentMessages.push({ content, options });
    },
  } as unknown as RuntimePluginApi;

  return { api, commands, sentMessages };
}

function requireCommand(commands: Map<string, RegisteredCommand>, name: string): RegisteredCommand {
  return requireDefined(commands.get(name), `Expected ${name} command to be registered.`);
}

describe("update interactive command runtime plugin", () => {
  test("queues the changelog-driven update workflow as a user message", async () => {
    const workspace = createTestWorkspace("update-command-runtime-plugin");
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "demo-app" }), "utf8");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });

    const { api, commands, sentMessages } = createCommandApiMock();
    await createUpdateCommandRuntimePlugin(runtime)(api);

    const command = requireCommand(commands, "update");

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      isIdle: () => true,
      ui: {
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
    };

    await command.handler("target=latest", ctx);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.options).toBeUndefined();
    expect(sentMessages[0]?.content).toContain(
      "Run a Brewva update workflow for this environment.",
    );
    expect(sentMessages[0]?.content).toContain("target=latest");
    expect(sentMessages[0]?.content).toContain(
      "Do not claim the update is complete until validation has passed.",
    );
    expect(notifications).toEqual([{ message: "Queued Brewva update workflow.", level: "info" }]);
  });

  test("queues the update workflow as a follow-up when the agent is busy", async () => {
    const workspace = createTestWorkspace("update-command-runtime-plugin-follow-up");
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });

    const { api, commands, sentMessages } = createCommandApiMock();
    await createUpdateCommandRuntimePlugin(runtime)(api);

    const command = requireCommand(commands, "update");

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      isIdle: () => false,
      ui: {
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
    };

    await command.handler("", ctx);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.options).toEqual({ deliverAs: "followUp" });
    expect(notifications).toEqual([
      { message: "Queued Brewva update workflow after the current run.", level: "info" },
    ]);
  });
});
