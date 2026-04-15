import { createOperatorRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate";
import {
  createKeybindingResolver,
  type KeybindingContext,
  type OverlayPriority,
} from "@brewva/brewva-tui";
import {
  getExternalPagerCommand,
  openExternalEditorWithShell,
  openExternalPagerWithShell,
} from "../external-process.js";
import { buildSessionInspectReport, resolveInspectDirectory } from "../inspect.js";
import {
  extractMessageError,
  readAssistantMessageEventPartial,
  readMessageRole,
  readMessageStopReason,
  readToolResultMessage,
} from "../message-content.js";
import {
  createOperatorSurfacePort,
  createCliShellPromptStore,
  createSessionViewPort,
  createShellConfigPort,
  createWorkspaceCompletionPort,
} from "./adapters/ports.js";
import {
  acceptComposerCompletion,
  appendPromptHistoryEntry,
  completionStateEquals,
  createPromptHistoryState,
  navigatePromptHistoryState,
  resolveComposerCompletion,
  type DismissedCompletionState,
  type PromptHistoryState,
} from "./controller-composer.js";
import {
  buildInspectSections,
  buildNotificationsOverlayPayload,
  buildOverlayView,
  buildSessionsOverlayPayload,
  CREDENTIAL_HELP_LINES,
  resolveOverlayFocusOwner,
} from "./controller-overlays.js";
import {
  buildCliShellPromptContentParts,
  cloneCliShellPromptParts,
  cloneCliShellPromptStashEntry,
  promptPartArraysEqual,
  summarizePromptSnapshot,
} from "./prompt-parts.js";
import {
  createCliShellState,
  reduceCliShellState,
  type CliShellAction,
  type CliShellCompletionState,
  type CliShellState,
} from "./state/index.js";
import { buildTaskRunOutputLines } from "./task-details.js";
import {
  buildSeedTranscriptMessages,
  buildTextTranscriptMessage,
  buildTranscriptMessageFromMessage,
  upsertToolExecutionIntoTranscriptMessages,
  type CliShellTranscriptMessage,
} from "./transcript.js";
import type {
  CliShellOverlayPayload,
  CliShellPromptPart,
  CliShellPromptStashEntry,
  CliShellPromptStorePort,
  CliShellSessionBundle,
  CliShellUiPort,
  OperatorSurfaceSnapshot,
  SessionViewPort,
} from "./types.js";
import { createCliShellUiPortController } from "./ui-port.js";

export interface CliShellControllerOptions {
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
}

export interface CliShellSemanticInput {
  key: string;
  text?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeBindingKey(key: string): string {
  switch (key) {
    case "return":
    case "linefeed":
      return "enter";
    default:
      return key.toLowerCase();
  }
}

export class CliShellController {
  static readonly PROMPT_HISTORY_LIMIT = 50;
  static readonly STATUS_DEBOUNCE_MS = 120;
  readonly #completionPort;
  readonly #configPort = createShellConfigPort();
  readonly #keybindings = createKeybindingResolver([
    {
      id: "global.exit",
      context: "global",
      trigger: { key: "q", ctrl: true, meta: false, shift: false },
      action: "exit",
    },
    {
      id: "global.abort",
      context: "global",
      trigger: { key: "c", ctrl: true, meta: false, shift: false },
      action: "abortOrExit",
    },
    {
      id: "global.approvals",
      context: "global",
      trigger: { key: "a", ctrl: true, meta: false, shift: false },
      action: "openApprovals",
    },
    {
      id: "global.questions",
      context: "global",
      trigger: { key: "o", ctrl: true, meta: false, shift: false },
      action: "openQuestions",
    },
    {
      id: "global.tasks",
      context: "global",
      trigger: { key: "t", ctrl: true, meta: false, shift: false },
      action: "openTasks",
    },
    {
      id: "global.sessions",
      context: "global",
      trigger: { key: "g", ctrl: true, meta: false, shift: false },
      action: "openSessions",
    },
    {
      id: "global.inspect",
      context: "global",
      trigger: { key: "i", ctrl: true, meta: false, shift: false },
      action: "openInspect",
    },
    {
      id: "global.notifications",
      context: "global",
      trigger: { key: "n", ctrl: true, meta: false, shift: false },
      action: "openNotifications",
    },
    {
      id: "global.editor",
      context: "global",
      trigger: { key: "e", ctrl: true, meta: false, shift: false },
      action: "openEditor",
    },
    {
      id: "global.scrollUp",
      context: "global",
      trigger: { key: "pageup", ctrl: false, meta: false, shift: false },
      action: "scrollUp",
    },
    {
      id: "global.scrollDown",
      context: "global",
      trigger: { key: "pagedown", ctrl: false, meta: false, shift: false },
      action: "scrollDown",
    },
    {
      id: "global.scrollTop",
      context: "global",
      trigger: { key: "home", ctrl: false, meta: false, shift: false },
      action: "scrollTop",
    },
    {
      id: "global.scrollBottom",
      context: "global",
      trigger: { key: "end", ctrl: false, meta: false, shift: false },
      action: "scrollBottom",
    },
    {
      id: "composer.submit",
      context: "composer",
      trigger: { key: "enter", ctrl: false, meta: false, shift: false },
      action: "submit",
    },
    {
      id: "composer.newline",
      context: "composer",
      trigger: { key: "j", ctrl: true, meta: false, shift: false },
      action: "newline",
    },
    {
      id: "composer.stash",
      context: "composer",
      trigger: { key: "s", ctrl: true, meta: false, shift: false },
      action: "stashPrompt",
    },
    {
      id: "composer.unstash",
      context: "composer",
      trigger: { key: "y", ctrl: true, meta: false, shift: false },
      action: "unstashPrompt",
    },
    {
      id: "completion.accept",
      context: "completion",
      trigger: { key: "tab", ctrl: false, meta: false, shift: false },
      action: "acceptCompletion",
    },
    {
      id: "completion.acceptEnter",
      context: "completion",
      trigger: { key: "enter", ctrl: false, meta: false, shift: false },
      action: "acceptCompletion",
    },
    {
      id: "completion.next",
      context: "completion",
      trigger: { key: "down", ctrl: false, meta: false, shift: false },
      action: "nextCompletion",
    },
    {
      id: "completion.nextCtrlN",
      context: "completion",
      trigger: { key: "n", ctrl: true, meta: false, shift: false },
      action: "nextCompletion",
    },
    {
      id: "completion.prev",
      context: "completion",
      trigger: { key: "up", ctrl: false, meta: false, shift: false },
      action: "prevCompletion",
    },
    {
      id: "completion.prevCtrlP",
      context: "completion",
      trigger: { key: "p", ctrl: true, meta: false, shift: false },
      action: "prevCompletion",
    },
    {
      id: "completion.dismiss",
      context: "completion",
      trigger: { key: "escape", ctrl: false, meta: false, shift: false },
      action: "dismissCompletion",
    },
    {
      id: "overlay.close",
      context: "overlay",
      trigger: { key: "escape", ctrl: false, meta: false, shift: false },
      action: "closeOverlay",
    },
    {
      id: "overlay.select",
      context: "overlay",
      trigger: { key: "enter", ctrl: false, meta: false, shift: false },
      action: "overlayPrimary",
    },
    {
      id: "overlay.next",
      context: "overlay",
      trigger: { key: "down", ctrl: false, meta: false, shift: false },
      action: "overlayNext",
    },
    {
      id: "overlay.prev",
      context: "overlay",
      trigger: { key: "up", ctrl: false, meta: false, shift: false },
      action: "overlayPrev",
    },
    {
      id: "overlay.pageDown",
      context: "overlay",
      trigger: { key: "pagedown", ctrl: false, meta: false, shift: false },
      action: "overlayPageDown",
    },
    {
      id: "overlay.pageUp",
      context: "overlay",
      trigger: { key: "pageup", ctrl: false, meta: false, shift: false },
      action: "overlayPageUp",
    },
    {
      id: "pager.external",
      context: "pager",
      trigger: { key: "e", ctrl: true, meta: false, shift: false },
      action: "externalPager",
    },
  ]);
  readonly #listeners = new Set<() => void>();
  readonly #uiController;
  readonly #operatorPort;
  #state = createCliShellState();
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
  #assistantEntryId: string | undefined;
  #resolveExit: (() => void) | undefined;
  readonly #exitPromise: Promise<void>;
  #seenApprovals = new Set<string>();
  #seenQuestions = new Set<string>();
  #viewportRows = 24;
  #semanticInputQueue: Promise<void> = Promise.resolve();
  #transcriptNavigationRequestId = 0;
  #draftsBySessionId = new Map<
    string,
    {
      text: string;
      cursor: number;
      parts: CliShellPromptPart[];
      updatedAt: number;
    }
  >();
  readonly #promptStore;
  #promptHistory: PromptHistoryState = {
    entries: [],
    index: 0,
  };
  #promptStashEntries: CliShellPromptStashEntry[] = [];
  #dismissedCompletionBySessionId = new Map<string, DismissedCompletionState>();
  #started = false;
  #disposed = false;

  constructor(
    bundle: CliShellSessionBundle,
    private readonly options: CliShellControllerOptions,
  ) {
    this.#bundle = bundle;
    this.#sessionPort = createSessionViewPort(bundle);
    this.#completionPort = createWorkspaceCompletionPort(options.cwd);
    this.#promptStore = options.promptStore ?? createCliShellPromptStore();
    this.#promptHistory = createPromptHistoryState(this.#promptStore.loadHistory());
    this.#promptStashEntries = this.#promptStore
      .loadStash()
      .map((entry) => cloneCliShellPromptStashEntry(entry));
    this.#operatorPort = createOperatorSurfacePort({
      getBundle: () => this.#bundle,
      openSession: (sessionId) => options.openSession(sessionId),
      createSession: () => options.createSession(),
    });
    this.#uiController = createCliShellUiPortController({
      dispatch: (action) => this.dispatch(action),
      getState: () => this.#state,
      requestDialog: (request) => this.requestDialog(request),
      openExternalEditor: (title, prefill) => this.openExternalEditor(title, prefill),
      requestRender: () => this.emitChange(),
    });
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve;
    });
    bundle.session.setUiPort(this.ui);
  }

  get ui(): CliShellUiPort {
    return this.#uiController.ui;
  }

  getState(): CliShellState {
    return this.#state;
  }

  getBundle(): CliShellSessionBundle {
    return this.#bundle;
  }

  getOperatorSnapshot(): OperatorSurfaceSnapshot {
    return this.#operatorSnapshot;
  }

  async decideApproval(requestId: string, decision: "accept" | "reject"): Promise<void> {
    await this.#operatorPort.decideApproval(requestId, {
      decision,
      actor: "brewva-cli",
    });
    await this.refreshOperatorSnapshot();
  }

  prefillQuestionAnswer(questionId: string): void {
    const answerPrefix = `/answer ${questionId} `;
    this.dispatch({
      type: "composer.setText",
      text: answerPrefix,
      cursor: answerPrefix.length,
    });
  }

  openTasksOverlay(): void {
    this.openOverlay({ kind: "tasks", selectedIndex: 0, snapshot: this.#operatorSnapshot });
  }

  openSessionsBrowser(): void {
    this.openSessionsOverlay();
  }

  openNotificationsInbox(): void {
    this.openNotificationsOverlay();
  }

  async openInspectPanel(): Promise<void> {
    await this.openInspectOverlay();
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
      void this.refreshOperatorSnapshot().catch((error) => {
        this.ui.notify(
          error instanceof Error ? error.message : "Failed to refresh operator snapshot.",
          "warning",
        );
      });
    }, this.options.operatorPollIntervalMs ?? 750);
    await this.refreshOperatorSnapshot();

    if (this.options.initialMessage?.trim()) {
      const initialMessage = this.options.initialMessage.trim();
      this.dispatch({
        type: "composer.setText",
        text: initialMessage,
        cursor: initialMessage.length,
      });
      await this.submitComposer();
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
    this.dispatch(
      {
        type: "composer.setPromptState",
        text,
        cursor,
        parts: cloneCliShellPromptParts(parts),
      },
      false,
    );
  }

  setCompletionSelection(index: number): void {
    const completion = this.#state.composer.completion;
    if (!completion) {
      return;
    }
    if (index < 0 || index >= completion.items.length || completion.selectedIndex === index) {
      return;
    }
    this.dispatch(
      {
        type: "completion.set",
        completion: {
          ...completion,
          selectedIndex: index,
        },
      },
      false,
    );
  }

  acceptCurrentCompletion(): void {
    this.acceptCompletion();
  }

  syncTranscriptScrollState(followMode: "live" | "scrolled", scrollOffset: number): void {
    if (
      this.#state.transcript.followMode === followMode &&
      this.#state.transcript.scrollOffset === Math.max(0, scrollOffset)
    ) {
      return;
    }
    this.dispatch(
      {
        type: "transcript.setScrollState",
        followMode,
        scrollOffset,
      },
      false,
    );
  }

  acknowledgeTranscriptNavigation(requestId: number): void {
    if (this.#state.transcript.navigationRequest?.id !== requestId) {
      return;
    }
    this.dispatch({ type: "transcript.clearNavigation", id: requestId }, false);
  }

  private getInputContexts(): KeybindingContext[] {
    const activeOverlay = this.#state.overlay.active?.payload;
    if (activeOverlay?.kind === "pager") {
      return ["pager", "overlay", "global"];
    }
    if (activeOverlay) {
      return ["overlay", "global"];
    }
    if (this.#state.composer.completion) {
      return ["completion", "composer", "global"];
    }
    return ["composer", "global"];
  }

  openOverlay(payload: CliShellOverlayPayload, priority: OverlayPriority = "normal"): void {
    this.openOverlayWithOptions(payload, { priority });
  }

  private openOverlayWithOptions(
    payload: CliShellOverlayPayload,
    options: {
      priority?: OverlayPriority;
      suspendCurrent?: boolean;
    } = {},
  ): void {
    const view = buildOverlayView(payload);
    const activeOverlay = this.#state.overlay.active;
    this.dispatch({
      type: "overlay.open",
      overlay: {
        id: `${payload.kind}:${Date.now()}`,
        kind: payload.kind,
        focusOwner: resolveOverlayFocusOwner(payload),
        priority: options.priority ?? "normal",
        suspendFocusOwner: options.suspendCurrent ? activeOverlay?.focusOwner : undefined,
        title: view.title,
        lines: view.lines,
        payload,
      },
    });
  }

  wantsSemanticInput(input: CliShellSemanticInput): boolean {
    const activeOverlay = this.#state.overlay.active?.payload;
    const contexts = this.getInputContexts();

    const binding = this.#keybindings.resolve(contexts, {
      key: normalizeBindingKey(input.key),
      ctrl: input.ctrl,
      meta: input.meta,
      shift: input.shift,
    });
    if (binding) {
      return true;
    }
    if (this.shouldHandlePromptHistoryInput(input)) {
      return true;
    }
    if (activeOverlay) {
      return true;
    }
    return false;
  }

  async handleSemanticInput(input: CliShellSemanticInput): Promise<boolean> {
    const task = this.#semanticInputQueue.then(() => this.handleSemanticInputNow(input));
    this.#semanticInputQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return await task;
  }

  private async handleSemanticInputNow(input: CliShellSemanticInput): Promise<boolean> {
    const activeOverlay = this.#state.overlay.active?.payload;
    try {
      const binding = this.#keybindings.resolve(this.getInputContexts(), {
        key: normalizeBindingKey(input.key),
        ctrl: input.ctrl,
        meta: input.meta,
        shift: input.shift,
      });
      if (binding) {
        await this.handleBinding(binding.action);
        return true;
      }

      if (activeOverlay?.kind === "input") {
        if (normalizeBindingKey(input.key) === "backspace") {
          this.replaceActiveOverlay({
            ...activeOverlay,
            value: activeOverlay.value.slice(0, -1),
          });
          return true;
        }
        if (normalizeBindingKey(input.key) === "character" && typeof input.text === "string") {
          this.replaceActiveOverlay({
            ...activeOverlay,
            value: `${activeOverlay.value}${input.text}`,
          });
          return true;
        }
        return true;
      }

      if (activeOverlay) {
        const handled = await this.handleOverlayShortcut(activeOverlay, input);
        return handled || typeof input.text === "string" || input.key.length > 0;
      }

      if (this.shouldHandlePromptHistoryInput(input)) {
        this.navigatePromptHistory(normalizeBindingKey(input.key) === "up" ? -1 : 1);
        return true;
      }

      return false;
    } catch (error) {
      this.ui.notify(
        error instanceof Error ? error.message : "Failed to process interactive input.",
        "error",
      );
      return true;
    }
  }

  private emitChange(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  private initializeState(): void {
    const sessionId = this.#sessionPort.getSessionId();
    this.#state = createCliShellState();
    this.#assistantEntryId = undefined;
    this.#seenApprovals = new Set();
    this.#seenQuestions = new Set();
    const restoredDraft = this.#draftsBySessionId.get(sessionId);
    this.#promptHistory.index = 0;
    this.#promptHistory.draft = undefined;
    this.#dismissedCompletionBySessionId.delete(sessionId);
    this.applyActions(
      [
        {
          type: "status.title",
          title: `Session ${sessionId} (${this.#sessionPort.getModelLabel()})`,
        },
        {
          type: "status.set",
          key: "thinking",
          text: this.#sessionPort.getThinkingLevel(),
        },
      ],
      false,
    );
    if (this.options.verbose) {
      this.dispatch({
        type: "notification.add",
        notification: {
          id: "startup",
          level: "info",
          message: `Interactive shell attached to ${sessionId}.`,
          createdAt: Date.now(),
        },
      });
    }
    this.#state = reduceCliShellState(this.#state, {
      type: "transcript.setMessages",
      messages: buildSeedTranscriptMessages(this.#sessionPort.getTranscriptSeed()),
    });
    if (restoredDraft) {
      this.#state = reduceCliShellState(this.#state, {
        type: "composer.setPromptState",
        text: restoredDraft.text,
        cursor: restoredDraft.cursor,
        parts: cloneCliShellPromptParts(restoredDraft.parts),
      });
    }
    this.emitChange();
  }

  private mountSession(bundle: CliShellSessionBundle): void {
    this.#bundle = bundle;
    bundle.session.setUiPort(this.ui);
    this.#sessionPort = createSessionViewPort(bundle);
    this.options.onBundleChange?.(bundle);
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = this.#sessionPort.subscribe((event) => {
      try {
        this.handleSessionEvent(event);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to render the latest session event.";
        this.ui.notify(message, "error");
        this.appendTranscriptMessage(
          buildTextTranscriptMessage({
            id: `system:event:${Date.now()}`,
            role: "system",
            text: `TUI render error while handling ${event.type}: ${message}`,
          }),
        );
      }
    });
  }

  private applyActions(actions: readonly CliShellAction[], refreshCompletions = true): void {
    if (actions.length === 0) {
      return;
    }
    for (const action of actions) {
      this.#state = reduceCliShellState(this.#state, action);
    }
    if (
      actions.some(
        (action) =>
          action.type === "notification.add" ||
          action.type === "notification.dismiss" ||
          action.type === "notification.clear",
      )
    ) {
      this.syncNotificationsOverlay();
    }
    if (refreshCompletions) {
      this.refreshCompletion();
    }
    this.emitChange();
  }

  private queueStatusActions(
    actions: readonly CliShellAction[],
    debounceMs = CliShellController.STATUS_DEBOUNCE_MS,
  ): void {
    this.#queuedStatusActions.push(...actions);
    if (this.#statusTimer) {
      return;
    }
    this.#statusTimer = setTimeout(() => {
      this.#statusTimer = undefined;
      const queued = this.#queuedStatusActions.splice(0);
      this.applyActions(queued);
    }, debounceMs);
  }

  private dispatch(action: CliShellAction, debounceStatus = true): void {
    if (action.type.startsWith("status.") && debounceStatus) {
      this.queueStatusActions([action]);
      return;
    }
    this.applyActions([action]);
  }

  private dispatchMany(actions: readonly CliShellAction[], debounceStatus = true): void {
    if (actions.length === 0) {
      return;
    }
    const immediate: CliShellAction[] = [];
    const deferred: CliShellAction[] = [];
    for (const action of actions) {
      if (action.type.startsWith("status.") && debounceStatus) {
        deferred.push(action);
      } else {
        immediate.push(action);
      }
    }
    if (deferred.length > 0) {
      this.queueStatusActions(deferred);
    }
    if (immediate.length > 0) {
      this.applyActions(immediate);
    }
  }

  private findTranscriptMessage(id: string): CliShellTranscriptMessage | undefined {
    return this.#state.transcript.messages.find((message) => message.id === id);
  }

  private replaceTranscriptMessages(messages: readonly CliShellTranscriptMessage[]): void {
    this.dispatch(
      {
        type: "transcript.setMessages",
        messages: [...messages],
      },
      false,
    );
  }

  private appendTranscriptMessage(message: CliShellTranscriptMessage | null): void {
    if (!message) {
      return;
    }
    this.replaceTranscriptMessages([...this.#state.transcript.messages, message]);
  }

  private upsertTranscriptMessage(message: CliShellTranscriptMessage | null): void {
    if (!message) {
      return;
    }
    const existingIndex = this.#state.transcript.messages.findIndex(
      (candidate) => candidate.id === message.id,
    );
    if (existingIndex < 0) {
      this.appendTranscriptMessage(message);
      return;
    }
    const nextMessages = [
      ...this.#state.transcript.messages.slice(0, existingIndex),
      message,
      ...this.#state.transcript.messages.slice(existingIndex + 1),
    ];
    this.replaceTranscriptMessages(nextMessages);
  }

  private readTranscriptText(message: CliShellTranscriptMessage | undefined): string {
    if (!message) {
      return "";
    }
    return message.parts
      .filter(
        (part): part is Extract<CliShellTranscriptMessage["parts"][number], { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => part.text)
      .join("");
  }

  private upsertAssistantTranscriptMessage(
    message: unknown,
    renderMode: "stable" | "streaming",
  ): void {
    const id = this.#assistantEntryId ?? `assistant:${Date.now()}`;
    this.#assistantEntryId = id;
    const nextMessage = buildTranscriptMessageFromMessage(message, {
      id,
      renderMode,
      previousMessage: this.findTranscriptMessage(id),
    });
    this.upsertTranscriptMessage(nextMessage);
  }

  private upsertToolExecutionInTranscript(update: {
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    phase?: string;
    partialResult?: unknown;
    result?: unknown;
    status?: "pending" | "running" | "completed" | "error";
    renderMode?: "stable" | "streaming";
    fallbackMessageId?: string;
  }): void {
    if (typeof update.toolCallId !== "string" || update.toolCallId.length === 0) {
      return;
    }
    this.replaceTranscriptMessages(
      upsertToolExecutionIntoTranscriptMessages(this.#state.transcript.messages, {
        toolCallId: update.toolCallId,
        toolName: update.toolName,
        args: update.args,
        phase: update.phase,
        partialResult: update.partialResult,
        result: update.result,
        status: update.status,
        renderMode: update.renderMode,
        fallbackMessageId: update.fallbackMessageId,
      }),
    );
  }

  private handleSessionEvent(event: BrewvaPromptSessionEvent): void {
    if (event.type === "message_update") {
      const assistantPartialMessage =
        readMessageRole(event.message) === "assistant"
          ? event.message
          : readMessageRole(readAssistantMessageEventPartial(event.assistantMessageEvent)) ===
              "assistant"
            ? readAssistantMessageEventPartial(event.assistantMessageEvent)
            : undefined;
      if (assistantPartialMessage) {
        this.upsertAssistantTranscriptMessage(assistantPartialMessage, "streaming");
        return;
      }

      const delta = asRecord(event.assistantMessageEvent)?.delta;
      if (typeof delta === "string" && delta.length > 0) {
        const id = this.#assistantEntryId ?? `assistant:${Date.now()}`;
        this.#assistantEntryId = id;
        this.upsertTranscriptMessage(
          buildTextTranscriptMessage({
            id,
            role: "assistant",
            text: `${this.readTranscriptText(this.findTranscriptMessage(id))}${delta}`,
            renderMode: "streaming",
          }),
        );
      }
      return;
    }

    if (event.type === "message_end") {
      const role = readMessageRole(event.message);
      const errorMessage =
        role === "assistant" && readMessageStopReason(event.message) === "error"
          ? extractMessageError(event.message)
          : undefined;
      if (errorMessage) {
        this.ui.notify(errorMessage, "error");
      }

      const toolResult = readToolResultMessage(event.message);
      if (toolResult) {
        this.upsertToolExecutionInTranscript({
          toolCallId: toolResult.toolCallId,
          toolName: toolResult.toolName,
          result: toolResult,
          status: toolResult.isError ? "error" : "completed",
          renderMode: "stable",
          fallbackMessageId: `tool:result:${toolResult.toolCallId}`,
        });
        return;
      }

      if (role === "assistant") {
        if (this.#assistantEntryId) {
          this.upsertAssistantTranscriptMessage(event.message, "stable");
          this.#assistantEntryId = undefined;
          return;
        }
        this.appendTranscriptMessage(
          buildTranscriptMessageFromMessage(event.message, {
            id: `assistant:end:${Date.now()}`,
            renderMode: "stable",
          }),
        );
        this.#assistantEntryId = undefined;
        return;
      }

      if (role === "user") {
        // User messages are added optimistically in submitComposer before session.prompt()
        // is called. The session's message_end for user messages is redundant and must be
        // skipped to prevent every submitted prompt appearing twice in the transcript.
        this.#assistantEntryId = undefined;
        return;
      }

      this.appendTranscriptMessage(
        buildTranscriptMessageFromMessage(event.message, {
          id: `${role ?? "message"}:end:${Date.now()}`,
          renderMode: "stable",
        }),
      );
      this.#assistantEntryId = undefined;
      return;
    }

    if (event.type === "tool_execution_start") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.upsertToolExecutionInTranscript({
        toolCallId,
        toolName,
        args: event.args,
        status: "running",
        renderMode: "streaming",
      });
      return;
    }

    if (event.type === "tool_execution_update") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.upsertToolExecutionInTranscript({
        toolCallId,
        toolName,
        args: event.args,
        partialResult: event.partialResult,
        status: "running",
        renderMode: "streaming",
      });
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.upsertToolExecutionInTranscript({
        toolCallId,
        toolName,
        result: event.result,
        status: event.isError ? "error" : "completed",
        renderMode: "stable",
        fallbackMessageId: toolCallId ? `tool:end:${toolCallId}` : undefined,
      });
      return;
    }

    if (event.type === "tool_execution_phase_change") {
      const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
      const toolName = typeof event.toolName === "string" ? event.toolName : undefined;
      this.upsertToolExecutionInTranscript({
        toolCallId,
        toolName,
        args: event.args,
        phase: typeof event.phase === "string" ? event.phase : undefined,
        status: event.phase === "cleanup" ? "completed" : "running",
        renderMode: "streaming",
      });
      return;
    }

    if (event.type === "session_phase_change") {
      const phase = asRecord(event.phase);
      this.dispatch({
        type: "status.set",
        key: "phase",
        text: typeof phase?.kind === "string" ? phase.kind : undefined,
      });
      return;
    }

    if (event.type === "context_state_change") {
      const contextState = asRecord(event.state);
      this.dispatch({
        type: "status.set",
        key: "pressure",
        text:
          typeof contextState?.budgetPressure === "string"
            ? contextState.budgetPressure
            : undefined,
      });
    }
  }

  private syncSnapshotOverlay(snapshot: OperatorSurfaceSnapshot): void {
    const active = this.#state.overlay.active?.payload;
    if (!active) {
      return;
    }

    if (active.kind === "approval") {
      this.replaceActiveOverlay({
        ...active,
        selectedIndex: Math.max(0, Math.min(active.selectedIndex, snapshot.approvals.length - 1)),
        snapshot,
      });
      return;
    }
    if (active.kind === "question") {
      this.replaceActiveOverlay({
        ...active,
        selectedIndex: Math.max(0, Math.min(active.selectedIndex, snapshot.questions.length - 1)),
        snapshot,
      });
      return;
    }
    if (active.kind === "tasks") {
      this.replaceActiveOverlay({
        ...active,
        selectedIndex: Math.max(0, Math.min(active.selectedIndex, snapshot.taskRuns.length - 1)),
        snapshot,
      });
      return;
    }
    if (active.kind === "sessions") {
      this.replaceActiveOverlay(
        this.buildSessionsOverlayPayload(snapshot, {
          sessionId: active.sessions[active.selectedIndex]?.sessionId,
          index: active.selectedIndex,
        }),
      );
    }
  }

  private async refreshOperatorSnapshot(): Promise<void> {
    const snapshot = await this.#operatorPort.getSnapshot();
    this.#operatorSnapshot = snapshot;
    this.syncSnapshotOverlay(snapshot);
    this.dispatchMany([
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
    ]);

    const newApproval = snapshot.approvals.find((item) => !this.#seenApprovals.has(item.requestId));
    if (newApproval) {
      for (const item of snapshot.approvals) {
        this.#seenApprovals.add(item.requestId);
      }
      this.openOverlay(
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

    const newQuestion = snapshot.questions.find(
      (item) => !this.#seenQuestions.has(item.questionId),
    );
    if (newQuestion) {
      for (const item of snapshot.questions) {
        this.#seenQuestions.add(item.questionId);
      }
      this.openOverlay(
        {
          kind: "question",
          selectedIndex: snapshot.questions.findIndex(
            (item) => item.questionId === newQuestion.questionId,
          ),
          snapshot,
        },
        "queued",
      );
    }
  }

  private replaceActiveOverlay(payload: CliShellOverlayPayload): void {
    const active = this.#state.overlay.active;
    if (!active) {
      return;
    }
    const view = buildOverlayView(payload);
    this.dispatch(
      {
        type: "overlay.replace",
        overlay: {
          ...active,
          title: view.title,
          lines: view.lines,
          payload,
        },
      },
      false,
    );
  }

  private async handleOverlayShortcut(
    active: CliShellOverlayPayload,
    input: CliShellSemanticInput,
  ): Promise<boolean> {
    if (input.ctrl || input.meta || normalizeBindingKey(input.key) !== "character" || !input.text) {
      return false;
    }
    const key = input.text.toLowerCase();

    if (active.kind === "approval") {
      const item = active.snapshot.approvals[active.selectedIndex];
      if (!item) {
        return true;
      }
      if (key === "a") {
        await this.#operatorPort.decideApproval(item.requestId, {
          decision: "accept",
          actor: "brewva-cli",
        });
        this.ui.notify(`Approved ${item.requestId}.`, "info");
        this.closeActiveOverlay(false);
        await this.refreshOperatorSnapshot();
        return true;
      }
      if (key === "r") {
        await this.#operatorPort.decideApproval(item.requestId, {
          decision: "reject",
          actor: "brewva-cli",
        });
        this.ui.notify(`Rejected ${item.requestId}.`, "warning");
        this.closeActiveOverlay(false);
        await this.refreshOperatorSnapshot();
        return true;
      }
    }

    if (active.kind === "tasks" && key === "c") {
      const item = active.snapshot.taskRuns[active.selectedIndex];
      if (!item) {
        return true;
      }
      await this.#operatorPort.stopTask(item.runId);
      this.ui.notify(`Stopped task ${item.runId}.`, "warning");
      this.closeActiveOverlay(false);
      await this.refreshOperatorSnapshot();
      return true;
    }

    if (active.kind === "notifications") {
      if (key === "d") {
        const item = active.notifications[active.selectedIndex];
        if (!item) {
          return true;
        }
        this.dispatch(
          {
            type: "notification.dismiss",
            id: item.id,
          },
          false,
        );
        return true;
      }
      if (key === "x") {
        this.dispatch(
          {
            type: "notification.clear",
          },
          false,
        );
        return true;
      }
    }

    if (active.kind === "sessions" && key === "n") {
      await this.switchBundle(await this.#operatorPort.createSession());
      this.closeActiveOverlay(false);
      return true;
    }

    if (active.kind === "confirm") {
      if (key === "y") {
        active.resolve(true);
        this.closeActiveOverlay(false);
        return true;
      }
      if (key === "n") {
        active.resolve(false);
        this.closeActiveOverlay(false);
        return true;
      }
    }

    return false;
  }

  private async handleBinding(action: string): Promise<void> {
    switch (action) {
      case "exit":
        this.#resolveExit?.();
        return;
      case "abortOrExit":
        if (this.#bundle.session.isStreaming) {
          await this.#sessionPort.abort();
          this.ui.notify("Aborted the current turn.", "warning");
          return;
        }
        this.#resolveExit?.();
        return;
      case "submit":
        await this.submitComposer();
        return;
      case "newline":
        this.ui.pasteToEditor("\n");
        return;
      case "stashPrompt":
        this.stashCurrentPrompt();
        return;
      case "unstashPrompt":
        this.restoreLatestStash();
        return;
      case "acceptCompletion":
        this.acceptCompletion();
        return;
      case "nextCompletion":
        this.moveCompletion(1);
        return;
      case "prevCompletion":
        this.moveCompletion(-1);
        return;
      case "dismissCompletion":
        this.dismissCompletion();
        return;
      case "closeOverlay":
        this.closeActiveOverlay(false);
        return;
      case "overlayPrimary":
        await this.handleOverlayPrimary();
        return;
      case "overlayNext":
        this.moveOverlaySelection(1);
        return;
      case "overlayPrev":
        this.moveOverlaySelection(-1);
        return;
      case "overlayPageDown":
        this.scrollActiveOverlay(this.getOverlayPageStep());
        return;
      case "overlayPageUp":
        this.scrollActiveOverlay(-this.getOverlayPageStep());
        return;
      case "externalPager":
        await this.openActivePagerExternally();
        return;
      case "openApprovals":
        this.openOverlay({ kind: "approval", selectedIndex: 0, snapshot: this.#operatorSnapshot });
        return;
      case "openQuestions":
        this.openOverlay({ kind: "question", selectedIndex: 0, snapshot: this.#operatorSnapshot });
        return;
      case "openTasks":
        this.openOverlay({ kind: "tasks", selectedIndex: 0, snapshot: this.#operatorSnapshot });
        return;
      case "openSessions":
        this.openSessionsOverlay();
        return;
      case "openInspect":
        await this.openInspectOverlay();
        return;
      case "openNotifications":
        this.openNotificationsOverlay();
        return;
      case "openEditor": {
        const externalPagerTarget = this.getExternalPagerTarget();
        if (externalPagerTarget) {
          await this.openExternalPagerTarget(externalPagerTarget);
          return;
        }
        const edited = await this.openExternalEditor("brewva-composer", this.#state.composer.text);
        if (typeof edited === "string") {
          this.dispatch({
            type: "composer.setText",
            text: edited,
            cursor: edited.length,
          });
        }
        return;
      }
      case "scrollUp":
        this.requestTranscriptNavigation("pageUp");
        return;
      case "scrollDown":
        this.requestTranscriptNavigation("pageDown");
        return;
      case "scrollTop":
        this.requestTranscriptNavigation("top");
        return;
      case "scrollBottom":
        this.requestTranscriptNavigation("bottom");
        return;
      default:
        return;
    }
  }

  private refreshCompletion(): void {
    const result = resolveComposerCompletion({
      text: this.#state.composer.text,
      cursor: this.#state.composer.cursor,
      current: this.#state.composer.completion,
      dismissed: this.getDismissedCompletionState(),
      slashCommands: this.#completionPort.listSlashCommands(),
      pathEntries: (query) => this.#completionPort.listPaths(query),
    });
    if (result.clearDismissed) {
      this.clearDismissedCompletionState();
    }
    this.setCompletionState(result.completion);
  }

  private moveCompletion(delta: number): void {
    const completion = this.#state.composer.completion;
    if (!completion || completion.items.length === 0) {
      return;
    }
    const nextIndex =
      (completion.selectedIndex + delta + completion.items.length) % completion.items.length;
    this.dispatch(
      {
        type: "completion.set",
        completion: {
          ...completion,
          selectedIndex: nextIndex,
        },
      },
      false,
    );
  }

  private acceptCompletion(): void {
    const completion = this.#state.composer.completion;
    if (!completion) {
      return;
    }
    const nextState = acceptComposerCompletion({
      completion,
      composer: {
        text: this.#state.composer.text,
        cursor: this.#state.composer.cursor,
        parts: this.#state.composer.parts,
      },
      createPromptPartId: (prefix) =>
        `${prefix}-part:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`,
    });
    if (!nextState) {
      return;
    }
    this.dispatch(
      {
        type: "composer.setPromptState",
        text: nextState.text,
        cursor: nextState.cursor,
        parts: nextState.parts,
      },
      false,
    );
  }

  private dismissCompletion(): void {
    const completion = this.#state.composer.completion;
    if (!completion) {
      return;
    }
    // Match opencode behavior: Escape on an incomplete slash command clears the text entirely
    // rather than leaving a dangling partial "/command" in the composer. This also avoids the
    // dismissed-state bug where backspace back to the same (text, cursor) would keep the
    // completion suppressed.
    if (completion.kind === "slash") {
      const text = this.#state.composer.text;
      if (text.startsWith("/") && !text.includes(" ")) {
        this.dispatch({ type: "composer.setText", text: "", cursor: 0 });
        return;
      }
    }
    this.#dismissedCompletionBySessionId.set(this.#sessionPort.getSessionId(), {
      kind: completion.kind,
      text: this.#state.composer.text,
      cursor: this.#state.composer.cursor,
    });
    this.setCompletionState(undefined);
    this.emitChange();
  }

  private setCompletionState(completion: CliShellCompletionState | undefined): void {
    if (completionStateEquals(this.#state.composer.completion, completion)) {
      return;
    }
    this.#state = reduceCliShellState(this.#state, {
      type: "completion.set",
      completion,
    });
  }

  private async submitComposer(): Promise<void> {
    const promptText = this.#state.composer.text;
    const promptParts = cloneCliShellPromptParts(this.#state.composer.parts);
    const prompt = promptText.trim();
    if (!prompt) {
      return;
    }
    const promptSnapshot = {
      text: promptText,
      parts: promptParts,
    };
    this.#promptHistory = appendPromptHistoryEntry(
      this.#promptHistory,
      promptSnapshot,
      CliShellController.PROMPT_HISTORY_LIMIT,
    );
    this.#promptStore.appendHistory(promptSnapshot);
    const handled = await this.handleShellCommand(prompt);
    if (handled) {
      this.dispatch({
        type: "composer.setText",
        text: "",
        cursor: 0,
      });
      return;
    }
    this.appendTranscriptMessage(
      buildTextTranscriptMessage({
        id: `user:${Date.now()}`,
        role: "user",
        text: prompt,
      }),
    );
    this.dispatch({
      type: "composer.setText",
      text: "",
      cursor: 0,
    });
    await this.#sessionPort.prompt(
      buildCliShellPromptContentParts(this.options.cwd, promptText, promptParts),
      {
        source: "interactive",
        streamingBehavior: this.#bundle.session.isStreaming ? "followUp" : undefined,
      },
    );
  }

  private shouldHandlePromptHistoryInput(input: CliShellSemanticInput): boolean {
    if (
      input.ctrl ||
      input.meta ||
      input.shift ||
      this.#state.overlay.active?.payload ||
      this.#state.composer.completion
    ) {
      return false;
    }
    const key = normalizeBindingKey(input.key);
    const history = this.#promptHistory;
    if (key === "up") {
      return this.#state.composer.cursor === 0 && history.entries.length > 0;
    }
    if (key === "down") {
      return this.#state.composer.cursor === this.#state.composer.text.length && history.index > 0;
    }
    return false;
  }

  private navigatePromptHistory(direction: -1 | 1): void {
    const result = navigatePromptHistoryState({
      history: this.#promptHistory,
      direction,
      composer: {
        text: this.#state.composer.text,
        cursor: this.#state.composer.cursor,
        parts: this.#state.composer.parts,
      },
    });
    if (!result) {
      return;
    }
    this.#promptHistory = result.history;
    this.dispatch(
      {
        type: "composer.setPromptState",
        text: result.composer.text,
        cursor: result.composer.cursor,
        parts: result.composer.parts,
      },
      false,
    );
  }

  private getDismissedCompletionState(): DismissedCompletionState | undefined {
    return this.#dismissedCompletionBySessionId.get(this.#sessionPort.getSessionId());
  }

  private clearDismissedCompletionState(): void {
    this.#dismissedCompletionBySessionId.delete(this.#sessionPort.getSessionId());
  }

  private stashCurrentPrompt(): void {
    const snapshot = {
      text: this.#state.composer.text,
      parts: cloneCliShellPromptParts(this.#state.composer.parts),
    };
    if (snapshot.text.trim().length === 0) {
      this.ui.notify("Nothing to stash yet. Type a prompt, then press Ctrl+S.", "warning");
      return;
    }
    const entry = this.#promptStore.pushStash(snapshot);
    this.#promptStashEntries = [
      ...this.#promptStashEntries,
      cloneCliShellPromptStashEntry(entry),
    ].slice(-CliShellController.PROMPT_HISTORY_LIMIT);
    this.dispatch(
      {
        type: "composer.setText",
        text: "",
        cursor: 0,
      },
      false,
    );
    this.ui.notify(
      `Stashed prompt: ${summarizePromptSnapshot(snapshot)}. Press Ctrl+Y to restore the latest draft.`,
      "info",
    );
  }

  private restoreLatestStash(): void {
    const entry = this.#promptStore.popStash();
    if (!entry) {
      this.ui.notify(
        "No stashed prompts yet. Press Ctrl+S to stash the current prompt first.",
        "warning",
      );
      return;
    }
    this.#promptStashEntries = this.#promptStore
      .loadStash()
      .map((item) => cloneCliShellPromptStashEntry(item));
    this.dispatch(
      {
        type: "composer.setPromptState",
        text: entry.text,
        cursor: entry.text.length,
        parts: cloneCliShellPromptParts(entry.parts),
      },
      false,
    );
    this.ui.notify(`Restored stashed prompt: ${summarizePromptSnapshot(entry)}`, "info");
  }

  private async selectStashedPrompt(): Promise<void> {
    if (this.#promptStashEntries.length === 0) {
      this.ui.notify(
        "No stashed prompts yet. Press Ctrl+S to stash the current prompt first.",
        "warning",
      );
      return;
    }
    const options = this.#promptStashEntries
      .map((entry, index, items) => {
        const reverseIndex = items.length - index;
        return `${reverseIndex}. ${summarizePromptSnapshot(entry)}`;
      })
      .toReversed();
    const selection = await this.requestDialog<string | undefined>({
      id: `stash:${Date.now()}`,
      kind: "select",
      title: "Select Stashed Prompt",
      options,
      resolve: (value) => value,
    });
    if (!selection) {
      return;
    }
    const match = /^(\d+)\.\s/u.exec(selection);
    if (!match?.[1]) {
      return;
    }
    const ordinal = Number.parseInt(match[1], 10);
    if (Number.isNaN(ordinal) || ordinal <= 0) {
      return;
    }
    const index = this.#promptStashEntries.length - ordinal;
    const entry = this.#promptStashEntries[index];
    if (!entry) {
      return;
    }
    this.dispatch(
      {
        type: "composer.setPromptState",
        text: entry.text,
        cursor: entry.text.length,
        parts: cloneCliShellPromptParts(entry.parts),
      },
      false,
    );
  }

  private async handleShellCommand(prompt: string): Promise<boolean> {
    if (prompt === "/quit" || prompt === "/exit") {
      this.#resolveExit?.();
      return true;
    }
    if (prompt === "/sessions") {
      this.openSessionsOverlay();
      return true;
    }
    if (prompt === "/questions") {
      this.openOverlay({ kind: "question", selectedIndex: 0, snapshot: this.#operatorSnapshot });
      return true;
    }
    if (prompt === "/approvals") {
      this.openOverlay({ kind: "approval", selectedIndex: 0, snapshot: this.#operatorSnapshot });
      return true;
    }
    if (prompt === "/tasks") {
      this.openOverlay({ kind: "tasks", selectedIndex: 0, snapshot: this.#operatorSnapshot });
      return true;
    }
    if (prompt === "/inspect") {
      await this.openInspectOverlay();
      return true;
    }
    if (prompt === "/notifications" || prompt === "/inbox") {
      this.openNotificationsOverlay();
      return true;
    }
    if (prompt === "/new") {
      await this.switchBundle(await this.#operatorPort.createSession());
      return true;
    }
    if (prompt === "/credentials" || prompt === "/auth") {
      this.openOverlay({
        kind: "pager",
        title: "Credentials",
        lines: [...CREDENTIAL_HELP_LINES],
        scrollOffset: 0,
      });
      return true;
    }
    if (prompt === "/stash") {
      await this.selectStashedPrompt();
      return true;
    }
    if (prompt === "/stash pop" || prompt === "/unstash") {
      this.restoreLatestStash();
      return true;
    }
    if (prompt === "/theme" || prompt === "/theme list") {
      const themeNames = this.ui
        .getAllThemes()
        .map((theme) => theme.name)
        .join(", ");
      this.ui.notify(`Available themes: ${themeNames}`, "info");
      return true;
    }
    if (prompt.startsWith("/theme ")) {
      const selection = prompt.slice("/theme ".length).trim();
      if (selection.length === 0) {
        this.ui.notify("Usage: /theme <name>", "warning");
        return true;
      }
      const result = this.ui.setTheme(selection);
      if (result.success) {
        this.ui.notify(`Theme switched to ${selection}.`, "info");
      } else {
        this.ui.notify(result.error ?? "Unknown theme selection.", "warning");
      }
      return true;
    }
    if (prompt.startsWith("/answer ")) {
      const [questionId, ...answerParts] = prompt.slice("/answer ".length).trim().split(/\s+/u);
      const answerText = answerParts.join(" ").trim();
      if (!questionId || !answerText) {
        this.ui.notify("Usage: /answer <questionId> <text>", "warning");
        return true;
      }
      await this.#operatorPort.answerQuestion(questionId, answerText);
      await this.refreshOperatorSnapshot();
      return true;
    }
    return false;
  }

  private moveOverlaySelection(delta: number): void {
    const active = this.#state.overlay.active?.payload;
    if (!active) {
      return;
    }
    if (active.kind === "pager") {
      this.scrollActiveOverlay(delta);
      return;
    }
    if (
      active.kind === "approval" ||
      active.kind === "question" ||
      active.kind === "tasks" ||
      active.kind === "sessions" ||
      active.kind === "notifications" ||
      active.kind === "inspect" ||
      active.kind === "select"
    ) {
      const items =
        active.kind === "approval"
          ? active.snapshot.approvals
          : active.kind === "question"
            ? active.snapshot.questions
            : active.kind === "tasks"
              ? active.snapshot.taskRuns
              : active.kind === "sessions"
                ? active.sessions
                : active.kind === "notifications"
                  ? active.notifications
                  : active.kind === "inspect"
                    ? active.sections
                    : active.options;
      if (items.length === 0) {
        return;
      }
      const selectedIndex = (active.selectedIndex + delta + items.length) % items.length;
      this.replaceActiveOverlay({
        ...active,
        selectedIndex,
      });
    }
  }

  private getTranscriptPageStep(): number {
    return Math.max(3, Math.floor(Math.max(8, this.#viewportRows - 10) / 2));
  }

  private requestTranscriptNavigation(kind: "pageUp" | "pageDown" | "top" | "bottom"): void {
    this.dispatch(
      {
        type: "transcript.requestNavigation",
        request: {
          id: ++this.#transcriptNavigationRequestId,
          kind,
        },
      },
      false,
    );
  }

  private getOverlayPageStep(): number {
    return Math.max(4, Math.floor(Math.max(10, this.#viewportRows - 8) / 2));
  }

  private scrollActiveOverlay(delta: number): void {
    const active = this.#state.overlay.active?.payload;
    if (!active) {
      return;
    }
    if (active.kind === "pager") {
      this.replaceActiveOverlay({
        ...active,
        scrollOffset: Math.max(0, active.scrollOffset + delta),
      });
      return;
    }
    if (active.kind === "inspect") {
      const nextOffsets = [...active.scrollOffsets];
      const currentOffset = nextOffsets[active.selectedIndex] ?? 0;
      nextOffsets[active.selectedIndex] = Math.max(0, currentOffset + delta);
      this.replaceActiveOverlay({
        ...active,
        scrollOffsets: nextOffsets,
      });
    }
  }

  private closeActiveOverlay(cancelled: boolean): void {
    const active = this.#state.overlay.active;
    const payload = active?.payload;
    if (!active || !payload) {
      return;
    }
    if (cancelled) {
      if (payload.kind === "confirm") {
        payload.resolve(false);
      } else if (payload.kind === "input" || payload.kind === "select") {
        payload.resolve(undefined);
      }
    }
    this.dispatch(
      {
        type: "overlay.close",
        id: active.id,
      },
      false,
    );
  }

  private async handleOverlayPrimary(): Promise<void> {
    const active = this.#state.overlay.active?.payload;
    if (!active) {
      return;
    }
    switch (active.kind) {
      case "approval": {
        const item = active.snapshot.approvals[active.selectedIndex];
        if (!item) {
          return;
        }
        await this.#operatorPort.decideApproval(item.requestId, {
          decision: "accept",
          actor: "brewva-cli",
        });
        this.ui.notify(`Approved ${item.requestId}.`, "info");
        this.closeActiveOverlay(false);
        await this.refreshOperatorSnapshot();
        return;
      }
      case "question": {
        const item = active.snapshot.questions[active.selectedIndex];
        if (!item) {
          return;
        }
        const answerPrefix = `/answer ${item.questionId} `;
        this.dispatch({
          type: "composer.setText",
          text: answerPrefix,
          cursor: answerPrefix.length,
        });
        this.closeActiveOverlay(false);
        return;
      }
      case "tasks": {
        const item = active.snapshot.taskRuns[active.selectedIndex];
        if (!item) {
          return;
        }
        const detailTarget = this.getExternalPagerTarget();
        if (!detailTarget) {
          return;
        }
        this.openOverlayWithOptions(
          {
            kind: "pager",
            title: detailTarget.title,
            lines: [...detailTarget.lines],
            scrollOffset: 0,
          },
          {
            suspendCurrent: true,
          },
        );
        return;
      }
      case "sessions": {
        const item = active.sessions[active.selectedIndex];
        if (!item) {
          return;
        }
        if (item.sessionId === this.#sessionPort.getSessionId()) {
          this.closeActiveOverlay(false);
          return;
        }
        await this.switchBundle(await this.#operatorPort.openSession(item.sessionId));
        this.closeActiveOverlay(false);
        return;
      }
      case "notifications": {
        const item = active.notifications[active.selectedIndex];
        if (!item) {
          return;
        }
        const detailTarget = this.getExternalPagerTarget();
        if (!detailTarget) {
          return;
        }
        this.openOverlayWithOptions(
          {
            kind: "pager",
            title: detailTarget.title,
            lines: [...detailTarget.lines],
            scrollOffset: 0,
          },
          {
            suspendCurrent: true,
          },
        );
        return;
      }
      case "confirm":
        active.resolve(true);
        this.closeActiveOverlay(false);
        return;
      case "input":
        active.resolve(active.value.trim().length > 0 ? active.value : undefined);
        this.closeActiveOverlay(false);
        return;
      case "select":
        active.resolve(active.options[active.selectedIndex]);
        this.closeActiveOverlay(false);
        return;
      case "inspect": {
        const section = active.sections[active.selectedIndex];
        if (!section) {
          return;
        }
        const detailTarget = this.getExternalPagerTarget();
        if (!detailTarget) {
          return;
        }
        this.openOverlayWithOptions(
          {
            kind: "pager",
            title: detailTarget.title,
            lines: [...detailTarget.lines],
            scrollOffset: active.scrollOffsets[active.selectedIndex] ?? 0,
          },
          {
            suspendCurrent: true,
          },
        );
        return;
      }
      default:
        this.closeActiveOverlay(false);
    }
  }

  private async openInspectOverlay(): Promise<void> {
    const operatorRuntime = createOperatorRuntimePort(this.#bundle.runtime);
    const report = buildSessionInspectReport({
      runtime: operatorRuntime,
      sessionId: this.#sessionPort.getSessionId(),
      directory: resolveInspectDirectory(operatorRuntime, undefined, undefined),
    });
    const sections = buildInspectSections(report);
    this.openOverlay({
      kind: "inspect",
      lines: sections[0]?.lines ?? [],
      sections,
      selectedIndex: 0,
      scrollOffsets: sections.map(() => 0),
    });
  }

  private buildNotificationsOverlayPayload(
    selection: {
      id?: string;
      index?: number;
    } = {},
  ) {
    return buildNotificationsOverlayPayload(this.#state.notifications, selection);
  }

  private openNotificationsOverlay(): void {
    this.openOverlay(this.buildNotificationsOverlayPayload());
  }

  private buildSessionsOverlayPayload(
    snapshot: OperatorSurfaceSnapshot = this.#operatorSnapshot,
    selection: {
      sessionId?: string;
      index?: number;
    } = {},
  ): CliShellOverlayPayload {
    return buildSessionsOverlayPayload({
      snapshot,
      currentSessionId: this.#sessionPort.getSessionId(),
      draftsBySessionId: this.#draftsBySessionId,
      currentComposerText: this.#state.composer.text,
      selection,
    });
  }

  private openSessionsOverlay(): void {
    this.openOverlay(this.buildSessionsOverlayPayload());
  }

  private syncNotificationsOverlay(): void {
    const active = this.#state.overlay.active?.payload;
    if (active?.kind !== "notifications") {
      return;
    }
    this.replaceActiveOverlay(
      this.buildNotificationsOverlayPayload({
        id: active.notifications[active.selectedIndex]?.id,
        index: active.selectedIndex,
      }),
    );
  }

  private async switchBundle(bundle: CliShellSessionBundle): Promise<void> {
    this.snapshotCurrentDraft();
    this.#bundle.session.dispose();
    this.mountSession(bundle);
    this.initializeState();
    this.ui.notify(
      `Session started: ${this.#sessionPort.getSessionId()} (${this.#sessionPort.getModelLabel()})`,
      "info",
    );
    await this.refreshOperatorSnapshot();
  }

  private snapshotCurrentDraft(): void {
    const sessionId = this.#sessionPort.getSessionId();
    const text = this.#state.composer.text;
    if (text.trim().length === 0) {
      this.#draftsBySessionId.delete(sessionId);
      return;
    }
    this.#draftsBySessionId.set(sessionId, {
      text,
      cursor: this.#state.composer.cursor,
      parts: cloneCliShellPromptParts(this.#state.composer.parts),
      updatedAt: Date.now(),
    });
  }

  private async requestDialog<T>(request: {
    id: string;
    kind: "confirm" | "input" | "select";
    title: string;
    message?: string;
    options?: string[];
    resolve(value: T): void;
  }): Promise<T> {
    return await new Promise<T>((resolve) => {
      const payload =
        request.kind === "confirm"
          ? ({
              kind: "confirm",
              message: request.message ?? request.title,
              resolve: (value: boolean) => {
                request.resolve(value as T);
                resolve(value as T);
              },
            } satisfies CliShellOverlayPayload)
          : request.kind === "input"
            ? ({
                kind: "input",
                message: request.message,
                value: "",
                resolve: (value: string | undefined) => {
                  request.resolve(value as T);
                  resolve(value as T);
                },
              } satisfies CliShellOverlayPayload)
            : ({
                kind: "select",
                options: request.options ?? [],
                selectedIndex: 0,
                resolve: (value: string | undefined) => {
                  request.resolve(value as T);
                  resolve(value as T);
                },
              } satisfies CliShellOverlayPayload);
      this.openOverlay(payload, "queued");
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
    const active = this.#state.overlay.active?.payload;
    if (!active) {
      return undefined;
    }
    if (active.kind === "pager") {
      return {
        title: active.title ?? "brewva-pager",
        lines: active.lines,
      };
    }
    if (filter === "pager") {
      return undefined;
    }
    if (active.kind === "inspect") {
      const section = active.sections[active.selectedIndex];
      if (!section) {
        return undefined;
      }
      return {
        title: section.title,
        lines: section.lines,
      };
    }
    if (active.kind === "tasks") {
      const run = active.snapshot.taskRuns[active.selectedIndex];
      if (!run) {
        return undefined;
      }
      const sessionWireFrames = run.workerSessionId
        ? this.#bundle.runtime.inspect.sessionWire?.query?.(run.workerSessionId)
        : undefined;
      return {
        title: `Task ${run.runId} output`,
        lines: buildTaskRunOutputLines(run, { sessionWireFrames }),
      };
    }
    if (active.kind === "notifications") {
      const notification = active.notifications[active.selectedIndex];
      if (!notification) {
        return undefined;
      }
      return {
        title: `Notification [${notification.level}]`,
        lines: [
          `id: ${notification.id}`,
          `level: ${notification.level}`,
          `createdAt: ${new Date(notification.createdAt).toISOString()}`,
          "",
          ...notification.message.split(/\r?\n/u),
        ],
      };
    }
    return undefined;
  }

  private async openExternalPagerTarget(target: {
    title: string;
    lines: readonly string[];
  }): Promise<void> {
    const opened = await this.openExternalPager(target.title, target.lines);
    if (!opened) {
      this.ui.notify("No external pager is available for the current shell.", "warning");
    }
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
