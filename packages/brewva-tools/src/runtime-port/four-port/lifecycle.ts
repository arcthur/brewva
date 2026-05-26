import type { SessionLifecycleSnapshot } from "@brewva/brewva-vocabulary/session";
import type { BrewvaToolRuntimeCapabilitiesPort } from "../../contracts/index.js";
import { openToolCalls } from "./tooling.js";
import type { FourPortRuntimeCapabilityContext } from "./types.js";

export function createFourPortLifecycleRuntimeOps(
  context: FourPortRuntimeCapabilityContext,
): BrewvaToolRuntimeCapabilitiesPort["lifecycle"] {
  return {
    getSnapshot(sessionId): SessionLifecycleSnapshot {
      const turnState = context.runtime.tape.project(sessionId, "turn_state");
      const recovery = context.runtime.tape.project(sessionId, "recovery_history");
      const latestCause = recovery.causes.at(-1) ?? null;
      const openCalls = openToolCalls(context.runtime, sessionId);
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
          latestStatus: latestCause ? "recorded" : null,
          pendingFamily: null,
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
