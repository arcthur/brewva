import { describe, expect, test } from "bun:test";
import {
  createBrewvaHostPluginRunner,
  type BrewvaHostCommandContext,
  type BrewvaHostContext,
} from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";

function createHostContext(): BrewvaHostContext {
  return {
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: () => undefined,
      onTerminalInput: () => () => undefined,
      setStatus: () => undefined,
      setWorkingMessage: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: async () => undefined as never,
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => "",
      editor: async () => undefined,
      setEditorComponent: () => undefined,
      theme: {},
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    },
    hasUI: true,
    cwd: "/tmp/workspace",
    sessionManager: {
      getSessionId: () => "session-1",
      getLeafId: () => "leaf-1",
    },
    modelRegistry: undefined,
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "base-system-prompt",
  };
}

function createCommandContext(): BrewvaHostCommandContext {
  const base = createHostContext();
  return {
    ...base,
    waitForIdle: async () => undefined,
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => undefined,
  };
}

describe("substrate host plugin runner", () => {
  test("initializes plugins, tracks registrations, and forwards registration callbacks", async () => {
    const registeredTools: string[] = [];
    const registeredCommands: string[] = [];

    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        (api) => {
          api.registerTool({
            name: "demo_tool",
            label: "Demo",
            description: "Demo tool",
            parameters: Type.Object({ value: Type.String() }),
            async execute() {
              return { content: [{ type: "text", text: "ok" }], details: {} };
            },
          });
          api.registerCommand("demo", {
            description: "Demo command",
            async handler() {
              return undefined;
            },
          });
        },
      ],
      actions: {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        refreshTools: () => undefined,
      },
      registrations: {
        registerTool(tool) {
          registeredTools.push(tool.name);
        },
        registerCommand(name) {
          registeredCommands.push(name);
        },
      },
    });

    expect(runner.getRegisteredTools().map((tool) => tool.name)).toEqual(["demo_tool"]);
    expect([...runner.getRegisteredCommands().keys()]).toEqual(["demo"]);
    expect(registeredTools).toEqual(["demo_tool"]);
    expect(registeredCommands).toEqual(["demo"]);
  });

  test("chains input transforms and short-circuits handled results", async () => {
    const seenInputs: string[] = [];
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        (api) => {
          api.on("input", async (event) => ({
            action: "transform" as const,
            text: `one:${event.text}`,
            images: event.images,
          }));
        },
        (api) => {
          api.on("input", async (event) => {
            seenInputs.push(event.text);
            return {
              action: "handled" as const,
            };
          });
        },
      ],
      actions: {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        refreshTools: () => undefined,
      },
    });

    const result = await runner.emitInput(
      {
        type: "input",
        text: "hello",
        source: "interactive",
      },
      createHostContext(),
    );

    expect(result).toEqual({ action: "handled" });
    expect(seenInputs).toEqual(["one:hello"]);
  });

  test("chains context and provider request transforms in Brewva-owned order", async () => {
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        (api) => {
          api.on("context", async (event) => ({
            messages: [...event.messages, { role: "custom", value: "a" }],
          }));
          api.on("before_provider_request", async (event) => ({
            ...(event.payload as Record<string, unknown>),
            stepA: true,
          }));
        },
        (api) => {
          api.on("context", async (event) => ({
            messages: [...event.messages, { role: "custom", value: "b" }],
          }));
          api.on("before_provider_request", async (event) => ({
            ...(event.payload as Record<string, unknown>),
            stepB: true,
          }));
        },
      ],
      actions: {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        refreshTools: () => undefined,
      },
    });

    const messages = await runner.emitContext(
      { type: "context", messages: [{ role: "user", value: "root" }] },
      createHostContext(),
    );
    const payload = await runner.emitBeforeProviderRequest(
      { type: "before_provider_request", payload: { base: true } },
      createHostContext(),
    );

    expect(messages).toEqual([
      { role: "user", value: "root" },
      { role: "custom", value: "a" },
      { role: "custom", value: "b" },
    ]);
    expect(payload).toEqual({ base: true, stepA: true, stepB: true });
  });

  test("collects before-agent-start messages and keeps the latest system prompt override", async () => {
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        (api) => {
          api.on("before_agent_start", async () => ({
            message: {
              customType: "note",
              content: "alpha",
            },
            systemPrompt: "system-a",
          }));
        },
        (api) => {
          api.on("before_agent_start", async () => ({
            message: {
              customType: "note",
              content: "beta",
            },
            systemPrompt: "system-b",
          }));
        },
      ],
      actions: {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        refreshTools: () => undefined,
      },
    });

    const result = await runner.emitBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: "ship it",
        systemPrompt: "base",
      },
      createHostContext(),
    );

    expect(result).toEqual({
      messages: [
        { customType: "note", content: "alpha" },
        { customType: "note", content: "beta" },
      ],
      systemPrompt: "system-b",
    });
  });

  test("short-circuits blocked tool calls and chains tool-result rewrites", async () => {
    const toolCallOrder: string[] = [];

    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        (api) => {
          api.on("tool_call", async () => {
            toolCallOrder.push("first");
            return { block: true, reason: "blocked" };
          });
          api.on("tool_result", async (event) => ({
            content: [
              {
                type: "text" as const,
                text: `first:${event.content[0]?.type === "text" ? event.content[0].text : ""}`,
              },
            ],
          }));
        },
        (api) => {
          api.on("tool_call", async () => {
            toolCallOrder.push("second");
            return { block: false };
          });
          api.on("tool_result", async (event) => ({
            content: [
              {
                type: "text" as const,
                text: `second:${event.content[0]?.type === "text" ? event.content[0].text : ""}`,
              },
            ],
            isError: true,
          }));
        },
      ],
      actions: {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        refreshTools: () => undefined,
      },
    });

    const toolCallResult = await runner.emitToolCall(
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "exec",
        input: { command: "echo hi" },
      },
      createHostContext(),
    );

    const toolResult = await runner.emitToolResult(
      {
        type: "tool_result",
        toolCallId: "call-1",
        toolName: "exec",
        input: { command: "echo hi" },
        content: [{ type: "text", text: "root" }],
        isError: false,
      },
      createHostContext(),
    );

    expect(toolCallResult).toEqual({ block: true, reason: "blocked" });
    expect(toolCallOrder).toEqual(["first"]);
    expect(toolResult).toEqual({
      content: [{ type: "text", text: "second:first:root" }],
      details: undefined,
      isError: true,
    });
  });

  test("forwards command-side messaging actions through the action port", async () => {
    const sentUsers: Array<{
      content: string | { type: "text"; text: string }[];
      deliverAs?: string;
    }> = [];

    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        (api) => {
          api.registerCommand("queue-demo", {
            async handler(_args, _ctx) {
              api.sendUserMessage("queued", { deliverAs: "followUp" });
            },
          });
        },
      ],
      actions: {
        sendMessage: () => undefined,
        sendUserMessage(content, options) {
          sentUsers.push({ content, deliverAs: options?.deliverAs });
        },
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        refreshTools: () => undefined,
      },
    });

    const command = runner.getRegisteredCommands().get("queue-demo");
    expect(command).toBeDefined();
    await command?.handler("", createCommandContext());

    expect(sentUsers).toEqual([{ content: "queued", deliverAs: "followUp" }]);
  });
});
