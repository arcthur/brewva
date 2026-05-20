import { createBrewvaRuntime, type BrewvaConfig, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { CollectSessionPromptOutputSession } from "../turn-adapter/collect-output.js";
import {
  canCreateHostedRuntimeExecutionPorts,
  createHostedRuntimeProviderPort,
  createHostedRuntimeToolAuthorityResolver,
  createHostedRuntimeToolExecutorPort,
} from "../turn-adapter/runtime-turn-execution-ports.js";
import type { HostedRuntimeAdapterPort } from "./runtime-ports.js";

const SESSION_RUNTIMES = new WeakMap<CollectSessionPromptOutputSession, BrewvaRuntime>();

function cloneRuntimeConfigForHostedTurn(runtime: {
  readonly config: BrewvaRuntime["config"];
}): BrewvaConfig {
  return structuredClone(runtime.config) as BrewvaConfig;
}

export function canResolveHostedRuntimeTurnRuntime(
  session: CollectSessionPromptOutputSession,
  _prompt?: unknown,
): boolean {
  return canCreateHostedRuntimeExecutionPorts(session);
}

export async function resolveHostedRuntimeTurnRuntime(input: {
  session: CollectSessionPromptOutputSession;
  runtime: {
    readonly identity: BrewvaRuntime["identity"];
    readonly config: BrewvaRuntime["config"];
    readonly bindTurnPorts?: HostedRuntimeAdapterPort["bindTurnPorts"];
  };
}): Promise<BrewvaRuntime> {
  const existing = SESSION_RUNTIMES.get(input.session);
  if (existing) {
    return existing;
  }
  const provider = createHostedRuntimeProviderPort(input.session);
  const toolExecutor = createHostedRuntimeToolExecutorPort(input.session);
  const resolveToolAuthority = createHostedRuntimeToolAuthorityResolver(input.session, {
    actionAdmissionOverrides: input.runtime.config.security.actionAdmissionOverrides,
  });
  const runtime =
    input.runtime.bindTurnPorts?.({ provider, toolExecutor, resolveToolAuthority }) ??
    createBrewvaRuntime({
      cwd: input.runtime.identity.cwd,
      agentId: input.runtime.identity.agentId,
      config: cloneRuntimeConfigForHostedTurn(input.runtime),
      provider,
      toolExecutor,
      resolveToolAuthority,
    });
  await runtime.start();
  SESSION_RUNTIMES.set(input.session, runtime);
  return runtime;
}
