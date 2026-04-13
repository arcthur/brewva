import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { BrewvaHostPluginApi } from "@brewva/brewva-substrate";

function buildActionableNotification(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
): string | undefined {
  const budget = runtime.inspect.cost.getSummary(sessionId).budget;
  if (budget.blocked) {
    return "Brewva: cost budget is blocking tools in this session.";
  }

  const blockers = runtime.inspect.task.getState(sessionId).blockers;
  if (blockers.length > 0) {
    return `Brewva: ${blockers.length} unresolved blocker(s) remain.`;
  }

  return undefined;
}

export interface NotificationLifecycle {
  agentEnd: (event: unknown, ctx: unknown) => undefined;
}

export function createNotificationLifecycle(
  runtime: BrewvaHostedRuntimePort,
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
  extensionApi: BrewvaHostPluginApi,
  runtime: BrewvaHostedRuntimePort,
): void {
  const hooks = extensionApi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createNotificationLifecycle(runtime);
  hooks.on("agent_end", lifecycle.agentEnd);
}
