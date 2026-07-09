import {
  buildGoalContinuationPayload,
  GOAL_BLOCKED_EVENT_TYPE,
  GOAL_BLOCKER_OBSERVED_EVENT_TYPE,
  GOAL_BUDGET_LIMITED_EVENT_TYPE,
  GOAL_CLEARED_EVENT_TYPE,
  GOAL_COMPLETED_EVENT_TYPE,
  GOAL_CONTINUATION_QUEUED_EVENT_TYPE,
  GOAL_CONTINUED_EVENT_TYPE,
  GOAL_MAX_TURNS_EVENT_TYPE,
  GOAL_PAUSED_EVENT_TYPE,
  GOAL_REPLACED_EVENT_TYPE,
  GOAL_RESUMED_EVENT_TYPE,
  GOAL_STARTED_EVENT_TYPE,
  GOAL_USAGE_OBSERVED_EVENT_TYPE,
  normalizeGoalBlockerKey,
  type GoalLifecycleInput,
} from "@brewva/brewva-vocabulary/goal";
import type { HostedRuntimeOpsContext } from "./runtime-ops-context.js";
import {
  BLOCKED_REQUIRED_COUNT,
  createGoalRuntimeReader,
  inputPayload,
  normalizeNow,
  TERMINAL_GOAL_STATUSES,
} from "./runtime-ops-goal-state-read.js";
import type { HostedRuntimeOpsPort } from "./runtime-ops-port.js";

type GoalOps = HostedRuntimeOpsPort["goal"];
type GoalMutation = ReturnType<GoalOps["lifecycle"]["start"]>;

export function createGoalRuntimeController(ctx: HostedRuntimeOpsContext) {
  const { activeGoal, countConsecutiveBlockers, readGoal } = createGoalRuntimeReader(ctx);
  let continuationSequence = 0;

  function inactive(sessionId: string, reason: string): GoalMutation {
    return { ok: false, reason, goal: readGoal(sessionId) };
  }

  function append(
    sessionId: string,
    eventType: string,
    payload: Record<string, unknown>,
    turn?: number,
  ): GoalMutation {
    const event = ctx.emit(sessionId, eventType, payload, {
      timestamp: typeof payload.now === "number" ? payload.now : undefined,
      turn,
    });
    return { ok: true, goal: readGoal(sessionId), eventType, eventId: event.id };
  }

  return {
    get: readGoal,
    start(sessionId: string, input: GoalLifecycleInput): GoalMutation {
      const now = normalizeNow(input);
      const current = readGoal(sessionId);
      const objective = typeof input.objective === "string" ? input.objective.trim() : "";
      if (!objective) return inactive(sessionId, "missing_objective");
      const replacing = current !== null && !TERMINAL_GOAL_STATUSES.has(current.status);
      const tokenBudget =
        input.tokenBudget === null
          ? null
          : typeof input.tokenBudget === "number" && Number.isFinite(input.tokenBudget)
            ? Math.max(1, Math.trunc(input.tokenBudget))
            : null;
      const maxTurns =
        typeof input.maxTurns === "number" && Number.isFinite(input.maxTurns) && input.maxTurns > 0
          ? Math.trunc(input.maxTurns)
          : null;
      const goalId =
        typeof input.goalId === "string" && input.goalId.trim()
          ? input.goalId.trim()
          : `goal:${sessionId}:${now}`;
      return append(
        sessionId,
        replacing ? GOAL_REPLACED_EVENT_TYPE : GOAL_STARTED_EVENT_TYPE,
        {
          schema: "brewva.goal.lifecycle.v1",
          goalId,
          objective,
          tokenBudget,
          maxTurns,
          now,
          ...(replacing ? { previousGoalId: current.id } : {}),
        },
        typeof input.turn === "number" ? input.turn : undefined,
      );
    },
    pause(sessionId: string, input: GoalLifecycleInput = {}): GoalMutation {
      if (!activeGoal(sessionId)) return inactive(sessionId, "goal_not_active");
      const payload = inputPayload(input);
      return append(sessionId, GOAL_PAUSED_EVENT_TYPE, {
        schema: "brewva.goal.lifecycle.v1",
        reason: typeof payload.reason === "string" ? payload.reason : undefined,
        now: normalizeNow(input),
      });
    },
    resume(sessionId: string, input: GoalLifecycleInput = {}): GoalMutation {
      if (readGoal(sessionId)?.status !== "paused")
        return inactive(sessionId, "goal_not_resumable");
      return append(sessionId, GOAL_RESUMED_EVENT_TYPE, {
        schema: "brewva.goal.lifecycle.v1",
        now: normalizeNow(input),
      });
    },
    continueGoal(sessionId: string, input: GoalLifecycleInput = {}): GoalMutation {
      if (readGoal(sessionId)?.status !== "max_turns")
        return inactive(sessionId, "goal_not_continuable");
      return append(sessionId, GOAL_CONTINUED_EVENT_TYPE, {
        schema: "brewva.goal.lifecycle.v1",
        now: normalizeNow(input),
      });
    },
    clear(sessionId: string, input: GoalLifecycleInput = {}): GoalMutation {
      if (!readGoal(sessionId)) return inactive(sessionId, "goal_not_found");
      return append(sessionId, GOAL_CLEARED_EVENT_TYPE, {
        schema: "brewva.goal.lifecycle.v1",
        reason: input.reason,
        now: normalizeNow(input),
      });
    },
    complete(sessionId: string, input: GoalLifecycleInput = {}): GoalMutation {
      if (!activeGoal(sessionId)) return inactive(sessionId, "goal_not_active");
      const payload = inputPayload(input);
      return append(sessionId, GOAL_COMPLETED_EVENT_TYPE, {
        schema: "brewva.goal.lifecycle.v1",
        reason: typeof payload.reason === "string" ? payload.reason : undefined,
        evidence: Array.isArray(payload.evidence) ? payload.evidence : [],
        evidenceRef:
          typeof payload.evidenceRef === "string" && payload.evidenceRef.trim()
            ? payload.evidenceRef.trim()
            : undefined,
        now: normalizeNow(input),
      });
    },
    block(sessionId: string, input: GoalLifecycleInput): GoalMutation {
      const state = activeGoal(sessionId);
      if (!state) return inactive(sessionId, "goal_not_active");
      const evidence = Array.isArray(input.evidence)
        ? input.evidence.filter((entry): entry is string => typeof entry === "string")
        : [];
      const reason = typeof input.reason === "string" ? input.reason.trim() : "";
      if (!reason || evidence.length === 0) return inactive(sessionId, "missing_block_evidence");
      const blockerKey =
        typeof input.blockerKey === "string" && input.blockerKey.trim()
          ? input.blockerKey.trim()
          : normalizeGoalBlockerKey(reason, evidence);
      const now = normalizeNow(input);
      const goalTurnKey =
        typeof input.turnId === "string" && input.turnId.trim()
          ? input.turnId.trim()
          : typeof input.turn === "number"
            ? `turn:${input.turn}`
            : (state.latestContinuationRef ?? "unattributed");
      ctx.emit(
        sessionId,
        GOAL_BLOCKER_OBSERVED_EVENT_TYPE,
        {
          schema: "brewva.goal.blocker.v1",
          goalId: state.id,
          goalTurnKey,
          blockerKey,
          reason,
          evidence,
          turnId: input.turnId,
          now,
        },
        { timestamp: now, turn: typeof input.turn === "number" ? input.turn : undefined },
      );
      const count = countConsecutiveBlockers(sessionId, blockerKey);
      if (count < BLOCKED_REQUIRED_COUNT) {
        return {
          ok: false,
          reason: "block_threshold_not_met",
          goal: readGoal(sessionId),
          count,
          requiredCount: BLOCKED_REQUIRED_COUNT,
        };
      }
      return {
        ...append(sessionId, GOAL_BLOCKED_EVENT_TYPE, {
          schema: "brewva.goal.lifecycle.v1",
          blockerKey,
          reason,
          evidence,
          evidenceRef:
            typeof input.evidenceRef === "string" && input.evidenceRef.trim()
              ? input.evidenceRef.trim()
              : undefined,
          now,
        }),
        count,
      };
    },
    observe(sessionId: string, input: GoalLifecycleInput): GoalMutation {
      if (!activeGoal(sessionId)) return inactive(sessionId, "goal_not_active");
      const payload = inputPayload(input);
      const observed = append(sessionId, GOAL_USAGE_OBSERVED_EVENT_TYPE, {
        schema: "brewva.goal.usage.v1",
        tokens: typeof payload.tokens === "number" ? Math.max(0, Math.trunc(payload.tokens)) : 0,
        elapsedMs:
          typeof payload.elapsedMs === "number" ? Math.max(0, Math.trunc(payload.elapsedMs)) : 0,
        turnId: payload.turnId,
        continuationId:
          typeof payload.continuationId === "string" && payload.continuationId.trim()
            ? payload.continuationId.trim()
            : undefined,
        now: normalizeNow(input),
      });
      const updated = observed.goal;
      if (
        updated?.status === "active" &&
        updated.tokenBudget !== null &&
        updated.usage.tokens >= updated.tokenBudget
      ) {
        return append(sessionId, GOAL_BUDGET_LIMITED_EVENT_TYPE, {
          schema: "brewva.goal.lifecycle.v1",
          reason: "token_budget_exhausted",
          now: normalizeNow(input),
        });
      }
      if (
        updated?.status === "active" &&
        updated.maxTurns !== null &&
        updated.usage.goalTurnCount >= updated.maxTurns
      ) {
        return append(sessionId, GOAL_MAX_TURNS_EVENT_TYPE, {
          schema: "brewva.goal.lifecycle.v1",
          reason: "max_turns_reached",
          now: normalizeNow(input),
        });
      }
      return observed;
    },
    recordQueued(
      sessionId: string,
      input: Parameters<GoalOps["continuation"]["recordQueued"]>[1],
    ): GoalMutation {
      const state = readGoal(sessionId);
      if (!state) return inactive(sessionId, "goal_not_found");
      const now = normalizeNow(input);
      const continuationId =
        typeof input.continuationId === "string" && input.continuationId.trim()
          ? input.continuationId.trim()
          : `goal-continuation:${sessionId}:${now}:${(continuationSequence += 1)}`;
      return append(sessionId, GOAL_CONTINUATION_QUEUED_EVENT_TYPE, {
        ...buildGoalContinuationPayload(state, input.kind, {
          continuationId,
          now,
        }),
      });
    },
  };
}
