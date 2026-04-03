import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { coerceContextBudgetUsage } from "@brewva/brewva-runtime";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getHostedTurnTransitionCoordinator } from "../session/turn-transition.js";
import type { HostedDelegationStore } from "../subagents/delegation-store.js";
import {
  createHostedCompactionController,
  type HostedManualCompact,
} from "./hosted-compaction-controller.js";
import {
  createHostedContextInjectionPipeline,
  type HostedContextInjectionResult,
} from "./hosted-context-injection-pipeline.js";
import { createHostedContextTelemetry } from "./hosted-context-telemetry.js";
import { createRuntimeTurnClockStore, type RuntimeTurnClockStore } from "./runtime-turn-clock.js";

export interface ContextTransformOptions {
  autoCompactionWatchdogMs?: number;
  delegationStore?: HostedDelegationStore;
  turnClock?: RuntimeTurnClockStore;
  contextProfile?: "minimal" | "standard" | "full";
}

export interface ContextTransformLifecycle {
  turnStart: (event: unknown, ctx: unknown) => undefined;
  context: (event: unknown, ctx: unknown) => undefined;
  sessionCompact: (event: unknown, ctx: unknown) => undefined;
  sessionShutdown: (event: unknown, ctx: unknown) => undefined;
  beforeAgentStart: (event: unknown, ctx: unknown) => Promise<HostedContextInjectionResult>;
}

interface RuntimePluginSessionManager {
  getSessionId: () => string;
  getLeafId?: () => string | null | undefined;
}

interface RuntimePluginLifecycleContext {
  sessionManager: RuntimePluginSessionManager;
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
  };
  fromExtension?: unknown;
}

interface BeforeAgentStartEvent {
  prompt?: unknown;
  systemPrompt?: unknown;
}

function asLifecycleContext(ctx: unknown): RuntimePluginLifecycleContext {
  return ctx as RuntimePluginLifecycleContext;
}

function resolveUsage(ctx: RuntimePluginLifecycleContext) {
  return coerceContextBudgetUsage(
    typeof ctx.getContextUsage === "function" ? ctx.getContextUsage() : undefined,
  );
}

export function createContextTransformLifecycle(
  extensionApi: ExtensionAPI,
  runtime: BrewvaRuntime,
  options: ContextTransformOptions = {},
): ContextTransformLifecycle {
  getHostedTurnTransitionCoordinator(runtime);
  const turnClock = options.turnClock ?? createRuntimeTurnClockStore();
  const telemetry = createHostedContextTelemetry(runtime);
  const compactionController = createHostedCompactionController(runtime, telemetry, turnClock, {
    autoCompactionWatchdogMs: options.autoCompactionWatchdogMs,
  });
  const injectionPipeline = createHostedContextInjectionPipeline(
    extensionApi,
    runtime,
    telemetry,
    compactionController,
    {
      delegationStore: options.delegationStore,
      contextProfile: options.contextProfile,
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
    context(_event, ctx) {
      const lifecycleContext = asLifecycleContext(ctx);
      compactionController.context({
        sessionId: lifecycleContext.sessionManager.getSessionId(),
        usage: resolveUsage(lifecycleContext),
        hasUI: lifecycleContext.hasUI === true,
        idle: typeof lifecycleContext.isIdle === "function" ? lifecycleContext.isIdle() : false,
        compact: lifecycleContext.compact,
      });
      return undefined;
    },
    sessionCompact(event, ctx) {
      const lifecycleContext = asLifecycleContext(ctx);
      const compactEvent = event as SessionCompactEvent;
      compactionController.sessionCompact({
        sessionId: lifecycleContext.sessionManager.getSessionId(),
        usage: resolveUsage(lifecycleContext),
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
      return injectionPipeline.beforeAgentStart({
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
  extensionApi: ExtensionAPI,
  runtime: BrewvaRuntime,
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
