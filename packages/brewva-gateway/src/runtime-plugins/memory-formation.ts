import {
  createMemoryFormationLifecycle,
  type MemoryFormationLifecycle,
} from "@brewva/brewva-deliberation";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export { createMemoryFormationLifecycle, type MemoryFormationLifecycle };

export function registerMemoryFormation(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const hooks = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createMemoryFormationLifecycle(runtime);
  hooks.on("agent_end", lifecycle.agentEnd);
  hooks.on("session_compact", lifecycle.sessionCompact);
  hooks.on("session_shutdown", lifecycle.sessionShutdown);
}
