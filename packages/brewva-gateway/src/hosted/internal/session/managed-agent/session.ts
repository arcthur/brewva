import { clearApiProviderSessions } from "@brewva/brewva-provider-core/registry";
import {
  type BrewvaAgentProtocolEvent,
  type BrewvaAgentProtocolMessage,
} from "@brewva/brewva-substrate/agent-protocol";
import { decideCompaction } from "@brewva/brewva-substrate/context-budget";
import {
  createBrewvaHostPluginRunner,
  type BrewvaHostContext,
  type BrewvaHostCustomMessage,
  type BrewvaHostCustomMessageDelivery,
  type BrewvaHostPluginRunner,
  type BrewvaToolUiPort,
} from "@brewva/brewva-substrate/host-api";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
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
  type BrewvaModelRoleAlias,
  type BrewvaSteerOptions,
  type BrewvaSteerOutcome,
  type BrewvaPromptOptions,
  type BrewvaPromptQueueBehavior,
  type BrewvaQueuedPromptView,
  type BrewvaPromptSessionEvent,
  type BrewvaPromptThinkingLevel,
  type SessionPhase,
  type BrewvaSessionModelCatalogView,
  type ContextState,
  type BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import {
  type BrewvaCompactionRequest,
  BrewvaToolContext,
  BrewvaToolDefinition,
} from "@brewva/brewva-substrate/tools";
import {
  STEER_APPLIED_EVENT_TYPE,
  STEER_DROPPED_EVENT_TYPE,
  STEER_QUEUED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/wire";
import {
  collectHostedExtensionManifests,
  type VerificationGateManifest,
} from "../../../../extensions/api.js";
import { ManagedSessionDeferredCompactionCoordinator } from "../../compaction/deferred.js";
import { ManagedSessionCompactionFlowState } from "../../compaction/flow.js";
import {
  MODEL_DOWNSHIFT_COMPACTION_INSTRUCTIONS,
  requestCompactionAndWait,
  shouldCompactForModelDownshift,
} from "../../compaction/model-downshift-policy.js";
import {
  createHostedLlmCompactionSummaryGenerator,
  type BrewvaCompactionSummaryGenerator,
} from "../../compaction/summary-generator.js";
import { supportsHostedExtendedThinkingModel as supportsHostedExtendedThinking } from "../../provider/built-in-catalog.js";
import {
  ProviderCacheBreakDetector,
  createToolSchemaSnapshotStore,
  type ToolSchemaSnapshot,
} from "../../provider/cache/index.js";
import type { HostedSessionLogger } from "../../shared/logger.js";
import { HOSTED_PROMPT_ATTEMPT_DISPATCH } from "../../turn-adapter/hosted-prompt-attempt.js";
import {
  HOSTED_COMPACTION_BOUNDARY,
  type HostedCompactionBoundary,
} from "../../turn-adapter/runtime-turn-compaction.js";
import {
  HOSTED_RUNTIME_TURN_CONTEXT,
  HOSTED_RUNTIME_TURN_PRELUDE,
  type HostedRuntimeTurnContext,
  type HostedRuntimeTurnPreludeResult,
} from "../../turn-adapter/runtime-turn-prelude.js";
import { readRuntimeVerificationGateEvidenceFromEvent } from "../../turn-adapter/runtime-turn-verification-gates.js";
import { runHostedTurnEnvelope } from "../../turn-adapter/turn-envelope.js";
import {
  getRuntimeCompactionGateStatus,
  getRuntimeContextUsage,
  queryRuntimeEvents,
  type HostedRuntimeAdapterPort,
} from "../runtime-ports.js";
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
import { ManagedSessionCompactionLifecycle } from "./compaction-lifecycle.js";
import {
  ManagedSessionCommandDispatchGate,
  ManagedSessionCommandMessageRouter,
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
import { ManagedSessionProviderAssistantObserver } from "./provider-assistant-observer.js";
import {
  ManagedSessionProviderCacheState,
  resolveProviderCacheDiagnosticDumpDirectory,
} from "./provider-cache-state.js";
import { createProviderPayloadPipeline } from "./provider-payload-pipeline.js";
import {
  resolveWorkbenchContextFingerprint,
  WorkbenchContextFingerprintHolder,
} from "./provider-payload-summary.js";
import { ManagedRuntimeSessionController } from "./runtime-session-controller.js";
import {
  REQUIRED_HOSTED_PERSISTENCE_EVENTS,
  toTurnLoopThinkingLevel,
  type BrewvaManagedAgentSessionSettingsPort,
  type BuiltDeferredCompactionEvents,
  type CreateBrewvaManagedAgentSessionOptions,
  type ManagedAgentSessionStore,
  type PreparedDeferredCompaction,
  type PreparedManagedPromptDispatch,
  type RuntimeProviderCacheRenderInput,
  type RuntimeProviderPayloadInput,
} from "./session-contracts.js";
import {
  nextHarnessProviderAttemptSequence,
  recordRuntimeHarnessManifest,
  turnNumberFromTurnId,
} from "./session-harness-manifest.js";
import {
  hostedTurnSourceFromPromptOptions,
  prepareManagedPromptDispatch,
  type ManagedPromptDispatchDeps,
} from "./session-prompt-dispatch.js";
import {
  ManagedSessionToolRegistry,
  type ManagedSessionToolApplicationDeps,
} from "./tool-registry.js";
import {
  buildSteerAuditPayload,
  normalizePromptSource,
  recordSteeringAuditEvent,
  resolveChannelContext,
} from "./turn-audit.js";

export const MANAGED_AGENT_SESSION_TEST_ONLY = {
  nextHarnessProviderAttemptSequence,
  recordRuntimeHarnessManifest,
  resolveWorkbenchContextFingerprint,
  turnNumberFromTurnId,
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
  readonly #runtime: HostedRuntimeAdapterPort;
  readonly #settings: BrewvaManagedAgentSessionSettingsPort;
  readonly #catalog: BrewvaMutableModelCatalog;
  readonly #modelSelection: ManagedSessionModelSelectionController;
  readonly #resourceLoader: BrewvaHostedResourceLoader;
  readonly #agent: ManagedRuntimeSessionController;
  readonly #runner: BrewvaHostPluginRunner;
  readonly #verificationGateManifests: readonly VerificationGateManifest[];
  readonly #compactionSummaryGenerator: BrewvaCompactionSummaryGenerator;
  readonly #sessionTitleGenerator: BrewvaSessionTitleGenerator;
  readonly #toolSchemaSnapshotStore = createToolSchemaSnapshotStore();
  readonly #toolRegistry: ManagedSessionToolRegistry;
  readonly #providerCacheState: ManagedSessionProviderCacheState;
  readonly #deferredTurnState = new ManagedSessionDeferredTurnState();
  readonly #commandDispatchGate = new ManagedSessionCommandDispatchGate();
  readonly #compactionFlow = new ManagedSessionCompactionFlowState();
  readonly #compactionLifecycle: ManagedSessionCompactionLifecycle;
  readonly #deferredCompaction: ManagedSessionDeferredCompactionCoordinator<
    PreparedDeferredCompaction,
    BuiltDeferredCompactionEvents
  >;
  readonly #eventBridge: ManagedSessionEventBridge;
  readonly #liveTranscript: ManagedSessionLiveTranscript;
  readonly #phaseCoordinator: ManagedSessionPhaseCoordinator;
  readonly #promptDispatchDeps: ManagedPromptDispatchDeps;
  readonly #commandRouter: ManagedSessionCommandMessageRouter;
  readonly #listeners = new Set<(event: BrewvaPromptSessionEvent) => void>();
  #ui: BrewvaToolUiPort;
  #unsubscribeSessionWire: (() => void) | null = null;
  #unsubscribeSessionTitleCoordinator: (() => void) | null = null;
  #disposed = false;
  #turnIndex = 0;
  #turnStartTimestamp = 0;
  #activePromptSource: string | undefined;
  #runtimeTurnContext: HostedRuntimeTurnContext | null = null;
  readonly #workbenchContextFingerprint: WorkbenchContextFingerprintHolder;
  readonly #logger: HostedSessionLogger | null;
  readonly #onProviderAssistantMessage:
    | ((message: Extract<BrewvaAgentProtocolMessage, { role: "assistant" }>) => void)
    | undefined;
  readonly #prepareRuntimeProviderPayload:
    | ((input: RuntimeProviderPayloadInput) => Promise<unknown>)
    | undefined;
  readonly #observeRuntimeCacheRender:
    | ((input: RuntimeProviderCacheRenderInput) => void)
    | undefined;
  readonly #onDispose: (() => void) | undefined;
  readonly #onInitialPersistence: (() => void) | undefined;
  readonly #modelRole: BrewvaModelRoleAlias | undefined;
  #initialPersistenceEnsured = false;
  #sessionStartEmitted = false;

  constructor(input: {
    cwd: string;
    runtime: HostedRuntimeAdapterPort;
    settings: BrewvaManagedAgentSessionSettingsPort;
    catalog: BrewvaMutableModelCatalog;
    resourceLoader: BrewvaHostedResourceLoader;
    sessionStore: ManagedAgentSessionStore;
    modelPresetState?: BrewvaModelPresetState;
    modelRole?: BrewvaModelRoleAlias;
    customTools: readonly BrewvaToolDefinition[];
    runner: BrewvaHostPluginRunner;
    verificationGateManifests: readonly VerificationGateManifest[];
    agent: ManagedRuntimeSessionController;
    compactionSummaryGenerator: BrewvaCompactionSummaryGenerator;
    sessionTitleGenerator: BrewvaSessionTitleGenerator;
    ui?: BrewvaToolUiPort;
    logger?: HostedSessionLogger;
    onProviderAssistantMessage?: (
      message: Extract<BrewvaAgentProtocolMessage, { role: "assistant" }>,
    ) => void;
    prepareRuntimeProviderPayload?: (input: RuntimeProviderPayloadInput) => Promise<unknown>;
    observeRuntimeCacheRender?: (input: RuntimeProviderCacheRenderInput) => void;
    workbenchContextFingerprint: WorkbenchContextFingerprintHolder;
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
    this.#runner = input.runner;
    this.#verificationGateManifests = input.verificationGateManifests;
    this.#agent = input.agent;
    this.#compactionSummaryGenerator = input.compactionSummaryGenerator;
    this.#sessionTitleGenerator = input.sessionTitleGenerator;
    this.#logger = input.logger ?? null;
    this.#onProviderAssistantMessage = input.onProviderAssistantMessage;
    this.#prepareRuntimeProviderPayload = input.prepareRuntimeProviderPayload;
    this.#observeRuntimeCacheRender = input.observeRuntimeCacheRender;
    this.#workbenchContextFingerprint = input.workbenchContextFingerprint;
    this.#onInitialPersistence = input.onInitialPersistence;
    this.#onDispose = input.onDispose;
    this.#modelRole = input.modelRole;
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
    this.#compactionLifecycle = new ManagedSessionCompactionLifecycle({
      cwd: this.#cwd,
      runtime: this.#runtime,
      agentState: () => this.#agent.state,
      catalog: this.#catalog,
      compactionSummaryGenerator: this.#compactionSummaryGenerator,
      sessionManager: this.sessionManager,
      runner: this.#runner,
      createHostContext: () => this.createHostContext(),
      emitToListeners: (event) => this.emitToListeners(event),
      replaceMessages: (messages) => this.replaceMessages(messages),
      markSessionCompacted: () => this.markSessionCompactedForCacheState(),
    });
    this.#deferredCompaction = new ManagedSessionDeferredCompactionCoordinator({
      flow: this.#compactionFlow,
      isStreaming: () => this.isStreaming,
      preview: (request) => this.#compactionLifecycle.preview(request),
      build: (prepared) => this.#compactionLifecycle.build(prepared),
      finalize: (prepared, built) => this.#compactionLifecycle.finalize(prepared, built),
      salvage: (prepared, built, mode) => this.#compactionLifecycle.salvage(prepared, built, mode),
      rollback: (prepared) => this.#compactionLifecycle.rollback(prepared),
    });
    this.#providerCacheState = new ManagedSessionProviderCacheState({
      getSessionId: () => this.sessionManager.getSessionId(),
      clearToolSchemaSnapshot: (reason) => this.#toolSchemaSnapshotStore.clear(reason),
      clearProviderSessions: (sessionId) => clearApiProviderSessions(sessionId),
      logger: this.#logger ?? undefined,
    });
    this.#toolRegistry = new ManagedSessionToolRegistry({
      cwd: this.#cwd,
      resourceLoader: this.#resourceLoader,
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
    this.#toolRegistry.replaceAll(input.customTools);
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
    this.#commandRouter = new ManagedSessionCommandMessageRouter({
      commandDispatchGate: this.#commandDispatchGate,
      deferredTurnState: this.#deferredTurnState,
      isStreaming: () => this.isStreaming,
      dispatchPrompt: (parts, options) => this.prompt(parts, options),
      getRegisteredCommands: () => this.#runner.getRegisteredCommands(),
      appendPassiveCustomMessage: (customMessage, options) =>
        this.#eventBridge.appendPassiveCustomMessage(customMessage, options),
      createHostContext: () => this.createHostContext(),
      waitForIdle: () => this.waitForIdle(),
      reload: async () => {
        await this.#resourceLoader.reload();
        this.refreshTools();
      },
    });
    this.#promptDispatchDeps = {
      runner: this.#runner,
      resourceLoader: this.#resourceLoader,
      catalog: this.#catalog,
      sessionManager: this.sessionManager,
      isStreaming: () => this.isStreaming,
      getModel: () => this.model,
      getBaseSystemPrompt: () => this.baseSystemPrompt,
      consumeNextTurnMessages: () => this.#deferredTurnState.consumeNextTurnMessages(),
      createHostContext: () => this.createHostContext(),
      waitForProviderCacheSessionClear: () => this.waitForProviderCacheSessionClear(),
      applyQueuedModelPreset: () => this.applyQueuedModelPreset(),
      tryExecuteRegisteredCommand: (name, args) =>
        this.#commandRouter.tryExecuteRegisteredCommand(name, args),
      flushCommandDispatchBuffer: () => this.#commandRouter.flushCommandDispatchBuffer(),
      ensureInitialPersistence: () => this.ensureInitialPersistence(),
      queueUserMessage: (parts, behavior) => this.queueUserMessage(parts, behavior),
      appendPassiveCustomMessage: (customMessage, options) =>
        this.#eventBridge.appendPassiveCustomMessage(customMessage, options),
      applyPromptOverlay: (systemPrompt) => this.#liveTranscript.applyPromptOverlay(systemPrompt),
      setWorkbenchContextFingerprint: (value) => this.#workbenchContextFingerprint.set(value),
      syncContextState: () => this.syncContextState(),
    };
  }

  static async create(
    options: CreateBrewvaManagedAgentSessionOptions,
  ): Promise<BrewvaManagedAgentSession> {
    const toolDefinitions = [...(options.customTools ?? [])];
    let session: BrewvaManagedAgentSession | undefined;
    const requireSession = (): BrewvaManagedAgentSession => {
      if (!session) {
        throw new Error("Session not initialized");
      }
      return session;
    };

    const runner = await createBrewvaHostPluginRunner({
      plugins: options.extensions,
      actions: {
        sendMessage(message, sendOptions) {
          void requireSession().sendCustomMessage(message, sendOptions);
        },
        sendUserMessage(content, sendOptions) {
          void requireSession().sendUserMessage(content, sendOptions);
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
    const extensionManifests = collectHostedExtensionManifests(options.extensions);

    const cacheBreakDetector = new ProviderCacheBreakDetector({
      diagnosticDumpDirectory: resolveProviderCacheDiagnosticDumpDirectory(options.cwd),
    });
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

    const agent = new ManagedRuntimeSessionController({
      initialModel: options.initialModel,
      initialThinkingLevel: toTurnLoopThinkingLevel(options.initialThinkingLevel),
    });

    const workbenchContextFingerprint = new WorkbenchContextFingerprintHolder();
    const providerPayloadPipeline = createProviderPayloadPipeline({
      runner,
      settings: options.settings,
      runtime: options.runtime,
      sessionId,
      isSessionReady: () => session !== undefined,
      agentState: () => agent.state,
      createHostContext: () => requireSession().createHostContext(),
      resolveChannelContext: () => requireSession().resolveProviderCacheChannelContext(),
      resolveToolSchemaSnapshot: (invalidationReason) =>
        requireSession().resolveProviderToolSchemaSnapshot(invalidationReason),
      observeStickyLatches: (input) => requireSession().observeProviderCacheStickyLatches(input),
      readWorkbenchContextFingerprint: () => workbenchContextFingerprint.get(),
    });

    const clearCacheState = options.runtime?.ops.session.state.onClear(
      (clearedSessionId: string) => {
        if (clearedSessionId === sessionId) {
          cacheBreakDetector.clear();
          providerPayloadPipeline.resetForSessionClear();
          session?.clearProviderCacheSessionStateBestEffort();
        }
      },
    );

    const providerAssistantObserver = new ManagedSessionProviderAssistantObserver({
      runtime: options.runtime,
      sessionId,
      cacheBreakDetector,
      resolveExpectedBreak: () => providerPayloadPipeline.consumeExpectedBreak(),
      state: () => providerPayloadPipeline.readState(),
    });

    session = new BrewvaManagedAgentSession({
      cwd: options.cwd,
      settings: options.settings,
      catalog: options.modelCatalog,
      resourceLoader: options.resourceLoader,
      sessionStore: options.sessionStore,
      modelPresetState: options.initialModelPresetState,
      modelRole: options.initialModelRole,
      customTools: toolDefinitions,
      runner,
      verificationGateManifests: extensionManifests.verificationGateManifests,
      agent,
      compactionSummaryGenerator,
      sessionTitleGenerator,
      ui: options.ui,
      runtime: options.runtime,
      logger: options.logger,
      prepareRuntimeProviderPayload: providerPayloadPipeline.preparePayload,
      observeRuntimeCacheRender: providerPayloadPipeline.observeCacheRender,
      workbenchContextFingerprint,
      onProviderAssistantMessage: (message) =>
        providerAssistantObserver.onCommittedAssistantMessage(message),
      onInitialPersistence: options.onInitialPersistence,
      onDispose: () => {
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
    const restoredMessages = this.sessionManager.buildSessionContext()
      .messages as BrewvaAgentProtocolMessage[];
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
      getSessionPhase: () => this.#phaseCoordinator.get(),
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

  getRuntimeActiveModelRole(): BrewvaModelRoleAlias {
    return this.#modelRole ?? "default";
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
    const removed = this.#deferredTurnState.removeQueuedPrompt(promptId, () => true);
    if (!removed) {
      return false;
    }
    this.emitQueuedPromptChange();
    return true;
  }

  getRegisteredTools(): readonly BrewvaToolDefinition[] {
    return this.#toolRegistry.listRegisteredTools();
  }

  getRuntimeModelCatalog(): BrewvaMutableModelCatalog {
    return this.#catalog;
  }

  createRuntimeToolContext(): BrewvaToolContext {
    return this.createToolContext();
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
    const output = await runHostedTurnEnvelope({
      session: this,
      runtime: this.#runtime,
      sessionId: this.sessionManager.getSessionId(),
      prompt: parts,
      source: hostedTurnSourceFromPromptOptions(options),
    });
    if (output.status === "failed") {
      throw output.error instanceof Error ? output.error : new Error(String(output.error));
    }
    if (output.status === "cancelled" || output.status === "suspended") {
      return;
    }

    while (!this.isStreaming) {
      const queued = this.#deferredTurnState.consumeQueuedPrompt();
      if (!queued) {
        break;
      }
      this.emitQueuedPromptChange();
      await this[HOSTED_PROMPT_ATTEMPT_DISPATCH](queued.parts, {
        expandPromptTemplates: false,
        source: options?.source,
      });
    }
  }

  async [HOSTED_RUNTIME_TURN_PRELUDE](
    parts: readonly BrewvaPromptContentPart[],
    options?: BrewvaPromptOptions,
  ): Promise<HostedRuntimeTurnPreludeResult> {
    const prepared = await this.preparePromptDispatch(parts, options);
    if (prepared.status !== "ready") {
      return { status: prepared.status };
    }
    const previousPromptSource = this.#activePromptSource;
    this.#activePromptSource = prepared.source;
    const sessionId = this.sessionManager.getSessionId();
    this.#runtimeTurnContext = {
      messages: prepared.messages,
      runtimeEventCursor: this.#runtime.runtime.tape.list(sessionId).at(-1)?.id ?? null,
    };
    const runtimeTurn = this.#agent.beginRuntimeTurn();
    return {
      status: "ready",
      promptText: prepared.promptText,
      promptContent: prepared.promptContent,
      signal: runtimeTurn.signal,
      complete: () => {
        this.#runtimeTurnContext = null;
        this.#activePromptSource = previousPromptSource;
        runtimeTurn.complete();
      },
    };
  }

  [HOSTED_RUNTIME_TURN_CONTEXT](): HostedRuntimeTurnContext | null {
    return this.#runtimeTurnContext;
  }

  [HOSTED_COMPACTION_BOUNDARY](): HostedCompactionBoundary {
    return {
      consumeToolResultStop: () => this.#deferredCompaction.consumeToolResultStop(),
      flushPendingCompaction: async () => {
        const flushed = await this.#deferredCompaction.flushAfterCommittedToolResult();
        await this.syncContextState();
        return flushed;
      },
      settleTurnEndCompaction: async () => {
        await this.#deferredCompaction.settleTurnEnd();
        await this.syncContextState();
      },
    };
  }

  getRuntimeProviderCachePolicy() {
    return this.#settings.getCachePolicy();
  }

  getRuntimeProviderTransport() {
    return this.#settings.getTransport();
  }

  getRuntimeVerificationGateManifests() {
    return this.#verificationGateManifests;
  }

  getRuntimeVerificationGateEvidence(sessionId: string) {
    return queryRuntimeEvents(this.#runtime, sessionId, { last: 100 }).flatMap((event) => {
      const evidence = readRuntimeVerificationGateEvidenceFromEvent(event);
      return evidence ? [evidence] : [];
    });
  }

  getRuntimeModelRoutingSettings() {
    return this.#settings.getModelRoutingSettings?.();
  }

  recordRuntimeProviderCredentialRotated(input: {
    providerId: string;
    credentialSlot: string;
    reason: "quota" | "rate_limit" | "auth" | "manual";
    cooldownMs: number;
  }): void {
    this.#runtime.ops.session.lifecycle.providerCredentialRotated({
      sessionId: this.sessionManager.getSessionId(),
      payload: input,
    });
  }

  async prepareRuntimeProviderPayload(input: RuntimeProviderPayloadInput): Promise<unknown> {
    return this.#prepareRuntimeProviderPayload?.(input) ?? input.payload;
  }

  observeRuntimeCacheRender(input: RuntimeProviderCacheRenderInput): void {
    this.#observeRuntimeCacheRender?.(input);
  }

  observeRuntimeAssistantMessage(
    message: Extract<BrewvaAgentProtocolMessage, { role: "assistant" }>,
  ): void {
    this.#onProviderAssistantMessage?.(message);
  }

  private async preparePromptDispatch(
    parts: readonly BrewvaPromptContentPart[],
    options?: BrewvaPromptOptions,
  ): Promise<PreparedManagedPromptDispatch> {
    return prepareManagedPromptDispatch(this.#promptDispatchDeps, parts, options);
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
    return this.#toolRegistry.resolveProviderToolSchemaSnapshot(
      invalidationReason,
      this.getActiveToolNames(),
    );
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

  private toolApplicationDeps(): ManagedSessionToolApplicationDeps {
    return {
      createToolContext: () => this.createToolContext(),
      getActiveToolNames: () => this.getActiveToolNames(),
      applyBaseContext: (input) => this.#liveTranscript.applyBaseContext(input),
      applyBaseSystemPrompt: (systemPrompt) =>
        this.#liveTranscript.applyBaseSystemPrompt(systemPrompt),
    };
  }

  private get baseSystemPrompt(): string {
    return this.#toolRegistry.currentBaseSystemPrompt;
  }

  private refreshTools(): void {
    this.#toolRegistry.refreshTools(this.toolApplicationDeps());
  }

  private registerHostedTool(tool: BrewvaToolDefinition): void {
    this.#toolRegistry.registerHostedTool(tool, this.toolApplicationDeps());
  }

  private getActiveToolNames(): string[] {
    return this.#agent.state.tools.map((tool) => tool.name);
  }

  private getAllToolInfo(): ReturnType<ManagedSessionToolRegistry["listInfo"]> {
    return this.#toolRegistry.listInfo();
  }

  private setActiveTools(toolNames: string[]): void {
    this.#toolRegistry.setActiveTools(toolNames, this.toolApplicationDeps());
  }

  private async queueUserMessage(
    parts: readonly BrewvaPromptContentPart[],
    behavior: BrewvaPromptQueueBehavior,
  ): Promise<void> {
    this.#deferredTurnState.enqueueStreamingUserPrompt(parts, behavior);
    this.emitQueuedPromptChange();
  }

  private sendCustomMessage(
    message: BrewvaHostCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: BrewvaHostCustomMessageDelivery },
  ): Promise<void> {
    return this.#commandRouter.sendCustomMessage(message, options);
  }

  private sendUserMessage(
    content: BrewvaPromptContentPart[],
    options?: { deliverAs?: "queue" | "followUp" },
  ): Promise<void> {
    return this.#commandRouter.sendUserMessage(content, options);
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
      hasPendingMessages: () => this.#deferredTurnState.hasPending(false),
      shutdown: () => this.dispose(),
      compact: (request) => {
        this.requestCompaction(request);
      },
      getContextUsage: () => undefined,
      getSystemPrompt: () => this.#agent.state.systemPrompt,
    };
  }

  private createHostContext(): BrewvaHostContext {
    return this.createToolContext();
  }

  private async handleAgentEvent(
    event: BrewvaAgentProtocolEvent,
  ): Promise<BrewvaAgentProtocolEvent> {
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
    if (this.#runtime) {
      const sessionId = this.sessionManager.getSessionId();
      const usage = getRuntimeContextUsage(this.#runtime, sessionId);
      const gateStatus = getRuntimeCompactionGateStatus(this.#runtime, sessionId, usage);
      const decision = decideCompaction({
        caller: "manual",
        gateStatus,
      });
      if (decision.decision !== "execute") {
        request?.onError?.(new Error(`manual_compaction_rejected:${decision.reason}`));
        return;
      }
    }
    void this.#deferredCompaction.request(request);
  }

  private async transitionCrashAndResume(anchor: string): Promise<void> {
    await this.#phaseCoordinator.transitionCrashAndResume(anchor);
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
    recordSteeringAuditEvent(this.#runtime, this.sessionManager.getSessionId(), type, payload);
  }

  private async syncContextState(): Promise<void> {
    await this.#eventBridge.syncContextState();
  }

  private deleteQueuedMessage(
    message: Extract<BrewvaAgentProtocolMessage, { role: "user" }>,
  ): void {
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
