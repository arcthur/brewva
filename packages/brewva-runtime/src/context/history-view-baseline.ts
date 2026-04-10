import type {
  BrewvaEventRecord,
  HistoryViewBaselineSnapshot,
  SessionCompactionCommitInput,
} from "../contracts/index.js";
import {
  SESSION_COMPACT_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
} from "../events/event-types.js";
import { coerceReasoningRevertPayload } from "../tape/reasoning-events.js";
import { sha256 } from "../utils/hash.js";
import { estimateTokenCount } from "../utils/token.js";

const EXACT_HISTORY_MAX_TURNS = 4;

export interface HistoryViewBaselineDerivation {
  snapshot?: HistoryViewBaselineSnapshot;
  degradedReason: string | null;
  postureMode: "degraded" | "diagnostic_only" | null;
}

export interface HistoryViewBaselineDerivationOptions {
  referenceContextDigest?: string | null;
  maxBaselineTokens?: number | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value === null) return null;
  return readNumber(value);
}

function normalizeNullableString(value: unknown): string | null {
  if (value === null) return null;
  return readString(value);
}

export function coerceSessionCompactionCommitInput(
  value: unknown,
): SessionCompactionCommitInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const compactId = readString(candidate.compactId);
  const sanitizedSummary = readString(candidate.sanitizedSummary);
  const summaryDigest = readString(candidate.summaryDigest);
  const sourceTurn = readNumber(candidate.sourceTurn);
  const origin =
    candidate.origin === "extension_api" ||
    candidate.origin === "auto_compaction" ||
    candidate.origin === "hosted_recovery"
      ? candidate.origin
      : null;
  if (!compactId || !sanitizedSummary || !summaryDigest || sourceTurn === null || !origin) {
    return null;
  }
  return {
    compactId,
    sanitizedSummary,
    summaryDigest,
    sourceTurn,
    leafEntryId: normalizeNullableString(candidate.leafEntryId),
    referenceContextDigest: normalizeNullableString(candidate.referenceContextDigest),
    fromTokens: normalizeNullableNumber(candidate.fromTokens),
    toTokens: normalizeNullableNumber(candidate.toTokens),
    origin,
  };
}

export function buildHistoryViewBaselineSnapshot(
  event: BrewvaEventRecord,
): HistoryViewBaselineSnapshot | null {
  const payload = coerceSessionCompactionCommitInput(event.payload);
  if (!payload) {
    return null;
  }
  const diagnostics: string[] = [];
  const computedSummaryDigest = sha256(payload.sanitizedSummary);
  if (computedSummaryDigest !== payload.summaryDigest) {
    diagnostics.push("summary_digest_mismatch");
  }
  return {
    ...payload,
    eventId: event.id,
    timestamp: event.timestamp,
    rebuildSource: "receipt",
    diagnostics,
  };
}

function isBaselineCompatibleWithReferenceDigest(
  snapshot: HistoryViewBaselineSnapshot,
  referenceContextDigest: string | null,
): boolean {
  if (!referenceContextDigest || !snapshot.referenceContextDigest) {
    return true;
  }
  return snapshot.referenceContextDigest === referenceContextDigest;
}

function leafKey(value: string | null): string {
  return value ?? "__root__";
}

export function deriveHistoryViewBaselineFromEvents(
  events: readonly BrewvaEventRecord[],
): HistoryViewBaselineSnapshot | undefined {
  return deriveHistoryViewBaselineState(events).snapshot;
}

function normalizeTranscriptText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

function readTurnNumber(event: BrewvaEventRecord): number | null {
  return typeof event.turn === "number" && Number.isFinite(event.turn)
    ? Math.max(0, Math.floor(event.turn))
    : null;
}

interface ExactHistoryTurnRecord {
  turn: number;
  promptText: string | null;
  assistantText: string | null;
  toolOutputsCount: number;
  eventId: string;
  timestamp: number;
}

function normalizeMaxBaselineTokens(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.max(0, Math.floor(value));
  return normalized > 0 ? normalized : null;
}

function baselineFitsTokenBudget(
  snapshot: HistoryViewBaselineSnapshot,
  maxBaselineTokens: number | null,
): boolean {
  if (maxBaselineTokens === null) {
    return true;
  }
  const block = buildHistoryViewBaselineBlock(snapshot);
  if (!block) {
    return false;
  }
  return estimateTokenCount(block) <= maxBaselineTokens;
}

function buildExactHistorySnapshot(input: {
  selectedTurns: readonly ExactHistoryTurnRecord[];
  latestEventId: string;
  latestTimestamp: number;
}): HistoryViewBaselineSnapshot {
  const lines = ["[ExactHistoryBaseline]"];
  for (const turn of input.selectedTurns) {
    lines.push(`turn: ${turn.turn}`);
    if (turn.promptText) {
      lines.push(`user: ${turn.promptText}`);
    }
    if (turn.assistantText) {
      lines.push(`assistant: ${turn.assistantText}`);
    }
    if (turn.toolOutputsCount > 0) {
      lines.push(`tool_outputs: ${turn.toolOutputsCount}`);
    }
  }
  const transcript = lines.join("\n");
  const lastTurn = input.selectedTurns[input.selectedTurns.length - 1]!;
  return {
    compactId: `exact-history:${lastTurn.turn}`,
    sanitizedSummary: transcript,
    summaryDigest: sha256(transcript),
    sourceTurn: lastTurn.turn,
    leafEntryId: null,
    referenceContextDigest: null,
    fromTokens: null,
    toTokens: null,
    origin: "exact_history",
    eventId: input.latestEventId,
    timestamp: input.latestTimestamp,
    rebuildSource: "exact_history",
    diagnostics: [],
  };
}

function buildExactHistoryFallback(
  events: readonly BrewvaEventRecord[],
  options: HistoryViewBaselineDerivationOptions,
): HistoryViewBaselineDerivation {
  const turns = new Map<number, ExactHistoryTurnRecord>();
  let sawReasoningRevert = false;
  let latestTimestamp = 0;
  let latestEventId = "exact-history";

  for (const event of events) {
    if (event.type === "reasoning_revert") {
      sawReasoningRevert = true;
      continue;
    }
    const turn = readTurnNumber(event);
    if (turn === null) {
      continue;
    }
    const payload =
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    if (!payload) {
      continue;
    }
    if (
      event.type !== TURN_INPUT_RECORDED_EVENT_TYPE &&
      event.type !== TURN_RENDER_COMMITTED_EVENT_TYPE
    ) {
      continue;
    }
    const current = turns.get(turn) ?? {
      turn,
      promptText: null,
      assistantText: null,
      toolOutputsCount: 0,
      eventId: event.id,
      timestamp: event.timestamp,
    };
    if (event.type === TURN_INPUT_RECORDED_EVENT_TYPE) {
      current.promptText = normalizeTranscriptText(payload.promptText);
    } else {
      current.assistantText = normalizeTranscriptText(payload.assistantText);
      current.toolOutputsCount = Array.isArray(payload.toolOutputs)
        ? payload.toolOutputs.length
        : 0;
    }
    current.eventId = event.id;
    current.timestamp = event.timestamp;
    latestEventId = event.id;
    latestTimestamp = event.timestamp;
    turns.set(turn, current);
  }

  const orderedTurns = [...turns.values()]
    .filter(
      (turn) =>
        turn.promptText !== null || turn.assistantText !== null || turn.toolOutputsCount > 0,
    )
    .toSorted((left, right) => left.turn - right.turn);
  if (sawReasoningRevert) {
    return {
      degradedReason: "exact_history_branch_ambiguous",
      postureMode: "diagnostic_only",
    };
  }
  if (orderedTurns.length === 0) {
    return { degradedReason: null, postureMode: null };
  }
  const recentTurns = orderedTurns.slice(-EXACT_HISTORY_MAX_TURNS);
  const maxBaselineTokens = normalizeMaxBaselineTokens(options.maxBaselineTokens);
  let selectedTurns = recentTurns;
  if (maxBaselineTokens !== null) {
    let fittedTurns: ExactHistoryTurnRecord[] = [];
    for (const turn of recentTurns.toReversed()) {
      const candidateTurns = [turn, ...fittedTurns];
      const candidateSnapshot = buildExactHistorySnapshot({
        selectedTurns: candidateTurns,
        latestEventId,
        latestTimestamp,
      });
      if (!baselineFitsTokenBudget(candidateSnapshot, maxBaselineTokens)) {
        if (fittedTurns.length === 0) {
          return {
            degradedReason: "exact_history_over_budget",
            postureMode: "diagnostic_only",
          };
        }
        break;
      }
      fittedTurns = candidateTurns;
    }
    selectedTurns = fittedTurns;
  }
  if (selectedTurns.length === 0) {
    return {
      degradedReason: "exact_history_over_budget",
      postureMode: "diagnostic_only",
    };
  }
  const snapshot = buildExactHistorySnapshot({
    selectedTurns,
    latestEventId,
    latestTimestamp,
  });
  if (!baselineFitsTokenBudget(snapshot, maxBaselineTokens)) {
    return {
      degradedReason: "exact_history_over_budget",
      postureMode: "diagnostic_only",
    };
  }
  return {
    snapshot,
    degradedReason: null,
    postureMode: null,
  };
}

export function deriveHistoryViewBaselineState(
  events: readonly BrewvaEventRecord[],
  options: HistoryViewBaselineDerivationOptions = {},
): HistoryViewBaselineDerivation {
  const baselinesByLeaf = new Map<string, HistoryViewBaselineSnapshot>();
  let activeLeafKey = "__root__";
  let current: HistoryViewBaselineSnapshot | undefined;
  let latestIntegrityReason: string | null = null;
  let latestIntegrityTimestamp = -1;
  const referenceContextDigest = normalizeNullableString(options.referenceContextDigest);
  const maxBaselineTokens = normalizeMaxBaselineTokens(options.maxBaselineTokens);

  for (const event of events) {
    if (event.type === SESSION_COMPACT_EVENT_TYPE) {
      const baseline = buildHistoryViewBaselineSnapshot(event);
      if (!baseline) {
        continue;
      }
      const integrityIssue =
        baseline.diagnostics.find((item) => item === "summary_digest_mismatch") ??
        (!isBaselineCompatibleWithReferenceDigest(baseline, referenceContextDigest)
          ? "reference_context_digest_mismatch"
          : !baselineFitsTokenBudget(baseline, maxBaselineTokens)
            ? "history_view_baseline_over_budget"
            : null);
      if (integrityIssue) {
        latestIntegrityReason = integrityIssue;
        latestIntegrityTimestamp = event.timestamp;
        continue;
      }
      const key = leafKey(baseline.leafEntryId);
      baselinesByLeaf.set(key, baseline);
      activeLeafKey = key;
      current = baseline;
      continue;
    }

    if (event.type === "reasoning_revert") {
      const payload = coerceReasoningRevertPayload(event.payload);
      if (!payload) {
        continue;
      }
      activeLeafKey = leafKey(payload.targetLeafEntryId ?? null);
      current = baselinesByLeaf.get(activeLeafKey);
    }
  }

  if (current) {
    const degradeForIntegrity =
      latestIntegrityReason !== null && latestIntegrityTimestamp >= current.timestamp;
    return {
      snapshot: current,
      degradedReason: degradeForIntegrity ? latestIntegrityReason : null,
      postureMode: degradeForIntegrity ? "degraded" : null,
    };
  }

  const fallback = buildExactHistoryFallback(events, options);
  if (fallback.snapshot && latestIntegrityReason) {
    return {
      snapshot: {
        ...fallback.snapshot,
        diagnostics: [...fallback.snapshot.diagnostics, latestIntegrityReason],
      },
      degradedReason: latestIntegrityReason,
      postureMode: "degraded",
    };
  }
  if (latestIntegrityReason && !fallback.snapshot) {
    return {
      snapshot: undefined,
      degradedReason: latestIntegrityReason,
      postureMode: "diagnostic_only",
    };
  }
  return fallback;
}

export function buildHistoryViewBaselineBlock(
  snapshot: HistoryViewBaselineSnapshot | undefined,
): string | null {
  if (!snapshot) {
    return null;
  }
  return ["[HistoryViewBaseline]", snapshot.sanitizedSummary].join("\n");
}
