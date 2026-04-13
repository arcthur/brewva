import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SessionWireFrame } from "@brewva/brewva-runtime";
import {
  DEFAULT_CONTEXT_STATE,
  advanceSessionPhase,
  buildBrewvaSystemPrompt,
  createBrewvaHostPluginRunner,
  expandBrewvaPromptTemplate,
  type BrewvaHostedResourceLoader,
  type BrewvaHostCommandContext,
  type BrewvaHostCustomMessage,
  type BrewvaHostPluginFactory,
  type BrewvaHostPluginRunner,
  type BrewvaManagedPromptSession,
  type BrewvaManagedSessionStore,
  type BrewvaManagedSessionSettingsView,
  type BrewvaMutableModelCatalog,
  type BrewvaCompactionRequest,
  type BrewvaPromptOptions,
  type BrewvaPromptQueueBehavior,
  type BrewvaPromptSessionEvent,
  type BrewvaPromptThinkingLevel,
  type BrewvaRegisteredModel,
  type SessionPhase,
  type SessionPhaseEvent,
  type ContextState,
  type BrewvaSessionModelCatalogView,
  type BrewvaSessionModelDescriptor,
  type BrewvaSessionContext,
  BrewvaTextContentPart,
  BrewvaToolContext,
  BrewvaToolDefinition,
  BrewvaToolResult,
  type BrewvaToolUiPort,
} from "@brewva/brewva-substrate";
import {
  deriveSessionPhaseFromRuntimeFactFrame,
  deriveSessionPhaseFromRuntimeFactHistory,
} from "../session/session-phase-runtime-facts.js";
import {
  createHostedAgentEngine,
  supportsHostedExtendedThinking,
  type BrewvaAgentEngine,
  type BrewvaAgentEngineAfterToolCallContext,
  type BrewvaAgentEngineBeforeToolCallContext,
  type BrewvaAgentEngineEvent,
  type BrewvaAgentEngineImageContent,
  type BrewvaAgentEngineMessage,
  type BrewvaAgentEngineTextContent,
  type BrewvaAgentEngineThinkingBudgets,
  type BrewvaAgentEngineThinkingLevel,
  type BrewvaAgentEngineTool,
  type BrewvaAgentEngineToolResultMessage,
  type BrewvaAgentEngineTransport,
} from "./hosted-agent-engine.js";

export interface BrewvaManagedAgentSessionSettingsPort {
  getQuietStartup(): boolean;
  getSteeringMode(): "all" | "one-at-a-time" | undefined;
  getFollowUpMode(): "all" | "one-at-a-time" | undefined;
  getTransport(): BrewvaAgentEngineTransport;
  getThinkingBudgets(): BrewvaAgentEngineThinkingBudgets | undefined;
  getRetrySettings(): { maxDelayMs: number } | undefined;
  setDefaultModelAndProvider(provider: string, modelId: string): void;
  setDefaultThinkingLevel(thinkingLevel: string): void;
}

export interface CreateBrewvaManagedAgentSessionOptions {
  cwd: string;
  agentDir: string;
  sessionStore: ManagedAgentSessionStore;
  settings: BrewvaManagedAgentSessionSettingsPort;
  modelCatalog: BrewvaMutableModelCatalog;
  resourceLoader: BrewvaHostedResourceLoader;
  runtimePlugins?: readonly BrewvaHostPluginFactory[];
  customTools?: readonly BrewvaToolDefinition[];
  initialModel?: BrewvaRegisteredModel;
  initialThinkingLevel?: BrewvaPromptThinkingLevel;
}

type PendingQueuedItem =
  | { kind: "user"; text: string; images?: BrewvaAgentEngineImageContent[] }
  | { kind: "custom"; message: BrewvaHostCustomMessage };

type ManagedAgentSessionStoreCore = Pick<
  BrewvaManagedSessionStore,
  | "getSessionId"
  | "getLeafId"
  | "getBranch"
  | "buildSessionContext"
  | "appendThinkingLevelChange"
  | "appendModelChange"
  | "appendMessage"
  | "appendCustomMessageEntry"
  | "appendCompaction"
  | "appendBranchSummaryEntry"
  | "branchWithSummary"
>;

export interface ManagedAgentSessionStore extends ManagedAgentSessionStoreCore {
  subscribeSessionWire?(listener: (frame: SessionWireFrame) => void): () => void;
  querySessionWire?(): SessionWireFrame[];
  dispose?(): void;
  readContextState?(): ContextState;
  previewCompaction(
    summary: string,
    tokensBefore: number,
    compactId?: string,
    sourceLeafEntryId?: string | null,
  ): {
    compactId: string;
    sourceLeafEntryId: string | null;
    firstKeptEntryId: string;
    context: BrewvaSessionContext;
    tokensBefore: number;
    summary: string;
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
    return () => undefined;
  },
  setStatus() {},
  setWorkingMessage() {},
  setHiddenThinkingLabel() {},
  setWidget() {},
  setFooter() {},
  setHeader() {},
  setTitle() {},
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

function toAgentTool(
  tool: BrewvaToolDefinition,
  ctxFactory: () => BrewvaToolContext,
): BrewvaAgentEngineTool {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: tool.prepareArguments,
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (update: ToolResultForAgent) => void,
    ) =>
      tool.execute(
        toolCallId,
        params,
        signal,
        onUpdate ? (update) => onUpdate(update as unknown as ToolResultForAgent) : undefined,
        ctxFactory(),
      ) as Promise<ToolResultForAgent>,
  };
}

type ToolResultForAgent = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details: unknown;
};

interface PendingCompactionRequestState {
  customInstructions?: string;
  onComplete?: BrewvaCompactionRequest["onComplete"];
  onError?: BrewvaCompactionRequest["onError"];
}

const COMPACTION_SUMMARY_MAX_LINES = 8;
const COMPACTION_SUMMARY_MAX_CHARS = 220;
const REQUIRED_HOSTED_PERSISTENCE_EVENTS = ["message_end", "session_compact"] as const;

function normalizeSummaryText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function summarizeUnknownMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return normalizeSummaryText(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const fragments: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as { type?: unknown; text?: unknown; name?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      fragments.push(record.text);
      continue;
    }
    if (record.type === "toolCall" && typeof record.name === "string") {
      fragments.push(`[toolCall:${record.name}]`);
    }
  }
  return normalizeSummaryText(fragments.join(" "));
}

function summarizeCompactionMessage(message: unknown): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const record = message as {
    role?: unknown;
    content?: unknown;
    toolName?: unknown;
    customType?: unknown;
    summary?: unknown;
    errorMessage?: unknown;
  };
  if (record.role === "branchSummary" && typeof record.summary === "string") {
    return `branchSummary: ${normalizeSummaryText(record.summary)}`;
  }
  if (record.role === "compactionSummary" && typeof record.summary === "string") {
    return `compactionSummary: ${normalizeSummaryText(record.summary)}`;
  }
  if (record.role === "toolResult") {
    const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
    const body = summarizeUnknownMessageContent(record.content);
    return body.length > 0 ? `toolResult(${toolName}): ${body}` : `toolResult(${toolName})`;
  }
  if (record.role === "custom") {
    const customType = typeof record.customType === "string" ? record.customType : "custom";
    const body = summarizeUnknownMessageContent(record.content);
    return body.length > 0 ? `custom(${customType}): ${body}` : `custom(${customType})`;
  }
  if (typeof record.role === "string") {
    const body = summarizeUnknownMessageContent(record.content);
    if (body.length > 0) {
      return `${record.role}: ${body}`;
    }
    if (typeof record.errorMessage === "string" && record.errorMessage.trim().length > 0) {
      return `${record.role}: ${record.errorMessage.trim()}`;
    }
    return record.role;
  }
  return null;
}

function trimCompactionSummaryLine(line: string): string {
  if (line.length <= COMPACTION_SUMMARY_MAX_CHARS) {
    return line;
  }
  return `${line.slice(0, COMPACTION_SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

function buildDeterministicCompactionSummary(messages: unknown[]): string {
  const summarized = messages
    .map((message) => summarizeCompactionMessage(message))
    .filter((line): line is string => typeof line === "string" && line.length > 0);
  const selected = summarized.slice(-COMPACTION_SUMMARY_MAX_LINES).map(trimCompactionSummaryLine);
  const lines = ["[CompactSummary]"];
  if (selected.length === 0) {
    lines.push("- Preserve the current task state and latest verified evidence.");
  } else {
    for (const line of selected) {
      lines.push(`- ${line}`);
    }
  }
  return lines.join("\n");
}

function estimateCompactionTokens(messages: unknown[]): number {
  const chars = messages
    .map((message) => summarizeCompactionMessage(message) ?? "")
    .join("\n")
    .trim().length;
  return chars > 0 ? Math.max(1, Math.ceil(chars / 4)) : 0;
}

function sameSessionMessages(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function inferRecoveryCrashPoint(
  current: SessionPhase,
): "model_streaming" | "tool_executing" | "wal_append" {
  switch (current.kind) {
    case "model_streaming":
      return "model_streaming";
    case "tool_executing":
    case "waiting_approval":
      return "tool_executing";
    default:
      return "wal_append";
  }
}

function toImageContent(
  parts: readonly unknown[] | undefined,
): BrewvaAgentEngineImageContent[] | undefined {
  if (!Array.isArray(parts) || parts.length === 0) {
    return undefined;
  }
  const images: BrewvaAgentEngineImageContent[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as { type?: unknown; data?: unknown; mimeType?: unknown };
    if (
      record.type === "image" &&
      typeof record.data === "string" &&
      typeof record.mimeType === "string"
    ) {
      images.push({
        type: "image",
        data: record.data,
        mimeType: record.mimeType,
      });
    }
  }
  return images.length > 0 ? images : undefined;
}

function parseCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) {
    return null;
  }
  const spaceIndex = text.indexOf(" ");
  return {
    name: spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex),
    args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1),
  };
}

function buildSkillCommandText(text: string, resourceLoader: BrewvaHostedResourceLoader): string {
  if (!text.startsWith("/skill:")) {
    return text;
  }
  const spaceIndex = text.indexOf(" ");
  const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  const rawArgs = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  const skill = resourceLoader.getSkills().skills.find((candidate) => candidate.name === skillName);
  if (!skill) {
    return text;
  }

  try {
    const content = readFileSync(skill.filePath, "utf8");
    const body = content.replace(/^---[\s\S]*?---\n?/u, "").trim();
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return rawArgs.length > 0 ? `${skillBlock}\n\n${rawArgs}` : skillBlock;
  } catch {
    return text;
  }
}

class ManagedSessionSettingsView implements BrewvaManagedSessionSettingsView {
  constructor(private readonly settings: BrewvaManagedAgentSessionSettingsPort) {}

  getQuietStartup(): boolean {
    return this.settings.getQuietStartup();
  }
}

class ManagedSessionModelCatalogView implements BrewvaSessionModelCatalogView {
  constructor(private readonly catalog: BrewvaMutableModelCatalog) {}

  getAvailable(): readonly BrewvaSessionModelDescriptor[] {
    return this.catalog.getAvailable() as readonly BrewvaSessionModelDescriptor[];
  }

  getAll(): readonly BrewvaSessionModelDescriptor[] {
    return this.catalog.getAll();
  }
}

class BrewvaManagedAgentSession implements BrewvaManagedPromptSession {
  readonly sessionManager: ManagedAgentSessionStore;
  readonly settingsManager: BrewvaManagedSessionSettingsView;
  readonly modelRegistry: BrewvaSessionModelCatalogView;
  readonly _customTools: BrewvaToolDefinition[];

  readonly #cwd: string;
  readonly #settings: BrewvaManagedAgentSessionSettingsPort;
  readonly #catalog: BrewvaMutableModelCatalog;
  readonly #resourceLoader: BrewvaHostedResourceLoader;
  readonly #agent: BrewvaAgentEngine;
  readonly #runner: BrewvaHostPluginRunner;
  readonly #toolDefinitions = new Map<string, BrewvaToolDefinition>();
  readonly #toolPromptSnippets = new Map<string, string>();
  readonly #toolPromptGuidelines = new Map<string, string[]>();
  readonly #listeners = new Set<(event: BrewvaPromptSessionEvent) => void>();
  readonly #queuedSteering: string[] = [];
  readonly #queuedFollowUps: string[] = [];
  readonly #pendingNextTurnMessages: Array<Extract<BrewvaAgentEngineMessage, { role: "custom" }>> =
    [];
  readonly #commandUnsupported = async (): Promise<{ cancelled: boolean }> => ({ cancelled: true });
  #sessionPhase: SessionPhase = { kind: "idle" };
  #unsubscribeSessionWire: (() => void) | null = null;
  #baseSystemPrompt = "";
  #disposed = false;
  #isCompacting = false;
  #commandDispatchBuffer: PendingQueuedItem[] | null = null;
  #pendingCompactionRequest: PendingCompactionRequestState | null = null;
  #stopAfterCurrentToolResults = false;
  #turnIndex = 0;
  #turnStartTimestamp = 0;
  #contextState: ContextState = { ...DEFAULT_CONTEXT_STATE };

  constructor(input: {
    cwd: string;
    settings: BrewvaManagedAgentSessionSettingsPort;
    catalog: BrewvaMutableModelCatalog;
    resourceLoader: BrewvaHostedResourceLoader;
    sessionStore: ManagedAgentSessionStore;
    customTools: readonly BrewvaToolDefinition[];
    runner: BrewvaHostPluginRunner;
    agent: BrewvaAgentEngine;
  }) {
    this.#cwd = input.cwd;
    this.#settings = input.settings;
    this.#catalog = input.catalog;
    this.#resourceLoader = input.resourceLoader;
    this.sessionManager = input.sessionStore;
    this.settingsManager = new ManagedSessionSettingsView(input.settings);
    this.modelRegistry = new ManagedSessionModelCatalogView(input.catalog);
    this._customTools = [...input.customTools];
    this.#runner = input.runner;
    this.#agent = input.agent;
  }

  static async create(
    options: CreateBrewvaManagedAgentSessionOptions,
  ): Promise<BrewvaManagedAgentSession> {
    const toolDefinitions = [...(options.customTools ?? [])];
    let session: BrewvaManagedAgentSession | undefined;

    const runner = await createBrewvaHostPluginRunner({
      plugins: options.runtimePlugins,
      actions: {
        sendMessage(message, sendOptions) {
          if (!session) {
            throw new Error("Session not initialized");
          }
          void session.sendCustomMessage(message, sendOptions);
        },
        sendUserMessage(content, sendOptions) {
          if (!session) {
            throw new Error("Session not initialized");
          }
          void session.sendUserMessage(content, sendOptions);
        },
        getActiveTools() {
          return session?.getActiveToolNames() ?? [];
        },
        getAllTools() {
          return session?.getAllToolInfo() ?? [];
        },
        setActiveTools(toolNames) {
          session?.setActiveTools(toolNames);
        },
        refreshTools() {
          session?.refreshTools();
        },
      },
      registrations: {
        registerTool(tool) {
          toolDefinitions.push(tool);
        },
      },
    });
    const missingPersistenceEvents =
      options.sessionStore.subscribeSessionWire || options.sessionStore.querySessionWire
        ? REQUIRED_HOSTED_PERSISTENCE_EVENTS.filter((event) => !runner.hasHandlers(event))
        : [];
    if (missingPersistenceEvents.length > 0) {
      throw new Error(
        `Hosted runtime-backed sessions require persistence handlers for ${missingPersistenceEvents.join(
          ", ",
        )}. Add createHostedTurnPipeline(...).`,
      );
    }

    const agent = createHostedAgentEngine({
      initialModel: options.initialModel,
      initialThinkingLevel: options.initialThinkingLevel ?? "off",
      steeringMode: options.settings.getSteeringMode(),
      followUpMode: options.settings.getFollowUpMode(),
      transport: options.settings.getTransport(),
      thinkingBudgets: options.settings.getThinkingBudgets(),
      maxRetryDelayMs: options.settings.getRetrySettings()?.maxDelayMs,
      sessionId: options.sessionStore.getSessionId(),
      resolveRequestAuth: async (model) => options.modelCatalog.getApiKeyAndHeaders(model),
      beforeToolCall: async (input: BrewvaAgentEngineBeforeToolCallContext) => {
        if (!session) {
          return undefined;
        }
        const result = await runner.emitToolCall(
          {
            type: "tool_call",
            toolCallId: input.toolCall.id,
            toolName: input.toolCall.name,
            input: input.args as Record<string, unknown>,
          },
          session.createHostContext(),
        );
        return result ? { block: result.block, reason: result.reason } : undefined;
      },
      afterToolCall: async (input: BrewvaAgentEngineAfterToolCallContext) => {
        if (!session) {
          return undefined;
        }
        const result = await runner.emitToolResult(
          {
            type: "tool_result",
            toolCallId: input.toolCall.id,
            toolName: input.toolCall.name,
            input: input.args as Record<string, unknown>,
            content: input.result.content as BrewvaToolResult["content"],
            details: input.result.details,
            isError: input.isError,
          },
          session.createHostContext(),
        );
        if (!result) {
          return undefined;
        }
        return {
          content: result.content as ToolResultForAgent["content"],
          details: result.details,
          isError: result.isError,
        };
      },
      onPayload: async (payload) => {
        if (!session) {
          return payload;
        }
        return runner.emitBeforeProviderRequest(
          { type: "before_provider_request", payload },
          session.createHostContext(),
        );
      },
      transformContext: async (messages) => {
        if (!session) {
          return messages;
        }
        return runner.emitContext(
          { type: "context", messages },
          session.createHostContext(),
        ) as Promise<BrewvaAgentEngineMessage[]>;
      },
      shouldStopAfterToolResults: (toolResults) =>
        session?.consumeToolResultStop(toolResults) ?? false,
    });

    session = new BrewvaManagedAgentSession({
      cwd: options.cwd,
      settings: options.settings,
      catalog: options.modelCatalog,
      resourceLoader: options.resourceLoader,
      sessionStore: options.sessionStore,
      customTools: toolDefinitions,
      runner,
      agent,
    });
    await session.initialize();
    await session.emitSessionStart();
    return session;
  }

  async initialize(): Promise<void> {
    this.refreshTools();
    const restoredMessages = this.sessionManager.buildSessionContext().messages;
    if (restoredMessages.length > 0) {
      this.replaceMessages(restoredMessages);
    }
    const runtimeFactHistory = this.sessionManager.querySessionWire?.();
    if (runtimeFactHistory && runtimeFactHistory.length > 0) {
      await this.reconcileSessionPhase(
        deriveSessionPhaseFromRuntimeFactHistory(
          this.sessionManager.getSessionId(),
          runtimeFactHistory,
        ).phase,
      );
    }
    this.#agent.subscribe(async (event) => {
      await this.handleAgentEvent(event);
    });
    this.#unsubscribeSessionWire =
      this.sessionManager.subscribeSessionWire?.((frame) => {
        void this.advanceSessionPhaseFromRuntimeFactFrame(frame);
      }) ?? null;
    await this.syncContextState();
  }

  get model(): BrewvaSessionModelDescriptor | undefined {
    return this.#catalog.find(this.#agent.state.model.provider, this.#agent.state.model.id);
  }

  get thinkingLevel(): BrewvaPromptThinkingLevel {
    return this.#agent.state.thinkingLevel as BrewvaPromptThinkingLevel;
  }

  get isStreaming(): boolean {
    return this.#agent.state.isStreaming;
  }

  get isCompacting(): boolean {
    return this.#isCompacting;
  }

  getContextState(): ContextState {
    return { ...this.#contextState };
  }

  async prompt(text: string, options?: BrewvaPromptOptions): Promise<void> {
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;
    const command = expandPromptTemplates ? parseCommand(text) : null;
    if (command) {
      const handled = await this.tryExecuteRegisteredCommand(command.name, command.args);
      if (handled) {
        await this.flushCommandDispatchBuffer();
        return;
      }
    }

    let currentText = text;
    let currentImages = toImageContent(options?.images);
    if (this.#runner.hasHandlers("input")) {
      const result = await this.#runner.emitInput(
        {
          type: "input",
          text: currentText,
          images: (options?.images as never) ?? undefined,
          source: options?.source,
        },
        this.createHostContext(),
      );
      if (result.action === "handled") {
        return;
      }
      if (result.action === "transform") {
        currentText = result.text;
        currentImages = toImageContent(result.images);
      }
    }

    let expandedText = currentText;
    if (expandPromptTemplates) {
      expandedText = buildSkillCommandText(expandedText, this.#resourceLoader);
      expandedText = expandBrewvaPromptTemplate(
        expandedText,
        this.#resourceLoader.getPrompts().prompts,
      );
    }

    if (this.isStreaming) {
      const behavior = options?.streamingBehavior;
      if (!behavior) {
        throw new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        );
      }
      await this.queueUserMessage(expandedText, currentImages, behavior);
      return;
    }

    if (!this.model) {
      throw new Error("No model selected.");
    }
    if (!this.#catalog.hasConfiguredAuth(this.model as BrewvaRegisteredModel)) {
      throw new Error(`No API key found for ${this.model.provider}/${this.model.id}.`);
    }

    const messages: BrewvaAgentEngineMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: expandedText }, ...(currentImages ?? [])],
        timestamp: Date.now(),
      },
      ...this.#pendingNextTurnMessages,
    ];
    this.#pendingNextTurnMessages.length = 0;

    const beforeStart = await this.#runner.emitBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: expandedText,
        images: (options?.images as never) ?? undefined,
        systemPrompt: this.#baseSystemPrompt,
      },
      this.createHostContext(),
    );
    if (beforeStart?.messages) {
      for (const message of beforeStart.messages) {
        messages.push({
          role: "custom",
          customType: message.customType,
          content: message.content,
          display: message.display ?? true,
          details: message.details,
          timestamp: Date.now(),
        });
      }
    }

    this.#agent.setSystemPrompt(beforeStart?.systemPrompt ?? this.#baseSystemPrompt);
    await this.syncContextState();
    await this.#agent.prompt(messages);
  }

  subscribe(listener: (event: BrewvaPromptSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  waitForIdle(): Promise<void> {
    return this.#agent.waitForIdle();
  }

  async setModel(model: BrewvaSessionModelDescriptor): Promise<void> {
    const resolved = this.#catalog.find(model.provider, model.id);
    if (!resolved) {
      throw new Error(`Unknown model: ${model.provider}/${model.id}`);
    }
    if (!this.#catalog.hasConfiguredAuth(resolved)) {
      throw new Error(`No API key for ${resolved.provider}/${resolved.id}`);
    }

    const previousModel = this.model;
    this.#agent.setModel(resolved);
    this.#settings.setDefaultModelAndProvider(resolved.provider, resolved.id);
    this.setThinkingLevel(this.thinkingLevel);

    if (
      !previousModel ||
      previousModel.provider !== resolved.provider ||
      previousModel.id !== resolved.id
    ) {
      this.sessionManager.appendModelChange(resolved.provider, resolved.id);
      await this.#runner.emit(
        "model_select",
        {
          type: "model_select",
          model: { provider: resolved.provider, id: resolved.id },
          previousModel: previousModel
            ? { provider: previousModel.provider, id: previousModel.id }
            : undefined,
          source: "set",
        },
        this.createHostContext(),
      );
    }
  }

  setThinkingLevel(level: BrewvaPromptThinkingLevel): void {
    const available = this.getAvailableThinkingLevels();
    const effective = available.includes(level)
      ? level
      : (available[available.length - 1] ?? "off");
    const previousThinkingLevel = this.#agent.state.thinkingLevel as BrewvaPromptThinkingLevel;
    const changed = effective !== previousThinkingLevel;
    this.#agent.setThinkingLevel(effective as BrewvaAgentEngineThinkingLevel);
    if (changed) {
      this.sessionManager.appendThinkingLevelChange(effective);
      this.#settings.setDefaultThinkingLevel(effective);
      void this.#runner
        .emit(
          "thinking_level_select",
          {
            type: "thinking_level_select",
            thinkingLevel: effective,
            previousThinkingLevel,
            source: "set",
          },
          this.createHostContext(),
        )
        .catch(() => undefined);
    }
  }

  replaceMessages(messages: unknown): void {
    if (!Array.isArray(messages)) {
      throw new Error("replaceMessages expects an array of messages.");
    }
    this.#agent.replaceMessages([...messages] as BrewvaAgentEngineMessage[]);
  }

  getAvailableThinkingLevels(): BrewvaPromptThinkingLevel[] {
    const currentModel = this.model;
    if (!currentModel?.reasoning) {
      return ["off"];
    }
    return supportsHostedExtendedThinking(currentModel as BrewvaRegisteredModel)
      ? ["off", "minimal", "low", "medium", "high", "xhigh"]
      : ["off", "minimal", "low", "medium", "high"];
  }

  async abort(): Promise<void> {
    this.#agent.abort();
    await this.#agent.waitForIdle();
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeSessionWire?.();
    this.#unsubscribeSessionWire = null;
    this.sessionManager.dispose?.();
    this.#listeners.clear();
    void this.#runner.emit(
      "session_shutdown",
      { type: "session_shutdown" },
      this.createHostContext(),
    );
  }

  private async emitSessionStart(): Promise<void> {
    await this.#runner.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      this.createHostContext(),
    );
  }

  private refreshTools(): void {
    this.#toolDefinitions.clear();
    this.#toolPromptSnippets.clear();
    this.#toolPromptGuidelines.clear();

    for (const tool of this._customTools) {
      this.#toolDefinitions.set(tool.name, tool);
      const promptSnippet = this.normalizePromptSnippet(tool.promptSnippet);
      if (promptSnippet) {
        this.#toolPromptSnippets.set(tool.name, promptSnippet);
      }
      const guidelines = this.normalizePromptGuidelines(tool.promptGuidelines);
      if (guidelines.length > 0) {
        this.#toolPromptGuidelines.set(tool.name, guidelines);
      }
    }

    const tools = [...this.#toolDefinitions.values()].map((tool) =>
      toAgentTool(tool, () => this.createToolContext()),
    );
    this.#agent.setTools(tools);
    this.#baseSystemPrompt = this.rebuildSystemPrompt();
    this.#agent.setSystemPrompt(this.#baseSystemPrompt);
  }

  private normalizePromptSnippet(text: string | undefined): string | undefined {
    if (!text) {
      return undefined;
    }
    const normalized = text
      .replace(/[\r\n]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
    if (!guidelines || guidelines.length === 0) {
      return [];
    }
    return [...new Set(guidelines.map((line) => line.trim()).filter((line) => line.length > 0))];
  }

  private rebuildSystemPrompt(): string {
    const selectedTools = this.getActiveToolNames();
    const toolSnippets: Record<string, string> = {};
    const promptGuidelines: string[] = [];
    for (const toolName of selectedTools) {
      const snippet = this.#toolPromptSnippets.get(toolName);
      if (snippet) {
        toolSnippets[toolName] = snippet;
      }
      const guidelines = this.#toolPromptGuidelines.get(toolName);
      if (guidelines) {
        promptGuidelines.push(...guidelines);
      }
    }

    const loadedSkills = this.#resourceLoader.getSkills().skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
    }));

    return buildBrewvaSystemPrompt({
      cwd: this.#cwd,
      selectedTools,
      toolSnippets,
      promptGuidelines,
      customPrompt: this.#resourceLoader.getSystemPrompt(),
      appendSystemPrompt: this.#resourceLoader.getAppendSystemPrompt().join("\n\n"),
      contextFiles: this.#resourceLoader.getAgentsFiles().agentsFiles,
      skills: loadedSkills,
    });
  }

  private getActiveToolNames(): string[] {
    return this.#agent.state.tools.map((tool) => tool.name);
  }

  private getAllToolInfo(): Array<{
    name: string;
    description: string;
    parameters: unknown;
    sourceInfo?: unknown;
  }> {
    return [...this.#toolDefinitions.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private setActiveTools(toolNames: string[]): void {
    const tools = toolNames
      .map((toolName) => this.#toolDefinitions.get(toolName))
      .filter((tool): tool is BrewvaToolDefinition => tool !== undefined)
      .map((tool) => toAgentTool(tool, () => this.createToolContext()));
    this.#agent.setTools(tools);
    this.#baseSystemPrompt = this.rebuildSystemPrompt();
    this.#agent.setSystemPrompt(this.#baseSystemPrompt);
  }

  private async tryExecuteRegisteredCommand(name: string, args: string): Promise<boolean> {
    const command = this.#runner.getRegisteredCommands().get(name);
    if (!command) {
      return false;
    }
    this.#commandDispatchBuffer = [];
    try {
      await command.handler(args, this.createCommandContext());
      return true;
    } finally {
      if (this.#commandDispatchBuffer?.length === 0) {
        this.#commandDispatchBuffer = null;
      }
    }
  }

  private async flushCommandDispatchBuffer(): Promise<void> {
    const buffer = this.#commandDispatchBuffer;
    this.#commandDispatchBuffer = null;
    if (!buffer || buffer.length === 0) {
      return;
    }
    for (const item of buffer) {
      if (item.kind === "user") {
        await this.prompt(item.text, {
          expandPromptTemplates: false,
          images: item.images as never,
          source: "extension",
        });
        continue;
      }
      await this.sendCustomMessage(item.message, { triggerTurn: true });
    }
  }

  private async queueUserMessage(
    text: string,
    images: BrewvaAgentEngineImageContent[] | undefined,
    behavior: BrewvaPromptQueueBehavior,
  ): Promise<void> {
    if (behavior === "followUp") {
      this.#queuedFollowUps.push(text);
      this.#agent.followUp({
        role: "user",
        content: [{ type: "text", text }, ...(images ?? [])],
        timestamp: Date.now(),
      });
      return;
    }
    this.#queuedSteering.push(text);
    this.#agent.steer({
      role: "user",
      content: [{ type: "text", text }, ...(images ?? [])],
      timestamp: Date.now(),
    });
  }

  private async sendCustomMessage(
    message: BrewvaHostCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void> {
    const customMessage: Extract<BrewvaAgentEngineMessage, { role: "custom" }> = {
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display ?? true,
      details: message.details,
      timestamp: Date.now(),
    };

    if (options?.deliverAs === "nextTurn") {
      this.#pendingNextTurnMessages.push(customMessage);
      return;
    }

    if (this.#commandDispatchBuffer && !this.isStreaming && options?.triggerTurn) {
      this.#commandDispatchBuffer.push({ kind: "custom", message });
      return;
    }

    if (this.isStreaming) {
      if (options?.deliverAs === "followUp") {
        this.#agent.followUp(customMessage);
      } else {
        this.#agent.steer(customMessage);
      }
      return;
    }

    if (options?.triggerTurn) {
      await this.#agent.prompt(customMessage);
      return;
    }

    this.#agent.appendMessage(customMessage);
    const messageStartEvent = { type: "message_start" as const, message: customMessage };
    const messageEndEvent = { type: "message_end" as const, message: customMessage };
    if (this.#runner.hasHandlers("message_end")) {
      await this.emitPluginEvent(messageStartEvent);
      this.emitToListeners(messageStartEvent);
      await this.emitPluginEvent(messageEndEvent);
      this.emitToListeners(messageEndEvent);
    } else {
      this.sessionManager.appendCustomMessageEntry(
        customMessage.customType,
        customMessage.content,
        customMessage.display,
        customMessage.details,
      );
      this.emitToListeners(messageStartEvent);
      this.emitToListeners(messageEndEvent);
    }
    await this.syncContextState();
  }

  private async sendUserMessage(
    content: string | BrewvaTextContentPart[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> {
    let text: string;
    let images: BrewvaAgentEngineImageContent[] | undefined;

    if (typeof content === "string") {
      text = content;
    } else {
      text = content.map((part) => part.text).join("\n");
      images = undefined;
    }

    if (this.#commandDispatchBuffer && !this.isStreaming) {
      this.#commandDispatchBuffer.push({ kind: "user", text, images });
      return;
    }

    await this.prompt(text, {
      expandPromptTemplates: false,
      streamingBehavior: options?.deliverAs,
      images: images as never,
      source: "extension",
    });
  }

  private createToolContext(): BrewvaToolContext {
    return {
      ui: NOOP_UI,
      hasUI: false,
      cwd: this.#cwd,
      sessionManager: {
        getSessionId: () => this.sessionManager.getSessionId(),
        getLeafId: () => this.sessionManager.getLeafId() ?? null,
      },
      modelRegistry: this.#catalog,
      model: this.model as BrewvaRegisteredModel | undefined,
      isIdle: () => !this.isStreaming,
      signal: this.#agent.signal,
      abort: () => this.#agent.abort(),
      hasPendingMessages: () =>
        this.#agent.hasQueuedMessages() || this.#pendingNextTurnMessages.length > 0,
      shutdown: () => this.dispose(),
      compact: (request) => {
        this.requestCompaction(request);
      },
      getContextUsage: () => undefined,
      getSystemPrompt: () => this.#agent.state.systemPrompt,
    };
  }

  private createHostContext() {
    return this.createToolContext();
  }

  private createCommandContext(): BrewvaHostCommandContext {
    const hostContext = this.createHostContext();
    return {
      ...hostContext,
      waitForIdle: () => this.waitForIdle(),
      newSession: this.#commandUnsupported,
      fork: this.#commandUnsupported,
      navigateTree: this.#commandUnsupported,
      switchSession: this.#commandUnsupported,
      reload: async () => {
        await this.#resourceLoader.reload();
        this.refreshTools();
      },
    };
  }

  private async handleAgentEvent(event: BrewvaAgentEngineEvent): Promise<void> {
    if (event.type === "message_start" && event.message.role === "user") {
      const userText = this.extractUserMessageText(event.message);
      this.deleteQueuedMessage(userText);
    }

    await this.advanceSessionPhaseFromAgentEvent(event);
    await this.emitPluginEvent(event);
    this.emitToListeners(event as BrewvaPromptSessionEvent);
    await this.syncContextState();
    if (event.type === "message_end" && event.message.role === "toolResult") {
      await this.executeDeferredCompaction();
      await this.syncContextState();
    }
  }

  private requestCompaction(request?: BrewvaCompactionRequest): void {
    if (this.#isCompacting || this.#pendingCompactionRequest) {
      request?.onError?.(new Error("Hosted compaction is already in progress."));
      return;
    }

    this.#pendingCompactionRequest = {
      customInstructions: request?.customInstructions,
      onComplete: request?.onComplete,
      onError: request?.onError,
    };

    if (this.isStreaming) {
      this.#stopAfterCurrentToolResults = true;
      return;
    }

    void this.executeDeferredCompaction();
  }

  private consumeToolResultStop(_toolResults: BrewvaAgentEngineToolResultMessage[]): boolean {
    if (!this.#stopAfterCurrentToolResults) {
      return false;
    }
    this.#stopAfterCurrentToolResults = false;
    return true;
  }

  private async executeDeferredCompaction(): Promise<void> {
    const request = this.#pendingCompactionRequest;
    if (!request || this.#isCompacting) {
      return;
    }

    this.#pendingCompactionRequest = null;
    this.#isCompacting = true;
    let pendingCompactEvent: {
      type: "session_compact";
      compactionEntry: {
        id: string;
        summary: string;
        content: string;
        text: string;
        sourceLeafEntryId: string | null;
        firstKeptEntryId: string;
        tokensBefore: number;
      };
      fromExtension: false;
    } | null = null;
    try {
      const branchEntries = this.sessionManager.getBranch();
      const sessionContext = this.sessionManager.buildSessionContext();
      const sourceLeafEntryId = this.sessionManager.getLeafId() ?? null;
      const summary = buildDeterministicCompactionSummary(sessionContext.messages);
      const tokensBefore = estimateCompactionTokens(sessionContext.messages);
      const compactId = randomUUID();
      const preview = this.sessionManager.previewCompaction(
        summary,
        tokensBefore,
        compactId,
        sourceLeafEntryId,
      );
      const beforeCompactEvent = {
        type: "session_before_compact" as const,
        preparation: {
          strategy: "deterministic_projection_compaction",
        },
        branchEntries,
        customInstructions: request.customInstructions,
      };
      await this.#runner.emit(
        "session_before_compact",
        beforeCompactEvent,
        this.createHostContext(),
      );
      this.emitToListeners(beforeCompactEvent);

      this.replaceMessages(preview.context.messages);

      const compactEvent = {
        type: "session_compact" as const,
        compactionEntry: {
          id: preview.compactId,
          summary,
          content: summary,
          text: summary,
          sourceLeafEntryId: preview.sourceLeafEntryId,
          firstKeptEntryId: preview.firstKeptEntryId,
          tokensBefore: preview.tokensBefore,
        },
        fromExtension: false as const,
      };
      pendingCompactEvent = compactEvent;
      try {
        await this.#runner.emit("session_compact", compactEvent, this.createHostContext());
        this.emitToListeners(compactEvent);
        request.onComplete?.(compactEvent);
      } catch (error) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await Promise.resolve();
          await new Promise((resolve) => setTimeout(resolve, 0));
          const persistedBranch = this.sessionManager.getBranch();
          const persistedLeaf = persistedBranch[persistedBranch.length - 1];
          const persistedContext = this.sessionManager.buildSessionContext();
          if (
            (persistedLeaf?.type === "compaction" &&
              persistedLeaf.summary === summary &&
              persistedLeaf.firstKeptEntryId === preview.firstKeptEntryId &&
              persistedLeaf.tokensBefore === preview.tokensBefore) ||
            sameSessionMessages(persistedContext.messages, preview.context.messages)
          ) {
            this.replaceMessages(persistedContext.messages);
            this.emitToListeners(compactEvent);
            request.onComplete?.(compactEvent);
            return;
          }
        }
        this.replaceMessages(sessionContext.messages);
        throw error;
      }
    } catch (error) {
      this.#stopAfterCurrentToolResults = false;
      if (pendingCompactEvent) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const settledBranch = this.sessionManager.getBranch();
        const settledLeaf = settledBranch[settledBranch.length - 1];
        const settledContext = this.sessionManager.buildSessionContext();
        if (settledLeaf?.type === "compaction") {
          this.replaceMessages(settledContext.messages);
          this.emitToListeners(pendingCompactEvent);
          request.onComplete?.(pendingCompactEvent);
          return;
        }
      }
      request.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.#isCompacting = false;
    }
  }

  private async emitPluginEvent(event: BrewvaAgentEngineEvent): Promise<void> {
    const ctx = this.createHostContext();
    switch (event.type) {
      case "agent_start":
        await this.#runner.emit("agent_start", { type: "agent_start" }, ctx);
        return;
      case "agent_end":
        await this.#runner.emit("agent_end", { type: "agent_end", messages: event.messages }, ctx);
        return;
      case "turn_start":
        this.#turnIndex += 1;
        this.#turnStartTimestamp = Date.now();
        await this.#runner.emit(
          "turn_start",
          {
            type: "turn_start",
            turnIndex: this.#turnIndex,
            timestamp: this.#turnStartTimestamp,
          },
          ctx,
        );
        return;
      case "turn_end":
        await this.#runner.emit(
          "turn_end",
          {
            type: "turn_end",
            turnIndex: this.#turnIndex,
            message: event.message,
            toolResults: event.toolResults,
          },
          ctx,
        );
        return;
      case "message_start":
        await this.#runner.emit(
          "message_start",
          { type: "message_start", message: event.message },
          ctx,
        );
        return;
      case "message_update":
        await this.#runner.emit(
          "message_update",
          {
            type: "message_update",
            message: event.message,
            assistantMessageEvent: event.assistantMessageEvent,
          },
          ctx,
        );
        return;
      case "message_end":
        await this.#runner.emit(
          "message_end",
          { type: "message_end", message: event.message },
          ctx,
        );
        return;
      case "tool_execution_start":
        await this.#runner.emit(
          "tool_execution_start",
          {
            type: "tool_execution_start",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args,
          },
          ctx,
        );
        return;
      case "tool_execution_update":
        await this.#runner.emit(
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
        return;
      case "tool_execution_end":
        await this.#runner.emit(
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
        return;
      case "tool_execution_phase_change":
        await this.#runner.emit(
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
        return;
      default:
        return;
    }
  }

  private async advanceSessionPhaseFromAgentEvent(event: BrewvaAgentEngineEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
        if (event.message.role !== "assistant" || this.getSessionPhase().kind !== "idle") {
          return;
        }
        await this.transitionSessionPhase({
          type: "start_model_stream",
          modelCallId: this.resolveModelCallId(event.message),
          turn: this.resolvePhaseTurn(),
        });
        return;
      case "message_end":
        if (
          event.message.role !== "assistant" ||
          this.getSessionPhase().kind !== "model_streaming"
        ) {
          return;
        }
        await this.transitionSessionPhase({ type: "finish_model_stream" });
        return;
      case "tool_execution_start":
        if (this.getSessionPhase().kind !== "idle") {
          return;
        }
        await this.transitionSessionPhase({
          type: "start_tool_execution",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          turn: this.resolvePhaseTurn(),
        });
        return;
      case "tool_execution_end":
        if (this.getSessionPhase().kind !== "tool_executing") {
          return;
        }
        await this.transitionSessionPhase({ type: "finish_tool_execution" });
        return;
      default:
        return;
    }
  }

  private async advanceSessionPhaseFromRuntimeFactFrame(frame: SessionWireFrame): Promise<void> {
    if (
      frame.type === "turn.transition" &&
      frame.status === "entered" &&
      frame.family === "recovery" &&
      frame.reason === "wal_recovery_resume" &&
      this.getSessionPhase().kind !== "crashed" &&
      this.getSessionPhase().kind !== "recovering" &&
      this.getSessionPhase().kind !== "terminated"
    ) {
      await this.transitionSessionPhase({
        type: "crash",
        crashAt: inferRecoveryCrashPoint(this.getSessionPhase()),
        turn: this.resolvePhaseTurn(),
        recoveryAnchor: `transition:${frame.reason}`,
      });
      await this.transitionSessionPhase({ type: "resume" });
    }
    const next = deriveSessionPhaseFromRuntimeFactFrame(
      this.getSessionPhase(),
      frame,
      this.resolvePhaseTurn(),
    );
    if (!next) {
      return;
    }
    await this.reconcileSessionPhase(next.phase);
    await this.syncContextState();
  }

  private async transitionSessionPhase(event: SessionPhaseEvent): Promise<void> {
    const previousPhase = this.getSessionPhase();
    const nextPhase = advanceSessionPhase(previousPhase, event);
    if (sameSessionPhase(previousPhase, nextPhase)) {
      return;
    }
    this.#sessionPhase = nextPhase;
    await this.#runner.emit(
      "session_phase_change",
      {
        type: "session_phase_change",
        phase: nextPhase,
        previousPhase,
      },
      this.createHostContext(),
    );
    this.emitToListeners({
      type: "session_phase_change",
      phase: nextPhase,
      previousPhase,
    });
  }

  private async reconcileSessionPhase(nextPhase: SessionPhase): Promise<void> {
    const previousPhase = this.getSessionPhase();
    if (sameSessionPhase(previousPhase, nextPhase)) {
      return;
    }
    this.#sessionPhase = nextPhase;
    await this.#runner.emit(
      "session_phase_change",
      {
        type: "session_phase_change",
        phase: nextPhase,
        previousPhase,
      },
      this.createHostContext(),
    );
    this.emitToListeners({
      type: "session_phase_change",
      phase: nextPhase,
      previousPhase,
    });
  }

  private getSessionPhase(): SessionPhase {
    return this.#sessionPhase;
  }

  private resolvePhaseTurn(): number {
    return this.#turnIndex > 0 ? this.#turnIndex : 1;
  }

  private resolveModelCallId(
    message: Extract<BrewvaAgentEngineMessage, { role: "assistant" }>,
  ): string {
    return typeof message.responseId === "string" && message.responseId.trim().length > 0
      ? message.responseId
      : `turn:${this.resolvePhaseTurn()}:assistant`;
  }

  private emitToListeners(event: BrewvaPromptSessionEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  private async syncContextState(): Promise<void> {
    const next = this.sessionManager.readContextState?.() ?? DEFAULT_CONTEXT_STATE;
    if (sameContextState(this.#contextState, next)) {
      return;
    }
    const previousState = this.#contextState;
    this.#contextState = { ...next };
    await this.#runner.emit(
      "context_state_change",
      {
        type: "context_state_change",
        state: this.getContextState(),
        previousState,
      },
      this.createHostContext(),
    );
    this.emitToListeners({
      type: "context_state_change",
      state: this.getContextState(),
      previousState,
    });
  }

  private extractUserMessageText(
    message: Extract<BrewvaAgentEngineMessage, { role: "user" }>,
  ): string {
    if (typeof message.content === "string") {
      return message.content;
    }
    return message.content
      .filter((block): block is BrewvaAgentEngineTextContent => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  private deleteQueuedMessage(text: string): void {
    const steeringIndex = this.#queuedSteering.indexOf(text);
    if (steeringIndex !== -1) {
      this.#queuedSteering.splice(steeringIndex, 1);
      return;
    }
    const followUpIndex = this.#queuedFollowUps.indexOf(text);
    if (followUpIndex !== -1) {
      this.#queuedFollowUps.splice(followUpIndex, 1);
    }
  }
}

export async function createBrewvaManagedAgentSession(
  options: CreateBrewvaManagedAgentSessionOptions,
): Promise<BrewvaManagedPromptSession> {
  return BrewvaManagedAgentSession.create(options);
}

function sameSessionPhase(left: SessionPhase, right: SessionPhase): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "idle":
      return true;
    case "model_streaming": {
      const next = right as Extract<SessionPhase, { kind: "model_streaming" }>;
      return left.modelCallId === next.modelCallId && left.turn === next.turn;
    }
    case "tool_executing": {
      const next = right as Extract<SessionPhase, { kind: "tool_executing" }>;
      return (
        left.toolCallId === next.toolCallId &&
        left.toolName === next.toolName &&
        left.turn === next.turn
      );
    }
    case "waiting_approval": {
      const next = right as Extract<SessionPhase, { kind: "waiting_approval" }>;
      return (
        left.requestId === next.requestId &&
        left.toolCallId === next.toolCallId &&
        left.toolName === next.toolName &&
        left.turn === next.turn
      );
    }
    case "recovering": {
      const next = right as Extract<SessionPhase, { kind: "recovering" }>;
      return left.recoveryAnchor === next.recoveryAnchor && left.turn === next.turn;
    }
    case "crashed": {
      const next = right as Extract<SessionPhase, { kind: "crashed" }>;
      return (
        left.crashAt === next.crashAt &&
        left.turn === next.turn &&
        left.modelCallId === next.modelCallId &&
        left.toolCallId === next.toolCallId &&
        left.recoveryAnchor === next.recoveryAnchor
      );
    }
    case "terminated": {
      const next = right as Extract<SessionPhase, { kind: "terminated" }>;
      return left.reason === next.reason;
    }
  }

  const exhaustive: never = left;
  return exhaustive;
}

function sameContextState(left: ContextState, right: ContextState): boolean {
  return (
    left.budgetPressure === right.budgetPressure &&
    left.promptStabilityFingerprint === right.promptStabilityFingerprint &&
    left.transientReductionActive === right.transientReductionActive &&
    left.historyBaselineAvailable === right.historyBaselineAvailable &&
    left.reservedPrimaryTokens === right.reservedPrimaryTokens &&
    left.reservedSupplementalTokens === right.reservedSupplementalTokens &&
    left.lastInjectionScopeId === right.lastInjectionScopeId
  );
}
