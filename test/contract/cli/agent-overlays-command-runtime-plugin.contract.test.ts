import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentOverlaysCommandRuntimePlugin } from "@brewva/brewva-cli";
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
} {
  const commands = new Map<string, RegisteredCommand>();
  const api = {
    on() {
      return;
    },
    registerCommand(name: string, definition: RegisteredCommand) {
      commands.set(name, definition);
    },
  } as unknown as RuntimePluginApi;
  return { api, commands };
}

describe("agent-overlays interactive command runtime plugin", () => {
  test("renders validation state and authored overlay details", async () => {
    const workspace = createTestWorkspace("agent-overlays-command-runtime-plugin");
    mkdirSync(join(workspace, ".brewva", "agents"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva", "agents", "reviewer.md"),
      `---
name: reviewer
extends: review
description: Reviewer override
---
Keep findings short and concrete.
`,
      "utf8",
    );
    const runtime = new BrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });

    const { api, commands } = createCommandApiMock();
    await createAgentOverlaysCommandRuntimePlugin(runtime)(api);
    const command = requireDefined(
      commands.get("agent-overlays"),
      "expected agent-overlays command registration",
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

    await command.handler("validate", ctx);

    expect(widgets.at(-1)?.id).toBe("brewva-agent-overlays");
    expect(widgets.at(-1)?.options?.placement).toBe("belowEditor");
    const rendered = (widgets.at(-1)?.lines ?? []).join("\n");
    expect(rendered).toContain("Agent overlays — valid");
    expect(rendered).toContain("reviewer");
    expect(rendered).toContain(".brewva/agents/reviewer.md");
    expect(notifications).toEqual([{ message: "Agent overlay validation passed.", level: "info" }]);
  });
});
