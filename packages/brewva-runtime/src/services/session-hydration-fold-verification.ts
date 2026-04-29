import type { VerificationCheckRun, VerificationSessionState } from "../contracts/index.js";
import {
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_STATE_RESET_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
} from "../events/event-types.js";
import {
  coerceVerificationWriteMarkedPayload,
  readVerificationToolResultProjectionPayload,
} from "../verification/projector-payloads.js";
import type {
  SessionHydrationApplyContext,
  SessionHydrationFold,
  VerificationHydrationState,
} from "./session-hydration-fold.js";
import { readEventPayload } from "./session-hydration-fold.js";

export const SESSION_HYDRATION_VERIFICATION_TURN_LIFECYCLE_PLACEMENT = {
  foldId: "session_hydration_verification",
  source: "packages/brewva-runtime/src/services/session-hydration-fold-verification.ts",
  observes: ["execution_recorded", "recovery_settled", "terminal_recorded"],
  role: "hydrate",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function createSnapshot(state: VerificationHydrationState): VerificationSessionState | undefined {
  if (
    state.lastWriteAt === undefined &&
    Object.keys(state.checkRuns).length === 0 &&
    state.lastOutcomeAt === undefined
  ) {
    return undefined;
  }
  return {
    lastWriteAt: state.lastWriteAt,
    checkRuns: { ...state.checkRuns },
    denialCount: 0,
    lastOutcomeAt: state.lastOutcomeAt,
    lastOutcomeLevel: state.lastOutcomeLevel,
    lastOutcomePassed: state.lastOutcomePassed,
    lastOutcomeReferenceWriteAt: state.lastOutcomeReferenceWriteAt,
  };
}

function setCheckRun(
  state: VerificationHydrationState,
  checkName: string,
  run: VerificationCheckRun,
): void {
  state.checkRuns[checkName] = run;
}

function applyVerificationSnapshot(
  context: SessionHydrationApplyContext,
  snapshot: VerificationSessionState | undefined,
): void {
  context.callbacks.restoreVerificationState(context.sessionId, snapshot);
}

export function createVerificationHydrationFold(): SessionHydrationFold<VerificationHydrationState> {
  return {
    domain: "verification",
    initial() {
      return {
        checkRuns: {},
      };
    },
    fold(state, event) {
      const payload = readEventPayload(event);

      if (event.type === VERIFICATION_WRITE_MARKED_EVENT_TYPE) {
        if (!coerceVerificationWriteMarkedPayload(payload)) {
          return;
        }
        state.lastWriteAt = Math.max(0, Math.floor(event.timestamp));
        return;
      }

      if (event.type === TOOL_RESULT_RECORDED_EVENT_TYPE) {
        const projection = readVerificationToolResultProjectionPayload(
          payload?.verificationProjection,
        );
        if (!projection) {
          return;
        }
        if (projection.checkRun) {
          setCheckRun(state, projection.checkRun.checkName, projection.checkRun.run);
        }
        return;
      }

      if (event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) {
        if (!isRecord(payload)) {
          return;
        }
        const level =
          payload.level === "quick" || payload.level === "standard" || payload.level === "strict"
            ? payload.level
            : undefined;
        if (!level) {
          return;
        }
        state.lastOutcomeAt = Math.max(0, Math.floor(event.timestamp));
        state.lastOutcomeLevel = level;
        state.lastOutcomePassed = payload.outcome === "pass";
        state.lastOutcomeReferenceWriteAt =
          typeof payload.referenceWriteAt === "number" && Number.isFinite(payload.referenceWriteAt)
            ? Math.max(0, Math.floor(payload.referenceWriteAt))
            : undefined;
        return;
      }

      if (event.type === VERIFICATION_STATE_RESET_EVENT_TYPE) {
        state.lastWriteAt = undefined;
        state.checkRuns = {};
        state.lastOutcomeAt = undefined;
        state.lastOutcomeLevel = undefined;
        state.lastOutcomePassed = undefined;
        state.lastOutcomeReferenceWriteAt = undefined;
      }
    },
    apply(state, _cell, context) {
      applyVerificationSnapshot(context, createSnapshot(state));
    },
  };
}
