import {
  isRecord,
  normalizeBoolean,
  normalizeNonNegativeInteger,
  normalizeNonNegativeNumber,
  normalizeNonEmptyString,
  normalizePositiveInteger,
  normalizeStringArray,
  normalizeUnitInterval,
} from "./normalization-shared.js";
import type { BrewvaConfig } from "./types.js";

const VALID_COST_ACTIONS = new Set(["warn", "block_tools"]);
const VALID_EVENT_LEVELS = new Set(["audit", "ops", "debug"]);

export function normalizeInfrastructureConfig(
  infrastructureInput: Record<string, unknown>,
  defaults: BrewvaConfig["infrastructure"],
): BrewvaConfig["infrastructure"] {
  const infrastructureEventsInput = isRecord(infrastructureInput.events)
    ? infrastructureInput.events
    : {};
  const contextBudgetInput = isRecord(infrastructureInput.contextBudget)
    ? infrastructureInput.contextBudget
    : {};
  const contextBudgetThresholdsInput = isRecord(contextBudgetInput.thresholds)
    ? contextBudgetInput.thresholds
    : {};
  const contextBudgetCompactionInput = isRecord(contextBudgetInput.compaction)
    ? contextBudgetInput.compaction
    : {};
  const toolFailureInjectionInput = isRecord(infrastructureInput.toolFailureInjection)
    ? infrastructureInput.toolFailureInjection
    : {};
  const interruptRecoveryInput = isRecord(infrastructureInput.interruptRecovery)
    ? infrastructureInput.interruptRecovery
    : {};
  const costTrackingInput = isRecord(infrastructureInput.costTracking)
    ? infrastructureInput.costTracking
    : {};
  const recoveryWalInput = isRecord(infrastructureInput.recoveryWal)
    ? infrastructureInput.recoveryWal
    : {};
  const defaultContextBudget = defaults.contextBudget;
  const defaultContextBudgetThresholds = defaultContextBudget.thresholds;
  const defaultContextCompaction = defaultContextBudget.compaction;
  const defaultToolFailureInjection = defaults.toolFailureInjection;
  const normalizedHardRatio = normalizeUnitInterval(
    contextBudgetThresholdsInput.hardRatio,
    defaultContextBudgetThresholds.hardRatio,
  );
  const normalizedAdvisoryRatio = Math.min(
    normalizedHardRatio,
    normalizeUnitInterval(
      contextBudgetThresholdsInput.advisoryRatio,
      defaultContextBudgetThresholds.advisoryRatio,
    ),
  );

  return {
    events: {
      enabled: normalizeBoolean(infrastructureEventsInput.enabled, defaults.events.enabled),
      level: VALID_EVENT_LEVELS.has(infrastructureEventsInput.level as string)
        ? (infrastructureEventsInput.level as BrewvaConfig["infrastructure"]["events"]["level"])
        : defaults.events.level,
    },
    contextBudget: {
      enabled: normalizeBoolean(contextBudgetInput.enabled, defaultContextBudget.enabled),
      thresholds: {
        hardRatio: normalizedHardRatio,
        advisoryRatio: normalizedAdvisoryRatio,
        headroomTokens: normalizeNonNegativeInteger(
          contextBudgetThresholdsInput.headroomTokens,
          defaultContextBudgetThresholds.headroomTokens,
        ),
      },
      dynamicTailTokens: normalizePositiveInteger(
        contextBudgetInput.dynamicTailTokens,
        defaultContextBudget.dynamicTailTokens,
      ),
      predictedTurnGrowthTokens: normalizeNonNegativeInteger(
        contextBudgetInput.predictedTurnGrowthTokens,
        defaultContextBudget.predictedTurnGrowthTokens,
      ),
      providerCacheStalenessMs: normalizePositiveInteger(
        contextBudgetInput.providerCacheStalenessMs,
        defaultContextBudget.providerCacheStalenessMs,
      ),
      consequenceDigestMaxChars: normalizePositiveInteger(
        contextBudgetInput.consequenceDigestMaxChars,
        defaultContextBudget.consequenceDigestMaxChars,
      ),
      compactionInstructions: normalizeNonEmptyString(
        contextBudgetInput.compactionInstructions,
        defaultContextBudget.compactionInstructions,
      ),
      compaction: {
        minTurnsBetween: normalizeNonNegativeInteger(
          contextBudgetCompactionInput.minTurnsBetween,
          defaultContextCompaction.minTurnsBetween,
        ),
        protectedTools: normalizeStringArray(
          contextBudgetCompactionInput.protectedTools,
          defaultContextCompaction.protectedTools,
        ),
        tailProtectTokens: normalizeNonNegativeInteger(
          contextBudgetCompactionInput.tailProtectTokens,
          defaultContextCompaction.tailProtectTokens,
        ),
      },
    },
    toolFailureInjection: {
      enabled: normalizeBoolean(
        toolFailureInjectionInput.enabled,
        defaultToolFailureInjection.enabled,
      ),
      maxEntries: normalizePositiveInteger(
        toolFailureInjectionInput.maxEntries,
        defaultToolFailureInjection.maxEntries,
      ),
      maxOutputChars: normalizePositiveInteger(
        toolFailureInjectionInput.maxOutputChars,
        defaultToolFailureInjection.maxOutputChars,
      ),
    },
    interruptRecovery: {
      enabled: normalizeBoolean(interruptRecoveryInput.enabled, defaults.interruptRecovery.enabled),
      gracefulTimeoutMs: normalizePositiveInteger(
        interruptRecoveryInput.gracefulTimeoutMs,
        defaults.interruptRecovery.gracefulTimeoutMs,
      ),
    },
    costTracking: {
      enabled: normalizeBoolean(costTrackingInput.enabled, defaults.costTracking.enabled),
      maxCostUsdPerSession: normalizeNonNegativeNumber(
        costTrackingInput.maxCostUsdPerSession,
        defaults.costTracking.maxCostUsdPerSession,
      ),
      alertThresholdRatio: normalizeUnitInterval(
        costTrackingInput.alertThresholdRatio,
        defaults.costTracking.alertThresholdRatio,
      ),
      actionOnExceed: VALID_COST_ACTIONS.has(costTrackingInput.actionOnExceed as string)
        ? (costTrackingInput.actionOnExceed as BrewvaConfig["infrastructure"]["costTracking"]["actionOnExceed"])
        : defaults.costTracking.actionOnExceed,
    },
    recoveryWal: {
      enabled: normalizeBoolean(recoveryWalInput.enabled, defaults.recoveryWal.enabled),
      dir: normalizeNonEmptyString(recoveryWalInput.dir, defaults.recoveryWal.dir),
      defaultTtlMs: normalizePositiveInteger(
        recoveryWalInput.defaultTtlMs,
        defaults.recoveryWal.defaultTtlMs,
      ),
      maxRetries: normalizeNonNegativeInteger(
        recoveryWalInput.maxRetries,
        defaults.recoveryWal.maxRetries,
      ),
      compactAfterMs: normalizePositiveInteger(
        recoveryWalInput.compactAfterMs,
        defaults.recoveryWal.compactAfterMs,
      ),
      scheduleTurnTtlMs: normalizePositiveInteger(
        recoveryWalInput.scheduleTurnTtlMs,
        defaults.recoveryWal.scheduleTurnTtlMs,
      ),
      toolTurnTtlMs: normalizePositiveInteger(
        recoveryWalInput.toolTurnTtlMs,
        defaults.recoveryWal.toolTurnTtlMs,
      ),
    },
  };
}
