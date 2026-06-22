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
import {
  buildCliShellPromptContentParts,
  cloneCliShellPromptParts,
  expandPromptTextParts,
} from "../../domain/prompt-parts.js";
import type { CliShellPromptPart, CliShellPromptSnapshot } from "../../domain/prompt.js";
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

export interface ShellSessionHandlerContext {
  cwd: string;
  getState(): CliShellViewState;
  getBundle(): CliShellSessionBundle;
  getSessionPort(): SessionViewPort;
  getSessionPhase(): SessionPhase;
  getSessionGeneration(): number;
  getUi(): CliShellUiPort;
  promptMemory: PromptMemoryDelegate;
  transcriptProjector: TranscriptProjectorDelegate;
  modelSelection: ModelSelectionDelegate;
  providerAuth: ProviderAuthDelegate;
  commit(input: ShellCommitInput, options?: ShellCommitOptions): void;
  runShellEffects(effects: readonly ShellEffect[]): Promise<void>;
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
        await this.context.runShellEffects([
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
        ]);
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

    if (options.waitForPromptEffect === false) {
      setTimeout(() => {
        void runPromptEffect()
          .then(() => {
            this.context.notifyInteractiveUserPromptCommitted();
          })
          .catch((error) => {
            this.context
              .getUi()
              .notify(error instanceof Error ? error.message : "Failed to run prompt.", "error");
          });
      }, 0);
      return;
    }

    await runPromptEffect();
    this.context.notifyInteractiveUserPromptCommitted();
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
      // plane to compose, so report why the transaction could not run.
      this.context.getUi().notify(`Undo unavailable: ${result.reason}.`, "warning");
      return;
    }
    this.context.transcriptProjector.setRewindMarker(
      `Session undo applied: reverted ${result.patchSetIds.length} patch set(s) and restored the submitted prompt. Use /redo to restore the undone turn.`,
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
        `Undid ${result.patchSetIds.length} patch set(s); prompt restored for session rewind.`,
        "info",
      );
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
      this.context.getUi().notify(`Rewind unavailable (${result.reason}).`, "warning");
      return;
    }

    this.context.transcriptProjector.setRewindMarker(
      `Session rewind applied: rewound to turn ${result.checkpoint.turn} and reverted ${result.patchSetIds.length} patch set(s). Use /redo to restore the abandoned branch tip.`,
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
        `Rewound to turn ${result.checkpoint.turn}; reverted ${result.patchSetIds.length} patch set(s).`,
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
    this.context.dismissPendingInteractiveQuestionRequests({
      sessionId: this.context.getSessionPort().getSessionId(),
    });
    try {
      recordSessionShutdownIfMissing(this.context.getBundle().runtime, {
        sessionId: this.context.getSessionPort().getSessionId(),
        reason: "cli_shell_session_switch",
        source: "cli_shell_runtime",
      });
    } catch {
      // best effort terminal receipt for session switching
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
