import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import {
  getRuntimeCostSummary,
  getRuntimeTaskState,
  type HostedRuntimeAdapterPort,
} from "../../session/runtime-ports.js";

function buildActionableNotification(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): string | undefined {
  const budget = getRuntimeCostSummary(runtime, sessionId).budget;
  if (budget.blocked) {
    return "Brewva: cost budget is blocking tools in this session.";
  }

  const blockers = getRuntimeTaskState(runtime, sessionId).blockers;
  if (blockers.length > 0) {
    return `Brewva: ${blockers.length} unresolved blocker(s) remain.`;
  }

  return undefined;
}

export interface NotificationLifecycle {
  agentEnd: (event: unknown, ctx: unknown) => undefined;
}

export function createNotificationLifecycle(
  runtime: HostedRuntimeAdapterPort,
): NotificationLifecycle {
  return {
    agentEnd(_event, ctx) {
      if (!(ctx as { hasUI?: boolean }).hasUI) return undefined;
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      const message = buildActionableNotification(runtime, sessionId);
      if (!message) return undefined;
      (ctx as { ui: { notify: (message: string, level: string) => void } }).ui.notify(
        message,
        "warning",
      );
      return undefined;
    },
  };
}

export function registerNotification(
  extensionApi: InternalHostPluginApi,
  runtime: HostedRuntimeAdapterPort,
): void {
  const hooks = extensionApi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createNotificationLifecycle(runtime);
  hooks.on("agent_end", lifecycle.agentEnd);
}
