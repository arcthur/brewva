import type {
  BrewvaHostAgentEndEvent as AgentEndEvent,
  BrewvaHostBeforeAgentStartEvent as BeforeAgentStartEvent,
  BrewvaHostBeforeAgentStartResult,
  BrewvaHostContext as ExtensionContext,
  BrewvaHostInputEvent as InputEvent,
  BrewvaHostInputEventResult as InputEventResult,
  BrewvaHostPluginApi as ExtensionAPI,
  BrewvaHostSessionCompactEvent as SessionCompactEvent,
  BrewvaHostSessionShutdownEvent as SessionShutdownEvent,
  BrewvaHostSessionStartEvent as SessionStartEvent,
  BrewvaHostToolResultEvent as ToolResultEvent,
  BrewvaHostToolResultResult,
  BrewvaHostTurnStartEvent as TurnStartEvent,
} from "@brewva/brewva-substrate";

type MaybePromise<T> = T | Promise<T>;

type BeforeAgentStartLifecycleResult = BrewvaHostBeforeAgentStartResult;
type ToolResultLifecycleResult = BrewvaHostToolResultResult;

type BeforeAgentStartRegistrar = (
  event: "before_agent_start",
  handler: (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ) => MaybePromise<BeforeAgentStartLifecycleResult | undefined>,
) => void;

export interface TurnLifecyclePort {
  sessionStart?: (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => MaybePromise<void | undefined>;
  turnStart?: (event: TurnStartEvent, ctx: ExtensionContext) => MaybePromise<void | undefined>;
  input?: (event: InputEvent, ctx: ExtensionContext) => MaybePromise<InputEventResult | undefined>;
  beforeAgentStart?: (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ) => MaybePromise<BeforeAgentStartLifecycleResult | undefined>;
  toolResult?: (
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ) => MaybePromise<ToolResultLifecycleResult | undefined>;
  agentEnd?: (event: AgentEndEvent, ctx: ExtensionContext) => MaybePromise<void | undefined>;
  sessionCompact?: (
    event: SessionCompactEvent,
    ctx: ExtensionContext,
  ) => MaybePromise<void | undefined>;
  sessionShutdown?: (
    event: SessionShutdownEvent,
    ctx: ExtensionContext,
  ) => MaybePromise<void | undefined>;
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function mergeBeforeAgentStart(
  current: BeforeAgentStartLifecycleResult | undefined,
  next: BeforeAgentStartLifecycleResult | undefined,
): BeforeAgentStartLifecycleResult | undefined {
  if (!next) {
    return current;
  }
  return {
    ...current,
    ...next,
  };
}

function mergeToolResult(
  current: ToolResultLifecycleResult | undefined,
  next: ToolResultLifecycleResult | undefined,
): ToolResultLifecycleResult | undefined {
  if (!next) {
    return current;
  }
  return {
    ...current,
    ...next,
  };
}

function applyToolResultToEvent(
  event: ToolResultEvent,
  result: ToolResultLifecycleResult | undefined,
): ToolResultEvent {
  if (!result) {
    return event;
  }
  return {
    ...event,
    ...(result.content ? { content: result.content } : {}),
    ...(Object.prototype.hasOwnProperty.call(result, "details") ? { details: result.details } : {}),
    ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
  };
}

async function runSequential<TEvent>(
  handlers: Array<
    ((event: TEvent, ctx: ExtensionContext) => MaybePromise<void | undefined>) | undefined
  >,
  event: TEvent,
  ctx: ExtensionContext,
): Promise<void> {
  for (const handler of handlers) {
    if (!handler) {
      continue;
    }
    await handler(event, ctx);
  }
}

async function runUntilResult<TEvent, TResult>(
  handlers: Array<
    ((event: TEvent, ctx: ExtensionContext) => MaybePromise<TResult | undefined>) | undefined
  >,
  event: TEvent,
  ctx: ExtensionContext,
): Promise<TResult | undefined> {
  for (const handler of handlers) {
    if (!handler) {
      continue;
    }
    const result = handler(event, ctx);
    const resolved = isPromiseLike(result) ? await result : result;
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return undefined;
}

async function runBeforeAgentStart(
  handlers: Array<
    | ((
        event: BeforeAgentStartEvent,
        ctx: ExtensionContext,
      ) => MaybePromise<BeforeAgentStartLifecycleResult | undefined>)
    | undefined
  >,
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): Promise<BeforeAgentStartLifecycleResult | undefined> {
  let merged: BeforeAgentStartLifecycleResult | undefined;
  for (const handler of handlers) {
    if (!handler) {
      continue;
    }
    const result = handler(event, ctx);
    merged = mergeBeforeAgentStart(merged, isPromiseLike(result) ? await result : result);
  }
  return merged;
}

async function runToolResultPipeline(
  handlers: Array<
    | ((
        event: ToolResultEvent,
        ctx: ExtensionContext,
      ) => MaybePromise<ToolResultLifecycleResult | undefined>)
    | undefined
  >,
  event: ToolResultEvent,
  ctx: ExtensionContext,
): Promise<ToolResultLifecycleResult | undefined> {
  let currentEvent = event;
  let merged: ToolResultLifecycleResult | undefined;
  for (const handler of handlers) {
    if (!handler) {
      continue;
    }
    const result = handler(currentEvent, ctx);
    const resolved = isPromiseLike(result) ? await result : result;
    merged = mergeToolResult(merged, resolved);
    currentEvent = applyToolResultToEvent(currentEvent, resolved);
  }
  return merged;
}

function collectHandlers<TKey extends keyof TurnLifecyclePort>(
  ports: readonly TurnLifecyclePort[],
  key: TKey,
): Array<NonNullable<TurnLifecyclePort[TKey]>> {
  return ports
    .map((port) => port[key])
    .filter((handler): handler is NonNullable<TurnLifecyclePort[TKey]> => Boolean(handler));
}

export function registerTurnLifecyclePorts(
  extensionApi: ExtensionAPI,
  ports: readonly TurnLifecyclePort[],
): void {
  const sessionStart = collectHandlers(ports, "sessionStart");
  const turnStart = collectHandlers(ports, "turnStart");
  const input = collectHandlers(ports, "input");
  const beforeAgentStart = collectHandlers(ports, "beforeAgentStart");
  const toolResult = collectHandlers(ports, "toolResult");
  const agentEnd = collectHandlers(ports, "agentEnd");
  const sessionCompact = collectHandlers(ports, "sessionCompact");
  const sessionShutdown = collectHandlers(ports, "sessionShutdown");

  if (sessionStart.length > 0) {
    extensionApi.on("session_start", (event, ctx) => runSequential(sessionStart, event, ctx));
  }
  if (turnStart.length > 0) {
    extensionApi.on("turn_start", (event, ctx) => runSequential(turnStart, event, ctx));
  }
  if (input.length > 0) {
    extensionApi.on("input", (event, ctx) => runUntilResult(input, event, ctx));
  }
  if (beforeAgentStart.length > 0) {
    const registerBeforeAgentStart = extensionApi.on.bind(
      extensionApi,
    ) as BeforeAgentStartRegistrar;
    registerBeforeAgentStart("before_agent_start", (event, ctx) =>
      runBeforeAgentStart(beforeAgentStart, event, ctx),
    );
  }
  if (toolResult.length > 0) {
    extensionApi.on("tool_result", (event, ctx) => runToolResultPipeline(toolResult, event, ctx));
  }
  if (agentEnd.length > 0) {
    extensionApi.on("agent_end", (event, ctx) => runSequential(agentEnd, event, ctx));
  }
  if (sessionCompact.length > 0) {
    extensionApi.on("session_compact", (event, ctx) => runSequential(sessionCompact, event, ctx));
  }
  if (sessionShutdown.length > 0) {
    extensionApi.on("session_shutdown", (event, ctx) => runSequential(sessionShutdown, event, ctx));
  }
}
