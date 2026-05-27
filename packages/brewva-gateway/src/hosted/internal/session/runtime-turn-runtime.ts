import { createBrewvaRuntime, type BrewvaConfig, type BrewvaRuntime } from "@brewva/brewva-runtime";
import type { CollectSessionPromptOutputSession } from "../turn-adapter/collect-output.js";
import {
  canCreateHostedRuntimeExecutionPorts,
  createHostedRuntimeProviderPort,
  createHostedRuntimeToolAuthorityResolver,
  createHostedRuntimeToolExecutorPort,
  isRuntimeAdapterSession,
} from "../turn-adapter/runtime-turn-execution-ports.js";
import { createVerificationGateRuntimeProviderPort } from "../turn-adapter/runtime-turn-verification-gates.js";
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
    readonly createRuntime?: HostedRuntimeAdapterPort["createRuntime"];
  };
}): Promise<BrewvaRuntime> {
  const existing = SESSION_RUNTIMES.get(input.session);
  if (existing) {
    return existing;
  }
  const provider = createVerificationGateRuntimeProviderPort(
    createHostedRuntimeProviderPort(input.session),
    isRuntimeAdapterSession(input.session) ? input.session : null,
  );
  const toolExecutor = createHostedRuntimeToolExecutorPort(input.session);
  const resolveToolAuthority = createHostedRuntimeToolAuthorityResolver(input.session, {
    actionAdmissionOverrides: input.runtime.config.security.actionAdmissionOverrides,
  });
  const physics = {
    mode: "real" as const,
    provider,
    toolExecutor,
    resolveToolAuthority,
  };
  const runtime =
    input.runtime.createRuntime?.({ physics }) ??
    createBrewvaRuntime({
      cwd: input.runtime.identity.cwd,
      agentId: input.runtime.identity.agentId,
      config: cloneRuntimeConfigForHostedTurn(input.runtime),
      physics,
    });
  await runtime.start();
  SESSION_RUNTIMES.set(input.session, runtime);
  return runtime;
}
