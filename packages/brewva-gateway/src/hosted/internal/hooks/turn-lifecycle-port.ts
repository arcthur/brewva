import type {
  BrewvaHostAgentEndEvent as AgentEndEvent,
  BrewvaHostBeforeAgentStartEvent as BeforeAgentStartEvent,
  BrewvaHostBeforeAgentStartResult,
  BrewvaHostContext as ExtensionContext,
  BrewvaHostInputEvent as InputEvent,
  BrewvaHostInputEventResult as InputEventResult,
  InternalHostPluginApi as ExtensionAPI,
  BrewvaHostSessionCompactEvent as SessionCompactEvent,
  BrewvaHostSessionShutdownEvent as SessionShutdownEvent,
  BrewvaHostSessionStartEvent as SessionStartEvent,
  BrewvaHostTurnEndEvent as TurnEndEvent,
  BrewvaHostToolResultEvent as ToolResultEvent,
  BrewvaHostToolResultResult,
  BrewvaHostTurnStartEvent as TurnStartEvent,
} from "@brewva/brewva-substrate/host-api";

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
  turnEnd?: (event: TurnEndEvent, ctx: ExtensionContext) => MaybePromise<void | undefined>;
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

export const HOSTED_LIFECYCLE_PHASES = ["pre_model", "model_io", "post_tool", "teardown"] as const;

export type HostedLifecyclePhase = (typeof HOSTED_LIFECYCLE_PHASES)[number];

/**
 * The hosted turn-lifecycle spine, declared by coarse, ordered phase buckets
 * rather than a flat inline array (RFC: Checked Invariants And Disciplined Peer
 * Borrowing, item E).
 *
 * The phases are ORDERING TIERS, not strict lifecycle gates. A port is collected
 * once per handler type (`collectHandlers` below) and each handler fires on its own
 * event in the flattened tier order; the phase names describe where internal ports
 * typically sit, and a module may legitimately span more than one tier
 * (`contextTransform` and `toolSurface` each hold two). The `teardown` tier is
 * simply "last": external user ports live there so their handlers run after every
 * internal port of the same type. So a tier fixes relative order within each
 * handler type — it does not restrict which lifecycle events a tier's ports handle
 * (a `teardown` port may still carry a `beforeAgentStart` handler, which then runs
 * after the internal `beforeAgentStart` ports).
 */
export type HostedLifecyclePhasePorts = Readonly<
  Record<HostedLifecyclePhase, readonly TurnLifecyclePort[]>
>;

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
  const messages = [
    ...(current?.message ? [current.message] : []),
    ...(current?.messages ?? []),
    ...(next.message ? [next.message] : []),
    ...(next.messages ?? []),
  ];
  return {
    ...current,
    ...next,
    message: messages.length === 1 ? messages[0] : undefined,
    messages: messages.length > 1 ? messages : undefined,
  };
}

function applyBeforeAgentStartToEvent(
  event: BeforeAgentStartEvent,
  result: BeforeAgentStartLifecycleResult | undefined,
): BeforeAgentStartEvent {
  if (result?.systemPrompt === undefined) {
    return event;
  }
  return {
    ...event,
    systemPrompt: result.systemPrompt,
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
  let currentEvent = event;
  let merged: BeforeAgentStartLifecycleResult | undefined;
  for (const handler of handlers) {
    if (!handler) {
      continue;
    }
    const result = handler(currentEvent, ctx);
    const resolved = isPromiseLike(result) ? await result : result;
    merged = mergeBeforeAgentStart(merged, resolved);
    currentEvent = applyBeforeAgentStartToEvent(currentEvent, resolved);
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
  portsByPhase: HostedLifecyclePhasePorts,
): void {
  const ports = HOSTED_LIFECYCLE_PHASES.flatMap((phase) => portsByPhase[phase]);
  const sessionStart = collectHandlers(ports, "sessionStart");
  const turnStart = collectHandlers(ports, "turnStart");
  const input = collectHandlers(ports, "input");
  const beforeAgentStart = collectHandlers(ports, "beforeAgentStart");
  const toolResult = collectHandlers(ports, "toolResult");
  const turnEnd = collectHandlers(ports, "turnEnd");
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
  if (turnEnd.length > 0) {
    extensionApi.on("turn_end", (event, ctx) => runSequential(turnEnd, event, ctx));
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
