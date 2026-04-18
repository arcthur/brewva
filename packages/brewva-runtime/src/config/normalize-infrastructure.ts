import type { BrewvaConfig } from "../contracts/index.js";
import {
  isRecord,
  normalizeBoolean,
  normalizeNonNegativeInteger,
  normalizeNonNegativeNumber,
  normalizeNonEmptyString,
  normalizePositiveInteger,
  normalizeUnitInterval,
} from "./normalization-shared.js";

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
  const contextBudgetInjectionInput = isRecord(contextBudgetInput.injection)
    ? contextBudgetInput.injection
    : {};
  const contextBudgetThresholdsInput = isRecord(contextBudgetInput.thresholds)
    ? contextBudgetInput.thresholds
    : {};
  const contextBudgetCompactionInput = isRecord(contextBudgetInput.compaction)
    ? contextBudgetInput.compaction
    : {};
  const contextBudgetArenaInput = isRecord(contextBudgetInput.arena)
    ? contextBudgetInput.arena
    : {};
  const toolFailureInjectionInput = isRecord(infrastructureInput.toolFailureInjection)
    ? infrastructureInput.toolFailureInjection
    : {};
  const toolOutputDistillationInjectionInput = isRecord(
    infrastructureInput.toolOutputDistillationInjection,
  )
    ? infrastructureInput.toolOutputDistillationInjection
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
  const defaultContextBudgetInjection = defaultContextBudget.injection;
  const defaultContextBudgetThresholds = defaultContextBudget.thresholds;
  const defaultContextCompaction = defaultContextBudget.compaction;
  const defaultContextArena = defaultContextBudget.arena;
  const defaultToolFailureInjection = defaults.toolFailureInjection;
  const defaultToolOutputDistillationInjection = defaults.toolOutputDistillationInjection;
  const normalizedInjectionBaseTokens = normalizePositiveInteger(
    contextBudgetInjectionInput.baseTokens,
    defaultContextBudgetInjection.baseTokens,
  );
  const normalizedInjectionMaxTokens = Math.max(
    normalizedInjectionBaseTokens,
    normalizePositiveInteger(
      contextBudgetInjectionInput.maxTokens,
      defaultContextBudgetInjection.maxTokens,
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
      injection: {
        baseTokens: normalizedInjectionBaseTokens,
        windowFraction: normalizeUnitInterval(
          contextBudgetInjectionInput.windowFraction,
          defaultContextBudgetInjection.windowFraction,
        ),
        maxTokens: normalizedInjectionMaxTokens,
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
        pressureBypassPercent: normalizeUnitInterval(
          contextBudgetCompactionInput.pressureBypassPercent,
          defaultContextCompaction.pressureBypassPercent,
        ),
      },
      arena: {
        maxEntriesPerSession: normalizePositiveInteger(
          contextBudgetArenaInput.maxEntriesPerSession,
          defaultContextArena.maxEntriesPerSession,
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
    toolOutputDistillationInjection: {
      enabled: normalizeBoolean(
        toolOutputDistillationInjectionInput.enabled,
        defaultToolOutputDistillationInjection.enabled,
      ),
      maxEntries: normalizePositiveInteger(
        toolOutputDistillationInjectionInput.maxEntries,
        defaultToolOutputDistillationInjection.maxEntries,
      ),
      maxOutputChars: normalizePositiveInteger(
        toolOutputDistillationInjectionInput.maxOutputChars,
        defaultToolOutputDistillationInjection.maxOutputChars,
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
