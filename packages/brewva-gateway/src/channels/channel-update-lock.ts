import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";

export interface PendingUpdateReservation {
  scopeKey: string;
  turnId: string;
  conversationId: string;
  sessionId: string;
  agentId?: string;
  requestedAt: number;
}

export interface ChannelUpdateExecutionScope {
  lockKey: string;
  lockTarget: string;
}

export type ChannelUpdateLockAttempt =
  | {
      kind: "blocked";
      lockKey: string;
      lockTarget: string;
      blocked: PendingUpdateReservation;
    }
  | {
      kind: "reserved";
      lockKey: string;
      lockTarget: string;
      reservation: PendingUpdateReservation;
      release: () => void;
    };

export interface ChannelUpdateLockManager {
  tryReserve(input: {
    turn: TurnEnvelope;
    scopeKey: string;
    agentId: string;
  }): ChannelUpdateLockAttempt;
}

export function createChannelUpdateLockManager(input: {
  updateExecutionScope: ChannelUpdateExecutionScope;
}): ChannelUpdateLockManager {
  const pendingUpdateReservations = new Map<string, PendingUpdateReservation>();

  return {
    tryReserve({
      turn,
      scopeKey,
      agentId,
    }: {
      turn: TurnEnvelope;
      scopeKey: string;
      agentId: string;
    }): ChannelUpdateLockAttempt {
      const existing = pendingUpdateReservations.get(input.updateExecutionScope.lockKey);
      if (existing) {
        return {
          kind: "blocked",
          lockKey: input.updateExecutionScope.lockKey,
          lockTarget: input.updateExecutionScope.lockTarget,
          blocked: existing,
        };
      }

      const reservation: PendingUpdateReservation = {
        scopeKey,
        turnId: turn.turnId,
        conversationId: turn.conversationId,
        sessionId: turn.sessionId,
        agentId,
        requestedAt: Date.now(),
      };
      pendingUpdateReservations.set(input.updateExecutionScope.lockKey, reservation);

      return {
        kind: "reserved",
        lockKey: input.updateExecutionScope.lockKey,
        lockTarget: input.updateExecutionScope.lockTarget,
        reservation,
        release: () => {
          const current = pendingUpdateReservations.get(input.updateExecutionScope.lockKey);
          if (
            current &&
            current.turnId === reservation.turnId &&
            current.sessionId === reservation.sessionId
          ) {
            pendingUpdateReservations.delete(input.updateExecutionScope.lockKey);
          }
        },
      };
    },
  };
}
