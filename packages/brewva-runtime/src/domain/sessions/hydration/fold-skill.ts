import {
  readSkillActivatedEventPayload,
  readSkillCompletedEventPayload,
  readSkillCompletionFailureEventPayload,
} from "../../../events/descriptors.js";
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
} from "../../../events/registry.js";
import { normalizeToolName } from "../../../utils/tool-name.js";
import type {
  ActiveSkillRuntimeState,
  SkillCompletionFailureRecord,
  SkillOutputRecord,
} from "../../skills/api.js";
import type { SessionHydrationFold, SkillHydrationState } from "./fold.js";
import { readSkillName } from "./fold.js";

export const SESSION_HYDRATION_SKILL_TURN_LIFECYCLE_PLACEMENT = {
  foldId: "session_hydration_skill",
  source: "packages/brewva-runtime/src/domain/sessions/hydration/fold-skill.ts",
  observes: ["admission_resolved", "execution_recorded", "recovery_settled", "terminal_recorded"],
  role: "hydrate",
} as const;

function readToolName(payload: Record<string, unknown> | null): string | null {
  if (!payload || typeof payload.toolName !== "string") return null;
  const normalized = normalizeToolName(payload.toolName);
  return normalized || null;
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
        const activated = readSkillActivatedEventPayload(event);
        if (activated) {
          state.activeSkill = activated.skillName;
          state.activeSkillState = buildActiveSkillState(activated.skillName, "active");
          state.latestSkillFailure = undefined;
          state.toolCalls = 0;
        }
        return;
      }

      if (event.type === SKILL_COMPLETED_EVENT_TYPE) {
        const completed = readSkillCompletedEventPayload(event);
        if (completed) {
          state.skillOutputs.set(completed.skillName, {
            skillName: completed.skillName,
            completedAt: completed.completedAt,
            outputs: completed.outputs,
            sourceEventId: event.id,
            ...(completed.semanticBindings ? { semanticBindings: completed.semanticBindings } : {}),
          });
        }
        state.activeSkill = undefined;
        state.activeSkillState = undefined;
        state.latestSkillFailure = undefined;
        state.toolCalls = 0;
        return;
      }

      if (event.type === SKILL_COMPLETION_REJECTED_EVENT_TYPE) {
        const failure = readSkillCompletionFailureEventPayload(event);
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
        const failure = readSkillCompletionFailureEventPayload(event);
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
