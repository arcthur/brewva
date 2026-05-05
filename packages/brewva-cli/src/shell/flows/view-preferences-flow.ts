import type {
  BrewvaDiffPreferences,
  BrewvaShellViewPreferences,
} from "@brewva/brewva-substrate/session";
import type { ShellCommitOptions } from "../shell-actions.js";
import type { CliShellAction, CliShellViewState } from "../state/index.js";
import type { CliShellUiPort, SessionViewPort } from "../types.js";

export function normalizeDiffPreferences(
  preferences: Partial<BrewvaDiffPreferences>,
): BrewvaDiffPreferences {
  return {
    style: preferences.style === "stacked" ? "stacked" : "auto",
    wrapMode: preferences.wrapMode === "none" ? "none" : "word",
  };
}

export function normalizeShellViewPreferences(
  preferences: Partial<BrewvaShellViewPreferences>,
): BrewvaShellViewPreferences {
  return {
    showThinking: preferences.showThinking !== false,
    toolDetails: preferences.toolDetails !== false,
  };
}

export interface ShellViewPreferencesFlowContext {
  getSessionPort(): SessionViewPort;
  getState(): CliShellViewState;
  getUi(): CliShellUiPort;
  commit(action: CliShellAction, options?: ShellCommitOptions): void;
}

export class ShellViewPreferencesFlow {
  constructor(private readonly context: ShellViewPreferencesFlowContext) {}

  toggleThinkingVisibility(): void {
    const next = !this.context.getState().view.showThinking;
    this.persistShellViewPreferences({
      ...this.currentShellViewPreferences(),
      showThinking: next,
    });
    this.context
      .getUi()
      .notify(next ? "Thinking blocks shown." : "Thinking blocks hidden.", "info");
  }

  toggleToolDetails(): void {
    const next = !this.context.getState().view.toolDetails;
    this.persistShellViewPreferences({
      ...this.currentShellViewPreferences(),
      toolDetails: next,
    });
    this.context.getUi().notify(next ? "Tool details shown." : "Tool details hidden.", "info");
  }

  toggleDiffWrapMode(): void {
    const next = this.context.getState().diff.wrapMode === "word" ? "none" : "word";
    this.persistDiffPreferences({
      ...this.context.getState().diff,
      wrapMode: next,
    });
    this.context
      .getUi()
      .notify(next === "word" ? "Diff wrapping enabled." : "Diff wrapping disabled.", "info");
  }

  toggleDiffStyle(): void {
    const next = this.context.getState().diff.style === "auto" ? "stacked" : "auto";
    this.persistDiffPreferences({
      ...this.context.getState().diff,
      style: next,
    });
    this.context
      .getUi()
      .notify(
        next === "auto"
          ? "Diff style set to auto split/unified."
          : "Diff style set to stacked unified.",
        "info",
      );
  }

  private persistDiffPreferences(preferences: BrewvaDiffPreferences): void {
    const normalized = normalizeDiffPreferences(preferences);
    this.context.getSessionPort().setDiffPreferences(normalized);
    this.context.commit(
      {
        type: "diff.setPreferences",
        preferences: normalized,
      },
      { debounceStatus: false },
    );
  }

  private persistShellViewPreferences(preferences: BrewvaShellViewPreferences): void {
    const normalized = normalizeShellViewPreferences(preferences);
    this.context.getSessionPort().setShellViewPreferences(normalized);
    this.context.commit(
      {
        type: "view.setPreferences",
        preferences: {
          showThinking: normalized.showThinking,
          toolDetails: normalized.toolDetails,
        },
      },
      { debounceStatus: false },
    );
  }

  private currentShellViewPreferences(): BrewvaShellViewPreferences {
    return {
      showThinking: this.context.getState().view.showThinking,
      toolDetails: this.context.getState().view.toolDetails,
    };
  }
}
