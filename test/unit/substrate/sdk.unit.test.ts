import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineInternalHostPlugin } from "@brewva/brewva-substrate/host-api";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import {
  createBrewvaInMemoryAgentSession,
  createBrewvaSessionFromServices,
  createBrewvaSessionServices,
} from "@brewva/brewva-substrate/sdk";
import { defineBrewvaTool } from "@brewva/brewva-substrate/tools";
import type {
  BrewvaTurnLoopAssistantMessage,
  BrewvaTurnLoopAssistantMessageEvent,
  BrewvaTurnLoopStreamFunction,
  BrewvaTurnLoopStreamOptions,
} from "@brewva/brewva-substrate/turn";
import { Type } from "@sinclair/typebox";
import { createTurnEventStream } from "../../helpers/effect-stream.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

const TEST_MODEL: BrewvaRegisteredModel = {
  provider: "openai",
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 8192,
};

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function createAssistantMessage(text: string): BrewvaTurnLoopAssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: TEST_MODEL.api,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createToolCallAssistantMessage(toolName: string): BrewvaTurnLoopAssistantMessage {
  return {
    ...createAssistantMessage(""),
    content: [
      {
        type: "toolCall",
        id: `call-${toolName}`,
        name: toolName,
        arguments: {},
      },
    ],
    stopReason: "toolUse",
  };
}

function createTestStream(text: string): BrewvaTurnLoopStreamFunction {
  return () => {
    const finalMessage = createAssistantMessage(text);
    const events: BrewvaTurnLoopAssistantMessageEvent[] = [
      { type: "start", partial: finalMessage },
      {
        type: "text_delta",
        contentIndex: 0,
        delta: text,
        partial: finalMessage,
      },
      { type: "done", reason: "stop", message: finalMessage },
    ];
    return createTurnEventStream(events);
  };
}

function createSequenceStream(
  messages: readonly BrewvaTurnLoopAssistantMessage[],
  onCall?: (options: BrewvaTurnLoopStreamOptions) => Promise<void> | void,
): BrewvaTurnLoopStreamFunction {
  let index = 0;
  return (_model, _context, options) => {
    // Stream factories are synchronous; tests that need async setup must do it
    // before returning the Effect stream.
    void onCall?.(options);
    const finalMessage =
      messages[Math.min(index, messages.length - 1)] ?? createAssistantMessage("");
    index += 1;
    const doneReason =
      finalMessage.stopReason === "stop" ||
      finalMessage.stopReason === "length" ||
      finalMessage.stopReason === "toolUse"
        ? finalMessage.stopReason
        : "stop";
    const events: BrewvaTurnLoopAssistantMessageEvent[] = [
      { type: "start", partial: finalMessage },
      { type: "done", reason: doneReason, message: finalMessage },
    ];
    return createTurnEventStream(events);
  };
}

describe("substrate sdk", () => {
  test("creates cwd-bound services without constructing a session", async () => {
    const cwd = createTestWorkspace("substrate-sdk-services");
    const agentDir = join(cwd, ".brewva-agent");
    writeFile(
      join(cwd, ".brewva", "prompts", "project-plan.md"),
      `---
description: Project plan
---

Plan from project.
`,
    );

    const services = await createBrewvaSessionServices({
      cwd,
      agentDir,
      models: [TEST_MODEL],
      auth: {
        async getApiKey() {
          return "test-key";
        },
        hasAuth() {
          return true;
        },
      },
    });

    expect(services.cwd).toBe(cwd);
    expect(services.agentDir).toBe(agentDir);
    expect(services.modelCatalog.find("openai", "gpt-5.4-mini")?.id).toBe("gpt-5.4-mini");
    expect(services.resourceLoader.getPrompts().prompts.map((prompt) => prompt.name)).toEqual([
      "project-plan",
    ]);
    expect(services.diagnostics).toEqual([]);
  });

  test("surfaces recoverable resource diagnostics during service creation", async () => {
    const cwd = createTestWorkspace("substrate-sdk-resource-diagnostics");
    const agentDir = join(cwd, ".brewva-agent");
    const configPath = join(cwd, ".brewva", "brewva.json");
    writeFile(configPath, "{ invalid json");

    const services = await createBrewvaSessionServices({
      cwd,
      agentDir,
      models: [TEST_MODEL],
    });

    expect(services.diagnostics).toContainEqual(
      expect.objectContaining({
        type: "warning",
        source: {
          domain: "resources",
          kind: "skill",
          path: configPath,
        },
      }),
    );
  });

  test("creates a runnable in-memory session from existing services", async () => {
    const cwd = createTestWorkspace("substrate-sdk-session");
    const agentDir = join(cwd, ".brewva-agent");
    const services = await createBrewvaSessionServices({
      cwd,
      agentDir,
      models: [TEST_MODEL],
      auth: {
        async getApiKey() {
          return "test-key";
        },
        hasAuth() {
          return true;
        },
      },
    });
    const inspectTool = defineBrewvaTool({
      name: "inspect",
      label: "Inspect",
      description: "Inspect test state",
      parameters: Type.Object({}),
      async execute() {
        return {
          content: [{ type: "text", text: "inspected" }],
          details: { ok: true },
        };
      },
    });

    const session = await createBrewvaSessionFromServices({
      services,
      model: { provider: "openai", id: "gpt-5.4-mini" },
      thinkingLevel: "off",
      tools: [inspectTool],
      streamFn: createTestStream("done"),
    });

    expect(session.turnLoop.state.model).toEqual({ provider: "openai", id: "gpt-5.4-mini" });
    expect(session.turnLoop.state.tools).toEqual([{ name: "inspect" }]);
    expect(session.sessionHost.getPhase()).toEqual({ kind: "idle" });
    expect(session.diagnostics).toEqual([]);

    const events: string[] = [];
    session.turnLoop.subscribe((event) => {
      events.push(event.type);
    });

    await session.turnLoop.prompt({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    expect(events).toContain("agent_start");
    expect(events).toContain("agent_end");
  });

  test("includes plugin-registered tools in the initial turn-loop tool surface", async () => {
    const cwd = createTestWorkspace("substrate-sdk-plugin-tools");
    const session = await createBrewvaInMemoryAgentSession({
      cwd,
      agentDir: join(cwd, ".brewva-agent"),
      models: [TEST_MODEL],
      model: TEST_MODEL,
      thinkingLevel: "off",
      streamFn: createTestStream("ok"),
      runtimePlugins: [
        defineInternalHostPlugin({
          name: "register-test-tool",
          capabilities: ["tool_registration.write"],
          register(api) {
            api.registerTool(
              defineBrewvaTool({
                name: "from_plugin",
                label: "From Plugin",
                description: "Registered by a plugin",
                parameters: Type.Object({}),
                async execute() {
                  return {
                    content: [{ type: "text", text: "plugin" }],
                    details: undefined,
                  };
                },
              }),
            );
          },
        }),
      ],
    });

    expect(session.pluginRunner.getRegisteredTools().map((tool) => tool.name)).toEqual([
      "from_plugin",
    ]);
    expect(session.turnLoop.state.tools).toEqual([{ name: "from_plugin" }]);
  });

  test("preserves tool source info through the SDK host tool surface", async () => {
    const cwd = createTestWorkspace("substrate-sdk-tool-source-info");
    let observedTools: unknown[] = [];
    const sourcedTool = defineBrewvaTool({
      name: "sourced",
      label: "Sourced",
      description: "Carries source info",
      parameters: Type.Object({}),
      sourceInfo: {
        path: "sdk:sourced",
        source: "test",
        scope: "sdk",
      },
      async execute() {
        return {
          content: [{ type: "text", text: "ok" }],
          details: undefined,
        };
      },
    });

    await createBrewvaInMemoryAgentSession({
      cwd,
      agentDir: join(cwd, ".brewva-agent"),
      models: [TEST_MODEL],
      model: TEST_MODEL,
      thinkingLevel: "off",
      tools: [sourcedTool],
      streamFn: createTestStream("ok"),
      runtimePlugins: [
        defineInternalHostPlugin({
          name: "observe-tool-source-info",
          capabilities: [],
          register(api) {
            api.on("session_start", () => {
              observedTools = api.getAllTools();
            });
          },
        }),
      ],
    });

    expect(observedTools).toContainEqual(
      expect.objectContaining({
        name: "sourced",
        sourceInfo: {
          path: "sdk:sourced",
          source: "test",
          scope: "sdk",
        },
      }),
    );
  });

  test("forwards turn-loop events and message_end transforms to runtime plugins", async () => {
    const cwd = createTestWorkspace("substrate-sdk-plugin-events");
    const observedPluginEvents: string[] = [];
    const observedSubscriberMessages: unknown[] = [];
    const session = await createBrewvaInMemoryAgentSession({
      cwd,
      agentDir: join(cwd, ".brewva-agent"),
      models: [TEST_MODEL],
      model: TEST_MODEL,
      thinkingLevel: "off",
      streamFn: createTestStream("ok"),
      runtimePlugins: [
        defineInternalHostPlugin({
          name: "observe-turn-loop",
          capabilities: ["message_visibility.write"],
          register(api) {
            api.on("agent_start", () => {
              observedPluginEvents.push("agent_start");
            });
            api.on("turn_start", (event) => {
              observedPluginEvents.push(`turn_start:${event.turnIndex}`);
            });
            api.on("message_end", (event) => {
              observedPluginEvents.push(`message_end:${event.message.role}`);
              if (event.message.role === "assistant") {
                return {
                  visibility: {
                    excludeFromContext: true,
                    details: { plugin: "observe-turn-loop" },
                  },
                };
              }
              return undefined;
            });
            api.on("agent_end", () => {
              observedPluginEvents.push("agent_end");
            });
          },
        }),
      ],
    });

    session.turnLoop.subscribe((event) => {
      if (event.type === "message_end") {
        observedSubscriberMessages.push(event.message);
      }
    });

    await session.turnLoop.prompt({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    expect(observedPluginEvents).toContain("agent_start");
    expect(observedPluginEvents).toContain("turn_start:1");
    expect(observedPluginEvents).toContain("message_end:user");
    expect(observedPluginEvents).toContain("message_end:assistant");
    expect(observedPluginEvents).toContain("agent_end");
    expect(observedSubscriberMessages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        excludeFromContext: true,
        details: { plugin: "observe-turn-loop" },
      }),
    );
  });

  test("passes provider payloads through runtime plugin hooks", async () => {
    const cwd = createTestWorkspace("substrate-sdk-provider-payload");
    let transformedPayload: unknown;
    const session = await createBrewvaInMemoryAgentSession({
      cwd,
      agentDir: join(cwd, ".brewva-agent"),
      models: [TEST_MODEL],
      model: TEST_MODEL,
      thinkingLevel: "off",
      streamFn: createSequenceStream([createAssistantMessage("ok")], async (options) => {
        transformedPayload = await options.onPayload?.({ original: true }, TEST_MODEL);
      }),
      runtimePlugins: [
        defineInternalHostPlugin({
          name: "provider-payload-test",
          capabilities: ["provider_payload.write"],
          register(api) {
            api.on("before_provider_request", (event) => ({
              ...(event.payload as Record<string, unknown>),
              plugin: "provider-payload-test",
            }));
          },
        }),
      ],
    });

    await session.turnLoop.prompt({
      role: "user",
      content: [{ type: "text", text: "hello" }],
      timestamp: Date.now(),
    });

    expect(transformedPayload).toEqual({ original: true, plugin: "provider-payload-test" });
  });

  test("passes tool call and result hooks through runtime plugins", async () => {
    const cwd = createTestWorkspace("substrate-sdk-tool-hooks");
    let executed = false;
    const observedToolResults: unknown[] = [];
    const inspectTool = defineBrewvaTool({
      name: "inspect",
      label: "Inspect",
      description: "Inspect test state",
      parameters: Type.Object({}),
      async execute() {
        executed = true;
        return {
          content: [{ type: "text", text: "raw result" }],
          details: { raw: true },
        };
      },
    });
    const session = await createBrewvaInMemoryAgentSession({
      cwd,
      agentDir: join(cwd, ".brewva-agent"),
      models: [TEST_MODEL],
      model: TEST_MODEL,
      thinkingLevel: "off",
      tools: [inspectTool],
      streamFn: createSequenceStream([
        createToolCallAssistantMessage("inspect"),
        createAssistantMessage("done"),
      ]),
      runtimePlugins: [
        defineInternalHostPlugin({
          name: "tool-result-test",
          capabilities: ["tool_result.write"],
          register(api) {
            api.on("tool_call", (event) => {
              expect(event.toolName).toBe("inspect");
              return undefined;
            });
            api.on("tool_result", () => ({
              content: [{ type: "text" as const, text: "rewritten result" }],
              details: { rewritten: true },
            }));
          },
        }),
      ],
    });

    session.turnLoop.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "toolResult") {
        observedToolResults.push(event.message);
      }
    });

    await session.turnLoop.prompt({
      role: "user",
      content: [{ type: "text", text: "use a tool" }],
      timestamp: Date.now(),
    });

    expect(executed).toBe(true);
    expect(observedToolResults).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        content: [{ type: "text", text: "rewritten result" }],
        details: { rewritten: true },
      }),
    );
  });

  test("lets runtime plugins block tool calls in SDK sessions", async () => {
    const cwd = createTestWorkspace("substrate-sdk-block-tool-call");
    let executed = false;
    const observedToolResults: unknown[] = [];
    const blockedTool = defineBrewvaTool({
      name: "blocked",
      label: "Blocked",
      description: "Should not execute",
      parameters: Type.Object({}),
      async execute() {
        executed = true;
        return {
          content: [{ type: "text", text: "unexpected" }],
          details: undefined,
        };
      },
    });
    const session = await createBrewvaInMemoryAgentSession({
      cwd,
      agentDir: join(cwd, ".brewva-agent"),
      models: [TEST_MODEL],
      model: TEST_MODEL,
      thinkingLevel: "off",
      tools: [blockedTool],
      streamFn: createSequenceStream([
        createToolCallAssistantMessage("blocked"),
        createAssistantMessage("done"),
      ]),
      runtimePlugins: [
        defineInternalHostPlugin({
          name: "block-tool-call",
          capabilities: ["tool_call.block"],
          register(api) {
            api.on("tool_call", () => ({ block: true, reason: "blocked by plugin" }));
          },
        }),
      ],
    });

    session.turnLoop.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "toolResult") {
        observedToolResults.push(event.message);
      }
    });

    await session.turnLoop.prompt({
      role: "user",
      content: [{ type: "text", text: "use a blocked tool" }],
      timestamp: Date.now(),
    });

    expect(executed).toBe(false);
    expect(observedToolResults).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        content: [{ type: "text", text: "blocked by plugin" }],
        isError: true,
      }),
    );
  });

  test("returns diagnostics instead of throwing for unresolved model selection", async () => {
    const cwd = createTestWorkspace("substrate-sdk-diagnostics");
    const services = await createBrewvaSessionServices({
      cwd,
      agentDir: join(cwd, ".brewva-agent"),
      models: [TEST_MODEL],
    });

    const session = await createBrewvaSessionFromServices({
      services,
      model: { provider: "missing", id: "none" },
      thinkingLevel: "off",
      streamFn: createTestStream("unused"),
    });

    expect(session.turnLoop.state.model).toBeUndefined();
    expect(session.diagnostics).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: 'Model "missing/none" is not registered in the substrate model catalog.',
        source: {
          domain: "provider",
          kind: "model",
          provider: "missing",
          id: "none",
        },
      }),
    );
  });
});
