import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { CollectSessionPromptOutputSession } from "../turn-adapter/collect-output.js";
import { canCreateHostedRuntimeExecutionPorts } from "../turn-adapter/runtime-turn-execution-ports.js";
import type { HostedRuntimeAdapterPort } from "./runtime-ports.js";

export function canResolveHostedRuntimeTurnRuntime(
  session: CollectSessionPromptOutputSession,
  _prompt?: unknown,
): boolean {
  return canCreateHostedRuntimeExecutionPorts(session);
}

/**
 * Register the turn's session on the adapter's single router runtime and return
 * that runtime. This replaces the former noop-shell + per-session
 * `createRuntime` swap + module-level `SESSION_RUNTIMES` WeakMap: one
 * adapter-owned runtime whose physics routes provider/tool/authority by
 * sessionId to the registered session's ports.
 */
export async function resolveHostedRuntimeTurnRuntime(input: {
  sessionId: string;
  session: CollectSessionPromptOutputSession;
  runtime: Pick<HostedRuntimeAdapterPort, "registerTurnSession" | "runtime">;
}): Promise<BrewvaRuntime> {
  input.runtime.registerTurnSession(input.sessionId, input.session);
  await input.runtime.runtime.start();
  return input.runtime.runtime;
}
