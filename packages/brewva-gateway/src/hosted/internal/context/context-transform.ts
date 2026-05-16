import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { coerceContextBudgetUsage } from "@brewva/brewva-runtime/context";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import type { BrewvaTurnLoopMessage } from "@brewva/brewva-substrate/turn";
import type { HostedDelegationStore } from "../../../delegation/api.js";
import {
  createRuntimeTurnClockStore,
  type RuntimeTurnClockStore,
} from "../thread-loop/lifecycle/runtime-turn-clock.js";
import { getHostedTurnTransitionCoordinator } from "../thread-loop/turn-transition.js";
import {
  createHostedCompactionController,
  type HostedManualCompact,
} from "./hosted-compaction-controller.js";
import { createHostedContextTelemetry } from "./hosted-context-telemetry.js";
import {
  createHostedWorkbenchContextController,
  type HostedWorkbenchContextResult,
} from "./workbench-context.js";

export interface ContextTransformOptions {
  autoCompactionWatchdogMs?: number;
  delegationStore?: HostedDelegationStore;
  turnClock?: RuntimeTurnClockStore;
}

export interface ContextTransformLifecycle {
  turnStart: (event: unknown, ctx: unknown) => undefined;
  context: (event: unknown, ctx: unknown) => { messages: BrewvaTurnLoopMessage[] } | undefined;
  sessionCompact: (event: unknown, ctx: unknown) => Promise<undefined>;
  sessionShutdown: (event: unknown, ctx: unknown) => undefined;
  beforeAgentStart: (event: unknown, ctx: unknown) => Promise<HostedWorkbenchContextResult>;
}

interface HostedContextSessionManager {
  getSessionId: () => string;
  getLeafId?: () => string | null | undefined;
}

interface HostedContextLifecycleContext {
  sessionManager: HostedContextSessionManager;
  hasUI?: boolean;
  isIdle?: () => boolean;
  getContextUsage?: () => unknown;
  compact?: HostedManualCompact;
}

interface TurnStartEvent {
  turnIndex?: unknown;
  timestamp?: unknown;
}

interface SessionCompactEvent {
  compactionEntry?: {
    id?: unknown;
    summary?: unknown;
    content?: unknown;
    text?: unknown;
    summaryGeneration?: unknown;
  };
  fromExtension?: unknown;
}

interface BeforeAgentStartEvent {
  prompt?: unknown;
  systemPrompt?: unknown;
}

interface ContextEvent {
  messages?: unknown;
}

function asLifecycleContext(ctx: unknown): HostedContextLifecycleContext {
  return ctx as HostedContextLifecycleContext;
}

function resolveUsage(ctx: HostedContextLifecycleContext) {
  return coerceContextBudgetUsage(
    typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined,
  );
}

export function createContextTransformLifecycle(
  extensionApi: InternalHostPluginApi,
  runtime: BrewvaHostedRuntimePort,
  options: ContextTransformOptions = {},
): ContextTransformLifecycle {
  getHostedTurnTransitionCoordinator(runtime);
  const turnClock = options.turnClock ?? createRuntimeTurnClockStore();
  const telemetry = createHostedContextTelemetry(runtime);
  const compactionController = createHostedCompactionController(runtime, telemetry, turnClock, {
    autoCompactionWatchdogMs: options.autoCompactionWatchdogMs,
  });
  const workbenchContextController = createHostedWorkbenchContextController(
    extensionApi,
    runtime,
    telemetry,
    compactionController,
    {
      delegationStore: options.delegationStore,
    },
  );

  return {
    turnStart(event, ctx) {
      const lifecycleContext = asLifecycleContext(ctx);
      const turnEvent = event as TurnStartEvent;
      compactionController.turnStart({
        sessionId: lifecycleContext.sessionManager.getSessionId(),
        turnIndex: Number(turnEvent.turnIndex ?? 0),
        timestamp: Number(turnEvent.timestamp ?? Date.now()),
      });
      return undefined;
    },
    context(event, ctx) {
      const lifecycleContext = asLifecycleContext(ctx);
      compactionController.context({
        sessionId: lifecycleContext.sessionManager.getSessionId(),
        usage: resolveUsage(lifecycleContext),
        hasUI: lifecycleContext.hasUI === true,
        idle: typeof lifecycleContext.isIdle === "function" ? lifecycleContext.isIdle() : false,
        compact: lifecycleContext.compact,
      });
      const messages = (event as ContextEvent).messages;
      if (!Array.isArray(messages)) {
        return undefined;
      }
      return {
        messages: workbenchContextController.transformContext({
          sessionId: lifecycleContext.sessionManager.getSessionId(),
          messages: messages as BrewvaTurnLoopMessage[],
        }),
      };
    },
    async sessionCompact(event, ctx) {
      const lifecycleContext = asLifecycleContext(ctx);
      const compactEvent = event as SessionCompactEvent;
      await compactionController.sessionCompact({
        sessionId: lifecycleContext.sessionManager.getSessionId(),
        usage: resolveUsage(lifecycleContext),
        sessionManager: lifecycleContext.sessionManager,
        compactionEntry: compactEvent.compactionEntry,
        fromExtension: compactEvent.fromExtension,
      });
      return undefined;
    },
    sessionShutdown(_event, ctx) {
      const lifecycleContext = asLifecycleContext(ctx);
      compactionController.sessionShutdown({
        sessionId: lifecycleContext.sessionManager.getSessionId(),
      });
      return undefined;
    },
    async beforeAgentStart(event, ctx) {
      const lifecycleContext = asLifecycleContext(ctx);
      const startEvent = event as BeforeAgentStartEvent;
      return workbenchContextController.beforeAgentStart({
        sessionId: lifecycleContext.sessionManager.getSessionId(),
        sessionManager: lifecycleContext.sessionManager,
        prompt: typeof startEvent.prompt === "string" ? startEvent.prompt : "",
        systemPrompt: startEvent.systemPrompt,
        usage: resolveUsage(lifecycleContext),
      });
    },
  };
}

export function registerContextTransform(
  extensionApi: InternalHostPluginApi,
  runtime: BrewvaHostedRuntimePort,
  options: ContextTransformOptions = {},
): void {
  const hooks = extensionApi as unknown as {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  };
  const lifecycle = createContextTransformLifecycle(extensionApi, runtime, options);
  hooks.on("turn_start", lifecycle.turnStart);
  hooks.on("context", lifecycle.context);
  hooks.on("session_compact", lifecycle.sessionCompact);
  hooks.on("session_shutdown", lifecycle.sessionShutdown);
  hooks.on("before_agent_start", lifecycle.beforeAgentStart);
}
