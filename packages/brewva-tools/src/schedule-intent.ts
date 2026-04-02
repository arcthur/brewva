import type {
  ConvergencePredicate,
  ScheduleContinuityMode,
  ScheduleIntentStatus,
  ScheduleIntentUpdateInput,
  TaskPhase,
} from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatISO } from "date-fns";
import {
  formatIntentSummary,
  normalizeOptionalString,
  resolveSchedulePatch,
  resolveScheduleTarget,
} from "./schedule-shared.js";
import type { BrewvaToolOptions } from "./types.js";
import { attachStringEnumContractPaths, buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const SCHEDULE_ACTION_VALUES = ["create", "update", "cancel", "list"] as const;
const ScheduleActionSchema = buildStringEnumSchema(SCHEDULE_ACTION_VALUES, {
  guidance:
    "Use create to schedule new work, update to patch an existing intent, cancel to stop an intent, and list to inspect recorded intents.",
});

const CONTINUITY_MODE_VALUES = ["inherit", "fresh"] as const;
const ContinuityModeSchema = buildStringEnumSchema(CONTINUITY_MODE_VALUES, {
  recommendedValue: "inherit",
  guidance:
    "Use inherit to keep the scheduled work attached to the current session and goal lineage. Use fresh for a detached follow-up branch.",
});

const SCHEDULE_LIST_STATUSES = ["all", "active", "cancelled", "converged", "error"] as const;
const ListStatusSchema = buildStringEnumSchema(SCHEDULE_LIST_STATUSES, {
  recommendedValue: "all",
  guidance:
    "Use all by default. Filter to active, cancelled, converged, or error only when narrowing the listing.",
});

const CONVERGENCE_KIND_VALUES = [
  "truth_resolved",
  "task_phase",
  "max_runs",
  "all_of",
  "any_of",
] as const;
const TASK_PHASE_VALUES = [
  "align",
  "investigate",
  "execute",
  "verify",
  "ready_for_acceptance",
  "blocked",
  "done",
] as const;
const TaskPhaseSchema = buildStringEnumSchema(TASK_PHASE_VALUES, {
  guidance:
    "Use task_phase when the schedule should stop after the task reaches a specific phase such as investigate, execute, verify, ready_for_acceptance, blocked, or done.",
});

const ConvergencePredicateSchema = attachStringEnumContractPaths(
  Type.Recursive((Self) =>
    Type.Union([
      Type.Object({
        kind: Type.Literal("truth_resolved"),
        factId: Type.String({ minLength: 1, maxLength: 300 }),
      }),
      Type.Object({
        kind: Type.Literal("task_phase"),
        phase: TaskPhaseSchema,
      }),
      Type.Object({
        kind: Type.Literal("max_runs"),
        limit: Type.Integer({ minimum: 1 }),
      }),
      Type.Object({
        kind: Type.Literal("all_of"),
        predicates: Type.Array(Self, { minItems: 1, maxItems: 16 }),
      }),
      Type.Object({
        kind: Type.Literal("any_of"),
        predicates: Type.Array(Self, { minItems: 1, maxItems: 16 }),
      }),
    ]),
  ),
  [
    {
      path: ["kind"],
      contract: {
        canonicalValues: CONVERGENCE_KIND_VALUES,
        guidance:
          "Use truth_resolved for fact-based convergence, task_phase for task-state convergence, max_runs for bounded retries, and all_of or any_of to compose multiple predicates.",
      },
    },
  ],
);

function toStatusFilter(value: unknown): ScheduleIntentStatus | undefined {
  const normalized = typeof value === "string" ? value : undefined;
  if (
    normalized === "active" ||
    normalized === "cancelled" ||
    normalized === "converged" ||
    normalized === "error"
  ) {
    return normalized;
  }
  return undefined;
}

function normalizeContinuityMode(value: unknown): ScheduleContinuityMode | undefined {
  return value === "inherit" || value === "fresh" ? value : undefined;
}

function normalizeTaskPhase(value: unknown): TaskPhase | undefined {
  return TASK_PHASE_VALUES.includes(value as never) ? (value as TaskPhase) : undefined;
}

function normalizeConvergencePredicate(value: unknown): ConvergencePredicate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const kind = candidate.kind;

  if (kind === "truth_resolved") {
    const factId = normalizeOptionalString(candidate.factId);
    return factId ? { kind, factId } : undefined;
  }

  if (kind === "task_phase") {
    const phase = normalizeTaskPhase(candidate.phase);
    return phase ? { kind, phase } : undefined;
  }

  if (kind === "max_runs") {
    if (
      typeof candidate.limit !== "number" ||
      !Number.isInteger(candidate.limit) ||
      candidate.limit < 1
    ) {
      return undefined;
    }
    return { kind, limit: candidate.limit };
  }

  if (kind === "all_of" || kind === "any_of") {
    if (!Array.isArray(candidate.predicates) || candidate.predicates.length === 0) {
      return undefined;
    }
    const predicates = candidate.predicates
      .map((entry) => normalizeConvergencePredicate(entry))
      .filter((entry): entry is ConvergencePredicate => entry !== undefined);
    return predicates.length === candidate.predicates.length ? { kind, predicates } : undefined;
  }

  return undefined;
}

export function createScheduleIntentTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "schedule_intent",
    label: "Schedule Intent",
    description:
      "Create, update, cancel, or list schedule intents. Supports one-shot runAt/delayMs and recurring cron.",
    promptSnippet: "Create, update, cancel, or list deferred and recurring execution intents.",
    promptGuidelines: [
      "Use this only when the user explicitly wants future or recurring execution.",
      "Action values are create, update, cancel, and list. Prefer continuityMode=inherit unless the scheduled work should detach into a fresh branch.",
    ],
    parameters: Type.Object({
      action: ScheduleActionSchema,
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 800 })),
      intentId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      runAt: Type.Optional(Type.Number({ minimum: 1 })),
      delayMs: Type.Optional(Type.Integer({ minimum: 1 })),
      cron: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      maxRuns: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
      continuityMode: Type.Optional(ContinuityModeSchema),
      goalRef: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
      convergenceCondition: Type.Optional(ConvergencePredicateSchema),
      status: Type.Optional(ListStatusSchema),
      includeAllSessions: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const continuityMode = normalizeContinuityMode(params.continuityMode);
      const convergenceCondition = normalizeConvergencePredicate(params.convergenceCondition);
      if (!options.runtime.config.schedule.enabled) {
        return failTextResult("Schedule intent rejected (scheduler_disabled).", {
          ok: false,
          error: "scheduler_disabled",
        });
      }

      if (params.action === "create") {
        const reason = normalizeOptionalString(params.reason);
        if (!reason) {
          return failTextResult("Schedule intent rejected (missing_reason).", {
            ok: false,
            error: "missing_reason",
          });
        }

        const scheduleTarget = resolveScheduleTarget({
          runAt: params.runAt,
          delayMs: params.delayMs,
          cron: params.cron,
          timeZone: params.timeZone,
        });
        if (!scheduleTarget.runAt && !scheduleTarget.cron) {
          return failTextResult(
            `Schedule intent rejected (${scheduleTarget.error ?? "invalid_schedule"}).`,
            {
              ok: false,
              error: scheduleTarget.error ?? "invalid_schedule",
            },
          );
        }

        const created = await options.runtime.schedule.createIntent(sessionId, {
          reason,
          intentId: normalizeOptionalString(params.intentId),
          goalRef: normalizeOptionalString(params.goalRef),
          continuityMode,
          runAt: scheduleTarget.runAt,
          cron: scheduleTarget.cron,
          timeZone: scheduleTarget.timeZone,
          maxRuns: params.maxRuns,
          convergenceCondition,
        });

        if (!created.ok) {
          return failTextResult(`Schedule intent rejected (${created.error}).`, {
            ok: false,
            error: created.error,
          });
        }

        const intent = created.intent;
        const message = [
          "Schedule intent created.",
          `intentId: ${intent.intentId}`,
          `status: ${intent.status}`,
          `cron: ${intent.cron ?? "none"}`,
          `timeZone: ${intent.timeZone ?? "none"}`,
          `runAt: ${intent.runAt ? formatISO(intent.runAt) : "none"}`,
          `nextRunAt: ${intent.nextRunAt ? formatISO(intent.nextRunAt) : "none"}`,
          `runs: ${intent.runCount}/${intent.maxRuns}`,
        ].join("\n");
        return textResult(message, {
          ok: true,
          intent,
        });
      }

      if (params.action === "update") {
        const intentId = normalizeOptionalString(params.intentId);
        if (!intentId) {
          return failTextResult("Schedule intent update rejected (missing_intent_id).", {
            ok: false,
            error: "missing_intent_id",
          });
        }

        const schedulePatch = resolveSchedulePatch({
          runAt: params.runAt,
          delayMs: params.delayMs,
          cron: params.cron,
          timeZone: params.timeZone,
        });
        if (schedulePatch.error) {
          return failTextResult(`Schedule intent update rejected (${schedulePatch.error}).`, {
            ok: false,
            error: schedulePatch.error,
          });
        }

        const reason = normalizeOptionalString(params.reason);
        if (params.reason !== undefined && !reason) {
          return failTextResult("Schedule intent update rejected (invalid_reason).", {
            ok: false,
            error: "invalid_reason",
          });
        }
        const goalRef =
          params.goalRef !== undefined ? normalizeOptionalString(params.goalRef) : undefined;
        if (params.goalRef !== undefined && !goalRef) {
          return failTextResult("Schedule intent update rejected (invalid_goal_ref).", {
            ok: false,
            error: "invalid_goal_ref",
          });
        }
        const hasNonSchedulePatch =
          reason !== undefined ||
          goalRef !== undefined ||
          continuityMode !== undefined ||
          params.maxRuns !== undefined ||
          convergenceCondition !== undefined;
        if (!schedulePatch.hasScheduleUpdate && !hasNonSchedulePatch) {
          return failTextResult("Schedule intent update rejected (empty_update).", {
            ok: false,
            error: "empty_update",
          });
        }

        const updateInput: ScheduleIntentUpdateInput = {
          intentId,
          continuityMode,
          maxRuns: params.maxRuns,
          convergenceCondition,
        };
        if (reason !== undefined) updateInput.reason = reason;
        if (params.goalRef !== undefined) updateInput.goalRef = goalRef;
        if (schedulePatch.hasScheduleUpdate) {
          if (schedulePatch.runAt !== undefined) updateInput.runAt = schedulePatch.runAt;
          if (schedulePatch.cron !== undefined) updateInput.cron = schedulePatch.cron;
          if (schedulePatch.timeZone !== undefined) updateInput.timeZone = schedulePatch.timeZone;
        }

        const updated = await options.runtime.schedule.updateIntent(sessionId, updateInput);
        if (!updated.ok) {
          return failTextResult(`Schedule intent update rejected (${updated.error}).`, {
            ok: false,
            error: updated.error,
          });
        }

        const intent = updated.intent;
        const message = [
          "Schedule intent updated.",
          `intentId: ${intent.intentId}`,
          `status: ${intent.status}`,
          `cron: ${intent.cron ?? "none"}`,
          `timeZone: ${intent.timeZone ?? "none"}`,
          `runAt: ${intent.runAt ? formatISO(intent.runAt) : "none"}`,
          `nextRunAt: ${intent.nextRunAt ? formatISO(intent.nextRunAt) : "none"}`,
          `runs: ${intent.runCount}/${intent.maxRuns}`,
        ].join("\n");
        return textResult(message, {
          ok: true,
          intent,
        });
      }

      if (params.action === "cancel") {
        const intentId = normalizeOptionalString(params.intentId);
        if (!intentId) {
          return failTextResult("Schedule intent cancel rejected (missing_intent_id).", {
            ok: false,
            error: "missing_intent_id",
          });
        }

        const cancelled = await options.runtime.schedule.cancelIntent(sessionId, {
          intentId,
          reason: normalizeOptionalString(params.reason),
        });
        if (!cancelled.ok) {
          return failTextResult(
            `Schedule intent cancel rejected (${cancelled.error ?? "unknown_error"}).`,
            {
              ok: false,
              error: cancelled.error ?? "unknown_error",
            },
          );
        }
        return textResult(`Schedule intent cancelled (${intentId}).`, {
          ok: true,
          intentId,
        });
      }

      const statusFilter = toStatusFilter(params.status);
      const statusLabel = typeof params.status === "string" ? params.status : "all";
      const listQuery = {
        parentSessionId: params.includeAllSessions ? undefined : sessionId,
        status: statusFilter,
      };
      const intents = await options.runtime.schedule.listIntents(listQuery);
      const snapshot = await options.runtime.schedule.getProjectionSnapshot();

      const header = [
        "[ScheduleIntents]",
        `count: ${intents.length}`,
        `scope: ${listQuery.parentSessionId ? "session" : "global"}`,
        `status: ${statusLabel}`,
        `watermarkOffset: ${snapshot.watermarkOffset}`,
      ];
      const lines =
        intents.length > 0 ? intents.map((intent) => formatIntentSummary(intent)) : ["- (none)"];
      return textResult([...header, ...lines].join("\n"), {
        ok: true,
        intents,
        watermarkOffset: snapshot.watermarkOffset,
      });
    },
  });
}
