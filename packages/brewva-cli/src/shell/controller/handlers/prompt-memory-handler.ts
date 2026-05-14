import type { ShellCommitOptions } from "../../domain/actions.js";
import {
  appendPromptHistoryEntry,
  createPromptHistoryState,
  navigatePromptHistoryState,
  type PromptHistoryState,
} from "../../domain/composer-actions.js";
import type { CliShellInput } from "../../domain/input.js";
import { normalizeShellInputKey } from "../../domain/keymap.js";
import {
  cloneCliShellPromptParts,
  cloneCliShellPromptStashEntry,
  summarizePromptSnapshot,
} from "../../domain/prompt-parts.js";
import type {
  CliShellPromptSnapshot,
  CliShellPromptStashEntry,
  CliShellPromptStorePort,
} from "../../domain/prompt.js";
import type { CliShellAction, CliShellViewState } from "../../domain/state.js";

export interface ShellPromptMemoryDialogRequest {
  id: string;
  kind: "confirm" | "input" | "select";
  title: string;
  message?: string;
  options?: string[];
  masked?: boolean;
}

export interface ShellPromptMemoryHandlerContext {
  getState(): CliShellViewState;
  commit(action: CliShellAction, options?: ShellCommitOptions): void;
  notify(message: string, level: "info" | "warning" | "error"): void;
  requestDialog<T>(request: ShellPromptMemoryDialogRequest): Promise<T>;
}

export class ShellPromptMemoryHandler {
  #history: PromptHistoryState;
  #stashEntries: CliShellPromptStashEntry[];

  constructor(
    private readonly store: CliShellPromptStorePort,
    private readonly context: ShellPromptMemoryHandlerContext,
    private readonly limit: number,
  ) {
    this.#history = createPromptHistoryState(this.store.loadHistory());
    this.#stashEntries = this.store
      .loadStash()
      .map((entry) => cloneCliShellPromptStashEntry(entry));
  }

  appendHistory(entry: CliShellPromptSnapshot): void {
    this.#history = appendPromptHistoryEntry(this.#history, entry, this.limit);
    this.store.appendHistory(entry);
  }

  resetNavigation(): void {
    this.#history = {
      ...this.#history,
      index: 0,
      draft: undefined,
    };
  }

  canNavigate(direction: -1 | 1, input: CliShellInput): boolean {
    const state = this.context.getState();
    if (
      input.ctrl ||
      input.meta ||
      input.shift ||
      state.overlay.active?.payload ||
      state.composer.completion
    ) {
      return false;
    }
    const key = normalizeShellInputKey(input.key);
    if (direction === -1) {
      return key === "up" && state.composer.cursor === 0 && this.#history.entries.length > 0;
    }
    if (direction === 1) {
      return (
        key === "down" &&
        state.composer.cursor === state.composer.text.length &&
        this.#history.index > 0
      );
    }
    return false;
  }

  navigate(direction: -1 | 1): void {
    const state = this.context.getState();
    const result = navigatePromptHistoryState({
      history: this.#history,
      direction,
      composer: {
        text: state.composer.text,
        cursor: state.composer.cursor,
        parts: state.composer.parts,
      },
    });
    if (!result) {
      return;
    }
    this.#history = result.history;
    this.context.commit(
      {
        type: "composer.setPromptState",
        text: result.composer.text,
        cursor: result.composer.cursor,
        parts: result.composer.parts,
      },
      { debounceStatus: false },
    );
  }

  stashCurrentPrompt(): void {
    const state = this.context.getState();
    const snapshot = {
      text: state.composer.text,
      parts: cloneCliShellPromptParts(state.composer.parts),
    };
    if (snapshot.text.trim().length === 0) {
      this.context.notify("Nothing to stash yet. Type a prompt, then press Ctrl+S.", "warning");
      return;
    }
    const entry = this.store.pushStash(snapshot);
    this.#stashEntries = [...this.#stashEntries, cloneCliShellPromptStashEntry(entry)].slice(
      -this.limit,
    );
    this.context.commit(
      {
        type: "composer.setText",
        text: "",
        cursor: 0,
      },
      { debounceStatus: false },
    );
    this.context.notify(
      `Stashed prompt: ${summarizePromptSnapshot(snapshot)}. Press Ctrl+Y to restore the latest draft.`,
      "info",
    );
  }

  restoreLatestStash(): void {
    const entry = this.store.popStash();
    if (!entry) {
      this.context.notify(
        "No stashed prompts yet. Press Ctrl+S to stash the current prompt first.",
        "warning",
      );
      return;
    }
    this.#stashEntries = this.store.loadStash().map((item) => cloneCliShellPromptStashEntry(item));
    this.context.commit(
      {
        type: "composer.setPromptState",
        text: entry.text,
        cursor: entry.text.length,
        parts: cloneCliShellPromptParts(entry.parts),
      },
      { debounceStatus: false },
    );
    this.context.notify(`Restored stashed prompt: ${summarizePromptSnapshot(entry)}`, "info");
  }

  async selectStashedPrompt(): Promise<void> {
    if (this.#stashEntries.length === 0) {
      this.context.notify(
        "No stashed prompts yet. Press Ctrl+S to stash the current prompt first.",
        "warning",
      );
      return;
    }
    const options = this.#stashEntries
      .map((entry, index, items) => {
        const reverseIndex = items.length - index;
        return `${reverseIndex}. ${summarizePromptSnapshot(entry)}`;
      })
      .toReversed();
    const selection = await this.context.requestDialog<string | undefined>({
      id: `stash:${Date.now()}`,
      kind: "select",
      title: "Select Stashed Prompt",
      options,
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
    const index = this.#stashEntries.length - ordinal;
    const entry = this.#stashEntries[index];
    if (!entry) {
      return;
    }
    this.context.commit(
      {
        type: "composer.setPromptState",
        text: entry.text,
        cursor: entry.text.length,
        parts: cloneCliShellPromptParts(entry.parts),
      },
      { debounceStatus: false },
    );
  }
}
