import type {
  BrewvaTextContentPart,
  BrewvaToolContentPart,
  BrewvaToolDefinition,
} from "../contracts/tool.js";
import type {
  BrewvaHostBeforeAgentStartEvent,
  BrewvaHostBeforeAgentStartResult,
  BrewvaHostBeforeProviderRequestEvent,
  BrewvaHostContext,
  BrewvaHostContextEvent,
  BrewvaHostCustomMessage,
  BrewvaHostInputEvent,
  BrewvaHostInputEventResult,
  BrewvaHostPluginApi,
  BrewvaHostPluginEventMap,
  BrewvaHostPluginFactory,
  BrewvaHostRegisteredCommand,
  BrewvaHostToolCallEvent,
  BrewvaHostToolCallResult,
  BrewvaHostToolResultEvent,
  BrewvaHostToolResultResult,
} from "./plugin.js";

type PluginHandler<TKey extends keyof BrewvaHostPluginEventMap> = (
  event: BrewvaHostPluginEventMap[TKey],
  ctx: BrewvaHostContext,
) => unknown;

type HandlerRegistry = {
  [TKey in keyof BrewvaHostPluginEventMap]: PluginHandler<TKey>[];
};

export interface BrewvaHostPluginRunnerActionPort {
  sendMessage(
    message: BrewvaHostCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  sendUserMessage(
    content: string | BrewvaTextContentPart[],
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
}

export interface BrewvaHostPluginRunnerRegistrationPort {
  registerTool?(tool: BrewvaToolDefinition): void;
  registerCommand?(name: string, command: BrewvaHostRegisteredCommand): void;
}

export interface CreateBrewvaHostPluginRunnerOptions {
  plugins?: readonly BrewvaHostPluginFactory[];
  actions: BrewvaHostPluginRunnerActionPort;
  registrations?: BrewvaHostPluginRunnerRegistrationPort;
}

export interface BrewvaHostPluginRunner {
  readonly api: BrewvaHostPluginApi;
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

  const api: BrewvaHostPluginApi = {
    on(event, handler) {
      handlers[event].push(handler as PluginHandler<typeof event>);
    },
    registerTool(tool) {
      registeredTools.set(tool.name, tool);
      options.registrations?.registerTool?.(tool);
    },
    registerCommand(name, command) {
      registeredCommands.set(name, command);
      options.registrations?.registerCommand?.(name, command);
    },
    sendMessage(message, sendOptions) {
      options.actions.sendMessage(message, sendOptions);
    },
    sendUserMessage(content, sendOptions) {
      options.actions.sendUserMessage(content, sendOptions);
    },
    getActiveTools() {
      return options.actions.getActiveTools();
    },
    getAllTools() {
      return options.actions.getAllTools();
    },
    setActiveTools(toolNames) {
      options.actions.setActiveTools(toolNames);
    },
    refreshTools() {
      options.actions.refreshTools();
    },
  };

  for (const plugin of options.plugins ?? []) {
    await plugin(api);
  }

  return {
    api,
    hasHandlers(event) {
      return handlers[event].length > 0;
    },
    getHandlers(event) {
      return [...handlers[event]];
    },
    getRegisteredTools() {
      return [...registeredTools.values()];
    },
    getRegisteredCommands() {
      return new Map(registeredCommands);
    },
    async emit(event, payload, ctx) {
      for (const handler of handlers[event]) {
        await handler(payload, ctx);
      }
    },
    async emitContext(payload, ctx) {
      let currentMessages = structuredClone(payload.messages);
      for (const handler of handlers.context) {
        const result = (await handler({ ...payload, messages: currentMessages }, ctx)) as
          | BrewvaHostContextEvent
          | { messages?: unknown[] }
          | undefined;
        if (result && "messages" in result && Array.isArray(result.messages)) {
          currentMessages = result.messages;
        }
      }
      return currentMessages;
    },
    async emitBeforeProviderRequest(payload, ctx) {
      let currentPayload = payload.payload;
      for (const handler of handlers.before_provider_request) {
        const result = await handler({ ...payload, payload: currentPayload }, ctx);
        if (result !== undefined) {
          currentPayload = result;
        }
      }
      return currentPayload;
    },
    async emitBeforeAgentStart(payload, ctx) {
      const messages: BrewvaHostCustomMessage[] = [];
      let currentSystemPrompt = payload.systemPrompt;
      let systemPromptChanged = false;

      for (const handler of handlers.before_agent_start) {
        const result = (await handler({ ...payload, systemPrompt: currentSystemPrompt }, ctx)) as
          | BrewvaHostBeforeAgentStartResult
          | undefined;
        if (!result) {
          continue;
        }
        if (result.message) {
          messages.push(result.message);
        }
        if (result.systemPrompt !== undefined) {
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
      let currentText = payload.text;
      let currentImages = payload.images;

      for (const handler of handlers.input) {
        const result = (await handler(
          { ...payload, text: currentText, images: currentImages },
          ctx,
        )) as BrewvaHostInputEventResult | undefined;
        if (result?.action === "handled") {
          return result;
        }
        if (result?.action === "transform") {
          currentText = result.text;
          currentImages = result.images ?? currentImages;
        }
      }

      if (currentText !== payload.text || currentImages !== payload.images) {
        return { action: "transform", text: currentText, images: currentImages };
      }
      return { action: "continue" };
    },
    async emitToolCall(payload, ctx) {
      let lastResult: BrewvaHostToolCallResult | undefined;
      for (const handler of handlers.tool_call) {
        const result = (await handler(payload, ctx)) as BrewvaHostToolCallResult | undefined;
        if (!result) {
          continue;
        }
        lastResult = result;
        if (result.block) {
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

      for (const handler of handlers.tool_result) {
        const result = (await handler(
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
          currentContent = result.content;
          changed = true;
        }
        if (result.details !== undefined) {
          currentDetails = result.details;
          changed = true;
        }
        if (result.isError !== undefined) {
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
  };
}
