import { payloadOf, type BrewvaEventRecord } from "./events.js";
import type { ProtocolRecord } from "./types/foundation.js";

export const GOAL_SCHEMA = "brewva.goal.v1" as const;

export const GOAL_STATUS_VALUES = [
  "active",
  "paused",
  "budget_limited",
  "max_turns",
  "complete",
  "blocked",
] as const;

export type GoalStatus = (typeof GOAL_STATUS_VALUES)[number];

export const GOAL_STARTED_EVENT_TYPE = "goal.started" as const;
export const GOAL_REPLACED_EVENT_TYPE = "goal.replaced" as const;
export const GOAL_PAUSED_EVENT_TYPE = "goal.paused" as const;
export const GOAL_RESUMED_EVENT_TYPE = "goal.resumed" as const;
export const GOAL_CLEARED_EVENT_TYPE = "goal.cleared" as const;
export const GOAL_COMPLETED_EVENT_TYPE = "goal.completed" as const;
export const GOAL_BLOCKED_EVENT_TYPE = "goal.blocked" as const;
export const GOAL_BLOCKER_OBSERVED_EVENT_TYPE = "goal.blocker.observed" as const;
export const GOAL_BUDGET_LIMITED_EVENT_TYPE = "goal.budget_limited" as const;
export const GOAL_MAX_TURNS_EVENT_TYPE = "goal.max_turns" as const;
export const GOAL_CONTINUED_EVENT_TYPE = "goal.continued" as const;
export const GOAL_USAGE_OBSERVED_EVENT_TYPE = "goal.usage.observed" as const;
export const GOAL_CONTINUATION_QUEUED_EVENT_TYPE = "goal.continuation.queued" as const;

export const GOAL_EVENT_TYPES = [
  GOAL_STARTED_EVENT_TYPE,
  GOAL_REPLACED_EVENT_TYPE,
  GOAL_PAUSED_EVENT_TYPE,
  GOAL_RESUMED_EVENT_TYPE,
  GOAL_CLEARED_EVENT_TYPE,
  GOAL_COMPLETED_EVENT_TYPE,
  GOAL_BLOCKED_EVENT_TYPE,
  GOAL_BLOCKER_OBSERVED_EVENT_TYPE,
  GOAL_BUDGET_LIMITED_EVENT_TYPE,
  GOAL_MAX_TURNS_EVENT_TYPE,
  GOAL_CONTINUED_EVENT_TYPE,
  GOAL_USAGE_OBSERVED_EVENT_TYPE,
  GOAL_CONTINUATION_QUEUED_EVENT_TYPE,
] as const;

export interface GoalUsage extends ProtocolRecord {
  readonly tokens: number;
  readonly elapsedMs: number;
  readonly goalTurnCount: number;
}

export interface GoalState extends ProtocolRecord {
  readonly schema: typeof GOAL_SCHEMA;
  readonly id: string;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly tokenBudget: number | null;
  readonly maxTurns: number | null;
  readonly usage: GoalUsage;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly replacementOf?: string;
  readonly pausedReason?: string;
  readonly terminalReason?: string;
  readonly terminalEvidence?: readonly string[];
  readonly blockerKey?: string;
  readonly lastLifecycleEvent?: string;
  readonly latestContinuationRef?: string;
  readonly latestCompletionEvidenceRef?: string;
  readonly latestBlockEvidenceRef?: string;
}

export interface GoalLifecycleInput extends ProtocolRecord {
  readonly objective?: string;
  readonly tokenBudget?: number | null;
  readonly maxTurns?: number | null;
  readonly reason?: string;
  readonly evidence?: readonly string[];
  readonly blockerKey?: string;
  readonly continuationId?: string;
  readonly now?: number;
  readonly turn?: number;
  readonly turnId?: string;
}

export interface GoalUpdateInput extends ProtocolRecord {
  readonly status: "complete" | "blocked";
  readonly reason?: string;
  readonly evidence?: readonly string[];
  readonly blockerKey?: string;
}

export interface GoalContinuationPayload extends ProtocolRecord {
  readonly goalId: string;
  readonly objective: string;
  readonly tokenBudget: number | null;
  readonly usage: GoalUsage;
  readonly kind: "continue" | "budget_wrap_up" | "max_turns_wrap_up";
  readonly continuationId?: string;
  readonly now?: number;
}

export type GoalCommand =
  | {
      readonly kind: "start";
      readonly objective: string;
      readonly tokenBudget: number | null;
      readonly maxTurns: number | null;
    }
  | { readonly kind: "status" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "continue" }
  | { readonly kind: "clear" };

export type GoalCommandParseResult =
  | { readonly ok: true; readonly command: GoalCommand }
  | { readonly ok: false; readonly error: string };

const DEFAULT_USAGE: GoalUsage = Object.freeze({
  tokens: 0,
  elapsedMs: 0,
  goalTurnCount: 0,
});

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0)
    : [];
}

function eventNow(event: BrewvaEventRecord, payload: ProtocolRecord): number {
  return readNumber(payload.now) ?? event.timestamp;
}

function createGoalFromPayload(
  event: BrewvaEventRecord,
  payload: ProtocolRecord,
  replacementOf?: string,
): GoalState | null {
  const objective = readString(payload.objective);
  if (!objective) {
    return null;
  }
  const now = eventNow(event, payload);
  const goalId = readString(payload.goalId) ?? `goal:${event.sessionId}:${now}`;
  const rawBudget = payload.tokenBudget;
  const parsedBudget = readNumber(rawBudget);
  const tokenBudget =
    rawBudget === null
      ? null
      : parsedBudget !== undefined
        ? Math.max(1, Math.trunc(parsedBudget))
        : null;
  const parsedMaxTurns = readNumber(payload.maxTurns);
  const maxTurns =
    parsedMaxTurns !== undefined && parsedMaxTurns > 0 ? Math.trunc(parsedMaxTurns) : null;
  return {
    schema: GOAL_SCHEMA,
    id: goalId,
    objective,
    status: "active",
    tokenBudget,
    maxTurns,
    usage: DEFAULT_USAGE,
    createdAt: now,
    updatedAt: now,
    ...(replacementOf ? { replacementOf } : {}),
    lastLifecycleEvent: event.type,
  };
}

function updateGoal(
  state: GoalState,
  patch: Partial<Omit<GoalState, "schema" | "id" | "objective" | "createdAt">>,
): GoalState {
  const usage = (patch as { readonly usage?: GoalUsage }).usage;
  return {
    ...state,
    ...patch,
    usage: usage ?? state.usage,
  };
}

function parseTokenBudget(raw: string): number | null {
  const match = /^(\d+)([kKmM])?$/u.exec(raw.trim());
  if (!match) {
    return null;
  }
  const base = Number(match[1]);
  if (!Number.isSafeInteger(base) || base <= 0) {
    return null;
  }
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const value = base * multiplier;
  return Number.isSafeInteger(value) ? value : null;
}

function parseMaxTurns(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function tokenizeCommand(input: string): string[] {
  return input
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
}

export function parseGoalCommand(input: string): GoalCommandParseResult {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "status") {
    return { ok: true, command: { kind: "status" } };
  }
  if (
    trimmed === "pause" ||
    trimmed === "resume" ||
    trimmed === "continue" ||
    trimmed === "clear"
  ) {
    return { ok: true, command: { kind: trimmed } };
  }
  if (trimmed === "statusbar") {
    return { ok: false, error: "Unsupported /goal subcommand: statusbar" };
  }

  const tokens = tokenizeCommand(trimmed);
  const usage = "Usage: /goal [--tokens <count>] [--max-turns <count>] <objective>";
  let tokenBudget: number | null = null;
  let maxTurns: number | null = null;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--tokens") {
      const rawBudget = tokens[index + 1];
      if (!rawBudget) {
        return { ok: false, error: usage };
      }
      const parsedBudget = parseTokenBudget(rawBudget);
      if (parsedBudget === null) {
        return { ok: false, error: "Invalid goal token budget." };
      }
      tokenBudget = parsedBudget;
      index += 2;
      continue;
    }
    const inlineBudget = /^--tokens=(.+)$/u.exec(token ?? "");
    if (inlineBudget?.[1]) {
      const parsedBudget = parseTokenBudget(inlineBudget[1]);
      if (parsedBudget === null) {
        return { ok: false, error: "Invalid goal token budget." };
      }
      tokenBudget = parsedBudget;
      index += 1;
      continue;
    }
    if (token === "--max-turns") {
      const rawTurns = tokens[index + 1];
      if (!rawTurns) {
        return { ok: false, error: usage };
      }
      const parsedTurns = parseMaxTurns(rawTurns);
      if (parsedTurns === null) {
        return { ok: false, error: "Invalid goal max-turns." };
      }
      maxTurns = parsedTurns;
      index += 2;
      continue;
    }
    const inlineTurns = /^--max-turns=(.+)$/u.exec(token ?? "");
    if (inlineTurns?.[1]) {
      const parsedTurns = parseMaxTurns(inlineTurns[1]);
      if (parsedTurns === null) {
        return { ok: false, error: "Invalid goal max-turns." };
      }
      maxTurns = parsedTurns;
      index += 1;
      continue;
    }
    break;
  }

  const objective = tokens.slice(index).join(" ").trim();
  if (!objective) {
    return { ok: false, error: usage };
  }
  return {
    ok: true,
    command: {
      kind: "start",
      objective,
      tokenBudget,
      maxTurns,
    },
  };
}

export function normalizeGoalBlockerKey(reason: string, evidence: readonly string[] = []): string {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .replace(/-{2,}/gu, "-");
  const reasonKey = normalize(reason) || "unknown";
  const evidenceKey = [...new Set(evidence.map(normalize).filter(Boolean))].toSorted().join("-");
  return evidenceKey ? `${reasonKey}:${evidenceKey}` : reasonKey;
}

export function foldGoalEvents(events: readonly BrewvaEventRecord[]): GoalState | null {
  let state: GoalState | null = null;
  for (const event of events) {
    if (!GOAL_EVENT_TYPES.includes(event.type as (typeof GOAL_EVENT_TYPES)[number])) {
      continue;
    }
    const payload = payloadOf(event);
    const now = eventNow(event, payload);
    switch (event.type) {
      case GOAL_STARTED_EVENT_TYPE:
        state = createGoalFromPayload(event, payload);
        break;
      case GOAL_REPLACED_EVENT_TYPE:
        state = createGoalFromPayload(
          event,
          payload,
          readString(payload.previousGoalId) ?? state?.id,
        );
        break;
      case GOAL_PAUSED_EVENT_TYPE:
        if (state) {
          state = updateGoal(state, {
            status: "paused",
            updatedAt: now,
            pausedReason: readString(payload.reason),
            lastLifecycleEvent: event.type,
          });
        }
        break;
      case GOAL_RESUMED_EVENT_TYPE:
        if (state) {
          state = updateGoal(state, {
            status: "active",
            updatedAt: now,
            pausedReason: undefined,
            lastLifecycleEvent: event.type,
          });
        }
        break;
      case GOAL_COMPLETED_EVENT_TYPE:
        if (state) {
          state = updateGoal(state, {
            status: "complete",
            updatedAt: now,
            terminalReason: readString(payload.reason),
            terminalEvidence: readStringArray(payload.evidence),
            latestCompletionEvidenceRef: readString(payload.evidenceRef) ?? event.id,
            lastLifecycleEvent: event.type,
          });
        }
        break;
      case GOAL_BLOCKED_EVENT_TYPE:
        if (state) {
          state = updateGoal(state, {
            status: "blocked",
            updatedAt: now,
            terminalReason: readString(payload.reason),
            terminalEvidence: readStringArray(payload.evidence),
            blockerKey: readString(payload.blockerKey),
            latestBlockEvidenceRef: readString(payload.evidenceRef) ?? event.id,
            lastLifecycleEvent: event.type,
          });
        }
        break;
      case GOAL_BUDGET_LIMITED_EVENT_TYPE:
        if (state) {
          state = updateGoal(state, {
            status: "budget_limited",
            updatedAt: now,
            terminalReason: readString(payload.reason) ?? "token_budget_exhausted",
            lastLifecycleEvent: event.type,
          });
        }
        break;
      case GOAL_MAX_TURNS_EVENT_TYPE:
        if (state) {
          state = updateGoal(state, {
            status: "max_turns",
            updatedAt: now,
            terminalReason: readString(payload.reason) ?? "max_turns_reached",
            lastLifecycleEvent: event.type,
          });
        }
        break;
      case GOAL_CONTINUED_EVENT_TYPE:
        if (state) {
          // `/goal continue`: resume a max_turns-terminal goal and reset the turn
          // count so the cap applies afresh. Token usage stays cumulative.
          state = updateGoal(state, {
            status: "active",
            updatedAt: now,
            terminalReason: undefined,
            usage: { ...state.usage, goalTurnCount: 0 },
            lastLifecycleEvent: event.type,
          });
        }
        break;
      case GOAL_USAGE_OBSERVED_EVENT_TYPE:
        if (state) {
          const tokens = Math.max(0, Math.trunc(readNumber(payload.tokens) ?? 0));
          const elapsedMs = Math.max(0, Math.trunc(readNumber(payload.elapsedMs) ?? 0));
          state = updateGoal(state, {
            updatedAt: now,
            usage: {
              tokens: state.usage.tokens + tokens,
              elapsedMs: state.usage.elapsedMs + elapsedMs,
              goalTurnCount: state.usage.goalTurnCount + 1,
            },
          });
        }
        break;
      case GOAL_CONTINUATION_QUEUED_EVENT_TYPE:
        if (state) {
          state = updateGoal(state, {
            updatedAt: now,
            latestContinuationRef: readString(payload.continuationId) ?? event.id,
          });
        }
        break;
      case GOAL_CLEARED_EVENT_TYPE:
        state = null;
        break;
      default:
        break;
    }
  }
  return state;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${Number((tokens / 1_000_000).toFixed(2))}m`;
  }
  if (tokens >= 1_000) {
    return `${Number((tokens / 1_000).toFixed(2))}k`;
  }
  return `${tokens}`;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

export function formatGoalUsage(usage: GoalUsage): string {
  return `${formatTokenCount(usage.tokens)} tokens, ${formatElapsed(usage.elapsedMs)}, ${usage.goalTurnCount} goal turns`;
}

export function buildGoalContinuationPayload(
  state: GoalState,
  kind: GoalContinuationPayload["kind"] = "continue",
  input: Pick<GoalContinuationPayload, "continuationId" | "now"> = {},
): GoalContinuationPayload {
  const continuationId =
    typeof input.continuationId === "string" && input.continuationId.trim()
      ? input.continuationId.trim()
      : undefined;
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : undefined;
  return {
    schema: "brewva.goal-continuation.v1",
    goalId: state.id,
    objective: state.objective,
    tokenBudget: state.tokenBudget,
    usage: state.usage,
    kind,
    ...(continuationId ? { continuationId } : {}),
    ...(now === undefined ? {} : { now }),
  };
}

export function buildGoalContinuationMessage(state: GoalState): string {
  const remaining =
    state.tokenBudget === null
      ? "unlimited"
      : String(Math.max(0, state.tokenBudget - state.usage.tokens));
  return [
    "[GoalContinuation]",
    "<untrusted_objective>",
    state.objective,
    "</untrusted_objective>",
    `usage: ${formatGoalUsage(state.usage)}`,
    `token_budget_remaining: ${remaining}`,
    "Continue working toward the active goal.",
    "Before using update_goal with status=complete, perform a completion audit against the objective and evidence.",
    "Do not mark the goal complete only because budget is low, the turn is ending, or work is being stopped.",
  ].join("\n");
}

export function buildGoalBudgetLimitMessage(state: GoalState): string {
  return [
    "[GoalBudgetLimit]",
    "<untrusted_objective>",
    state.objective,
    "</untrusted_objective>",
    `usage: ${formatGoalUsage(state.usage)}`,
    "The token budget for this goal is exhausted. Produce a concise wrap-up with current state, evidence, and next steps. Do not mark the goal complete unless the completion audit actually passes.",
  ].join("\n");
}

export function buildGoalMaxTurnsMessage(state: GoalState): string {
  return [
    "[GoalMaxTurns]",
    "<untrusted_objective>",
    state.objective,
    "</untrusted_objective>",
    `usage: ${formatGoalUsage(state.usage)}`,
    "The turn cap for this goal is reached. Produce a concise wrap-up with current state, evidence, and next steps. Do not mark the goal complete unless the completion audit actually passes. The operator can extend the goal with /goal continue.",
  ].join("\n");
}
