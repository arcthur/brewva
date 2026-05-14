import {
  BrewvaEffect,
  startScopedSchedule,
  startScopedTimeout,
  type ScopedScheduleHandle,
} from "@brewva/brewva-effect";
import type { BrewvaUiDialogOptions } from "@brewva/brewva-substrate/host-api";
import type {
  BrewvaPromptSessionEvent,
  BrewvaQueuedPromptView,
} from "@brewva/brewva-substrate/session";
import {
  createKeybindingResolver,
  type KeybindingResolver,
  type OverlayPriority,
} from "../../internal/tui/index.js";
import { buildCommandPalettePayload, parseShellSlashPrompt } from "../commands/command-palette.js";
import { ShellCommandProvider } from "../commands/command-provider.js";
import { registerShellCommands } from "../commands/shell-command-registry.js";
import type { ShellAction } from "../domain/actions.js";
import type { ShellCommitBatch, ShellCommitInput, ShellCommitOptions } from "../domain/actions.js";
import {
  ShellCompletionProvider,
  createAgentCompletionSource,
  createCommandCompletionSource,
  createInMemoryCompletionUsageStore,
  createWorkspaceReferenceCompletionSource,
  type ShellCompletionAgent,
} from "../domain/completion-provider.js";
import type { ShellEffect } from "../domain/effects.js";
import { routeShellInput } from "../domain/input-router.js";
import { isShellKeyboardInput, type CliShellInput, type ShellInput } from "../domain/input.js";
import type { ShellIntent } from "../domain/intent.js";
import { shellBuiltInKeybindings } from "../domain/keymap.js";
import type { OperatorSurfaceSnapshot } from "../domain/operator-snapshot.js";
import type { CliShellOverlayPayload } from "../domain/overlays/payloads.js";
import { cloneCliShellPromptParts } from "../domain/prompt-parts.js";
import type { CliShellPromptStorePort } from "../domain/prompt.js";
import { updateShellIntent } from "../domain/reducer.js";
import {
  createShellRuntimeState,
  reduceShellRuntimeAction,
  type CliShellRuntimeState,
} from "../domain/runtime-state.js";
import { selectActiveOverlayPayload, selectHasCompletion } from "../domain/selectors.js";
import { type CliShellAction, type CliShellViewState } from "../domain/state.js";
import { projectShellViewModel, type ShellViewModel } from "../domain/view-model.js";
import { ShellOverlayLifecycleHandler } from "../overlays/lifecycle.js";
import { createShellConfigPort } from "../ports/config-adapter.js";
import { createOperatorSurfacePort } from "../ports/operator-adapter.js";
import { createCliShellPromptStore, createSessionViewPort } from "../ports/session-adapter.js";
import type { CliShellSessionBundle, SessionViewPort } from "../ports/session-port.js";
import { createCliShellUiPortController } from "../ports/ui-adapter.js";
import type { CliShellUiPort } from "../ports/ui-port.js";
import { ShellTranscriptProjector } from "../projectors/transcript-projector.js";
import { ShellDialogManager } from "./dialog-manager.js";
import {
  appendSessionProjectionError,
  dispatchShellEffect,
  type ShellEffectDispatcherContext,
} from "./effect-dispatcher.js";
import { ShellEffectRunner } from "./effect-runner.js";
import { ShellExternalProcessController } from "./external-process-controller.js";
import { ShellCompletionHandler } from "./handlers/completion-handler.js";
import { ShellModelDialogBridge } from "./handlers/model-provider-bridge.js";
import { ShellModelSelectionHandler } from "./handlers/model-selection-handler.js";
import { ShellOperatorOverlayHandler } from "./handlers/operator-overlay-handler.js";
import { ShellPromptMemoryHandler } from "./handlers/prompt-memory-handler.js";
import { ShellProviderAuthHandler } from "./handlers/provider-auth-handler.js";
import { ShellQuestionOverlayHandler } from "./handlers/question-overlay-handler.js";
import { ShellSessionHandler } from "./handlers/session-handler.js";
import {
  ShellViewPreferencesHandler,
  normalizeDiffPreferences,
  normalizeShellViewPreferences,
} from "./handlers/view-preferences-handler.js";
import { ShellOperatorSnapshotSync } from "./operator-snapshot-sync.js";
import { handleShellRendererInput } from "./renderer-input-handler.js";

export interface CliShellRuntimeOptions {
  cwd: string;
  verbose?: boolean;
  initialMessage?: string;
  openSession(sessionId: string): Promise<CliShellSessionBundle>;
  createSession(): Promise<CliShellSessionBundle>;
  onBundleChange?(bundle: CliShellSessionBundle): void;
  openExternalEditor?(title: string, prefill?: string): Promise<string | undefined>;
  openExternalPager?(title: string, lines: readonly string[]): Promise<boolean>;
  openExternalTranscriptPager?(): Promise<boolean>;
  copyTextToClipboard?(this: void, text: string): Promise<void>;
  operatorPollIntervalMs?: number;
  promptStore?: CliShellPromptStorePort;
  completionAgents?: readonly ShellCompletionAgent[] | (() => readonly ShellCompletionAgent[]);
}

function formatSteerDropReason(reason: unknown): string {
  switch (reason) {
    case "aborted":
      return "the turn was aborted";
    case "failed":
      return "the turn failed";
    case "no_tool_boundary":
      return "no tool-result boundary was reached";
    case "overwritten":
      return "the committed tool result replaced the guidance";
    default:
      return "the steer could not be applied";
  }
}

function isQueuedPromptView(value: unknown): value is BrewvaQueuedPromptView {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.promptId === "string" &&
    typeof record.text === "string" &&
    typeof record.submittedAt === "number" &&
    Number.isFinite(record.submittedAt) &&
    (record.behavior === "queue" || record.behavior === "followUp")
  );
}

function isQueuedPromptViewArray(value: unknown): value is readonly BrewvaQueuedPromptView[] {
  return Array.isArray(value) && value.every((item) => isQueuedPromptView(item));
}

function isShellActionArray(input: ShellCommitInput): input is readonly ShellAction[] {
  return Array.isArray(input);
}

function isShellCommitBatch(input: ShellCommitInput): input is ShellCommitBatch {
  return !isShellActionArray(input) && !("type" in input);
}

type CliShellStatusAction = Extract<
  CliShellAction,
  {
    type: "status.set" | "status.setTrust" | "status.working" | "status.hiddenThinking";
  }
>;

function isCliShellStatusAction(action: ShellAction): action is CliShellStatusAction {
  return (
    action.type === "status.set" ||
    action.type === "status.setTrust" ||
    action.type === "status.working" ||
    action.type === "status.hiddenThinking"
  );
}

export class CliShellRuntime {
  static readonly PROMPT_HISTORY_LIMIT = 50;
  static readonly STATUS_DEBOUNCE_MS = 120;
  readonly #configPort = createShellConfigPort();
  readonly #commandProvider = new ShellCommandProvider();
  readonly #completionProvider: ShellCompletionProvider;
  readonly #completionHandler: ShellCompletionHandler;
  readonly #keybindings: KeybindingResolver;
  readonly #modelSelectionHandler: ShellModelSelectionHandler;
  readonly #operatorOverlayHandler: ShellOperatorOverlayHandler;
  readonly #overlayHandler: ShellOverlayLifecycleHandler;
  readonly #promptMemoryHandler: ShellPromptMemoryHandler;
  readonly #providerAuthHandler: ShellProviderAuthHandler;
  readonly #questionOverlayHandler: ShellQuestionOverlayHandler;
  readonly #dialogManager: ShellDialogManager;
  readonly #externalProcesses: ShellExternalProcessController;
  readonly #sessionHandler: ShellSessionHandler;
  readonly #transcriptProjector: ShellTranscriptProjector;
  readonly #viewPreferencesHandler: ShellViewPreferencesHandler;
  #operatorSnapshotSync: ShellOperatorSnapshotSync;

  private buildLocalKeybindings() {
    return [...shellBuiltInKeybindings];
  }
  readonly #listeners = new Set<() => void>();
  readonly #uiController;
  readonly #operatorPort;
  #store: CliShellRuntimeState = createShellRuntimeState();
  #bundle: CliShellSessionBundle;
  #sessionPort: SessionViewPort;
  #operatorSnapshot: OperatorSurfaceSnapshot = {
    approvals: [],
    questions: [],
    taskRuns: [],
    sessions: [],
  };
  #unsubscribeSession: (() => void) | undefined;
  #pollTimer: ScopedScheduleHandle | undefined;
  #statusTimer: { close(): Promise<void> } | undefined;
  #queuedStatusActions: CliShellAction[] = [];
  #resolveExit: (() => void) | undefined;
  readonly #exitPromise: Promise<void>;
  #viewportRows = 24;
  #semanticInputQueue: Promise<void> = Promise.resolve();
  #transcriptNavigationRequestId = 0;
  #started = false;
  #disposed = false;
  readonly #effectRunner: ShellEffectRunner;

  get #state(): CliShellViewState {
    return this.#store.view;
  }

  get #sessionGeneration(): number {
    return this.#store.domain.sessionGeneration;
  }

  constructor(
    bundle: CliShellSessionBundle,
    private readonly options: CliShellRuntimeOptions,
  ) {
    this.#bundle = bundle;
    this.#effectRunner = new ShellEffectRunner({
      isDisposed: () => this.#disposed,
      driveShellEffect: (effect) => this.driveShellEffect(effect),
      reportShellEffectError: (error, effectOptions) =>
        this.reportShellEffectError(error, effectOptions),
    });
    this.#dialogManager = new ShellDialogManager({
      getSessionId: () => this.#sessionPort.getSessionId(),
      openOverlayWithOptions: (payload, overlayOptions) =>
        this.#overlayHandler.openOverlayWithOptions(payload, overlayOptions),
      closeOverlayById: (overlayId) => this.#overlayHandler.closeOverlayById(overlayId),
    });
    this.#externalProcesses = new ShellExternalProcessController(options, {
      getEditorCommand: () => this.#configPort.getEditorCommand(),
      getUi: () => this.ui,
    });
    this.#sessionPort = createSessionViewPort(bundle);
    const promptStore = options.promptStore ?? createCliShellPromptStore();
    this.#operatorPort = createOperatorSurfacePort({
      getSessionBundle: () => this.#bundle,
      openSession: (sessionId) => options.openSession(sessionId),
      createSession: () => options.createSession(),
    });
    registerShellCommands(this.#commandProvider);
    const completionUsageStore = createInMemoryCompletionUsageStore(
      promptStore.loadCompletionUsage(),
      (entry) => promptStore.recordCompletionUsage(entry),
    );
    this.#completionProvider = new ShellCompletionProvider({
      sources: [
        createCommandCompletionSource(this.#commandProvider),
        createAgentCompletionSource(() => this.listCompletionAgents()),
        createWorkspaceReferenceCompletionSource({ cwd: options.cwd }),
      ],
      usageStore: completionUsageStore,
    });
    this.#completionHandler = new ShellCompletionHandler({
      provider: this.#completionProvider,
      getState: () => this.#state,
      getSessionId: () => this.#sessionPort.getSessionId(),
      commit: (action, commitOptions) => this.commit(action, commitOptions),
      replaceCompletionState: (completion) => {
        this.commit(
          {
            type: "completion.set",
            completion,
          },
          { emitChange: false, refreshCompletions: false },
        );
      },
      emitChange: () => this.emitChange(),
      submitComposer: () => this.#sessionHandler.submitComposer(),
    });
    this.#promptMemoryHandler = new ShellPromptMemoryHandler(
      promptStore,
      {
        getState: () => this.#state,
        commit: (action, commitOptions) => this.commit(action, commitOptions),
        notify: (message, level) => this.ui.notify(message, level),
        requestDialog: (request) => this.requestDialog(request),
      },
      CliShellRuntime.PROMPT_HISTORY_LIMIT,
    );
    this.#keybindings = createKeybindingResolver([
      ...this.buildLocalKeybindings(),
      ...this.#commandProvider.keyboundCommands(),
    ]);
    const copyTextToClipboard = options.copyTextToClipboard;
    this.#uiController = createCliShellUiPortController({
      commit: (action) => this.commit(action),
      getState: () => this.#state,
      requestDialog: (request) => this.requestDialog(request),
      requestCustom: (kind, payload, dialogOptions) =>
        this.requestCustom(kind, payload, dialogOptions),
      openExternalEditor: (title, prefill) => this.openExternalEditor(title, prefill),
      copyTextToClipboard: copyTextToClipboard
        ? async (text) => {
            await copyTextToClipboard(text);
          }
        : undefined,
      requestRender: () => this.emitChange(),
    });
    this.#transcriptProjector = new ShellTranscriptProjector({
      getMessages: () => this.#state.transcript.messages,
      getSessionId: () => this.#sessionPort.getSessionId(),
      getTranscriptSeed: () => this.#sessionPort.getTranscriptSeed(),
      getUi: () => this.ui,
      commit: (action, commitOptions) => this.commit(action, commitOptions),
      setMessages: (messages) =>
        this.commit(
          {
            type: "transcript.setMessages",
            messages: [...messages],
          },
          { debounceStatus: false },
        ),
    });
    this.#questionOverlayHandler = new ShellQuestionOverlayHandler({
      notify: (message, level) => this.ui.notify(message, level),
      replaceActiveOverlay: (payload) => this.#overlayHandler.replaceActiveOverlay(payload),
      closeActiveOverlay: (cancelled) => this.#overlayHandler.closeActiveOverlay(cancelled),
      runShellEffects: (effects) => this.runShellEffects(effects),
      refreshOperatorSnapshot: () => this.refreshOperatorSnapshotEffect(),
      settleInteractiveQuestionRequest: (requestId, value) =>
        this.settleInteractiveQuestionRequest(requestId, value),
    });
    this.#operatorOverlayHandler = new ShellOperatorOverlayHandler({
      notify: (message, level) => this.ui.notify(message, level),
      commit: (action, commitOptions) => this.commit(action, commitOptions),
      runShellEffects: (effects) => this.runShellEffects(effects),
      refreshOperatorSnapshot: () => this.refreshOperatorSnapshotEffect(),
      closeActiveOverlay: (cancelled) => this.#overlayHandler.closeActiveOverlay(cancelled),
      openPagerOverlay: (target, pagerOptions) =>
        this.#overlayHandler.openPagerOverlay(target, pagerOptions),
      getExternalPagerTarget: () => this.getExternalPagerTarget(),
      getCurrentSessionId: () => this.#sessionPort.getSessionId(),
      createSession: async () =>
        this.#sessionHandler.switchBundle(await this.#operatorPort.createSession()),
      openSession: async (sessionId) =>
        this.#sessionHandler.switchBundle(await this.#operatorPort.openSession(sessionId)),
      handleQuestionPrimary: async (active) => {
        await this.#questionOverlayHandler.handleInput(active, {
          key: "enter",
          ctrl: false,
          meta: false,
          shift: false,
        });
      },
    });
    const modelDialogBridge = new ShellModelDialogBridge();
    this.#providerAuthHandler = new ShellProviderAuthHandler({
      getBundle: () => this.#bundle,
      getSessionPort: () => this.#sessionPort,
      getState: () => this.#state,
      getUi: () => this.ui,
      openOverlay: (payload, priority) => this.#overlayHandler.openOverlay(payload, priority),
      replaceActiveOverlay: (payload) => this.#overlayHandler.replaceActiveOverlay(payload),
      closeActiveOverlay: (cancelled) => this.#overlayHandler.closeActiveOverlay(cancelled),
      modelDialog: modelDialogBridge,
      requestDialog: (request, dialogOptions) => this.requestDialog(request, dialogOptions),
      runShellEffects: (effects, effectOptions) => this.runShellEffects(effects, effectOptions),
    });
    this.#modelSelectionHandler = new ShellModelSelectionHandler(
      {
        getBundle: () => this.#bundle,
        getSessionPort: () => this.#sessionPort,
        getState: () => this.#state,
        getUi: () => this.ui,
        commit: (actions, commitOptions) => this.commit(actions, commitOptions),
        buildSessionStatusActions: () => this.buildSessionStatusActions(),
        buildCommandPalettePayload: (query) =>
          buildCommandPalettePayload({
            commandProvider: this.#commandProvider,
            query,
          }),
        openOverlay: (payload, priority) => this.#overlayHandler.openOverlay(payload, priority),
        replaceActiveOverlay: (payload) => this.#overlayHandler.replaceActiveOverlay(payload),
        closeActiveOverlay: (cancelled) => this.#overlayHandler.closeActiveOverlay(cancelled),
      },
      this.#providerAuthHandler,
    );
    modelDialogBridge.bind(this.#modelSelectionHandler);
    // ShellSessionHandler is constructed before ShellOverlayLifecycleHandler; use a ref so submit can
    // notify sessions stable-order intent once the overlay handler exists.
    const overlayHandlerRef: { current?: ShellOverlayLifecycleHandler } = {};
    this.#sessionHandler = new ShellSessionHandler({
      cwd: options.cwd,
      getState: () => this.#state,
      getBundle: () => this.#bundle,
      getSessionPort: () => this.#sessionPort,
      getSessionGeneration: () => this.#sessionGeneration,
      getUi: () => this.ui,
      promptMemory: this.#promptMemoryHandler,
      transcriptProjector: this.#transcriptProjector,
      modelSelection: this.#modelSelectionHandler,
      providerAuth: this.#providerAuthHandler,
      commit: (actions, commitOptions) => this.commit(actions, commitOptions),
      runShellEffects: (effects) => this.runShellEffects(effects),
      handleShellCommand: (prompt) => this.handleShellCommand(prompt),
      buildSessionStatusActions: () => this.buildSessionStatusActions(),
      dismissPendingInteractiveQuestionRequests: (input) =>
        this.dismissPendingInteractiveQuestionRequests(input),
      mountSession: (nextBundle) => this.mountSession(nextBundle),
      initializeState: () => this.initializeState(),
      refreshOperatorSnapshot: () => this.refreshOperatorSnapshotEffect(),
      notifyInteractiveUserPromptCommitted: () =>
        overlayHandlerRef.current!.notifySessionsUserPromptReorderIntent(),
    });
    this.#overlayHandler = new ShellOverlayLifecycleHandler({
      getState: () => this.#state,
      getViewportRows: () => this.#viewportRows,
      getBundle: () => this.#bundle,
      getSessionPort: () => this.#sessionPort,
      getOperatorSnapshot: () => this.#operatorSnapshot,
      getDraftsBySessionId: () => this.#sessionHandler.getDraftsBySessionId(),
      getCommandProvider: () => this.#commandProvider,
      transcriptProjector: this.#transcriptProjector,
      buildSessionStatusActions: () => this.buildSessionStatusActions(),
      commit: (actions, commitOptions) => this.commit(actions, commitOptions),
      handleShellIntent: (intent) => this.handleShellIntent(intent),
      submitComposer: () => this.#sessionHandler.submitComposer(),
      resolveDialog: (dialogId, value) => this.resolveDialog(dialogId, value),
      settleInteractiveQuestionRequest: (requestId, value) =>
        this.settleInteractiveQuestionRequest(requestId, value),
      operatorOverlay: this.#operatorOverlayHandler,
      modelSelection: this.#modelSelectionHandler,
      providerAuth: this.#providerAuthHandler,
      questionOverlay: this.#questionOverlayHandler,
    });
    overlayHandlerRef.current = this.#overlayHandler;
    this.#operatorSnapshotSync = new ShellOperatorSnapshotSync({
      isDisposed: () => this.#disposed,
      getSessionGeneration: () => this.#sessionGeneration,
      getState: () => this.#state,
      getSnapshot: () => this.#operatorPort.getSnapshot(),
      setSnapshot: (snapshot) => {
        this.#operatorSnapshot = snapshot;
      },
      commit: (actions, commitOptions) => this.commit(actions, commitOptions),
      overlayHandler: this.#overlayHandler,
    });
    this.#viewPreferencesHandler = new ShellViewPreferencesHandler({
      getSessionPort: () => this.#sessionPort,
      getState: () => this.#state,
      getUi: () => this.ui,
      commit: (action, commitOptions) => this.commit(action, commitOptions),
    });
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    bundle.session.setUiPort(this.ui);
  }

  private listCompletionAgents(): ShellCompletionAgent[] {
    const configured =
      typeof this.options.completionAgents === "function"
        ? this.options.completionAgents()
        : (this.options.completionAgents ?? []);
    const currentAgentId =
      typeof this.#bundle.runtime.identity.agentId === "string"
        ? this.#bundle.runtime.identity.agentId
        : "";
    const agents: ShellCompletionAgent[] = [
      ...(currentAgentId
        ? [{ agentId: currentAgentId, description: "Current session agent" }]
        : []),
      ...configured,
    ];
    const seen = new Set<string>();
    const result: ShellCompletionAgent[] = [];
    for (const agent of agents) {
      if (!agent) {
        continue;
      }
      const agentId = agent.agentId.trim();
      if (!agentId || seen.has(agentId)) {
        continue;
      }
      seen.add(agentId);
      result.push(agent.description ? { agentId, description: agent.description } : { agentId });
    }
    return result;
  }

  get ui(): CliShellUiPort {
    return this.#uiController.ui;
  }

  getViewState(): ShellViewModel {
    return projectShellViewModel(this.#state);
  }

  getToolDefinitions(): CliShellSessionBundle["toolDefinitions"] {
    return this.#bundle.toolDefinitions;
  }

  getSessionIdentity(): {
    sessionId: string;
    lineageLabel: string | null;
    modelLabel: string;
    thinkingLevel: string;
  } {
    const lineageStatus = this.#sessionPort.getLineageStatus();
    return {
      sessionId: this.#sessionPort.getSessionId(),
      lineageLabel: this.formatLineageStatusLabel(lineageStatus),
      modelLabel: this.#sessionPort.getModelLabel(),
      thinkingLevel: this.#sessionPort.getThinkingLevel(),
    };
  }

  getSessionBundle(): CliShellSessionBundle {
    return this.#bundle;
  }

  getOperatorSnapshot(): OperatorSurfaceSnapshot {
    return this.#operatorSnapshot;
  }

  private async openSessionById(sessionId: string): Promise<void> {
    try {
      await this.#sessionHandler.switchBundle(await this.#operatorPort.openSession(sessionId));
      this.ui.notify(`Opened session ${sessionId}.`, "info");
    } catch (error) {
      this.ui.notify(
        `Failed to open session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  }

  async decideApproval(requestId: string, decision: "accept" | "reject"): Promise<void> {
    await this.runShellEffects([
      {
        type: "operator.decideApproval",
        requestId,
        input: {
          decision,
          actor: "brewva-cli",
        },
      },
    ]);
    await this.refreshOperatorSnapshotEffect();
  }

  prefillQuestionAnswer(questionId: string): void {
    const answerPrefix = `/answer ${questionId} `;
    this.commit({
      type: "composer.setText",
      text: answerPrefix,
      cursor: answerPrefix.length,
    });
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.initializeState();
    this.mountSession(this.#bundle);
    this.#pollTimer = startScopedSchedule({
      intervalMs: this.options.operatorPollIntervalMs ?? 750,
      run: () =>
        BrewvaEffect.promise(() =>
          this.runShellEffects([
            {
              type: "operator.refresh",
              sessionGeneration: this.#sessionGeneration,
            },
          ]),
        ),
    });
    await this.runShellEffects([
      { type: "operator.refresh", sessionGeneration: this.#sessionGeneration },
    ]);

    if (this.options.initialMessage?.trim()) {
      const initialMessage = this.options.initialMessage.trim();
      this.commit({
        type: "composer.setText",
        text: initialMessage,
        cursor: initialMessage.length,
      });
      await this.#sessionHandler.submitComposer();
    }
  }

  async waitForExit(): Promise<void> {
    await this.#exitPromise;
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#started = false;
    this.dismissPendingInteractiveQuestionRequests();
    const pollTimer = this.#pollTimer;
    const statusTimer = this.#statusTimer;
    this.#pollTimer = undefined;
    this.#statusTimer = undefined;
    void pollTimer?.close();
    void statusTimer?.close();
    this.#unsubscribeSession?.();
    this.#listeners.clear();
    this.#resolveExit?.();
  }

  openOverlay(payload: CliShellOverlayPayload, priority: OverlayPriority = "normal"): void {
    this.#overlayHandler.openOverlay(payload, priority);
  }

  wantsInput(input: ShellInput): boolean {
    if (!isShellKeyboardInput(input)) {
      return true;
    }
    return this.routeInput(input).handled;
  }

  async handleInput(input: ShellInput): Promise<boolean> {
    if (!isShellKeyboardInput(input)) {
      return await this.handleInputNow(input);
    }
    const task = this.#semanticInputQueue.then(() => this.handleInputNow(input));
    this.#semanticInputQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return await task;
  }

  private async handleInputNow(input: ShellInput): Promise<boolean> {
    try {
      if (!isShellKeyboardInput(input)) {
        return await this.handleRendererInput(input);
      }
      const route = this.routeInput(input);
      if (!route.handled) {
        return false;
      }
      if (!route.intent) {
        return true;
      }
      return await this.handleShellIntent(route.intent);
    } catch (error) {
      this.ui.notify(
        error instanceof Error ? error.message : "Failed to process interactive input.",
        "error",
      );
      return true;
    }
  }

  private async handleRendererInput(input: Exclude<ShellInput, CliShellInput>): Promise<boolean> {
    return await handleShellRendererInput(
      {
        getState: () => this.#state,
        setViewportRows: (rows) => {
          this.#viewportRows = rows;
        },
        commit: (action, commitOptions) => this.commit(action, commitOptions),
        completionHandler: this.#completionHandler,
        openSessionById: (sessionId) => this.openSessionById(sessionId),
      },
      input,
    );
  }

  private routeInput(input: CliShellInput) {
    return routeShellInput({
      input,
      state: {
        activeOverlayKind: selectActiveOverlayPayload(this.#state)?.kind,
        hasCompletion: selectHasCompletion(this.#state),
        canNavigatePromptHistoryPrevious: this.#promptMemoryHandler.canNavigate(-1, input),
        canNavigatePromptHistoryNext: this.#promptMemoryHandler.canNavigate(1, input),
      },
      keybindings: this.#keybindings,
    });
  }

  private emitChange(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  private initializeState(): void {
    const sessionId = this.#sessionPort.getSessionId();
    this.#transcriptProjector.resetAssistantDraft();
    this.#operatorSnapshotSync.resetSeen();
    const restoredDraft = this.#sessionHandler.getDraftsBySessionId().get(sessionId);
    this.#promptMemoryHandler.resetNavigation();
    this.#completionHandler.clearDismissedForCurrentSession();
    const shellViewPreferences = normalizeShellViewPreferences(
      this.#sessionPort.getShellViewPreferences(),
    );
    const hydratedMessages = this.#transcriptProjector.composeSeedTranscript();
    const actions: ShellAction[] = [
      {
        type: "diff.setPreferences",
        preferences: normalizeDiffPreferences(this.#sessionPort.getDiffPreferences()),
      },
      {
        type: "view.setPreferences",
        preferences: {
          showThinking: shellViewPreferences.showThinking,
          toolDetails: shellViewPreferences.toolDetails,
        },
      },
      ...this.buildSessionStatusActions(),
      {
        type: "transcript.setMessages",
        messages: hydratedMessages,
      },
      {
        type: "queue.set",
        items: this.projectQueuedPrompts(this.#sessionPort.getQueuedPrompts()),
      },
    ];
    if (restoredDraft) {
      actions.push({
        type: "composer.setPromptState",
        text: restoredDraft.text,
        cursor: restoredDraft.cursor,
        parts: cloneCliShellPromptParts(restoredDraft.parts),
      });
    }
    this.commit(
      {
        reset: { sessionGeneration: this.#sessionGeneration },
        actions,
      },
      { debounceStatus: false, emitChange: false, refreshCompletions: false },
    );
    if (this.options.verbose) {
      this.commit({
        type: "notification.add",
        notification: {
          id: "startup",
          level: "info",
          message: `Interactive shell attached to ${sessionId}.`,
          createdAt: Date.now(),
        },
      });
    }
    this.emitChange();
  }

  private buildSessionStatusActions(): CliShellAction[] {
    const modelLabel = this.#sessionPort.getModelLabel();
    const lineageLabel = this.formatLineageStatusLabel(this.#sessionPort.getLineageStatus());
    const presetState = this.#sessionPort.getModelPresetState();
    const presetLabel = presetState.pendingName
      ? `${presetState.activeName} -> ${presetState.pendingName}`
      : presetState.activeName;
    return [
      {
        type: "status.set",
        key: "model",
        text: modelLabel,
      },
      {
        type: "status.set",
        key: "preset",
        text: presetLabel,
      },
      {
        type: "status.set",
        key: "thinking",
        text: this.#sessionPort.getThinkingLevel(),
      },
      {
        type: "status.set",
        key: "lineage",
        text: lineageLabel ?? undefined,
      },
      {
        type: "status.set",
        key: "rewind",
        text: this.buildRewindStatusText(),
      },
    ];
  }

  private formatLineageStatusLabel(
    status: ReturnType<SessionViewPort["getLineageStatus"]>,
  ): string | null {
    if (status.unsupportedReason || !status.lineageNodeId) {
      return null;
    }
    const label = status.title ?? status.kind ?? status.lineageNodeId;
    return status.childCount > 0 ? `${label} +${status.childCount}` : label;
  }

  private buildRewindStatusText(): string | undefined {
    const state = this.#sessionPort.getRewindState();
    if (state.rewindAvailable && state.redoAvailable) {
      return "undo: /undo · rewind: /rewind · redo: /redo";
    }
    if (state.redoAvailable) {
      return "redo: /redo";
    }
    if (state.rewindAvailable) {
      return "undo: /undo · rewind: /rewind";
    }
    return undefined;
  }

  private mountSession(bundle: CliShellSessionBundle): void {
    this.commit([{ type: "domain.sessionGeneration.increment" }], {
      debounceStatus: false,
      emitChange: false,
      refreshCompletions: false,
    });
    this.#bundle = bundle;
    bundle.session.setUiPort(this.ui);
    this.#sessionPort = createSessionViewPort(bundle);
    this.options.onBundleChange?.(bundle);
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = this.#sessionPort.subscribe((event) => {
      if (event.type === "queue.changed" && isQueuedPromptViewArray(event.items)) {
        this.applyQueueProjection(event.items);
        return;
      }
      void this.handleShellIntent({ type: "session.event", event });
    });
  }

  private applyQueueProjection(items: ReturnType<SessionViewPort["getQueuedPrompts"]>): void {
    const projectedItems = this.projectQueuedPrompts(items);
    this.commit(
      [
        {
          type: "queue.set",
          items: projectedItems,
        },
      ],
      { debounceStatus: false, refreshCompletions: false },
    );
    this.#overlayHandler.syncQueueOverlay(projectedItems);
  }

  private notifySteerOutcome(event: BrewvaPromptSessionEvent): void {
    if (event.type === "steer_applied") {
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.ui.notify(
        toolName ? `Steer applied to ${toolName}.` : "Steer applied to the current turn.",
        "info",
      );
      return;
    }
    if (event.type === "steer_dropped") {
      this.ui.notify(`Steer dropped: ${formatSteerDropReason(event.reason)}.`, "warning");
    }
  }

  private projectQueuedPrompts(
    items: ReturnType<SessionViewPort["getQueuedPrompts"]>,
  ): ReturnType<SessionViewPort["getQueuedPrompts"]> {
    // followUp prompts merge into the current turn and are not part of the queue UI.
    return items.filter((item) => item.behavior === "queue");
  }

  private commit(input: ShellCommitInput, options: ShellCommitOptions = {}): void {
    let reset: { sessionGeneration: number } | undefined;
    let actions: readonly ShellAction[];
    if (isShellActionArray(input)) {
      actions = input;
    } else if (isShellCommitBatch(input)) {
      reset = input.reset;
      actions = input.actions ?? [];
    } else {
      actions = [input];
    }
    const debounceStatus = options.debounceStatus ?? true;
    const immediate: ShellAction[] = [];
    const deferred: CliShellAction[] = [];
    for (const action of actions) {
      if (debounceStatus && isCliShellStatusAction(action)) {
        deferred.push(action);
      } else {
        immediate.push(action);
      }
    }
    if (deferred.length > 0) {
      this.#queuedStatusActions.push(...deferred);
      if (!this.#statusTimer) {
        void this.runShellEffects([
          { type: "status.flush", delayMs: CliShellRuntime.STATUS_DEBOUNCE_MS },
        ]);
      }
    }
    if (!reset && immediate.length === 0) {
      return;
    }

    if (reset) {
      this.#store = createShellRuntimeState({
        sessionGeneration: reset.sessionGeneration,
      });
    }
    for (const action of immediate) {
      this.#store = reduceShellRuntimeAction(this.#store, action);
    }
    if (
      immediate.some(
        (action) =>
          action.type === "notification.add" ||
          action.type === "notification.dismiss" ||
          action.type === "notification.clear",
      )
    ) {
      this.#overlayHandler.syncNotificationsOverlay();
    }
    if (options.refreshCompletions ?? true) {
      void this.runShellEffects([{ type: "completion.refresh" }]);
    }
    if (options.emitChange !== false) {
      this.emitChange();
    }
  }

  private async runShellEffects(
    effects: readonly ShellEffect[],
    options: { errorMode?: "notify" | "throw" } = {},
  ): Promise<void> {
    return await this.#effectRunner.run(effects, options);
  }

  private reportShellEffectError(
    error: unknown,
    options: { errorMode?: "notify" | "throw" },
  ): void {
    if (options.errorMode === "throw") {
      throw error;
    }
    if (!this.#disposed) {
      this.ui.notify(error instanceof Error ? error.message : "Shell effect failed.", "error");
    }
  }

  private async driveShellEffect(effect: ShellEffect): Promise<void> {
    await dispatchShellEffect(this.createEffectDispatcherContext(), effect);
  }

  private createEffectDispatcherContext(): ShellEffectDispatcherContext {
    return {
      handleInputNow: (input) => this.handleInputNow(input),
      resolveExit: () => this.#resolveExit?.(),
      notify: (message, level) => {
        if (!this.#disposed) {
          this.ui.notify(message, level);
        }
      },
      invokeCommand: async (commandId, source) => {
        const intent = this.#commandProvider.createCommandIntent(commandId, {
          args: "",
          source,
        });
        if (intent) {
          await this.handleShellIntent(intent);
        }
      },
      submitComposer: () => this.#sessionHandler.submitComposer(),
      insertComposerNewline: () => this.ui.pasteToEditor("\n"),
      navigatePromptHistory: (direction) => this.#promptMemoryHandler.navigate(direction),
      stashCurrentPrompt: () => this.#promptMemoryHandler.stashCurrentPrompt(),
      restoreLatestStash: () => this.#promptMemoryHandler.restoreLatestStash(),
      selectStashedPrompt: () => this.#promptMemoryHandler.selectStashedPrompt(),
      acceptCompletion: () => this.#completionHandler.accept(),
      submitCompletion: () => this.#completionHandler.submit(),
      moveCompletion: (delta) => this.#completionHandler.move(delta),
      dismissCompletion: () => this.#completionHandler.dismiss(),
      refreshCompletion: () => this.#completionHandler.refresh(),
      handleDialogInput: (input) => {
        const active = this.#state.overlay.active?.payload;
        if (active?.kind === "input") {
          this.#overlayHandler.handleInputOverlayInput(active, input);
        }
      },
      handleQuestionInput: (input) => this.#overlayHandler.handleQuestionInput(input),
      handlePickerInput: (input) => this.#overlayHandler.handlePickerInput(input),
      handleOverlayInput: (input) => this.#overlayHandler.handleGenericInput(input),
      closeActiveOverlay: (cancelled) => this.#overlayHandler.closeActiveOverlay(cancelled),
      activatePrimaryOverlayAction: () => this.#overlayHandler.handlePrimary(),
      moveOverlaySelection: (delta) => this.#overlayHandler.moveSelection(delta),
      scrollOverlayPage: (direction) => this.#overlayHandler.scrollPage(direction),
      toggleOverlayFullscreen: () => this.#overlayHandler.toggleFullscreen(),
      openCommandPalette: (query) => this.#overlayHandler.openCommandPalette(query ?? ""),
      openHelpHub: () => this.#overlayHandler.openHelpHub(),
      openInbox: () => this.#overlayHandler.openInboxOverlay(),
      openSessions: () => this.#overlayHandler.openSessionsOverlay(),
      openLineage: () => this.#overlayHandler.openLineageOverlay(),
      openQueue: () => this.#overlayHandler.openQueueOverlay(),
      openInspect: () => this.#overlayHandler.openInspectOverlay(),
      openNotifications: () => this.#overlayHandler.openNotificationsOverlay(),
      openActivePagerExternally: () => this.openActivePagerExternally(),
      openExternalTranscriptPager: () => this.openExternalTranscriptPager(),
      requestTranscriptNavigation: (kind) => this.requestTranscriptNavigation(kind),
      projectSessionEvent: (projectEffect) => {
        try {
          this.#transcriptProjector.handleSessionEvent(projectEffect.event);
          this.notifySteerOutcome(projectEffect.event);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to render the latest session event.";
          this.ui.notify(message, "error");
          appendSessionProjectionError({
            appendMessage: (renderedMessage) =>
              this.#transcriptProjector.appendMessage(renderedMessage),
            eventType: projectEffect.event.type,
            message,
          });
        }
      },
      abortSession: async (notification) => {
        await this.#sessionPort.abort();
        if (notification) {
          this.ui.notify(notification, "warning");
        }
      },
      createSession: async () => {
        await this.#sessionHandler.switchBundle(await this.#operatorPort.createSession());
      },
      steerSession: async (steerEffect) => {
        if (steerEffect.sessionGeneration !== this.#sessionGeneration) {
          return;
        }
        const result = await this.#sessionPort.steer(steerEffect.text, {
          source: "interactive",
        });
        if (result.status === "no_active_run") {
          this.ui.notify("No turn is currently streaming.", "warning");
          return;
        }
        if (result.status === "rejected_empty") {
          this.ui.notify("Usage: /steer <text>", "warning");
          return;
        }
        this.ui.notify("Queued steer for the current turn.", "info");
      },
      undoSession: () => this.#sessionHandler.undoLastTurn(),
      rewindSession: (argument) => this.#sessionHandler.rewindSession(argument),
      redoSession: () => this.#sessionHandler.redoLastTurn(),
      openModel: (query) => this.#modelSelectionHandler.openModelsDialog(query ? { query } : {}),
      cycleRecentModel: () => this.#modelSelectionHandler.cycleRecentModel(),
      cycleNextModelPreset: async () => {
        const state = this.#sessionPort.getModelPresetState();
        if (state.presets.length <= 1) {
          this.ui.notify("Only one model preset is available.", "info");
          return;
        }
        const result = await this.#sessionPort.selectNextModelPreset({
          queueOnly: this.#bundle.session.isStreaming === true,
        });
        const verb = result.queued ? "Queued model preset" : "Model preset";
        this.ui.notify(`${verb}: ${result.selectedName}`, "info");
        this.commit(this.buildSessionStatusActions(), {
          debounceStatus: false,
        });
      },
      openProviderConnect: (query) => this.#providerAuthHandler.openConnectDialog(query ?? ""),
      openThinking: () => this.#modelSelectionHandler.openThinkingDialog(),
      toggleThinkingVisibility: () => this.#viewPreferencesHandler.toggleThinkingVisibility(),
      toggleToolDetails: () => this.#viewPreferencesHandler.toggleToolDetails(),
      toggleDiffWrap: () => this.#viewPreferencesHandler.toggleDiffWrapMode(),
      toggleDiffStyle: () => this.#viewPreferencesHandler.toggleDiffStyle(),
      listThemes: () => {
        const themeNames = this.ui
          .getAllThemes()
          .map((theme) => theme.name)
          .join(", ");
        this.ui.notify(`Available themes: ${themeNames}`, "info");
      },
      setTheme: (selection) => {
        const result = this.ui.setTheme(selection);
        if (result.success) {
          this.ui.notify(`Theme switched to ${selection}.`, "info");
        } else {
          this.ui.notify(result.error, "warning");
        }
      },
      refreshOperator: async (sessionGeneration) => {
        if (sessionGeneration === this.#sessionGeneration) {
          await this.refreshOperatorSnapshot(sessionGeneration);
        }
      },
      decideApproval: (requestId, input) => this.#operatorPort.decideApproval(requestId, input),
      answerQuestion: (questionId, answerText) =>
        this.#operatorPort.answerQuestion(questionId, answerText),
      answerQuestionRequest: (requestId, answers) =>
        this.#operatorPort.answerQuestionRequest(requestId, answers),
      stopTask: (runId) => this.#operatorPort.stopTask(runId),
      scheduleStatusFlush: (delayMs) => this.scheduleStatusFlush(delayMs),
      promptSession: async (sessionGeneration, parts, options) => {
        if (sessionGeneration === this.#sessionGeneration) {
          await this.#sessionPort.prompt(parts, options);
        }
      },
      openExternalEditorEffect: async (title, prefill) => {
        const edited = await this.openExternalEditor(title, prefill);
        if (typeof edited === "string" && !this.#disposed) {
          this.commit({
            type: "composer.setText",
            text: edited,
            cursor: edited.length,
          });
        }
      },
      openExternalPagerEffect: async (title, lines) => {
        const opened = await this.openExternalPager(title, lines);
        if (!opened && !this.#disposed) {
          this.ui.notify("No external pager is available for the current shell.", "warning");
        }
      },
      connectProviderApiKey: async (providerId, apiKey, inputs) => {
        const connectionPort = this.#bundle.providerConnections;
        if (!connectionPort) {
          throw new Error("Provider connection is unavailable for this session.");
        }
        await connectionPort.credential.connectApiKey(providerId, apiKey, inputs);
      },
      completeProviderOAuth: async (providerId, methodId, code) => {
        const connectionPort = this.#bundle.providerConnections;
        if (!connectionPort) {
          throw new Error("Provider connection is unavailable for this session.");
        }
        await connectionPort.authFlow.completeOAuth(providerId, methodId, code);
      },
      disconnectProvider: async (providerId) => {
        const connectionPort = this.#bundle.providerConnections;
        if (!connectionPort) {
          throw new Error("Provider connection is unavailable for this session.");
        }
        await connectionPort.credential.disconnect(providerId);
      },
      copyToClipboard: async (text) => {
        if (!this.ui.copyText) {
          throw new Error("Clipboard copy is unavailable.");
        }
        await this.ui.copyText(text);
      },
      openUrl: async (url) => {
        if (!this.ui.openUrl) {
          throw new Error("URL open is unavailable.");
        }
        await this.ui.openUrl(url);
      },
    };
  }

  private scheduleStatusFlush(delayMs: number): void {
    if (this.#statusTimer) {
      return;
    }
    this.#statusTimer = startScopedTimeout({
      delayMs,
      run: () =>
        BrewvaEffect.sync(() => {
          this.#statusTimer = undefined;
          const queued = this.#queuedStatusActions.splice(0);
          this.commit(queued, { debounceStatus: false });
        }),
    });
  }

  private syncSnapshotOverlay(snapshot: OperatorSurfaceSnapshot): void {
    this.#operatorSnapshotSync.syncOverlay(snapshot);
  }

  private async refreshOperatorSnapshot(
    sessionGeneration = this.#sessionGeneration,
  ): Promise<void> {
    await this.#operatorSnapshotSync.refresh(sessionGeneration);
  }

  private async refreshOperatorSnapshotEffect(): Promise<void> {
    await this.runShellEffects([
      { type: "operator.refresh", sessionGeneration: this.#sessionGeneration },
    ]);
  }

  private async handleShellIntent(intent: ShellIntent): Promise<boolean> {
    const result = updateShellIntent(
      {
        view: this.#state,
        sessionGeneration: this.#sessionGeneration,
        isStreaming: this.#bundle.session.isStreaming === true,
        operatorSnapshot: this.#operatorSnapshot,
        externalPagerTarget: this.getExternalPagerTarget(),
      },
      intent,
    );
    this.commit(result.actions, { refreshCompletions: false });
    await this.runShellEffects(result.effects);
    return result.handled;
  }

  private async handleShellCommand(prompt: string): Promise<boolean> {
    const slashCommand = parseShellSlashPrompt(prompt);
    if (!slashCommand) {
      return false;
    }
    const slashMatch = this.#commandProvider.lookupSlashName(slashCommand.name);
    if (!slashMatch) {
      return false;
    }
    if (slashMatch.kind === "reserved") {
      this.commit(
        {
          type: "notification.add",
          notification: {
            id: `reserved-slash:${Date.now()}:${slashCommand.name.toLowerCase()}`,
            level: "warning",
            message:
              slashMatch.reservation.message ??
              `/${slashCommand.name} is reserved for ${slashMatch.reservation.owner} and is unavailable in the interactive shell.`,
            createdAt: Date.now(),
          },
        },
        { refreshCompletions: false },
      );
      return true;
    }
    const intent = this.#commandProvider.createCommandIntent(slashMatch.command.id, {
      args: slashCommand.args,
      source: "slash",
    });
    if (!intent) {
      return false;
    }
    return await this.handleShellIntent(intent);
  }

  private getTranscriptPageStep(): number {
    return Math.max(3, Math.floor(Math.max(8, this.#viewportRows - 10) / 2));
  }

  private requestTranscriptNavigation(kind: "pageUp" | "pageDown" | "top" | "bottom"): void {
    this.commit(
      {
        type: "transcript.requestNavigation",
        request: {
          id: ++this.#transcriptNavigationRequestId,
          kind,
        },
      },
      { debounceStatus: false },
    );
  }

  private resolveDialog(dialogId: string | undefined, value: unknown): void {
    this.#dialogManager.resolveDialog(dialogId, value);
  }

  private settleInteractiveQuestionRequest(
    requestId: string,
    value: readonly (readonly string[])[] | undefined,
  ): void {
    this.#dialogManager.settleInteractiveQuestionRequest(requestId, value);
  }

  private dismissPendingInteractiveQuestionRequests(input?: { sessionId?: string }): void {
    this.#dialogManager.dismissPendingInteractiveQuestionRequests(input);
  }

  private async requestDialog<T>(
    request: {
      id: string;
      kind: "confirm" | "input" | "select";
      title: string;
      message?: string;
      options?: string[];
      masked?: boolean;
      compact?: boolean;
    },
    options: { priority?: OverlayPriority; suspendCurrent?: boolean } = {},
  ): Promise<T> {
    return await this.#dialogManager.requestDialog(request, options);
  }

  private async requestCustom<T>(
    kind: string,
    payload: unknown,
    options?: BrewvaUiDialogOptions,
  ): Promise<T> {
    return await this.#dialogManager.requestCustom<T>(kind, payload, options);
  }

  private async openExternalEditor(title: string, prefill?: string): Promise<string | undefined> {
    return await this.#externalProcesses.openEditor(title, prefill);
  }

  private async openActivePagerExternally(): Promise<void> {
    const externalPagerTarget = this.getExternalPagerTarget("pager");
    if (!externalPagerTarget) {
      return;
    }
    await this.openExternalPagerTarget(externalPagerTarget);
  }

  private getExternalPagerTarget(
    filter?: "pager",
  ): { title: string; lines: readonly string[] } | undefined {
    return this.#overlayHandler.getExternalPagerTarget(filter);
  }

  private async openExternalPagerTarget(target: {
    title: string;
    lines: readonly string[];
  }): Promise<void> {
    await this.runShellEffects([
      {
        type: "external.pager",
        title: target.title,
        lines: target.lines,
      },
    ]);
  }

  private async openExternalPager(title: string, lines: readonly string[]): Promise<boolean> {
    return await this.#externalProcesses.openPager(title, lines);
  }

  private async openExternalTranscriptPager(): Promise<boolean> {
    return await this.#externalProcesses.openTranscriptPager();
  }
}
