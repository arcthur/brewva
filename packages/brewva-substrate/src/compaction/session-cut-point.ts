export interface BrewvaSessionCompactionEntryLike {
  readonly id: string;
  readonly type: string;
}

export interface BrewvaSessionCompactionTokenEstimateEntry extends BrewvaSessionCompactionEntryLike {
  readonly message?: unknown;
  readonly content?: unknown;
  readonly summary?: unknown;
}

export interface BrewvaSessionCompactionCutPointOptions<
  TEntry extends BrewvaSessionCompactionEntryLike,
> {
  readonly tailProtectTokens: number;
  readonly targetContextWindow?: number | null;
  readonly reserveTokens?: number | null;
  /**
   * Reserved for future turn-prefix summary support. Callers that know the prior
   * kept boundary can clamp newer selections without splitting a turn group.
   */
  readonly previousFirstKeptEntryId?: string | null;
  readonly estimateEntryTokens?: (entry: TEntry, index: number) => number;
  readonly isKeepableEntry?: (entry: TEntry) => boolean;
}

export interface BrewvaSessionCompactionCutPoint {
  readonly firstKeptEntryId: string;
  readonly firstKeptIndex: number;
  readonly tokensKept: number;
  readonly tokensBefore: number;
  /**
   * Reserved for future turn-prefix summary support. Current callers persist
   * the signal in compaction details but do not create a second summary yet.
   */
  readonly turnPrefixSummaryRequired: boolean;
  readonly reason: "tail_budget" | "minimum_tail" | "oversized_active_turn";
}

interface KeepableEntry<TEntry extends BrewvaSessionCompactionEntryLike> {
  readonly entry: TEntry;
  readonly index: number;
  readonly tokenCount: number;
  readonly role: string | null;
}

interface TurnGroup<TEntry extends BrewvaSessionCompactionEntryLike> {
  readonly entries: readonly KeepableEntry<TEntry>[];
  readonly tokenCount: number;
}

function defaultIsKeepableEntry(entry: BrewvaSessionCompactionEntryLike): boolean {
  return (
    entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary"
  );
}

function readRole(entry: BrewvaSessionCompactionEntryLike): string | null {
  const record = entry as BrewvaSessionCompactionEntryLike & {
    readonly role?: unknown;
    readonly message?: { readonly role?: unknown };
  };
  const role = record.message?.role ?? record.role;
  return typeof role === "string" && role.length > 0 ? role : null;
}

function estimateStructuredTokens(value: unknown): number {
  const serialized = JSON.stringify(value);
  return estimateTextTokens(serialized ?? "");
}

function estimateTextTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function estimateBrewvaSessionEntryTokens(
  entry: BrewvaSessionCompactionTokenEstimateEntry,
): number {
  if (entry.type === "message") {
    return estimateStructuredTokens(entry.message);
  }
  if (entry.type === "custom_message") {
    return estimateStructuredTokens(entry.content);
  }
  if (entry.type === "branch_summary" && typeof entry.summary === "string") {
    return estimateTextTokens(entry.summary);
  }
  return estimateStructuredTokens(entry);
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0;
}

function normalizeBudget(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function effectiveTailBudget<TEntry extends BrewvaSessionCompactionEntryLike>(
  options: BrewvaSessionCompactionCutPointOptions<TEntry>,
): number {
  const configuredTail = normalizeBudget(options.tailProtectTokens) ?? 0;
  const targetWindow = normalizeBudget(options.targetContextWindow);
  const reserveTokens = normalizeBudget(options.reserveTokens) ?? 0;
  if (targetWindow === null || targetWindow === 0) {
    return configuredTail;
  }
  return Math.min(configuredTail, Math.max(0, targetWindow - reserveTokens));
}

function collectKeepableEntries<TEntry extends BrewvaSessionCompactionEntryLike>(
  branchEntries: readonly TEntry[],
  options: BrewvaSessionCompactionCutPointOptions<TEntry>,
): KeepableEntry<TEntry>[] {
  const isKeepable = options.isKeepableEntry ?? defaultIsKeepableEntry;
  return branchEntries.flatMap((entry, index) => {
    if (!isKeepable(entry)) {
      return [];
    }
    const tokenCount = normalizeTokenCount(
      options.estimateEntryTokens?.(entry, index) ?? estimateBrewvaSessionEntryTokens(entry),
    );
    return [
      {
        entry,
        index,
        tokenCount,
        role: readRole(entry),
      },
    ];
  });
}

function groupKeepableTurns<TEntry extends BrewvaSessionCompactionEntryLike>(
  keepable: readonly KeepableEntry<TEntry>[],
): TurnGroup<TEntry>[] {
  const groups: TurnGroup<TEntry>[] = [];
  let current: KeepableEntry<TEntry>[] = [];
  for (const item of keepable) {
    if (item.role === "user" && current.length > 0) {
      groups.push({
        entries: current,
        tokenCount: current.reduce((sum, entry) => sum + entry.tokenCount, 0),
      });
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) {
    groups.push({
      entries: current,
      tokenCount: current.reduce((sum, entry) => sum + entry.tokenCount, 0),
    });
  }
  return groups;
}

function clampToPreviousFirstKept<TEntry extends BrewvaSessionCompactionEntryLike>(
  selected: TurnGroup<TEntry>[],
  keepable: readonly KeepableEntry<TEntry>[],
  previousFirstKeptEntryId: string | null | undefined,
): TurnGroup<TEntry>[] {
  if (!previousFirstKeptEntryId || selected.length === 0) {
    return selected;
  }
  const previous = keepable.find((item) => item.entry.id === previousFirstKeptEntryId);
  if (!previous) {
    return selected;
  }
  const firstSelected = selected[0]?.entries[0];
  if (!firstSelected || firstSelected.index >= previous.index) {
    return selected;
  }
  const containingGroupIndex = selected.findIndex((group) =>
    group.entries.some((entry) => entry.entry.id === previousFirstKeptEntryId),
  );
  if (containingGroupIndex >= 0) {
    return selected.slice(containingGroupIndex);
  }
  const firstGroupAfterPreviousIndex = selected.findIndex(
    (group) => (group.entries[0]?.index ?? -1) >= previous.index,
  );
  if (firstGroupAfterPreviousIndex >= 0) {
    return selected.slice(firstGroupAfterPreviousIndex);
  }
  return selected;
}

export function selectBrewvaSessionCompactionCutPoint<
  TEntry extends BrewvaSessionCompactionEntryLike,
>(
  branchEntries: readonly TEntry[],
  options: BrewvaSessionCompactionCutPointOptions<TEntry>,
): BrewvaSessionCompactionCutPoint | null {
  const keepable = collectKeepableEntries(branchEntries, options);
  if (keepable.length === 0) {
    return null;
  }
  const groups = groupKeepableTurns(keepable);
  const budget = effectiveTailBudget(options);
  const selected: TurnGroup<TEntry>[] = [];
  let tokensKept = 0;
  let oversizedActiveTurn = false;

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    const wouldKeep = tokensKept + group.tokenCount;
    if (selected.length === 0 || wouldKeep <= budget) {
      selected.unshift(group);
      tokensKept = wouldKeep;
      if (selected.length === 1 && group.tokenCount > budget) {
        oversizedActiveTurn = true;
      }
      continue;
    }
    break;
  }

  const finalGroups = clampToPreviousFirstKept(
    selected,
    keepable,
    options.previousFirstKeptEntryId,
  );
  const first = finalGroups[0]?.entries[0];
  if (!first) {
    return null;
  }
  const finalTokensKept = finalGroups.reduce((sum, group) => sum + group.tokenCount, 0);
  const totalTokens = keepable.reduce((sum, entry) => sum + entry.tokenCount, 0);

  return {
    firstKeptEntryId: first.entry.id,
    firstKeptIndex: first.index,
    tokensKept: finalTokensKept,
    tokensBefore: Math.max(0, totalTokens - finalTokensKept),
    turnPrefixSummaryRequired: oversizedActiveTurn,
    reason: oversizedActiveTurn
      ? "oversized_active_turn"
      : first.index === keepable[0]?.index
        ? "minimum_tail"
        : "tail_budget",
  };
}
