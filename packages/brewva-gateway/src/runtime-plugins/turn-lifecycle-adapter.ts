import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type LifecycleEvent = unknown;
type LifecycleContext = unknown;
type MaybePromise<T> = T | Promise<T>;
type ExtensionHookRegistrar = {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
};

type LifecycleHook<T = unknown> = (
  event: LifecycleEvent,
  ctx: LifecycleContext,
) => MaybePromise<T | undefined>;

export interface TurnLifecycleHandlers {
  sessionStart?: LifecycleHook;
  turnStart?: LifecycleHook;
  input?: LifecycleHook;
  context?: LifecycleHook;
  beforeAgentStart?: LifecycleHook<object>;
  toolCall?: LifecycleHook;
  toolResult?: LifecycleHook;
  toolExecutionEnd?: LifecycleHook;
  agentEnd?: LifecycleHook;
  sessionCompact?: LifecycleHook;
  sessionShutdown?: LifecycleHook;
}

export interface TurnLifecycleAdapterOptions {
  sessionStart?: LifecycleHook[];
  turnStart?: LifecycleHook[];
  input?: LifecycleHook[];
  context?: LifecycleHook[];
  beforeAgentStart?: LifecycleHook<object>[];
  toolCall?: LifecycleHook[];
  toolResult?: LifecycleHook[];
  toolExecutionEnd?: LifecycleHook[];
  agentEnd?: LifecycleHook[];
  sessionCompact?: LifecycleHook[];
  sessionShutdown?: LifecycleHook[];
}

function mergeBeforeAgentStartResult(
  current: object | undefined,
  next: unknown,
): object | undefined {
  if (!next || typeof next !== "object") {
    return current;
  }
  return {
    ...current,
    ...next,
  };
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

async function continuePipeline(
  handlers: LifecycleHook[],
  startIndex: number,
  event: LifecycleEvent,
  ctx: LifecycleContext,
  pending: Promise<unknown>,
): Promise<void> {
  await pending;
  for (let index = startIndex; index < handlers.length; index += 1) {
    await handlers[index]?.(event, ctx);
  }
}

function runPipeline(
  handlers: LifecycleHook[] | undefined,
  event: LifecycleEvent,
  ctx: LifecycleContext,
): MaybePromise<void> {
  if (!handlers || handlers.length === 0) {
    return undefined;
  }
  for (let index = 0; index < handlers.length; index += 1) {
    const result = handlers[index]?.(event, ctx);
    if (result && isPromiseLike(result)) {
      return continuePipeline(handlers, index + 1, event, ctx, result);
    }
  }
  return undefined;
}

async function continueUntilResult(
  handlers: LifecycleHook[],
  startIndex: number,
  event: LifecycleEvent,
  ctx: LifecycleContext,
  pending: Promise<unknown>,
): Promise<unknown> {
  const pendingResult = await pending;
  if (pendingResult !== undefined) {
    return pendingResult;
  }
  for (let index = startIndex; index < handlers.length; index += 1) {
    const result = handlers[index]?.(event, ctx);
    const resolved = result && isPromiseLike(result) ? await result : result;
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

function runUntilResult(
  handlers: LifecycleHook[] | undefined,
  event: LifecycleEvent,
  ctx: LifecycleContext,
): MaybePromise<unknown> {
  if (!handlers || handlers.length === 0) {
    return undefined;
  }
  for (let index = 0; index < handlers.length; index += 1) {
    const result = handlers[index]?.(event, ctx);
    if (result && isPromiseLike(result)) {
      return continueUntilResult(handlers, index + 1, event, ctx, result);
    }
    if (result !== undefined) {
      return result;
    }
  }
  return undefined;
}

async function continueBeforeAgentStart(
  handlers: LifecycleHook<object>[],
  startIndex: number,
  event: LifecycleEvent,
  ctx: LifecycleContext,
  merged: object | undefined,
  pending: Promise<object | undefined>,
): Promise<object | undefined> {
  let nextMerged = mergeBeforeAgentStartResult(merged, await pending);
  for (let index = startIndex; index < handlers.length; index += 1) {
    const result = handlers[index]?.(event, ctx);
    nextMerged = mergeBeforeAgentStartResult(
      nextMerged,
      result && isPromiseLike(result) ? await result : result,
    );
  }
  return nextMerged;
}

function runBeforeAgentStart(
  handlers: LifecycleHook<object>[] | undefined,
  event: LifecycleEvent,
  ctx: LifecycleContext,
): MaybePromise<object | undefined> {
  if (!handlers || handlers.length === 0) {
    return undefined;
  }
  let merged: object | undefined;
  for (let index = 0; index < handlers.length; index += 1) {
    const result = handlers[index]?.(event, ctx);
    if (result && isPromiseLike(result)) {
      return continueBeforeAgentStart(handlers, index + 1, event, ctx, merged, result);
    }
    merged = mergeBeforeAgentStartResult(merged, result);
  }
  return merged;
}

export function registerTurnLifecycleAdapter(
  pi: ExtensionAPI,
  options: TurnLifecycleAdapterOptions,
): void {
  const hooks = pi as unknown as ExtensionHookRegistrar;
  if (options.sessionStart?.length) {
    hooks.on("session_start", (event, ctx) => runPipeline(options.sessionStart, event, ctx));
  }

  if (options.turnStart?.length) {
    hooks.on("turn_start", (event, ctx) => runPipeline(options.turnStart, event, ctx));
  }

  if (options.input?.length) {
    hooks.on("input", (event, ctx) => runUntilResult(options.input, event, ctx) ?? undefined);
  }

  if (options.context?.length) {
    hooks.on("context", (event, ctx) => runPipeline(options.context, event, ctx));
  }

  if (options.beforeAgentStart?.length) {
    hooks.on("before_agent_start", (event, ctx) => {
      return runBeforeAgentStart(options.beforeAgentStart, event, ctx) ?? undefined;
    });
  }

  if (options.toolCall?.length) {
    hooks.on(
      "tool_call",
      (event, ctx) => runUntilResult(options.toolCall, event, ctx) ?? undefined,
    );
  }

  if (options.toolResult?.length) {
    hooks.on("tool_result", (event, ctx) => runPipeline(options.toolResult, event, ctx));
  }

  if (options.toolExecutionEnd?.length) {
    hooks.on("tool_execution_end", (event, ctx) =>
      runPipeline(options.toolExecutionEnd, event, ctx),
    );
  }

  if (options.agentEnd?.length) {
    hooks.on("agent_end", (event, ctx) => runPipeline(options.agentEnd, event, ctx));
  }

  if (options.sessionCompact?.length) {
    hooks.on("session_compact", (event, ctx) => runPipeline(options.sessionCompact, event, ctx));
  }

  if (options.sessionShutdown?.length) {
    hooks.on("session_shutdown", (event, ctx) => runPipeline(options.sessionShutdown, event, ctx));
  }
}
