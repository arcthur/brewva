import type {
  ActiveSkillRuntimeState,
  SemanticArtifactSchemaId,
  SkillCompletionFailureRecord,
  SkillOutputRecord,
  SkillSemanticBindings,
  SkillOutputValidationIssue,
  SkillRepairGuidance,
  SkillRepairBudgetState,
} from "../contracts/index.js";
import { isSemanticArtifactSchemaId } from "../contracts/index.js";
import {
  SKILL_ACTIVATED_EVENT_TYPE,
  SKILL_BUDGET_WARNING_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  SKILL_COMPLETION_REJECTED_EVENT_TYPE,
  SKILL_CONTRACT_FAILED_EVENT_TYPE,
  SKILL_PARALLEL_WARNING_EVENT_TYPE,
  TOOL_CALL_MARKED_EVENT_TYPE,
  TOOL_CONTRACT_WARNING_EVENT_TYPE,
  GOVERNANCE_METADATA_MISSING_EVENT_TYPE,
} from "../events/event-types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type { SessionHydrationFold, SkillHydrationState } from "./session-hydration-fold.js";
import { readNonNegativeNumber, readSkillName } from "./session-hydration-fold.js";

function readToolName(payload: Record<string, unknown> | null): string | null {
  if (!payload || typeof payload.toolName !== "string") return null;
  const normalized = normalizeToolName(payload.toolName);
  return normalized || null;
}

function readSkillOutputs(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  const outputs = payload?.outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
    return null;
  }
  return outputs as Record<string, unknown>;
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

function readSkillSemanticBindings(
  payload: Record<string, unknown> | null,
): SkillSemanticBindings | undefined {
  const candidate = payload?.semanticBindings;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return undefined;
  }
  const entries = Object.entries(candidate).flatMap(([outputName, schemaId]) => {
    const normalizedOutputName = outputName.trim();
    if (!normalizedOutputName || typeof schemaId !== "string") {
      return [];
    }
    const normalizedSchemaId = schemaId.trim();
    if (!isSemanticArtifactSchemaId(normalizedSchemaId)) {
      return [];
    }
    return [[normalizedOutputName, normalizedSchemaId] as const];
  });
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries);
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

function readExpectedOutputs(payload: Record<string, unknown> | null): Record<string, unknown> {
  const expectedOutputs = payload?.expectedOutputs;
  if (!expectedOutputs || typeof expectedOutputs !== "object" || Array.isArray(expectedOutputs)) {
    return {};
  }
  return expectedOutputs as Record<string, unknown>;
}

function readRepairGuidance(value: unknown): SkillRepairGuidance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const minimumContractState =
    typeof candidate.minimumContractState === "string" &&
    candidate.minimumContractState.trim().length > 0
      ? candidate.minimumContractState.trim()
      : undefined;
  if (!minimumContractState) {
    return undefined;
  }
  const unresolvedFields = readStringArray(candidate.unresolvedFields);
  const nextBlockingConsumer =
    typeof candidate.nextBlockingConsumer === "string" &&
    candidate.nextBlockingConsumer.trim().length > 0
      ? candidate.nextBlockingConsumer.trim()
      : undefined;
  return {
    unresolvedFields,
    minimumContractState,
    ...(nextBlockingConsumer ? { nextBlockingConsumer } : {}),
  };
}

function readCompletionFailure(
  payload: Record<string, unknown> | null,
  fallbackPhase: SkillCompletionFailureRecord["phase"],
  occurredAt: number,
): SkillCompletionFailureRecord | null {
  const skillName = readSkillName(payload);
  const repairBudget = readRepairBudget(payload?.repairBudget);
  if (!skillName || !repairBudget) {
    return null;
  }
  const phase =
    payload?.phase === "repair_required" || payload?.phase === "failed_contract"
      ? payload.phase
      : fallbackPhase;
  const invalid = Array.isArray(payload?.invalid)
    ? payload.invalid
        .map((entry) => readSkillOutputValidationIssue(entry))
        .filter((entry): entry is SkillOutputValidationIssue => entry !== null)
    : [];
  return {
    skillName,
    occurredAt: readNonNegativeNumber(payload?.occurredAt) ?? occurredAt,
    phase,
    outputKeys: readStringArray(payload?.outputKeys),
    missing: readStringArray(payload?.missing),
    invalid,
    expectedOutputs: readExpectedOutputs(payload),
    repairGuidance: readRepairGuidance(payload?.repairGuidance),
    repairBudget,
  };
}

function buildActiveSkillState(
  skillName: string,
  phase: ActiveSkillRuntimeState["phase"],
  latestFailure?: SkillCompletionFailureRecord,
): ActiveSkillRuntimeState {
  return {
    skillName,
    phase,
    ...(latestFailure ? { repairBudget: latestFailure.repairBudget, latestFailure } : {}),
  };
}

export function createSkillHydrationFold(): SessionHydrationFold<SkillHydrationState> {
  return {
    domain: "skill",
    initial(cell) {
      return {
        turn: cell.turn,
        activeSkill: cell.activeSkill,
        activeSkillState: cell.activeSkillState,
        latestSkillFailure: cell.latestSkillFailure,
        toolCalls: cell.toolCalls,
        toolContractWarnings: new Set(cell.toolContractWarnings),
        governanceMetadataWarnings: new Set(cell.governanceMetadataWarnings),
        skillBudgetWarnings: new Set(cell.skillBudgetWarnings),
        skillParallelWarnings: new Set(cell.skillParallelWarnings),
        skillOutputs: new Map<string, SkillOutputRecord>(),
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

      if (event.type === SKILL_ACTIVATED_EVENT_TYPE) {
        const skillName = readSkillName(payload);
        if (skillName) {
          state.activeSkill = skillName;
          state.activeSkillState = buildActiveSkillState(skillName, "active");
          state.latestSkillFailure = undefined;
          state.toolCalls = 0;
        }
        return;
      }

      if (event.type === SKILL_COMPLETED_EVENT_TYPE) {
        const skillName = readSkillName(payload);
        const outputs = readSkillOutputs(payload);
        const semanticBindings = readSkillSemanticBindings(payload);
        if (skillName && outputs) {
          state.skillOutputs.set(skillName, {
            skillName,
            completedAt: readNonNegativeNumber(payload?.completedAt) ?? event.timestamp,
            outputs,
            sourceEventId: event.id,
            ...(semanticBindings ? { semanticBindings } : {}),
          });
        }
        state.activeSkill = undefined;
        state.activeSkillState = undefined;
        state.latestSkillFailure = undefined;
        state.toolCalls = 0;
        return;
      }

      if (event.type === SKILL_COMPLETION_REJECTED_EVENT_TYPE) {
        const failure = readCompletionFailure(payload, "repair_required", event.timestamp);
        if (!failure) {
          return;
        }
        state.latestSkillFailure = failure;
        if (failure.phase === "repair_required") {
          state.activeSkill = failure.skillName;
          state.activeSkillState = buildActiveSkillState(
            failure.skillName,
            "repair_required",
            failure,
          );
          return;
        }
        state.activeSkill = undefined;
        state.activeSkillState = undefined;
        state.toolCalls = 0;
        return;
      }

      if (event.type === SKILL_CONTRACT_FAILED_EVENT_TYPE) {
        const failure = readCompletionFailure(payload, "failed_contract", event.timestamp);
        if (!failure) {
          return;
        }
        state.latestSkillFailure = failure;
        state.activeSkill = undefined;
        state.activeSkillState = undefined;
        state.toolCalls = 0;
        return;
      }

      if (event.type === TOOL_CALL_MARKED_EVENT_TYPE) {
        if (state.activeSkill) {
          state.toolCalls += 1;
        }
        return;
      }

      if (event.type === TOOL_CONTRACT_WARNING_EVENT_TYPE) {
        const skillName = readSkillName(payload);
        const normalizedTool = readToolName(payload);
        if (skillName && normalizedTool) {
          state.toolContractWarnings.add(`${skillName}:${normalizedTool}`);
        }
        return;
      }

      if (event.type === GOVERNANCE_METADATA_MISSING_EVENT_TYPE) {
        const skillName = readSkillName(payload);
        const normalizedTool = readToolName(payload);
        if (skillName && normalizedTool) {
          state.governanceMetadataWarnings.add(`${skillName}:${normalizedTool}`);
        }
        return;
      }

      if (event.type === SKILL_BUDGET_WARNING_EVENT_TYPE) {
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

      if (event.type === SKILL_PARALLEL_WARNING_EVENT_TYPE) {
        const skillName = readSkillName(payload);
        if (skillName) {
          state.skillParallelWarnings.add(`maxParallel:${skillName}`);
        }
      }
    },
    apply(state, cell) {
      cell.turn = state.turn;
      cell.activeSkill = state.activeSkill;
      cell.activeSkillState = state.activeSkillState;
      cell.latestSkillFailure = state.latestSkillFailure;
      cell.toolCalls = state.activeSkill ? state.toolCalls : 0;
      cell.toolContractWarnings = state.toolContractWarnings;
      cell.governanceMetadataWarnings = state.governanceMetadataWarnings;
      cell.skillBudgetWarnings = state.skillBudgetWarnings;
      cell.skillParallelWarnings = state.skillParallelWarnings;
      cell.skillOutputs = state.skillOutputs;
    },
  };
}
