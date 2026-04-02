import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatISO } from "date-fns";
import {
  formatIntentSummary,
  normalizeOptionalString,
  resolveScheduleTarget,
} from "./schedule-shared.js";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const FOLLOW_UP_ACTION_VALUES = ["create", "cancel", "list"] as const;
const FollowUpActionSchema = buildStringEnumSchema(FOLLOW_UP_ACTION_VALUES, {
  guidance:
    "Use create to schedule a bounded follow-up, cancel to stop one, and list to inspect follow-ups for the current session.",
});

const FOLLOW_UP_DURATION_PATTERN = "^[1-9][0-9]*(m|h|d)$";
const FOLLOW_UP_RECURRING_DURATION_PATTERN = "^[1-9][0-9]*(m|h)$";

type DurationUnit = "m" | "h" | "d";

function parseDuration(
  raw: unknown,
  allowedUnits: readonly DurationUnit[],
): { value: number; unit: DurationUnit; ms: number } | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim();
  const match = /^([1-9][0-9]*)([mhd])$/.exec(normalized);
  if (!match) return undefined;

  const value = Number(match[1]);
  const unit = match[2] as DurationUnit;
  if (!Number.isInteger(value) || value <= 0 || !allowedUnits.includes(unit)) {
    return undefined;
  }

  const unitMs = unit === "m" ? 60_000 : unit === "h" ? 60 * 60_000 : 24 * 60 * 60_000;
  const ms = value * unitMs;
  if (!Number.isSafeInteger(ms) || ms <= 0) {
    return undefined;
  }

  return { value, unit, ms };
}

function compileEveryDurationToCron(duration: {
  value: number;
  unit: "m" | "h";
}): string | undefined {
  if (duration.unit === "m") {
    if (duration.value < 60 && 60 % duration.value === 0) {
      return `*/${duration.value} * * * *`;
    }
    if (duration.value === 60) {
      return "0 * * * *";
    }
    if (duration.value > 60 && duration.value % 60 === 0) {
      const hours = duration.value / 60;
      if (hours < 24 && 24 % hours === 0) {
        return `0 */${hours} * * *`;
      }
      if (hours === 24) {
        return "0 0 * * *";
      }
    }
    return undefined;
  }

  if (duration.value < 24 && 24 % duration.value === 0) {
    return `0 */${duration.value} * * *`;
  }
  if (duration.value === 24) {
    return "0 0 * * *";
  }
  return undefined;
}

export function createFollowUpTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "follow_up",
    label: "Follow Up",
    description:
      "Create, cancel, or list bounded follow-ups using after/every durations. Compiles to schedule_intent semantics without exposing the lower-level contract.",
    promptSnippet: "Create, cancel, or list bounded follow-ups using after/every durations.",
    promptGuidelines: [
      "Use this when the user wants a simple delayed or recurring follow-up without editing the lower-level schedule_intent contract directly.",
      "Use after for a one-shot follow-up and every for a recurring follow-up. Keep recurring follow-ups bounded.",
    ],
    parameters: Type.Object({
      action: FollowUpActionSchema,
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 800 })),
      intentId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      after: Type.Optional(Type.String({ pattern: FOLLOW_UP_DURATION_PATTERN, maxLength: 32 })),
      every: Type.Optional(
        Type.String({ pattern: FOLLOW_UP_RECURRING_DURATION_PATTERN, maxLength: 32 }),
      ),
      runs: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_000 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      if (!options.runtime.config.schedule.enabled) {
        return failTextResult("Follow-up rejected (scheduler_disabled).", {
          ok: false,
          error: "scheduler_disabled",
        });
      }

      if (params.action === "create") {
        const reason = normalizeOptionalString(params.reason);
        if (!reason) {
          return failTextResult("Follow-up rejected (missing_reason).", {
            ok: false,
            error: "missing_reason",
          });
        }

        if (params.after !== undefined && params.every !== undefined) {
          return failTextResult("Follow-up rejected (after_and_every_are_mutually_exclusive).", {
            ok: false,
            error: "after_and_every_are_mutually_exclusive",
          });
        }
        if (params.after === undefined && params.every === undefined) {
          return failTextResult("Follow-up rejected (missing_follow_up_timing).", {
            ok: false,
            error: "missing_follow_up_timing",
          });
        }

        if (params.after !== undefined) {
          if (params.runs !== undefined) {
            return failTextResult("Follow-up rejected (runs_requires_every).", {
              ok: false,
              error: "runs_requires_every",
            });
          }

          const after = parseDuration(params.after, ["m", "h", "d"]);
          if (!after) {
            return failTextResult("Follow-up rejected (invalid_after).", {
              ok: false,
              error: "invalid_after",
            });
          }

          const scheduleTarget = resolveScheduleTarget({ delayMs: after.ms });
          if (scheduleTarget.error || scheduleTarget.runAt === undefined) {
            return failTextResult("Follow-up rejected (invalid_after).", {
              ok: false,
              error: "invalid_after",
            });
          }

          const created = await options.runtime.schedule.createIntent(sessionId, {
            reason,
            intentId: normalizeOptionalString(params.intentId),
            continuityMode: "inherit",
            runAt: scheduleTarget.runAt,
            maxRuns: 1,
          });
          if (!created.ok) {
            return failTextResult(`Follow-up rejected (${created.error}).`, {
              ok: false,
              error: created.error,
            });
          }

          const intent = created.intent;
          return textResult(
            [
              "Follow-up created.",
              `intentId: ${intent.intentId}`,
              "mode: after",
              `runAt: ${intent.runAt ? formatISO(intent.runAt) : "none"}`,
              `nextRunAt: ${intent.nextRunAt ? formatISO(intent.nextRunAt) : "none"}`,
            ].join("\n"),
            {
              ok: true,
              intent,
            },
          );
        }

        const every = parseDuration(params.every, ["m", "h"]);
        const recurringEvery =
          every && (every.unit === "m" || every.unit === "h")
            ? {
                value: every.value,
                unit: every.unit,
              }
            : undefined;
        if (!recurringEvery) {
          return failTextResult("Follow-up rejected (invalid_every).", {
            ok: false,
            error: "invalid_every",
          });
        }
        const cron = compileEveryDurationToCron(recurringEvery);
        if (!cron) {
          return failTextResult("Follow-up rejected (unsupported_every_interval).", {
            ok: false,
            error: "unsupported_every_interval",
          });
        }

        const created = await options.runtime.schedule.createIntent(sessionId, {
          reason,
          intentId: normalizeOptionalString(params.intentId),
          continuityMode: "inherit",
          cron,
          maxRuns: params.runs ?? 12,
        });
        if (!created.ok) {
          return failTextResult(`Follow-up rejected (${created.error}).`, {
            ok: false,
            error: created.error,
          });
        }

        const intent = created.intent;
        return textResult(
          [
            "Follow-up created.",
            `intentId: ${intent.intentId}`,
            "mode: every",
            `cron: ${intent.cron ?? "none"}`,
            `nextRunAt: ${intent.nextRunAt ? formatISO(intent.nextRunAt) : "none"}`,
            `runs: ${intent.runCount}/${intent.maxRuns}`,
          ].join("\n"),
          {
            ok: true,
            intent,
          },
        );
      }

      if (params.action === "cancel") {
        const intentId = normalizeOptionalString(params.intentId);
        if (!intentId) {
          return failTextResult("Follow-up cancel rejected (missing_intent_id).", {
            ok: false,
            error: "missing_intent_id",
          });
        }

        const cancelled = await options.runtime.schedule.cancelIntent(sessionId, {
          intentId,
          reason: normalizeOptionalString(params.reason),
        });
        if (!cancelled.ok) {
          return failTextResult(`Follow-up cancel rejected (${cancelled.error}).`, {
            ok: false,
            error: cancelled.error ?? "unknown_error",
          });
        }
        return textResult(`Follow-up cancelled (${intentId}).`, {
          ok: true,
          intentId,
        });
      }

      const intents = await options.runtime.schedule.listIntents({
        parentSessionId: sessionId,
      });
      const snapshot = await options.runtime.schedule.getProjectionSnapshot();
      const header = [
        "[FollowUps]",
        `count: ${intents.length}`,
        "scope: session",
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
