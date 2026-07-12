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
      const latestEventType = turnState.lastEvent?.type ?? null;
      // A live recovery wait is the turn's current posture, so it wins over the
      // still-active turn: the snapshot reads `recovering` rather than `running`,
      // which is what makes the daemon replay-seed ("restarting") and the bootstrap
      // recovering phase derivable straight off the snapshot. An approval wait, by
      // contrast, carries no tool identity or subject on this tape (only turn_state,
      // recovery_history, and tool_commitments are readable), so it keeps the active
      // `running` kind and lets `recovery.pendingFamily` carry the approval truth —
      // the approval phase is reconstructed from wire frames that do carry it.
      // The kind's legal value space is pinned by `SessionLifecycleStatusKind` at the
      // `summary`/`execution` assignment sites below, so it is inferred here rather than
      // re-spelling the literal union (which would drift from the vocabulary contract).
      const executionKind =
        pendingFamily === "recovery" ? "recovering" : turnState.active ? "running" : "idle";
      return {
        sessionId,
        execution:
          executionKind === "recovering"
            ? { kind: "recovering", reason: latestCause, detail: latestEventType }
            : executionKind === "running"
              ? { kind: "running", detail: "runtime_turn_active" }
              : { kind: "idle" },
        recovery: {
          mode: latestCause ? "observed" : "idle",
          latestReason: latestCause,
          latestStatus: pendingFamily ? "entered" : latestCause ? "recorded" : null,
          pendingFamily,
          degradedReason: null,
          duplicateSideEffectSuppressionCount: 0,
          latestSourceEventId: turnState.lastEvent?.id ?? null,
          latestSourceEventType: latestEventType,
          recentTransitions: recovery.causes,
        },
        tooling: {
          openToolCalls: openCalls,
        },
        summary: {
          kind: executionKind,
          reason: latestCause,
          detail: latestEventType,
        },
      };
    },
  };
}
