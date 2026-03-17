import {
  createCognitiveMetricsLifecycle,
  type CognitiveMetricsLifecycle,
} from "@brewva/brewva-deliberation";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { getBrewvaToolSurface } from "@brewva/brewva-tools";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export { createCognitiveMetricsLifecycle, type CognitiveMetricsLifecycle };

export function registerCognitiveMetrics(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const hooks = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createCognitiveMetricsLifecycle(runtime, {
    resolveToolSurface: getBrewvaToolSurface,
  });
  hooks.on("session_start", lifecycle.sessionStart);
  hooks.on("turn_start", lifecycle.turnStart);
  hooks.on("before_agent_start", lifecycle.beforeAgentStart);
  hooks.on("tool_result", lifecycle.toolResult);
  hooks.on("tool_execution_end", lifecycle.toolExecutionEnd);
  hooks.on("session_shutdown", lifecycle.sessionShutdown);
}
