import type { RenderTurnConsequenceDigestOptions } from "@brewva/brewva-vocabulary/iteration";
import {
  deriveTurnEffectCommitmentProjection,
  renderTurnConsequenceDigest,
} from "../runtime-consequence-digest.js";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort, RuntimeEventRecord } from "../runtime-ops-port.js";

export function buildEventsRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["events"] {
  return {
    recordMetricObservation: ctx.recordSessionPayload("iteration.metric.observed"),
    recordGuardResult: ctx.recordSessionPayload("iteration.guard.recorded"),
    records: {
      listSessionIds: () => ctx.sessionIds(),
      list: (sessionId, query) => ctx.listEvents(sessionId, query),
      query: (sessionId, query) => ctx.queryEvents(sessionId, query),
      queryStructured: (sessionId, query) => ctx.queryStructuredEvents(sessionId, query),
      toStructured: (event: RuntimeEventRecord) => ctx.structuredEvent(event),
      subscribe(listener) {
        ctx.state.subscribers.add(listener);
        return () => ctx.state.subscribers.delete(listener);
      },
    },
    replay: {
      listSessions: (limit) => ctx.listReplaySessions(limit),
    },
    effects: {
      renderTurnDigest: (_sessionId: string, value: RenderTurnConsequenceDigestOptions = {}) =>
        renderTurnConsequenceDigest(value),
      getTurnProjection: (_sessionId: string, value: RenderTurnConsequenceDigestOptions = {}) =>
        deriveTurnEffectCommitmentProjection(value),
    },
    iteration: {
      listGuardResults: () => [],
      listMetricObservations: () => [],
    },
  };
}
