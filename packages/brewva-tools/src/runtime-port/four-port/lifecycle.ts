import type { SessionLifecycleSnapshot } from "@brewva/brewva-vocabulary/session";
import type { BrewvaToolRuntimeCapabilitiesPort } from "../../contracts/index.js";
import { openToolCalls } from "./tooling.js";
import type { FourPortRuntimeCapabilityContext } from "./types.js";

/**
 * The recovery family a session is actively blocked in, or `null` when it is not
 * mid-wait. A turn that suspends commits `runtime.suspended` and halts, leaving
 * that commit as the session's latest event until it resumes; the suspend cause
 * names the family the turn is waiting on. Surfacing this on the snapshot's
 * recovery posture is what lets posture-aware consumers (transient outbound
 * reduction) observe an active recovery/approval wait — without it the wait is
 * invisible and the posture gate never fires. `terminal_commit` is a normal
 * end-of-turn commit, not a live wait, so it maps to no pending family.
 */
function pendingRecoveryFamily(suspendedCause: string | null): "recovery" | "approval" | null {
  switch (suspendedCause) {
    case "approval_pending":
      return "approval";
    case "compaction_required":
    case "provider_retry":
    case "interrupt":
      return "recovery";
    default:
      return null;
  }
}

export function createFourPortLifecycleRuntimeOps(
  context: FourPortRuntimeCapabilityContext,
): BrewvaToolRuntimeCapabilitiesPort["lifecycle"] {
  return {
    getSnapshot(sessionId): SessionLifecycleSnapshot {
      const turnState = context.runtime.tape.project(sessionId, "turn_state");
      const recovery = context.runtime.tape.project(sessionId, "recovery_history");
      const latestCause = recovery.causes.at(-1) ?? null;
      const openCalls = openToolCalls(context.runtime, sessionId);
      // Treat the recovery cause as a *live* wait only while the suspend commit is
      // still the session's latest event, i.e. the turn has not resumed past it.
      const suspendedCause =
        turnState.lastEvent?.type === "runtime.suspended" ? turnState.lastCause : null;
      const pendingFamily = pendingRecoveryFamily(suspendedCause);
      return {
        sessionId,
        hydration: "fresh",
        execution: turnState.active
          ? { kind: "running", detail: "runtime_turn_active" }
          : { kind: "idle" },
        integrity: "ok",
        recovery: {
          mode: latestCause ? "observed" : "idle",
          latestReason: latestCause,
          latestStatus: pendingFamily ? "entered" : latestCause ? "recorded" : null,
          pendingFamily,
          degradedReason: null,
          duplicateSideEffectSuppressionCount: 0,
          latestSourceEventId: turnState.lastEvent?.id ?? null,
          latestSourceEventType: turnState.lastEvent?.type ?? null,
          recentTransitions: recovery.causes,
        },
        approval: {
          status: "idle",
          pendingCount: 0,
          requestId: null,
          toolCallId: null,
          toolName: null,
          subject: null,
        },
        tooling: {
          openToolCalls: openCalls,
        },
        summary: {
          kind: turnState.active ? "running" : "idle",
          reason: latestCause,
          detail: turnState.lastEvent?.type ?? null,
        },
      };
    },
  };
}
