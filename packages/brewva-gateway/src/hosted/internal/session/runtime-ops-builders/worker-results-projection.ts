import type { WorkerResult } from "@brewva/brewva-vocabulary/delegation";
import { type HostedRuntimeOpsContext, readStringArrayRecord } from "../runtime-ops-context.js";

/**
 * Rebuild worker results from durable `worker.result.*` tape events by replaying
 * the same record/clear semantics the live builder applies. The in-process Map
 * is a droppable cache over this projection: after a restart it starts empty and
 * is rehydrated here, so subagent results recorded by a prior process survive.
 */
function projectWorkerResultsFromTape(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): WorkerResult[] {
  let results: WorkerResult[] = [];
  for (const event of ctx.listEvents(sessionId)) {
    if (event.type === "worker.result.recorded") {
      const payload = event.payload;
      const value =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as { value?: unknown }).value
          : undefined;
      if (value !== undefined) {
        results.push(value as WorkerResult);
      }
      continue;
    }
    if (event.type === "worker.results.cleared") {
      const workerIds = readStringArrayRecord(event.payload, "workerIds");
      const selected = new Set(workerIds);
      results =
        selected.size === 0
          ? []
          : results.filter((result, index) => {
              const record = result && typeof result === "object" ? result : {};
              const workerId =
                typeof record.workerId === "string" ? record.workerId : `worker_${index + 1}`;
              return !selected.has(workerId);
            });
    }
  }
  return results;
}

export function workerResultsFor(ctx: HostedRuntimeOpsContext, sessionId: string): WorkerResult[] {
  const cached = ctx.state.workerResults.get(sessionId);
  if (cached !== undefined) {
    return cached;
  }
  const rebuilt = projectWorkerResultsFromTape(ctx, sessionId);
  ctx.state.workerResults.set(sessionId, rebuilt);
  return rebuilt;
}
