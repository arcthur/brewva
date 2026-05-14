import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInspectCommandExtension } from "@brewva/brewva-cli/extensions";
import type { HostedExtensionApi } from "@brewva/brewva-gateway/extensions";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { requireDefined } from "../../helpers/assertions.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createHostedTestRuntime(options: BrewvaRuntimeOptions) {
  return createBrewvaRuntime(options).hosted;
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

function requireCommand(commands: Map<string, RegisteredCommand>, name: string): RegisteredCommand {
  return requireDefined(commands.get(name), `Expected ${name} command to be registered.`);
}

describe("inspect interactive command extension", () => {
  test("registers inspect and publishes a report notification without mutating runtime event history", async () => {
    const workspace = createTestWorkspace("inspect-command-extension");
    writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(workspace, "other"), { recursive: true });
    writeFileSync(join(workspace, "src", "in-scope.ts"), "export const inScope = 1;\n", "utf8");
    writeFileSync(
      join(workspace, "other", "out-of-scope.ts"),
      "export const outOfScope = 1;\n",
      "utf8",
    );

    const runtime = createHostedTestRuntime({
      cwd: workspace,
      config: structuredClone(DEFAULT_BREWVA_CONFIG),
    });
    const sessionId = "inspect-command-session-1";
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "session_bootstrap",
      payload: {
        managedToolMode: "hosted",
      },
    });
    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    runtime.authority.tools.tracking.markCall(sessionId, "edit");
    runtime.authority.tools.tracking.trackCallStart({
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
    runtime.authority.tools.tracking.trackCallEnd({
      sessionId,
      toolCallId: "edit-1",
      toolName: "edit",
      channelSuccess: true,
    });
    runtime.authority.tools.invocation.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bash -lc 'if then'" },
      outputText: "bash: -c: line 1: syntax error near unexpected token `then'",
      channelSuccess: false,
    });

    const beforeEventCount = runtime.inspect.events.records.query(sessionId).length;
    const { api, commands } = createCommandApiMock();
    await createInspectCommandExtension(runtime, {
      maxNotificationLines: 64,
    }).register(api);

    const inspectCommand = requireCommand(commands, "inspect");

    const notifications: Array<{ message: string; level: string }> = [];
    const ctx = {
      hasUI: true,
      ui: {
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
      },
      sessionManager: {
        getSessionId: () => sessionId,
      },
    };

    await inspectCommand.handler("src", ctx);

    expect(runtime.inspect.events.records.query(sessionId)).toHaveLength(beforeEventCount);
    const rendered = notifications.at(-1)?.message ?? "";
    expect(rendered).toContain("Inspect report for src");
    expect(rendered).toContain("Analysis: directory=src");
    expect(rendered).toContain("code=shell_composition");
    expect(rendered).toContain("code=scope_drift");
    expect(notifications.at(-1)?.level).toBe("warning");
  });
});
