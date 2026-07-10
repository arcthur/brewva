import { asBrewvaIntentId, asBrewvaSessionId } from "../core/index.js";
import {
  isRecord,
  normalizeBoolean,
  normalizeNonEmptyString,
  normalizeOptionalNonEmptyString,
  normalizePositiveInteger,
  normalizeStrictStringEnum,
  normalizeStringArray,
  type AnyRecord,
} from "./normalization-shared.js";
import type { BrewvaConfig } from "./types.js";

const VALID_SCHEDULE_CONTINUITY_MODES = new Set(["inherit", "fresh"]);

export function normalizeScheduleConfig(
  scheduleInput: AnyRecord,
  defaults: BrewvaConfig["schedule"],
): BrewvaConfig["schedule"] {
  const selfImproveInput = isRecord(scheduleInput.selfImprove) ? scheduleInput.selfImprove : {};
  return {
    enabled: normalizeBoolean(scheduleInput.enabled, defaults.enabled),
    projectionPath: normalizeNonEmptyString(scheduleInput.projectionPath, defaults.projectionPath),
    leaseDurationMs: normalizePositiveInteger(
      scheduleInput.leaseDurationMs,
      defaults.leaseDurationMs,
    ),
    maxActiveIntentsPerSession: normalizePositiveInteger(
      scheduleInput.maxActiveIntentsPerSession,
      defaults.maxActiveIntentsPerSession,
    ),
    maxActiveIntentsGlobal: normalizePositiveInteger(
      scheduleInput.maxActiveIntentsGlobal,
      defaults.maxActiveIntentsGlobal,
    ),
    minIntervalMs: normalizePositiveInteger(scheduleInput.minIntervalMs, defaults.minIntervalMs),
    maxConsecutiveErrors: normalizePositiveInteger(
      scheduleInput.maxConsecutiveErrors,
      defaults.maxConsecutiveErrors,
    ),
    maxRecoveryCatchUps: normalizePositiveInteger(
      scheduleInput.maxRecoveryCatchUps,
      defaults.maxRecoveryCatchUps,
    ),
    staleOneShotRecoveryThresholdMs: normalizePositiveInteger(
      scheduleInput.staleOneShotRecoveryThresholdMs,
      defaults.staleOneShotRecoveryThresholdMs,
    ),
    selfImprove: {
      enabled: normalizeBoolean(selfImproveInput.enabled, defaults.selfImprove.enabled),
      // Absence inherits the default; an unrecognized explicit value fails
      // CLOSED to "suspend" (garbage must never grant the envelope).
      approvalMode:
        selfImproveInput.approvalMode === undefined
          ? defaults.selfImprove.approvalMode
          : selfImproveInput.approvalMode === "auto_within_envelope"
            ? "auto_within_envelope"
            : "suspend",
      parentSessionId: asBrewvaSessionId(
        normalizeNonEmptyString(
          selfImproveInput.parentSessionId,
          defaults.selfImprove.parentSessionId,
        ),
      ),
      intentId: asBrewvaIntentId(
        normalizeNonEmptyString(selfImproveInput.intentId, defaults.selfImprove.intentId),
      ),
      reason: normalizeNonEmptyString(selfImproveInput.reason, defaults.selfImprove.reason),
      goalRef: normalizeNonEmptyString(selfImproveInput.goalRef, defaults.selfImprove.goalRef),
      continuityMode: normalizeStrictStringEnum(
        selfImproveInput.continuityMode,
        defaults.selfImprove.continuityMode,
        VALID_SCHEDULE_CONTINUITY_MODES,
        "schedule.selfImprove.continuityMode",
      ),
      cron: normalizeNonEmptyString(selfImproveInput.cron, defaults.selfImprove.cron),
      timeZone:
        normalizeOptionalNonEmptyString(selfImproveInput.timeZone) ?? defaults.selfImprove.timeZone,
      maxRuns: normalizePositiveInteger(selfImproveInput.maxRuns, defaults.selfImprove.maxRuns),
      taskSpec: {
        goal: normalizeNonEmptyString(
          isRecord(selfImproveInput.taskSpec) ? selfImproveInput.taskSpec.goal : undefined,
          defaults.selfImprove.taskSpec.goal,
        ),
        expectedBehavior:
          normalizeOptionalNonEmptyString(
            isRecord(selfImproveInput.taskSpec)
              ? selfImproveInput.taskSpec.expectedBehavior
              : undefined,
          ) ?? defaults.selfImprove.taskSpec.expectedBehavior,
        constraints: normalizeStringArray(
          isRecord(selfImproveInput.taskSpec) ? selfImproveInput.taskSpec.constraints : undefined,
          defaults.selfImprove.taskSpec.constraints ?? [],
        ),
      },
    },
  };
}
