import { DebugLoopController, type DebugLoopState } from "@brewva/brewva-deliberation";
import { type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveInjectionScopeId } from "./context-shared.js";
export { DebugLoopController, type DebugLoopState };

function extractSessionId(ctx: unknown): string {
  if (
    !ctx ||
    typeof ctx !== "object" ||
    !("sessionManager" in ctx) ||
    !ctx.sessionManager ||
    typeof (ctx as { sessionManager?: { getSessionId?: () => string } }).sessionManager
      ?.getSessionId !== "function"
  ) {
    return "";
  }
  return (ctx as { sessionManager: { getSessionId: () => string } }).sessionManager.getSessionId();
}

export function registerDebugLoop(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const controller = new DebugLoopController(runtime);

  pi.on("tool_call", (event, ctx) => {
    const sessionId = extractSessionId(ctx);
    if (!sessionId) return undefined;
    controller.onToolCall(
      event as { toolName?: unknown; toolCallId?: unknown; input?: unknown },
      sessionId,
      resolveInjectionScopeId(
        (ctx as { sessionManager?: { getLeafId?: () => string | null | undefined } })
          .sessionManager,
      ),
    );
    return undefined;
  });

  runtime.events.subscribe((event) => {
    controller.handleRuntimeEvent(event);
  });
}
