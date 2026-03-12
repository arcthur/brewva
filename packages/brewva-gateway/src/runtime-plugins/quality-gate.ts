import { coerceContextBudgetUsage, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface QualityGateLifecycle {
  toolCall: (event: unknown, ctx: unknown) => unknown;
  input: (event: unknown, ctx: unknown) => unknown;
}

export function createQualityGateLifecycle(runtime: BrewvaRuntime): QualityGateLifecycle {
  const normalizeField = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    if (value == null) {
      return "";
    }
    return JSON.stringify(value);
  };

  return {
    toolCall(event, ctx) {
      const rawEvent = event as { toolCallId?: unknown; toolName?: unknown; input?: unknown };
      const sessionId = (
        ctx as { sessionManager: { getSessionId: () => string } }
      ).sessionManager.getSessionId();
      const usage = coerceContextBudgetUsage(
        typeof (ctx as { getContextUsage?: () => unknown }).getContextUsage === "function"
          ? (ctx as { getContextUsage: () => unknown }).getContextUsage()
          : undefined,
      );
      const started = runtime.tools.start({
        sessionId,
        toolCallId: normalizeField(rawEvent.toolCallId),
        toolName: normalizeField(rawEvent.toolName),
        args:
          rawEvent.input && typeof rawEvent.input === "object"
            ? (rawEvent.input as Record<string, unknown>)
            : undefined,
        usage,
      });
      if (!started.allowed) {
        return {
          block: true,
          reason: started.reason ?? "Tool call blocked by runtime policy.",
        };
      }
      return undefined;
    },
    input(event, ctx) {
      const rawEvent = event as { text?: unknown; images?: unknown };
      const sessionId =
        ctx &&
        typeof ctx === "object" &&
        "sessionManager" in ctx &&
        (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager &&
        typeof (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager
          ?.getSessionId === "function"
          ? ((
              ctx as { sessionManager: { getSessionId: () => string } }
            ).sessionManager.getSessionId() ?? "")
          : "";
      if (sessionId.length > 0) {
        runtime.context.onUserInput(sessionId);
      }
      const text = typeof rawEvent.text === "string" ? rawEvent.text : "";
      const sanitized = runtime.context.sanitizeInput(text);
      if (sanitized === text) {
        return { action: "continue" };
      }

      return {
        action: "transform",
        text: sanitized,
        images: rawEvent.images,
      };
    },
  };
}

export function registerQualityGate(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const hooks = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createQualityGateLifecycle(runtime);
  hooks.on("tool_call", lifecycle.toolCall);
  hooks.on("input", lifecycle.input);
}
