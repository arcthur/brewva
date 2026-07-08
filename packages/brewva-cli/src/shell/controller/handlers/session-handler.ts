import { recordSessionShutdownIfMissing } from "@brewva/brewva-gateway";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type { SessionPhase } from "@brewva/brewva-substrate/session";
import type {
  SessionRewindMode,
  SessionRewindSummary,
  SessionRewindTargetView,
} from "@brewva/brewva-vocabulary/session";
import type { ShellCommitInput, ShellCommitOptions } from "../../domain/actions.js";
import {
  describeShellCockpitComposerPolicyBlock,
  resolveShellCockpitComposerSubmitPolicy,
  shellCockpitComposerPolicyAllowsSubmit,
} from "../../domain/cockpit/index.js";
import type { ShellEffect } from "../../domain/effects.js";
import type { ModelAvailabilityMemory } from "../../domain/model-availability-memory.js";
import {
  buildCliShellPromptContentParts,
  cloneCliShellPromptParts,
  expandPromptTextParts,
} from "../../domain/prompt-parts.js";
import type { CliShellPromptPart, CliShellPromptSnapshot } from "../../domain/prompt.js";
import {
  describeProviderFailure,
  isProviderAccessFailure,
  isProviderAccessFailureAttempt,
  readProviderFailureAttempts,
} from "../../domain/provider-failure-guidance.js";
import type { CliShellAction, CliShellViewState } from "../../domain/state.js";
import { buildTextTranscriptMessage } from "../../domain/transcript.js";
import type { CliShellSessionBundle, SessionViewPort } from "../../ports/session-port.js";
import type { CliShellUiPort } from "../../ports/ui-port.js";

interface PromptMemoryDelegate {
  appendHistory(entry: CliShellPromptSnapshot): void;
}

interface TranscriptProjectorDelegate {
  clearRewindMarker(sessionId: string): void;
  appendMessage(
    message: ReturnType<typeof buildTextTranscriptMessage>,
    options?: ShellCommitOptions,
  ): void;
  setRewindMarker(text: string): void;
  refreshFromSession(): void;
}

interface ModelSelectionDelegate {
  openModelsDialog(input?: { query?: string; providerFilter?: string }): Promise<void>;
}

interface ProviderAuthDelegate {
  openConnectDialog(query?: string): Promise<void>;
}

interface ParsedRewindCommand {
  checkpointOrdinal?: number;
  mode?: SessionRewindMode;
  summary?: SessionRewindSummary;
}

function parseLeadingSlashCommand(prompt: string): { name?: string } | undefined {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith("/")) {
    return undefined;
  }
  const match = /^\/(?<name>[^\s]*)/u.exec(trimmed);
  const name = match?.groups?.name;
  return name ? { name } : {};
}

// Availability badges render inline in the model picker; keep the provider's
// rejection text but cap it so a verbose error body doesn't wreck the layout.
const AVAILABILITY_REASON_MAX_CHARS = 120;

function truncateAvailabilityReason(message: string): string {
  const flattened = message.split("\n", 1)[0] ?? message;
  return flattened.length > AVAILABILITY_REASON_MAX_CHARS
    ? `${flattened.slice(0, AVAILABILITY_REASON_MAX_CHARS - 1)}…`
    : flattened;
}

// Rewind success copy must say which workspace lane ran: a world restore can
// rewrite files while zero patch sets exist, and "reverted 0 patch set(s)"
// would read as "workspace untouched" over a tree that just changed.
function describeWorkspaceRewind(result: {
  readonly patchSetIds: readonly string[];
  readonly worldRestore?: {
    readonly wroteFileCount: number;
    readonly deletedFileCount: number;
  };
}): string {
  if (result.worldRestore) {
    const { wroteFileCount, deletedFileCount } = result.worldRestore;
    return `restored the workspace to the checkpoint world (${wroteFileCount} file(s) written, ${deletedFileCount} deleted; ${result.patchSetIds.length} patch set(s) superseded)`;
  }
  return `reverted ${result.patchSetIds.length} patch set(s)`;
}

export interface ShellSessionHandlerContext {
  cwd: string;
  getState(): CliShellViewState;
  getBundle(): CliShellSessionBundle;
  getSessionPort(): SessionViewPort;
  getSessionPhase(): SessionPhase;
  getSessionGeneration(): number;
  getUi(): CliShellUiPort;
  getModelAvailabilityMemory(): ModelAvailabilityMemory;
  promptMemory: PromptMemoryDelegate;
  transcriptProjector: TranscriptProjectorDelegate;
  modelSelection: ModelSelectionDelegate;
  providerAuth: ProviderAuthDelegate;
  commit(input: ShellCommitInput, options?: ShellCommitOptions): void;
  runShellEffects(
    effects: readonly ShellEffect[],
    options?: { errorMode?: "notify" | "throw" },
  ): Promise<void>;
  handleShellCommand(prompt: string): Promise<boolean>;
  getShortcutLabel(id: string): string | undefined;
  buildSessionStatusActions(): CliShellAction[];
  dismissPendingInteractiveQuestionRequests(input?: { sessionId?: string }): void;
  mountSession(bundle: CliShellSessionBundle): void;
  initializeState(): void;
  refreshOperatorSnapshot(): Promise<void>;
  notifyInteractiveUserPromptCommitted: () => void;
}

export interface ShellComposerSubmitOptions {
  readonly waitForPromptEffect?: boolean;
}

export class ShellSessionHandler {
  readonly #draftsBySessionId = new Map<
    string,
    {
      text: string;
      cursor: number;
      parts: CliShellPromptPart[];
      updatedAt: number;
    }
  >();
  #interactiveTurnSequence = 0;
  #preserveComposerAfterShellCommand = false;
  #submittingComposer = false;
  #pendingOptimisticSubmitKey: string | undefined;

  constructor(private readonly context: ShellSessionHandlerContext) {}

  #listRewindChoices(): SessionRewindTargetView[] {
    return this.context
      .getSessionPort()
      .listRewindTargets()
      .filter((target) => target.lineage.kind === "active")
      .toSorted((left, right) => right.timestamp - left.timestamp);
  }

  #formatRewindChoice(target: SessionRewindTargetView, index: number): string {
    const preview = target.promptPreview.trim() || "(prompt unavailable)";
    const fileSummary = `${target.fileSummary.added}+ ${target.fileSummary.modified}~ ${target.fileSummary.deleted}-`;
    return `${index + 1}. Turn ${target.turn} — ${preview} · ${target.patchSetCountAfter} patch set(s) · ${fileSummary}`;
  }

  #parseRewindCommand(argument: string | undefined): ParsedRewindCommand | undefined {
    const tokens =
      argument
        ?.trim()
        .split(/\s+/)
        .filter((token) => token.length > 0) ?? [];
    let checkpointOrdinal: number | undefined;
    let mode: SessionRewindMode | undefined;
    let summary: SessionRewindSummary | undefined;
    for (const token of tokens) {
      if (token === "conversation" || token === "code" || token === "both") {
        mode = token;
        continue;
      }
      if (token === "carry" || token === "--carry") {
        summary = "carry";
        continue;
      }
      if (/^-\d+$/.test(token)) {
        const parsed = Number.parseInt(token.slice(1), 10);
        if (!Number.isInteger(parsed) || parsed < 1) {
          return undefined;
        }
        checkpointOrdinal = parsed;
        continue;
      }
      return undefined;
    }
    return {
      ...(checkpointOrdinal !== undefined ? { checkpointOrdinal } : {}),
      ...(mode ? { mode } : {}),
      ...(summary ? { summary } : {}),
    };
  }

  getDraftsBySessionId(): ReadonlyMap<
    string,
    {
      text: string;
      cursor: number;
      parts: CliShellPromptPart[];
      updatedAt: number;
    }
  > {
    return this.#draftsBySessionId;
  }

  async submitComposer(options: ShellComposerSubmitOptions = {}): Promise<void> {
    if (this.#submittingComposer) {
      return;
    }
    this.#submittingComposer = true;
    try {
      await this.submitComposerNow(options);
    } finally {
      this.#submittingComposer = false;
    }
  }

  private async submitComposerNow(options: ShellComposerSubmitOptions): Promise<void> {
    const promptText = this.context.getState().composer.text;
    const promptParts = cloneCliShellPromptParts(this.context.getState().composer.parts);
    const prompt = promptText.trim();
    if (!prompt) {
      return;
    }
    const composerPolicy = resolveShellCockpitComposerSubmitPolicy({
      phase: this.context.getSessionPhase(),
      projectionPolicy: this.context.getState().cockpit?.projection?.composerPolicy,
    });
    if (!shellCockpitComposerPolicyAllowsSubmit(composerPolicy)) {
      this.context
        .getUi()
        .notify(
          describeShellCockpitComposerPolicyBlock(composerPolicy) ?? "Composer is unavailable.",
          "warning",
        );
      return;
    }
    const slashCommand = parseLeadingSlashCommand(prompt);
    if (slashCommand) {
      this.#preserveComposerAfterShellCommand = false;
      const handled = await this.context.handleShellCommand(prompt);
      if (handled) {
        if (!this.#preserveComposerAfterShellCommand) {
          this.context.commit({
            type: "composer.setText",
            text: "",
            cursor: 0,
          });
        }
        this.#preserveComposerAfterShellCommand = false;
        return;
      }
      const commandLabel = slashCommand.name ? `: /${slashCommand.name}` : "";
      const commandPaletteShortcut = this.context.getShortcutLabel("app.commandPalette");
      const commandPaletteHint = commandPaletteShortcut
        ? ` or press ${commandPaletteShortcut} for commands`
        : "";
      this.context
        .getUi()
        .notify(
          `Unknown slash command${commandLabel}. Type /help${commandPaletteHint}.`,
          "warning",
        );
      return;
    }

    if (!this.context.getBundle().session.model) {
      const availableModels = await this.context.getSessionPort().listModels();
      if (availableModels.length === 0) {
        this.context
          .getUi()
          .notify("No connected model provider. Use /model to connect one.", "warning");
        await this.context.providerAuth.openConnectDialog();
        return;
      }
      this.context.getUi().notify("No model selected. Use /model to choose one.", "warning");
      await this.context.modelSelection.openModelsDialog();
      return;
    }
    const availableModels = this.context.getBundle().session.modelRegistry?.getAvailable?.();
    if (Array.isArray(availableModels) && availableModels.length === 0) {
      this.context
        .getUi()
        .notify("No connected model provider. Use /model to connect one.", "warning");
      await this.context.providerAuth.openConnectDialog();
      return;
    }

    const optimisticSubmitKey =
      options.waitForPromptEffect === false
        ? JSON.stringify({ text: promptText, parts: promptParts })
        : undefined;
    if (
      optimisticSubmitKey !== undefined &&
      this.#pendingOptimisticSubmitKey === optimisticSubmitKey
    ) {
      this.context.commit(
        {
          type: "composer.setText",
          text: "",
          cursor: 0,
        },
        {
          debounceStatus: false,
          refreshCompletions: false,
        },
      );
      return;
    }
    if (optimisticSubmitKey !== undefined) {
      this.#pendingOptimisticSubmitKey = optimisticSubmitKey;
    }
    const clearPendingOptimisticSubmit = (): void => {
      if (
        optimisticSubmitKey !== undefined &&
        this.#pendingOptimisticSubmitKey === optimisticSubmitKey
      ) {
        this.#pendingOptimisticSubmitKey = undefined;
      }
    };

    this.context.promptMemory.appendHistory({
      text: promptText,
      parts: promptParts,
    });

    const submittedAt = Date.now();
    const turnId = `interactive:${submittedAt}:${++this.#interactiveTurnSequence}`;
    // Capture the model that runs THIS turn so a mid-turn `/model` switch cannot
    // misattribute the failure (or success) to the wrong model in availability memory.
    const submittedModel = this.context.getBundle().session.model;
    type RewindPromptParts = NonNullable<
      Parameters<SessionViewPort["recordRewindCheckpoint"]>[0]["prompt"]
    >["parts"];
    const recordCheckpoint = async (): Promise<void> => {
      await this.context.getSessionPort().recordRewindCheckpoint({
        turnId,
        prompt: {
          text: promptText,
          parts: structuredClone(promptParts) as unknown as RewindPromptParts,
        },
      });
    };
    const runPromptEffect = async (): Promise<void> => {
      try {
        await recordCheckpoint();
        await this.context.runShellEffects(
          [
            {
              type: "session.prompt",
              sessionGeneration: this.context.getSessionGeneration(),
              parts: buildCliShellPromptContentParts(
                this.context.cwd,
                promptText,
                promptParts,
              ) as readonly BrewvaPromptContentPart[],
              options: {
                source: "interactive",
                ...(composerPolicy === "queue" ? { streamingBehavior: "queue" as const } : {}),
              },
            },
          ],
          // Surface a failed turn to onPromptFailure instead of the effect
          // runner's default notify-and-swallow. Otherwise the failure resolves,
          // onPromptSuccess runs, and the just-failed model is wrongly CLEARED in
          // availability memory (and a permanent access failure is never marked).
          { errorMode: "throw" },
        );
      } finally {
        clearPendingOptimisticSubmit();
      }
    };

    this.context.transcriptProjector.clearRewindMarker(
      this.context.getSessionPort().getSessionId(),
    );
    this.context.commit(this.context.buildSessionStatusActions(), {
      debounceStatus: false,
      emitChange: false,
      refreshCompletions: false,
    });
    this.context.transcriptProjector.appendMessage(
      buildTextTranscriptMessage({
        id: `user:${submittedAt}`,
        role: "user",
        text: expandPromptTextParts(promptText, promptParts).trim(),
      }),
      {
        debounceStatus: false,
        emitChange: false,
        refreshCompletions: false,
      },
    );
    this.context.commit(
      {
        type: "composer.setText",
        text: "",
        cursor: 0,
      },
      {
        debounceStatus: false,
        refreshCompletions: false,
      },
    );

    const memory = this.context.getModelAvailabilityMemory();
    const onPromptSuccess = (): void => {
      // The model just produced a successful turn — it is usable again.
      if (submittedModel) {
        memory.clear(submittedModel.provider, submittedModel.id);
      }
      this.context.notifyInteractiveUserPromptCommitted();
    };
    const onPromptFailure = (error: unknown): void => {
      if (submittedModel && isProviderAccessFailure(error)) {
        memory.markUnavailable(
          submittedModel.provider,
          submittedModel.id,
          "not available with your current credentials",
        );
      }
      // A fallback-exhausted failure carries the whole per-route trail. Every
      // model the chain burned through on an access rejection gets its badge —
      // otherwise only the surfaced model is remembered and the picker keeps
      // offering routes the account already refused.
      for (const attempt of readProviderFailureAttempts(error)) {
        if (isProviderAccessFailureAttempt(attempt)) {
          memory.markUnavailable(
            attempt.provider,
            attempt.model,
            truncateAvailabilityReason(attempt.message),
          );
        }
      }
      this.context.getUi().notify(describeProviderFailure(error), "error");
    };

    if (options.waitForPromptEffect === false) {
      setTimeout(() => {
        void runPromptEffect().then(onPromptSuccess).catch(onPromptFailure);
      }, 0);
      return;
    }

    // Awaited path (e.g. `brewva "<prompt>"`): same outcome handling as the
    // fire-and-forget path so a failure surfaces with guidance and availability is
    // recorded consistently. The failure is surfaced here, so it is not re-thrown.
    try {
      await runPromptEffect();
      onPromptSuccess();
    } catch (error) {
      onPromptFailure(error);
    }
  }

  async undoLastTurn(): Promise<void> {
    if (this.context.getBundle().session.isStreaming) {
      await this.context.getSessionPort().abort();
      await this.context.getSessionPort().waitForIdle();
    }
    const result = await this.context.getSessionPort().rewindSession();
    if (!result.ok) {
      // One recovery owner: /undo IS the session rewind transaction (conversation
      // plus workspace through one engine). There is no separate workspace-only
      // plane to compose, so report why the transaction could not run — and a
      // mid-flight world-restore failure means the workspace is visibly
      // partial, which must never read as "nothing happened".
      const detail = result.error ? ` (${result.error})` : "";
      const partial =
        result.error === "restore_io_error"
          ? " The workspace may be partially restored; re-run the rewind."
          : "";
      this.context
        .getUi()
        .notify(`Undo unavailable: ${result.reason}${detail}.${partial}`, "warning");
      return;
    }
    this.context.transcriptProjector.setRewindMarker(
      `Session undo applied: ${describeWorkspaceRewind(result)} and restored the submitted prompt. Use /redo to restore the undone turn.`,
    );
    this.context.transcriptProjector.refreshFromSession();
    if (result.restoredPrompt) {
      this.context.commit(
        {
          type: "composer.setPromptState",
          text: result.restoredPrompt.text,
          cursor: result.restoredPrompt.text.length,
          parts: cloneCliShellPromptParts(
            result.restoredPrompt.parts as unknown as CliShellPromptPart[],
          ),
        },
        { debounceStatus: false },
      );
      this.#preserveComposerAfterShellCommand = true;
    }
    this.context
      .getUi()
      .notify(`Undo: ${describeWorkspaceRewind(result)}; prompt restored.`, "info");
    this.context.commit(this.context.buildSessionStatusActions(), { debounceStatus: false });
  }

  async rewindSession(argument?: string): Promise<void> {
    if (this.context.getBundle().session.isStreaming) {
      await this.context.getSessionPort().abort();
      await this.context.getSessionPort().waitForIdle();
    }

    const targets = this.#listRewindChoices();
    if (targets.length === 0) {
      this.context.getUi().notify("No rewind target is available on the active branch.", "warning");
      return;
    }

    const parsedCommand = this.#parseRewindCommand(argument);
    if (argument?.trim() && !parsedCommand) {
      this.context
        .getUi()
        .notify("Usage: /rewind [conversation|code|both] [carry] [-<index>]", "warning");
      return;
    }
    let target: SessionRewindTargetView | undefined;
    if (parsedCommand?.checkpointOrdinal !== undefined) {
      if (parsedCommand.checkpointOrdinal > targets.length) {
        this.context
          .getUi()
          .notify("Usage: /rewind [conversation|code|both] [carry] [-<index>]", "warning");
        return;
      }
      target = targets[parsedCommand.checkpointOrdinal - 1];
    } else {
      const options = targets.map((candidate, index) => this.#formatRewindChoice(candidate, index));
      const selected = await this.context.getUi().select("Rewind conversation", options);
      if (!selected) {
        return;
      }
      const selectedIndex = options.indexOf(selected);
      target = selectedIndex >= 0 ? targets[selectedIndex] : undefined;
    }

    if (!target) {
      this.context.getUi().notify("Unable to resolve the selected rewind target.", "warning");
      return;
    }

    const result = await this.context.getSessionPort().rewindSession({
      checkpointId: target.checkpointId,
      mode: parsedCommand?.mode ?? "both",
      summary: parsedCommand?.summary ?? "none",
    });
    if (!result.ok) {
      const detail = result.error ? ` (${result.error})` : "";
      const partial =
        result.error === "restore_io_error"
          ? " The workspace may be partially restored; re-run the rewind."
          : "";
      this.context
        .getUi()
        .notify(`Rewind unavailable: ${result.reason}${detail}.${partial}`, "warning");
      return;
    }

    this.context.transcriptProjector.setRewindMarker(
      `Session rewind applied: rewound to turn ${result.checkpoint.turn}; ${describeWorkspaceRewind(result)}. Use /redo to restore the abandoned branch tip.`,
    );
    this.context.transcriptProjector.refreshFromSession();
    if (result.restoredPrompt) {
      this.context.commit(
        {
          type: "composer.setPromptState",
          text: result.restoredPrompt.text,
          cursor: result.restoredPrompt.text.length,
          parts: cloneCliShellPromptParts(
            result.restoredPrompt.parts as unknown as CliShellPromptPart[],
          ),
        },
        { debounceStatus: false },
      );
      this.#preserveComposerAfterShellCommand = true;
    }
    this.context
      .getUi()
      .notify(
        `Rewound to turn ${result.checkpoint.turn}; ${describeWorkspaceRewind(result)}.`,
        "info",
      );
    this.context.commit(this.context.buildSessionStatusActions(), { debounceStatus: false });
  }

  async redoLastTurn(): Promise<void> {
    if (this.context.getBundle().session.isStreaming) {
      this.context.getUi().notify("Cannot redo while agent is running.", "warning");
      return;
    }
    const result = await this.context.getSessionPort().redoSession();
    if (!result.ok) {
      this.context.getUi().notify(`Redo unavailable (${result.reason}).`, "warning");
      return;
    }
    this.context.transcriptProjector.setRewindMarker(
      `Session redo applied: restored the undone turn and reapplied ${result.patchSetIds.length} patch set(s).`,
    );
    this.context.transcriptProjector.refreshFromSession();
    this.context.commit(
      {
        type: "composer.setText",
        text: "",
        cursor: 0,
      },
      { debounceStatus: false },
    );
    this.context.getUi().notify(`Redid ${result.patchSetIds.length} patch set(s).`, "info");
    this.context.commit(this.context.buildSessionStatusActions(), { debounceStatus: false });
  }

  async switchBundle(bundle: CliShellSessionBundle): Promise<void> {
    this.snapshotCurrentDraft();
    const outgoingSessionId = this.context.getSessionPort().getSessionId();
    this.context.dismissPendingInteractiveQuestionRequests({
      sessionId: outgoingSessionId,
    });
    // Only stamp a switch shutdown receipt when the outgoing session actually
    // persisted something. A new session the user navigated away from before the
    // first prompt defers persistence (deferPersistenceUntilPrompt) and has an
    // empty tape; writing a receipt there would be its only event — a tape with no
    // lineage root — which made the session impossible to reopen
    // (session_lineage_root_missing). This mirrors the managed session's own
    // sessionStartEmitted gate and the CLI exit-path persisted-activity guard.
    const outgoingHasPersistedEvents =
      this.context.getBundle().inspect.events.query(outgoingSessionId, { last: 1 }).length > 0;
    if (outgoingHasPersistedEvents) {
      try {
        recordSessionShutdownIfMissing(this.context.getBundle().runtime, {
          sessionId: outgoingSessionId,
          reason: "cli_shell_session_switch",
          source: "cli_shell_runtime",
        });
      } catch {
        // best effort terminal receipt for session switching
      }
    }
    this.context.getBundle().session.dispose();
    this.context.mountSession(bundle);
    this.context.initializeState();
    this.context
      .getUi()
      .notify(
        `Session started: ${this.context.getSessionPort().getSessionId()} (${this.context.getSessionPort().getModelLabel()})`,
        "info",
      );
    await this.context.refreshOperatorSnapshot();
  }

  private snapshotCurrentDraft(): void {
    const sessionId = this.context.getSessionPort().getSessionId();
    const text = this.context.getState().composer.text;
    if (text.trim().length === 0) {
      this.#draftsBySessionId.delete(sessionId);
      return;
    }
    this.#draftsBySessionId.set(sessionId, {
      text,
      cursor: this.context.getState().composer.cursor,
      parts: cloneCliShellPromptParts(this.context.getState().composer.parts),
      updatedAt: Date.now(),
    });
  }
}
