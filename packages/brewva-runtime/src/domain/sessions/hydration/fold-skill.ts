import type { SessionHydrationFold, SkillHydrationState } from "./fold.js";

export const SESSION_HYDRATION_SKILL_TURN_LIFECYCLE_PLACEMENT = {
  foldId: "session_hydration_skill",
  source: "packages/brewva-runtime/src/domain/sessions/hydration/fold-skill.ts",
  observes: ["admission_resolved", "execution_recorded", "recovery_settled", "terminal_recorded"],
  role: "hydrate",
} as const;

export function createSkillHydrationFold(): SessionHydrationFold<SkillHydrationState> {
  return {
    domain: "skill",
    initial(cell) {
      return {
        turn: cell.turn,
        toolCalls: cell.toolCalls,
        toolContractWarnings: new Set(cell.toolContractWarnings),
        governanceMetadataWarnings: new Set(cell.governanceMetadataWarnings),
      };
    },
    fold(state, event) {
      if (typeof event.turn === "number" && Number.isFinite(event.turn)) {
        state.turn = Math.max(state.turn, Math.floor(event.turn));
      }
    },
    apply(state, cell) {
      cell.turn = state.turn;
      cell.toolCalls = state.toolCalls;
      cell.toolContractWarnings = state.toolContractWarnings;
      cell.governanceMetadataWarnings = state.governanceMetadataWarnings;
    },
  };
}
