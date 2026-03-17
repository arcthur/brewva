import {
  createMemoryCuratorLifecycle,
  type MemoryCuratorLifecycle,
} from "@brewva/brewva-deliberation";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
export { createMemoryCuratorLifecycle, type MemoryCuratorLifecycle };

export function registerMemoryCurator(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const hooks = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createMemoryCuratorLifecycle(runtime);
  hooks.on("before_agent_start", lifecycle.beforeAgentStart);
  hooks.on("session_shutdown", lifecycle.sessionShutdown);
}
