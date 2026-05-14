import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentOverlaysCommandExtension } from "@brewva/brewva-cli/extensions";
import type { HostedExtensionApi } from "@brewva/brewva-gateway/extensions";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { requireDefined } from "../../helpers/assertions.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: Record<string, unknown>) => Promise<void> | void;
};

function createCommandApiMock(): {
  api: HostedExtensionApi;
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
  } as unknown as HostedExtensionApi;
  return { api, commands };
}

describe("agent-overlays interactive command extension", () => {
  test("renders validation state and authored overlay details", async () => {
    const workspace = createTestWorkspace("agent-overlays-command-extension");
    mkdirSync(join(workspace, ".brewva", "subagents"), { recursive: true });
    writeFileSync(
      join(workspace, ".brewva", "subagents", "reviewer.md"),
      `---
name: reviewer
extends: advisor
description: Reviewer override
---
Keep findings short and concrete.
`,
      "utf8",
    );
    const runtime = createBrewvaRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    }).hosted;

    const { api, commands } = createCommandApiMock();
    await createAgentOverlaysCommandExtension(runtime).register(api);
    const command = requireDefined(
      commands.get("agent-overlays"),
      "expected agent-overlays command registration",
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

    await command.handler("validate", ctx);

    const rendered = notifications.at(-1)?.message ?? "";
    expect(rendered).toContain("Custom subagent validation passed.");
    expect(rendered).toContain("Custom subagents — valid");
    expect(rendered).toContain("reviewer");
    expect(rendered).toContain(".brewva/subagents/reviewer.md");
    expect(notifications.at(-1)?.level).toBe("info");
  });
});
