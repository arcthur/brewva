import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildLifecycleRuntimeOps(
  _ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["lifecycle"] {
  return {
    getSnapshot(sessionId) {
      return {
        sessionId,
        hydration: "fresh",
        execution: { kind: "idle" },
        integrity: "ok",
        recovery: {
          mode: "idle",
          latestReason: null,
          latestStatus: null,
          pendingFamily: null,
          degradedReason: null,
          duplicateSideEffectSuppressionCount: 0,
          latestSourceEventId: null,
          latestSourceEventType: null,
          recentTransitions: [],
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
          openToolCalls: [],
        },
        summary: {
          kind: "idle",
          reason: null,
          detail: null,
        },
      };
    },
  };
}
