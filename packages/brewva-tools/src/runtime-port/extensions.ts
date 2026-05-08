import type { BrewvaToolRuntime } from "../contracts/index.js";

export interface ToolRuntimeEventInput {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: object;
  timestamp?: number;
  skipTapeCheckpoint?: boolean;
}

type ToolRuntimeEventPort = {
  list?(sessionId: string, query?: unknown): unknown[];
  query?(sessionId: string, query?: unknown): unknown[];
};

type ToolRuntimeContextPort = {
  getUsageRatio?(usage: unknown): number | null;
  getCompactionInstructions?(): string;
};

type ToolRuntimeTaskPort = {
  getTargetDescriptor?(sessionId: string): unknown;
};

type ToolRuntimeAuthorityToolsPort = {
  acquireParallelSlotAsync?(
    sessionId: string,
    runId: string,
    options?: { timeoutMs?: number },
  ): Promise<{ accepted: boolean }>;
  releaseParallelSlot?(sessionId: string, runId: string): void;
};

// Tool-side runtime extensions stay explicit. Callers that need these behaviors
// must inject `runtime.extensions.tools`; tools do not rediscover raw BrewvaRuntime
// instances behind the type system.
export function recordToolRuntimeEvent(
  runtime: BrewvaToolRuntime | undefined,
  input: ToolRuntimeEventInput,
): void {
  runtime?.extensions?.tools?.recordEvent?.(input);
}

export function resolveToolRuntimeCredentialBindings(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string,
  toolName: string,
): Record<string, string> {
  if (runtime?.extensions?.tools?.resolveCredentialBindings) {
    return runtime.extensions.tools.resolveCredentialBindings(sessionId, toolName);
  }
  return {};
}

export function registerToolRuntimeClearStateListener(
  runtime: BrewvaToolRuntime | undefined,
  listener: (sessionId: string) => void,
): void {
  if (runtime?.extensions?.tools?.onClearState) {
    runtime.extensions.tools.onClearState(listener);
  }
}

export function resolveToolRuntimeEventPort(
  runtime: BrewvaToolRuntime | undefined,
): ToolRuntimeEventPort | undefined {
  return runtime?.inspect?.events;
}

export function resolveToolRuntimeTaskPort(
  runtime: BrewvaToolRuntime | undefined,
): ToolRuntimeTaskPort | undefined {
  return runtime?.inspect?.task;
}

export function resolveToolRuntimeContextPort(
  runtime: BrewvaToolRuntime | undefined,
): ToolRuntimeContextPort | undefined {
  return runtime?.inspect?.context;
}

export function resolveToolRuntimeAuthorityTools(
  runtime: BrewvaToolRuntime | undefined,
): ToolRuntimeAuthorityToolsPort | undefined {
  return runtime?.authority?.tools;
}
