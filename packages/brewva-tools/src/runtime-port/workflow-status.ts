import type { BrewvaToolRuntime } from "../contracts/index.js";

export function readWorkflowStatusState(runtime: BrewvaToolRuntime, sessionId: string) {
  return {
    events: runtime.capabilities.events.records.query(sessionId),
    taskState: runtime.capabilities.task.state.get(sessionId),
    openToolCalls: runtime.capabilities.session.lifecycle.getOpenToolCalls(sessionId),
    uncleanShutdownDiagnostic:
      runtime.capabilities.session.lifecycle.getUncleanShutdownDiagnostic(sessionId),
    pendingWorkerResults: runtime.capabilities.session.workerResults.list(sessionId),
  };
}
