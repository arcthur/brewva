import { sha256Hex } from "@brewva/brewva-std/hash";
import {
  readTurnInputRecordedEventPayload,
  readTurnRenderCommittedEventPayload,
} from "../../events/descriptors.js";
import {
  SESSION_COMPACT_EVENT_TYPE,
  TURN_INPUT_RECORDED_EVENT_TYPE,
  TURN_RENDER_COMMITTED_EVENT_TYPE,
} from "../../events/registry.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import { estimateTokenCount } from "../../utils/token.js";
import { coerceReasoningRevertPayload } from "../reasoning/api.js";
import { ReasoningReplayEngine } from "../tape/api.js";
import type { HistoryViewBaselineSnapshot, SessionCompactionCommitInput } from "./types.js";

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
    cacheImpact: {
      before: null,
      after: null,
      explicitEpochChanges: 1,
      prefixBytesChanged: null,
      degradedReason: null,
    },
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
  const computedSummaryDigest = sha256Hex(payload.sanitizedSummary);
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

interface LeafIntegrityState {
  reason: string;
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
  activeLeafEntryId: string | null;
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
    compactId: `exact-history:${input.activeLeafEntryId ?? "root"}:${lastTurn.turn}`,
    sanitizedSummary: transcript,
    summaryDigest: sha256Hex(transcript),
    sourceTurn: lastTurn.turn,
    leafEntryId: input.activeLeafEntryId,
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
  const validatedReasoning = buildValidatedReasoningState(events);
  let activeLeafEntryId: string | null = null;
  let branchAmbiguous = false;
  let latestTimestamp = 0;
  let latestEventId = "exact-history";

  for (const event of events) {
    if (event.type === "reasoning_checkpoint") {
      const checkpoint = event.payload as Record<string, unknown> | null;
      const checkpointId = readString(checkpoint?.checkpointId);
      const checkpointLeafEntryId = checkpointId
        ? validatedReasoning.checkpointLeafEntryIds.get(checkpointId)
        : undefined;
      if (checkpointId && checkpointLeafEntryId !== undefined) {
        activeLeafEntryId = checkpointLeafEntryId;
      }
      continue;
    }
    if (event.type === "reasoning_revert") {
      if (!validatedReasoning.acceptedRevertEventIds.has(event.id)) {
        continue;
      }
      const payload = coerceReasoningRevertPayload(event.payload);
      const targetTurn = payload
        ? validatedReasoning.checkpointTurns.get(payload.toCheckpointId)
        : undefined;
      if (!payload || targetTurn === undefined) {
        branchAmbiguous = true;
        continue;
      }
      activeLeafEntryId =
        payload.targetLeafEntryId ??
        validatedReasoning.checkpointLeafEntryIds.get(payload.toCheckpointId) ??
        null;
      latestEventId = event.id;
      latestTimestamp = event.timestamp;
      for (const turn of turns.keys()) {
        if (turn > targetTurn) {
          turns.delete(turn);
        }
      }
      continue;
    }
    const turn = readTurnNumber(event);
    if (turn === null) {
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
      current.promptText = normalizeTranscriptText(
        readTurnInputRecordedEventPayload(event)?.promptText,
      );
    } else {
      const committed = readTurnRenderCommittedEventPayload(event);
      current.assistantText = normalizeTranscriptText(committed?.assistantText);
      current.toolOutputsCount = committed?.toolOutputs.length ?? 0;
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
  if (branchAmbiguous) {
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
        activeLeafEntryId,
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
    activeLeafEntryId,
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
  const validatedReasoning = buildValidatedReasoningState(events);
  let activeLeafKey = "__root__";
  let current: HistoryViewBaselineSnapshot | undefined;
  const integrityByLeaf = new Map<string, LeafIntegrityState>();
  const referenceContextDigest = normalizeNullableString(options.referenceContextDigest);
  const maxBaselineTokens = normalizeMaxBaselineTokens(options.maxBaselineTokens);

  for (const event of events) {
    if (event.type === "reasoning_checkpoint") {
      const checkpoint = event.payload as Record<string, unknown> | null;
      const checkpointId = readString(checkpoint?.checkpointId);
      const checkpointLeafEntryId = checkpointId
        ? validatedReasoning.checkpointLeafEntryIds.get(checkpointId)
        : undefined;
      if (checkpointLeafEntryId !== undefined) {
        activeLeafKey = leafKey(checkpointLeafEntryId);
        current = baselinesByLeaf.get(activeLeafKey);
      }
      continue;
    }
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
      const key = leafKey(baseline.leafEntryId);
      if (integrityIssue) {
        integrityByLeaf.set(key, {
          reason: integrityIssue,
          timestamp: event.timestamp,
        });
        baselinesByLeaf.delete(key);
        activeLeafKey = key;
        current = undefined;
        continue;
      }
      baselinesByLeaf.set(key, baseline);
      activeLeafKey = key;
      current = baseline;
      continue;
    }

    if (event.type === "reasoning_revert") {
      if (!validatedReasoning.acceptedRevertEventIds.has(event.id)) {
        continue;
      }
      const payload = coerceReasoningRevertPayload(event.payload);
      if (!payload) {
        continue;
      }
      const targetLeafEntryId =
        payload.targetLeafEntryId ??
        validatedReasoning.checkpointLeafEntryIds.get(payload.toCheckpointId) ??
        null;
      activeLeafKey = leafKey(targetLeafEntryId);
      current = baselinesByLeaf.get(activeLeafKey) ?? {
        compactId: `reasoning-revert:${payload.revertId}`,
        sanitizedSummary: payload.continuityPacket.text,
        summaryDigest: sha256Hex(payload.continuityPacket.text),
        sourceTurn: readTurnNumber(event) ?? 0,
        leafEntryId: targetLeafEntryId,
        referenceContextDigest: null,
        fromTokens: null,
        toTokens: null,
        origin: "reasoning_revert",
        eventId: event.id,
        timestamp: event.timestamp,
        rebuildSource: "receipt",
        diagnostics: [],
      };
    }
  }

  if (current) {
    const currentIntegrity = integrityByLeaf.get(activeLeafKey) ?? null;
    const degradeForIntegrity =
      currentIntegrity !== null && currentIntegrity.timestamp >= current.timestamp;
    return {
      snapshot: current,
      degradedReason: degradeForIntegrity ? (currentIntegrity?.reason ?? null) : null,
      postureMode: degradeForIntegrity ? "degraded" : null,
    };
  }

  const fallback = buildExactHistoryFallback(events, options);
  const fallbackIntegrity = integrityByLeaf.get(activeLeafKey) ?? null;
  if (fallback.snapshot && fallbackIntegrity) {
    return {
      snapshot: {
        ...fallback.snapshot,
        diagnostics: [...fallback.snapshot.diagnostics, fallbackIntegrity.reason],
      },
      degradedReason: fallbackIntegrity.reason,
      postureMode: "degraded",
    };
  }
  if (fallbackIntegrity && !fallback.snapshot) {
    return {
      snapshot: undefined,
      degradedReason: fallbackIntegrity.reason,
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

function buildValidatedReasoningState(events: readonly BrewvaEventRecord[]): {
  checkpointTurns: ReadonlyMap<string, number>;
  checkpointLeafEntryIds: ReadonlyMap<string, string | null>;
  acceptedRevertEventIds: ReadonlySet<string>;
} {
  const sessionId = events[0]?.sessionId;
  if (!sessionId) {
    return {
      checkpointTurns: new Map<string, number>(),
      checkpointLeafEntryIds: new Map<string, string | null>(),
      acceptedRevertEventIds: new Set<string>(),
    };
  }
  const replay = new ReasoningReplayEngine({
    listEvents: () => [...events],
  });
  const state = replay.replay(sessionId);
  return {
    checkpointTurns: new Map(state.checkpoints.map((entry) => [entry.checkpointId, entry.turn])),
    checkpointLeafEntryIds: new Map(
      state.checkpoints.map((entry) => [entry.checkpointId, entry.leafEntryId ?? null]),
    ),
    acceptedRevertEventIds: new Set(state.reverts.map((entry) => entry.eventId)),
  };
}
