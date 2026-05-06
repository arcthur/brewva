import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  BrewvaModelCatalog,
  BrewvaMutableModelCatalog,
  BrewvaProviderAuthStore,
  BrewvaRegisteredModel,
} from "../contracts/provider.js";
import type {
  BrewvaToolContentPart,
  BrewvaToolContext,
  BrewvaToolDefinition,
} from "../contracts/tool.js";
import {
  createBrewvaHostPluginRunner,
  type BrewvaHostPluginRunner,
} from "../host-api/plugin-runner.js";
import {
  type BrewvaHostContext,
  type BrewvaHostCustomMessage,
  type BrewvaHostMessageEnvelope,
  type BrewvaHostMessageVisibilityPatch,
  type BrewvaHostToolInfo,
  type HostCommandPort,
  type HostUIPort,
  type InternalHostPlugin,
  type InternalSessionHostPluginContext,
} from "../host-api/plugin.js";
import type { BrewvaToolUiPort } from "../host-api/ui.js";
import type { BrewvaPromptContentPart } from "../prompt/content.js";
import { buildBrewvaSystemPrompt } from "../prompt/system-prompt.js";
import type { BrewvaProviderCompletionDriver } from "../provider/completion.js";
import {
  createFetchProviderCompletionDriver,
  type CreateFetchProviderCompletionDriverOptions,
} from "../provider/fetch-provider-driver.js";
import { createInMemoryModelCatalog } from "../provider/model-catalog.js";
import {
  createHostedResourceLoader,
  type BrewvaHostedResourceLoader,
} from "../resources/resource-loader.js";
import {
  createInMemorySessionHost,
  type BrewvaSessionHost,
  type CreateInMemorySessionHostOptions,
} from "../session/session-host.js";
import {
  createBrewvaTurnLoopController,
  type BrewvaTurnLoopController,
  type BrewvaTurnLoopMessage,
  type BrewvaTurnLoopStreamFunction,
  type BrewvaTurnLoopThinkingBudgets,
  type BrewvaTurnLoopThinkingLevel,
  type BrewvaTurnLoopToolResult,
  type BrewvaTurnLoopTool,
  type BrewvaTurnLoopTransport,
  createBrewvaTurnProviderStreamFunction,
} from "../turn/index.js";

export interface BrewvaSubstrateDiagnostic {
  type: "info" | "warning" | "error";
  message: string;
  source?: BrewvaSubstrateDiagnosticSource;
  cause?: unknown;
}

export type BrewvaSubstrateDiagnosticSource =
  | {
      domain: "resources";
      kind: "loader" | "skill" | "prompt" | "extension";
      path?: string;
    }
  | {
      domain: "provider";
      kind: "model";
      provider?: string;
      id?: string;
    }
  | {
      domain: "host-api";
      kind: "runtime-plugin";
      pluginName?: string;
      capability?: string;
      operation?: string;
    }
  | {
      domain: "sdk";
      kind: "compaction" | "session";
      sessionId?: string;
    };

export interface BrewvaSessionServicesOptions {
  cwd?: string;
  agentDir?: string;
  models?: readonly BrewvaRegisteredModel[];
  auth?: BrewvaProviderAuthStore;
  modelCatalog?: BrewvaMutableModelCatalog;
  resourceLoader?: BrewvaHostedResourceLoader;
  providerDriver?: BrewvaProviderCompletionDriver;
  runtimePlugins?: readonly InternalHostPlugin[];
  fetchImpl?: CreateFetchProviderCompletionDriverOptions["fetchImpl"];
  maxOutputTokens?: number;
}

export interface BrewvaSessionServices {
  cwd: string;
  agentDir: string;
  modelCatalog: BrewvaMutableModelCatalog;
  resourceLoader: BrewvaHostedResourceLoader;
  providerDriver: BrewvaProviderCompletionDriver;
  runtimePlugins: readonly InternalHostPlugin[];
  diagnostics: readonly BrewvaSubstrateDiagnostic[];
}

export type BrewvaSessionModelSelection =
  | BrewvaRegisteredModel
  | {
      provider: string;
      id: string;
    };

export interface BrewvaSessionFromServicesOptions {
  services: BrewvaSessionServices;
  model?: BrewvaSessionModelSelection;
  thinkingLevel?: BrewvaTurnLoopThinkingLevel;
  tools?: readonly BrewvaToolDefinition[];
  activeToolNames?: readonly string[];
  runtimePlugins?: readonly InternalHostPlugin[];
  sessionHost?: BrewvaSessionHost;
  sessionHostPlugins?: CreateInMemorySessionHostOptions["plugins"];
  streamFn?: BrewvaTurnLoopStreamFunction;
  systemPrompt?: string;
  sessionId?: string;
  queueMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  transport?: BrewvaTurnLoopTransport;
  thinkingBudgets?: BrewvaTurnLoopThinkingBudgets;
  maxRetryDelayMs?: number;
}

export interface BrewvaInMemoryAgentSession {
  services: BrewvaSessionServices;
  sessionHost: BrewvaSessionHost;
  turnLoop: BrewvaTurnLoopController;
  pluginRunner: BrewvaHostPluginRunner;
  diagnostics: readonly BrewvaSubstrateDiagnostic[];
}

export type BrewvaInMemoryAgentSessionOptions = Omit<
  BrewvaSessionServicesOptions & Omit<BrewvaSessionFromServicesOptions, "services">,
  "modelCatalog" | "resourceLoader" | "providerDriver"
> & {
  modelCatalog?: BrewvaMutableModelCatalog;
  resourceLoader?: BrewvaHostedResourceLoader;
  providerDriver?: BrewvaProviderCompletionDriver;
};

type MutableSdkState = {
  toolDefinitions: BrewvaToolDefinition[];
  activeToolNames: Set<string> | undefined;
  turnLoop: BrewvaTurnLoopController | undefined;
  diagnostics: BrewvaSubstrateDiagnostic[];
};

const TURN_LOOP_MESSAGE_ROLES = new Set([
  "user",
  "assistant",
  "toolResult",
  "custom",
  "branchSummary",
  "compactionSummary",
]);

function defaultAgentDir(): string {
  return join(homedir(), ".brewva-agent");
}

function cloneDiagnostics(
  diagnostics: readonly BrewvaSubstrateDiagnostic[],
): BrewvaSubstrateDiagnostic[] {
  return diagnostics.map((diagnostic) => ({ ...diagnostic }));
}

function collectResourceDiagnostics(
  resourceLoader: BrewvaHostedResourceLoader,
): BrewvaSubstrateDiagnostic[] {
  const diagnostics: BrewvaSubstrateDiagnostic[] = [];
  for (const diagnostic of resourceLoader.getSkills().diagnostics) {
    diagnostics.push({
      type: "warning",
      message: diagnostic.message,
      source: {
        domain: "resources",
        kind: "skill",
        path: diagnostic.path,
      },
    });
  }
  for (const diagnostic of resourceLoader.getPrompts().diagnostics) {
    diagnostics.push({
      type: "warning",
      message: diagnostic.message,
      source: {
        domain: "resources",
        kind: "prompt",
        path: diagnostic.path,
      },
    });
  }
  for (const diagnostic of resourceLoader.getExtensions().errors) {
    diagnostics.push({
      type: "warning",
      message: diagnostic.error,
      source: {
        domain: "resources",
        kind: "extension",
        path: diagnostic.path,
      },
    });
  }
  return diagnostics;
}

function isRegisteredModel(input: BrewvaSessionModelSelection): input is BrewvaRegisteredModel {
  return "api" in input && "baseUrl" in input;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTurnLoopMessage(value: unknown): value is BrewvaTurnLoopMessage {
  return (
    isObjectRecord(value) &&
    typeof value.role === "string" &&
    TURN_LOOP_MESSAGE_ROLES.has(value.role)
  );
}

function assertTurnLoopMessages(messages: unknown[]): BrewvaTurnLoopMessage[] {
  if (messages.every(isTurnLoopMessage)) {
    return messages;
  }
  throw new Error("Runtime plugin context transform returned a non-turn-loop message.");
}

function applyMessageVisibilityPatch(
  message: BrewvaTurnLoopMessage,
  visibility: BrewvaHostMessageVisibilityPatch,
): BrewvaTurnLoopMessage {
  return {
    ...message,
    ...(visibility.display !== undefined ? { display: visibility.display } : {}),
    ...(visibility.excludeFromContext !== undefined
      ? { excludeFromContext: visibility.excludeFromContext }
      : {}),
    ...(visibility.details !== undefined ? { details: visibility.details } : {}),
  };
}

async function resolveInitialModel(
  input: BrewvaSessionModelSelection | undefined,
  modelCatalog: BrewvaModelCatalog,
): Promise<{
  model: BrewvaRegisteredModel | undefined;
  diagnostics: BrewvaSubstrateDiagnostic[];
}> {
  if (!input) {
    const [available] = await modelCatalog.getAvailable();
    if (available) {
      return { model: available, diagnostics: [] };
    }
    const [first] = modelCatalog.getAll();
    if (first) {
      return {
        model: first,
        diagnostics: [
          {
            type: "warning",
            message: `Model "${first.provider}/${first.id}" is registered but has no configured auth.`,
            source: {
              domain: "provider",
              kind: "model",
              provider: first.provider,
              id: first.id,
            },
          },
        ],
      };
    }
    return {
      model: undefined,
      diagnostics: [
        {
          type: "error",
          message: "No model is registered in the substrate model catalog.",
          source: {
            domain: "provider",
            kind: "model",
          },
        },
      ],
    };
  }

  if (isRegisteredModel(input)) {
    return { model: input, diagnostics: [] };
  }

  const model = modelCatalog.find(input.provider, input.id);
  if (model) {
    return { model, diagnostics: [] };
  }
  return {
    model: undefined,
    diagnostics: [
      {
        type: "error",
        message: `Model "${input.provider}/${input.id}" is not registered in the substrate model catalog.`,
        source: {
          domain: "provider",
          kind: "model",
          provider: input.provider,
          id: input.id,
        },
      },
    ],
  };
}

const NOOP_UI: BrewvaToolUiPort = {
  async select() {
    return undefined;
  },
  async confirm() {
    return false;
  },
  async input() {
    return undefined;
  },
  notify() {},
  onTerminalInput() {
    return () => {};
  },
  setStatus() {},
  setWorkingMessage() {},
  setHiddenThinkingLabel() {},
  async custom() {
    return undefined as never;
  },
  pasteToEditor() {},
  setEditorText() {},
  getEditorText() {
    return "";
  },
  async editor() {
    return undefined;
  },
  setEditorComponent() {},
  theme: {},
  getAllThemes() {
    return [];
  },
  getTheme() {
    return undefined;
  },
  setTheme() {
    return { success: false, error: "UI unavailable" };
  },
  getToolsExpanded() {
    return true;
  },
  setToolsExpanded() {},
};

const NOOP_COMMANDS: HostCommandPort = {
  interrupt() {},
  newSession() {},
  reloadSession() {},
};

const NOOP_HOST_UI: HostUIPort = {
  setStatus() {},
  notify() {},
};

function createSessionHostPluginContext(): InternalSessionHostPluginContext {
  return {
    commands: NOOP_COMMANDS,
    ui: NOOP_HOST_UI,
  };
}

function toTurnLoopTool(
  tool: BrewvaToolDefinition,
  ctxFactory: () => BrewvaToolContext,
): BrewvaTurnLoopTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    execute: (toolCallId, params, signal, onUpdate) =>
      tool.execute(toolCallId, params, signal, onUpdate, ctxFactory()),
  };
}

function createCustomTurnLoopMessage(message: BrewvaHostCustomMessage): BrewvaTurnLoopMessage {
  return {
    role: "custom",
    customType: message.customType,
    content: message.content,
    display: message.display ?? true,
    details: message.details,
    timestamp: Date.now(),
  };
}

function createUserTurnLoopMessage(
  parts: readonly BrewvaPromptContentPart[],
): BrewvaTurnLoopMessage {
  return {
    role: "user",
    content: parts.map((part) => ({ ...part })),
    timestamp: Date.now(),
  };
}

function getActiveDefinitions(state: MutableSdkState): BrewvaToolDefinition[] {
  if (!state.activeToolNames) {
    return [...state.toolDefinitions];
  }
  return state.toolDefinitions.filter((tool) => state.activeToolNames?.has(tool.name));
}

function buildSystemPrompt(input: {
  cwd: string;
  resourceLoader: BrewvaHostedResourceLoader;
  tools: readonly BrewvaToolDefinition[];
  override?: string;
}): string {
  const appendSystemPrompt = input.resourceLoader.getAppendSystemPrompt().join("\n\n");
  const toolSnippets: Record<string, string> = {};
  for (const tool of input.tools) {
    if (typeof tool.promptSnippet === "string" && tool.promptSnippet.length > 0) {
      toolSnippets[tool.name] = tool.promptSnippet;
    }
  }

  return buildBrewvaSystemPrompt({
    cwd: input.cwd,
    customPrompt: input.override ?? input.resourceLoader.getSystemPrompt(),
    appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt : undefined,
    contextFiles: input.resourceLoader.getAgentsFiles().agentsFiles,
    skills: input.resourceLoader.getSkills().skills,
    selectedTools: input.tools.map((tool) => tool.name),
    toolSnippets,
    promptGuidelines: input.tools.flatMap((tool) => tool.promptGuidelines ?? []),
  });
}

function createToolContext(input: {
  cwd: string;
  sessionId: string;
  state: MutableSdkState;
  modelCatalog: BrewvaModelCatalog;
  getModel(): BrewvaRegisteredModel | undefined;
  getSystemPrompt(): string;
}): BrewvaToolContext {
  return {
    ui: NOOP_UI,
    hasUI: false,
    cwd: input.cwd,
    sessionManager: {
      getSessionId() {
        return input.sessionId;
      },
      getLeafId() {
        return null;
      },
    },
    modelRegistry: input.modelCatalog,
    model: input.getModel(),
    isIdle() {
      return input.state.turnLoop?.state.isStreaming !== true;
    },
    signal: input.state.turnLoop?.signal,
    abort() {
      input.state.turnLoop?.abort();
    },
    hasPendingMessages() {
      return input.state.turnLoop?.hasQueuedMessages() ?? false;
    },
    shutdown() {
      input.state.turnLoop?.abort();
    },
    compact() {
      input.state.diagnostics.push({
        type: "warning",
        message: "Substrate SDK sessions do not own hosted compaction policy.",
        source: {
          domain: "sdk",
          kind: "compaction",
          sessionId: input.sessionId,
        },
      });
    },
    getContextUsage() {
      return undefined;
    },
    getSystemPrompt() {
      return input.getSystemPrompt();
    },
  };
}

function createHostContext(input: {
  cwd: string;
  sessionId: string;
  state: MutableSdkState;
  modelCatalog: BrewvaModelCatalog;
  getModel(): BrewvaRegisteredModel | undefined;
}): BrewvaHostContext {
  return {
    ui: NOOP_UI,
    hasUI: false,
    cwd: input.cwd,
    sessionManager: {
      getSessionId() {
        return input.sessionId;
      },
      getLeafId() {
        return null;
      },
    },
    modelRegistry: input.modelCatalog,
    model: input.getModel(),
    isIdle() {
      return input.state.turnLoop?.state.isStreaming !== true;
    },
    signal: input.state.turnLoop?.signal,
    abort() {
      input.state.turnLoop?.abort();
    },
    hasPendingMessages() {
      return input.state.turnLoop?.hasQueuedMessages() ?? false;
    },
    shutdown() {
      input.state.turnLoop?.abort();
    },
    compact() {
      input.state.diagnostics.push({
        type: "warning",
        message: "Substrate SDK sessions do not own hosted compaction policy.",
        source: {
          domain: "sdk",
          kind: "compaction",
          sessionId: input.sessionId,
        },
      });
    },
    getContextUsage() {
      return undefined;
    },
    getSystemPrompt() {
      return input.state.turnLoop?.state.systemPrompt ?? "";
    },
  };
}

function applyToolsToTurnLoop(input: {
  state: MutableSdkState;
  cwd: string;
  sessionId: string;
  modelCatalog: BrewvaModelCatalog;
  getModel(): BrewvaRegisteredModel | undefined;
  getSystemPrompt(): string;
}): void {
  const turnLoop = input.state.turnLoop;
  if (!turnLoop) {
    return;
  }
  const activeDefinitions = getActiveDefinitions(input.state);
  turnLoop.setTools(
    activeDefinitions.map((tool) =>
      toTurnLoopTool(tool, () =>
        createToolContext({
          cwd: input.cwd,
          sessionId: input.sessionId,
          state: input.state,
          modelCatalog: input.modelCatalog,
          getModel: () => input.getModel(),
          getSystemPrompt: () => input.getSystemPrompt(),
        }),
      ),
    ),
  );
}

function trackTurnLoopModel(
  turnLoop: BrewvaTurnLoopController,
  onSetModel: (model: BrewvaRegisteredModel) => void,
): BrewvaTurnLoopController {
  return {
    get state() {
      return turnLoop.state;
    },
    get signal() {
      return turnLoop.signal;
    },
    subscribe(listener) {
      return turnLoop.subscribe(listener);
    },
    prompt(message) {
      return turnLoop.prompt(message);
    },
    waitForIdle() {
      return turnLoop.waitForIdle();
    },
    setModel(model) {
      onSetModel(model);
      turnLoop.setModel(model);
    },
    setThinkingLevel(level) {
      turnLoop.setThinkingLevel(level);
    },
    replaceMessages(messages) {
      turnLoop.replaceMessages(messages);
    },
    abort() {
      turnLoop.abort();
    },
    setTools(tools) {
      turnLoop.setTools(tools);
    },
    setSystemPrompt(prompt) {
      turnLoop.setSystemPrompt(prompt);
    },
    followUp(message) {
      turnLoop.followUp(message);
    },
    queue(message) {
      turnLoop.queue(message);
    },
    removeQueuedMessage(message, queue) {
      return turnLoop.removeQueuedMessage(message, queue);
    },
    steer(text) {
      return turnLoop.steer(text);
    },
    hasPendingSteer() {
      return turnLoop.hasPendingSteer();
    },
    appendMessage(message) {
      turnLoop.appendMessage(message);
    },
    hasQueuedMessages() {
      return turnLoop.hasQueuedMessages();
    },
  };
}

export async function createBrewvaSessionServices(
  options: BrewvaSessionServicesOptions = {},
): Promise<BrewvaSessionServices> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const agentDir = resolve(options.agentDir ?? defaultAgentDir());
  const diagnostics: BrewvaSubstrateDiagnostic[] = [];

  let resourceLoader = options.resourceLoader;
  if (!resourceLoader) {
    try {
      resourceLoader = await createHostedResourceLoader({
        cwd,
        agentDir,
        runtimePlugins: options.runtimePlugins,
      });
    } catch (error) {
      diagnostics.push({
        type: "error",
        message: "Failed to create hosted resource loader.",
        source: {
          domain: "resources",
          kind: "loader",
        },
        cause: error,
      });
      throw error;
    }
  }
  diagnostics.push(...collectResourceDiagnostics(resourceLoader));

  return {
    cwd,
    agentDir,
    modelCatalog:
      options.modelCatalog ??
      createInMemoryModelCatalog({
        models: options.models,
        auth: options.auth,
      }),
    resourceLoader,
    providerDriver:
      options.providerDriver ??
      createFetchProviderCompletionDriver({
        fetchImpl: options.fetchImpl,
        maxOutputTokens: options.maxOutputTokens,
      }),
    runtimePlugins: options.runtimePlugins ?? [],
    diagnostics,
  };
}

export async function createBrewvaSessionFromServices(
  options: BrewvaSessionFromServicesOptions,
): Promise<BrewvaInMemoryAgentSession> {
  const services = options.services;
  const sessionId = options.sessionId ?? randomUUID();
  const modelResolution = await resolveInitialModel(options.model, services.modelCatalog);
  let currentModel = modelResolution.model;
  const diagnostics = [...cloneDiagnostics(services.diagnostics), ...modelResolution.diagnostics];
  const state: MutableSdkState = {
    toolDefinitions: [...(options.tools ?? [])],
    activeToolNames: options.activeToolNames ? new Set(options.activeToolNames) : undefined,
    turnLoop: undefined,
    diagnostics,
  };
  let currentSystemPrompt = "";
  let pluginRunner: BrewvaHostPluginRunner | undefined;
  let turnIndex = 0;

  const getModel = () => currentModel;
  const getSystemPrompt = () => currentSystemPrompt;
  const createCurrentHostContext = () =>
    createHostContext({
      cwd: services.cwd,
      sessionId,
      state,
      modelCatalog: services.modelCatalog,
      getModel,
    });

  const sessionHost =
    options.sessionHost ??
    createInMemorySessionHost({
      plugins: options.sessionHostPlugins,
      pluginContext: createSessionHostPluginContext(),
    });

  const baseTurnLoop = createBrewvaTurnLoopController({
    initialModel: modelResolution.model,
    initialThinkingLevel: options.thinkingLevel ?? "off",
    queueMode: options.queueMode ?? "one-at-a-time",
    followUpMode: options.followUpMode ?? "one-at-a-time",
    transport: options.transport ?? "sse",
    thinkingBudgets: options.thinkingBudgets,
    maxRetryDelayMs: options.maxRetryDelayMs,
    sessionId,
    cachePolicy: undefined,
    beforeToolCall: async (input) => {
      const runner = pluginRunner;
      if (!runner) {
        return undefined;
      }
      const result = await runner.emitToolCall(
        {
          type: "tool_call",
          toolCallId: input.toolCall.id,
          toolName: input.toolCall.name,
          input: input.args as Record<string, unknown>,
        },
        createCurrentHostContext(),
      );
      return result ? { block: result.block, reason: result.reason } : undefined;
    },
    afterToolCall: async (input) => {
      const runner = pluginRunner;
      if (!runner) {
        return undefined;
      }
      const result = await runner.emitToolResult(
        {
          type: "tool_result",
          toolCallId: input.toolCall.id,
          toolName: input.toolCall.name,
          input: input.args as Record<string, unknown>,
          content: input.result.content as BrewvaToolContentPart[],
          details: input.result.details,
          isError: input.isError,
        },
        createCurrentHostContext(),
      );
      if (!result) {
        return undefined;
      }
      return {
        content: result.content as BrewvaTurnLoopToolResult["content"] | undefined,
        details: result.details,
        isError: result.isError,
      };
    },
    onPayload: async (payload, model, _metadata) => {
      const runner = pluginRunner;
      if (!runner) {
        return payload;
      }
      return runner.emitBeforeProviderRequest(
        {
          type: "before_provider_request",
          payload,
          provider: model.provider,
          api: model.api,
          modelId: model.id,
        },
        createCurrentHostContext(),
      );
    },
    onCacheRender: undefined,
    transformContext: async (messages) => {
      const runner = pluginRunner;
      if (!runner) {
        return messages;
      }
      return assertTurnLoopMessages(
        await runner.emitContext({ type: "context", messages }, createCurrentHostContext()),
      );
    },
    streamFn: options.streamFn ?? createBrewvaTurnProviderStreamFunction(),
    resolveRequestAuth: (model) => services.modelCatalog.getApiKeyAndHeaders(model),
  });
  const turnLoop = trackTurnLoopModel(baseTurnLoop, (model) => {
    currentModel = model;
  });
  state.turnLoop = turnLoop;

  turnLoop.subscribe(async (event) => {
    const runner = pluginRunner;
    if (!runner) {
      return event;
    }
    const ctx = createCurrentHostContext();
    switch (event.type) {
      case "agent_start":
        await runner.emit("agent_start", { type: "agent_start" }, ctx);
        return event;
      case "agent_end":
        await runner.emit("agent_end", { type: "agent_end", messages: event.messages }, ctx);
        return event;
      case "turn_start":
        turnIndex += 1;
        await runner.emit(
          "turn_start",
          { type: "turn_start", turnIndex, timestamp: Date.now() },
          ctx,
        );
        return event;
      case "turn_end":
        await runner.emit(
          "turn_end",
          {
            type: "turn_end",
            turnIndex,
            message: event.message,
            toolResults: event.toolResults,
          },
          ctx,
        );
        return event;
      case "message_start":
        await runner.emit("message_start", { type: "message_start", message: event.message }, ctx);
        return event;
      case "message_update":
        await runner.emit(
          "message_update",
          {
            type: "message_update",
            message: event.message,
            assistantMessageEvent: event.assistantMessageEvent,
          },
          ctx,
        );
        return event;
      case "message_end": {
        const result = await runner.emitMessageEnd(
          { type: "message_end", message: event.message as BrewvaHostMessageEnvelope },
          ctx,
        );
        if (result?.visibility === undefined) {
          return event;
        }
        return {
          ...event,
          message: applyMessageVisibilityPatch(event.message, result.visibility),
        };
      }
      case "tool_execution_start":
        await runner.emit(
          "tool_execution_start",
          {
            type: "tool_execution_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          },
          ctx,
        );
        return event;
      case "tool_execution_update":
        await runner.emit(
          "tool_execution_update",
          {
            type: "tool_execution_update",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
            partialResult: event.partialResult,
          },
          ctx,
        );
        return event;
      case "tool_execution_end":
        await runner.emit(
          "tool_execution_end",
          {
            type: "tool_execution_end",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          },
          ctx,
        );
        return event;
      case "tool_execution_phase_change":
        await runner.emit(
          "tool_execution_phase_change",
          {
            type: "tool_execution_phase_change",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            phase: event.phase,
            previousPhase: event.previousPhase,
            args: event.args,
          },
          ctx,
        );
        return event;
      default:
        return event;
    }
  });

  function refreshToolSurface(): void {
    applyToolsToTurnLoop({
      state,
      cwd: services.cwd,
      sessionId,
      modelCatalog: services.modelCatalog,
      getModel,
      getSystemPrompt,
    });
    currentSystemPrompt = buildSystemPrompt({
      cwd: services.cwd,
      resourceLoader: services.resourceLoader,
      tools: getActiveDefinitions(state),
      override: options.systemPrompt,
    });
    turnLoop.setSystemPrompt(currentSystemPrompt);
  }

  refreshToolSurface();

  pluginRunner = await createBrewvaHostPluginRunner({
    plugins: [...services.runtimePlugins, ...(options.runtimePlugins ?? [])],
    registrations: {
      registerTool(tool) {
        state.toolDefinitions.push(tool);
      },
    },
    actions: {
      sendMessage(message, sendOptions) {
        const turnMessage = createCustomTurnLoopMessage(message);
        switch (sendOptions?.deliverAs) {
          case "followUp":
            turnLoop.followUp(turnMessage);
            return;
          case "transcript":
            turnLoop.appendMessage(turnMessage);
            return;
          case "nextTurn":
          case "queue":
          default:
            turnLoop.queue(turnMessage);
            return;
        }
      },
      sendUserMessage(content, sendOptions) {
        const turnMessage = createUserTurnLoopMessage(content);
        if (sendOptions?.deliverAs === "followUp") {
          turnLoop.followUp(turnMessage);
          return;
        }
        turnLoop.queue(turnMessage);
      },
      getActiveTools() {
        return getActiveDefinitions(state).map((tool) => tool.name);
      },
      getAllTools() {
        return state.toolDefinitions.map((tool) => {
          const info: BrewvaHostToolInfo = {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          };
          if (tool.sourceInfo !== undefined) {
            info.sourceInfo = tool.sourceInfo;
          }
          return info;
        });
      },
      setActiveTools(toolNames) {
        state.activeToolNames = new Set(toolNames);
        refreshToolSurface();
      },
      refreshTools() {
        refreshToolSurface();
      },
      recordPluginCapabilityViolation(input) {
        state.diagnostics.push({
          type: "warning",
          message: `Plugin "${input.pluginName}" attempted ${input.operation} without ${input.capability}.`,
          source: {
            domain: "host-api",
            kind: "runtime-plugin",
            pluginName: input.pluginName,
            capability: input.capability,
            operation: input.operation,
          },
        });
      },
    },
  });

  refreshToolSurface();

  await pluginRunner.emit(
    "session_start",
    { type: "session_start", reason: "startup" },
    createCurrentHostContext(),
  );

  return {
    services,
    sessionHost,
    turnLoop,
    pluginRunner,
    diagnostics: state.diagnostics,
  };
}

export async function createBrewvaInMemoryAgentSession(
  options: BrewvaInMemoryAgentSessionOptions = {},
): Promise<BrewvaInMemoryAgentSession> {
  const services = await createBrewvaSessionServices(options);
  return createBrewvaSessionFromServices({
    services,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    tools: options.tools,
    activeToolNames: options.activeToolNames,
    sessionHost: options.sessionHost,
    sessionHostPlugins: options.sessionHostPlugins,
    streamFn: options.streamFn,
    systemPrompt: options.systemPrompt,
    sessionId: options.sessionId,
    queueMode: options.queueMode,
    followUpMode: options.followUpMode,
    transport: options.transport,
    thinkingBudgets: options.thinkingBudgets,
    maxRetryDelayMs: options.maxRetryDelayMs,
  });
}
