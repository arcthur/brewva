import type { LedgerHydrationState, SessionHydrationFold } from "./fold.js";

export const SESSION_HYDRATION_LEDGER_TURN_LIFECYCLE_PLACEMENT = {
  foldId: "session_hydration_ledger",
  source: "packages/brewva-runtime/src/domain/sessions/hydration/fold-ledger.ts",
  observes: ["execution_recorded", "terminal_recorded"],
  role: "hydrate",
} as const;

export function createLedgerHydrationFold(): SessionHydrationFold<LedgerHydrationState> {
  return {
    domain: "ledger",
    initial(cell) {
      return {
        lastLedgerCompactionTurn: cell.lastLedgerCompactionTurn,
      };
    },
    fold(state, event) {
      if (event.type !== "ledger_compacted") {
        return;
      }
      if (typeof event.turn !== "number" || !Number.isFinite(event.turn)) {
        return;
      }
      state.lastLedgerCompactionTurn = Math.max(0, Math.floor(event.turn));
    },
    apply(state, cell) {
      cell.lastLedgerCompactionTurn =
        typeof state.lastLedgerCompactionTurn === "number" &&
        Number.isFinite(state.lastLedgerCompactionTurn)
          ? state.lastLedgerCompactionTurn
          : undefined;
    },
  };
}
