import type {
  ActiveSkillRuntimeState,
  OpenTurnRecord,
  OpenToolCallRecord,
  SemanticArtifactSchemaId,
  SessionUncleanShutdownReason,
  SessionUncleanShutdownDiagnostic,
  SkillCompletionFailureRecord,
  SkillOutputValidationIssue,
  SkillRepairBudgetState,
} from "../contracts/index.js";
import { asBrewvaToolCallId, asBrewvaToolName } from "../contracts/index.js";
import {
  SESSION_SHUTDOWN_EVENT_TYPE,
  SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE,
  TOOL_CALL_EVENT_TYPE,
  TOOL_EXECUTION_END_EVENT_TYPE,
  TOOL_EXECUTION_START_EVENT_TYPE,
} from "../events/event-types.js";
import type {
  SessionHydrationFold,
  ToolLifecycleHydrationState,
} from "./session-hydration-fold.js";
import { readNonNegativeNumber } from "./session-hydration-fold.js";

function readToolCallId(
  payload: Record<string, unknown> | null,
): import("../contracts/index.js").BrewvaToolCallId | null {
  if (!payload || typeof payload.toolCallId !== "string") {
    return null;
  }
  const toolCallId = payload.toolCallId.trim();
  return toolCallId.length > 0 ? asBrewvaToolCallId(toolCallId) : null;
}

function readToolName(
  payload: Record<string, unknown> | null,
): import("../contracts/index.js").BrewvaToolName | null {
  if (!payload || typeof payload.toolName !== "string") {
    return null;
  }
  const toolName = payload.toolName.trim();
  return toolName.length > 0 ? asBrewvaToolName(toolName) : null;
}

function readAttempt(payload: Record<string, unknown> | null): number | null | undefined {
  if (!payload || !Object.prototype.hasOwnProperty.call(payload, "attempt")) {
    return undefined;
  }
  if (payload.attempt === null) {
    return null;
  }
  return readNonNegativeNumber(payload.attempt);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readSkillOutputValidationIssue(value: unknown): SkillOutputValidationIssue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== "string" || typeof candidate.reason !== "string") {
    return null;
  }
  const name = candidate.name.trim();
  const reason = candidate.reason.trim();
  if (!name || !reason) {
    return null;
  }
  const schemaId =
    typeof candidate.schemaId === "string" && candidate.schemaId.trim().length > 0
      ? (candidate.schemaId.trim() as SemanticArtifactSchemaId)
      : undefined;
  return {
    name,
    reason,
    ...(schemaId ? { schemaId } : {}),
  };
}

function readRepairBudget(value: unknown): SkillRepairBudgetState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const maxAttempts = readNonNegativeNumber(candidate.maxAttempts);
  const usedAttempts = readNonNegativeNumber(candidate.usedAttempts);
  const remainingAttempts = readNonNegativeNumber(candidate.remainingAttempts);
  const maxToolCalls = readNonNegativeNumber(candidate.maxToolCalls);
  const usedToolCalls = readNonNegativeNumber(candidate.usedToolCalls);
  const remainingToolCalls = readNonNegativeNumber(candidate.remainingToolCalls);
  const tokenBudget = readNonNegativeNumber(candidate.tokenBudget);
  if (
    maxAttempts === null ||
    usedAttempts === null ||
    remainingAttempts === null ||
    maxToolCalls === null ||
    usedToolCalls === null ||
    remainingToolCalls === null ||
    tokenBudget === null
  ) {
    return null;
  }
  const enteredAtTokens = readNonNegativeNumber(candidate.enteredAtTokens) ?? undefined;
  const latestObservedTokens = readNonNegativeNumber(candidate.latestObservedTokens) ?? undefined;
  const usedTokens = readNonNegativeNumber(candidate.usedTokens) ?? undefined;
  return {
    maxAttempts,
    usedAttempts,
    remainingAttempts,
    maxToolCalls,
    usedToolCalls,
    remainingToolCalls,
    tokenBudget,
    ...(enteredAtTokens !== undefined ? { enteredAtTokens } : {}),
    ...(latestObservedTokens !== undefined ? { latestObservedTokens } : {}),
    ...(usedTokens !== undefined ? { usedTokens } : {}),
  };
}

function readLatestFailure(value: unknown): SkillCompletionFailureRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const skillName =
    typeof candidate.skillName === "string" ? candidate.skillName.trim() : undefined;
  const phase =
    candidate.phase === "repair_required" || candidate.phase === "failed_contract"
      ? candidate.phase
      : undefined;
  const repairBudget = readRepairBudget(candidate.repairBudget);
  if (!skillName || !phase || !repairBudget) {
    return undefined;
  }
  const invalid = Array.isArray(candidate.invalid)
    ? candidate.invalid
        .map((entry) => readSkillOutputValidationIssue(entry))
        .filter((entry): entry is SkillOutputValidationIssue => entry !== null)
    : [];
  return {
    skillName,
    occurredAt: readNonNegativeNumber(candidate.occurredAt) ?? 0,
    phase,
    outputKeys: readStringArray(candidate.outputKeys),
    missing: readStringArray(candidate.missing),
    invalid,
    expectedOutputs:
      candidate.expectedOutputs &&
      typeof candidate.expectedOutputs === "object" &&
      !Array.isArray(candidate.expectedOutputs)
        ? (candidate.expectedOutputs as Record<string, unknown>)
        : {},
    repairBudget,
  };
}

function readActiveSkillState(value: unknown): ActiveSkillRuntimeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const skillName =
    typeof candidate.skillName === "string" ? candidate.skillName.trim() : undefined;
  const phase =
    candidate.phase === "active" || candidate.phase === "repair_required"
      ? candidate.phase
      : undefined;
  if (!skillName || !phase) {
    return undefined;
  }
  const latestFailure = readLatestFailure(candidate.latestFailure);
  return {
    skillName,
    phase,
    ...(latestFailure ? { repairBudget: latestFailure.repairBudget, latestFailure } : {}),
  };
}

function readOpenToolCallRecord(value: unknown): OpenToolCallRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const toolCallId =
    typeof candidate.toolCallId === "string"
      ? asBrewvaToolCallId(candidate.toolCallId.trim())
      : undefined;
  const toolName =
    typeof candidate.toolName === "string"
      ? asBrewvaToolName(candidate.toolName.trim())
      : undefined;
  const openedAt = readNonNegativeNumber(candidate.openedAt);
  if (!toolCallId || !toolName || openedAt === null) {
    return null;
  }
  const turn = readNonNegativeNumber(candidate.turn) ?? undefined;
  const attempt = readAttempt(candidate);
  const eventId = typeof candidate.eventId === "string" ? candidate.eventId.trim() : undefined;
  return {
    toolCallId,
    toolName,
    openedAt,
    ...(turn !== undefined ? { turn } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(eventId ? { eventId } : {}),
  };
}

function readOpenTurnRecord(value: unknown): OpenTurnRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const turn = readNonNegativeNumber(candidate.turn);
  const startedAt = readNonNegativeNumber(candidate.startedAt);
  if (turn === null || startedAt === null) {
    return null;
  }
  const eventId = typeof candidate.eventId === "string" ? candidate.eventId.trim() : undefined;
  return {
    turn,
    startedAt,
    ...(eventId ? { eventId } : {}),
  };
}

function readUncleanShutdownReason(value: unknown): SessionUncleanShutdownReason | null {
  return value === "open_tool_calls_without_terminal_receipt" ||
    value === "open_turn_without_terminal_receipt" ||
    value === "active_skill_without_terminal_receipt"
    ? value
    : null;
}

function readUncleanShutdownDiagnostic(
  payload: Record<string, unknown> | null,
): SessionUncleanShutdownDiagnostic | undefined {
  if (!payload) {
    return undefined;
  }
  const reasons = Array.isArray(payload.reasons)
    ? payload.reasons
        .map((entry) => readUncleanShutdownReason(entry))
        .filter((entry): entry is SessionUncleanShutdownReason => entry !== null)
    : [];
  const openToolCalls = Array.isArray(payload.openToolCalls)
    ? payload.openToolCalls
        .map((entry) => readOpenToolCallRecord(entry))
        .filter((entry): entry is OpenToolCallRecord => entry !== null)
    : [];
  const openTurns = Array.isArray(payload.openTurns)
    ? payload.openTurns
        .map((entry) => readOpenTurnRecord(entry))
        .filter((entry): entry is OpenTurnRecord => entry !== null)
    : [];
  if (reasons.length === 0) {
    return undefined;
  }
  const latestEventAt = readNonNegativeNumber(payload.latestEventAt);
  return {
    detectedAt: readNonNegativeNumber(payload.detectedAt) ?? 0,
    reasons,
    openToolCalls,
    ...(openTurns.length > 0 ? { openTurns } : {}),
    ...(readActiveSkillState(payload.activeSkill)
      ? { activeSkill: readActiveSkillState(payload.activeSkill) }
      : {}),
    ...(readLatestFailure(payload.latestFailure)
      ? { latestFailure: readLatestFailure(payload.latestFailure) }
      : {}),
    ...(typeof payload.latestEventType === "string" && payload.latestEventType.trim().length > 0
      ? { latestEventType: payload.latestEventType.trim() }
      : {}),
    ...(latestEventAt !== null ? { latestEventAt } : {}),
  };
}

export function createToolLifecycleHydrationFold(): SessionHydrationFold<ToolLifecycleHydrationState> {
  return {
    domain: "tool_lifecycle",
    initial(cell) {
      return {
        openToolCalls: new Map(cell.openToolCalls),
        latestUncleanShutdownDiagnostic: cell.uncleanShutdownDiagnostic,
      };
    },
    fold(state, event) {
      state.latestEventAt = Math.max(state.latestEventAt ?? 0, event.timestamp);
      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : null;

      if (event.type === TOOL_CALL_EVENT_TYPE || event.type === TOOL_EXECUTION_START_EVENT_TYPE) {
        const toolCallId = readToolCallId(payload);
        const toolName = readToolName(payload);
        if (!toolCallId || !toolName) {
          return;
        }
        state.openToolCalls.set(toolCallId, {
          toolCallId,
          toolName,
          openedAt: event.timestamp,
          ...(typeof event.turn === "number" && Number.isFinite(event.turn)
            ? { turn: Math.max(0, Math.floor(event.turn)) }
            : {}),
          ...(readAttempt(payload) !== undefined ? { attempt: readAttempt(payload) } : {}),
          eventId: event.id,
        });
        return;
      }

      if (event.type === TOOL_EXECUTION_END_EVENT_TYPE) {
        const toolCallId = readToolCallId(payload);
        if (!toolCallId) {
          return;
        }
        state.openToolCalls.delete(toolCallId);
        return;
      }

      if (event.type === SESSION_SHUTDOWN_EVENT_TYPE) {
        state.lastSessionShutdownAt = event.timestamp;
        state.openToolCalls.clear();
        state.latestUncleanShutdownDiagnostic = undefined;
        return;
      }

      if (event.type === SESSION_UNCLEAN_SHUTDOWN_RECONCILED_EVENT_TYPE) {
        state.latestUncleanShutdownDiagnostic = readUncleanShutdownDiagnostic(payload);
      }
    },
    apply(state, cell) {
      cell.openToolCalls = state.openToolCalls;
      cell.uncleanShutdownDiagnostic = state.latestUncleanShutdownDiagnostic;
    },
  };
}
