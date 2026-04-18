import type { BrewvaEventRecord, IntegrityIssue } from "../contracts/index.js";
import type { SessionCostTracker } from "../cost/tracker.js";
import { TAPE_CHECKPOINT_EVENT_TYPE, coerceTapeCheckpointPayload } from "../tape/events.js";
import type { VerificationGate } from "../verification/gate.js";
import { createCostHydrationFold } from "./session-hydration-fold-cost.js";
import { createLedgerHydrationFold } from "./session-hydration-fold-ledger.js";
import { createResourceLeaseHydrationFold } from "./session-hydration-fold-resource-lease.js";
import { createSkillHydrationFold } from "./session-hydration-fold-skill.js";
import { createToolLifecycleHydrationFold } from "./session-hydration-fold-tool-lifecycle.js";
import { createVerificationHydrationFold } from "./session-hydration-fold-verification.js";
import {
  applySessionHydrationFold,
  type SessionHydrationApplyContext,
  type SessionHydrationFold,
  type SessionHydrationFoldCallbacks,
  type SessionHydrationFoldContext,
} from "./session-hydration-fold.js";
import type { RuntimeSessionStateCell } from "./session-state.js";

interface SessionHydrationCoordinatorOptions {
  costTracker: SessionCostTracker;
  verificationGate: VerificationGate;
}

interface SessionHydrationReplayState {
  costReplayStartIndex: number;
  checkpointTurn: number | null;
}

interface SessionHydrationFoldEntry {
  fold: SessionHydrationFold<unknown>;
  state: unknown;
}

interface SessionHydrationRun {
  issues: IntegrityIssue[];
  callbacks: SessionHydrationFoldCallbacks;
  applyContext: SessionHydrationApplyContext;
  foldEntries: SessionHydrationFoldEntry[];
}

export class SessionHydrationCoordinator {
  private static readonly hydrationFolds: SessionHydrationFold<unknown>[] = [
    createSkillHydrationFold(),
    createToolLifecycleHydrationFold(),
    createVerificationHydrationFold(),
    createResourceLeaseHydrationFold(),
    createCostHydrationFold(),
    createLedgerHydrationFold(),
  ];

  private readonly costTracker: SessionCostTracker;
  private readonly verificationGate: VerificationGate;

  constructor(options: SessionHydrationCoordinatorOptions) {
    this.costTracker = options.costTracker;
    this.verificationGate = options.verificationGate;
  }

  hydrate(input: {
    sessionId: string;
    state: RuntimeSessionStateCell;
    events: BrewvaEventRecord[];
    initialIssues: IntegrityIssue[];
  }): void {
    const replayState = this.prepareHydrationReplayState(input.sessionId, input.events);
    const hydrationRun = this.createHydrationRun(input.sessionId, input.state, input.initialIssues);
    this.replayHydrationEvents(input.sessionId, input.events, hydrationRun, replayState);
    this.applyHydrationRun(input.state, input.events, hydrationRun);
  }

  private prepareHydrationReplayState(
    sessionId: string,
    events: BrewvaEventRecord[],
  ): SessionHydrationReplayState {
    const latestCheckpoint = this.findLatestCheckpoint(events);
    const replayState: SessionHydrationReplayState = {
      costReplayStartIndex: latestCheckpoint ? latestCheckpoint.index + 1 : 0,
      checkpointTurn: latestCheckpoint ? this.normalizeTurn(latestCheckpoint.turn) : null,
    };
    if (latestCheckpoint) {
      this.costTracker.restore(
        sessionId,
        latestCheckpoint.payload.state.cost,
        latestCheckpoint.payload.state.costSkillLastTurnByName,
      );
    }
    return replayState;
  }

  private createHydrationRun(
    sessionId: string,
    state: RuntimeSessionStateCell,
    initialIssues: IntegrityIssue[],
  ): SessionHydrationRun {
    const issues: IntegrityIssue[] = initialIssues.map((issue) => ({ ...issue }));
    const callbacks = this.buildHydrationCallbacks();
    return {
      issues,
      callbacks,
      applyContext: {
        sessionId,
        callbacks,
      },
      foldEntries: SessionHydrationCoordinator.hydrationFolds.map((fold) => ({
        fold,
        state: fold.initial(state),
      })),
    };
  }

  private replayHydrationEvents(
    sessionId: string,
    events: BrewvaEventRecord[],
    hydrationRun: SessionHydrationRun,
    replayState: SessionHydrationReplayState,
  ): void {
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (!event) {
        continue;
      }
      const foldContext: SessionHydrationFoldContext = {
        sessionId,
        index,
        replayCostTail: index >= replayState.costReplayStartIndex,
        replayCheckpointTurnTransient: this.shouldReplayCheckpointTurnTransient(
          event,
          index,
          replayState,
        ),
        callbacks: hydrationRun.callbacks,
        issues: hydrationRun.issues,
      };
      for (const entry of hydrationRun.foldEntries) {
        applySessionHydrationFold(entry.fold, entry.state, event, foldContext);
      }
    }
  }

  private shouldReplayCheckpointTurnTransient(
    event: BrewvaEventRecord,
    index: number,
    replayState: SessionHydrationReplayState,
  ): boolean {
    if (index >= replayState.costReplayStartIndex || replayState.checkpointTurn === null) {
      return false;
    }
    return (
      this.normalizeTurn(event.turn) === replayState.checkpointTurn &&
      this.isCheckpointTurnCostTransientEvent(event.type)
    );
  }

  private applyHydrationRun(
    state: RuntimeSessionStateCell,
    events: BrewvaEventRecord[],
    hydrationRun: SessionHydrationRun,
  ): void {
    for (const entry of hydrationRun.foldEntries) {
      entry.fold.apply(entry.state, state, hydrationRun.applyContext);
    }
    state.hydration = {
      status: hydrationRun.issues.length > 0 ? "degraded" : "ready",
      latestEventId: events[events.length - 1]?.id,
      hydratedAt: Date.now(),
      issues: hydrationRun.issues,
    };
  }

  private buildHydrationCallbacks(): SessionHydrationFoldCallbacks {
    return {
      replayCostStateEvent: (sessionId, event, payload, options) =>
        this.replayCostStateEvent(sessionId, event, payload, options),
      restoreVerificationState: (sessionId, snapshot) => {
        this.verificationGate.stateStore.clear(sessionId);
        this.verificationGate.stateStore.restore(sessionId, snapshot);
      },
    };
  }

  private findLatestCheckpoint(events: BrewvaEventRecord[]): {
    index: number;
    turn: number;
    payload: NonNullable<ReturnType<typeof coerceTapeCheckpointPayload>>;
  } | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event || event.type !== TAPE_CHECKPOINT_EVENT_TYPE) {
        continue;
      }
      const payload = coerceTapeCheckpointPayload(event.payload);
      if (!payload) {
        continue;
      }
      return {
        index,
        turn: this.normalizeTurn(event.turn),
        payload,
      };
    }
    return null;
  }

  private isCheckpointTurnCostTransientEvent(type: string): boolean {
    return type === "tool_call_marked";
  }

  private replayCostStateEvent(
    sessionId: string,
    event: BrewvaEventRecord,
    payload: Record<string, unknown> | null,
    options?: {
      checkpointTurnTransient?: boolean;
    },
  ): void {
    const turn = this.normalizeTurn(event.turn);
    const checkpointTurnTransient = options?.checkpointTurnTransient === true;

    if (event.type === "tool_call_marked") {
      const toolName =
        payload && typeof payload.toolName === "string" ? payload.toolName.trim() : "";
      if (!toolName) {
        return;
      }
      if (checkpointTurnTransient) {
        this.costTracker.restoreToolCallForTurn(sessionId, {
          toolName,
          turn,
        });
      } else {
        this.costTracker.recordToolCall(sessionId, {
          toolName,
          turn,
        });
      }
      return;
    }

    if (event.type !== "cost_update" || !payload) {
      return;
    }
    this.costTracker.applyCostUpdateEvent(sessionId, payload, turn, event.timestamp);
  }

  private normalizeTurn(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.floor(value));
  }
}
