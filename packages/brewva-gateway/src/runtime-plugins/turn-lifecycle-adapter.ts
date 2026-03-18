import type { ExtensionAPI, InputEventResult } from "@mariozechner/pi-coding-agent";

type LifecycleEvent = unknown;
type LifecycleContext = unknown;
type MaybePromise<T> = T | Promise<T>;

interface BeforeAgentStartLifecycleResult {
  message?: {
    customType: string;
    content: string;
    display?: boolean;
    details?: unknown;
  };
  systemPrompt?: string;
}

interface ToolCallLifecycleResult {
  block?: boolean;
  reason?: string;
}

type BeforeAgentStartRegistrar = (
  event: "before_agent_start",
  handler: (
    event: LifecycleEvent,
    ctx: LifecycleContext,
  ) => MaybePromise<BeforeAgentStartLifecycleResult | undefined>,
) => void;
type LifecycleHook<TResult = void> = (
  event: LifecycleEvent,
  ctx: LifecycleContext,
) => MaybePromise<TResult | undefined>;

export interface TurnLifecycleHandlers {
  sessionStart?: LifecycleHook;
  turnStart?: LifecycleHook;
  input?: LifecycleHook<InputEventResult>;
  context?: LifecycleHook;
  beforeAgentStart?: LifecycleHook<BeforeAgentStartLifecycleResult>;
  toolCall?: LifecycleHook<ToolCallLifecycleResult>;
  toolResult?: LifecycleHook;
  toolExecutionEnd?: LifecycleHook;
  agentEnd?: LifecycleHook;
  sessionCompact?: LifecycleHook;
  sessionShutdown?: LifecycleHook;
}

export interface TurnLifecycleAdapterOptions {
  sessionStart?: LifecycleHook[];
  turnStart?: LifecycleHook[];
  input?: LifecycleHook<InputEventResult>[];
  context?: LifecycleHook[];
  beforeAgentStart?: LifecycleHook<BeforeAgentStartLifecycleResult>[];
  toolCall?: LifecycleHook<ToolCallLifecycleResult>[];
  toolResult?: LifecycleHook[];
  toolExecutionEnd?: LifecycleHook[];
  agentEnd?: LifecycleHook[];
  sessionCompact?: LifecycleHook[];
  sessionShutdown?: LifecycleHook[];
}

function mergeBeforeAgentStartResult(
  current: BeforeAgentStartLifecycleResult | undefined,
  next: unknown,
): BeforeAgentStartLifecycleResult | undefined {
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

async function continueUntilResult<TResult>(
  handlers: LifecycleHook<TResult>[],
  startIndex: number,
  event: LifecycleEvent,
  ctx: LifecycleContext,
  pending: Promise<TResult | undefined>,
): Promise<TResult | undefined> {
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

function runUntilResult<TResult>(
  handlers: LifecycleHook<TResult>[] | undefined,
  event: LifecycleEvent,
  ctx: LifecycleContext,
): MaybePromise<TResult | undefined> {
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
  handlers: LifecycleHook<BeforeAgentStartLifecycleResult>[],
  startIndex: number,
  event: LifecycleEvent,
  ctx: LifecycleContext,
  merged: BeforeAgentStartLifecycleResult | undefined,
  pending: Promise<BeforeAgentStartLifecycleResult | undefined>,
): Promise<BeforeAgentStartLifecycleResult | undefined> {
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
  handlers: LifecycleHook<BeforeAgentStartLifecycleResult>[] | undefined,
  event: LifecycleEvent,
  ctx: LifecycleContext,
): MaybePromise<BeforeAgentStartLifecycleResult | undefined> {
  if (!handlers || handlers.length === 0) {
    return undefined;
  }
  let merged: BeforeAgentStartLifecycleResult | undefined;
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
  if (options.sessionStart?.length) {
    pi.on("session_start", (event, ctx) => runPipeline(options.sessionStart, event, ctx));
  }

  if (options.turnStart?.length) {
    pi.on("turn_start", (event, ctx) => runPipeline(options.turnStart, event, ctx));
  }

  if (options.input?.length) {
    pi.on("input", (event, ctx) => runUntilResult(options.input, event, ctx) ?? undefined);
  }

  if (options.context?.length) {
    pi.on("context", (event, ctx) => runPipeline(options.context, event, ctx));
  }

  if (options.beforeAgentStart?.length) {
    const registerBeforeAgentStart = pi.on.bind(pi) as BeforeAgentStartRegistrar;
    registerBeforeAgentStart("before_agent_start", (event, ctx) => {
      return runBeforeAgentStart(options.beforeAgentStart, event, ctx) ?? undefined;
    });
  }

  if (options.toolCall?.length) {
    pi.on("tool_call", (event, ctx) => runUntilResult(options.toolCall, event, ctx) ?? undefined);
  }

  if (options.toolResult?.length) {
    pi.on("tool_result", (event, ctx) => runPipeline(options.toolResult, event, ctx));
  }

  if (options.toolExecutionEnd?.length) {
    pi.on("tool_execution_end", (event, ctx) => runPipeline(options.toolExecutionEnd, event, ctx));
  }

  if (options.agentEnd?.length) {
    pi.on("agent_end", (event, ctx) => runPipeline(options.agentEnd, event, ctx));
  }

  if (options.sessionCompact?.length) {
    pi.on("session_compact", (event, ctx) => runPipeline(options.sessionCompact, event, ctx));
  }

  if (options.sessionShutdown?.length) {
    pi.on("session_shutdown", (event, ctx) => runPipeline(options.sessionShutdown, event, ctx));
  }
}
