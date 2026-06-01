import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import {
  startBoundaryInterval,
  startBoundaryTimeout,
  type BoundaryIntervalHandle,
} from "@brewva/brewva-effect";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import { safeParseJson, type JsonObject } from "@brewva/brewva-std/json";
import type { BrewvaUiDialogOptions } from "@brewva/brewva-substrate/host-api";
import type {
  BrewvaPromptSessionEvent,
  BrewvaQueuedPromptView,
  SessionPhase,
} from "@brewva/brewva-substrate/session";
import {
  listPersistedPatchSets,
  resolveSessionPatchHistoryPath,
} from "@brewva/brewva-vocabulary/workbench";
import type { PersistedPatchSet } from "@brewva/brewva-vocabulary/workbench";
import { type OverlayPriority } from "../../internal/tui/index.js";
import {
  buildSessionInspectReport,
  formatInspectText,
  resolveInspectDirectory,
} from "../../operator/inspect.js";
import {
  getCliRuntimeCompactionGateStatus,
  getCliRuntimeContextUsage,
  getCliRuntimePendingCompactionReason,
  getCliRuntimeTapeStatus,
  getCliRuntimeTurnProjection,
  recordCliRuntimeTapeHandoff,
  renderCliRuntimeTurnDigest,
} from "../../runtime/runtime-ports.js";
import { buildCommandPalettePayload, parseShellSlashPrompt } from "../commands/command-palette.js";
import { ShellCommandProvider } from "../commands/command-provider.js";
import { registerShellCommands } from "../commands/shell-command-registry.js";
import { loadBrewvaTuiConfig } from "../config/tui-config.js";
import type { ShellAction } from "../domain/actions.js";
import type { ShellCommitBatch, ShellCommitInput, ShellCommitOptions } from "../domain/actions.js";
import {
  describeShellCockpitComposerPolicyBlock,
  resolveShellCockpitComposerSubmitPolicy,
  shellCockpitComposerPolicyAllowsSubmit,
} from "../domain/cockpit/index.js";
import {
  ShellCompletionProvider,
  createAgentCompletionSource,
  createCommandCompletionSource,
  createInMemoryCompletionUsageStore,
  createWorkspaceReferenceCompletionSource,
  type ShellCompletionAgent,
} from "../domain/completion-provider.js";
import type { SessionHandoffDraft, ShellEffect } from "../domain/effects.js";
import { routeShellInput } from "../domain/input-router.js";
import { isShellKeyboardInput, type CliShellInput, type ShellInput } from "../domain/input.js";
import type { ShellIntent } from "../domain/intent.js";
import type { OperatorSurfaceSnapshot } from "../domain/operator-snapshot.js";
import type { CliShellOverlayPayload } from "../domain/overlays/payloads.js";
import { renderTranscriptAsMarkdown } from "../domain/overlays/projectors/transcript-markdown.js";
import { cloneCliShellPromptParts } from "../domain/prompt-parts.js";
import type { CliShellPromptStorePort } from "../domain/prompt.js";
import { updateShellIntent } from "../domain/reducer.js";
import {
  createShellRuntimeState,
  reduceShellRuntimeAction,
  type CliShellRuntimeState,
} from "../domain/runtime-state.js";
import { selectActiveOverlayPayload, selectHasCompletion } from "../domain/selectors.js";
import { isSessionPhase } from "../domain/session-phase.js";
import { type CliShellAction, type CliShellViewState } from "../domain/state.js";
import type { BrewvaResolvedKeymapBindings, BrewvaTuiConfig } from "../domain/tui.js";
import { projectShellViewModel, type ShellViewModel } from "../domain/view-model.js";
import {
  BREWVA_BUILT_IN_KEYMAP_BINDINGS,
  buildBrewvaKeymapBindings,
  buildShortcutOverlayLines,
  pickShortcutLabel,
} from "../keymap/keymap-bindings.js";
import { ShellOverlayLifecycleHandler } from "../overlays/lifecycle.js";
import { createShellConfigPort } from "../ports/config-adapter.js";
import { createOperatorSurfacePort } from "../ports/operator-adapter.js";
import { createCliShellPromptStore, createSessionViewPort } from "../ports/session-adapter.js";
import type { CliShellSessionBundle, SessionViewPort } from "../ports/session-port.js";
import { createCliShellUiPortController } from "../ports/ui-adapter.js";
import type { CliShellUiPort } from "../ports/ui-port.js";
import { ShellTranscriptProjector } from "../projectors/transcript-projector.js";
import { ShellCockpitSync } from "./cockpit-sync.js";
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
import { handleShellRendererInput, type ShellRendererInput } from "./renderer-input-handler.js";

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

const execFileAsync = promisify(execFile);
const GIT_EVIDENCE_SECTION_MAX_LINES = 5_000;
const GIT_EVIDENCE_SECTION_MAX_CHARS = 200_000;

function isShellKeymapInput(
  input: ShellInput,
): input is Extract<ShellInput, { type: "keymap.command" | "keymap.effect" }> {
  return input.type === "keymap.command" || input.type === "keymap.effect";
}

function isHighFrequencySessionProgressEvent(event: BrewvaPromptSessionEvent): boolean {
  return (
    event.type === "message_update" ||
    event.type === "tool_execution_update" ||
    event.type === "session_wire_progress"
  );
}

function isHighFrequencyCockpitProgressEvent(event: BrewvaPromptSessionEvent): boolean {
  return (
    event.type === "message_update" ||
    event.type === "tool_execution_update" ||
    event.type === "session_wire_progress"
  );
}

function isWireFoldTranscriptCandidateEvent(event: BrewvaPromptSessionEvent): boolean {
  return (
    event.type === "message_update" ||
    event.type === "message_end" ||
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end" ||
    event.type === "session_wire_progress"
  );
}

type GitCommandResult =
  | {
      readonly ok: true;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly stdout: string;
      readonly stderr: string;
    };

function trimProcessOutput(value: unknown): string {
  if (typeof value === "string") {
    return value.trimEnd();
  }
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8").trimEnd();
  }
  return "";
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatBoundedGitOutput(text: string, emptyMessage: string): string[] {
  if (text.length === 0) {
    return [emptyMessage];
  }

  const lines: string[] = [];
  let offset = 0;
  let renderedChars = 0;
  let truncated = false;

  while (offset <= text.length) {
    if (lines.length >= GIT_EVIDENCE_SECTION_MAX_LINES) {
      truncated = true;
      break;
    }

    const newlineIndex = text.indexOf("\n", offset);
    const rawLineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const lineEnd = text.charAt(rawLineEnd - 1) === "\r" ? rawLineEnd - 1 : rawLineEnd;
    const line = text.slice(offset, lineEnd);
    const lineSeparatorChars = lines.length === 0 ? 0 : 1;
    const remainingChars = GIT_EVIDENCE_SECTION_MAX_CHARS - renderedChars - lineSeparatorChars;

    if (remainingChars <= 0) {
      truncated = true;
      break;
    }

    if (line.length > remainingChars) {
      lines.push(line.slice(0, remainingChars));
      renderedChars += lineSeparatorChars + remainingChars;
      truncated = true;
      break;
    }

    lines.push(line);
    renderedChars += lineSeparatorChars + line.length;

    if (newlineIndex === -1) {
      break;
    }
    offset = newlineIndex + 1;
  }

  if (truncated) {
    lines.push(
      `... truncated after ${lines.length} lines/${renderedChars} chars; run git diff in your shell for full output.`,
    );
  }

  return lines;
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
    type: "status.set" | "status.setSafety" | "status.working" | "status.hiddenThinking";
  }
>;

function isCliShellStatusAction(action: ShellAction): action is CliShellStatusAction {
  return (
    action.type === "status.set" ||
    action.type === "status.setSafety" ||
    action.type === "status.working" ||
    action.type === "status.hiddenThinking"
  );
}

export class CliShellRuntime {
  static readonly PROMPT_HISTORY_LIMIT = 50;
  static readonly STATUS_DEBOUNCE_MS = 120;
  static readonly STREAMING_RENDER_INTERVAL_MS = 16;
  readonly #configPort = createShellConfigPort();
  readonly #commandProvider = new ShellCommandProvider();
  readonly #completionProvider: ShellCompletionProvider;
  readonly #completionHandler: ShellCompletionHandler;
  readonly #tuiConfig: BrewvaTuiConfig;
  readonly #keymapBindings: BrewvaResolvedKeymapBindings;
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
  #cockpitSync: ShellCockpitSync;
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
  #sessionPhase: SessionPhase = { kind: "idle" };
  #unsubscribeSession: (() => void) | undefined;
  #pollTimer: BoundaryIntervalHandle | undefined;
  #statusTimer: { close(): Promise<void> } | undefined;
  #streamingRenderTimer: ReturnType<typeof setTimeout> | undefined;
  #sessionProgressTimer: ReturnType<typeof setTimeout> | undefined;
  #queuedSessionProgressEvents: BrewvaPromptSessionEvent[] = [];
  #lastSessionProgressFlushAt = 0;
  #queuedStatusActions: CliShellAction[] = [];
  #resolveExit: (() => void) | undefined;
  readonly #exitPromise: Promise<void>;
  #viewportRows = 24;
  #semanticInputQueue: Promise<void> = Promise.resolve();
  #surfaceNavigationRequestId = 0;
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
    registerShellCommands(this.#commandProvider, { cwd: options.cwd, loadFileCommands: true });
    const commandKeymapBindings = this.#commandProvider.keymapCommandBindings();
    const knownKeymapIds = new Set([
      ...BREWVA_BUILT_IN_KEYMAP_BINDINGS.map((binding) => binding.id),
      ...commandKeymapBindings.map((binding) => binding.id),
    ]);
    const tuiConfigResolution = loadBrewvaTuiConfig({
      cwd: options.cwd,
      knownBindingIds: knownKeymapIds,
    });
    this.#tuiConfig = tuiConfigResolution.config;
    for (const warning of tuiConfigResolution.warnings) {
      process.stderr.write(`[tui-config:${warning.code}] ${warning.path}: ${warning.message}\n`);
    }
    this.#keymapBindings = buildBrewvaKeymapBindings({
      commandBindings: commandKeymapBindings,
      overrides: this.#tuiConfig.keymap.bindings,
    });
    const completionUsageStore = createInMemoryCompletionUsageStore(
      promptStore.loadCompletionUsage(),
      (entry) => promptStore.recordCompletionUsage(entry),
    );
    this.#completionProvider = new ShellCompletionProvider({
      sources: [
        createCommandCompletionSource(this.#commandProvider, {
          shortcutLabel: (id) => pickShortcutLabel(this.#keymapBindings, id),
        }),
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
      getWireFoldSnapshot: () =>
        this.#sessionPort.getCockpitWireFoldSnapshot(this.#sessionPort.getSessionId(), {
          refreshDurable: false,
        }),
      getUi: () => this.ui,
      commit: (action, commitOptions) => this.commit(action, commitOptions),
      setMessages: (messages, commitOptions) =>
        this.commit(
          {
            type: "transcript.setMessages",
            messages: [...messages],
          },
          { debounceStatus: false, ...commitOptions },
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
      openSession: async (sessionId) =>
        this.#sessionHandler.switchBundle(await this.#operatorPort.openSession(sessionId)),
      openSubagentFooter: (runId) => this.openSubagentFooter(runId),
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
        requestCockpitSync: () => this.#cockpitSync.requestSync(),
        buildSessionStatusActions: () => this.buildSessionStatusActions(),
        buildCommandPalettePayload: (query) =>
          buildCommandPalettePayload({
            commandProvider: this.#commandProvider,
            query,
            shortcutLabel: (id) => pickShortcutLabel(this.#keymapBindings, id),
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
      getSessionPhase: () => this.#sessionPhase,
      getSessionGeneration: () => this.#sessionGeneration,
      getUi: () => this.ui,
      promptMemory: this.#promptMemoryHandler,
      transcriptProjector: this.#transcriptProjector,
      modelSelection: this.#modelSelectionHandler,
      providerAuth: this.#providerAuthHandler,
      commit: (actions, commitOptions) => this.commit(actions, commitOptions),
      runShellEffects: (effects) => this.runShellEffects(effects),
      handleShellCommand: (prompt) => this.handleShellCommand(prompt),
      getShortcutLabel: (id) => pickShortcutLabel(this.#keymapBindings, id),
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
      getShortcutLabel: (id) => pickShortcutLabel(this.#keymapBindings, id),
      getShortcutOverlayLines: () => buildShortcutOverlayLines(this.#keymapBindings),
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
    this.#cockpitSync = new ShellCockpitSync({
      isDisposed: () => this.#disposed,
      getRuntime: () => this.#bundle.runtime,
      getSessionId: () => this.#sessionPort.getSessionId(),
      getSessionPhase: () => this.#sessionPhase,
      getModelLabel: () => this.#sessionPort.getModelLabel(),
      getOperatorSnapshot: () => this.#operatorSnapshot,
      getObservation: () => this.#state.cockpit.observation,
      getRewindTargets: () => this.#sessionPort.listRewindTargets(),
      getSessionWireFrames: (sessionId, readOptions) =>
        this.#sessionPort.getSessionWireFrames(sessionId, readOptions),
      getCockpitWireFoldSnapshot: (sessionId, readOptions) =>
        this.#sessionPort.getCockpitWireFoldSnapshot(sessionId, readOptions),
      commit: (action, commitOptions) => this.commit(action, commitOptions),
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

  getSessionWireFrames(sessionId: string) {
    return this.#sessionPort.getSessionWireFrames(sessionId);
  }

  getToolDefinitions(): CliShellSessionBundle["toolDefinitions"] {
    return this.#bundle.toolDefinitions;
  }

  getTuiConfig(): BrewvaTuiConfig {
    return this.#tuiConfig;
  }

  getKeymapBindings(): BrewvaResolvedKeymapBindings {
    return this.#keymapBindings;
  }

  getShortcutLabel(id: string): string | undefined {
    return pickShortcutLabel(this.#keymapBindings, id);
  }

  getSessionIdentity(): {
    sessionId: string;
    assistantLabel: string;
    lineageLabel: string | null;
    modelLabel: string;
    thinkingLevel: string;
  } {
    const lineageStatus = this.#sessionPort.getLineageStatus();
    return {
      sessionId: this.#sessionPort.getSessionId(),
      assistantLabel: this.formatAssistantStatusLabel(),
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

  requestRender(): void {
    this.emitChange();
  }

  submitComposer(): void {
    void this.#sessionHandler.submitComposer({ waitForPromptEffect: false });
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

  async decideApproval(requestId: string, decision: "accept" | "deny" | "cancel"): Promise<void> {
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
    this.#cockpitSync.syncNow();
    this.#pollTimer = startBoundaryInterval({
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
    this.#cockpitSync.syncNow();

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
    this.flushSessionProgressEvents();
    this.dismissPendingInteractiveQuestionRequests();
    const pollTimer = this.#pollTimer;
    const statusTimer = this.#statusTimer;
    const streamingRenderTimer = this.#streamingRenderTimer;
    const sessionProgressTimer = this.#sessionProgressTimer;
    this.#disposed = true;
    this.#started = false;
    this.#pollTimer = undefined;
    this.#statusTimer = undefined;
    this.#streamingRenderTimer = undefined;
    this.#sessionProgressTimer = undefined;
    this.#queuedSessionProgressEvents = [];
    this.#lastSessionProgressFlushAt = 0;
    void pollTimer?.close();
    void statusTimer?.close();
    if (streamingRenderTimer) {
      clearTimeout(streamingRenderTimer);
      this.emitChange();
    }
    if (sessionProgressTimer) {
      clearTimeout(sessionProgressTimer);
    }
    this.#cockpitSync.dispose();
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
    if (!isShellKeyboardInput(input) && !isShellKeymapInput(input)) {
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
        switch (input.type) {
          case "keymap.command":
            return await this.handleShellIntent({
              type: "command.invoke",
              commandId: input.commandId,
              args: "",
              source: input.source,
            });
          case "keymap.effect":
            return await this.handleShellIntent({
              type: "effect.dispatch",
              effect: input.effect,
            });
          default:
            return await this.handleRendererInput(input);
        }
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

  private async handleRendererInput(input: ShellRendererInput): Promise<boolean> {
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
        isStreaming: this.#bundle.session.isStreaming === true,
        canNavigatePromptHistoryPrevious: this.#promptMemoryHandler.canNavigate(-1, input),
        canNavigatePromptHistoryNext: this.#promptMemoryHandler.canNavigate(1, input),
      },
    });
  }

  private emitChange(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }

  private requestStreamingRender(): void {
    if (this.#disposed || this.#streamingRenderTimer) {
      return;
    }
    this.#streamingRenderTimer = setTimeout(() => {
      this.#streamingRenderTimer = undefined;
      if (!this.#disposed) {
        this.emitChange();
      }
    }, CliShellRuntime.STREAMING_RENDER_INTERVAL_MS);
  }

  private clearQueuedSessionProgressEvents(): void {
    if (this.#sessionProgressTimer) {
      clearTimeout(this.#sessionProgressTimer);
      this.#sessionProgressTimer = undefined;
    }
    this.#queuedSessionProgressEvents = [];
    this.#lastSessionProgressFlushAt = 0;
  }

  private enqueueSessionProgressEvent(event: BrewvaPromptSessionEvent): void {
    if (this.#disposed) {
      return;
    }
    this.#queuedSessionProgressEvents.push(event);
    if (this.#sessionProgressTimer) {
      return;
    }

    const elapsedMs = Date.now() - this.#lastSessionProgressFlushAt;
    if (
      this.#lastSessionProgressFlushAt === 0 ||
      elapsedMs >= CliShellRuntime.STREAMING_RENDER_INTERVAL_MS
    ) {
      this.flushSessionProgressEvents();
      return;
    }

    this.#sessionProgressTimer = setTimeout(() => {
      this.#sessionProgressTimer = undefined;
      this.flushSessionProgressEvents();
    }, CliShellRuntime.STREAMING_RENDER_INTERVAL_MS - elapsedMs);
  }

  private flushSessionProgressEvents(): void {
    if (this.#sessionProgressTimer) {
      clearTimeout(this.#sessionProgressTimer);
      this.#sessionProgressTimer = undefined;
    }
    if (this.#queuedSessionProgressEvents.length === 0) {
      return;
    }
    const events = this.#queuedSessionProgressEvents;
    this.#queuedSessionProgressEvents = [];
    this.#lastSessionProgressFlushAt = Date.now();
    if (this.#disposed) {
      return;
    }
    const useWireFoldProjection = this.#sessionPort.getProjectionMode() === "wireFold";
    if (useWireFoldProjection && events.some(isWireFoldTranscriptCandidateEvent)) {
      const transcriptChanged = this.#transcriptProjector.refreshFromWireFold();
      let requestCockpitProgress = false;
      for (const event of events) {
        if (isWireFoldTranscriptCandidateEvent(event)) {
          requestCockpitProgress ||= isHighFrequencyCockpitProgressEvent(event);
          continue;
        }
        this.projectSessionEvent(event);
      }
      if (transcriptChanged) {
        this.requestStreamingRender();
      }
      if (requestCockpitProgress) {
        this.#cockpitSync.requestProgressSync();
      }
      return;
    }
    for (const event of events) {
      this.projectSessionEvent(event);
    }
  }

  private handleSessionPortEvent(event: BrewvaPromptSessionEvent): void {
    if (event.type === "queue.changed" && isQueuedPromptViewArray(event.items)) {
      this.flushSessionProgressEvents();
      this.applyQueueProjection(event.items);
      return;
    }
    if (isHighFrequencySessionProgressEvent(event)) {
      this.enqueueSessionProgressEvent(event);
      return;
    }
    this.flushSessionProgressEvents();
    this.projectSessionEvent(event);
  }

  private projectSessionEvent(event: BrewvaPromptSessionEvent): void {
    let transcriptChanged = false;
    try {
      if (event.type === "session_phase_change" && isSessionPhase(event.phase)) {
        this.#sessionPhase = event.phase;
      }
      transcriptChanged =
        this.#sessionPort.getProjectionMode() === "wireFold" &&
        isWireFoldTranscriptCandidateEvent(event)
          ? this.#transcriptProjector.refreshFromWireFold()
          : this.#transcriptProjector.handleSessionEvent(event);
      this.notifySteerOutcome(event);
    } catch (error) {
      transcriptChanged = true;
      const message =
        error instanceof Error ? error.message : "Failed to render the latest session event.";
      this.ui.notify(message, "error");
      appendSessionProjectionError({
        appendMessage: (renderedMessage) =>
          this.#transcriptProjector.appendMessage(renderedMessage),
        eventType: event.type,
        message,
      });
    } finally {
      if (isHighFrequencySessionProgressEvent(event)) {
        if (transcriptChanged) {
          this.requestStreamingRender();
        }
        if (isHighFrequencyCockpitProgressEvent(event)) {
          this.#cockpitSync.requestProgressSync();
        }
      } else {
        this.#cockpitSync.requestSync();
      }
    }
  }

  private initializeState(): void {
    const sessionId = this.#sessionPort.getSessionId();
    this.#sessionPhase = { kind: "idle" };
    this.#transcriptProjector.resetAssistantDraft();
    this.#operatorSnapshotSync.resetSeen();
    const restoredDraft = this.#sessionHandler.getDraftsBySessionId().get(sessionId);
    this.#promptMemoryHandler.resetNavigation();
    this.#completionHandler.clearDismissedForCurrentSession();
    const shellViewPreferences = normalizeShellViewPreferences({
      ...this.#sessionPort.getShellViewPreferences(),
      showThinking: this.#tuiConfig.view.showThinking,
      toolDetails: this.#tuiConfig.view.toolDetails,
    });
    const diffPreferences = normalizeDiffPreferences({
      ...this.#sessionPort.getDiffPreferences(),
      ...this.#tuiConfig.view.diff,
    });
    const hydratedMessages = this.#transcriptProjector.composeSeedTranscript();
    const actions: ShellAction[] = [
      {
        type: "diff.setPreferences",
        preferences: diffPreferences,
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

  private formatAssistantStatusLabel(): string {
    const presetState = this.#sessionPort.getModelPresetState();
    const activeName = presetState.activeName.trim();
    if (!activeName) {
      return "Brewva";
    }
    const activePreset = presetState.presets.find(
      (preset) => preset.name === presetState.activeName,
    );
    return activePreset?.synthetic ? "Brewva" : activeName;
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
    const state = this.#sessionPort.getRewindState() ?? {
      rewindAvailable: false,
      redoAvailable: false,
    };
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
    this.clearQueuedSessionProgressEvents();
    this.commit([{ type: "domain.sessionGeneration.increment" }], {
      debounceStatus: false,
      emitChange: false,
      refreshCompletions: false,
    });
    this.#bundle = bundle;
    bundle.session.setUiPort(this.ui);
    this.#sessionPort = createSessionViewPort(bundle);
    this.#cockpitSync.reset();
    this.options.onBundleChange?.(bundle);
    this.#unsubscribeSession?.();
    this.#cockpitSync.requestSync();
    this.#unsubscribeSession = this.#sessionPort.subscribe((event) => {
      this.handleSessionPortEvent(event);
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
      handleDialogInput: async (input) => {
        const active = this.#state.overlay.active?.payload;
        if (active?.kind === "input") {
          await this.#overlayHandler.handleInputOverlayInput(active, input);
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
      openShortcutOverlay: () => this.#overlayHandler.openShortcutOverlay(),
      openInbox: () => this.#overlayHandler.openInboxOverlay(),
      openSessions: () => this.#overlayHandler.openSessionsOverlay(),
      openLineage: () => this.#overlayHandler.openLineageOverlay(),
      openTree: (query, lineageNodeId) =>
        this.#overlayHandler.openTreeOverlay(query, lineageNodeId),
      openQueue: () => this.#overlayHandler.openQueueOverlay(),
      openInspect: () => this.#overlayHandler.openInspectOverlay(),
      openNotifications: () => this.#overlayHandler.openNotificationsOverlay(),
      openContext: () => this.#overlayHandler.openContextOverlay(),
      openAuthority: () => this.#overlayHandler.openAuthorityOverlay(),
      openSkills: () => this.#overlayHandler.openSkillsOverlay(),
      openCockpitArchive: () => this.#overlayHandler.openCockpitArchiveOverlay(),
      openCockpitAttention: () => this.#overlayHandler.openCockpitAttentionOverlay(),
      openActivePagerExternally: () => this.openActivePagerExternally(),
      openExternalTranscriptPager: () => this.openExternalTranscriptPager(),
      copyLatestAssistantAnswer: () => this.copyLatestAssistantAnswer(),
      requestSurfaceNavigation: (kind) => this.requestSurfaceNavigation(kind),
      toggleSubagentFooter: () => this.toggleSubagentFooter(),
      closeSubagentFooter: () => this.closeSubagentFooter(),
      selectSubagentFooterRun: (runId) => this.selectSubagentFooterRun(runId),
      selectRelativeSubagentFooterRun: (delta) => this.selectRelativeSubagentFooterRun(delta),
      scrollSubagentFooter: (delta) => this.scrollSubagentFooter(delta),
      openSelectedSubagentSession: () => this.openSelectedSubagentSession(),
      cancelSelectedSubagent: () => this.cancelSelectedSubagent(),
      requestContextCompaction: () => this.requestContextCompaction(),
      projectSessionEvent: (projectEffect) => this.projectSessionEvent(projectEffect.event),
      abortSession: async (notification) => {
        await this.#sessionPort.abort();
        if (notification) {
          this.ui.notify(notification, "warning");
        }
      },
      createSession: async () => {
        await this.#sessionHandler.switchBundle(await this.#operatorPort.createSession());
      },
      openSessionDiffExternalPager: () => this.openSessionDiffExternalPager(),
      exportSessionBundle: () => this.exportSessionBundle(),
      exportInspectBundle: () => this.exportInspectBundle(),
      recordSessionHandoff: (handoff) => this.recordSessionHandoff(handoff),
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
        this.#cockpitSync.requestSync();
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
          const composerPolicy = resolveShellCockpitComposerSubmitPolicy({
            phase: this.#sessionPhase,
            projectionPolicy: this.#state.cockpit.projection?.composerPolicy,
          });
          const source = options?.source;
          const appliesToComposer =
            source === "interactive" || source === "slash" || source === "internal";
          if (appliesToComposer && !shellCockpitComposerPolicyAllowsSubmit(composerPolicy)) {
            this.ui.notify(
              describeShellCockpitComposerPolicyBlock(composerPolicy) ?? "Composer is unavailable.",
              "warning",
            );
            return;
          }
          await this.#sessionPort.prompt(parts, {
            ...options,
            ...(appliesToComposer && composerPolicy === "queue"
              ? { streamingBehavior: "queue" as const }
              : {}),
          });
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
      exportPatchEvidence: () => this.exportPatchEvidence(),
      previewProjectGuidanceInit: () => this.previewProjectGuidanceInit(),
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
    this.#statusTimer = startBoundaryTimeout({
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
    const changed = await this.#operatorSnapshotSync.refresh(sessionGeneration);
    if (changed) {
      this.#cockpitSync.requestSync();
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
    const slashMatch = this.#commandProvider.lookupSlashName(slashCommand.name);
    if (!slashMatch) {
      return false;
    }
    if (slashMatch.kind === "reserved") {
      const reservedName = slashCommand.name.toLowerCase();
      this.commit(
        {
          type: "notification.add",
          notification: {
            id: `reserved-slash:${Date.now()}:${reservedName}`,
            level: "warning",
            message:
              slashMatch.reservation.message ??
              `/${slashCommand.name} is reserved for ${slashMatch.reservation.owner} and is unavailable in the interactive shell.`,
            createdAt: Date.now(),
          },
        },
        { refreshCompletions: false },
      );
      const redirectCommandId = slashMatch.reservation.redirectCommandId;
      if (redirectCommandId) {
        await this.handleShellIntent({
          type: "command.invoke",
          commandId: redirectCommandId,
          args: "",
          source: "internal",
        });
      }
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

  private getSurfacePageStep(): number {
    return Math.max(3, Math.floor(Math.max(8, this.#viewportRows - 10) / 2));
  }

  private requestSurfaceNavigation(kind: "pageUp" | "pageDown" | "top" | "bottom"): void {
    this.commit(
      {
        type: "surface.requestNavigation",
        request: {
          id: ++this.#surfaceNavigationRequestId,
          kind,
        },
      },
      { debounceStatus: false },
    );
  }

  private getSelectedSubagentRun() {
    const selectedRunId =
      this.#state.subagentFooter.selectedRunId ?? this.#state.operator.taskRuns[0]?.runId;
    return selectedRunId
      ? this.#state.operator.taskRuns.find((run) => run.runId === selectedRunId)
      : undefined;
  }

  private openSubagentFooter(runId?: string): void {
    // Command handlers keep modal focus ownership user-visible; the reducer also enforces it
    // for direct state transitions.
    if (this.#state.overlay.active) {
      return;
    }
    this.commit(
      {
        type: "subagentFooter.open",
        runId,
      },
      { debounceStatus: false, refreshCompletions: false },
    );
  }

  private toggleSubagentFooter(): void {
    if (this.#state.operator.taskRuns.length === 0) {
      this.ui.notify("No background subagents are available.", "info");
      return;
    }
    // Keep global toggles from changing focus while a modal overlay owns input.
    if (this.#state.overlay.active) {
      return;
    }
    this.commit(
      {
        type: "subagentFooter.toggle",
      },
      { debounceStatus: false, refreshCompletions: false },
    );
  }

  private closeSubagentFooter(): void {
    this.commit(
      {
        type: "subagentFooter.close",
      },
      { debounceStatus: false, refreshCompletions: false },
    );
  }

  private selectSubagentFooterRun(runId: string): void {
    this.commit(
      {
        type: "subagentFooter.select",
        runId,
      },
      { debounceStatus: false, refreshCompletions: false },
    );
  }

  private selectRelativeSubagentFooterRun(delta: -1 | 1): void {
    this.commit(
      {
        type: "subagentFooter.selectRelative",
        delta,
      },
      { debounceStatus: false, refreshCompletions: false },
    );
  }

  private scrollSubagentFooter(delta: number): void {
    this.commit(
      {
        type: "subagentFooter.scroll",
        delta,
      },
      { debounceStatus: false, refreshCompletions: false },
    );
  }

  private async openSelectedSubagentSession(): Promise<void> {
    const run = this.getSelectedSubagentRun();
    if (!run?.workerSessionId) {
      this.ui.notify("The selected subagent has no worker session.", "warning");
      return;
    }
    await this.openSessionById(run.workerSessionId);
  }

  private async cancelSelectedSubagent(): Promise<void> {
    const run = this.getSelectedSubagentRun();
    if (!run) {
      this.ui.notify("No background subagent is selected.", "warning");
      return;
    }
    await this.#operatorPort.stopTask(run.runId);
    this.ui.notify(`Stopped task ${run.runId}.`, "warning");
    await this.refreshOperatorSnapshotEffect();
  }

  private requestContextCompaction(): void {
    const sessionId = this.#sessionPort.getSessionId();
    const usage = getCliRuntimeContextUsage(this.#bundle.runtime, sessionId);
    const gateStatus = getCliRuntimeCompactionGateStatus(this.#bundle.runtime, sessionId, usage);
    const previousPendingReason = getCliRuntimePendingCompactionReason(
      this.#bundle.runtime,
      sessionId,
    );
    this.#bundle.runtime.ops.context.compaction.request(sessionId, "manual");
    if (gateStatus.required) {
      this.ui.notify(
        `Context compaction requested; gate is already required (${gateStatus.reason ?? "unknown"}).`,
        "warning",
      );
      return;
    }
    if (previousPendingReason) {
      this.ui.notify(
        `Context compaction requested; existing pending reason was ${previousPendingReason}.`,
        "warning",
      );
      return;
    }
    this.ui.notify("Context compaction requested.", "info");
  }

  private async copyLatestAssistantAnswer(): Promise<void> {
    for (let index = this.#state.transcript.messages.length - 1; index >= 0; index -= 1) {
      const message = this.#state.transcript.messages[index];
      if (message?.role !== "assistant") {
        continue;
      }
      const text = message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n\n")
        .trim();
      if (!text) {
        continue;
      }
      await this.runShellEffects([{ type: "clipboard.copy", text }]);
      this.ui.notify("Copied latest assistant answer.", "info");
      return;
    }
    this.ui.notify("No assistant answer is available to copy.", "warning");
  }

  private async readGitOutput(args: readonly string[]): Promise<GitCommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync("git", [...args], {
        cwd: this.options.cwd,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      });
      return {
        ok: true,
        stdout: trimProcessOutput(stdout),
        stderr: trimProcessOutput(stderr),
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        stdout: trimProcessOutput(
          error instanceof Error && "stdout" in error ? error.stdout : undefined,
        ),
        stderr: trimProcessOutput(
          error instanceof Error && "stderr" in error ? error.stderr : undefined,
        ),
      };
    }
  }

  private resolvePatchHistoryPath(): string {
    return resolveSessionPatchHistoryPath({
      workspaceRoot: this.#bundle.runtime.identity.workspaceRoot,
      sessionId: this.#sessionPort.getSessionId(),
    });
  }

  private listSessionPatchSets(): PersistedPatchSet[] {
    return listPersistedPatchSets({
      path: this.resolvePatchHistoryPath(),
      sessionId: this.#sessionPort.getSessionId(),
    });
  }

  private appendGitCommandSection(input: {
    lines: string[];
    title: string;
    result: GitCommandResult;
    emptyMessage: string;
  }): void {
    input.lines.push("", `## ${input.title}`);
    if (input.result.ok) {
      input.lines.push(...formatBoundedGitOutput(input.result.stdout, input.emptyMessage));
      if (input.result.stderr) {
        input.lines.push("", "stderr:", ...formatBoundedGitOutput(input.result.stderr, ""));
      }
      return;
    }
    input.lines.push(`Unavailable: ${input.result.message}`);
    if (input.result.stderr) {
      input.lines.push("", "stderr:", ...formatBoundedGitOutput(input.result.stderr, ""));
    }
    if (input.result.stdout) {
      input.lines.push("", "stdout:", ...formatBoundedGitOutput(input.result.stdout, ""));
    }
  }

  private appendPatchAttributionSection(lines: string[]): void {
    const sessionId = this.#sessionPort.getSessionId();
    const projection = getCliRuntimeTurnProjection(this.#bundle.runtime, sessionId);
    const patchSets = this.listSessionPatchSets().slice(-8).toReversed();
    lines.push(
      "",
      "## Brewva turn attribution",
      `runtimeTurn=${projection.runtimeTurn} declared=${projection.declared.length} attempted=${projection.attempted.length} decisions=${projection.decisions.length} executed=${projection.executed.length} recovery=${projection.recovery.length} warnings=${projection.warnings.length}`,
    );
    const digest = renderCliRuntimeTurnDigest(this.#bundle.runtime, sessionId, {
      maxChars: 1_800,
    });
    lines.push("", digest);
    lines.push("", "## Brewva patch sets");
    if (patchSets.length === 0) {
      lines.push(`No patch sets recorded at ${this.resolvePatchHistoryPath()}.`);
      return;
    }
    for (const patchSet of patchSets) {
      const paths = patchSet.changes.map((change: { readonly path?: string }) => change.path);
      lines.push(
        [
          `- patchSet=${patchSet.id}`,
          `status=${patchSet.status}`,
          `tool=${patchSet.toolName}`,
          `changes=${patchSet.changes.length}`,
          `appliedAt=${patchSet.appliedAt != null ? new Date(patchSet.appliedAt).toISOString() : "n/a"}`,
          patchSet.summary ? `summary=${patchSet.summary}` : undefined,
          `paths=${paths.slice(0, 5).join(",") || "none"}${paths.length > 5 ? `,+${paths.length - 5}` : ""}`,
        ]
          .filter((part): part is string => part !== undefined)
          .join(" "),
      );
    }
  }

  private async buildDiffEvidenceLines(): Promise<string[]> {
    const [status, diffStat, diff] = await Promise.all([
      this.readGitOutput(["status", "--short"]),
      this.readGitOutput(["diff", "--stat", "--", "."]),
      this.readGitOutput(["diff", "--", "."]),
    ]);
    const lines = [
      `Session: ${this.#sessionPort.getSessionId()}`,
      `Working directory: ${this.options.cwd}`,
    ];
    this.appendGitCommandSection({
      lines,
      title: "Git status",
      result: status,
      emptyMessage: "No tracked or untracked changes.",
    });
    this.appendGitCommandSection({
      lines,
      title: "Git diff stat",
      result: diffStat,
      emptyMessage: "No tracked diff stat.",
    });
    this.appendGitCommandSection({
      lines,
      title: "Git diff",
      result: diff,
      emptyMessage: "No tracked diff.",
    });
    this.appendPatchAttributionSection(lines);
    return lines;
  }

  private async buildPatchEvidenceLines(): Promise<string[]> {
    const diffStat = await this.readGitOutput(["diff", "--stat", "--", "."]);
    const lines = [
      `Session: ${this.#sessionPort.getSessionId()}`,
      `Working directory: ${this.options.cwd}`,
    ];
    this.appendPatchAttributionSection(lines);
    this.appendGitCommandSection({
      lines,
      title: "Git diff stat",
      result: diffStat,
      emptyMessage: "No tracked diff stat.",
    });
    return lines;
  }

  private async openSessionDiffExternalPager(): Promise<void> {
    await this.openExternalPagerTarget({
      title: "Brewva diff",
      lines: await this.buildDiffEvidenceLines(),
    });
  }

  private async exportPatchEvidence(): Promise<void> {
    await this.openExternalPagerTarget({
      title: "Brewva patch evidence",
      lines: await this.buildPatchEvidenceLines(),
    });
  }

  private buildInspectTextLines(): string[] {
    const report = buildSessionInspectReport({
      runtime: this.#bundle.runtime,
      sessionId: this.#sessionPort.getSessionId(),
      directory: resolveInspectDirectory(this.#bundle.runtime, undefined, undefined),
    });
    return formatInspectText(report.base).split("\n");
  }

  private buildTranscriptMarkdownLines(): string[] {
    return [
      ...this.buildLatestHandoffLines(),
      ...renderTranscriptAsMarkdown(this.#state.transcript.messages),
    ];
  }

  private buildLatestHandoffLines(): string[] {
    const status = getCliRuntimeTapeStatus(this.#bundle.runtime, this.#sessionPort.getSessionId());
    const anchor = status.lastAnchor;
    if (!anchor) {
      return [];
    }
    return [
      "# Latest Handoff",
      "",
      `Anchor: ${anchor.id}`,
      `Name: ${anchor.name ?? "n/a"}`,
      `Summary: ${anchor.summary ?? "n/a"}`,
      `Next steps: ${anchor.nextSteps ?? "n/a"}`,
      "",
    ];
  }

  private async exportSessionBundle(): Promise<void> {
    const sessionId = this.#sessionPort.getSessionId();
    const lines = [
      "# Brewva Session Handoff Bundle",
      "",
      `Session: ${sessionId}`,
      `Workspace: ${this.#bundle.runtime.identity.workspaceRoot}`,
      `Working directory: ${this.options.cwd}`,
      "",
      "## Inspect Report",
      ...this.buildInspectTextLines(),
      "",
      "## Latest Handoff",
      ...(this.buildLatestHandoffLines().length > 0
        ? this.buildLatestHandoffLines().slice(2)
        : ["None"]),
      "",
      "## Transcript Markdown",
      ...this.buildTranscriptMarkdownLines(),
      "",
      "## Patch Evidence",
      ...(await this.buildPatchEvidenceLines()),
    ];
    await this.openExternalPagerTarget({
      title: "Brewva session export",
      lines,
    });
  }

  private async recordSessionHandoff(handoff?: SessionHandoffDraft): Promise<void> {
    const sessionId = this.#sessionPort.getSessionId();
    const name = handoff?.name?.trim() || "Interactive handoff";
    const summary = handoff?.summary?.trim();
    const nextSteps = handoff?.nextSteps?.trim() || "Continue from the latest work card.";
    const result = recordCliRuntimeTapeHandoff(this.#bundle.runtime, sessionId, {
      name,
      ...(summary ? { summary } : {}),
      nextSteps,
    });
    if (!result.ok) {
      this.ui.notify(`Handoff was not recorded: ${result.reason ?? "unknown error"}.`, "error");
      return;
    }
    this.ui.notify(`Handoff recorded: ${result.eventId ?? "anchor recorded"}.`, "info");
  }

  private async exportInspectBundle(): Promise<void> {
    await this.openExternalPagerTarget({
      title: "Brewva inspect bundle",
      lines: this.buildInspectTextLines(),
    });
  }

  private async readWorkspaceText(relativePath: string): Promise<string | null> {
    try {
      return await readFile(
        resolvePath(this.#bundle.runtime.identity.workspaceRoot, relativePath),
        "utf8",
      );
    } catch {
      return null;
    }
  }

  private extractMarkdownHeadings(text: string | null, limit: number): string[] {
    if (!text) {
      return [];
    }
    return text
      .split(/\r?\n/u)
      .map((line) => line.match(/^#{2,3}\s+(.+)$/u)?.[1]?.trim())
      .filter((heading): heading is string => Boolean(heading))
      .slice(0, limit);
  }

  private extractPackageScripts(packageJson: string | null): Record<string, string> {
    if (!packageJson) {
      return {};
    }
    const parsed = safeParseJson(packageJson);
    if (!isJsonObject(parsed) || !isJsonObject(parsed.scripts)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed.scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  private buildVerificationCommandLines(scripts: Record<string, string>): string[] {
    const preferred = [
      "check",
      "test",
      "test:docs",
      "format:docs:check",
      "test:dist",
      "build:binaries",
    ];
    const selected = preferred.filter((script) => scripts[script]);
    if (selected.length === 0) {
      return ["- no verification scripts found in package.json"];
    }
    return selected.map((script) => `- bun run ${script} :: ${scripts[script]}`);
  }

  private async listScriptDirectoryEntries(): Promise<string[]> {
    try {
      const entries = await readdir(
        resolvePath(this.#bundle.runtime.identity.workspaceRoot, "script"),
        {
          withFileTypes: true,
        },
      );
      return entries
        .filter((entry) => entry.isFile() || entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted()
        .slice(0, 12);
    } catch {
      return [];
    }
  }

  private async previewProjectGuidanceInit(): Promise<void> {
    const [
      packageJson,
      agentsGuide,
      workflowGates,
      packageBoundaries,
      criticalRules,
      scriptEntries,
    ] = await Promise.all([
      this.readWorkspaceText("package.json"),
      this.readWorkspaceText("AGENTS.md"),
      this.readWorkspaceText("skills/project/shared/workflow-gates.md"),
      this.readWorkspaceText("skills/project/shared/package-boundaries.md"),
      this.readWorkspaceText("skills/project/shared/critical-rules.md"),
      this.listScriptDirectoryEntries(),
    ]);
    const scripts = this.extractPackageScripts(packageJson);
    const workflowHeadings = this.extractMarkdownHeadings(workflowGates, 8);
    const packageBoundaryHeadings = this.extractMarkdownHeadings(packageBoundaries, 6);
    const criticalRuleHeadings = this.extractMarkdownHeadings(criticalRules, 6);
    const agentHeadings = this.extractMarkdownHeadings(agentsGuide, 8);
    this.#overlayHandler.openPagerOverlay({
      title: "Brewva project guidance preview",
      lines: [
        "# Brewva Project Guidance Preview",
        "",
        "This preview is read-only and assembled from the current workspace. It does not write AGENTS.md or .brewva metadata.",
        "",
        `Workspace: ${this.#bundle.runtime.identity.workspaceRoot}`,
        `AGENTS.md: ${agentsGuide ? "present" : "missing"}`,
        "",
        "## Verification commands",
        ...this.buildVerificationCommandLines(scripts),
        "",
        "## Workflow gates",
        ...(workflowHeadings.length > 0
          ? workflowHeadings.map((heading) => `- ${heading}`)
          : ["- no workflow gate headings found"]),
        "",
        "## Package-boundary notes",
        ...(packageBoundaryHeadings.length > 0
          ? packageBoundaryHeadings.map((heading) => `- ${heading}`)
          : ["- no package-boundary guidance found"]),
        "",
        "## Critical rules",
        ...(criticalRuleHeadings.length > 0
          ? criticalRuleHeadings.map((heading) => `- ${heading}`)
          : ["- no critical-rule guidance found"]),
        "",
        "## Existing agent guide headings",
        ...(agentHeadings.length > 0
          ? agentHeadings.map((heading) => `- ${heading}`)
          : ["- no existing guide headings found"]),
        "",
        "## Script inventory",
        ...(scriptEntries.length > 0
          ? scriptEntries.map((entry) => `- script/${entry}`)
          : ["- no script/ entries found"]),
      ],
    });
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
    const externalPagerTarget = this.getExternalPagerTarget();
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
