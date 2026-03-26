import type {
  VerificationCheckRun,
  VerificationEvidence,
  VerificationSessionState,
} from "../contracts/index.js";
import {
  TOOL_RESULT_RECORDED_EVENT_TYPE,
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

function createSnapshot(state: VerificationHydrationState): VerificationSessionState | undefined {
  if (
    state.lastWriteAt === undefined &&
    state.evidence.length === 0 &&
    Object.keys(state.checkRuns).length === 0
  ) {
    return undefined;
  }
  return {
    lastWriteAt: state.lastWriteAt,
    evidence: [...state.evidence],
    checkRuns: { ...state.checkRuns },
    denialCount: 0,
  };
}

function appendEvidence(state: VerificationHydrationState, evidence: VerificationEvidence[]): void {
  if (evidence.length === 0) {
    return;
  }
  state.evidence.push(...evidence);
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
        evidence: [],
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
        appendEvidence(state, projection.evidence);
        if (projection.checkRun) {
          setCheckRun(state, projection.checkRun.checkName, projection.checkRun.run);
        }
        return;
      }

      if (event.type === VERIFICATION_STATE_RESET_EVENT_TYPE) {
        state.lastWriteAt = undefined;
        state.evidence = [];
        state.checkRuns = {};
      }
    },
    apply(state, _cell, context) {
      applyVerificationSnapshot(context, createSnapshot(state));
    },
  };
}
