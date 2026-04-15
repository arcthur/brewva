import {
  cloneCliShellPromptParts,
  cloneCliShellPromptSnapshot,
  rebasePromptPartsAfterTextReplace,
} from "./prompt-parts.js";
import type { CliShellCompletionItem, CliShellCompletionState } from "./state/index.js";
import type {
  CliShellPromptPart,
  CliShellPromptSnapshot,
  PathCompletionEntry,
  SlashCommandEntry,
} from "./types.js";

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
  kind: CliShellCompletionState["kind"];
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
  slashCommands: readonly SlashCommandEntry[];
  pathEntries(query: string): readonly PathCompletionEntry[];
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
  return {
    entries: [...history.entries, snapshot].slice(-limit),
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
    left.kind !== right.kind ||
    left.query !== right.query ||
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
  const slashQuery = findSlashCompletion(input.text, input.cursor);
  if (slashQuery !== null) {
    if (matchesDismissedCompletion(input.dismissed, "slash", input.text, input.cursor)) {
      return { completion: undefined, clearDismissed: false };
    }
    const normalizedQuery = normalizeCompletionQuery(slashQuery);
    const matched = filterSlashCommandsFuzzy(input.slashCommands, normalizedQuery);
    // Pad labels so descriptions form a consistent second column (opencode style).
    const maxLabelLen = matched.reduce((m, e) => Math.max(m, e.command.length + 1), 0);
    const items = matched.map((entry): CliShellCompletionItem => {
      const rawLabel = `/${entry.command}`;
      return {
        kind: "slash",
        label: maxLabelLen > 0 ? rawLabel.padEnd(maxLabelLen + 2) : rawLabel,
        value: entry.command,
        insertText: `/${entry.command} `,
        description: entry.description,
      };
    });
    // Always return a completion state when the slash trigger is active so the overlay
    // can show "No matching items" instead of silently vanishing (matches opencode behavior).
    return {
      completion: {
        kind: "slash",
        query: slashQuery,
        items,
        selectedIndex: resolveCompletionSelection(input.current, items),
      },
      clearDismissed: input.dismissed !== undefined,
    };
  }

  const pathRange = findPathCompletionRange(input.text, input.cursor);
  if (pathRange) {
    if (matchesDismissedCompletion(input.dismissed, "path", input.text, input.cursor)) {
      return { completion: undefined, clearDismissed: false };
    }
    const items = input.pathEntries(pathRange.query).map(
      (item): CliShellCompletionItem => ({
        kind: "path",
        label: `@${item.value}`,
        value: item.value,
        insertText: item.value,
        description: item.description,
        detail: item.kind,
      }),
    );
    return {
      completion:
        items.length > 0
          ? {
              kind: "path",
              query: pathRange.query,
              items,
              selectedIndex: resolveCompletionSelection(input.current, items),
            }
          : undefined,
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
  createPromptPartId(prefix: "file" | "text"): string;
}): ComposerPromptState | undefined {
  const selected = input.completion.items[input.completion.selectedIndex];
  if (!selected) {
    return undefined;
  }

  if (input.completion.kind === "slash") {
    return {
      text: selected.insertText,
      cursor: selected.insertText.length,
      parts: cloneCliShellPromptParts(input.composer.parts),
    };
  }

  const pathRange = findPathCompletionRange(input.composer.text, input.composer.cursor);
  if (!pathRange) {
    return undefined;
  }
  const tokenStart =
    pathRange.start > 0 && input.composer.text[pathRange.start - 1] === "@"
      ? pathRange.start - 1
      : pathRange.start;
  const visibleText = `@${selected.insertText}`;
  const nextText = replaceRange(input.composer.text, tokenStart, pathRange.end, visibleText);
  const insertedPart =
    selected.detail === "directory"
      ? undefined
      : ({
          id: input.createPromptPartId("file"),
          type: "file",
          path: selected.value,
          source: {
            text: {
              start: tokenStart,
              end: tokenStart + visibleText.length,
              value: visibleText,
            },
          },
        } satisfies CliShellPromptPart);
  return {
    text: nextText,
    cursor: tokenStart + visibleText.length,
    parts: rebasePromptPartsAfterTextReplace(
      input.composer.parts,
      {
        start: tokenStart,
        end: pathRange.end,
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

function findPathCompletionRange(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, cursor);
  const match = /(?:^|\s)@(?<path>"[^"]*|[^\s]*)$/u.exec(before);
  if (!match?.groups?.path) {
    return null;
  }
  const query = match.groups.path.replace(/^"/u, "");
  return {
    start: cursor - match.groups.path.length,
    end: cursor,
    query,
  };
}

function findSlashCompletion(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor);
  const match = /^\/(?<command>[^\s]*)$/u.exec(before);
  return match?.groups?.command ?? null;
}

function normalizeCompletionQuery(query: string): string {
  return query.trim().toLowerCase();
}

function resolveCompletionSelection(
  previous: CliShellCompletionState | undefined,
  items: readonly CliShellCompletionItem[],
): number {
  if (!previous || previous.items.length === 0 || items.length === 0) {
    return 0;
  }
  const selected = previous.items[previous.selectedIndex];
  if (!selected) {
    return 0;
  }
  const nextIndex = items.findIndex(
    (item) =>
      item.kind === selected.kind &&
      item.value === selected.value &&
      item.insertText === selected.insertText,
  );
  return nextIndex >= 0 ? nextIndex : 0;
}

function completionItemEquals(
  left: CliShellCompletionItem,
  right: CliShellCompletionItem,
): boolean {
  return (
    left.kind === right.kind &&
    left.label === right.label &&
    left.value === right.value &&
    left.insertText === right.insertText &&
    left.description === right.description &&
    left.detail === right.detail
  );
}

function matchesDismissedCompletion(
  dismissed: DismissedCompletionState | undefined,
  kind: CliShellCompletionState["kind"],
  text: string,
  cursor: number,
): boolean {
  return dismissed?.kind === kind && dismissed.text === text && dismissed.cursor === cursor;
}

function replaceRange(text: string, start: number, end: number, replacement: string): string {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

/**
 * Fuzzy-filter and rank slash commands against a query string.
 * Scoring (higher = better):
 *   - Prefix match on "/command"  → 1000 − command.length (shorter prefix wins)
 *   - Fuzzy subsequence on name   → based on consecutive-character bonuses
 *   - Fuzzy subsequence on desc   → same score − 500 (lower priority)
 * Non-matching entries are excluded. Empty query returns all commands sorted alphabetically.
 */
function filterSlashCommandsFuzzy(
  commands: readonly SlashCommandEntry[],
  query: string,
): SlashCommandEntry[] {
  if (!query) {
    return [...commands].toSorted((a, b) => a.command.localeCompare(b.command));
  }

  const results: Array<{ entry: SlashCommandEntry; score: number }> = [];
  for (const entry of commands) {
    // Match against the bare command name (no leading "/") so that prefix scoring
    // fires correctly: "qu" vs "quit" (prefix) outranks "qu" inside a description.
    const nameTarget = entry.command.toLowerCase();
    let score = fuzzyScore(query, nameTarget);
    if (score === null) {
      const descScore = fuzzyScore(query, (entry.description ?? "").toLowerCase());
      if (descScore !== null) {
        score = descScore - 500;
      }
    }
    if (score !== null) {
      results.push({ entry, score });
    }
  }

  return results.toSorted((a, b) => b.score - a.score).map((r) => r.entry);
}

/**
 * Returns a numeric score if `query` is a fuzzy subsequence of `target`, or null if not.
 * Prefix matches score highest. Consecutive character runs add bonus points.
 */
function fuzzyScore(query: string, target: string): number | null {
  if (query.length === 0) {
    return 0;
  }
  // Exact prefix → highest priority bucket
  if (target.startsWith(query)) {
    return 1000 - target.length;
  }
  // Subsequence scan with consecutive-run bonus
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -2;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) {
      score += lastMatchIndex === ti - 1 ? 10 : 1;
      lastMatchIndex = ti;
      qi++;
    }
  }
  return qi < query.length ? null : score;
}
