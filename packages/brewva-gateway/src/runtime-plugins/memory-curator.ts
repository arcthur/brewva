import {
  createMemoryCuratorLifecycle,
  type MemoryCuratorLifecycle,
} from "@brewva/brewva-deliberation";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTurnLifecycleAdapter } from "./turn-lifecycle-adapter.js";
export { createMemoryCuratorLifecycle, type MemoryCuratorLifecycle };

export function registerMemoryCurator(pi: ExtensionAPI, runtime: BrewvaRuntime): void {
  const lifecycle = createMemoryCuratorLifecycle(runtime);
  registerTurnLifecycleAdapter(pi, {
    beforeAgentStart: [lifecycle.beforeAgentStart],
    sessionShutdown: [lifecycle.sessionShutdown],
  });
}
