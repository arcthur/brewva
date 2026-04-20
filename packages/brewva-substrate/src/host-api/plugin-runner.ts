import type { BrewvaToolContentPart, BrewvaToolDefinition } from "../contracts/tool.js";
import {
  buildBrewvaPromptText,
  brewvaPromptContentPartsEqual,
  cloneBrewvaPromptContentParts,
  type BrewvaPromptContentPart,
} from "../session/prompt-content.js";
import type {
  BrewvaHostBeforeAgentStartEvent,
  BrewvaHostBeforeAgentStartResult,
  BrewvaHostBeforeProviderRequestEvent,
  BrewvaHostContext,
  BrewvaHostContextEvent,
  BrewvaHostCustomMessage,
  BrewvaHostCustomMessageDelivery,
  BrewvaHostInputEvent,
  BrewvaHostInputEventResult,
  BrewvaHostMessageEndEvent,
  BrewvaHostMessageEndResult,
  BrewvaHostMessageEnvelope,
  BrewvaHostMessageVisibilityPatch,
  BrewvaHostPluginEventMap,
  BrewvaHostRegisteredCommand,
  BrewvaHostToolCallEvent,
  BrewvaHostToolCallResult,
  BrewvaHostToolResultEvent,
  BrewvaHostToolResultResult,
  InternalHostPlugin,
  InternalHostPluginApi,
  RuntimePluginCapability,
} from "./plugin.js";

type PluginHandler<TKey extends keyof BrewvaHostPluginEventMap> = (
  event: BrewvaHostPluginEventMap[TKey],
  ctx: BrewvaHostContext,
) => unknown;

interface PluginHandlerRecord<TKey extends keyof BrewvaHostPluginEventMap> {
  readonly pluginName: string;
  readonly capabilities: ReadonlySet<RuntimePluginCapability>;
  readonly handler: PluginHandler<TKey>;
}

type HandlerRegistry = {
  [TKey in keyof BrewvaHostPluginEventMap]: PluginHandlerRecord<TKey>[];
};

function applyMessageVisibilityPatch(
  message: BrewvaHostMessageEnvelope,
  visibility: BrewvaHostMessageVisibilityPatch,
): BrewvaHostMessageEnvelope {
  return {
    ...message,
    ...(visibility.display !== undefined ? { display: visibility.display } : {}),
    ...(visibility.excludeFromContext !== undefined
      ? { excludeFromContext: visibility.excludeFromContext }
      : {}),
    ...(visibility.details !== undefined ? { details: visibility.details } : {}),
  };
}

function readMessageVisibility(
  message: BrewvaHostMessageEnvelope,
): BrewvaHostMessageVisibilityPatch {
  return {
    ...(message.display !== undefined ? { display: message.display } : {}),
    ...(message.excludeFromContext !== undefined
      ? { excludeFromContext: message.excludeFromContext }
      : {}),
    ...(message.details !== undefined ? { details: message.details } : {}),
  };
}

export interface BrewvaHostPluginRunnerActionPort {
  sendMessage(
    message: BrewvaHostCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: BrewvaHostCustomMessageDelivery },
  ): void;
  sendUserMessage(
    content: BrewvaPromptContentPart[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;
  getActiveTools(): string[];
  getAllTools(): {
    name: string;
    description: string;
    parameters: unknown;
    sourceInfo?: unknown;
  }[];
  setActiveTools(toolNames: string[]): void;
  refreshTools(): void;
  recordPluginCapabilityViolation?(input: {
    pluginName: string;
    capability: RuntimePluginCapability;
    operation: string;
    event?: keyof BrewvaHostPluginEventMap;
  }): void;
}

export interface BrewvaHostPluginRunnerRegistrationPort {
  registerTool?(tool: BrewvaToolDefinition): void;
  registerCommand?(name: string, command: BrewvaHostRegisteredCommand): void;
}

export interface CreateBrewvaHostPluginRunnerOptions {
  plugins?: readonly InternalHostPlugin[];
  actions: BrewvaHostPluginRunnerActionPort;
  registrations?: BrewvaHostPluginRunnerRegistrationPort;
}

export interface BrewvaHostPluginRunner {
  readonly api: InternalHostPluginApi;
  hasHandlers(event: keyof BrewvaHostPluginEventMap): boolean;
  getHandlers<TKey extends keyof BrewvaHostPluginEventMap>(
    event: TKey,
  ): ReadonlyArray<PluginHandler<TKey>>;
  getRegisteredTools(): BrewvaToolDefinition[];
  getRegisteredCommands(): ReadonlyMap<string, BrewvaHostRegisteredCommand>;
  emit<TKey extends keyof BrewvaHostPluginEventMap>(
    event: TKey,
    payload: BrewvaHostPluginEventMap[TKey],
    ctx: BrewvaHostContext,
  ): Promise<void>;
  emitContext(
    payload: BrewvaHostContextEvent,
    ctx: BrewvaHostContext,
  ): Promise<BrewvaHostContextEvent["messages"]>;
  emitBeforeProviderRequest(
    payload: BrewvaHostBeforeProviderRequestEvent,
    ctx: BrewvaHostContext,
  ): Promise<unknown>;
  emitBeforeAgentStart(
    payload: BrewvaHostBeforeAgentStartEvent,
    ctx: BrewvaHostContext,
  ): Promise<{ messages?: BrewvaHostCustomMessage[]; systemPrompt?: string } | undefined>;
  emitInput(
    payload: BrewvaHostInputEvent,
    ctx: BrewvaHostContext,
  ): Promise<BrewvaHostInputEventResult>;
  emitToolCall(
    payload: BrewvaHostToolCallEvent,
    ctx: BrewvaHostContext,
  ): Promise<BrewvaHostToolCallResult | undefined>;
  emitToolResult(
    payload: BrewvaHostToolResultEvent,
    ctx: BrewvaHostContext,
  ): Promise<BrewvaHostToolResultResult | undefined>;
  emitMessageEnd(
    payload: BrewvaHostMessageEndEvent,
    ctx: BrewvaHostContext,
  ): Promise<BrewvaHostMessageEndResult | undefined>;
}

const ALL_RUNTIME_PLUGIN_CAPABILITIES: readonly RuntimePluginCapability[] = [
  "tool_registration.write",
  "tool_surface.write",
  "system_prompt.write",
  "context_messages.write",
  "provider_payload.write",
  "input_parts.write",
  "turn_input.handle",
  "tool_call.block",
  "tool_result.write",
  "message_visibility.write",
  "assistant_message.enqueue",
  "user_message.enqueue",
];

function createCapabilitySet(
  capabilities: readonly RuntimePluginCapability[],
): ReadonlySet<RuntimePluginCapability> {
  return new Set(capabilities);
}

function assertCapability(input: {
  actions: BrewvaHostPluginRunnerActionPort;
  pluginName: string;
  capabilities: ReadonlySet<RuntimePluginCapability>;
  capability: RuntimePluginCapability;
  operation: string;
  event?: keyof BrewvaHostPluginEventMap;
}): void {
  if (input.capabilities.has(input.capability)) {
    return;
  }
  input.actions.recordPluginCapabilityViolation?.({
    pluginName: input.pluginName,
    capability: input.capability,
    operation: input.operation,
    ...(input.event ? { event: input.event } : {}),
  });
  throw new Error(
    `Internal runtime plugin '${input.pluginName}' attempted '${input.operation}' without capability '${input.capability}'`,
  );
}

function assertHandlerCapability<TKey extends keyof BrewvaHostPluginEventMap>(
  actions: BrewvaHostPluginRunnerActionPort,
  record: PluginHandlerRecord<TKey>,
  capability: RuntimePluginCapability,
  operation: string,
  event: TKey,
): void {
  assertCapability({
    actions,
    pluginName: record.pluginName,
    capabilities: record.capabilities,
    capability,
    operation,
    event,
  });
}

function createEmptyHandlerRegistry(): HandlerRegistry {
  return {
    session_start: [],
    session_switch: [],
    session_before_compact: [],
    session_compact: [],
    session_shutdown: [],
    context: [],
    before_provider_request: [],
    before_agent_start: [],
    agent_start: [],
    agent_end: [],
    turn_start: [],
    turn_end: [],
    message_start: [],
    message_update: [],
    message_end: [],
    tool_execution_start: [],
    tool_execution_update: [],
    tool_execution_end: [],
    tool_execution_phase_change: [],
    session_phase_change: [],
    context_state_change: [],
    model_select: [],
    thinking_level_select: [],
    input: [],
    tool_call: [],
    tool_result: [],
  };
}

export async function createBrewvaHostPluginRunner(
  options: CreateBrewvaHostPluginRunnerOptions,
): Promise<BrewvaHostPluginRunner> {
  const handlers = createEmptyHandlerRegistry();
  const registeredTools = new Map<string, BrewvaToolDefinition>();
  const registeredCommands = new Map<string, BrewvaHostRegisteredCommand>();

  function createApiForPlugin(input: {
    pluginName: string;
    capabilities: ReadonlySet<RuntimePluginCapability>;
  }): InternalHostPluginApi {
    return {
      on(event, handler) {
        handlers[event].push({
          pluginName: input.pluginName,
          capabilities: input.capabilities,
          handler: handler as PluginHandler<typeof event>,
        });
      },
      registerTool(tool) {
        assertCapability({
          actions: options.actions,
          pluginName: input.pluginName,
          capabilities: input.capabilities,
          capability: "tool_registration.write",
          operation: "registerTool",
        });
        registeredTools.set(tool.name, tool);
        options.registrations?.registerTool?.(tool);
      },
      registerCommand(name, command) {
        assertCapability({
          actions: options.actions,
          pluginName: input.pluginName,
          capabilities: input.capabilities,
          capability: "tool_registration.write",
          operation: "registerCommand",
        });
        registeredCommands.set(name, command);
        options.registrations?.registerCommand?.(name, command);
      },
      sendMessage(message, sendOptions) {
        assertCapability({
          actions: options.actions,
          pluginName: input.pluginName,
          capabilities: input.capabilities,
          capability: "assistant_message.enqueue",
          operation: "sendMessage",
        });
        options.actions.sendMessage(message, sendOptions);
      },
      sendUserMessage(content, sendOptions) {
        assertCapability({
          actions: options.actions,
          pluginName: input.pluginName,
          capabilities: input.capabilities,
          capability: "user_message.enqueue",
          operation: "sendUserMessage",
        });
        options.actions.sendUserMessage(content, sendOptions);
      },
      getActiveTools() {
        return options.actions.getActiveTools();
      },
      getAllTools() {
        return options.actions.getAllTools();
      },
      setActiveTools(toolNames) {
        assertCapability({
          actions: options.actions,
          pluginName: input.pluginName,
          capabilities: input.capabilities,
          capability: "tool_surface.write",
          operation: "setActiveTools",
        });
        options.actions.setActiveTools(toolNames);
      },
      refreshTools() {
        assertCapability({
          actions: options.actions,
          pluginName: input.pluginName,
          capabilities: input.capabilities,
          capability: "tool_surface.write",
          operation: "refreshTools",
        });
        options.actions.refreshTools();
      },
    };
  }

  const api = createApiForPlugin({
    pluginName: "internal.runner",
    capabilities: createCapabilitySet(ALL_RUNTIME_PLUGIN_CAPABILITIES),
  });

  for (const plugin of options.plugins ?? []) {
    await plugin.register(
      createApiForPlugin({
        pluginName: plugin.name,
        capabilities: createCapabilitySet(plugin.capabilities),
      }),
    );
  }

  return {
    api,
    hasHandlers(event) {
      return handlers[event].length > 0;
    },
    getHandlers(event) {
      return handlers[event].map((record) => record.handler);
    },
    getRegisteredTools() {
      return [...registeredTools.values()];
    },
    getRegisteredCommands() {
      return new Map(registeredCommands);
    },
    async emit(event, payload, ctx) {
      for (const record of handlers[event]) {
        await record.handler(payload, ctx);
      }
    },
    async emitContext(payload, ctx) {
      let currentMessages = structuredClone(payload.messages);
      for (const record of handlers.context) {
        const result = (await record.handler({ ...payload, messages: currentMessages }, ctx)) as
          | BrewvaHostContextEvent
          | { messages?: unknown[] }
          | undefined;
        if (result && "messages" in result && Array.isArray(result.messages)) {
          assertHandlerCapability(
            options.actions,
            record,
            "context_messages.write",
            "context.messages",
            "context",
          );
          currentMessages = result.messages;
        }
      }
      return currentMessages;
    },
    async emitBeforeProviderRequest(payload, ctx) {
      let currentPayload = payload.payload;
      for (const record of handlers.before_provider_request) {
        const result = await record.handler({ ...payload, payload: currentPayload }, ctx);
        if (result !== undefined) {
          assertHandlerCapability(
            options.actions,
            record,
            "provider_payload.write",
            "before_provider_request.payload",
            "before_provider_request",
          );
          currentPayload = result;
        }
      }
      return currentPayload;
    },
    async emitBeforeAgentStart(payload, ctx) {
      const messages: BrewvaHostCustomMessage[] = [];
      let currentSystemPrompt = payload.systemPrompt;
      let systemPromptChanged = false;

      for (const record of handlers.before_agent_start) {
        const result = (await record.handler(
          { ...payload, systemPrompt: currentSystemPrompt },
          ctx,
        )) as BrewvaHostBeforeAgentStartResult | undefined;
        if (!result) {
          continue;
        }
        if (result.message) {
          assertHandlerCapability(
            options.actions,
            record,
            "context_messages.write",
            "before_agent_start.message",
            "before_agent_start",
          );
          messages.push(result.message);
        }
        if (result.systemPrompt !== undefined) {
          assertHandlerCapability(
            options.actions,
            record,
            "system_prompt.write",
            "before_agent_start.systemPrompt",
            "before_agent_start",
          );
          currentSystemPrompt = result.systemPrompt;
          systemPromptChanged = true;
        }
      }

      if (messages.length === 0 && !systemPromptChanged) {
        return undefined;
      }

      return {
        messages: messages.length > 0 ? messages : undefined,
        systemPrompt: systemPromptChanged ? currentSystemPrompt : undefined,
      };
    },
    async emitInput(payload, ctx) {
      let currentParts = cloneBrewvaPromptContentParts(payload.parts);

      for (const record of handlers.input) {
        const result = (await record.handler(
          {
            ...payload,
            parts: currentParts,
            text: buildBrewvaPromptText(currentParts),
          },
          ctx,
        )) as BrewvaHostInputEventResult | undefined;
        if (result?.action === "handled") {
          assertHandlerCapability(
            options.actions,
            record,
            "turn_input.handle",
            "input.handled",
            "input",
          );
          return result;
        }
        if (result?.action === "transform") {
          assertHandlerCapability(
            options.actions,
            record,
            "input_parts.write",
            "input.transform",
            "input",
          );
          currentParts = cloneBrewvaPromptContentParts(result.parts);
        }
      }

      if (!brewvaPromptContentPartsEqual(currentParts, payload.parts)) {
        return { action: "transform", parts: currentParts };
      }
      return { action: "continue" };
    },
    async emitToolCall(payload, ctx) {
      let lastResult: BrewvaHostToolCallResult | undefined;
      for (const record of handlers.tool_call) {
        const result = (await record.handler(payload, ctx)) as BrewvaHostToolCallResult | undefined;
        if (!result) {
          continue;
        }
        lastResult = result;
        if (result.block) {
          assertHandlerCapability(
            options.actions,
            record,
            "tool_call.block",
            "tool_call.block",
            "tool_call",
          );
          return result;
        }
      }
      return lastResult;
    },
    async emitToolResult(payload, ctx) {
      let currentContent: BrewvaToolContentPart[] = payload.content;
      let currentDetails = payload.details;
      let currentIsError = payload.isError;
      let changed = false;

      for (const record of handlers.tool_result) {
        const result = (await record.handler(
          {
            ...payload,
            content: currentContent,
            details: currentDetails,
            isError: currentIsError,
          },
          ctx,
        )) as BrewvaHostToolResultResult | undefined;
        if (!result) {
          continue;
        }
        if (result.content !== undefined) {
          assertHandlerCapability(
            options.actions,
            record,
            "tool_result.write",
            "tool_result.content",
            "tool_result",
          );
          currentContent = result.content;
          changed = true;
        }
        if (result.details !== undefined) {
          assertHandlerCapability(
            options.actions,
            record,
            "tool_result.write",
            "tool_result.details",
            "tool_result",
          );
          currentDetails = result.details;
          changed = true;
        }
        if (result.isError !== undefined) {
          assertHandlerCapability(
            options.actions,
            record,
            "tool_result.write",
            "tool_result.isError",
            "tool_result",
          );
          currentIsError = result.isError;
          changed = true;
        }
      }

      if (!changed) {
        return undefined;
      }

      return {
        content: currentContent,
        details: currentDetails,
        isError: currentIsError,
      };
    },
    async emitMessageEnd(payload, ctx) {
      let currentMessage = payload.message;
      let changed = false;

      for (const record of handlers.message_end) {
        const result = (await record.handler(
          {
            ...payload,
            message: currentMessage,
          },
          ctx,
        )) as BrewvaHostMessageEndResult | undefined;
        if (!result?.visibility) {
          continue;
        }
        assertHandlerCapability(
          options.actions,
          record,
          "message_visibility.write",
          "message_end.visibility",
          "message_end",
        );
        currentMessage = applyMessageVisibilityPatch(currentMessage, result.visibility);
        changed = true;
      }

      return changed ? { visibility: readMessageVisibility(currentMessage) } : undefined;
    },
  };
}
