interface RuntimeTurnClockState {
  currentTurn: number;
  lastStartTimestamp: number | null;
  lastLocalTurn: number | null;
}

export interface RuntimeTurnClockStore {
  observeTurnStart(sessionId: string, localTurnIndex: unknown, timestamp?: unknown): number;
  getCurrentTurn(sessionId: string): number;
  clearSession(sessionId: string): void;
}

function normalizeTurnIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

export function createRuntimeTurnClockStore(): RuntimeTurnClockStore {
  const turnClockBySession = new Map<string, RuntimeTurnClockState>();

  const getOrCreateState = (sessionId: string): RuntimeTurnClockState => {
    const existing = turnClockBySession.get(sessionId);
    if (existing) {
      return existing;
    }
    const created: RuntimeTurnClockState = {
      currentTurn: -1,
      lastStartTimestamp: null,
      lastLocalTurn: null,
    };
    turnClockBySession.set(sessionId, created);
    return created;
  };

  return {
    observeTurnStart(sessionId, localTurnIndex, timestamp) {
      const state = getOrCreateState(sessionId);
      const normalizedLocalTurn = normalizeTurnIndex(localTurnIndex);
      const normalizedTimestamp = normalizeTimestamp(timestamp);

      const isDuplicateByTimestamp =
        normalizedTimestamp !== null &&
        state.lastStartTimestamp === normalizedTimestamp &&
        state.lastLocalTurn === normalizedLocalTurn &&
        state.currentTurn >= 0;
      const isDuplicateByLocalTurn =
        normalizedTimestamp === null &&
        state.lastStartTimestamp === null &&
        state.lastLocalTurn === normalizedLocalTurn &&
        state.currentTurn >= 0;

      if (!isDuplicateByTimestamp && !isDuplicateByLocalTurn) {
        state.currentTurn = state.currentTurn < 0 ? 0 : state.currentTurn + 1;
        state.lastStartTimestamp = normalizedTimestamp;
        state.lastLocalTurn = normalizedLocalTurn;
      }

      return state.currentTurn < 0 ? 0 : state.currentTurn;
    },

    getCurrentTurn(sessionId) {
      const state = turnClockBySession.get(sessionId);
      if (!state) return 0;
      return state.currentTurn < 0 ? 0 : state.currentTurn;
    },

    clearSession(sessionId) {
      turnClockBySession.delete(sessionId);
    },
  };
}
