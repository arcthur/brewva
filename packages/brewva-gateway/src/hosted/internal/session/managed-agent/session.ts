import { randomUUID } from "node:crypto";
import { clearApiProviderSessions } from "@brewva/brewva-provider-core/registry";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import {
  STEER_APPLIED_EVENT_TYPE,
  STEER_DROPPED_EVENT_TYPE,
  STEER_QUEUED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import {
  buildBrewvaDeterministicCompactionSummary,
  estimateBrewvaCompactionTokens,
} from "@brewva/brewva-substrate/compaction";
import type { ContextState } from "@brewva/brewva-substrate/contracts";
import {
  createBrewvaHostPluginRunner,
  type BrewvaHostCommandContext,
  type BrewvaHostCustomMessage,
  type BrewvaHostCustomMessageDelivery,
  type BrewvaHostPluginRunner,
  type BrewvaToolUiPort,
} from "@brewva/brewva-substrate/host-api";
import {
  buildBrewvaPromptText,
  cloneBrewvaPromptContentParts,
  expandBrewvaPromptTemplate,
  promptPartsArePlainText,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaMutableModelCatalog,
  BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import type { BrewvaHostedResourceLoader } from "@brewva/brewva-substrate/resources";
import {
  canTransitionSessionPhase,
  type BrewvaManagedPromptSession,
  type BrewvaManagedSessionSettingsView,
  type BrewvaModelPresetSelectionRequest,
  type BrewvaModelPresetSelectionResult,
  type BrewvaModelPresetState,
  type BrewvaSteerOptions,
  type BrewvaSteerOutcome,
  type BrewvaPromptOptions,
  type BrewvaPromptQueueBehavior,
  type BrewvaQueuedPromptView,
  type BrewvaPromptSessionEvent,
  type BrewvaPromptThinkingLevel,
  type SessionPhase,
  type SessionPhaseEvent,
  type BrewvaSessionModelCatalogView,
  type BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import {
  type BrewvaCompactionRequest,
  BrewvaToolContext,
  BrewvaToolDefinition,
  BrewvaToolResult,
} from "@brewva/brewva-substrate/tools";
import {
  createBrewvaTurnLoopController,
  type BrewvaTurnLoopAfterToolCallContext,
  type BrewvaTurnLoopBeforeToolCallContext,
  type BrewvaTurnLoopController,
  type BrewvaTurnLoopEvent,
  type BrewvaTurnLoopMessage,
  type BrewvaTurnLoopToolResultMessage,
} from "@brewva/brewva-substrate/turn";
import {
  ManagedSessionDeferredCompactionCoordinator,
  type DeferredCompactionSalvageMode,
} from "../../compaction/deferred.js";
import {
  buildCompactionSummaryGenerationMetadata,
  compactionFallbackReason,
  ManagedSessionCompactionFlowState,
  nonNegativeUsageNumber,
  sameSessionMessages,
  type ResolvedCompactionSummary,
} from "../../compaction/flow.js";
import {
  MODEL_DOWNSHIFT_COMPACTION_INSTRUCTIONS,
  requestCompactionAndWait,
  shouldCompactForModelDownshift,
} from "../../compaction/model-downshift-policy.js";
import {
  createHostedLlmCompactionSummaryGenerator,
  DETERMINISTIC_EMERGENCY_COMPACTION_STRATEGY,
  LLM_PRIMARY_COMPACTION_STRATEGY,
  normalizeCompactionSummaryForStorage,
  type BrewvaCompactionSummaryGenerator,
} from "../../compaction/summary-generator.js";
import { supportsHostedExtendedThinkingModel as supportsHostedExtendedThinking } from "../../provider/built-in-catalog.js";
import {
  GoogleCachedContentManager,
  ProviderCacheBreakDetector,
  createProviderRequestFingerprint,
  createToolSchemaSnapshotStore,
  type ToolSchemaSnapshot,
} from "../../provider/cache/index.js";
import { createHostedProviderStreamFunction } from "../../provider/stream.js";
import type { HostedSessionLogger } from "../../shared/logger.js";
import { HOSTED_PROMPT_ATTEMPT_DISPATCH } from "../../thread-loop/hosted-prompt-attempt.js";
import { clearDefaultTurnLifecycleSpine } from "../../thread-loop/turn-envelope.js";
import {
  deriveCompatibilityValidationEvent,
  ManagedSessionPhaseCoordinator,
  resolveManagedSessionBootstrapPhase,
  resolvePhaseTurn,
  subscribeManagedSessionWireHydration,
} from "../session-phase/api.js";
import { SessionTitleCoordinator } from "../title-coordinator.js";
import {
  createHostedSessionTitleGenerator,
  type BrewvaSessionTitleGenerator,
} from "../title-generator.js";
import {
  ManagedSessionCommandDispatchGate,
  ManagedSessionDeferredTurnState,
} from "./deferred-dispatch.js";
import { ManagedSessionEventBridge } from "./event-bridge.js";
import { ManagedSessionLiveTranscript } from "./live-transcript.js";
import { ManagedSessionModelCatalogView } from "./model-catalog-view.js";
import {
  createFallbackModelPresetState,
  ManagedSessionModelSelectionController,
} from "./model-selection.js";
import { NOOP_UI } from "./noop-ui.js";
import { ManagedSessionSettingsView } from "./preferences.js";
import {
  buildSkillCommandText,
  buildTextPromptParts,
  parseCommand,
  resolvePromptFilePart,
  toAgentUserContent,
} from "./prompt-content.js";
import { ManagedSessionProviderAssistantObserver } from "./provider-assistant-observer.js";
import {
  buildProviderCacheModelKey,
  isCachedContentUnsupportedStreamError,
  ManagedSessionProviderCacheState,
  normalizeProviderCacheRender,
  resolveProviderCacheDiagnosticDumpDirectory,
} from "./provider-cache-state.js";
import {
  buildProviderDynamicTailSummary,
  EMPTY_WORKBENCH_CONTEXT_FINGERPRINT,
  resolveExpectedProviderCacheBreak,
  resolveWorkbenchContextFingerprint,
  type WorkbenchContextFingerprintInput,
} from "./provider-payload-summary.js";
import {
  REQUIRED_HOSTED_PERSISTENCE_EVENTS,
  toTurnLoopThinkingLevel,
  type BrewvaManagedAgentSessionSettingsPort,
  type BuiltDeferredCompactionEvents,
  type CreateBrewvaManagedAgentSessionOptions,
  type ManagedAgentSessionStore,
  type PreparedDeferredCompaction,
  type ProviderCacheRuntimeState,
  type ToolResultForAgent,
} from "./session-contracts.js";
import {
  buildManagedSessionBaseSystemPrompt,
  ManagedSessionToolRegistry,
} from "./tool-registry.js";
import {
  buildSteerAuditPayload,
  normalizePromptSource,
  resolveChannelContext,
} from "./turn-audit.js";

const DEFAULT_GOOGLE_CACHED_CONTENT_MANAGER = new GoogleCachedContentManager();

export const MANAGED_AGENT_SESSION_TEST_ONLY = {
  resolveWorkbenchContextFingerprint,
  isCachedContentUnsupportedStreamError,
} as const;

export type {
  BrewvaManagedAgentSessionSettingsPort,
  CreateBrewvaManagedAgentSessionOptions,
  ManagedAgentSessionStore,
} from "./session-contracts.js";

class BrewvaManagedAgentSession implements BrewvaManagedPromptSession {
  readonly sessionManager: ManagedAgentSessionStore;
  readonly settingsManager: BrewvaManagedSessionSettingsView;
  readonly modelRegistry: BrewvaSessionModelCatalogView;

  readonly #cwd: string;
  readonly #runtime: BrewvaHostedRuntimePort | undefined;
  readonly #settings: BrewvaManagedAgentSessionSettingsPort;
  readonly #catalog: BrewvaMutableModelCatalog;
  readonly #modelSelection: ManagedSessionModelSelectionController;
  readonly #resourceLoader: BrewvaHostedResourceLoader;
  readonly #agent: BrewvaTurnLoopController;
  readonly #runner: BrewvaHostPluginRunner;
  readonly #compactionSummaryGenerator: BrewvaCompactionSummaryGenerator;
  readonly #sessionTitleGenerator: BrewvaSessionTitleGenerator;
  readonly #registeredTools: BrewvaToolDefinition[];
  readonly #toolSchemaSnapshotStore = createToolSchemaSnapshotStore();
  readonly #toolRegistry: ManagedSessionToolRegistry;
  readonly #providerCacheState: ManagedSessionProviderCacheState;
  readonly #deferredTurnState = new ManagedSessionDeferredTurnState();
  readonly #commandDispatchGate = new ManagedSessionCommandDispatchGate();
  readonly #compactionFlow = new ManagedSessionCompactionFlowState();
  readonly #deferredCompaction: ManagedSessionDeferredCompactionCoordinator<
    PreparedDeferredCompaction,
    BuiltDeferredCompactionEvents
  >;
  readonly #eventBridge: ManagedSessionEventBridge;
  readonly #liveTranscript: ManagedSessionLiveTranscript;
  readonly #phaseCoordinator: ManagedSessionPhaseCoordinator;
  readonly #listeners = new Set<(event: BrewvaPromptSessionEvent) => void>();
  #ui: BrewvaToolUiPort;
  readonly #commandUnsupported = async (): Promise<{ cancelled: boolean }> => ({ cancelled: true });
  #unsubscribeSessionWire: (() => void) | null = null;
  #unsubscribeSessionTitleCoordinator: (() => void) | null = null;
  #baseSystemPrompt = "";
  #disposed = false;
  #turnIndex = 0;
  #turnStartTimestamp = 0;
  #activePromptSource: string | undefined;
  #lastWorkbenchContextFingerprint: WorkbenchContextFingerprintInput = {
    ...EMPTY_WORKBENCH_CONTEXT_FINGERPRINT,
  };
  readonly #logger: HostedSessionLogger | null;
  readonly #onProviderAssistantMessage:
    | ((message: Extract<BrewvaTurnLoopMessage, { role: "assistant" }>) => void)
    | undefined;
  readonly #onDispose: (() => void) | undefined;
  readonly #onInitialPersistence: (() => void) | undefined;
  #initialPersistenceEnsured = false;
  #sessionStartEmitted = false;

  constructor(input: {
    cwd: string;
    runtime?: BrewvaHostedRuntimePort;
    settings: BrewvaManagedAgentSessionSettingsPort;
    catalog: BrewvaMutableModelCatalog;
    resourceLoader: BrewvaHostedResourceLoader;
    sessionStore: ManagedAgentSessionStore;
    modelPresetState?: BrewvaModelPresetState;
    customTools: readonly BrewvaToolDefinition[];
    runner: BrewvaHostPluginRunner;
    agent: BrewvaTurnLoopController;
    compactionSummaryGenerator: BrewvaCompactionSummaryGenerator;
    sessionTitleGenerator: BrewvaSessionTitleGenerator;
    ui?: BrewvaToolUiPort;
    logger?: HostedSessionLogger;
    onProviderAssistantMessage?: (
      message: Extract<BrewvaTurnLoopMessage, { role: "assistant" }>,
    ) => void;
    onInitialPersistence?: () => void;
    onDispose?: () => void;
  }) {
    this.#cwd = input.cwd;
    this.#runtime = input.runtime;
    this.#settings = input.settings;
    this.#catalog = input.catalog;
    this.#resourceLoader = input.resourceLoader;
    this.#ui = input.ui ?? NOOP_UI;
    this.sessionManager = input.sessionStore;
    this.settingsManager = new ManagedSessionSettingsView(input.settings);
    this.modelRegistry = new ManagedSessionModelCatalogView(input.catalog);
    this.#registeredTools = [...input.customTools];
    this.#runner = input.runner;
    this.#agent = input.agent;
    this.#compactionSummaryGenerator = input.compactionSummaryGenerator;
    this.#sessionTitleGenerator = input.sessionTitleGenerator;
    this.#logger = input.logger ?? null;
    this.#onProviderAssistantMessage = input.onProviderAssistantMessage;
    this.#onInitialPersistence = input.onInitialPersistence;
    this.#onDispose = input.onDispose;
    this.#liveTranscript = new ManagedSessionLiveTranscript({
      agent: this.#agent,
      clearProviderCacheSessionState: () => this.clearProviderCacheSessionState(),
    });
    this.#eventBridge = new ManagedSessionEventBridge({
      runner: this.#runner,
      createHostContext: () => this.createHostContext(),
      emitToListeners: (event) => this.emitToListeners(event),
      appendMessage: (message) => this.#liveTranscript.appendCommittedMessage(message),
      appendCustomMessageEntry: (customType, content, display, details) =>
        this.sessionManager.appendCustomMessageEntry(customType, content, display, details),
      readContextState: () => this.sessionManager.readContextState?.(),
      readTurnEventState: () => ({
        turnIndex: this.#turnIndex,
        turnStartTimestamp: this.#turnStartTimestamp,
      }),
      writeTurnEventState: (state) => {
        this.#turnIndex = state.turnIndex;
        this.#turnStartTimestamp = state.turnStartTimestamp;
      },
    });
    this.#phaseCoordinator = new ManagedSessionPhaseCoordinator({
      getTurn: () => this.resolvePhaseTurn(),
      emitPhaseChange: ({ phase, previousPhase }) =>
        this.#eventBridge.emitSessionPhaseChange({ phase, previousPhase }),
      warnOnIncompatibleReconciledSessionPhase: (previousPhase, nextPhase) =>
        this.warnOnIncompatibleReconciledSessionPhase(previousPhase, nextPhase),
    });
    this.#deferredCompaction = new ManagedSessionDeferredCompactionCoordinator({
      flow: this.#compactionFlow,
      isStreaming: () => this.isStreaming,
      preview: (request) => this.previewDeferredCompaction(request),
      build: (prepared) => this.buildDeferredCompactionEvents(prepared),
      finalize: (prepared, built) => this.finalizeDeferredCompaction(prepared, built),
      salvage: (prepared, built, mode) => this.salvageDeferredCompaction(prepared, built, mode),
      rollback: (prepared) => this.rollbackDeferredCompaction(prepared),
    });
    this.#providerCacheState = new ManagedSessionProviderCacheState({
      getSessionId: () => this.sessionManager.getSessionId(),
      clearToolSchemaSnapshot: (reason) => this.#toolSchemaSnapshotStore.clear(reason),
      clearProviderSessions: (sessionId) => clearApiProviderSessions(sessionId),
      logger: this.#logger ?? undefined,
    });
    this.#toolRegistry = new ManagedSessionToolRegistry({
      resolveSchemaSnapshot: (tools, invalidationReason) =>
        this.#toolSchemaSnapshotStore.resolve(
          tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
          invalidationReason,
        ),
    });
    this.#modelSelection = new ManagedSessionModelSelectionController({
      initialState:
        input.modelPresetState ??
        input.settings.getModelPresetState?.() ??
        createFallbackModelPresetState(
          input.sessionStore.buildSessionContext().activeModelPresetName,
        ),
      catalog: input.catalog,
      getCurrentModel: () => this.model,
      getCurrentThinkingLevel: () => this.thinkingLevel,
      compactBeforeModelDownshiftIfNeeded: (previousModel, nextModel) =>
        this.compactBeforeModelDownshiftIfNeeded(previousModel, nextModel),
      setCurrentModel: (model) => this.#agent.setModel(model),
      setSelectedModelPreference: (model) => input.settings.setSelectedModelPreference?.(model),
      applyThinkingLevel: (level, options) => this.applyThinkingLevel(level, options),
      clearProviderCacheSessionState: () => this.clearProviderCacheSessionState(),
      appendModelPresetSelection: (selection) =>
        this.sessionManager.appendModelPresetSelection(selection),
      appendModelChange: (provider, modelId) =>
        this.sessionManager.appendModelChange(provider, modelId),
      emitModelSelect: ({ model, previousModel, source }) => {
        if (!this.#initialPersistenceEnsured) {
          return Promise.resolve();
        }
        return this.#eventBridge.emitModelSelect({ model, previousModel, source });
      },
    });
  }

  static async create(
    options: CreateBrewvaManagedAgentSessionOptions,
  ): Promise<BrewvaManagedAgentSession> {
    const toolDefinitions = [...(options.customTools ?? [])];
    let session: BrewvaManagedAgentSession | undefined;

    const runner = await createBrewvaHostPluginRunner({
      plugins: options.extensions,
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
          const existingIndex = toolDefinitions.findIndex(
            (candidate) => candidate.name === tool.name,
          );
          if (existingIndex >= 0) {
            toolDefinitions[existingIndex] = tool;
          } else {
            toolDefinitions.push(tool);
          }
          session?.registerHostedTool(tool);
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
        )}. Add createHostedBehaviorHostAdapter(...).`,
      );
    }

    const providerCacheRuntime: ProviderCacheRuntimeState = {
      lastProviderFingerprint: undefined,
      lastCacheRender: undefined,
      lastCacheRenderModelKey: undefined,
      lastGoogleCredential: undefined,
      lastGoogleModelBaseUrl: undefined,
    };
    const cacheBreakDetector = new ProviderCacheBreakDetector({
      diagnosticDumpDirectory: resolveProviderCacheDiagnosticDumpDirectory(options.cwd),
    });
    const googleCachedContentManager =
      options.googleCachedContentManager ?? DEFAULT_GOOGLE_CACHED_CONTENT_MANAGER;
    const compactionSummaryGenerator =
      options.compactionSummaryGenerator ??
      createHostedLlmCompactionSummaryGenerator({
        resolveAuth: (model) => options.modelCatalog.getApiKeyAndHeaders(model),
      });
    const sessionTitleGenerator =
      options.sessionTitleGenerator ??
      createHostedSessionTitleGenerator({
        resolveAuth: (model) => options.modelCatalog.getApiKeyAndHeaders(model),
      });
    const sessionId = options.sessionStore.getSessionId();
    const releaseGoogleCachedContent = () => {
      // Best-effort cleanup uses the latest Google credential. If the user rotates accounts mid-session,
      // delete may fail and fall back to the manager's pending-delete retry policy.
      void googleCachedContentManager
        .releaseSession(options.cwd, sessionId, providerCacheRuntime.lastGoogleCredential)
        .catch(() => undefined);
    };
    const clearCacheState = options.runtime?.operator.session.state.onClear((clearedSessionId) => {
      if (clearedSessionId === sessionId) {
        cacheBreakDetector.clear();
        providerCacheRuntime.lastProviderFingerprint = undefined;
        providerCacheRuntime.lastCacheRender = undefined;
        providerCacheRuntime.lastCacheRenderModelKey = undefined;
        googleCachedContentManager.resetCapability(
          options.cwd,
          providerCacheRuntime.lastGoogleModelBaseUrl,
        );
        providerCacheRuntime.lastGoogleModelBaseUrl = undefined;
        releaseGoogleCachedContent();
        session?.clearProviderCacheSessionStateBestEffort();
      }
    });

    const agent = createBrewvaTurnLoopController({
      initialModel: options.initialModel,
      initialThinkingLevel: toTurnLoopThinkingLevel(options.initialThinkingLevel),
      queueMode: options.settings.getQueueMode(),
      followUpMode: options.settings.getFollowUpMode(),
      transport: options.settings.getTransport(),
      cachePolicy: options.settings.getCachePolicy(),
      thinkingBudgets: options.settings.getThinkingBudgets(),
      maxRetryDelayMs: options.settings.getRetrySettings()?.maxDelayMs,
      sessionId,
      streamFn: createHostedProviderStreamFunction(),
      resolveRequestAuth: async (model) => options.modelCatalog.getApiKeyAndHeaders(model),
      beforeToolCall: async (input: BrewvaTurnLoopBeforeToolCallContext) => {
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
      afterToolCall: async (input: BrewvaTurnLoopAfterToolCallContext) => {
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
      onPayload: async (payload, model, metadata) => {
        if (!session) {
          return payload;
        }
        let nextPayload = await runner.emitBeforeProviderRequest(
          {
            type: "before_provider_request",
            payload,
            provider: model.provider,
            api: model.api,
            modelId: model.id,
          },
          session.createHostContext(),
        );
        if (options.runtime) {
          const channelContext = session.resolveProviderCacheChannelContext();
          const cachePolicy = options.settings.getCachePolicy();
          let cacheRender = normalizeProviderCacheRender({
            metadata,
            model,
            transport: options.settings.getTransport(),
            sessionId,
            cachePolicy,
            previousRender: providerCacheRuntime.lastCacheRender,
            previousRenderModelKey: providerCacheRuntime.lastCacheRenderModelKey,
          });
          if (model.api === "google-gemini-cli") {
            const auth = await options.modelCatalog.getApiKeyAndHeaders(model);
            providerCacheRuntime.lastGoogleCredential = auth.ok ? auth.apiKey : undefined;
            providerCacheRuntime.lastGoogleModelBaseUrl = model.baseUrl;
            const googleCache = await googleCachedContentManager.apply({
              workspaceRoot: options.cwd,
              sessionId,
              cachePolicy,
              credential: auth.ok ? auth.apiKey : undefined,
              payload: nextPayload,
              modelBaseUrl: model.baseUrl,
            });
            nextPayload = googleCache.payload;
            if (googleCache.render) {
              cacheRender = {
                status: googleCache.render.status,
                reason: googleCache.render.reason,
                renderedRetention: googleCache.render.renderedRetention,
                bucketKey: googleCache.render.bucketKey,
                capability: googleCache.render.capability,
                cachedContentName: googleCache.render.cachedContentName,
                cachedContentTtlSeconds: googleCache.render.cachedContentTtlSeconds,
              };
            }
          }
          providerCacheRuntime.lastCacheRender = cacheRender;
          providerCacheRuntime.lastCacheRenderModelKey = buildProviderCacheModelKey(model);
          const toolSchemaSnapshot = session.resolveProviderToolSchemaSnapshot("provider_payload");
          const stickyLatches = session.observeProviderCacheStickyLatches({
            cachePolicy,
            cacheRender,
            transport: options.settings.getTransport(),
            reasoning: metadata?.reasoning ?? agent.state.thinkingLevel,
            channelContext,
          });
          const transientReduction =
            options.runtime.inspect.context.prompt.getTransientReduction(sessionId);
          const visibleHistoryReduction = {
            epoch: options.runtime.inspect.context.visibleRead.getEpoch(sessionId),
            transientReductionStatus: transientReduction?.status ?? "none",
            transientReductionClassification: transientReduction?.classification ?? null,
            expectedCacheBreak: transientReduction?.expectedCacheBreak ?? false,
          };
          const workbenchContext = session.#lastWorkbenchContextFingerprint;
          providerCacheRuntime.lastProviderFingerprint = createProviderRequestFingerprint({
            provider: model.provider,
            api: model.api,
            model: model.id,
            transport: options.settings.getTransport(),
            sessionId,
            cachePolicy,
            toolSchemaSnapshot,
            stablePrefixParts: [agent.state.systemPrompt],
            dynamicTailParts: [
              buildProviderDynamicTailSummary({
                payload: nextPayload,
                channelContext,
                workbenchContext,
                visibleHistoryReduction,
              }),
            ],
            channelContext,
            renderedCache: cacheRender,
            stickyLatches,
            reasoning: metadata?.reasoning ?? agent.state.thinkingLevel,
            thinkingBudgets: metadata?.thinkingBudgets ?? options.settings.getThinkingBudgets(),
            cacheRelevantHeaders: metadata?.headers,
            extraBody: metadata?.extraBody,
            visibleHistoryReduction,
            workbenchContext,
            providerFallback: metadata?.providerFallback ?? { active: false },
            payload: nextPayload,
          });
        }
        return nextPayload;
      },
      onCacheRender: (render, model) => {
        providerCacheRuntime.lastCacheRender = {
          status: render.status,
          reason: render.reason,
          renderedRetention: render.renderedRetention,
          bucketKey: render.bucketKey,
          capability: render.capability,
          cachedContentName: render.cachedContentName,
          cachedContentTtlSeconds: render.cachedContentTtlSeconds,
        };
        providerCacheRuntime.lastCacheRenderModelKey = buildProviderCacheModelKey(model);
      },
      transformContext: async (messages) => {
        if (!session) {
          return messages;
        }
        return runner.emitContext(
          { type: "context", messages },
          session.createHostContext(),
        ) as Promise<BrewvaTurnLoopMessage[]>;
      },
      resolveFile: (part) => resolvePromptFilePart(options.cwd, part),
      shouldStopAfterToolResults: (toolResults) =>
        session?.consumeToolResultStop(toolResults) ?? false,
    });

    const providerAssistantObserver = new ManagedSessionProviderAssistantObserver({
      runtime: options.runtime,
      workspaceRoot: options.cwd,
      sessionId,
      googleCachedContentManager,
      cacheBreakDetector,
      resolveExpectedBreak: () =>
        options.runtime ? resolveExpectedProviderCacheBreak(options.runtime, sessionId) : undefined,
      state: () => ({
        lastProviderFingerprint: providerCacheRuntime.lastProviderFingerprint,
        lastCacheRender: providerCacheRuntime.lastCacheRender,
        lastGoogleModelBaseUrl: providerCacheRuntime.lastGoogleModelBaseUrl,
      }),
    });

    session = new BrewvaManagedAgentSession({
      cwd: options.cwd,
      settings: options.settings,
      catalog: options.modelCatalog,
      resourceLoader: options.resourceLoader,
      sessionStore: options.sessionStore,
      modelPresetState: options.initialModelPresetState,
      customTools: toolDefinitions,
      runner,
      agent,
      compactionSummaryGenerator,
      sessionTitleGenerator,
      ui: options.ui,
      runtime: options.runtime,
      logger: options.logger,
      onProviderAssistantMessage: (message) =>
        providerAssistantObserver.onCommittedAssistantMessage(message),
      onInitialPersistence: options.onInitialPersistence,
      onDispose: () => {
        releaseGoogleCachedContent();
        clearCacheState?.();
      },
    });
    await session.initialize();
    if (!options.deferPersistenceUntilPrompt) {
      await session.ensureInitialPersistence();
    }
    return session;
  }

  async initialize(): Promise<void> {
    this.refreshTools();
    const restoredMessages = this.sessionManager.buildSessionContext().messages;
    if (restoredMessages.length > 0) {
      await this.replaceMessages(restoredMessages);
    }
    const bootstrapPhase = resolveManagedSessionBootstrapPhase(
      this.sessionManager,
      this.resolvePhaseTurn(),
    );
    if (bootstrapPhase) {
      await this.reconcileSessionPhase(bootstrapPhase);
    }
    this.#agent.subscribe((event) => this.handleAgentEvent(event));
    this.#unsubscribeSessionWire = subscribeManagedSessionWireHydration(this.sessionManager, {
      resolvePhaseTurn: () => this.resolvePhaseTurn(),
      reconcileSessionPhase: (phase) => this.reconcileSessionPhase(phase),
      transitionCrashAndResume: (anchor) => this.transitionCrashAndResume(anchor),
      getSessionPhase: () => this.getSessionPhase(),
      syncContextState: () => this.syncContextState(),
    });
    if (this.#runtime) {
      this.#unsubscribeSessionTitleCoordinator = new SessionTitleCoordinator({
        runtime: this.#runtime,
        sessionId: this.sessionManager.getSessionId(),
        catalog: this.#catalog,
        generator: this.#sessionTitleGenerator,
        getCurrentModel: () => this.model,
        getActiveModelPreset: () => {
          const state = this.#modelSelection.getState();
          return state.presets.find((preset) => preset.name === state.activeName);
        },
        logger: this.#logger ?? undefined,
      }).start();
    }
    await this.syncContextState();
  }

  get model(): BrewvaSessionModelDescriptor | undefined {
    const model = this.#agent.state.model;
    return model ? this.#catalog.find(model.provider, model.id) : undefined;
  }

  get thinkingLevel(): BrewvaPromptThinkingLevel {
    return this.#agent.state.thinkingLevel as BrewvaPromptThinkingLevel;
  }

  get isStreaming(): boolean {
    return this.#agent.state.isStreaming;
  }

  get isCompacting(): boolean {
    return this.#deferredCompaction.isCompacting;
  }

  getModelPresetState(): BrewvaModelPresetState {
    return this.#modelSelection.getState();
  }

  queueModelPresetForNextTurn(name: string): BrewvaModelPresetSelectionResult {
    return this.#modelSelection.queueModelPresetForNextTurn(name);
  }

  async selectModelPreset(
    request: BrewvaModelPresetSelectionRequest,
  ): Promise<BrewvaModelPresetSelectionResult> {
    return this.#modelSelection.selectModelPreset(request);
  }

  private async applyQueuedModelPreset(): Promise<void> {
    await this.#modelSelection.applyQueuedModelPreset();
  }

  getContextState(): ContextState {
    return this.#eventBridge.getContextState();
  }

  getQueuedPrompts(): readonly BrewvaQueuedPromptView[] {
    return this.#deferredTurnState.getQueuedPromptViews();
  }

  removeQueuedPrompt(promptId: string): boolean {
    const removed = this.#deferredTurnState.removeQueuedPrompt(promptId, (message, behavior) =>
      this.#agent.removeQueuedMessage(message, behavior),
    );
    if (!removed) {
      return false;
    }
    this.emitQueuedPromptChange();
    return true;
  }

  getRegisteredTools(): readonly BrewvaToolDefinition[] {
    return this.#toolRegistry.listRegisteredTools();
  }

  resolveProviderCacheChannelContext(): { source: string } | "" {
    return resolveChannelContext(this.#activePromptSource);
  }

  async prompt(
    parts: readonly BrewvaPromptContentPart[],
    options?: BrewvaPromptOptions,
  ): Promise<void> {
    await this[HOSTED_PROMPT_ATTEMPT_DISPATCH](parts, options);
  }

  async [HOSTED_PROMPT_ATTEMPT_DISPATCH](
    parts: readonly BrewvaPromptContentPart[],
    options?: BrewvaPromptOptions,
  ): Promise<void> {
    await this.waitForProviderCacheSessionClear();
    await this.applyQueuedModelPreset();
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;
    let currentParts = cloneBrewvaPromptContentParts(parts);
    const command =
      expandPromptTemplates && promptPartsArePlainText(currentParts)
        ? parseCommand(buildBrewvaPromptText(currentParts))
        : null;
    if (command) {
      const handled = await this.tryExecuteRegisteredCommand(command.name, command.args);
      if (handled) {
        await this.flushCommandDispatchBuffer();
        return;
      }
    }

    await this.ensureInitialPersistence();

    if (this.#runner.hasHandlers("input")) {
      const result = await this.#runner.emitInput(
        {
          type: "input",
          text: buildBrewvaPromptText(currentParts),
          parts: currentParts,
          source: options?.source,
        },
        this.createHostContext(),
      );
      if (result.action === "handled") {
        return;
      }
      if (result.action === "transform") {
        currentParts = cloneBrewvaPromptContentParts(result.parts);
      }
    }

    if (expandPromptTemplates && promptPartsArePlainText(currentParts)) {
      let expandedText = buildBrewvaPromptText(currentParts);
      expandedText = buildSkillCommandText(expandedText, this.#resourceLoader);
      expandedText = expandBrewvaPromptTemplate(
        expandedText,
        this.#resourceLoader.getPrompts().prompts,
      );
      currentParts = buildTextPromptParts(expandedText);
    }

    if (this.isStreaming) {
      const behavior = options?.streamingBehavior ?? "queue";
      await this.queueUserMessage(currentParts, behavior);
      return;
    }

    if (!this.model) {
      throw new Error("No model selected.");
    }
    if (!this.#catalog.hasConfiguredAuth(this.model as BrewvaRegisteredModel)) {
      throw new Error(`No API key found for ${this.model.provider}/${this.model.id}.`);
    }

    const messages: BrewvaTurnLoopMessage[] = [
      {
        role: "user",
        content: toAgentUserContent(currentParts),
        timestamp: Date.now(),
      },
      ...this.#deferredTurnState.consumeNextTurnMessages(),
    ];

    const beforeStart = await this.#runner.emitBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: buildBrewvaPromptText(currentParts),
        parts: cloneBrewvaPromptContentParts(currentParts),
        systemPrompt: this.#baseSystemPrompt,
      },
      this.createHostContext(),
    );
    this.#lastWorkbenchContextFingerprint = resolveWorkbenchContextFingerprint(
      beforeStart?.messages,
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

    this.#liveTranscript.applyPromptOverlay(beforeStart?.systemPrompt ?? this.#baseSystemPrompt);
    await this.syncContextState();
    const previousPromptSource = this.#activePromptSource;
    this.#activePromptSource = normalizePromptSource(options?.source);
    try {
      await this.#agent.prompt(messages);
    } finally {
      this.#activePromptSource = previousPromptSource;
    }
  }

  async steer(text: string, options?: BrewvaSteerOptions): Promise<BrewvaSteerOutcome> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { status: "rejected_empty" };
    }
    if (!this.#agent.steer(trimmed)) {
      return { status: "no_active_run" };
    }
    this.#recordRuntimeEvent(
      STEER_QUEUED_EVENT_TYPE,
      buildSteerAuditPayload(trimmed, {
        source: normalizePromptSource(options?.source) ?? null,
      }),
    );
    return { status: "queued", chars: trimmed.length };
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

  setUiPort(ui: BrewvaToolUiPort): void {
    this.#ui = ui;
  }

  async setModel(model: BrewvaSessionModelDescriptor): Promise<void> {
    await this.#modelSelection.setModel(model);
  }

  private shouldCompactBeforeModelDownshift(
    previousModel: BrewvaSessionModelDescriptor | undefined,
    nextModel: BrewvaSessionModelDescriptor,
  ): boolean {
    if (!this.#runtime || this.isStreaming || this.isCompacting || !previousModel) {
      return false;
    }
    return shouldCompactForModelDownshift({
      runtime: this.#runtime,
      sessionId: this.sessionManager.getSessionId(),
      currentModel: previousModel,
      targetModel: nextModel,
    });
  }

  private async compactBeforeModelDownshiftIfNeeded(
    previousModel: BrewvaSessionModelDescriptor | undefined,
    nextModel: BrewvaSessionModelDescriptor,
  ): Promise<void> {
    if (!this.shouldCompactBeforeModelDownshift(previousModel, nextModel)) {
      return;
    }

    await requestCompactionAndWait((request) => this.requestCompaction(request), {
      customInstructions: MODEL_DOWNSHIFT_COMPACTION_INSTRUCTIONS,
    });
  }

  setThinkingLevel(level: BrewvaPromptThinkingLevel): void {
    this.applyThinkingLevel(level, { persistDefault: true });
  }

  private applyThinkingLevel(
    level: BrewvaPromptThinkingLevel,
    options: { persistDefault: boolean },
  ): void {
    const available = this.getAvailableThinkingLevels();
    const effective = available.includes(level)
      ? level
      : (available[available.length - 1] ?? "off");
    const previousThinkingLevel = this.#agent.state.thinkingLevel as BrewvaPromptThinkingLevel;
    const changed = effective !== previousThinkingLevel;
    this.#agent.setThinkingLevel(toTurnLoopThinkingLevel(effective));
    if (changed) {
      this.sessionManager.appendThinkingLevelChange(effective);
      if (options.persistDefault) {
        this.#settings.setDefaultThinkingLevel(effective);
      }
      if (this.#initialPersistenceEnsured) {
        this.#eventBridge.emitThinkingLevelSelect({
          thinkingLevel: effective,
          previousThinkingLevel,
          source: "set",
        });
      }
    }
  }

  async replaceMessages(messages: unknown): Promise<void> {
    await this.#liveTranscript.replacePersistedMessages(messages);
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
    this.#unsubscribeSessionTitleCoordinator?.();
    this.#unsubscribeSessionTitleCoordinator = null;
    this.#onDispose?.();
    clearDefaultTurnLifecycleSpine(this, this.sessionManager.getSessionId());
    this.sessionManager.dispose?.();
    this.#listeners.clear();
    if (this.#sessionStartEmitted) {
      this.#eventBridge.emitSessionShutdown();
    }
  }

  async ensureInitialPersistence(): Promise<void> {
    if (this.#initialPersistenceEnsured) {
      return;
    }
    this.#initialPersistenceEnsured = true;
    this.sessionManager.ensureInitialPersistence?.();
    await this.emitSessionStart();
    this.#onInitialPersistence?.();
  }

  private async emitSessionStart(): Promise<void> {
    if (this.#sessionStartEmitted) {
      return;
    }
    this.#sessionStartEmitted = true;
    await this.#eventBridge.emitSessionStart();
  }

  private resolveProviderToolSchemaSnapshot(invalidationReason: string): ToolSchemaSnapshot {
    const activeDefinitions = this.#toolRegistry.resolveDefinitions(this.getActiveToolNames());
    return this.#toolRegistry.buildSchemaSnapshot(activeDefinitions, invalidationReason);
  }

  private async waitForProviderCacheSessionClear(): Promise<void> {
    await this.#providerCacheState.waitForSessionClear();
  }

  private clearProviderCacheSessionState(): Promise<void> {
    return this.#providerCacheState.clearSessionState();
  }

  private clearProviderCacheSessionStateBestEffort(): void {
    this.#providerCacheState.clearSessionStateBestEffort();
  }

  private observeProviderCacheStickyLatches(
    input: Parameters<ManagedSessionProviderCacheState["observeStickyLatches"]>[0],
  ) {
    return this.#providerCacheState.observeStickyLatches(input);
  }

  private async markSessionCompactedForCacheState(): Promise<void> {
    await this.#providerCacheState.markSessionCompacted();
  }

  private refreshTools(): void {
    this.#toolRegistry.replaceAll(this.#registeredTools);
    const toolDefinitions = this.#toolRegistry.listRegisteredTools();
    const snapshot = this.#toolRegistry.buildSchemaSnapshot(toolDefinitions, "tool_refresh");
    const tools = this.#toolRegistry.buildAgentTools(toolDefinitions, snapshot, () =>
      this.createToolContext(),
    );
    this.#baseSystemPrompt = this.rebuildSystemPrompt();
    this.#liveTranscript.applyBaseContext({
      tools,
      systemPrompt: this.#baseSystemPrompt,
    });
  }

  private registerHostedTool(tool: BrewvaToolDefinition): void {
    const existingIndex = this.#registeredTools.findIndex(
      (candidate) => candidate.name === tool.name,
    );
    if (existingIndex >= 0) {
      this.#registeredTools[existingIndex] = tool;
    } else {
      this.#registeredTools.push(tool);
    }
    this.#toolRegistry.upsert(tool);
    this.#baseSystemPrompt = this.rebuildSystemPrompt();
    this.#liveTranscript.applyBaseSystemPrompt(this.#baseSystemPrompt);
  }

  private rebuildSystemPrompt(): string {
    return buildManagedSessionBaseSystemPrompt({
      cwd: this.#cwd,
      resourceLoader: this.#resourceLoader,
      activeToolNames: this.getActiveToolNames(),
      toolPromptInputs: this.#toolRegistry.buildPromptInputs(this.getActiveToolNames()),
    });
  }

  private getActiveToolNames(): string[] {
    return this.#agent.state.tools.map((tool) => tool.name);
  }

  private getAllToolInfo(): ReturnType<ManagedSessionToolRegistry["listInfo"]> {
    return this.#toolRegistry.listInfo();
  }

  private setActiveTools(toolNames: string[]): void {
    const selectedDefinitions = this.#toolRegistry.resolveDefinitions(toolNames);
    const snapshot = this.#toolRegistry.buildSchemaSnapshot(
      selectedDefinitions,
      "active_tool_set_changed",
    );
    const tools = this.#toolRegistry.buildAgentTools(selectedDefinitions, snapshot, () =>
      this.createToolContext(),
    );
    this.#baseSystemPrompt = this.rebuildSystemPrompt();
    this.#liveTranscript.applyBaseContext({
      tools,
      systemPrompt: this.#baseSystemPrompt,
    });
  }

  private async tryExecuteRegisteredCommand(name: string, args: string): Promise<boolean> {
    const command = this.#runner.getRegisteredCommands().get(name);
    if (!command) {
      return false;
    }
    this.#commandDispatchGate.begin();
    try {
      await command.handler(args, this.createCommandContext());
      return true;
    } finally {
      this.#commandDispatchGate.finishAfterCommand();
    }
  }

  private async flushCommandDispatchBuffer(): Promise<void> {
    const buffer = this.#commandDispatchGate.consumeBufferedItems();
    if (buffer.length === 0) {
      return;
    }
    for (const item of buffer) {
      if (item.kind === "user") {
        await this.prompt(item.parts, {
          expandPromptTemplates: false,
          source: "extension",
        });
        continue;
      }
      await this.sendCustomMessage(item.message, { triggerTurn: true });
    }
  }

  private async queueUserMessage(
    parts: readonly BrewvaPromptContentPart[],
    behavior: BrewvaPromptQueueBehavior,
  ): Promise<void> {
    const entry = this.#deferredTurnState.enqueueStreamingUserPrompt(parts, behavior);
    if (behavior === "followUp") {
      this.#agent.followUp(entry.message);
    } else {
      this.#agent.queue(entry.message);
    }
    this.emitQueuedPromptChange();
  }

  private async sendCustomMessage(
    message: BrewvaHostCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: BrewvaHostCustomMessageDelivery },
  ): Promise<void> {
    const customMessage: Extract<BrewvaTurnLoopMessage, { role: "custom" }> = {
      role: "custom",
      customType: message.customType,
      content: message.content,
      display: message.display ?? true,
      details: message.details,
      timestamp: Date.now(),
    };

    if (options?.deliverAs === "nextTurn") {
      this.#deferredTurnState.pushNextTurnMessage(customMessage);
      return;
    }

    if (options?.deliverAs === "transcript") {
      await this.#eventBridge.appendPassiveCustomMessage(customMessage, { transcript: true });
      return;
    }

    if (
      !this.isStreaming &&
      options?.triggerTurn &&
      this.#commandDispatchGate.bufferTriggeredCustom(message)
    ) {
      return;
    }

    if (this.isStreaming) {
      if (options?.deliverAs === "followUp") {
        this.#agent.followUp(customMessage);
      } else {
        this.#agent.queue(customMessage);
      }
      return;
    }

    if (options?.triggerTurn) {
      await this.#agent.prompt(customMessage);
      return;
    }

    await this.#eventBridge.appendPassiveCustomMessage(customMessage);
  }

  private async sendUserMessage(
    content: BrewvaPromptContentPart[],
    options?: { deliverAs?: "queue" | "followUp" },
  ): Promise<void> {
    if (!this.isStreaming && this.#commandDispatchGate.bufferUser(content)) {
      return;
    }

    await this.prompt(content, {
      expandPromptTemplates: false,
      streamingBehavior: options?.deliverAs,
      source: "extension",
    });
  }

  private createToolContext(): BrewvaToolContext {
    return {
      ui: this.#ui,
      hasUI: this.#ui !== NOOP_UI,
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
      hasPendingMessages: () => this.#deferredTurnState.hasPending(this.#agent.hasQueuedMessages()),
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

  private async handleAgentEvent(event: BrewvaTurnLoopEvent): Promise<BrewvaTurnLoopEvent> {
    if (event.type === "message_start" && event.message.role === "user") {
      this.deleteQueuedMessage(event.message);
    }
    if (event.type === "steer_applied") {
      this.#recordRuntimeEvent(
        STEER_APPLIED_EVENT_TYPE,
        buildSteerAuditPayload(event.text, {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        }),
      );
    }
    if (event.type === "steer_dropped") {
      this.#recordRuntimeEvent(
        STEER_DROPPED_EVENT_TYPE,
        buildSteerAuditPayload(event.text, {
          reason: event.reason,
        }),
      );
    }

    await this.#phaseCoordinator.advanceFromAgentEvent(event);
    const eventForListeners = await this.#eventBridge.emitTurnLoopEvent(event);
    this.emitToListeners(eventForListeners as BrewvaPromptSessionEvent);
    await this.syncContextState();
    if (
      eventForListeners.type === "message_end" &&
      eventForListeners.message.role === "toolResult"
    ) {
      if (await this.#deferredCompaction.flushAfterCommittedToolResult()) {
        await this.syncContextState();
      }
    }
    if (
      eventForListeners.type === "message_end" &&
      eventForListeners.message.role === "assistant"
    ) {
      this.#onProviderAssistantMessage?.(eventForListeners.message);
    }
    return eventForListeners;
  }

  requestCompaction(request?: BrewvaCompactionRequest): void {
    void this.#deferredCompaction.request(request);
  }

  private async resolveCompactionSummary(input: {
    sessionId: string;
    messages: readonly unknown[];
    customInstructions?: string;
  }): Promise<ResolvedCompactionSummary> {
    try {
      const stateModel = this.#agent.state.model;
      const model = stateModel ? this.#catalog.find(stateModel.provider, stateModel.id) : undefined;
      if (!model) {
        throw new Error("compaction_summary_model_unavailable");
      }
      const generated = await this.#compactionSummaryGenerator({
        sessionId: input.sessionId,
        cwd: this.#cwd,
        model,
        messages: input.messages,
        systemPrompt: this.#agent.state.systemPrompt,
        customInstructions: input.customInstructions,
        summaryMaxOutputRatio:
          this.#runtime?.config.infrastructure.contextBudget.compaction.summaryMaxOutputRatio,
      });
      return {
        summary: normalizeCompactionSummaryForStorage(generated.summary),
        strategy: generated.strategy ?? LLM_PRIMARY_COMPACTION_STRATEGY,
        model: generated.model ?? {
          provider: model.provider,
          id: model.id,
          api: model.api,
        },
        usage: generated.usage,
      };
    } catch (error) {
      return {
        summary: buildBrewvaDeterministicCompactionSummary(input.messages),
        strategy: DETERMINISTIC_EMERGENCY_COMPACTION_STRATEGY,
        fallbackReason: compactionFallbackReason(error),
      };
    }
  }

  private recordCompactionGenerationCost(
    sessionId: string,
    resolution: ResolvedCompactionSummary,
  ): void {
    if (!this.#runtime || !resolution.model || !resolution.usage) {
      return;
    }
    this.#runtime.authority.cost.usage.recordAssistant({
      sessionId,
      model: `${resolution.model.provider}/${resolution.model.id}`,
      inputTokens: nonNegativeUsageNumber(resolution.usage.input),
      outputTokens: nonNegativeUsageNumber(resolution.usage.output),
      cacheReadTokens: nonNegativeUsageNumber(resolution.usage.cacheRead),
      cacheWriteTokens: nonNegativeUsageNumber(resolution.usage.cacheWrite),
      totalTokens: nonNegativeUsageNumber(resolution.usage.totalTokens),
      costUsd: nonNegativeUsageNumber(resolution.usage.cost?.total),
      stopReason: "compaction_summary",
    });
  }

  private consumeToolResultStop(_toolResults: BrewvaTurnLoopToolResultMessage[]): boolean {
    return this.#deferredCompaction.consumeToolResultStop(_toolResults);
  }

  private async previewDeferredCompaction(
    request: BrewvaCompactionRequest,
  ): Promise<PreparedDeferredCompaction> {
    const branchEntries = this.sessionManager.getBranch();
    const originalContext = this.sessionManager.buildSessionContext();
    const sessionId = this.sessionManager.getSessionId();
    const sourceLeafEntryId = this.sessionManager.getLeafId() ?? null;
    const summaryResolution = await this.resolveCompactionSummary({
      sessionId,
      messages: originalContext.messages,
      customInstructions: request.customInstructions,
    });
    const summary = summaryResolution.summary;
    const summaryGeneration = buildCompactionSummaryGenerationMetadata(summaryResolution);
    this.recordCompactionGenerationCost(sessionId, summaryResolution);
    const tokensBefore = estimateBrewvaCompactionTokens(originalContext.messages);
    const preview = this.sessionManager.previewCompaction(
      summary,
      tokensBefore,
      randomUUID(),
      sourceLeafEntryId,
    );
    return {
      request,
      sessionId,
      branchEntries,
      originalContext,
      sourceLeafEntryId,
      summary,
      summaryGeneration,
      preview,
    };
  }

  private buildDeferredCompactionEvents(
    prepared: PreparedDeferredCompaction,
  ): BuiltDeferredCompactionEvents {
    return {
      beforeCompactEvent: {
        type: "session_before_compact",
        preparation: {
          ...prepared.summaryGeneration,
        },
        branchEntries: prepared.branchEntries,
        customInstructions: prepared.request.customInstructions,
      },
      compactEvent: {
        type: "session_compact",
        compactionEntry: {
          id: prepared.preview.compactId,
          summary: prepared.summary,
          content: prepared.summary,
          text: prepared.summary,
          sourceLeafEntryId: prepared.preview.sourceLeafEntryId,
          firstKeptEntryId: prepared.preview.firstKeptEntryId,
          tokensBefore: prepared.preview.tokensBefore,
          summaryGeneration: prepared.summaryGeneration,
        },
        fromExtension: false,
      },
    };
  }

  private async finalizeDeferredCompaction(
    prepared: PreparedDeferredCompaction,
    built: BuiltDeferredCompactionEvents,
  ): Promise<void> {
    await this.#runner.emit(
      "session_before_compact",
      built.beforeCompactEvent,
      this.createHostContext(),
    );
    this.emitToListeners(built.beforeCompactEvent);
    await this.replaceMessages(prepared.preview.context.messages);
    await this.#runner.emit("session_compact", built.compactEvent, this.createHostContext());
    this.emitToListeners(built.compactEvent);
    await this.markSessionCompactedForCacheState();
    prepared.request.onComplete?.(built.compactEvent);
  }

  private async salvageDeferredCompaction(
    prepared: PreparedDeferredCompaction,
    built: BuiltDeferredCompactionEvents,
    mode: DeferredCompactionSalvageMode,
  ): Promise<boolean> {
    if (mode === "persisted-preview") {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await Promise.resolve();
        await new Promise((settle) => setTimeout(settle, 0));
        const persistedBranch = this.sessionManager.getBranch();
        const persistedLeaf = persistedBranch[persistedBranch.length - 1];
        const persistedContext = this.sessionManager.buildSessionContext();
        if (
          (persistedLeaf?.type === "compaction" &&
            persistedLeaf.summary === prepared.summary &&
            persistedLeaf.firstKeptEntryId === prepared.preview.firstKeptEntryId &&
            persistedLeaf.tokensBefore === prepared.preview.tokensBefore) ||
          sameSessionMessages(persistedContext.messages, prepared.preview.context.messages)
        ) {
          await this.replaceMessages(persistedContext.messages);
          this.emitToListeners(built.compactEvent);
          await this.markSessionCompactedForCacheState();
          prepared.request.onComplete?.(built.compactEvent);
          return true;
        }
      }
      return false;
    }

    await Promise.resolve();
    await new Promise((settle) => setTimeout(settle, 0));
    const settledBranch = this.sessionManager.getBranch();
    const settledLeaf = settledBranch[settledBranch.length - 1];
    if (settledLeaf?.type !== "compaction") {
      return false;
    }
    const settledContext = this.sessionManager.buildSessionContext();
    await this.replaceMessages(settledContext.messages);
    this.emitToListeners(built.compactEvent);
    await this.markSessionCompactedForCacheState();
    prepared.request.onComplete?.(built.compactEvent);
    return true;
  }

  private async rollbackDeferredCompaction(prepared: PreparedDeferredCompaction): Promise<void> {
    await this.replaceMessages(prepared.originalContext.messages);
  }

  private async transitionCrashAndResume(anchor: string): Promise<void> {
    await this.#phaseCoordinator.transitionCrashAndResume(anchor);
  }

  private async transitionSessionPhase(event: SessionPhaseEvent): Promise<void> {
    await this.#phaseCoordinator.transition(event);
  }

  private async reconcileSessionPhase(nextPhase: SessionPhase): Promise<void> {
    await this.#phaseCoordinator.reconcile(nextPhase);
  }

  private warnOnIncompatibleReconciledSessionPhase(
    previousPhase: SessionPhase,
    nextPhase: SessionPhase,
  ): void {
    const validationEvent = deriveCompatibilityValidationEvent(previousPhase, nextPhase);
    if (!validationEvent) {
      return;
    }
    if (canTransitionSessionPhase(previousPhase, validationEvent)) {
      return;
    }
    const fields = {
      validationEvent: validationEvent.type,
      previousKind: previousPhase.kind,
      nextKind: nextPhase.kind,
      previousPhase,
      nextPhase,
    };
    if (this.#logger) {
      this.#logger.warn("managed_agent_session_phase_reconcile_mismatch", fields);
      return;
    }
    console.warn("managed_agent_session_phase_reconcile_mismatch", fields);
  }

  private getSessionPhase(): SessionPhase {
    return this.#phaseCoordinator.get();
  }

  private resolvePhaseTurn(): number {
    return resolvePhaseTurn(this.#turnIndex);
  }

  private emitToListeners(event: BrewvaPromptSessionEvent): void {
    for (const listener of this.#listeners) {
      listener(event);
    }
  }

  private emitQueuedPromptChange(): void {
    this.emitToListeners({
      type: "queue.changed",
      items: this.getQueuedPrompts(),
    });
  }

  #recordRuntimeEvent(type: string, payload: Record<string, unknown>): void {
    if (!this.#runtime) {
      return;
    }
    this.#runtime.extensions.hosted.events.record({
      sessionId: this.sessionManager.getSessionId(),
      type,
      payload,
    });
  }

  private async syncContextState(): Promise<void> {
    await this.#eventBridge.syncContextState();
  }

  private deleteQueuedMessage(message: Extract<BrewvaTurnLoopMessage, { role: "user" }>): void {
    const deleted = this.#deferredTurnState.acknowledgeStartedQueuedUser(message);
    if (!deleted) {
      return;
    }
    this.emitQueuedPromptChange();
  }
}

export async function createBrewvaManagedAgentSession(
  options: CreateBrewvaManagedAgentSessionOptions,
): Promise<BrewvaManagedPromptSession> {
  return BrewvaManagedAgentSession.create(options);
}
