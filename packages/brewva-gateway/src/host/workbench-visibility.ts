import { parseWorkbenchEvictionSpanRef, type WorkbenchEntry } from "@brewva/brewva-runtime";
import type { BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import type { BrewvaSessionEntry } from "@brewva/brewva-substrate/session";
import type { BrewvaTurnLoopMessage } from "@brewva/brewva-substrate/turn";

interface WorkbenchEvictionIndex {
  refs: Set<string>;
  reasonsByRef: Map<string, string>;
}

interface VisibilityDetails {
  workbenchEviction?: {
    spanRefs: string[];
    reasons: string[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSpanRef(ref: string): string | null {
  return parseWorkbenchEvictionSpanRef(ref)?.normalized ?? null;
}

function turnRefMatches(value: string, turn: number | undefined): boolean {
  if (turn === undefined || !Number.isFinite(turn)) {
    return false;
  }
  const normalizedTurn = Math.max(0, Math.trunc(turn));
  const range = /^(\d+)\.\.(\d+)$/u.exec(value);
  if (range) {
    const start = Number(range[1]);
    const end = Number(range[2]);
    return normalizedTurn >= Math.min(start, end) && normalizedTurn <= Math.max(start, end);
  }
  return Number(value) === normalizedTurn;
}

function createEvictionIndex(entries: readonly WorkbenchEntry[]): WorkbenchEvictionIndex {
  const refs = new Set<string>();
  const reasonsByRef = new Map<string, string>();
  for (const entry of entries) {
    if (entry.kind !== "eviction") {
      continue;
    }
    for (const sourceRef of entry.sourceRefs) {
      const normalized = normalizeSpanRef(sourceRef);
      if (!normalized) {
        continue;
      }
      refs.add(normalized);
      reasonsByRef.set(normalized, entry.reason);
    }
  }
  return { refs, reasonsByRef };
}

function collectDetailsRefs(details: unknown): string[] {
  if (!isRecord(details)) {
    return [];
  }
  const refs: string[] = [];
  for (const key of ["eventId", "sourceEventId"]) {
    const value = details[key];
    if (typeof value === "string" && value.trim().length > 0) {
      refs.push(`event:${value.trim()}`);
    }
  }
  for (const key of ["entryId", "sourceEntryId"]) {
    const value = details[key];
    if (typeof value === "string" && value.trim().length > 0) {
      refs.push(`entry:${value.trim()}`);
    }
  }
  for (const key of ["turn", "turnIndex"]) {
    const value = details[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      refs.push(`turn:${Math.trunc(value)}`);
    }
  }
  return refs;
}

function collectMessageRefs(message: BrewvaTurnLoopMessage, index: number): string[] {
  const refs = [`message:${index + 1}`, ...collectDetailsRefs(message.details)];
  if (message.role === "toolResult") {
    refs.push(`tool:${message.toolCallId}`, `tool:${message.toolName}`);
    refs.push(`tool:${message.toolName}:${message.toolCallId}`);
  }
  return refs;
}

function collectSessionEntryRefs(input: {
  entry: BrewvaSessionEntry;
  sourceEvent?: BrewvaEventRecord;
  index: number;
}): string[] {
  const refs = [`entry:${input.entry.id}`, `message:${input.index + 1}`];
  if (input.sourceEvent) {
    refs.push(`event:${input.sourceEvent.id}`);
    if (typeof input.sourceEvent.turn === "number" && Number.isFinite(input.sourceEvent.turn)) {
      refs.push(`turn:${Math.trunc(input.sourceEvent.turn)}`);
    }
  }
  if (input.entry.type === "message") {
    refs.push(...collectMessageRefs(input.entry.message as BrewvaTurnLoopMessage, input.index));
  }
  return refs;
}

function matchingEvictionRefs(input: {
  candidateRefs: readonly string[];
  evictionIndex: WorkbenchEvictionIndex;
  turn?: number;
}): string[] {
  const matched = new Set<string>();
  for (const candidate of input.candidateRefs) {
    const normalized = normalizeSpanRef(candidate);
    if (normalized && input.evictionIndex.refs.has(normalized)) {
      matched.add(normalized);
    }
  }
  if (input.turn !== undefined) {
    for (const ref of input.evictionIndex.refs) {
      const parsed = parseWorkbenchEvictionSpanRef(ref);
      if (parsed?.prefix === "turn" && turnRefMatches(parsed.value, input.turn)) {
        matched.add(parsed.normalized);
      }
    }
  }
  return [...matched].toSorted((left, right) => left.localeCompare(right));
}

function mergeVisibilityDetails(
  details: unknown,
  matchedRefs: readonly string[],
  evictionIndex: WorkbenchEvictionIndex,
): unknown {
  const base = isRecord(details) ? { ...details } : {};
  const reasons = [
    ...new Set(
      matchedRefs
        .map((ref) => evictionIndex.reasonsByRef.get(ref))
        .filter((reason): reason is string => Boolean(reason)),
    ),
  ];
  return {
    ...base,
    workbenchEviction: {
      spanRefs: [...matchedRefs],
      reasons,
    } satisfies VisibilityDetails["workbenchEviction"],
  };
}

export function applyWorkbenchEvictionsToMessages(input: {
  messages: readonly BrewvaTurnLoopMessage[];
  workbenchEntries: readonly WorkbenchEntry[];
}): {
  messages: BrewvaTurnLoopMessage[];
  excludedCount: number;
  appliedSpanRefs: string[];
} {
  const evictionIndex = createEvictionIndex(input.workbenchEntries);
  if (evictionIndex.refs.size === 0) {
    return {
      messages: [...input.messages],
      excludedCount: 0,
      appliedSpanRefs: [],
    };
  }

  const applied = new Set<string>();
  let excludedCount = 0;
  const messages = input.messages.map((message, index) => {
    const matchedRefs = matchingEvictionRefs({
      candidateRefs: collectMessageRefs(message, index),
      evictionIndex,
    });
    if (matchedRefs.length === 0) {
      return message;
    }
    for (const ref of matchedRefs) {
      applied.add(ref);
    }
    excludedCount += message.excludeFromContext === true ? 0 : 1;
    return {
      ...message,
      excludeFromContext: true,
      details: mergeVisibilityDetails(message.details, matchedRefs, evictionIndex),
    };
  });
  return {
    messages,
    excludedCount,
    appliedSpanRefs: [...applied].toSorted((left, right) => left.localeCompare(right)),
  };
}

export function shouldExcludeSessionEntryForWorkbench(input: {
  entry: BrewvaSessionEntry;
  sourceEvent?: BrewvaEventRecord;
  index: number;
  workbenchEntries: readonly WorkbenchEntry[];
}): boolean {
  const evictionIndex = createEvictionIndex(input.workbenchEntries);
  if (evictionIndex.refs.size === 0) {
    return false;
  }
  const matchedRefs = matchingEvictionRefs({
    candidateRefs: collectSessionEntryRefs(input),
    evictionIndex,
    turn: input.sourceEvent?.turn,
  });
  return matchedRefs.length > 0;
}
