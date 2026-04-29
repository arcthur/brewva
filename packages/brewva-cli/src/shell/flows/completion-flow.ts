import type { ShellCompletionProvider } from "../completion-provider.js";
import {
  acceptComposerCompletion,
  completionStateEquals,
  resolveComposerCompletion,
  type DismissedCompletionState,
} from "../composer-actions.js";
import type { ShellCommitOptions } from "../shell-actions.js";
import type { CliShellAction, CliShellCompletionState, CliShellViewState } from "../state/index.js";

export interface ShellCompletionFlowContext {
  provider: ShellCompletionProvider;
  getState(): CliShellViewState;
  getSessionId(): string;
  commit(action: CliShellAction, options?: ShellCommitOptions): void;
  replaceCompletionState(completion: CliShellCompletionState | undefined): void;
  emitChange(): void;
  submitComposer(): Promise<void>;
}

export class ShellCompletionFlow {
  readonly #dismissedBySessionId = new Map<string, DismissedCompletionState>();

  constructor(private readonly context: ShellCompletionFlowContext) {}

  refresh(): void {
    const state = this.context.getState();
    const result = resolveComposerCompletion({
      text: state.composer.text,
      cursor: state.composer.cursor,
      current: state.composer.completion,
      dismissed: this.getDismissedCompletionState(),
      provider: this.context.provider,
    });
    if (result.clearDismissed) {
      this.clearDismissedCompletionState();
    }
    this.setCompletionState(result.completion);
  }

  move(delta: number): void {
    const completion = this.context.getState().composer.completion;
    if (!completion || completion.items.length === 0) {
      return;
    }
    const nextIndex =
      (completion.selectedIndex + delta + completion.items.length) % completion.items.length;
    this.context.commit(
      {
        type: "completion.set",
        completion: {
          ...completion,
          selectedIndex: nextIndex,
        },
      },
      { debounceStatus: false },
    );
  }

  select(index: number): void {
    const completion = this.context.getState().composer.completion;
    if (!completion) {
      return;
    }
    if (index < 0 || index >= completion.items.length || completion.selectedIndex === index) {
      return;
    }
    this.context.commit(
      {
        type: "completion.set",
        completion: {
          ...completion,
          selectedIndex: index,
        },
      },
      { debounceStatus: false },
    );
  }

  accept(): void {
    const state = this.context.getState();
    const completion = state.composer.completion;
    if (!completion) {
      return;
    }
    const selected = completion.items[completion.selectedIndex];
    const nextState = acceptComposerCompletion({
      completion,
      composer: {
        text: state.composer.text,
        cursor: state.composer.cursor,
        parts: state.composer.parts,
      },
      createPromptPartId: (prefix) =>
        `${prefix}-part:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`,
    });
    if (!nextState) {
      return;
    }
    if (selected) {
      this.context.provider.recordAccepted(selected);
    }
    this.context.commit(
      {
        type: "composer.setPromptState",
        text: nextState.text,
        cursor: nextState.cursor,
        parts: nextState.parts,
      },
      { debounceStatus: false },
    );
    if (selected && selected.accept.type !== "insertDirectoryText") {
      this.#dismissedBySessionId.set(this.context.getSessionId(), {
        trigger: completion.trigger,
        text: nextState.text,
        cursor: nextState.cursor,
      });
      this.setCompletionState(undefined);
    }
  }

  async submit(): Promise<void> {
    const completion = this.context.getState().composer.completion;
    if (!completion) {
      return;
    }
    const selected = completion.items[completion.selectedIndex];
    if (!selected) {
      if (completion.trigger === "/") {
        await this.context.submitComposer();
      }
      return;
    }
    if (selected.accept.type !== "runCommand") {
      this.accept();
      return;
    }

    if (selected.accept.argumentMode === "required") {
      this.accept();
      return;
    }

    this.context.provider.recordAccepted(selected);
    const commandText = `/${selected.value}`;
    this.context.commit(
      {
        type: "composer.setPromptState",
        text: commandText,
        cursor: commandText.length,
        parts: [],
      },
      { debounceStatus: false },
    );
    await this.context.submitComposer();
  }

  dismiss(): void {
    const state = this.context.getState();
    const completion = state.composer.completion;
    if (!completion) {
      return;
    }
    // Match opencode behavior: Escape on an incomplete slash command clears the text entirely
    // rather than leaving a dangling partial "/command" in the composer. This also avoids the
    // dismissed-state bug where backspace back to the same (text, cursor) would keep the
    // completion suppressed.
    if (completion.trigger === "/") {
      const text = state.composer.text;
      if (text.startsWith("/") && !text.includes(" ")) {
        this.context.commit({ type: "composer.setText", text: "", cursor: 0 });
        return;
      }
    }
    this.#dismissedBySessionId.set(this.context.getSessionId(), {
      trigger: completion.trigger,
      text: state.composer.text,
      cursor: state.composer.cursor,
    });
    this.setCompletionState(undefined);
    this.context.emitChange();
  }

  clearDismissedForCurrentSession(): void {
    this.clearDismissedCompletionState();
  }

  private getDismissedCompletionState(): DismissedCompletionState | undefined {
    return this.#dismissedBySessionId.get(this.context.getSessionId());
  }

  private clearDismissedCompletionState(): void {
    this.#dismissedBySessionId.delete(this.context.getSessionId());
  }

  private setCompletionState(completion: CliShellCompletionState | undefined): void {
    if (completionStateEquals(this.context.getState().composer.completion, completion)) {
      return;
    }
    this.context.replaceCompletionState(completion);
  }
}
