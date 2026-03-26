import type { SkillOutputRecord } from "../contracts/index.js";
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
    },
  };
}
