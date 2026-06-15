import type { ParallelSlotPort } from "@brewva/brewva-vocabulary/delegation";
import {
  createParallelAdmissionController,
  type ParallelAdmissionDeps,
} from "../../../delegation/api.js";
import type { HostedRuntimeOpsContext } from "./runtime-ops-context.js";

/**
 * Wire the delegation parallel-admission controller to a hosted runtime ops
 * context. The controller (delegation domain) stays pure over a narrow
 * dependency interface; this host-side adapter supplies those dependencies from
 * the hosted ctx — replay-derived tape events for the active count, active
 * `resource_lease` budgets for the ceiling, and receipt emission onto the same
 * session tape. Crossing into the delegation domain goes through its `api.js`
 * seam, not an internal path.
 */
export function createHostedParallelAdmission(ctx: HostedRuntimeOpsContext): ParallelSlotPort {
  const deps: ParallelAdmissionDeps = {
    parallelConfig: () => ctx.runtime.config.parallel,
    queryEvents: (sessionId) => ctx.queryStructuredEvents(sessionId),
    activeLeases: (sessionId) => ctx.projections.resourceLeases(sessionId),
    emit: (sessionId, type, payload) => {
      ctx.emit(sessionId, type, payload);
    },
    now: () => ctx.clock(),
  };
  return createParallelAdmissionController(deps);
}
