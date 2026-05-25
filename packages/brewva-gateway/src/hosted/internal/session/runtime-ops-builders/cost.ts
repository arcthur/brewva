import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildCostRuntimeOps(ctx: HostedRuntimeOpsContext): HostedRuntimeOpsPort["cost"] {
  return {
    summary: {
      get: () => ctx.emptyCostSummary,
    },
    usage: {
      recordAssistant(inputValue: { sessionId?: string; payload?: object }) {
        ctx.emit(inputValue.sessionId ?? "default", "cost.observed", inputValue.payload);
        return ctx.emptyCostSummary;
      },
    },
  };
}
