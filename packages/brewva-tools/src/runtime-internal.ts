import type { BrewvaToolRuntime } from "./types.js";

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

// Tool-side internal wiring is intentionally hook-only. Callers that need these
// behaviors must inject `runtime.internal`; tools do not rediscover raw BrewvaRuntime
// instances behind the type system.
export function recordToolRuntimeEvent(
  runtime: BrewvaToolRuntime | undefined,
  input: ToolRuntimeEventInput,
): void {
  runtime?.internal?.recordEvent?.(input);
}

export function resolveToolRuntimeCredentialBindings(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string,
  toolName: string,
): Record<string, string> {
  if (runtime?.internal?.resolveCredentialBindings) {
    return runtime.internal.resolveCredentialBindings(sessionId, toolName);
  }
  return {};
}

export function resolveToolRuntimeSandboxApiKey(
  runtime: BrewvaToolRuntime | undefined,
  sessionId: string,
): string | undefined {
  if (runtime?.internal?.resolveSandboxApiKey) {
    return runtime.internal.resolveSandboxApiKey(sessionId);
  }
  return undefined;
}

export function registerToolRuntimeClearStateListener(
  runtime: BrewvaToolRuntime | undefined,
  listener: (sessionId: string) => void,
): void {
  if (runtime?.internal?.onClearState) {
    runtime.internal.onClearState(listener);
  }
}

export function appendToolRuntimeGuardedSupplementalBlocks(
  runtime: BrewvaToolRuntime,
  sessionId: string,
  blocks: readonly { familyId: string; content: string }[],
  scopeId?: string,
) {
  const internalResult = runtime.internal?.appendGuardedSupplementalBlocks?.(
    sessionId,
    blocks,
    scopeId,
  );
  if (internalResult) {
    return internalResult;
  }
  return null;
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

export function canAppendToolRuntimeGuardedSupplementalBlocks(
  runtime: BrewvaToolRuntime | undefined,
): boolean {
  const internal = runtime?.internal;
  if (!internal) return false;
  return (
    typeof Reflect.getOwnPropertyDescriptor(internal, "appendGuardedSupplementalBlocks")?.value ===
    "function"
  );
}
