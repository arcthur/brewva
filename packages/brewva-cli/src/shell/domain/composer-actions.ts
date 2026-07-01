import type {
  ShellCompletionCandidate,
  ShellCompletionProvider,
  ShellCompletionRange,
} from "./completion-provider.js";
import {
  cloneCliShellPromptParts,
  cloneCliShellPromptSnapshot,
  rebasePromptPartsAfterTextReplace,
} from "./prompt-parts.js";
import type { CliShellPromptPart, CliShellPromptSnapshot } from "./prompt.js";
import type { CliShellCompletionState } from "./state.js";

export interface PromptHistoryState {
  entries: CliShellPromptSnapshot[];
  index: number;
  draft?: {
    text: string;
    cursor: number;
    parts: CliShellPromptPart[];
  };
}

export interface DismissedCompletionState {
  trigger: CliShellCompletionState["trigger"];
  text: string;
  cursor: number;
}

export interface ComposerPromptState {
  text: string;
  cursor: number;
  parts: CliShellPromptPart[];
}

export interface ResolveComposerCompletionInput {
  text: string;
  cursor: number;
  current: CliShellCompletionState | undefined;
  dismissed: DismissedCompletionState | undefined;
  provider: ShellCompletionProvider;
}

export interface ResolveComposerCompletionResult {
  completion: CliShellCompletionState | undefined;
  clearDismissed: boolean;
}

export function createPromptHistoryState(
  entries: readonly CliShellPromptSnapshot[] = [],
): PromptHistoryState {
  return {
    entries: entries.map((entry) => cloneCliShellPromptSnapshot(entry)),
    index: 0,
  };
}

export function appendPromptHistoryEntry(
  history: PromptHistoryState,
  entry: CliShellPromptSnapshot,
  limit: number,
): PromptHistoryState {
  const snapshot = cloneCliShellPromptSnapshot(entry);
  // Suppress an adjacent duplicate so re-sending the same prompt does not stack
  // repeats in up/down navigation. This mirrors the persisted store's dedup
  // (prompt-store.appendHistory) so the in-session and post-restart history agree.
  const entries =
    history.entries.at(-1)?.text === snapshot.text
      ? history.entries
      : [...history.entries, snapshot].slice(-limit);
  return {
    entries,
    index: 0,
    draft: undefined,
  };
}

export function navigatePromptHistoryState(input: {
  history: PromptHistoryState;
  direction: -1 | 1;
  composer: ComposerPromptState;
}): { history: PromptHistoryState; composer: ComposerPromptState } | undefined {
  const { history, direction, composer } = input;
  if (history.entries.length === 0) {
    return undefined;
  }

  if (history.index > 0) {
    const currentEntry = getPromptHistoryEntry(history, history.index);
    if (currentEntry && currentEntry.text !== composer.text) {
      return undefined;
    }
  }

  let nextIndex = history.index;
  let nextDraft = history.draft
    ? {
        text: history.draft.text,
        cursor: history.draft.cursor,
        parts: cloneCliShellPromptParts(history.draft.parts),
      }
    : undefined;

  if (direction === -1) {
    if (nextIndex >= history.entries.length) {
      return undefined;
    }
    if (nextIndex === 0) {
      nextDraft = {
        text: composer.text,
        cursor: composer.cursor,
        parts: cloneCliShellPromptParts(composer.parts),
      };
    }
    nextIndex += 1;
  } else {
    if (nextIndex === 0) {
      return undefined;
    }
    nextIndex -= 1;
  }

  const nextEntry =
    nextIndex === 0
      ? (nextDraft ?? { text: "", cursor: 0, parts: [] })
      : getPromptHistoryEntry({ ...history, draft: nextDraft, index: nextIndex }, nextIndex);
  if (!nextEntry) {
    return undefined;
  }

  return {
    history: {
      entries: history.entries.map((entry) => cloneCliShellPromptSnapshot(entry)),
      index: nextIndex,
      draft: nextDraft,
    },
    composer: {
      text: nextEntry.text,
      cursor: direction === -1 ? 0 : nextEntry.text.length,
      parts: cloneCliShellPromptParts(nextEntry.parts),
    },
  };
}

export function completionStateEquals(
  left: CliShellCompletionState | undefined,
  right: CliShellCompletionState | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  if (
    left.trigger !== right.trigger ||
    left.query !== right.query ||
    left.range.start !== right.range.start ||
    left.range.end !== right.range.end ||
    left.range.trigger !== right.range.trigger ||
    left.range.query !== right.range.query ||
    left.selectedIndex !== right.selectedIndex ||
    left.items.length !== right.items.length
  ) {
    return false;
  }
  return left.items.every((item, index) => {
    const candidate = right.items[index];
    return candidate ? completionItemEquals(item, candidate) : false;
  });
}

export function resolveComposerCompletion(
  input: ResolveComposerCompletionInput,
): ResolveComposerCompletionResult {
  const range = findCompletionRange(input.text, input.cursor);
  if (range) {
    if (matchesDismissedCompletion(input.dismissed, range.trigger, input.text, input.cursor)) {
      return { completion: undefined, clearDismissed: false };
    }
    const items = input.provider.resolve(range);
    return {
      completion: {
        trigger: range.trigger,
        query: range.query,
        range,
        items,
        selectedIndex: resolveCompletionSelection(input.current, range, items),
      },
      clearDismissed: input.dismissed !== undefined,
    };
  }

  return {
    completion: undefined,
    clearDismissed: input.dismissed !== undefined,
  };
}

export function acceptComposerCompletion(input: {
  completion: CliShellCompletionState;
  composer: ComposerPromptState;
  createPromptPartId(prefix: "agent" | "file" | "text"): string;
}): ComposerPromptState | undefined {
  const selected = input.completion.items[input.completion.selectedIndex];
  if (!selected) {
    return undefined;
  }

  if (selected.accept.type === "runCommand") {
    return {
      text: selected.accept.insertText,
      cursor: selected.accept.insertText.length,
      parts: cloneCliShellPromptParts(input.composer.parts),
    };
  }

  const range = input.completion.range;
  // The completion may have been resolved against an older composer state
  // (refresh is debounced). A range that no longer fits the current text,
  // or whose trigger character is gone, is stale — accepting it would
  // splice the candidate into unrelated text. Treat it as a no-op; the
  // pending refresh will reconcile the popup.
  if (
    range.start < 0 ||
    range.end > input.composer.text.length ||
    input.composer.text[range.start] !== range.trigger
  ) {
    return undefined;
  }
  const replaceEnd = Math.max(range.end, input.composer.cursor);
  const visibleText = completionVisibleText(selected);
  const nextText = replaceRange(input.composer.text, range.start, replaceEnd, visibleText);
  const insertedPart = completionInsertedPart({
    selected,
    visibleText,
    start: range.start,
    createPromptPartId: (prefix) => input.createPromptPartId(prefix),
  });
  return {
    text: nextText,
    cursor: range.start + visibleText.length,
    parts: rebasePromptPartsAfterTextReplace(
      input.composer.parts,
      {
        start: range.start,
        end: replaceEnd,
        replacementText: visibleText,
      },
      insertedPart,
    ),
  };
}

function getPromptHistoryEntry(
  history: PromptHistoryState,
  index: number,
): { text: string; parts: CliShellPromptPart[]; cursor?: number } | undefined {
  if (index === 0) {
    return history.draft;
  }
  return history.entries[history.entries.length - index];
}

function findReferenceCompletionRange(text: string, cursor: number): ShellCompletionRange | null {
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)@(?<path>"[^"]*|[^\s]*)$/u.exec(before);
  if (match?.groups?.path === undefined) {
    return null;
  }
  const query = match.groups.path.replace(/^"/u, "");
  return {
    trigger: "@",
    query,
    start: cursor - match.groups.path.length - 1,
    end: cursor,
  };
}

function findSlashCompletionRange(text: string, cursor: number): ShellCompletionRange | null {
  const before = text.slice(0, cursor);
  const match = /^\/(?<command>[^\s]*)$/u.exec(before);
  if (!match?.groups) {
    return null;
  }
  return {
    trigger: "/",
    query: match.groups.command ?? "",
    start: 0,
    end: cursor,
  };
}

export function findCompletionRange(text: string, cursor: number): ShellCompletionRange | null {
  return findSlashCompletionRange(text, cursor) ?? findReferenceCompletionRange(text, cursor);
}

function resolveCompletionSelection(
  previous: CliShellCompletionState | undefined,
  range: ShellCompletionRange,
  items: readonly ShellCompletionCandidate[],
): number {
  if (
    !previous ||
    previous.trigger !== range.trigger ||
    previous.query !== range.query ||
    previous.range.start !== range.start ||
    previous.range.end !== range.end ||
    previous.items.length === 0 ||
    items.length === 0
  ) {
    return 0;
  }
  const selected = previous.items[previous.selectedIndex];
  if (!selected) {
    return 0;
  }
  const nextIndex = items.findIndex((item) => item.id === selected.id);
  return nextIndex >= 0 ? nextIndex : 0;
}

function completionItemEquals(
  left: ShellCompletionCandidate,
  right: ShellCompletionCandidate,
): boolean {
  return left.id === right.id;
}

function matchesDismissedCompletion(
  dismissed: DismissedCompletionState | undefined,
  trigger: CliShellCompletionState["trigger"],
  text: string,
  cursor: number,
): boolean {
  return dismissed?.trigger === trigger && dismissed.text === text && dismissed.cursor === cursor;
}

function replaceRange(text: string, start: number, end: number, replacement: string): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

function completionVisibleText(candidate: ShellCompletionCandidate): string {
  switch (candidate.accept.type) {
    case "insertFilePart":
      return `@${candidate.accept.path}`;
    case "insertDirectoryText":
      return `@${candidate.accept.text}`;
    case "insertAgentPart":
      return `@${candidate.accept.agentId}`;
    case "insertText":
      return candidate.accept.text;
    case "runCommand":
      return candidate.accept.insertText;
    default: {
      const exhaustiveCheck: never = candidate.accept;
      void exhaustiveCheck;
      return "";
    }
  }
}

function completionInsertedPart(input: {
  selected: ShellCompletionCandidate;
  visibleText: string;
  start: number;
  createPromptPartId(prefix: "agent" | "file" | "text"): string;
}): CliShellPromptPart | undefined {
  switch (input.selected.accept.type) {
    case "insertFilePart":
      return {
        id: input.createPromptPartId("file"),
        type: "file",
        path: input.selected.accept.path,
        source: {
          text: {
            start: input.start,
            end: input.start + input.visibleText.length,
            value: input.visibleText,
          },
        },
      };
    case "insertAgentPart":
      return {
        id: input.createPromptPartId("agent"),
        type: "agent",
        agentId: input.selected.accept.agentId,
        source: {
          text: {
            start: input.start,
            end: input.start + input.visibleText.length,
            value: input.visibleText,
          },
        },
      };
    case "insertDirectoryText":
    case "insertText":
    case "runCommand":
      return undefined;
    default: {
      const exhaustiveCheck: never = input.selected.accept;
      void exhaustiveCheck;
      return undefined;
    }
  }
}
