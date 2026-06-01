import type { BrewvaHostContext, InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import type {
  BrewvaHostAgentEndEvent as AgentEndEvent,
  BrewvaHostSessionStartEvent as SessionStartEvent,
  BrewvaHostTurnEndEvent as TurnEndEvent,
} from "@brewva/brewva-substrate/host-api";
import {
  buildGoalBudgetLimitMessage,
  buildGoalContinuationMessage,
  buildGoalContinuationPayload,
  GOAL_CONTINUATION_QUEUED_EVENT_TYPE,
  type GoalState,
} from "@brewva/brewva-vocabulary/goal";
import type { TurnLifecyclePort } from "../turn-adapter/lifecycle/turn-lifecycle-port.js";
import {
  queryRuntimeEventRecords,
  recordRuntimeGoalContinuationQueued,
} from "./projection/runtime-write-adapters.js";
import type { HostedRuntimeAdapterPort } from "./runtime-ports.js";

function getSessionId(ctx: BrewvaHostContext): string {
  return ctx.sessionManager.getSessionId();
}

function readTotalTokens(message: unknown): number {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return 0;
  }
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return 0;
  }
  const total = (usage as { totalTokens?: unknown }).totalTokens;
  return typeof total === "number" && Number.isFinite(total) ? Math.max(0, Math.trunc(total)) : 0;
}

function latestContinuationKind(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): string | null {
  return latestQueuedContinuation(runtime, sessionId)?.kind ?? null;
}

function latestQueuedContinuation(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): { readonly id: string; readonly kind: string } | null {
  const event = queryRuntimeEventRecords(runtime, sessionId, {
    type: GOAL_CONTINUATION_QUEUED_EVENT_TYPE,
    last: 1,
  })[0];
  const payload = event?.payload ?? {};
  const continuationId = payload.continuationId;
  const kind = payload.kind;
  if (typeof continuationId !== "string" || continuationId.trim().length === 0) {
    return null;
  }
  return typeof kind === "string" ? { id: continuationId.trim(), kind } : null;
}

function hasObservedContinuation(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
  continuationId: string,
): boolean {
  return queryRuntimeEventRecords(runtime, sessionId, {
    type: "goal.usage.observed",
  }).some((record) => record.payload?.continuationId === continuationId);
}

export interface GoalContinuationLifecycleOptions {
  readonly now?: () => number;
}

function resolveNow(options: GoalContinuationLifecycleOptions): number {
  const value = options.now?.();
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function sendGoalMessage(input: {
  hostApi: InternalHostPluginApi;
  runtime: HostedRuntimeAdapterPort;
  sessionId: string;
  goal: GoalState;
  kind: "continue" | "budget_wrap_up";
  now: number;
}): void {
  const payload = buildGoalContinuationPayload(input.goal, input.kind, { now: input.now });
  recordRuntimeGoalContinuationQueued(input.runtime, input.sessionId, payload);
  input.hostApi.sendMessage(
    {
      customType: input.kind === "continue" ? "goal.continuation" : "goal.budget_wrap_up",
      content:
        input.kind === "continue"
          ? buildGoalContinuationMessage(input.goal)
          : buildGoalBudgetLimitMessage(input.goal),
      display: false,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

export function createGoalContinuationLifecycle(
  hostApi: InternalHostPluginApi,
  runtime: HostedRuntimeAdapterPort,
  options: GoalContinuationLifecycleOptions = {},
): TurnLifecyclePort {
  return {
    sessionStart(_event: SessionStartEvent, ctx: BrewvaHostContext) {
      const sessionId = getSessionId(ctx);
      const goal = runtime.ops.goal.state.get(sessionId);
      if (goal?.status === "active") {
        runtime.ops.goal.lifecycle.pause(sessionId, {
          reason: "session_start",
          now: resolveNow(options),
        });
      }
    },
    turnEnd(event: TurnEndEvent, ctx: BrewvaHostContext) {
      const sessionId = getSessionId(ctx);
      const goal = runtime.ops.goal.state.get(sessionId);
      if (goal?.status !== "active") {
        return;
      }
      const queued = latestQueuedContinuation(runtime, sessionId);
      if (
        !queued ||
        queued.kind !== "continue" ||
        hasObservedContinuation(runtime, sessionId, queued.id)
      ) {
        return;
      }
      const turnId = `turn:${event.turnIndex}`;
      runtime.ops.goal.usage.observe(sessionId, {
        tokens: readTotalTokens(event.message),
        elapsedMs: 0,
        turn: event.turnIndex,
        turnId,
        continuationId: queued.id,
        now: resolveNow(options),
      });
    },
    agentEnd(_event: AgentEndEvent, ctx: BrewvaHostContext) {
      const sessionId = getSessionId(ctx);
      if (ctx.hasPendingMessages()) {
        return;
      }
      const goal = runtime.ops.goal.state.get(sessionId);
      if (!goal) {
        return;
      }
      if (goal.status === "budget_limited") {
        if (latestContinuationKind(runtime, sessionId) !== "budget_wrap_up") {
          sendGoalMessage({
            hostApi,
            runtime,
            sessionId,
            goal,
            kind: "budget_wrap_up",
            now: resolveNow(options),
          });
        }
        return;
      }
      if (goal.status !== "active") {
        return;
      }
      sendGoalMessage({
        hostApi,
        runtime,
        sessionId,
        goal,
        kind: "continue",
        now: resolveNow(options),
      });
    },
  };
}
