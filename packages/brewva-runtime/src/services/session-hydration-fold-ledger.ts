import type { LedgerHydrationState, SessionHydrationFold } from "./session-hydration-fold.js";

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
