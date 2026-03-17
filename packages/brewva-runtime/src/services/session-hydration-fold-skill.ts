import {
  SKILL_ROUTING_DECIDED_EVENT_TYPE,
  SKILL_ROUTING_FOLLOWED_EVENT_TYPE,
  SKILL_ROUTING_IGNORED_EVENT_TYPE,
  SKILL_ROUTING_OVERRIDDEN_EVENT_TYPE,
} from "../events/event-types.js";
import type {
  SkillChainIntent,
  SkillDispatchDecision,
  SkillOutputRecord,
  SkillSelectionBreakdownEntry,
  SkillSelectionSignal,
} from "../types.js";
import { SKILL_SELECTION_SIGNALS as SKILL_SELECTION_SIGNALS_LIST } from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type { SessionHydrationFold, SkillHydrationState } from "./session-hydration-fold.js";
import { readNonNegativeNumber, readSkillName } from "./session-hydration-fold.js";

const SKILL_SELECTION_SIGNALS = new Set<SkillSelectionSignal>(SKILL_SELECTION_SIGNALS_LIST);

function readToolName(payload: Record<string, unknown> | null): string | null {
  if (!payload || typeof payload.toolName !== "string") return null;
  const normalized = normalizeToolName(payload.toolName);
  return normalized || null;
}

function readSelectionBreakdown(value: unknown): SkillSelectionBreakdownEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    )
    .map((entry) => {
      const signal =
        typeof entry.signal === "string" &&
        SKILL_SELECTION_SIGNALS.has(entry.signal as SkillSelectionSignal)
          ? (entry.signal as SkillSelectionSignal)
          : null;
      const term =
        typeof entry.term === "string" && entry.term.trim().length > 0 ? entry.term.trim() : "";
      const delta = readFiniteNumber(entry.delta) ?? 0;
      if (!signal || !term || delta === 0) return null;
      return { signal, term, delta };
    })
    .filter((entry): entry is SkillSelectionBreakdownEntry => entry !== null);
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function readUnitIntervalNumber(value: unknown): number | null {
  const normalized = readNonNegativeNumber(value);
  if (normalized === null) return null;
  return Math.max(0, Math.min(1, normalized));
}

function readSkillOutputs(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const outputs = payload?.outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    return null;
  }
  return outputs as Record<string, unknown>;
}

function readPendingDispatch(
  payload: Record<string, unknown> | null,
  eventTurn: number | undefined,
): SkillDispatchDecision | undefined {
  if (!payload) return undefined;

  const modeCandidate = payload.mode;
  const mode = modeCandidate === "suggest" || modeCandidate === "auto" ? modeCandidate : null;
  if (!mode) return undefined;

  const primaryPayload =
    payload.primary && typeof payload.primary === "object" && !Array.isArray(payload.primary)
      ? (payload.primary as Record<string, unknown>)
      : null;
  const primaryName =
    typeof primaryPayload?.name === "string" && primaryPayload.name.trim().length > 0
      ? primaryPayload.name.trim()
      : "";
  const primaryScore = readNonNegativeNumber(primaryPayload?.score) ?? 0;
  const primaryReason =
    typeof primaryPayload?.reason === "string" && primaryPayload.reason.trim().length > 0
      ? primaryPayload.reason.trim()
      : "unknown";
  const primaryBreakdown = readSelectionBreakdown(primaryPayload?.breakdown);

  const selectedPayload = Array.isArray(payload.selected) ? payload.selected : [];
  const selected = selectedPayload
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && !Array.isArray(entry),
    )
    .map((entry) => {
      const name =
        typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : "";
      if (!name) return null;
      const score = readNonNegativeNumber(entry.score) ?? 0;
      const reason =
        typeof entry.reason === "string" && entry.reason.trim().length > 0
          ? entry.reason.trim()
          : "unknown";
      const breakdown = readSelectionBreakdown(entry.breakdown);
      return { name, score, reason, breakdown };
    })
    .filter(
      (
        entry,
      ): entry is {
        name: string;
        score: number;
        reason: string;
        breakdown: SkillSelectionBreakdownEntry[];
      } => entry !== null,
    );
  if (selected.length === 0 && primaryName) {
    selected.push({
      name: primaryName,
      score: primaryScore,
      reason: primaryReason,
      breakdown: primaryBreakdown,
    });
  }

  const chain =
    Array.isArray(payload.chain) && payload.chain.length > 0
      ? payload.chain
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : primaryName
        ? [primaryName]
        : [];
  const unresolvedConsumes = Array.isArray(payload.unresolvedConsumes)
    ? payload.unresolvedConsumes
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
  const confidence = readUnitIntervalNumber(payload.confidence) ?? 0.5;
  const reason =
    typeof payload.reason === "string" && payload.reason.trim().length > 0
      ? payload.reason.trim()
      : "unknown";

  const decisionTurnFromPayload = readNonNegativeNumber(payload.decisionTurn);
  const normalizedEventTurn =
    typeof eventTurn === "number" && Number.isFinite(eventTurn)
      ? Math.max(0, Math.floor(eventTurn))
      : 0;
  const turn =
    decisionTurnFromPayload !== null
      ? Math.max(0, Math.floor(decisionTurnFromPayload))
      : normalizedEventTurn;
  const routingOutcome =
    payload.routingOutcome === "selected" ||
    payload.routingOutcome === "empty" ||
    payload.routingOutcome === "failed"
      ? payload.routingOutcome
      : undefined;

  return {
    mode,
    primary: primaryName
      ? {
          name: primaryName,
          score: primaryScore,
          reason: primaryReason,
          breakdown: primaryBreakdown,
        }
      : null,
    selected,
    chain,
    unresolvedConsumes,
    confidence,
    reason,
    turn,
    routingOutcome,
  };
}

function readSkillChainIntent(
  payload: Record<string, unknown> | null,
): SkillChainIntent | undefined {
  if (!payload) return undefined;
  const intentPayload =
    payload.intent && typeof payload.intent === "object" && !Array.isArray(payload.intent)
      ? (payload.intent as Record<string, unknown>)
      : null;
  if (!intentPayload) return undefined;

  const id = typeof intentPayload.id === "string" ? intentPayload.id.trim() : "";
  if (!id) return undefined;
  const source =
    intentPayload.source === "dispatch" || intentPayload.source === "explicit"
      ? intentPayload.source
      : null;
  if (!source) return undefined;
  const sourceTurn = readNonNegativeNumber(intentPayload.sourceTurn) ?? 0;
  const cursor = readNonNegativeNumber(intentPayload.cursor) ?? 0;
  const status =
    intentPayload.status === "pending" ||
    intentPayload.status === "running" ||
    intentPayload.status === "paused" ||
    intentPayload.status === "completed" ||
    intentPayload.status === "failed" ||
    intentPayload.status === "cancelled"
      ? intentPayload.status
      : "pending";
  const stepsPayload = Array.isArray(intentPayload.steps) ? intentPayload.steps : [];
  const steps: SkillChainIntent["steps"] = [];
  for (const [index, entry] of stepsPayload.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const skill = typeof record.skill === "string" ? record.skill.trim() : "";
    if (!skill) continue;
    const stepId =
      typeof record.id === "string" && record.id.trim().length > 0
        ? record.id.trim()
        : `step-${index + 1}:${skill}`;
    const consumes = Array.isArray(record.consumes)
      ? record.consumes
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
    const produces = Array.isArray(record.produces)
      ? record.produces
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
    const lane =
      typeof record.lane === "string" && record.lane.trim().length > 0
        ? record.lane.trim()
        : undefined;
    const nextStep: SkillChainIntent["steps"][number] = {
      id: stepId,
      skill,
      consumes,
      produces,
    };
    if (lane) {
      nextStep.lane = lane;
    }
    steps.push(nextStep);
  }
  if (steps.length === 0) return undefined;
  const sourceEventId =
    typeof intentPayload.sourceEventId === "string" && intentPayload.sourceEventId.trim().length > 0
      ? intentPayload.sourceEventId.trim()
      : undefined;
  const unresolvedConsumes = Array.isArray(intentPayload.unresolvedConsumes)
    ? intentPayload.unresolvedConsumes
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
  const createdAt = readNonNegativeNumber(intentPayload.createdAt) ?? Date.now();
  const updatedAt = readNonNegativeNumber(intentPayload.updatedAt) ?? createdAt;
  const retries = readNonNegativeNumber(intentPayload.retries) ?? 0;
  const lastError =
    typeof intentPayload.lastError === "string" && intentPayload.lastError.trim().length > 0
      ? intentPayload.lastError.trim()
      : undefined;

  const maxCursor =
    status === "completed" || status === "failed" || status === "cancelled"
      ? steps.length
      : Math.max(0, steps.length - 1);

  return {
    id,
    source,
    sourceEventId,
    sourceTurn,
    steps,
    cursor: Math.min(cursor, maxCursor),
    status,
    unresolvedConsumes,
    createdAt,
    updatedAt,
    retries,
    lastError,
  };
}

export function createSkillHydrationFold(): SessionHydrationFold<SkillHydrationState> {
  return {
    domain: "skill",
    initial(cell) {
      return {
        turn: cell.turn,
        activeSkill: cell.activeSkill,
        toolCalls: cell.toolCalls,
        toolContractWarnings: new Set(cell.toolContractWarnings),
        governanceMetadataWarnings: new Set(cell.governanceMetadataWarnings),
        skillBudgetWarnings: new Set(cell.skillBudgetWarnings),
        skillParallelWarnings: new Set(cell.skillParallelWarnings),
        skillOutputs: new Map<string, SkillOutputRecord>(),
        pendingDispatch: cell.pendingDispatch,
        skillChainIntent: cell.skillChainIntent,
      };
    },
    fold(state, event) {
      if (typeof event.turn === "number" && Number.isFinite(event.turn)) {
        state.turn = Math.max(state.turn, Math.floor(event.turn));
      }

      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : null;

      if (event.type === "skill_activated") {
        const skillName = readSkillName(payload);
        if (skillName) {
          state.activeSkill = skillName;
          state.toolCalls = 0;
        }
        return;
      }

      if (event.type === "skill_completed") {
        const skillName = readSkillName(payload);
        const outputs = readSkillOutputs(payload);
        if (skillName && outputs) {
          state.skillOutputs.set(skillName, {
            skillName,
            completedAt: readNonNegativeNumber(payload?.completedAt) ?? event.timestamp,
            outputs,
          });
        }
        state.activeSkill = undefined;
        state.toolCalls = 0;
        return;
      }

      if (event.type === "tool_call_marked") {
        if (state.activeSkill) {
          state.toolCalls += 1;
        }
        return;
      }

      if (event.type === "tool_contract_warning") {
        const skillName = readSkillName(payload);
        const normalizedTool = readToolName(payload);
        if (skillName && normalizedTool) {
          state.toolContractWarnings.add(`${skillName}:${normalizedTool}`);
        }
        return;
      }

      if (event.type === "governance_metadata_missing") {
        const skillName = readSkillName(payload);
        const normalizedTool = readToolName(payload);
        if (skillName && normalizedTool) {
          state.governanceMetadataWarnings.add(`${skillName}:${normalizedTool}`);
        }
        return;
      }

      if (event.type === "skill_budget_warning") {
        const skillName = readSkillName(payload);
        const budget = payload?.budget;
        if (!skillName || typeof budget !== "string") return;
        if (budget === "tokens") {
          state.skillBudgetWarnings.add(`maxTokens:${skillName}`);
        } else if (budget === "tool_calls") {
          state.skillBudgetWarnings.add(`maxToolCalls:${skillName}`);
        }
        return;
      }

      if (event.type === "skill_parallel_warning") {
        const skillName = readSkillName(payload);
        if (skillName) {
          state.skillParallelWarnings.add(`maxParallel:${skillName}`);
        }
        return;
      }

      if (event.type === SKILL_ROUTING_DECIDED_EVENT_TYPE) {
        const parsed = readPendingDispatch(payload, event.turn);
        if (parsed) {
          state.pendingDispatch = parsed;
        }
        return;
      }

      if (event.type.startsWith("skill_cascade_")) {
        const parsedIntent = readSkillChainIntent(payload);
        if (parsedIntent) {
          state.skillChainIntent = parsedIntent;
        }
        return;
      }

      if (
        event.type === SKILL_ROUTING_FOLLOWED_EVENT_TYPE ||
        event.type === SKILL_ROUTING_OVERRIDDEN_EVENT_TYPE ||
        event.type === SKILL_ROUTING_IGNORED_EVENT_TYPE
      ) {
        state.pendingDispatch = undefined;
      }
    },
    apply(state, cell) {
      cell.turn = state.turn;
      cell.activeSkill = state.activeSkill;
      cell.toolCalls = state.activeSkill ? state.toolCalls : 0;
      cell.toolContractWarnings = state.toolContractWarnings;
      cell.governanceMetadataWarnings = state.governanceMetadataWarnings;
      cell.skillBudgetWarnings = state.skillBudgetWarnings;
      cell.skillParallelWarnings = state.skillParallelWarnings;
      cell.skillOutputs = state.skillOutputs;
      cell.pendingDispatch =
        state.pendingDispatch && state.pendingDispatch.mode !== "none"
          ? state.pendingDispatch
          : undefined;
      cell.skillChainIntent = state.skillChainIntent;
    },
  };
}
