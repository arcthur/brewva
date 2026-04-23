import { recordSessionShutdownIfMissing } from "@brewva/brewva-gateway";
import { createOperatorRuntimePort } from "@brewva/brewva-runtime";
import type {
  BrewvaDiffPreferences,
  BrewvaShellViewPreferences,
  BrewvaModelPreferences,
  BrewvaPromptSessionEvent,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate";
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
  resolveOverlayFocusOwner,
} from "./controller-overlays.js";
import {
  buildCliShellPromptContentParts,
  cloneCliShellPromptParts,
  cloneCliShellPromptStashEntry,
  expandPromptTextParts,
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
  CliOAuthWaitOverlayPayload,
  CliShellPromptPart,
  CliShellPromptStashEntry,
  CliShellPromptStorePort,
  CliShellSessionBundle,
  CliShellUiPort,
  ProviderConnection,
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderOAuthAuthorization,
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

function hasDiffPreviewPayload(value: unknown): boolean {
  const record = asRecord(value);
  const preview = asRecord(record?.diffPreview ?? record?.previewDiff ?? record?.preview);
  if (!preview) {
    return false;
  }
  if (typeof preview.diff === "string" || typeof preview.error === "string") {
    return true;
  }
  const files = preview.files;
  return Array.isArray(files) && files.length > 0;
}

function toolResultStatus(input: { result?: unknown; isError?: boolean }): "completed" | "error" {
  if (input.isError === true) {
    return "error";
  }
  const details = asRecord(asRecord(input.result)?.details);
  return details?.verdict === "fail" ? "error" : "completed";
}

function normalizeBindingKey(key: string): string {
  switch (key.toLowerCase()) {
    case "return":
    case "linefeed":
      return "enter";
    case "arrowup":
    case "uparrow":
      return "up";
    case "arrowdown":
    case "downarrow":
      return "down";
    case "arrowleft":
    case "leftarrow":
      return "left";
    case "arrowright":
    case "rightarrow":
      return "right";
    case "pageup":
    case "page-up":
      return "pageup";
    case "pagedown":
    case "page-down":
      return "pagedown";
    default:
      return key.toLowerCase();
  }
}

const RECENT_MODEL_LIMIT = 10;

function modelKey(model: Pick<BrewvaSessionModelDescriptor, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function fuzzySearchScore(query: string, target: string): number | null {
  const normalizedQuery = normalizeSearchText(query.trim());
  const normalizedTarget = normalizeSearchText(target);
  if (!normalizedQuery) {
    return 0;
  }
  if (!normalizedTarget) {
    return null;
  }
  if (normalizedTarget === normalizedQuery) {
    return 10_000 - normalizedTarget.length;
  }
  if (normalizedTarget.startsWith(normalizedQuery)) {
    return 8_000 - normalizedTarget.length;
  }
  const containsIndex = normalizedTarget.indexOf(normalizedQuery);
  if (containsIndex >= 0) {
    return 6_000 - containsIndex * 4 - normalizedTarget.length;
  }

  let queryIndex = 0;
  let score = 0;
  let lastMatchIndex = -2;
  let firstMatchIndex = -1;
  for (let targetIndex = 0; targetIndex < normalizedTarget.length; targetIndex++) {
    if (normalizedTarget[targetIndex] !== normalizedQuery[queryIndex]) {
      continue;
    }
    if (firstMatchIndex === -1) {
      firstMatchIndex = targetIndex;
    }
    score += lastMatchIndex === targetIndex - 1 ? 14 : 3;
    score -= Math.max(0, targetIndex - lastMatchIndex - 1);
    lastMatchIndex = targetIndex;
    queryIndex++;
    if (queryIndex >= normalizedQuery.length) {
      break;
    }
  }
  if (queryIndex < normalizedQuery.length) {
    return null;
  }
  return 1_000 + score - Math.max(0, firstMatchIndex) * 2 - normalizedTarget.length;
}

function bestSearchScore(query: string, candidates: readonly string[]): number | null {
  const normalized = query.trim();
  if (!normalized) {
    return 0;
  }
  let best: number | null = null;
  for (const candidate of candidates) {
    const score = fuzzySearchScore(normalized, candidate);
    if (score !== null && (best === null || score > best)) {
      best = score;
    }
  }
  return best;
}

function providerSearchScore(provider: ProviderConnection, query: string): number | null {
  return bestSearchScore(query, [
    provider.id,
    provider.name,
    provider.description ?? "",
    provider.connectionSource,
    ...(provider.modelProviders ?? []),
  ]);
}

function providerCoversModelProvider(provider: ProviderConnection, modelProvider: string): boolean {
  return provider.id === modelProvider || (provider.modelProviders ?? []).includes(modelProvider);
}

function authMethodCredentialProvider(providerId: string, method: ProviderAuthMethod): string {
  return method.credentialProvider ?? providerId;
}

function authMethodModelProviderFilter(providerId: string, method: ProviderAuthMethod): string {
  return method.modelProviderFilter ?? method.credentialProvider ?? providerId;
}

function providerConnectionFooter(provider: ProviderConnection): string {
  if (!provider.connected) {
    if (provider.id === "openai" || provider.id === "openai-codex") {
      return "OAuth/API key";
    }
    if (provider.id === "github-copilot") {
      return "OAuth/token";
    }
    return "API key";
  }
  switch (provider.connectionSource) {
    case "oauth":
      return "OAuth";
    case "vault":
      return "Vault";
    case "environment":
      return "Env";
    case "provider_config":
      return "Config";
    case "none":
      return "Connected";
  }
  return "Connected";
}

function modelMatchesQuery(model: BrewvaSessionModelDescriptor, query: string): boolean {
  return modelSearchScore(model, query) !== null;
}

function modelSearchScore(model: BrewvaSessionModelDescriptor, query: string): number | null {
  return bestSearchScore(query, [
    model.provider,
    model.id,
    model.name ?? "",
    model.displayName ?? "",
    `${model.provider}/${model.id}`,
  ]);
}

function compactModelPreferences(preferences: BrewvaModelPreferences): BrewvaModelPreferences {
  const normalize = (
    entries: readonly Pick<BrewvaSessionModelDescriptor, "provider" | "id">[],
    limit?: number,
  ) => {
    const seen = new Set<string>();
    const output: Array<{ provider: string; id: string }> = [];
    for (const entry of entries) {
      const key = modelKey(entry);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push({ provider: entry.provider, id: entry.id });
      if (limit && output.length >= limit) {
        break;
      }
    }
    return output;
  };
  return {
    recent: normalize(preferences.recent, RECENT_MODEL_LIMIT),
    favorite: normalize(preferences.favorite),
  };
}

function normalizeDiffPreferences(
  preferences: Partial<BrewvaDiffPreferences>,
): BrewvaDiffPreferences {
  return {
    style: preferences.style === "stacked" ? "stacked" : "auto",
    wrapMode: preferences.wrapMode === "none" ? "none" : "word",
  };
}

function normalizeShellViewPreferences(
  preferences: Partial<BrewvaShellViewPreferences>,
): BrewvaShellViewPreferences {
  return {
    showThinking: preferences.showThinking !== false,
    toolDetails: preferences.toolDetails !== false,
  };
}

function modelDisplayName(model: BrewvaSessionModelDescriptor): string {
  return model.displayName ?? model.name ?? model.id;
}

function modelPickerDetail(input: {
  section: string;
  model: BrewvaSessionModelDescriptor;
  favorite: boolean;
}): string | undefined {
  if (input.section === "Favorites" || input.section === "Recent") {
    return input.model.provider;
  }
  return input.favorite ? "(Favorite)" : undefined;
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
      action: "submitCompletion",
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
      id: "overlay.nextCtrlN",
      context: "overlay",
      trigger: { key: "n", ctrl: true, meta: false, shift: false },
      action: "overlayNext",
    },
    {
      id: "overlay.prev",
      context: "overlay",
      trigger: { key: "up", ctrl: false, meta: false, shift: false },
      action: "overlayPrev",
    },
    {
      id: "overlay.prevCtrlP",
      context: "overlay",
      trigger: { key: "p", ctrl: true, meta: false, shift: false },
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
      id: "overlay.fullscreen",
      context: "overlay",
      trigger: { key: "f", ctrl: true, meta: false, shift: false },
      action: "overlayFullscreen",
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

  async openSessionById(sessionId: string): Promise<void> {
    try {
      await this.switchBundle(await this.#operatorPort.openSession(sessionId));
      this.ui.notify(`Opened session ${sessionId}.`, "info");
    } catch (error) {
      this.ui.notify(
        `Failed to open session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
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
    if (activeOverlay?.kind === "input") {
      return true;
    }
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
      if (activeOverlay?.kind === "input") {
        return this.handleInputOverlayInput(activeOverlay, input);
      }

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

      if (activeOverlay?.kind === "modelPicker" || activeOverlay?.kind === "providerPicker") {
        const handledShortcut = await this.handleOverlayShortcut(activeOverlay, input);
        if (handledShortcut) {
          return true;
        }
        const handledText = await this.handlePickerTextInput(activeOverlay, input);
        if (handledText) {
          return true;
        }
        return typeof input.text === "string" || input.key.length > 0;
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
    this.#state = reduceCliShellState(this.#state, {
      type: "diff.setPreferences",
      preferences: normalizeDiffPreferences(this.#sessionPort.getDiffPreferences()),
    });
    const shellViewPreferences = normalizeShellViewPreferences(
      this.#sessionPort.getShellViewPreferences(),
    );
    this.#state = reduceCliShellState(this.#state, {
      type: "view.setPreferences",
      preferences: {
        showThinking: shellViewPreferences.showThinking,
      },
    });
    this.#state = reduceCliShellState(this.#state, {
      type: "status.toolsExpanded",
      expanded: shellViewPreferences.toolDetails,
    });
    this.applyActions(this.buildSessionStatusActions(), false);
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
    ];
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

  private removeTranscriptMessage(id: string): void {
    const nextMessages = this.#state.transcript.messages.filter((message) => message.id !== id);
    if (nextMessages.length === this.#state.transcript.messages.length) {
      return;
    }
    this.replaceTranscriptMessages(nextMessages);
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
          status: toolResultStatus({ result: toolResult, isError: toolResult.isError }),
          renderMode: "stable",
          fallbackMessageId: `tool:result:${toolResult.toolCallId}`,
        });
        return;
      }

      if (role === "assistant") {
        if (asRecord(event.message)?.display === false) {
          if (this.#assistantEntryId) {
            this.removeTranscriptMessage(this.#assistantEntryId);
          }
          this.#assistantEntryId = undefined;
          return;
        }
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
        status: toolResultStatus({ result: event.result, isError: event.isError === true }),
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

  private handleInputOverlayInput(
    active: Extract<CliShellOverlayPayload, { kind: "input" }>,
    input: CliShellSemanticInput,
  ): boolean {
    const key = normalizeBindingKey(input.key);
    if (key === "enter") {
      active.resolve(active.value.trim().length > 0 ? active.value : undefined);
      this.closeActiveOverlay(false);
      return true;
    }
    if (key === "escape") {
      this.closeActiveOverlay(true);
      return true;
    }
    if (key === "backspace") {
      this.replaceActiveOverlay({
        ...active,
        value: active.value.slice(0, -1),
      });
      return true;
    }
    if (!input.ctrl && !input.meta && key === "character" && typeof input.text === "string") {
      this.replaceActiveOverlay({
        ...active,
        value: `${active.value}${input.text}`,
      });
      return true;
    }
    return true;
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

    if (active.kind === "modelPicker" && key === "f") {
      await this.toggleSelectedModelFavorite(active);
      return true;
    }

    if (active.kind === "modelPicker" && key === "c") {
      this.closeActiveOverlay(false);
      await this.openConnectDialog(active.query);
      return true;
    }

    if (active.kind === "providerPicker" && key === "d") {
      await this.disconnectSelectedProvider(active);
      return true;
    }

    if (active.kind === "oauthWait" && key === "c") {
      await this.copyOAuthWaitText(active);
      return true;
    }

    if (active.kind === "oauthWait" && key === "p") {
      void this.submitOAuthWaitManualCode(active);
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
      case "submitCompletion":
        await this.submitCompletion();
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
        this.closeActiveOverlay(true);
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
      case "overlayFullscreen":
        this.toggleActiveOverlayFullscreen();
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

  private async submitCompletion(): Promise<void> {
    const completion = this.#state.composer.completion;
    if (!completion) {
      return;
    }
    const selected = completion.items[completion.selectedIndex];
    if (!selected || completion.kind !== "slash" || selected.enterBehavior !== "submit") {
      this.acceptCompletion();
      return;
    }

    const commandText = `/${selected.value}`;
    this.dispatch(
      {
        type: "composer.setPromptState",
        text: commandText,
        cursor: commandText.length,
        parts: [],
      },
      false,
    );
    await this.submitComposer();
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
    if (!prompt.startsWith("/")) {
      const availableModels = await this.#sessionPort.listModels();
      if (!this.#bundle.session.model || availableModels.length === 0) {
        this.ui.notify(
          availableModels.length === 0
            ? "No connected model provider. Use /connect to add provider auth."
            : "No model selected. Use /models to choose one.",
          "warning",
        );
        if (availableModels.length === 0) {
          await this.openConnectDialog();
        } else {
          await this.openModelsDialog();
        }
        return;
      }
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
        text: expandPromptTextParts(promptText, promptParts).trim(),
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

  private async listProviderConnections(): Promise<ProviderConnection[]> {
    if (this.#bundle.providerConnections) {
      return this.#bundle.providerConnections.listProviders();
    }

    const allModels = await this.#sessionPort.listModels({ includeUnavailable: true });
    const availableModels = await this.#sessionPort.listModels();
    const allByProvider = new Map<string, BrewvaSessionModelDescriptor[]>();
    const availableByProvider = new Map<string, BrewvaSessionModelDescriptor[]>();
    for (const model of allModels) {
      const entries = allByProvider.get(model.provider) ?? [];
      entries.push(model);
      allByProvider.set(model.provider, entries);
    }
    for (const model of availableModels) {
      const entries = availableByProvider.get(model.provider) ?? [];
      entries.push(model);
      availableByProvider.set(model.provider, entries);
    }
    return [...allByProvider.entries()]
      .map(([provider, models]) => {
        const availableModelCount = availableByProvider.get(provider)?.length ?? 0;
        return {
          id: provider,
          name: provider,
          group: "other" as const,
          connected: availableModelCount > 0,
          connectionSource:
            availableModelCount > 0 ? ("provider_config" as const) : ("none" as const),
          modelCount: models.length,
          availableModelCount,
          credentialRef: `vault://${provider}/apiKey`,
        };
      })
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }

  private buildProviderPickerItems(
    providers: readonly ProviderConnection[],
    query: string,
  ): NonNullable<Extract<CliShellOverlayPayload, { kind: "providerPicker" }>["items"]> {
    const scored = providers
      .map((provider) => ({ provider, score: providerSearchScore(provider, query) }))
      .filter(
        (entry): entry is { provider: ProviderConnection; score: number } => entry.score !== null,
      );
    const ordered = query.trim()
      ? scored.toSorted((left, right) => right.score - left.score).map((entry) => entry.provider)
      : scored.map((entry) => entry.provider);
    return ordered.map((provider) => ({
      id: provider.id,
      section: provider.group === "popular" ? "Popular" : "Other",
      label: provider.name,
      marker: provider.connected ? "✓" : undefined,
      detail: provider.connected
        ? `${provider.availableModelCount}/${provider.modelCount} models`
        : (provider.description ?? `${provider.modelCount} models`),
      footer: providerConnectionFooter(provider),
      provider,
    }));
  }

  private async buildProviderPickerPayload(
    input: {
      query?: string;
      selectedProviderId?: string;
      selectedIndex?: number;
    } = {},
  ): Promise<Extract<CliShellOverlayPayload, { kind: "providerPicker" }>> {
    const providers = await this.listProviderConnections();
    const query = input.query ?? "";
    const items = this.buildProviderPickerItems(providers, query);
    const requestedIndex =
      input.selectedProviderId !== undefined
        ? items.findIndex((item) => item.provider.id === input.selectedProviderId)
        : input.selectedIndex;
    const selectedIndex =
      items.length === 0 ? 0 : Math.max(0, Math.min(requestedIndex ?? 0, items.length - 1));
    return {
      kind: "providerPicker",
      title: "Connect a provider",
      query,
      selectedIndex,
      providers,
      items,
    };
  }

  private async openConnectDialog(query = ""): Promise<void> {
    this.openOverlay(await this.buildProviderPickerPayload({ query }));
  }

  private modelPreferences(): BrewvaModelPreferences {
    return compactModelPreferences(this.#sessionPort.getModelPreferences());
  }

  private persistModelPreferences(preferences: BrewvaModelPreferences): void {
    this.#sessionPort.setModelPreferences(compactModelPreferences(preferences));
  }

  private persistDiffPreferences(preferences: BrewvaDiffPreferences): void {
    const normalized = normalizeDiffPreferences(preferences);
    this.#sessionPort.setDiffPreferences(normalized);
    this.dispatch(
      {
        type: "diff.setPreferences",
        preferences: normalized,
      },
      false,
    );
  }

  private persistShellViewPreferences(preferences: BrewvaShellViewPreferences): void {
    const normalized = normalizeShellViewPreferences(preferences);
    this.#sessionPort.setShellViewPreferences(normalized);
    // TODO: Move toolDetails/toolsExpanded into view state once UI port compatibility allows it.
    this.dispatchMany(
      [
        {
          type: "view.setPreferences",
          preferences: {
            showThinking: normalized.showThinking,
          },
        },
        {
          type: "status.toolsExpanded",
          expanded: normalized.toolDetails,
        },
      ],
      false,
    );
  }

  private currentShellViewPreferences(): BrewvaShellViewPreferences {
    return {
      showThinking: this.#state.view.showThinking,
      toolDetails: this.#state.status.toolsExpanded,
    };
  }

  private toggleThinkingVisibility(): void {
    const next = !this.#state.view.showThinking;
    this.persistShellViewPreferences({
      ...this.currentShellViewPreferences(),
      showThinking: next,
    });
    this.ui.notify(next ? "Thinking blocks shown." : "Thinking blocks hidden.", "info");
  }

  private toggleToolDetails(): void {
    const next = !this.#state.status.toolsExpanded;
    this.persistShellViewPreferences({
      ...this.currentShellViewPreferences(),
      toolDetails: next,
    });
    this.ui.notify(next ? "Tool details shown." : "Tool details hidden.", "info");
  }

  private toggleDiffWrapMode(): void {
    const next = this.#state.diff.wrapMode === "word" ? "none" : "word";
    this.persistDiffPreferences({
      ...this.#state.diff,
      wrapMode: next,
    });
    this.ui.notify(next === "word" ? "Diff wrapping enabled." : "Diff wrapping disabled.", "info");
  }

  private toggleDiffStyle(): void {
    const next = this.#state.diff.style === "auto" ? "stacked" : "auto";
    this.persistDiffPreferences({
      ...this.#state.diff,
      style: next,
    });
    this.ui.notify(
      next === "auto"
        ? "Diff style set to auto split/unified."
        : "Diff style set to stacked unified.",
      "info",
    );
  }

  private resolvePreferenceModels(
    preferences: readonly Pick<BrewvaSessionModelDescriptor, "provider" | "id">[],
    allModels: readonly BrewvaSessionModelDescriptor[],
  ): BrewvaSessionModelDescriptor[] {
    const byKey = new Map(allModels.map((model) => [modelKey(model), model]));
    return preferences.flatMap((preference) => {
      const model = byKey.get(modelKey(preference));
      return model ? [model] : [];
    });
  }

  private async buildModelPickerPayload(
    input: {
      query?: string;
      providerFilter?: string;
      selectedModelKey?: string;
      selectedIndex?: number;
    } = {},
  ): Promise<Extract<CliShellOverlayPayload, { kind: "modelPicker" }>> {
    const query = input.query ?? "";
    const allModels = await this.#sessionPort.listModels({ includeUnavailable: true });
    const availableModels = await this.#sessionPort.listModels();
    const availableKeys = new Set(availableModels.map((model) => modelKey(model)));
    const providers = await this.listProviderConnections();
    const preferences = this.modelPreferences();
    const favoriteKeys = new Set(preferences.favorite.map((model) => modelKey(model)));
    const current = this.#bundle.session.model;
    const items: Extract<CliShellOverlayPayload, { kind: "modelPicker" }>["items"] = [];
    const added = new Set<string>();

    const addModel = (section: string, model: BrewvaSessionModelDescriptor): void => {
      const key = modelKey(model);
      if (added.has(`${section}:${key}`)) {
        return;
      }
      const available = availableKeys.has(key);
      const favorite = favoriteKeys.has(key);
      const currentModel = current?.provider === model.provider && current.id === model.id;
      added.add(`${section}:${key}`);
      items.push({
        id: `model:${key}:${section}`,
        kind: "model",
        section,
        provider: model.provider,
        modelId: model.id,
        label: modelDisplayName(model),
        detail: modelPickerDetail({ section, model, favorite }),
        footer: available ? undefined : "Connect",
        marker: currentModel ? "●" : undefined,
        available,
        favorite,
        current: currentModel,
      });
    };

    const hasConnectedProvider = availableModels.length > 0;
    if (!hasConnectedProvider && !input.providerFilter) {
      const providersWithMatchingModels = new Set(
        allModels.filter((model) => modelMatchesQuery(model, query)).map((model) => model.provider),
      );
      const providerItems = providers
        .map((provider) => ({
          provider,
          score: providerSearchScore(provider, query),
        }))
        .filter((entry) => {
          if (!query.trim()) {
            return entry.provider.group === "popular";
          }
          return (
            entry.score !== null ||
            [...providersWithMatchingModels].some((modelProvider) =>
              providerCoversModelProvider(entry.provider, modelProvider),
            )
          );
        })
        .toSorted((left, right) => (right.score ?? 0) - (left.score ?? 0))
        .map((entry) => entry.provider);
      for (const provider of providerItems) {
        items.push({
          id: `connect:${provider.id}`,
          kind: "connect_provider",
          section: "Connect",
          provider: provider.id,
          label: provider.name,
          detail: provider.description ?? `${provider.modelCount} models`,
          footer: providerConnectionFooter(provider),
        });
      }
      return {
        kind: "modelPicker",
        title: "Models",
        query,
        selectedIndex: items.length > 0 ? 0 : 0,
        providerFilter: input.providerFilter,
        items,
        emptyMessage: "No connected providers. Use /connect to add provider auth.",
      };
    }

    const scoredCandidateModels = allModels
      .map((model) => ({
        model,
        score: modelSearchScore(model, query),
      }))
      .filter((entry): entry is { model: BrewvaSessionModelDescriptor; score: number } => {
        if (input.providerFilter && entry.model.provider !== input.providerFilter) {
          return false;
        }
        if (entry.score === null) {
          return false;
        }
        return query || input.providerFilter ? true : availableKeys.has(modelKey(entry.model));
      });

    const candidateModels = query.trim()
      ? scoredCandidateModels
          .toSorted((left, right) => right.score - left.score)
          .map((entry) => entry.model)
      : scoredCandidateModels.map((entry) => entry.model);

    if (!query && !input.providerFilter) {
      for (const model of this.resolvePreferenceModels(preferences.favorite, allModels)) {
        if (candidateModels.some((candidate) => modelKey(candidate) === modelKey(model))) {
          addModel("Favorites", model);
        }
      }
      for (const model of this.resolvePreferenceModels(preferences.recent, allModels)) {
        if (
          !favoriteKeys.has(modelKey(model)) &&
          candidateModels.some((candidate) => modelKey(candidate) === modelKey(model))
        ) {
          addModel("Recent", model);
        }
      }
    }

    const byProvider = new Map<string, BrewvaSessionModelDescriptor[]>();
    for (const model of candidateModels) {
      const entries = byProvider.get(model.provider) ?? [];
      entries.push(model);
      byProvider.set(model.provider, entries);
    }
    for (const [provider, models] of [...byProvider.entries()].toSorted((left, right) =>
      left[0].localeCompare(right[0]),
    )) {
      for (const model of models.toSorted((left, right) =>
        modelDisplayName(left).localeCompare(modelDisplayName(right)),
      )) {
        addModel(provider, model);
      }
    }

    const requestedIndex =
      input.selectedModelKey !== undefined
        ? items.findIndex(
            (item) =>
              item.kind === "model" &&
              `${item.provider}/${item.modelId}` === input.selectedModelKey,
          )
        : input.selectedIndex;
    const selectedIndex =
      items.length === 0 ? 0 : Math.max(0, Math.min(requestedIndex ?? 0, items.length - 1));
    return {
      kind: "modelPicker",
      title: input.providerFilter ? `Models · ${input.providerFilter}` : "Models",
      query,
      selectedIndex,
      providerFilter: input.providerFilter,
      items,
      emptyMessage: "No models match the current filter.",
    };
  }

  private async openModelsDialog(
    input: { query?: string; providerFilter?: string } = {},
  ): Promise<void> {
    this.openOverlay(await this.buildModelPickerPayload(input));
  }

  private async openThinkingDialog(): Promise<void> {
    const levels = this.#sessionPort.getAvailableThinkingLevels();
    const current = this.#sessionPort.getThinkingLevel();
    const items = levels.map((level) => ({
      id: `thinking:${level}`,
      label: level,
      detail: level === "off" ? "no extended thinking" : "extended thinking",
      marker: level === current ? "●" : undefined,
      level,
      current: level === current,
    }));
    this.openOverlay({
      kind: "thinkingPicker",
      title: "Thinking",
      selectedIndex: Math.max(0, levels.indexOf(current)),
      items,
    });
  }

  private async recordRecentModel(model: BrewvaSessionModelDescriptor): Promise<void> {
    const preferences = this.modelPreferences();
    this.persistModelPreferences({
      ...preferences,
      recent: [{ provider: model.provider, id: model.id }, ...preferences.recent].slice(
        0,
        RECENT_MODEL_LIMIT,
      ),
    });
  }

  private async cycleRecentModel(): Promise<void> {
    const preferences = this.modelPreferences();
    if (preferences.recent.length === 0) {
      this.ui.notify("No recent models yet.", "warning");
      return;
    }
    const allModels = await this.#sessionPort.listModels({ includeUnavailable: true });
    const availableModels = await this.#sessionPort.listModels();
    const availableKeys = new Set(availableModels.map((model) => modelKey(model)));
    const resolved = this.resolvePreferenceModels(preferences.recent, allModels).filter((model) =>
      availableKeys.has(modelKey(model)),
    );
    if (resolved.length === 0) {
      this.ui.notify("No recent models are currently connected.", "warning");
      return;
    }
    const currentKey = this.#bundle.session.model ? modelKey(this.#bundle.session.model) : "";
    const currentIndex = resolved.findIndex((model) => modelKey(model) === currentKey);
    const next = resolved[(currentIndex + 1 + resolved.length) % resolved.length] ?? resolved[0];
    if (!next) {
      return;
    }
    await this.#sessionPort.setModel(next);
    await this.recordRecentModel(next);
    this.dispatchMany(this.buildSessionStatusActions(), false);
    this.ui.notify(`Model switched to ${modelKey(next)}.`, "info");
  }

  private async toggleSelectedModelFavorite(
    payload: Extract<CliShellOverlayPayload, { kind: "modelPicker" }>,
  ): Promise<void> {
    const item = payload.items[payload.selectedIndex];
    if (!item || item.kind !== "model" || !item.modelId) {
      return;
    }
    const preferences = this.modelPreferences();
    const key = `${item.provider}/${item.modelId}`;
    const exists = preferences.favorite.some((model) => modelKey(model) === key);
    const favorite = exists
      ? preferences.favorite.filter((model) => modelKey(model) !== key)
      : [{ provider: item.provider, id: item.modelId }, ...preferences.favorite];
    this.persistModelPreferences({
      ...preferences,
      favorite,
    });
    this.replaceActiveOverlay(
      await this.buildModelPickerPayload({
        query: payload.query,
        providerFilter: payload.providerFilter,
        selectedModelKey: key,
      }),
    );
  }

  private async selectAuthMethod(
    methods: readonly ProviderAuthMethod[],
    providerName: string,
  ): Promise<ProviderAuthMethod | undefined> {
    if (methods.length === 0) {
      this.ui.notify(
        `${providerName} does not expose an in-TUI auth flow. Configure provider auth, then reopen /models.`,
        "warning",
      );
      return undefined;
    }
    if (methods.length <= 1) {
      return methods[0];
    }
    return new Promise<ProviderAuthMethod | undefined>((resolve) => {
      const items: Extract<CliShellOverlayPayload, { kind: "authMethodPicker" }>["items"] =
        methods.map((method) => ({
          id: method.id,
          label: method.label,
          detail: method.kind === "oauth" ? "OAuth" : "API key",
          method,
        }));
      this.openOverlay(
        {
          kind: "authMethodPicker",
          title: `Connect ${providerName}`,
          selectedIndex: 0,
          items,
          resolve,
        } satisfies CliShellOverlayPayload,
        "queued",
      );
    });
  }

  private async collectAuthPromptInputs(
    prompts: readonly ProviderAuthPrompt[] | undefined,
  ): Promise<Record<string, string> | undefined> {
    const inputs: Record<string, string> = {};
    for (const prompt of prompts ?? []) {
      if (prompt.when) {
        const value = inputs[prompt.when.key];
        if (value === undefined) {
          continue;
        }
        const matches =
          prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value;
        if (!matches) {
          continue;
        }
      }

      if (prompt.type === "select") {
        const options = prompt.options.map((option, index) =>
          option.hint
            ? `${index + 1}. ${option.label} — ${option.hint}`
            : `${index + 1}. ${option.label}`,
        );
        const selected = await this.requestDialog<string | undefined>({
          id: `auth-prompt:${prompt.key}:${Date.now()}`,
          kind: "select",
          title: prompt.message,
          options,
          resolve: (value) => value,
        });
        if (!selected) {
          return undefined;
        }
        const optionIndex = options.indexOf(selected);
        const option = optionIndex >= 0 ? prompt.options[optionIndex] : undefined;
        if (!option) {
          return undefined;
        }
        inputs[prompt.key] = option.value;
        continue;
      }

      const value = await this.requestDialog<string | undefined>({
        id: `auth-prompt:${prompt.key}:${Date.now()}`,
        kind: "input",
        title: prompt.message,
        message: prompt.placeholder ?? prompt.message,
        masked: prompt.masked,
        resolve: (nextValue) => nextValue,
      });
      if (value === undefined) {
        return undefined;
      }
      inputs[prompt.key] = value.trim();
    }
    return inputs;
  }

  private async copyOAuthTextIfAvailable(authorization: ProviderOAuthAuthorization): Promise<void> {
    if (!authorization.copyText || !this.ui.copyText) {
      return;
    }
    try {
      await this.ui.copyText(authorization.copyText);
      this.ui.notify("Authorization code copied to clipboard.", "info");
    } catch {
      this.ui.notify("Press copy manually if the authorization code was not copied.", "warning");
    }
  }

  private async copyOAuthWaitText(payload: CliOAuthWaitOverlayPayload): Promise<void> {
    if (!this.ui.copyText) {
      this.ui.notify("Clipboard copy is unavailable.", "warning");
      return;
    }
    try {
      await this.ui.copyText(payload.copyText ?? payload.url);
      this.ui.notify("Copied to clipboard.", "info");
    } catch {
      this.ui.notify("Unable to copy automatically.", "warning");
    }
  }

  private async submitOAuthWaitManualCode(payload: CliOAuthWaitOverlayPayload): Promise<void> {
    if (!payload.submitManualCode) {
      await this.copyOAuthWaitText(payload);
      return;
    }
    const code = await this.requestDialog<string | undefined>(
      {
        id: `oauth-manual:${Date.now()}`,
        kind: "input",
        title: payload.title,
        message: payload.manualCodePrompt ?? "Paste the final redirect URL or authorization code.",
        resolve: (value) => value,
      },
      { suspendCurrent: true },
    );
    if (!code?.trim()) {
      return;
    }
    try {
      await payload.submitManualCode(code.trim());
    } catch (error) {
      this.ui.notify(
        error instanceof Error ? error.message : "OAuth authorization failed.",
        "error",
      );
    }
  }

  private async completeProviderOAuth(
    providerId: string,
    providerName: string,
    method: ProviderAuthMethod,
    authorization: ProviderOAuthAuthorization,
  ): Promise<void> {
    const connectionPort = this.#bundle.providerConnections;
    if (!connectionPort) {
      this.ui.notify("Provider connection is unavailable for this session.", "warning");
      return;
    }

    if (authorization.method === "code") {
      const code = await this.requestDialog<string | undefined>({
        id: `oauth-code:${providerId}:${Date.now()}`,
        kind: "input",
        title: method.label,
        message: `${authorization.instructions}\n${authorization.url}`,
        resolve: (value) => value,
      });
      if (!code?.trim()) {
        return;
      }
      await connectionPort.completeOAuth(providerId, method.id, code.trim());
      this.ui.notify(`Connected ${providerName}.`, "info");
      await this.openModelsDialog({
        providerFilter: authMethodModelProviderFilter(providerId, method),
      });
      return;
    }

    await this.copyOAuthTextIfAvailable(authorization);
    if (authorization.openBrowser && this.ui.openUrl) {
      void this.ui.openUrl(authorization.url).catch(() => {});
    }
    let completionHandled = false;
    const handleConnected = async () => {
      if (completionHandled) {
        return;
      }
      completionHandled = true;
      this.ui.notify(`Connected ${providerName}.`, "info");
      if (
        this.#state.overlay.active?.payload?.kind === "input" &&
        this.#state.overlay.active.payload.dialogId?.startsWith("oauth-manual:")
      ) {
        this.closeActiveOverlay(true);
      }
      if (this.#state.overlay.active?.payload?.kind === "oauthWait") {
        this.closeActiveOverlay(false);
      }
      await this.openModelsDialog({
        providerFilter: authMethodModelProviderFilter(providerId, method),
      });
    };
    this.openOverlay({
      kind: "oauthWait",
      title: method.label,
      url: authorization.url,
      instructions: authorization.instructions,
      copyText: authorization.copyText,
      manualCodePrompt: authorization.manualCode?.prompt,
      submitManualCode: authorization.manualCode
        ? async (code) => {
            await connectionPort.completeOAuth(providerId, method.id, code);
            await handleConnected();
          }
        : undefined,
    });
    try {
      await connectionPort.completeOAuth(providerId, method.id);
      await handleConnected();
    } catch (error) {
      if (this.#state.overlay.active?.payload?.kind === "oauthWait") {
        this.closeActiveOverlay(false);
      }
      this.ui.notify(
        error instanceof Error ? error.message : `Failed to connect ${providerName}.`,
        "error",
      );
    }
  }

  private async runProviderOAuthMethod(input: {
    connectionPort: NonNullable<CliShellSessionBundle["providerConnections"]>;
    providerId: string;
    providerName: string;
    method: ProviderAuthMethod;
    inputs: Record<string, string>;
  }): Promise<void> {
    const authorization = await input.connectionPort.authorizeOAuth(
      input.providerId,
      input.method.id,
      input.inputs,
    );
    if (!authorization) {
      this.ui.notify(`${input.providerName} does not expose this OAuth flow.`, "warning");
      return;
    }
    await this.completeProviderOAuth(
      input.providerId,
      input.providerName,
      input.method,
      authorization,
    );
  }

  private async openProviderConnectFlow(providerId: string): Promise<void> {
    const connectionPort = this.#bundle.providerConnections;
    if (!connectionPort) {
      this.ui.notify("Provider connection is unavailable for this session.", "warning");
      return;
    }
    const providers = await connectionPort.listProviders();
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (!provider) {
      this.ui.notify(`Unknown provider: ${providerId}`, "warning");
      return;
    }
    const authMethods = connectionPort.listAuthMethods(provider.id);
    const method = await this.selectAuthMethod(authMethods, provider.name);
    if (!method) {
      return;
    }
    const inputs = await this.collectAuthPromptInputs(method.prompts);
    if (inputs === undefined) {
      return;
    }
    if (method.kind === "oauth") {
      try {
        await this.runProviderOAuthMethod({
          connectionPort,
          providerId: provider.id,
          providerName: provider.name,
          method,
          inputs,
        });
      } catch (error) {
        this.ui.notify(
          error instanceof Error ? error.message : `Failed to connect ${provider.name}.`,
          "error",
        );
      }
      return;
    }
    if (method.kind !== "api_key") {
      this.ui.notify(
        `${provider.name} does not expose an in-TUI auth flow. Configure provider auth, then reopen /models.`,
        "warning",
      );
      return;
    }
    this.openOverlay({
      kind: "input",
      message: `${method.label} for ${provider.name} (${method.credentialRef})`,
      value: "",
      masked: true,
      resolve: (value) => {
        const apiKey = value?.trim();
        if (!apiKey) {
          return;
        }
        void this.connectProviderApiKey(
          authMethodCredentialProvider(provider.id, method),
          provider.name,
          apiKey,
          inputs,
          authMethodModelProviderFilter(provider.id, method),
        );
      },
    });
  }

  private async connectProviderApiKey(
    providerId: string,
    providerName: string,
    apiKey: string,
    inputs?: Record<string, string>,
    modelProviderFilter = providerId,
  ): Promise<void> {
    const connectionPort = this.#bundle.providerConnections;
    if (!connectionPort) {
      this.ui.notify("Provider connection is unavailable for this session.", "warning");
      return;
    }
    try {
      await connectionPort.connectApiKey(providerId, apiKey, inputs);
      this.ui.notify(`Connected ${providerName}.`, "info");
      await this.openModelsDialog({ providerFilter: modelProviderFilter });
    } catch (error) {
      this.ui.notify(
        error instanceof Error ? error.message : `Failed to connect ${providerName}.`,
        "error",
      );
    }
  }

  private startProviderConnectFlow(providerId: string): void {
    void this.openProviderConnectFlow(providerId).catch((error: unknown) => {
      this.ui.notify(
        error instanceof Error ? error.message : `Failed to connect ${providerId}.`,
        "error",
      );
    });
  }

  private startModelProviderConnectFlow(modelProvider: string): void {
    void (async () => {
      const providers = await this.listProviderConnections();
      const provider =
        providers.find((candidate) => providerCoversModelProvider(candidate, modelProvider)) ??
        providers.find((candidate) => candidate.id === modelProvider);
      await this.openProviderConnectFlow(provider?.id ?? modelProvider);
    })().catch((error: unknown) => {
      this.ui.notify(
        error instanceof Error ? error.message : `Failed to connect ${modelProvider}.`,
        "error",
      );
    });
  }

  private async selectProviderPickerItem(
    payload: Extract<CliShellOverlayPayload, { kind: "providerPicker" }>,
  ): Promise<void> {
    const item = payload.items[payload.selectedIndex];
    if (!item) {
      return;
    }
    this.closeActiveOverlay(false);
    this.startProviderConnectFlow(item.provider.id);
  }

  private async disconnectSelectedProvider(
    payload: Extract<CliShellOverlayPayload, { kind: "providerPicker" }>,
  ): Promise<void> {
    const item = payload.items[payload.selectedIndex];
    if (!item) {
      return;
    }
    const connectionPort = this.#bundle.providerConnections;
    if (!connectionPort) {
      this.ui.notify("Provider connection is unavailable for this session.", "warning");
      return;
    }
    await connectionPort.disconnect(item.provider.id);
    this.ui.notify(`Removed vault credential for ${item.provider.name}.`, "info");
    this.replaceActiveOverlay(
      await this.buildProviderPickerPayload({
        query: payload.query,
        selectedProviderId: item.provider.id,
      }),
    );
  }

  private async selectModelPickerItem(
    payload: Extract<CliShellOverlayPayload, { kind: "modelPicker" }>,
  ): Promise<void> {
    const item = payload.items[payload.selectedIndex];
    if (!item) {
      return;
    }
    if (item.kind === "connect_provider") {
      this.closeActiveOverlay(false);
      this.startProviderConnectFlow(item.provider);
      return;
    }
    if (!item.modelId) {
      return;
    }
    if (!item.available) {
      this.closeActiveOverlay(false);
      this.startModelProviderConnectFlow(item.provider);
      return;
    }
    const model = (await this.#sessionPort.listModels({ includeUnavailable: true })).find(
      (candidate) => candidate.provider === item.provider && candidate.id === item.modelId,
    );
    if (!model) {
      this.ui.notify(`Unknown model: ${item.provider}/${item.modelId}`, "warning");
      return;
    }
    await this.#sessionPort.setModel(model);
    await this.recordRecentModel(model);
    this.closeActiveOverlay(false);
    this.dispatchMany(this.buildSessionStatusActions(), false);
    this.ui.notify(`Model switched to ${modelKey(model)}.`, "info");
    if (this.#sessionPort.getAvailableThinkingLevels().length > 1) {
      await this.openThinkingDialog();
    }
  }

  private selectThinkingPickerItem(
    payload: Extract<CliShellOverlayPayload, { kind: "thinkingPicker" }>,
  ): void {
    const item = payload.items[payload.selectedIndex];
    if (!item) {
      return;
    }
    this.#sessionPort.setThinkingLevel(item.level);
    this.closeActiveOverlay(false);
    this.dispatchMany(this.buildSessionStatusActions(), false);
    this.ui.notify(`Thinking level set to ${this.#sessionPort.getThinkingLevel()}.`, "info");
  }

  private async updatePickerQuery(
    payload: Extract<CliShellOverlayPayload, { kind: "modelPicker" | "providerPicker" }>,
    query: string,
  ): Promise<void> {
    if (query === payload.query) {
      return;
    }
    if (payload.kind === "modelPicker") {
      this.replaceActiveOverlay(
        await this.buildModelPickerPayload({
          query,
          providerFilter: payload.providerFilter,
          selectedIndex: 0,
        }),
      );
      return;
    }
    this.replaceActiveOverlay(
      await this.buildProviderPickerPayload({
        query,
        selectedIndex: 0,
      }),
    );
  }

  private async handlePickerTextInput(
    payload: Extract<CliShellOverlayPayload, { kind: "modelPicker" | "providerPicker" }>,
    input: CliShellSemanticInput,
  ): Promise<boolean> {
    const key = normalizeBindingKey(input.key);
    if (key === "backspace") {
      if (payload.query.length === 0) {
        return true;
      }
      await this.updatePickerQuery(payload, payload.query.slice(0, -1));
      return true;
    }
    if (!input.ctrl && !input.meta && key === "character" && typeof input.text === "string") {
      await this.updatePickerQuery(payload, `${payload.query}${input.text}`);
      return true;
    }
    return false;
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
    if (prompt === "/models") {
      await this.openModelsDialog();
      return true;
    }
    if (prompt.startsWith("/models ")) {
      const args = prompt.slice("/models ".length).trim();
      if (args === "recent") {
        await this.cycleRecentModel();
        return true;
      }
      await this.openModelsDialog({ query: args });
      return true;
    }
    if (prompt === "/connect") {
      await this.openConnectDialog();
      return true;
    }
    if (prompt.startsWith("/connect ")) {
      await this.openConnectDialog(prompt.slice("/connect ".length).trim());
      return true;
    }
    if (prompt === "/think") {
      await this.openThinkingDialog();
      return true;
    }
    if (prompt === "/thinking") {
      this.toggleThinkingVisibility();
      return true;
    }
    if (prompt === "/tool-details") {
      this.toggleToolDetails();
      return true;
    }
    if (prompt === "/diffwrap") {
      this.toggleDiffWrapMode();
      return true;
    }
    if (prompt === "/diffstyle") {
      this.toggleDiffStyle();
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
        this.ui.notify(result.error, "warning");
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
      active.kind === "select" ||
      active.kind === "modelPicker" ||
      active.kind === "providerPicker" ||
      active.kind === "thinkingPicker" ||
      active.kind === "authMethodPicker"
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
                    : active.kind === "select"
                      ? active.options
                      : active.items;
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
      return;
    }
    if (active.kind === "approval") {
      const item = active.snapshot.approvals[active.selectedIndex];
      if (!hasDiffPreviewPayload(item)) {
        return;
      }
      this.replaceActiveOverlay({
        ...active,
        previewScrollOffset: Math.max(0, (active.previewScrollOffset ?? 0) + delta),
      });
    }
  }

  private toggleActiveOverlayFullscreen(): void {
    const active = this.#state.overlay.active?.payload;
    if (!active || active.kind !== "approval") {
      return;
    }
    const item = active.snapshot.approvals[active.selectedIndex];
    if (!hasDiffPreviewPayload(item)) {
      return;
    }
    this.replaceActiveOverlay({
      ...active,
      previewExpanded: !active.previewExpanded,
    });
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
      } else if (payload.kind === "authMethodPicker") {
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
      case "modelPicker":
        await this.selectModelPickerItem(active);
        return;
      case "providerPicker":
        await this.selectProviderPickerItem(active);
        return;
      case "thinkingPicker":
        this.selectThinkingPickerItem(active);
        return;
      case "authMethodPicker":
        active.resolve(active.items[active.selectedIndex]?.method);
        this.closeActiveOverlay(false);
        return;
      case "oauthWait":
        void this.submitOAuthWaitManualCode(active);
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
    try {
      recordSessionShutdownIfMissing(this.#bundle.runtime, {
        sessionId: this.#sessionPort.getSessionId(),
        reason: "cli_shell_session_switch",
        source: "cli_shell_controller",
      });
    } catch {
      // best effort terminal receipt for session switching
    }
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

  private async requestDialog<T>(
    request: {
      id: string;
      kind: "confirm" | "input" | "select";
      title: string;
      message?: string;
      options?: string[];
      masked?: boolean;
      resolve(value: T): void;
    },
    options: { priority?: OverlayPriority; suspendCurrent?: boolean } = {},
  ): Promise<T> {
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
                dialogId: request.id,
                title: request.title,
                message: request.message,
                value: "",
                masked: request.masked,
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
      this.openOverlayWithOptions(payload, {
        priority: options.priority ?? "queued",
        suspendCurrent: options.suspendCurrent,
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
