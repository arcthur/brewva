import { randomUUID } from "node:crypto";
import type {
  Api,
  Model as ProviderModel,
  ProviderCacheRenderResult,
  ProviderPayloadMetadata,
} from "@brewva/brewva-provider-core/contracts";
import { clearApiProviderSessions } from "@brewva/brewva-provider-core/registry";
import {
  type BrewvaAgentProtocolController,
  type BrewvaAgentProtocolEvent,
  type BrewvaAgentProtocolMessage,
} from "@brewva/brewva-substrate/agent-protocol";
import {
  buildBrewvaDeterministicCompactionSummary,
  estimateBrewvaCompactionTokens,
} from "@brewva/brewva-substrate/compaction";
import { decideCompaction } from "@brewva/brewva-substrate/context-budget";
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
  type BrewvaModelRoleAlias,
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
  type ContextState,
  type BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import {
  type BrewvaCompactionRequest,
  BrewvaToolContext,
  BrewvaToolDefinition,
} from "@brewva/brewva-substrate/tools";
import { buildHarnessManifest, stableHarnessId } from "@brewva/brewva-vocabulary/harness";
import {
  STEER_APPLIED_EVENT_TYPE,
  STEER_DROPPED_EVENT_TYPE,
  STEER_QUEUED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/wire";
import {
  collectHostedExtensionManifests,
  type VerificationGateManifest,
} from "../../../../extensions/api.js";
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
  generateCompactionSummaryWithPromptTooLargeRetry,
  LLM_PRIMARY_COMPACTION_STRATEGY,
  normalizeCompactionSummaryForStorage,
  type BrewvaCompactionSummaryGenerator,
} from "../../compaction/summary-generator.js";
import { supportsHostedExtendedThinkingModel as supportsHostedExtendedThinking } from "../../provider/built-in-catalog.js";
import {
  ProviderCacheBreakDetector,
  createProviderRequestFingerprint,
  createToolSchemaSnapshotStore,
  type ToolSchemaSnapshot,
} from "../../provider/cache/index.js";
import { consumeProviderRequestReductionExpectedCacheBreak } from "../../provider/request/provider-request-reduction.js";
import type { HostedSessionLogger } from "../../shared/logger.js";
import { HOSTED_PROMPT_ATTEMPT_DISPATCH } from "../../turn-adapter/hosted-prompt-attempt.js";
import type { RuntimeProviderContextSummary } from "../../turn-adapter/runtime-provider-context.js";
import {
  HOSTED_COMPACTION_BOUNDARY,
  type HostedCompactionBoundary,
} from "../../turn-adapter/runtime-turn-compaction.js";
import {
  HOSTED_RUNTIME_TURN_CONTEXT,
  HOSTED_RUNTIME_TURN_PRELUDE,
  type HostedRuntimeTurnPreludeResult,
} from "../../turn-adapter/runtime-turn-prelude.js";
import { readRuntimeVerificationGateEvidenceFromEvent } from "../../turn-adapter/runtime-turn-verification-gates.js";
import { runHostedTurnEnvelope } from "../../turn-adapter/turn-envelope.js";
import { extractPromptTargetPaths } from "../prompt-paths.js";
import {
  getRuntimeCompactionGateStatus,
  getRuntimeContextEvidenceLatest,
  getRuntimeContextUsage,
  getRuntimeVisibleReadEpoch,
  queryRuntimeEvents,
  recordRuntimeAssistantCost,
  type HostedRuntimeAdapterPort,
} from "../runtime-ports.js";
import {
  deriveSessionPhaseFromLifecycleSnapshot,
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
  toAgentUserContent,
} from "./prompt-content.js";
import { ManagedSessionProviderAssistantObserver } from "./provider-assistant-observer.js";
import {
  buildProviderCacheModelKey,
  ManagedSessionProviderCacheState,
  normalizeProviderCacheRender,
  resolveProviderCacheDiagnosticDumpDirectory,
} from "./provider-cache-state.js";
import {
  EMPTY_WORKBENCH_CONTEXT_FINGERPRINT,
  buildProviderDynamicTailSummary,
  resolveWorkbenchContextFingerprint,
  type WorkbenchContextFingerprintInput,
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
  type ProviderCacheRuntimeState,
} from "./session-contracts.js";
import {
  nextHarnessProviderAttemptSequence,
  readHarnessCapabilitySelection,
  readHarnessSkillSelection,
  readProviderFallbackActive,
  recordRuntimeHarnessManifest,
  turnNumberFromTurnId,
} from "./session-harness-manifest.js";
import {
  appendTargetScopedProjectInstructions,
  hostedTurnSourceFromPromptOptions,
  promptPartsFromCustomMessage,
  toTurnLoopCustomMessage,
} from "./session-prompt-dispatch.js";
import {
  buildManagedSessionBaseSystemPrompt,
  ManagedSessionToolRegistry,
} from "./tool-registry.js";
import {
  buildSteerAuditPayload,
  normalizePromptSource,
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

type PreparedManagedPromptDispatch =
  | {
      readonly status: "ready";
      readonly promptText: string;
      readonly promptContent: readonly BrewvaPromptContentPart[];
      readonly messages: readonly BrewvaAgentProtocolMessage[];
      readonly source: string | undefined;
    }
  | {
      readonly status: "handled" | "queued";
    };

interface RuntimeProviderPayloadInput {
  readonly payload: unknown;
  readonly model: ProviderModel<Api>;
  readonly metadata?: ProviderPayloadMetadata;
  readonly turn: {
    readonly sessionId: string;
    readonly turnId?: string;
  };
  readonly providerContext: RuntimeProviderContextSummary;
}

interface RuntimeProviderCacheRenderInput {
  readonly render: ProviderCacheRenderResult;
  readonly model: ProviderModel<Api>;
}

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
  readonly #agent: BrewvaAgentProtocolController;
  readonly #runner: BrewvaHostPluginRunner;
  readonly #verificationGateManifests: readonly VerificationGateManifest[];
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
  #runtimeTurnPreparedMessages: readonly BrewvaAgentProtocolMessage[] = [];
  #lastWorkbenchContextFingerprint: WorkbenchContextFingerprintInput = {
    ...EMPTY_WORKBENCH_CONTEXT_FINGERPRINT,
  };
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
    agent: BrewvaAgentProtocolController;
    compactionSummaryGenerator: BrewvaCompactionSummaryGenerator;
    sessionTitleGenerator: BrewvaSessionTitleGenerator;
    ui?: BrewvaToolUiPort;
    logger?: HostedSessionLogger;
    onProviderAssistantMessage?: (
      message: Extract<BrewvaAgentProtocolMessage, { role: "assistant" }>,
    ) => void;
    prepareRuntimeProviderPayload?: (input: RuntimeProviderPayloadInput) => Promise<unknown>;
    observeRuntimeCacheRender?: (input: RuntimeProviderCacheRenderInput) => void;
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
    this.#verificationGateManifests = input.verificationGateManifests;
    this.#agent = input.agent;
    this.#compactionSummaryGenerator = input.compactionSummaryGenerator;
    this.#sessionTitleGenerator = input.sessionTitleGenerator;
    this.#logger = input.logger ?? null;
    this.#onProviderAssistantMessage = input.onProviderAssistantMessage;
    this.#prepareRuntimeProviderPayload = input.prepareRuntimeProviderPayload;
    this.#observeRuntimeCacheRender = input.observeRuntimeCacheRender;
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
    const extensionManifests = collectHostedExtensionManifests(options.extensions);

    const providerCacheRuntime: ProviderCacheRuntimeState = {
      lastProviderFingerprint: undefined,
      lastCacheRender: undefined,
      lastCacheRenderModelKey: undefined,
      lastExpectedProviderCacheBreak: undefined,
    };
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
    const clearCacheState = options.runtime?.ops.session.state.onClear(
      (clearedSessionId: string) => {
        if (clearedSessionId === sessionId) {
          cacheBreakDetector.clear();
          providerCacheRuntime.lastProviderFingerprint = undefined;
          providerCacheRuntime.lastCacheRender = undefined;
          providerCacheRuntime.lastCacheRenderModelKey = undefined;
          session?.clearProviderCacheSessionStateBestEffort();
        }
      },
    );

    const agent = new ManagedRuntimeSessionController({
      initialModel: options.initialModel,
      initialThinkingLevel: toTurnLoopThinkingLevel(options.initialThinkingLevel),
    });

    const providerAssistantObserver = new ManagedSessionProviderAssistantObserver({
      runtime: options.runtime,
      sessionId,
      cacheBreakDetector,
      resolveExpectedBreak: () => {
        const hint = providerCacheRuntime.lastExpectedProviderCacheBreak;
        providerCacheRuntime.lastExpectedProviderCacheBreak = undefined;
        return hint;
      },
      state: () => ({
        lastProviderFingerprint: providerCacheRuntime.lastProviderFingerprint,
        lastCacheRender: providerCacheRuntime.lastCacheRender,
      }),
    });
    let harnessProviderAttemptTurnKey: string | undefined;
    let harnessProviderAttemptSequence = 0;

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
      prepareRuntimeProviderPayload: async ({
        payload,
        model,
        metadata,
        turn,
        providerContext,
      }) => {
        if (!session) {
          return payload;
        }
        const providerPayloadResult = await runner.emitBeforeProviderRequest(
          {
            type: "before_provider_request",
            payload,
            provider: model.provider,
            api: model.api,
            modelId: model.id,
          },
          session.createHostContext(),
        );
        const nextPayload = providerPayloadResult.payload;
        providerCacheRuntime.lastExpectedProviderCacheBreak =
          consumeProviderRequestReductionExpectedCacheBreak(nextPayload);
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
        const transientReduction = getRuntimeContextEvidenceLatest(
          options.runtime,
          sessionId,
          "transient_reduction",
        )?.payload;
        const visibleHistoryReduction = {
          epoch: getRuntimeVisibleReadEpoch(options.runtime, sessionId),
          transientReductionStatus:
            transientReduction &&
            typeof transientReduction === "object" &&
            "status" in transientReduction
              ? transientReduction.status
              : "none",
          transientReductionClassification:
            transientReduction &&
            typeof transientReduction === "object" &&
            "classification" in transientReduction
              ? transientReduction.classification
              : null,
          expectedCacheBreak: providerCacheRuntime.lastExpectedProviderCacheBreak !== undefined,
        };
        const workbenchContext = session.#lastWorkbenchContextFingerprint;
        const providerFallback = metadata?.providerFallback ?? { active: false };
        const providerFingerprint = createProviderRequestFingerprint({
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
          providerFallback,
          payload: nextPayload,
        });
        providerCacheRuntime.lastProviderFingerprint = providerFingerprint;
        const harnessManifest = buildHarnessManifest({
          sessionId,
          ...(() => {
            const numericTurn = turnNumberFromTurnId(turn.turnId);
            return numericTurn === undefined ? {} : { turn: numericTurn };
          })(),
          ...(turn.turnId ? { turnId: turn.turnId } : {}),
          attempt: nextHarnessProviderAttemptSequence({
            turnId: turn.turnId,
            currentTurnKey: harnessProviderAttemptTurnKey,
            currentSequence: harnessProviderAttemptSequence,
            update(next) {
              harnessProviderAttemptTurnKey = next.turnKey;
              harnessProviderAttemptSequence = next.sequence;
            },
          }),
          runtime: {
            configHash: stableHarnessId("runtime_config", options.runtime.config),
            runtimeIdentityHash: stableHarnessId("runtime_identity", options.runtime.identity),
          },
          prompt: {
            systemPromptHash: providerContext.systemPromptHash,
            blockHashes: providerContext.messageHashes,
            stabilityHash: providerFingerprint.stablePrefixHash,
          },
          tools: {
            activeToolNames: toolSchemaSnapshot.tools.map((tool) => tool.name).toSorted(),
            toolSchemaSnapshotHash: toolSchemaSnapshot.hash,
          },
          skillSelection: readHarnessSkillSelection(options.runtime, sessionId),
          capabilitySelection: readHarnessCapabilitySelection(options.runtime, sessionId),
          context: {
            materializationPolicyHash: stableHarnessId("context_materialization_policy", {
              transport: options.settings.getTransport(),
              cachePolicy,
            }),
            compactionPolicyHash: stableHarnessId("context_compaction_policy", {
              thinkingLevel: metadata?.reasoning ?? agent.state.thinkingLevel,
              thinkingBudgets: metadata?.thinkingBudgets ?? options.settings.getThinkingBudgets(),
              visibleHistoryReduction,
            }),
            promptStablePrefixHash: providerFingerprint.stablePrefixHash,
            promptDynamicTailHash: providerFingerprint.dynamicTailHash,
            contextEvidenceHashes: [
              providerFingerprint.channelContextHash,
              providerFingerprint.visibleHistoryReductionHash,
              providerFingerprint.workbenchContextHash,
            ],
          },
          provider: {
            provider: model.provider,
            api: model.api,
            model: model.id,
            transport: options.settings.getTransport(),
            cachePolicyHash: providerFingerprint.cachePolicyHash,
            requestHash: providerFingerprint.requestHash,
            providerFallbackHash: providerFingerprint.providerFallbackHash,
            providerFallbackActive: readProviderFallbackActive(providerFallback),
            status: "prepared",
          },
          plugins: {
            mutatingHookIds: providerPayloadResult.mutatingHookIds,
          },
          refs: {
            sourceEventIds: [],
          },
        });
        recordRuntimeHarnessManifest({
          runtime: options.runtime,
          manifest: harnessManifest,
          turnId: turn.turnId,
        });
        return nextPayload;
      },
      observeRuntimeCacheRender: ({ render, model }) => {
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
    this.#runtimeTurnPreparedMessages = prepared.messages;
    const runtimeTurn =
      this.#agent instanceof ManagedRuntimeSessionController
        ? this.#agent.beginRuntimeTurn()
        : null;
    return {
      status: "ready",
      promptText: prepared.promptText,
      promptContent: prepared.promptContent,
      ...(runtimeTurn ? { signal: runtimeTurn.signal } : {}),
      complete: () => {
        this.#runtimeTurnPreparedMessages = [];
        this.#activePromptSource = previousPromptSource;
        runtimeTurn?.complete();
      },
    };
  }

  [HOSTED_RUNTIME_TURN_CONTEXT](): readonly BrewvaAgentProtocolMessage[] {
    return this.#runtimeTurnPreparedMessages;
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
        return { status: "handled" };
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
        return { status: "handled" };
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
      return { status: "queued" };
    }

    if (!this.model) {
      throw new Error("No model selected.");
    }
    if (!this.#catalog.hasConfiguredAuth(this.model as BrewvaRegisteredModel)) {
      throw new Error(`No API key found for ${this.model.provider}/${this.model.id}.`);
    }

    const restoredMessages = this.sessionManager.buildSessionContext()
      .messages as BrewvaAgentProtocolMessage[];
    const messages: BrewvaAgentProtocolMessage[] = [
      ...restoredMessages,
      {
        role: "user",
        content: toAgentUserContent(currentParts),
        timestamp: Date.now(),
      },
      ...this.#deferredTurnState.consumeNextTurnMessages(),
    ];

    const promptText = buildBrewvaPromptText(currentParts);
    const promptTargetPaths = extractPromptTargetPaths(promptText);
    const systemPrompt = appendTargetScopedProjectInstructions({
      baseSystemPrompt: this.#baseSystemPrompt,
      promptTargetPaths,
      resourceLoader: this.#resourceLoader,
    });

    const beforeStart = await this.#runner.emitBeforeAgentStart(
      {
        type: "before_agent_start",
        prompt: promptText,
        parts: cloneBrewvaPromptContentParts(currentParts),
        promptPaths: promptTargetPaths,
        systemPrompt,
      },
      this.createHostContext(),
    );
    if (beforeStart?.messages) {
      for (const message of beforeStart.messages) {
        messages.push(toTurnLoopCustomMessage(message));
      }
    }
    this.#lastWorkbenchContextFingerprint = resolveWorkbenchContextFingerprint(
      beforeStart?.messages,
    );
    const transformedMessages = (await this.#runner.emitContext(
      { type: "context", messages },
      this.createHostContext(),
    )) as BrewvaAgentProtocolMessage[];
    messages.length = 0;
    messages.push(...transformedMessages);
    for (const message of beforeStart?.messages ?? []) {
      await this.#eventBridge.appendPassiveCustomMessage(toTurnLoopCustomMessage(message), {
        transcript: true,
      });
    }

    this.#liveTranscript.applyPromptOverlay(beforeStart?.systemPrompt ?? systemPrompt);
    await this.syncContextState();
    return {
      status: "ready",
      promptText,
      promptContent: cloneBrewvaPromptContentParts(currentParts),
      messages,
      source: normalizePromptSource(options?.source),
    };
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
    const activeToolNames = toolDefinitions.map((tool) => tool.name);
    const snapshot = this.#toolRegistry.buildSchemaSnapshot(toolDefinitions, "tool_refresh");
    const tools = this.#toolRegistry.buildAgentTools(toolDefinitions, snapshot, () =>
      this.createToolContext(),
    );
    this.#baseSystemPrompt = this.rebuildSystemPrompt(activeToolNames);
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

  private rebuildSystemPrompt(
    activeToolNames: readonly string[] = this.getActiveToolNames(),
  ): string {
    return buildManagedSessionBaseSystemPrompt({
      cwd: this.#cwd,
      resourceLoader: this.#resourceLoader,
      activeToolNames,
      toolPromptInputs: this.#toolRegistry.buildPromptInputs(activeToolNames),
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
    const activeToolNames = selectedDefinitions.map((tool) => tool.name);
    const snapshot = this.#toolRegistry.buildSchemaSnapshot(
      selectedDefinitions,
      "active_tool_set_changed",
    );
    const tools = this.#toolRegistry.buildAgentTools(selectedDefinitions, snapshot, () =>
      this.createToolContext(),
    );
    this.#baseSystemPrompt = this.rebuildSystemPrompt(activeToolNames);
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
    this.#deferredTurnState.enqueueStreamingUserPrompt(parts, behavior);
    this.emitQueuedPromptChange();
  }

  private async sendCustomMessage(
    message: BrewvaHostCustomMessage,
    options?: { triggerTurn?: boolean; deliverAs?: BrewvaHostCustomMessageDelivery },
  ): Promise<void> {
    const customMessage = toTurnLoopCustomMessage(message);

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
      this.#deferredTurnState.pushNextTurnMessage(customMessage);
      return;
    }

    if (options?.triggerTurn) {
      this.#deferredTurnState.pushNextTurnMessage(customMessage);
      await this.prompt(promptPartsFromCustomMessage(message), {
        expandPromptTemplates: false,
        source: "extension",
      });
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
      hasPendingMessages: () => this.#deferredTurnState.hasPending(false),
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
      const generated = await generateCompactionSummaryWithPromptTooLargeRetry({
        input: {
          sessionId: input.sessionId,
          cwd: this.#cwd,
          model,
          messages: input.messages,
          systemPrompt: this.#agent.state.systemPrompt,
          customInstructions: input.customInstructions,
        },
        generate: this.#compactionSummaryGenerator,
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
    recordRuntimeAssistantCost(this.#runtime, {
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
    const localPhase = this.#phaseCoordinator.get();
    const lifecycleSnapshot = this.sessionManager.readLifecycle?.();
    const projected = lifecycleSnapshot
      ? deriveSessionPhaseFromLifecycleSnapshot(lifecycleSnapshot, this.resolvePhaseTurn())?.phase
      : null;
    if (!projected) {
      return localPhase;
    }
    if (projected.kind !== "idle" || localPhase.kind === "idle") {
      return projected;
    }
    return localPhase;
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
    const event = {
      sessionId: this.sessionManager.getSessionId(),
      payload,
    };
    if (type === STEER_QUEUED_EVENT_TYPE) {
      this.#runtime.ops.tools.steering.queued(event);
    } else if (type === STEER_APPLIED_EVENT_TYPE) {
      this.#runtime.ops.tools.steering.applied(event);
    } else if (type === STEER_DROPPED_EVENT_TYPE) {
      this.#runtime.ops.tools.steering.dropped(event);
    }
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
