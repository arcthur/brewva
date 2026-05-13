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
  const contextBudgetDynamicTailInput = isRecord(contextBudgetInput.dynamicTail)
    ? contextBudgetInput.dynamicTail
    : {};
  const contextBudgetThresholdsInput = isRecord(contextBudgetInput.thresholds)
    ? contextBudgetInput.thresholds
    : {};
  const contextBudgetPredictiveTurnGrowthInput = isRecord(contextBudgetInput.predictiveTurnGrowth)
    ? contextBudgetInput.predictiveTurnGrowth
    : {};
  const contextBudgetModelPhysicsInput = isRecord(contextBudgetInput.modelPhysics)
    ? contextBudgetInput.modelPhysics
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
  const defaultContextBudgetDynamicTail = defaultContextBudget.dynamicTail;
  const defaultContextBudgetThresholds = defaultContextBudget.thresholds;
  const defaultContextBudgetPredictiveTurnGrowth = defaultContextBudget.predictiveTurnGrowth;
  const defaultContextBudgetModelPhysics = defaultContextBudget.modelPhysics;
  const defaultContextCompaction = defaultContextBudget.compaction;
  const defaultToolFailureInjection = defaults.toolFailureInjection;
  const normalizedDynamicTailBaseTokens = normalizePositiveInteger(
    contextBudgetDynamicTailInput.baseTokens,
    defaultContextBudgetDynamicTail.baseTokens,
  );
  const normalizedDynamicTailMaxTokens = Math.max(
    normalizedDynamicTailBaseTokens,
    normalizePositiveInteger(
      contextBudgetDynamicTailInput.maxTokens,
      defaultContextBudgetDynamicTail.maxTokens,
    ),
  );
  const normalizedHardLimitFloorPercent = normalizeUnitInterval(
    contextBudgetThresholdsInput.hardLimitFloorPercent,
    defaultContextBudgetThresholds.hardLimitFloorPercent,
  );
  const normalizedHardLimitCeilingPercent = Math.max(
    normalizedHardLimitFloorPercent,
    normalizeUnitInterval(
      contextBudgetThresholdsInput.hardLimitCeilingPercent,
      defaultContextBudgetThresholds.hardLimitCeilingPercent,
    ),
  );
  const normalizedCompactionFloorPercent = Math.min(
    normalizedHardLimitFloorPercent,
    normalizeUnitInterval(
      contextBudgetThresholdsInput.compactionFloorPercent,
      defaultContextBudgetThresholds.compactionFloorPercent,
    ),
  );
  const normalizedCompactionCeilingPercent = Math.min(
    normalizedHardLimitCeilingPercent,
    Math.max(
      normalizedCompactionFloorPercent,
      normalizeUnitInterval(
        contextBudgetThresholdsInput.compactionCeilingPercent,
        defaultContextBudgetThresholds.compactionCeilingPercent,
      ),
    ),
  );
  const normalizedPredictiveFloorContextWindow = normalizePositiveInteger(
    contextBudgetPredictiveTurnGrowthInput.floorContextWindow,
    defaultContextBudgetPredictiveTurnGrowth.floorContextWindow,
  );
  const normalizedPredictiveStandardTokens = normalizePositiveInteger(
    contextBudgetPredictiveTurnGrowthInput.standardTokens,
    defaultContextBudgetPredictiveTurnGrowth.standardTokens,
  );
  const normalizedPredictiveLargeTokens = Math.max(
    normalizedPredictiveStandardTokens,
    normalizePositiveInteger(
      contextBudgetPredictiveTurnGrowthInput.largeTokens,
      defaultContextBudgetPredictiveTurnGrowth.largeTokens,
    ),
  );

  return {
    events: {
      enabled: normalizeBoolean(infrastructureEventsInput.enabled, defaults.events.enabled),
      dir: normalizeNonEmptyString(infrastructureEventsInput.dir, defaults.events.dir),
      level: VALID_EVENT_LEVELS.has(infrastructureEventsInput.level as string)
        ? (infrastructureEventsInput.level as BrewvaConfig["infrastructure"]["events"]["level"])
        : defaults.events.level,
    },
    contextBudget: {
      enabled: normalizeBoolean(contextBudgetInput.enabled, defaultContextBudget.enabled),
      dynamicTail: {
        baseTokens: normalizedDynamicTailBaseTokens,
        windowFraction: normalizeUnitInterval(
          contextBudgetDynamicTailInput.windowFraction,
          defaultContextBudgetDynamicTail.windowFraction,
        ),
        maxTokens: normalizedDynamicTailMaxTokens,
        consequenceDigestMaxChars: normalizePositiveInteger(
          contextBudgetDynamicTailInput.consequenceDigestMaxChars,
          defaultContextBudgetDynamicTail.consequenceDigestMaxChars,
        ),
      },
      thresholds: {
        compactionFloorPercent: normalizedCompactionFloorPercent,
        compactionCeilingPercent: normalizedCompactionCeilingPercent,
        compactionHeadroomTokens: normalizePositiveInteger(
          contextBudgetThresholdsInput.compactionHeadroomTokens,
          defaultContextBudgetThresholds.compactionHeadroomTokens,
        ),
        hardLimitFloorPercent: normalizedHardLimitFloorPercent,
        hardLimitCeilingPercent: normalizedHardLimitCeilingPercent,
        hardLimitHeadroomTokens: normalizePositiveInteger(
          contextBudgetThresholdsInput.hardLimitHeadroomTokens,
          defaultContextBudgetThresholds.hardLimitHeadroomTokens,
        ),
      },
      predictiveTurnGrowth: {
        floorContextWindow: normalizedPredictiveFloorContextWindow,
        largeContextWindow: Math.max(
          normalizedPredictiveFloorContextWindow,
          normalizePositiveInteger(
            contextBudgetPredictiveTurnGrowthInput.largeContextWindow,
            defaultContextBudgetPredictiveTurnGrowth.largeContextWindow,
          ),
        ),
        standardTokens: normalizedPredictiveStandardTokens,
        largeTokens: normalizedPredictiveLargeTokens,
        scalingFactor: normalizeUnitInterval(
          contextBudgetPredictiveTurnGrowthInput.scalingFactor,
          defaultContextBudgetPredictiveTurnGrowth.scalingFactor,
        ),
      },
      modelPhysics: {
        effectiveContextWindowPercent: Math.max(
          0.01,
          normalizeUnitInterval(
            contextBudgetModelPhysicsInput.effectiveContextWindowPercent,
            defaultContextBudgetModelPhysics.effectiveContextWindowPercent,
          ),
        ),
        autoCompactLimitRatio: Math.max(
          0.01,
          normalizeUnitInterval(
            contextBudgetModelPhysicsInput.autoCompactLimitRatio,
            defaultContextBudgetModelPhysics.autoCompactLimitRatio,
          ),
        ),
        controllableBaselineTokens: normalizeNonNegativeInteger(
          contextBudgetModelPhysicsInput.controllableBaselineTokens,
          defaultContextBudgetModelPhysics.controllableBaselineTokens,
        ),
      },
      compactionInstructions: normalizeNonEmptyString(
        contextBudgetInput.compactionInstructions,
        defaultContextBudget.compactionInstructions,
      ),
      compaction: {
        minTurnsBetween: normalizeNonNegativeInteger(
          contextBudgetCompactionInput.minTurnsBetween,
          defaultContextCompaction.minTurnsBetween,
        ),
        minSecondsBetween: normalizeNonNegativeInteger(
          contextBudgetCompactionInput.minSecondsBetween,
          defaultContextCompaction.minSecondsBetween,
        ),
        cooldownBypassPercent: normalizeUnitInterval(
          contextBudgetCompactionInput.cooldownBypassPercent,
          defaultContextCompaction.cooldownBypassPercent,
        ),
        summaryMaxOutputRatio: normalizeUnitInterval(
          contextBudgetCompactionInput.summaryMaxOutputRatio,
          defaultContextCompaction.summaryMaxOutputRatio,
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
