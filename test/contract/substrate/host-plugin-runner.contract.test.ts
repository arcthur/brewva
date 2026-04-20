import { describe, expect, test } from "bun:test";
import {
  createBrewvaHostPluginRunner,
  defineInternalHostPlugin,
  type BrewvaHostCommandContext,
  type BrewvaHostContext,
  type BrewvaPromptContentPart,
  type InternalHostPlugin,
  type RuntimePluginCapability,
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
      setTheme: () => ({ success: false, error: "unsupported" }),
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

function textPrompt(text: string): BrewvaPromptContentPart[] {
  return [{ type: "text", text }];
}

type CapabilityViolation = {
  pluginName: string;
  capability: RuntimePluginCapability;
  operation: string;
  event?: string;
};

function testPlugin(
  name: string,
  capabilities: readonly RuntimePluginCapability[],
  register: InternalHostPlugin["register"],
): InternalHostPlugin {
  return defineInternalHostPlugin({
    name,
    capabilities,
    register,
  });
}

describe("substrate host plugin runner", () => {
  test("initializes manifest plugins, tracks registrations, and forwards callbacks", async () => {
    const registeredTools: string[] = [];
    const registeredCommands: string[] = [];

    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        testPlugin("registration-plugin", ["tool_registration.write"], (api) => {
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
        }),
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
        testPlugin("input-transform-plugin", ["input_parts.write"], (api) => {
          api.on("input", async (event) => ({
            action: "transform" as const,
            parts: textPrompt(`one:${event.text}`),
          }));
        }),
        testPlugin("input-handle-plugin", ["turn_input.handle"], (api) => {
          api.on("input", async (event) => {
            seenInputs.push(event.text);
            return { action: "handled" as const };
          });
        }),
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
        parts: textPrompt("hello"),
        source: "interactive",
      },
      createHostContext(),
    );

    expect(result).toEqual({ action: "handled" });
    expect(seenInputs).toEqual(["one:hello"]);
  });

  test("chains structured prompt parts through input transforms without flattening file references", async () => {
    const seenParts: BrewvaPromptContentPart[][] = [];
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        testPlugin("structured-input-transform-plugin", ["input_parts.write"], (api) => {
          api.on("input", async (event) => ({
            action: "transform" as const,
            parts: [
              ...textPrompt("review carefully "),
              ...event.parts.filter(
                (part): part is Extract<BrewvaPromptContentPart, { type: "file" }> =>
                  part.type === "file",
              ),
            ],
          }));
        }),
        testPlugin("structured-input-handle-plugin", ["turn_input.handle"], (api) => {
          api.on("input", async (event) => {
            seenParts.push(event.parts);
            return { action: "handled" as const };
          });
        }),
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
        text: "review @packages/",
        parts: [
          { type: "text", text: "review " },
          {
            type: "file",
            uri: "file:///tmp/workspace/packages",
            displayText: "@packages/",
            name: "packages",
          },
        ],
        source: "interactive",
      },
      createHostContext(),
    );

    expect(result).toEqual({ action: "handled" });
    expect(seenParts).toEqual([
      [
        { type: "text", text: "review carefully " },
        {
          type: "file",
          uri: "file:///tmp/workspace/packages",
          displayText: "@packages/",
          name: "packages",
        },
      ],
    ]);
  });

  test("chains context and provider request transforms in Brewva-owned order", async () => {
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        testPlugin(
          "context-provider-plugin-a",
          ["context_messages.write", "provider_payload.write"],
          (api) => {
            api.on("context", async (event) => ({
              messages: [...event.messages, { role: "custom", value: "a" }],
            }));
            api.on("before_provider_request", async (event) => ({
              ...(event.payload as Record<string, unknown>),
              stepA: true,
            }));
          },
        ),
        testPlugin(
          "context-provider-plugin-b",
          ["context_messages.write", "provider_payload.write"],
          (api) => {
            api.on("context", async (event) => ({
              messages: [...event.messages, { role: "custom", value: "b" }],
            }));
            api.on("before_provider_request", async (event) => ({
              ...(event.payload as Record<string, unknown>),
              stepB: true,
            }));
          },
        ),
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
        testPlugin(
          "before-agent-start-plugin-a",
          ["context_messages.write", "system_prompt.write"],
          (api) => {
            api.on("before_agent_start", async () => ({
              message: { customType: "note", content: "alpha" },
              systemPrompt: "system-a",
            }));
          },
        ),
        testPlugin(
          "before-agent-start-plugin-b",
          ["context_messages.write", "system_prompt.write"],
          (api) => {
            api.on("before_agent_start", async () => ({
              message: { customType: "note", content: "beta" },
              systemPrompt: "system-b",
            }));
          },
        ),
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
        parts: textPrompt("ship it"),
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

  test("fails closed when a manifest plugin writes system prompt without capability", async () => {
    const violations: CapabilityViolation[] = [];
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        testPlugin("bad-system-prompt-plugin", [], (api) => {
          api.on("before_agent_start", async () => ({
            systemPrompt: "rewritten",
          }));
        }),
      ],
      actions: {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        refreshTools: () => undefined,
        recordPluginCapabilityViolation(violation) {
          violations.push(violation);
        },
      },
    });

    let thrown: unknown;
    try {
      await runner.emitBeforeAgentStart(
        {
          type: "before_agent_start",
          prompt: "ship it",
          parts: textPrompt("ship it"),
          systemPrompt: "base",
        },
        createHostContext(),
      );
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain("system_prompt.write");
    expect(violations).toEqual([
      {
        pluginName: "bad-system-prompt-plugin",
        capability: "system_prompt.write",
        operation: "before_agent_start.systemPrompt",
        event: "before_agent_start",
      },
    ]);
  });

  test("allows manifest plugin system prompt writes when capability is declared", async () => {
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        testPlugin("system-prompt-plugin", ["system_prompt.write"], (api) => {
          api.on("before_agent_start", async () => ({
            systemPrompt: "rewritten",
          }));
        }),
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
        parts: textPrompt("ship it"),
        systemPrompt: "base",
      },
      createHostContext(),
    );

    expect(result).toEqual({
      messages: undefined,
      systemPrompt: "rewritten",
    });
  });

  test("short-circuits blocked tool calls and chains tool-result rewrites", async () => {
    const toolCallOrder: string[] = [];
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        testPlugin("tool-call-blocking-plugin", ["tool_call.block", "tool_result.write"], (api) => {
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
        }),
        testPlugin("tool-result-rewrite-plugin", ["tool_result.write"], (api) => {
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
        }),
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

  test("chains message_end transforms when plugins declare visibility capability", async () => {
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        testPlugin("visibility-plugin-a", ["message_visibility.write"], (api) => {
          api.on("message_end", async () => ({
            visibility: {
              display: false,
            },
          }));
        }),
        testPlugin("visibility-plugin-b", ["message_visibility.write"], (api) => {
          api.on("message_end", async (event) => ({
            visibility: {
              details: {
                observedDisplay: event.message.display,
              },
            },
          }));
        }),
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

    const result = await runner.emitMessageEnd(
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Draft output." }],
        },
      },
      createHostContext(),
    );

    expect(result).toEqual({
      visibility: {
        display: false,
        details: {
          observedDisplay: false,
        },
      },
    });
  });

  test("fails closed when a manifest plugin changes message visibility without capability", async () => {
    const violations: CapabilityViolation[] = [];
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        testPlugin("bad-visibility-plugin", [], (api) => {
          api.on("message_end", async () => ({
            visibility: {
              display: false,
            },
          }));
        }),
      ],
      actions: {
        sendMessage: () => undefined,
        sendUserMessage: () => undefined,
        getActiveTools: () => [],
        getAllTools: () => [],
        setActiveTools: () => undefined,
        refreshTools: () => undefined,
        recordPluginCapabilityViolation(violation) {
          violations.push(violation);
        },
      },
    });

    let thrown: unknown;
    try {
      await runner.emitMessageEnd(
        {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Draft output." }],
          },
        },
        createHostContext(),
      );
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain("message_visibility.write");
    expect(violations).toEqual([
      {
        pluginName: "bad-visibility-plugin",
        capability: "message_visibility.write",
        operation: "message_end.visibility",
        event: "message_end",
      },
    ]);
  });

  test("forwards command-side messaging actions through the action port", async () => {
    const sentUsers: Array<{ content: BrewvaPromptContentPart[]; deliverAs?: string }> = [];
    const runner = await createBrewvaHostPluginRunner({
      plugins: [
        testPlugin(
          "command-message-plugin",
          ["tool_registration.write", "user_message.enqueue"],
          (api) => {
            api.registerCommand("queue-demo", {
              async handler() {
                api.sendUserMessage(textPrompt("queued"), { deliverAs: "followUp" });
              },
            });
          },
        ),
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

    expect(sentUsers).toEqual([{ content: textPrompt("queued"), deliverAs: "followUp" }]);
  });
});
