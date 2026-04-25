import { type SessionQuestionRequest } from "@brewva/brewva-gateway";
import { normalizeQuestionPrompt } from "@brewva/brewva-substrate";
import type {
  BrewvaInteractiveQuestionRequest,
  BrewvaUiDialogOptions,
} from "@brewva/brewva-substrate";
import {
  createKeybindingResolver,
  type KeybindingResolver,
  type OverlayPriority,
} from "@brewva/brewva-tui";
import {
  getExternalPagerCommand,
  openExternalEditorWithShell,
  openExternalPagerWithShell,
} from "../external-process.js";
import {
  createOperatorSurfacePort,
  createCliShellPromptStore,
  createSessionViewPort,
  createShellConfigPort,
} from "./adapters/ports.js";
import { buildCommandPalettePayload, parseShellSlashPrompt } from "./commands/command-palette.js";
import { ShellCommandProvider } from "./commands/command-provider.js";
import { registerShellCommands } from "./commands/shell-command-registry.js";
import {
  ShellCompletionProvider,
  createAgentCompletionSource,
  createCommandCompletionSource,
  createInMemoryCompletionUsageStore,
  createWorkspaceReferenceCompletionSource,
  type ShellCompletionAgent,
} from "./completion-provider.js";
import { ShellCompletionFlow } from "./flows/completion-flow.js";
import { ShellModelDialogBridge } from "./flows/model-provider-bridge.js";
import { ShellModelSelectionFlow } from "./flows/model-selection-flow.js";
import { ShellOperatorOverlayFlow } from "./flows/operator-overlay-flow.js";
import { ShellOverlayLifecycleFlow } from "./flows/overlay-lifecycle-flow.js";
import { ShellPromptMemoryFlow } from "./flows/prompt-memory-flow.js";
import { ShellProviderAuthFlow } from "./flows/provider-auth-flow.js";
import { ShellQuestionOverlayFlow } from "./flows/question-overlay-flow.js";
import { ShellSessionWorkflow } from "./flows/session-workflow.js";
import {
  ShellViewPreferencesFlow,
  normalizeDiffPreferences,
  normalizeShellViewPreferences,
} from "./flows/view-preferences-flow.js";
import { ShellTranscriptProjector } from "./projectors/transcript-projector.js";
import { cloneCliShellPromptParts, promptPartArraysEqual } from "./prompt-parts.js";
import { buildOpenQuestionsFromRequest, questionRequestsFromSnapshot } from "./question-utils.js";
import type {
  ShellAction,
  ShellCommitBatch,
  ShellCommitInput,
  ShellCommitOptions,
  ShellEffect,
  ShellIntent,
} from "./shell-actions.js";
import { routeShellInput } from "./shell-input-router.js";
import { shellBuiltInKeybindings } from "./shell-keymap.js";
import {
  createShellRuntimeState,
  reduceShellRuntimeAction,
  type CliShellRuntimeState,
} from "./shell-runtime-state.js";
import { updateShellIntent } from "./shell-update.js";
import { type CliShellAction, type CliShellViewState } from "./state/index.js";
import { buildTextTranscriptMessage } from "./transcript.js";
import {
  buildTrustLoopIdleProjection,
  buildTrustLoopSessionProjection,
} from "./trust-loop/projection.js";
import type {
  CliShellOverlayPayload,
  CliShellPromptPart,
  CliShellPromptStorePort,
  CliShellSessionBundle,
  CliShellUiPort,
  OperatorSurfaceSnapshot,
  SessionViewPort,
  CliShellInput,
} from "./types.js";
import { createCliShellUiPortController } from "./ui-port.js";

export interface CliShellRuntimeOptions {
  cwd: string;
  verbose?: boolean;
  initialMessage?: string;
  openSession(sessionId: string): Promise<CliShellSessionBundle>;
  createSession(): Promise<CliShellSessionBundle>;
  onBundleChange?(bundle: CliShellSessionBundle): void;
  openExternalEditor?(title: string, prefill?: string): Promise<string | undefined>;
  openExternalPager?(title: string, lines: readonly string[]): Promise<boolean>;
  operatorPollIntervalMs?: number;
  promptStore?: CliShellPromptStorePort;
  completionAgents?: readonly ShellCompletionAgent[] | (() => readonly ShellCompletionAgent[]);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readQuestionOption(value: unknown): { label: string; description?: string } | null {
  const record = asRecord(value);
  const label =
    typeof record?.label === "string" && record.label.trim().length > 0
      ? record.label.trim()
      : null;
  if (!label) {
    return null;
  }
  const description =
    typeof record?.description === "string" && record.description.trim().length > 0
      ? record.description.trim()
      : undefined;
  return description ? { label, description } : { label };
}

function buildInteractiveQuestionRequest(input: {
  sessionId: string;
  request: BrewvaInteractiveQuestionRequest;
}): SessionQuestionRequest | null {
  const questions: SessionQuestionRequest["questions"] = [];
  for (const [index, question] of input.request.questions.entries()) {
    const normalizedQuestion = normalizeQuestionPrompt(question);
    if (!normalizedQuestion) {
      return null;
    }
    questions.push({
      questionId: `tool:${input.request.toolCallId}:question:${index + 1}`,
      header: normalizedQuestion.header,
      questionText: normalizedQuestion.question,
      options: normalizedQuestion.options
        .map((option) => readQuestionOption(option))
        .filter((option): option is { label: string; description?: string } => option !== null),
      ...(normalizedQuestion.multiple === true ? { multiple: true } : {}),
      custom: normalizedQuestion.custom,
    });
  }
  if (questions.length === 0) {
    return null;
  }
  return {
    requestId: `tool:${input.request.toolCallId}`,
    sessionId: input.sessionId,
    createdAt: Date.now(),
    presentationKind: "input_request",
    sourceKind: "skill",
    sourceEventId: `tool:${input.request.toolCallId}`,
    sourceLabel: "tool:question",
    questions,
  };
}

interface PendingInteractiveQuestionRequest {
  overlayId: string;
  sessionId: string;
  settle(value: readonly (readonly string[])[] | undefined): void;
}

function isShellActionArray(input: ShellCommitInput): input is readonly ShellAction[] {
  return Array.isArray(input);
}

function isShellCommitBatch(input: ShellCommitInput): input is ShellCommitBatch {
  return !isShellActionArray(input) && !("type" in input);
}

type CliShellStatusAction = Extract<
  CliShellAction,
  { type: "status.set" | "status.setTrust" | "status.working" | "status.hiddenThinking" }
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
  readonly #completionFlow: ShellCompletionFlow;
  readonly #keybindings: KeybindingResolver;
  readonly #modelSelectionFlow: ShellModelSelectionFlow;
  readonly #operatorOverlayFlow: ShellOperatorOverlayFlow;
  readonly #overlayFlow: ShellOverlayLifecycleFlow;
  readonly #promptMemoryFlow: ShellPromptMemoryFlow;
  readonly #providerAuthFlow: ShellProviderAuthFlow;
  readonly #questionOverlayFlow: ShellQuestionOverlayFlow;
  readonly #sessionWorkflow: ShellSessionWorkflow;
  readonly #transcriptProjector: ShellTranscriptProjector;
  readonly #viewPreferencesFlow: ShellViewPreferencesFlow;

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
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #statusTimer: ReturnType<typeof setTimeout> | undefined;
  #queuedStatusActions: CliShellAction[] = [];
  #resolveExit: (() => void) | undefined;
  readonly #exitPromise: Promise<void>;
  #seenApprovals = new Set<string>();
  #seenQuestions = new Set<string>();
  #viewportRows = 24;
  #semanticInputQueue: Promise<void> = Promise.resolve();
  #transcriptNavigationRequestId = 0;
  #dialogResolvers = new Map<string, (value: unknown) => void>();
  #pendingInteractiveQuestionRequests = new Map<string, PendingInteractiveQuestionRequest>();
  #started = false;
  #disposed = false;

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
    this.#completionFlow = new ShellCompletionFlow({
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
      submitComposer: () => this.#sessionWorkflow.submitComposer(),
    });
    this.#promptMemoryFlow = new ShellPromptMemoryFlow(
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
    this.#uiController = createCliShellUiPortController({
      commit: (action) => this.commit(action),
      getState: () => this.#state,
      requestDialog: (request) => this.requestDialog(request),
      requestCustom: (kind, payload, dialogOptions) =>
        this.requestCustom(kind, payload, dialogOptions),
      openExternalEditor: (title, prefill) => this.openExternalEditor(title, prefill),
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
    this.#questionOverlayFlow = new ShellQuestionOverlayFlow({
      notify: (message, level) => this.ui.notify(message, level),
      replaceActiveOverlay: (payload) => this.#overlayFlow.replaceActiveOverlay(payload),
      closeActiveOverlay: (cancelled) => this.#overlayFlow.closeActiveOverlay(cancelled),
      runShellEffects: (effects) => this.runShellEffects(effects),
      refreshOperatorSnapshot: () => this.refreshOperatorSnapshotEffect(),
      settleInteractiveQuestionRequest: (requestId, value) =>
        this.settleInteractiveQuestionRequest(requestId, value),
    });
    this.#operatorOverlayFlow = new ShellOperatorOverlayFlow({
      notify: (message, level) => this.ui.notify(message, level),
      commit: (action, commitOptions) => this.commit(action, commitOptions),
      runShellEffects: (effects) => this.runShellEffects(effects),
      refreshOperatorSnapshot: () => this.refreshOperatorSnapshotEffect(),
      closeActiveOverlay: (cancelled) => this.#overlayFlow.closeActiveOverlay(cancelled),
      openPagerOverlay: (target, pagerOptions) =>
        this.#overlayFlow.openPagerOverlay(target, pagerOptions),
      getExternalPagerTarget: () => this.getExternalPagerTarget(),
      getCurrentSessionId: () => this.#sessionPort.getSessionId(),
      createSession: async () =>
        this.#sessionWorkflow.switchBundle(await this.#operatorPort.createSession()),
      openSession: async (sessionId) =>
        this.#sessionWorkflow.switchBundle(await this.#operatorPort.openSession(sessionId)),
      handleQuestionPrimary: async (active) => {
        await this.#questionOverlayFlow.handleInput(active, {
          key: "enter",
          ctrl: false,
          meta: false,
          shift: false,
        });
      },
    });
    const modelDialogBridge = new ShellModelDialogBridge();
    this.#providerAuthFlow = new ShellProviderAuthFlow({
      getBundle: () => this.#bundle,
      getSessionPort: () => this.#sessionPort,
      getState: () => this.#state,
      getUi: () => this.ui,
      openOverlay: (payload, priority) => this.#overlayFlow.openOverlay(payload, priority),
      replaceActiveOverlay: (payload) => this.#overlayFlow.replaceActiveOverlay(payload),
      closeActiveOverlay: (cancelled) => this.#overlayFlow.closeActiveOverlay(cancelled),
      modelDialog: modelDialogBridge,
      requestDialog: (request, dialogOptions) => this.requestDialog(request, dialogOptions),
      runShellEffects: (effects, effectOptions) => this.runShellEffects(effects, effectOptions),
    });
    this.#modelSelectionFlow = new ShellModelSelectionFlow(
      {
        getBundle: () => this.#bundle,
        getSessionPort: () => this.#sessionPort,
        getState: () => this.#state,
        getUi: () => this.ui,
        commit: (actions, commitOptions) => this.commit(actions, commitOptions),
        buildSessionStatusActions: () => this.buildSessionStatusActions(),
        buildCommandPalettePayload: (query) =>
          buildCommandPalettePayload({ commandProvider: this.#commandProvider, query }),
        openOverlay: (payload, priority) => this.#overlayFlow.openOverlay(payload, priority),
        replaceActiveOverlay: (payload) => this.#overlayFlow.replaceActiveOverlay(payload),
        closeActiveOverlay: (cancelled) => this.#overlayFlow.closeActiveOverlay(cancelled),
      },
      this.#providerAuthFlow,
    );
    modelDialogBridge.bind(this.#modelSelectionFlow);
    this.#sessionWorkflow = new ShellSessionWorkflow({
      cwd: options.cwd,
      getState: () => this.#state,
      getBundle: () => this.#bundle,
      getSessionPort: () => this.#sessionPort,
      getSessionGeneration: () => this.#sessionGeneration,
      getUi: () => this.ui,
      promptMemory: this.#promptMemoryFlow,
      transcriptProjector: this.#transcriptProjector,
      modelSelection: this.#modelSelectionFlow,
      providerAuth: this.#providerAuthFlow,
      commit: (actions, commitOptions) => this.commit(actions, commitOptions),
      runShellEffects: (effects) => this.runShellEffects(effects),
      handleShellCommand: (prompt) => this.handleShellCommand(prompt),
      buildSessionStatusActions: () => this.buildSessionStatusActions(),
      dismissPendingInteractiveQuestionRequests: (input) =>
        this.dismissPendingInteractiveQuestionRequests(input),
      mountSession: (nextBundle) => this.mountSession(nextBundle),
      initializeState: () => this.initializeState(),
      refreshOperatorSnapshot: () => this.refreshOperatorSnapshotEffect(),
    });
    this.#overlayFlow = new ShellOverlayLifecycleFlow({
      getState: () => this.#state,
      getViewportRows: () => this.#viewportRows,
      getBundle: () => this.#bundle,
      getSessionPort: () => this.#sessionPort,
      getOperatorSnapshot: () => this.#operatorSnapshot,
      getDraftsBySessionId: () => this.#sessionWorkflow.getDraftsBySessionId(),
      getCommandProvider: () => this.#commandProvider,
      commit: (actions, commitOptions) => this.commit(actions, commitOptions),
      handleShellIntent: (intent) => this.handleShellIntent(intent),
      submitComposer: () => this.#sessionWorkflow.submitComposer(),
      resolveDialog: (dialogId, value) => this.resolveDialog(dialogId, value),
      settleInteractiveQuestionRequest: (requestId, value) =>
        this.settleInteractiveQuestionRequest(requestId, value),
      operatorOverlay: this.#operatorOverlayFlow,
      modelSelection: this.#modelSelectionFlow,
      providerAuth: this.#providerAuthFlow,
      questionOverlay: this.#questionOverlayFlow,
    });
    this.#viewPreferencesFlow = new ShellViewPreferencesFlow({
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
      typeof this.#bundle.runtime.agentId === "string" ? this.#bundle.runtime.agentId : "";
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

  getViewState(): CliShellViewState {
    return this.#state;
  }

  getToolDefinitions(): CliShellSessionBundle["toolDefinitions"] {
    return this.#bundle.toolDefinitions;
  }

  getSessionIdentity(): {
    sessionId: string;
    modelLabel: string;
    thinkingLevel: string;
  } {
    return {
      sessionId: this.#sessionPort.getSessionId(),
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

  async openSessionById(sessionId: string): Promise<void> {
    try {
      await this.#sessionWorkflow.switchBundle(await this.#operatorPort.openSession(sessionId));
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
    this.#pollTimer = setInterval(() => {
      void this.runShellEffects([
        { type: "operator.refresh", sessionGeneration: this.#sessionGeneration },
      ]);
    }, this.options.operatorPollIntervalMs ?? 750);
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
      await this.#sessionWorkflow.submitComposer();
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
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
    }
    if (this.#statusTimer) {
      clearTimeout(this.#statusTimer);
    }
    this.#unsubscribeSession?.();
    this.#listeners.clear();
    this.#resolveExit?.();
  }

  setViewportSize(columns: number, _rows: number): void {
    void columns;
    this.#viewportRows = Math.max(12, _rows);
  }

  syncComposerFromEditor(text: string, cursor: number, parts: CliShellPromptPart[] = []): void {
    if (
      this.#state.composer.text === text &&
      this.#state.composer.cursor === cursor &&
      promptPartArraysEqual(this.#state.composer.parts, parts)
    ) {
      return;
    }
    this.commit(
      {
        type: "composer.setPromptState",
        text,
        cursor,
        parts: cloneCliShellPromptParts(parts),
      },
      { debounceStatus: false },
    );
  }

  setCompletionSelection(index: number): void {
    this.#completionFlow.select(index);
  }

  acceptCurrentCompletion(): void {
    this.#completionFlow.accept();
  }

  syncTranscriptScrollState(followMode: "live" | "scrolled", scrollOffset: number): void {
    if (
      this.#state.transcript.followMode === followMode &&
      this.#state.transcript.scrollOffset === Math.max(0, scrollOffset)
    ) {
      return;
    }
    this.commit(
      {
        type: "transcript.setScrollState",
        followMode,
        scrollOffset,
      },
      { debounceStatus: false },
    );
  }

  acknowledgeTranscriptNavigation(requestId: number): void {
    if (this.#state.transcript.navigationRequest?.id !== requestId) {
      return;
    }
    this.commit({ type: "transcript.clearNavigation", id: requestId }, { debounceStatus: false });
  }

  openOverlay(payload: CliShellOverlayPayload, priority: OverlayPriority = "normal"): void {
    this.#overlayFlow.openOverlay(payload, priority);
  }

  wantsInput(input: CliShellInput): boolean {
    return this.routeInput(input).handled;
  }

  async handleInput(input: CliShellInput): Promise<boolean> {
    const task = this.#semanticInputQueue.then(() => this.handleInputNow(input));
    this.#semanticInputQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return await task;
  }

  private async handleInputNow(input: CliShellInput): Promise<boolean> {
    try {
      const route = this.routeInput(input);
      if (!route.handled) {
        return false;
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

  private routeInput(input: CliShellInput) {
    return routeShellInput({
      input,
      state: {
        activeOverlayKind: this.#state.overlay.active?.payload?.kind,
        hasCompletion: Boolean(this.#state.composer.completion),
        canNavigatePromptHistoryPrevious: this.#promptMemoryFlow.canNavigate(-1, input),
        canNavigatePromptHistoryNext: this.#promptMemoryFlow.canNavigate(1, input),
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
    this.#seenApprovals = new Set();
    this.#seenQuestions = new Set();
    const restoredDraft = this.#sessionWorkflow.getDraftsBySessionId().get(sessionId);
    this.#promptMemoryFlow.resetNavigation();
    this.#completionFlow.clearDismissedForCurrentSession();
    const shellViewPreferences = normalizeShellViewPreferences(
      this.#sessionPort.getShellViewPreferences(),
    );
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
        messages: this.#transcriptProjector.buildMessagesFromSession(),
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
    return [
      {
        type: "status.set",
        key: "model",
        text: modelLabel,
      },
      {
        type: "status.set",
        key: "thinking",
        text: this.#sessionPort.getThinkingLevel(),
      },
      {
        type: "status.set",
        key: "correction",
        text: this.buildCorrectionStatusText(),
      },
    ];
  }

  private buildCorrectionStatusText(): string | undefined {
    const state = this.#sessionPort.getCorrectionState();
    if (state.undoAvailable && state.redoAvailable) {
      return "undo: /undo · redo: /redo";
    }
    if (state.redoAvailable) {
      return "redo: /redo";
    }
    if (state.undoAvailable) {
      return "undo: /undo";
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
      void this.handleShellIntent({ type: "session.event", event });
    });
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
      this.#store = createShellRuntimeState({ sessionGeneration: reset.sessionGeneration });
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
      this.#overlayFlow.syncNotificationsOverlay();
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
    for (const effect of effects) {
      if (this.#disposed) {
        return;
      }
      try {
        await this.driveShellEffect(effect);
      } catch (error) {
        if (options.errorMode === "throw") {
          throw error;
        }
        if (!this.#disposed) {
          this.ui.notify(error instanceof Error ? error.message : "Shell effect failed.", "error");
        }
      }
    }
  }

  private async driveShellEffect(effect: ShellEffect): Promise<void> {
    switch (effect.type) {
      case "input.handle":
        await this.handleInputNow(effect.input);
        return;
      case "runtime.exit":
        this.#resolveExit?.();
        return;
      case "notification.show":
        this.ui.notify(effect.message, effect.level);
        return;
      case "command.invokeById": {
        const intent = this.#commandProvider.createCommandIntent(effect.commandId, {
          args: "",
          source: effect.source,
        });
        if (intent) {
          await this.handleShellIntent(intent);
        }
        return;
      }
      case "composer.submit":
        await this.#sessionWorkflow.submitComposer();
        return;
      case "composer.insertNewline":
        this.ui.pasteToEditor("\n");
        return;
      case "promptHistory.navigate":
        this.#promptMemoryFlow.navigate(effect.direction);
        return;
      case "promptMemory.stashCurrent":
        this.#promptMemoryFlow.stashCurrentPrompt();
        return;
      case "promptMemory.restoreLatest":
        this.#promptMemoryFlow.restoreLatestStash();
        return;
      case "promptMemory.selectStashed":
        await this.#promptMemoryFlow.selectStashedPrompt();
        return;
      case "completion.accept":
        this.#completionFlow.accept();
        return;
      case "completion.submit":
        await this.#completionFlow.submit();
        return;
      case "completion.move":
        this.#completionFlow.move(effect.delta);
        return;
      case "completion.dismiss":
        this.#completionFlow.dismiss();
        return;
      case "dialog.input": {
        const active = this.#state.overlay.active?.payload;
        if (active?.kind === "input") {
          this.#overlayFlow.handleInputOverlayInput(active, effect.input);
        }
        return;
      }
      case "question.input":
        await this.#overlayFlow.handleQuestionInput(effect.input);
        return;
      case "picker.input":
        await this.#overlayFlow.handlePickerInput(effect.input);
        return;
      case "overlay.input":
        await this.#overlayFlow.handleGenericInput(effect.input);
        return;
      case "overlay.closeActive":
        this.#overlayFlow.closeActiveOverlay(effect.cancelled);
        return;
      case "overlay.primary":
        await this.#overlayFlow.handlePrimary();
        return;
      case "overlay.moveSelection":
        this.#overlayFlow.moveSelection(effect.delta);
        return;
      case "overlay.scrollPage":
        this.#overlayFlow.scrollPage(effect.direction);
        return;
      case "overlay.toggleFullscreen":
        this.#overlayFlow.toggleFullscreen();
        return;
      case "overlay.openCommandPalette":
        this.#overlayFlow.openCommandPalette(effect.query ?? "");
        return;
      case "overlay.openHelpHub":
        this.#overlayFlow.openHelpHub();
        return;
      case "overlay.openSessions":
        this.#overlayFlow.openSessionsOverlay();
        return;
      case "overlay.openInspect":
        await this.#overlayFlow.openInspectOverlay();
        return;
      case "overlay.openNotifications":
        this.#overlayFlow.openNotificationsOverlay();
        return;
      case "pager.externalActive":
        await this.openActivePagerExternally();
        return;
      case "transcript.navigate":
        this.requestTranscriptNavigation(effect.kind);
        return;
      case "session.projectEvent":
        try {
          this.#transcriptProjector.handleSessionEvent(effect.event);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Failed to render the latest session event.";
          this.ui.notify(message, "error");
          this.#transcriptProjector.appendMessage(
            buildTextTranscriptMessage({
              id: `system:event:${Date.now()}`,
              role: "system",
              text: `TUI render error while handling ${effect.event.type}: ${message}`,
            }),
          );
        }
        return;
      case "session.abort":
        await this.#sessionPort.abort();
        if (effect.notification) {
          this.ui.notify(effect.notification, "warning");
        }
        return;
      case "session.create":
        await this.#sessionWorkflow.switchBundle(await this.#operatorPort.createSession());
        return;
      case "session.undoCorrection":
        await this.#sessionWorkflow.undoLastCorrection();
        return;
      case "session.redoCorrection":
        await this.#sessionWorkflow.redoLastCorrection();
        return;
      case "model.open":
        await this.#modelSelectionFlow.openModelsDialog(
          effect.query ? { query: effect.query } : {},
        );
        return;
      case "model.cycleRecent":
        await this.#modelSelectionFlow.cycleRecentModel();
        return;
      case "provider.openConnect":
        await this.#providerAuthFlow.openConnectDialog(effect.query ?? "");
        return;
      case "thinking.open":
        await this.#modelSelectionFlow.openThinkingDialog();
        return;
      case "view.toggleThinking":
        this.#viewPreferencesFlow.toggleThinkingVisibility();
        return;
      case "view.toggleToolDetails":
        this.#viewPreferencesFlow.toggleToolDetails();
        return;
      case "view.toggleDiffWrap":
        this.#viewPreferencesFlow.toggleDiffWrapMode();
        return;
      case "view.toggleDiffStyle":
        this.#viewPreferencesFlow.toggleDiffStyle();
        return;
      case "theme.list": {
        const themeNames = this.ui
          .getAllThemes()
          .map((theme) => theme.name)
          .join(", ");
        this.ui.notify(`Available themes: ${themeNames}`, "info");
        return;
      }
      case "theme.set": {
        const result = this.ui.setTheme(effect.selection);
        if (result.success) {
          this.ui.notify(`Theme switched to ${effect.selection}.`, "info");
        } else {
          this.ui.notify(result.error, "warning");
        }
        return;
      }
      case "completion.refresh":
        this.#completionFlow.refresh();
        return;
      case "operator.refresh":
        if (effect.sessionGeneration === this.#sessionGeneration) {
          await this.refreshOperatorSnapshot(effect.sessionGeneration);
        }
        return;
      case "operator.decideApproval":
        await this.#operatorPort.decideApproval(effect.requestId, effect.input);
        return;
      case "operator.answerQuestion":
        await this.#operatorPort.answerQuestion(effect.questionId, effect.answerText);
        return;
      case "operator.answerQuestionRequest":
        await this.#operatorPort.answerQuestionRequest(effect.requestId, effect.answers);
        return;
      case "operator.stopTask":
        await this.#operatorPort.stopTask(effect.runId);
        return;
      case "status.flush":
        this.scheduleStatusFlush(effect.delayMs);
        return;
      case "session.prompt":
        if (effect.sessionGeneration === this.#sessionGeneration) {
          await this.#sessionPort.prompt(effect.parts, effect.options);
        }
        return;
      case "external.editor": {
        const edited = await this.openExternalEditor(effect.title, effect.prefill);
        if (typeof edited === "string" && !this.#disposed) {
          this.commit({
            type: "composer.setText",
            text: edited,
            cursor: edited.length,
          });
        }
        return;
      }
      case "external.pager": {
        const opened = await this.openExternalPager(effect.title, effect.lines);
        if (!opened && !this.#disposed) {
          this.ui.notify("No external pager is available for the current shell.", "warning");
        }
        return;
      }
      case "provider.connectApiKey": {
        const connectionPort = this.#bundle.providerConnections;
        if (!connectionPort) {
          throw new Error("Provider connection is unavailable for this session.");
        }
        await connectionPort.connectApiKey(effect.providerId, effect.apiKey, effect.inputs);
        return;
      }
      case "provider.completeOAuth": {
        const connectionPort = this.#bundle.providerConnections;
        if (!connectionPort) {
          throw new Error("Provider connection is unavailable for this session.");
        }
        await connectionPort.completeOAuth(effect.providerId, effect.methodId, effect.code);
        return;
      }
      case "provider.disconnect": {
        const connectionPort = this.#bundle.providerConnections;
        if (!connectionPort) {
          throw new Error("Provider connection is unavailable for this session.");
        }
        await connectionPort.disconnect(effect.providerId);
        return;
      }
      case "clipboard.copy":
        if (!this.ui.copyText) {
          throw new Error("Clipboard copy is unavailable.");
        }
        await this.ui.copyText(effect.text);
        return;
      case "url.open":
        if (!this.ui.openUrl) {
          throw new Error("URL open is unavailable.");
        }
        await this.ui.openUrl(effect.url);
        return;
      default:
        effect satisfies never;
    }
  }

  private scheduleStatusFlush(delayMs: number): void {
    if (this.#statusTimer) {
      return;
    }
    this.#statusTimer = setTimeout(() => {
      this.#statusTimer = undefined;
      const queued = this.#queuedStatusActions.splice(0);
      this.commit(queued, { debounceStatus: false });
    }, delayMs);
  }

  private syncSnapshotOverlay(snapshot: OperatorSurfaceSnapshot): void {
    this.#overlayFlow.syncSnapshotOverlay(snapshot);
  }

  private async refreshOperatorSnapshot(
    sessionGeneration = this.#sessionGeneration,
  ): Promise<void> {
    const snapshot = await this.#operatorPort.getSnapshot();
    if (this.#disposed || sessionGeneration !== this.#sessionGeneration) {
      return;
    }
    this.#operatorSnapshot = snapshot;
    this.syncSnapshotOverlay(snapshot);
    const shouldClearApprovalTrust =
      snapshot.approvals.length === 0 && this.#state.status.trust?.source === "approval";
    const trustActions: CliShellAction[] = [];
    if (snapshot.approvals.length > 0) {
      trustActions.push({
        type: "status.setTrust",
        trust: buildTrustLoopSessionProjection({
          pendingApprovalCount: snapshot.approvals.length,
        }),
      });
    } else if (shouldClearApprovalTrust) {
      trustActions.push({
        type: "status.setTrust",
        trust: buildTrustLoopIdleProjection(),
      });
    }
    this.commit(
      [
        {
          type: "status.set",
          key: "approvals",
          text: String(snapshot.approvals.length),
        },
        {
          type: "status.set",
          key: "questions",
          text: String(snapshot.questions.length),
        },
        {
          type: "status.set",
          key: "tasks",
          text: String(snapshot.taskRuns.length),
        },
        ...trustActions,
      ],
      { debounceStatus: false },
    );

    const newApproval = snapshot.approvals.find((item) => !this.#seenApprovals.has(item.requestId));
    if (newApproval) {
      for (const item of snapshot.approvals) {
        this.#seenApprovals.add(item.requestId);
      }
      this.#overlayFlow.openOverlay(
        {
          kind: "approval",
          selectedIndex: snapshot.approvals.findIndex(
            (item) => item.requestId === newApproval.requestId,
          ),
          snapshot,
        },
        "queued",
      );
    }

    const questionRequests = questionRequestsFromSnapshot(snapshot);
    const newQuestionRequest = questionRequests.find(
      (item) => !this.#seenQuestions.has(item.requestId),
    );
    if (newQuestionRequest) {
      for (const item of questionRequests) {
        this.#seenQuestions.add(item.requestId);
      }
      this.#overlayFlow.openOverlay(
        {
          kind: "question",
          mode: "operator",
          selectedIndex: questionRequests.findIndex(
            (item) => item.requestId === newQuestionRequest.requestId,
          ),
          snapshot,
        },
        "queued",
      );
    }
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
    const intent = this.#commandProvider.createSlashCommandIntent(slashCommand.name, {
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
    if (!dialogId) {
      return;
    }
    const resolve = this.#dialogResolvers.get(dialogId);
    if (!resolve) {
      return;
    }
    this.#dialogResolvers.delete(dialogId);
    resolve(value);
  }

  private settleInteractiveQuestionRequest(
    requestId: string,
    value: readonly (readonly string[])[] | undefined,
  ): void {
    const pending = this.#pendingInteractiveQuestionRequests.get(requestId);
    if (!pending) {
      return;
    }
    this.#pendingInteractiveQuestionRequests.delete(requestId);
    pending.settle(value);
  }

  private dismissPendingInteractiveQuestionRequests(input?: { sessionId?: string }): void {
    for (const [requestId, pending] of this.#pendingInteractiveQuestionRequests.entries()) {
      if (input?.sessionId && pending.sessionId !== input.sessionId) {
        continue;
      }
      this.#pendingInteractiveQuestionRequests.delete(requestId);
      pending.settle(undefined);
      this.#overlayFlow.closeOverlayById(pending.overlayId);
    }
  }

  private async requestDialog<T>(
    request: {
      id: string;
      kind: "confirm" | "input" | "select";
      title: string;
      message?: string;
      options?: string[];
      masked?: boolean;
    },
    options: { priority?: OverlayPriority; suspendCurrent?: boolean } = {},
  ): Promise<T> {
    return await new Promise<T>((resolve) => {
      const settle = (value: unknown): void => {
        resolve(value as T);
      };
      this.#dialogResolvers.set(request.id, settle);
      const payload =
        request.kind === "confirm"
          ? ({
              kind: "confirm",
              dialogId: request.id,
              message: request.message ?? request.title,
            } satisfies CliShellOverlayPayload)
          : request.kind === "input"
            ? ({
                kind: "input",
                dialogId: request.id,
                title: request.title,
                message: request.message,
                value: "",
                masked: request.masked,
              } satisfies CliShellOverlayPayload)
            : ({
                kind: "select",
                dialogId: request.id,
                title: request.title,
                options: request.options ?? [],
                selectedIndex: 0,
              } satisfies CliShellOverlayPayload);
      this.#overlayFlow.openOverlayWithOptions(payload, {
        priority: options.priority ?? "queued",
        suspendCurrent: options.suspendCurrent,
      });
    });
  }

  private async requestCustom<T>(
    kind: string,
    payload: unknown,
    options?: BrewvaUiDialogOptions,
  ): Promise<T> {
    if (kind !== "question" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Unsupported UI custom request.");
    }
    const interactiveRequest = payload as BrewvaInteractiveQuestionRequest;
    const request = buildInteractiveQuestionRequest({
      sessionId: this.#sessionPort.getSessionId(),
      request: interactiveRequest,
    });
    if (!request) {
      throw new Error("Invalid interactive question request.");
    }
    if (options?.signal?.aborted) {
      return undefined as T;
    }

    return await new Promise<T>((resolve) => {
      let settled = false;
      let overlayId = "";
      const settle = (value: readonly (readonly string[])[] | undefined): void => {
        if (settled) {
          return;
        }
        settled = true;
        options?.signal?.removeEventListener("abort", handleAbort);
        this.#pendingInteractiveQuestionRequests.delete(request.requestId);
        resolve(value as T);
      };
      const handleAbort = (): void => {
        settle(undefined);
        if (overlayId) {
          this.#overlayFlow.closeOverlayById(overlayId);
        }
      };
      if (options?.signal) {
        options.signal.addEventListener("abort", handleAbort, { once: true });
      }
      overlayId = this.#overlayFlow.openOverlayWithOptions(
        {
          kind: "question",
          mode: "interactive",
          selectedIndex: 0,
          requestTitle:
            typeof interactiveRequest.title === "string" &&
            interactiveRequest.title.trim().length > 0
              ? interactiveRequest.title.trim()
              : "Agent needs input",
          interactiveRequest,
          snapshot: {
            approvals: [],
            questions: buildOpenQuestionsFromRequest(request),
            taskRuns: [],
            sessions: [],
          },
        },
        {
          priority: "normal",
          suspendCurrent: true,
        },
      );
      this.#pendingInteractiveQuestionRequests.set(request.requestId, {
        overlayId,
        sessionId: request.sessionId,
        settle,
      });
    });
  }

  private async openExternalEditor(title: string, prefill?: string): Promise<string | undefined> {
    if (this.options.openExternalEditor) {
      return await this.options.openExternalEditor(title, prefill);
    }
    const editor = this.#configPort.getEditorCommand();
    if (!editor) {
      this.ui.notify("No VISUAL or EDITOR is configured.", "warning");
      return prefill;
    }
    return await openExternalEditorWithShell(editor, title, prefill);
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
    return this.#overlayFlow.getExternalPagerTarget(filter);
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
    if (this.options.openExternalPager) {
      return await this.options.openExternalPager(title, lines);
    }
    const pager = getExternalPagerCommand();
    if (!pager) {
      return false;
    }
    return await openExternalPagerWithShell(pager, title, lines);
  }
}
