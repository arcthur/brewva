import type { BrewvaConfig, VerificationLevel } from "../types.js";

const VALID_COST_ACTIONS = new Set(["warn", "block_tools"]);
const VALID_SECURITY_MODES = new Set(["permissive", "standard", "strict"]);
const VALID_SECURITY_ENFORCEMENT_MODES = new Set(["off", "warn", "enforce", "inherit"]);
const VALID_EXECUTION_BACKENDS = new Set(["host", "sandbox", "best_available"]);
const VALID_EVENT_LEVELS = new Set(["audit", "ops", "debug"]);
const VALID_VERIFICATION_LEVELS = new Set<VerificationLevel>(["quick", "standard", "strict"]);
const VALID_CHANNEL_SCOPE_STRATEGIES = new Set(["chat", "thread"]);
const VALID_CHANNEL_ACL_MODES = new Set(["open", "closed"]);
const VALID_SKILL_CASCADE_MODES = new Set(["off", "assist", "auto"]);
const VALID_SKILL_CASCADE_SOURCES = new Set(["compose", "dispatch", "explicit"]);
const VALID_SKILL_SELECTOR_MODES = new Set(["deterministic", "external_only"]);

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function normalizeUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeNonEmptyString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeLowercaseStringArray(value: unknown, fallback: string[]): string[] {
  const normalized = normalizeStringArray(value, fallback)
    .map((entry) => entry.toLowerCase())
    .filter((entry) => entry.length > 0);
  return [...new Set(normalized)];
}

function normalizeVerificationLevel(
  value: unknown,
  fallback: VerificationLevel,
): VerificationLevel {
  return VALID_VERIFICATION_LEVELS.has(value as VerificationLevel)
    ? (value as VerificationLevel)
    : fallback;
}

function normalizeStrictStringEnum<T extends string>(
  value: unknown,
  fallback: T,
  validSet: Set<string>,
  fieldPath: string,
): T {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw new Error(
      `Invalid config value for ${fieldPath}: expected one of [${[...validSet].join(", ")}], received non-string.`,
    );
  }
  const normalized = value.trim();
  if (validSet.has(normalized)) {
    return normalized as T;
  }
  throw new Error(
    `Invalid config value for ${fieldPath}: expected one of [${[...validSet].join(", ")}], received "${value}".`,
  );
}

function normalizeStringRecord(
  value: unknown,
  fallback: Record<string, string>,
): Record<string, string> {
  if (!isRecord(value)) return { ...fallback };
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    out[key] = entry;
  }
  return out;
}

function normalizeSkillOverrides(
  value: unknown,
  fallback: BrewvaConfig["skills"]["overrides"],
): BrewvaConfig["skills"]["overrides"] {
  if (!isRecord(value)) return structuredClone(fallback);
  const out: BrewvaConfig["skills"]["overrides"] = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    out[key] = entry as BrewvaConfig["skills"]["overrides"][string];
  }
  return out;
}

function normalizeSkillCascadeSourceList(
  value: unknown,
  fallback: BrewvaConfig["skills"]["cascade"]["enabledSources"],
): BrewvaConfig["skills"]["cascade"]["enabledSources"] {
  if (!Array.isArray(value)) return [...fallback];
  const out: BrewvaConfig["skills"]["cascade"]["enabledSources"] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !VALID_SKILL_CASCADE_SOURCES.has(entry)) continue;
    const normalizedEntry = entry as BrewvaConfig["skills"]["cascade"]["enabledSources"][number];
    if (out.includes(normalizedEntry)) continue;
    out.push(normalizedEntry);
  }
  return out.length > 0 ? out : [...fallback];
}

export function normalizeBrewvaConfig(config: unknown, defaults: BrewvaConfig): BrewvaConfig {
  const input = isRecord(config) ? config : {};
  const uiInput = isRecord(input.ui) ? input.ui : {};
  const skillsInput = isRecord(input.skills) ? input.skills : {};
  const skillsSelectorInput = isRecord(skillsInput.selector) ? skillsInput.selector : {};
  const skillsCascadeInput = isRecord(skillsInput.cascade) ? skillsInput.cascade : {};
  const verificationInput = isRecord(input.verification) ? input.verification : {};
  const verificationChecksInput = isRecord(verificationInput.checks)
    ? verificationInput.checks
    : {};
  const ledgerInput = isRecord(input.ledger) ? input.ledger : {};
  const tapeInput = isRecord(input.tape) ? input.tape : {};
  const projectionInput = isRecord(input.projection) ? input.projection : {};
  const securityInput = isRecord(input.security) ? input.security : {};
  const securityEnforcementInput = isRecord(securityInput.enforcement)
    ? securityInput.enforcement
    : {};
  const securityExecutionInput = isRecord(securityInput.execution) ? securityInput.execution : {};
  const securityExecutionSandboxInput = isRecord(securityExecutionInput.sandbox)
    ? securityExecutionInput.sandbox
    : {};
  const scheduleInput = isRecord(input.schedule) ? input.schedule : {};
  const parallelInput = isRecord(input.parallel) ? input.parallel : {};
  const channelsInput = isRecord(input.channels) ? input.channels : {};
  const channelsOrchestrationInput = isRecord(channelsInput.orchestration)
    ? channelsInput.orchestration
    : {};
  const channelsOwnersInput = isRecord(channelsOrchestrationInput.owners)
    ? channelsOrchestrationInput.owners
    : {};
  const channelsLimitsInput = isRecord(channelsOrchestrationInput.limits)
    ? channelsOrchestrationInput.limits
    : {};
  const infrastructureInput = isRecord(input.infrastructure) ? input.infrastructure : {};
  const infrastructureEventsInput = isRecord(infrastructureInput.events)
    ? infrastructureInput.events
    : {};
  const contextBudgetInput = isRecord(infrastructureInput.contextBudget)
    ? infrastructureInput.contextBudget
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
  const turnWalInput = isRecord(infrastructureInput.turnWal) ? infrastructureInput.turnWal : {};

  const defaultContextBudget = defaults.infrastructure.contextBudget;
  const defaultToolFailureInjection = defaults.infrastructure.toolFailureInjection;
  const defaultToolOutputDistillationInjection =
    defaults.infrastructure.toolOutputDistillationInjection;
  const defaultContextCompaction = defaultContextBudget.compaction;
  const defaultContextArena = defaultContextBudget.arena;
  const normalizedHardLimitPercent = normalizeUnitInterval(
    contextBudgetInput.hardLimitPercent,
    defaultContextBudget.hardLimitPercent,
  );
  const normalizedCompactionThresholdPercent = Math.min(
    normalizeUnitInterval(
      contextBudgetInput.compactionThresholdPercent,
      defaultContextBudget.compactionThresholdPercent,
    ),
    normalizedHardLimitPercent,
  );
  const normalizedSecurityMode = VALID_SECURITY_MODES.has(securityInput.mode as string)
    ? (securityInput.mode as BrewvaConfig["security"]["mode"])
    : defaults.security.mode;
  const normalizedExecutionEnforceIsolation = normalizeBoolean(
    securityExecutionInput.enforceIsolation,
    defaults.security.execution.enforceIsolation,
  );
  const configuredExecutionBackend = VALID_EXECUTION_BACKENDS.has(
    securityExecutionInput.backend as string,
  )
    ? (securityExecutionInput.backend as BrewvaConfig["security"]["execution"]["backend"])
    : defaults.security.execution.backend;
  const normalizedExecutionBackend = normalizedExecutionEnforceIsolation
    ? "sandbox"
    : normalizedSecurityMode === "strict"
      ? "sandbox"
      : configuredExecutionBackend;
  const normalizedExecutionFallback =
    normalizedExecutionEnforceIsolation || normalizedSecurityMode === "strict"
      ? false
      : normalizeBoolean(
          securityExecutionInput.fallbackToHost,
          defaults.security.execution.fallbackToHost,
        );
  const normalizedCascadeSourcePriority = normalizeSkillCascadeSourceList(
    skillsCascadeInput.sourcePriority,
    defaults.skills.cascade.sourcePriority,
  );
  const normalizedCascadeEnabledSources = normalizeSkillCascadeSourceList(
    skillsCascadeInput.enabledSources,
    defaults.skills.cascade.enabledSources,
  );
  const effectiveCascadeSourcePriority = [
    ...normalizedCascadeSourcePriority.filter((source) =>
      normalizedCascadeEnabledSources.includes(source),
    ),
    ...normalizedCascadeEnabledSources.filter(
      (source) => !normalizedCascadeSourcePriority.includes(source),
    ),
  ] as BrewvaConfig["skills"]["cascade"]["sourcePriority"];

  return {
    ui: {
      quietStartup: normalizeBoolean(uiInput.quietStartup, defaults.ui.quietStartup),
    },
    skills: {
      roots: normalizeStringArray(skillsInput.roots, defaults.skills.roots ?? []),
      packs: normalizeStringArray(skillsInput.packs, defaults.skills.packs),
      disabled: normalizeStringArray(skillsInput.disabled, defaults.skills.disabled),
      overrides: normalizeSkillOverrides(skillsInput.overrides, defaults.skills.overrides),
      selector: {
        mode: normalizeStrictStringEnum(
          skillsSelectorInput.mode,
          defaults.skills.selector.mode,
          VALID_SKILL_SELECTOR_MODES,
          "skills.selector.mode",
        ),
        k: normalizePositiveInteger(skillsSelectorInput.k, defaults.skills.selector.k),
      },
      cascade: {
        mode: normalizeStrictStringEnum(
          skillsCascadeInput.mode,
          defaults.skills.cascade.mode,
          VALID_SKILL_CASCADE_MODES,
          "skills.cascade.mode",
        ),
        enabledSources: normalizedCascadeEnabledSources,
        sourcePriority: effectiveCascadeSourcePriority,
        maxStepsPerRun: normalizePositiveInteger(
          skillsCascadeInput.maxStepsPerRun,
          defaults.skills.cascade.maxStepsPerRun,
        ),
      },
    },
    verification: {
      defaultLevel: normalizeVerificationLevel(
        verificationInput.defaultLevel,
        defaults.verification.defaultLevel,
      ),
      checks: {
        quick: normalizeStringArray(
          verificationChecksInput.quick,
          defaults.verification.checks.quick,
        ),
        standard: normalizeStringArray(
          verificationChecksInput.standard,
          defaults.verification.checks.standard,
        ),
        strict: normalizeStringArray(
          verificationChecksInput.strict,
          defaults.verification.checks.strict,
        ),
      },
      commands: normalizeStringRecord(verificationInput.commands, defaults.verification.commands),
    },
    ledger: {
      path: normalizeNonEmptyString(ledgerInput.path, defaults.ledger.path),
      checkpointEveryTurns: normalizeNonNegativeInteger(
        ledgerInput.checkpointEveryTurns,
        defaults.ledger.checkpointEveryTurns,
      ),
    },
    tape: {
      checkpointIntervalEntries: normalizeNonNegativeInteger(
        tapeInput.checkpointIntervalEntries,
        defaults.tape.checkpointIntervalEntries,
      ),
    },
    projection: {
      enabled: normalizeBoolean(projectionInput.enabled, defaults.projection.enabled),
      dir: normalizeNonEmptyString(projectionInput.dir, defaults.projection.dir),
      workingFile: normalizeNonEmptyString(
        projectionInput.workingFile,
        defaults.projection.workingFile,
      ),
      maxWorkingChars: normalizePositiveInteger(
        projectionInput.maxWorkingChars,
        defaults.projection.maxWorkingChars,
      ),
    },
    security: {
      mode: normalizedSecurityMode,
      sanitizeContext: normalizeBoolean(
        securityInput.sanitizeContext,
        defaults.security.sanitizeContext,
      ),
      enforcement: {
        allowedToolsMode: normalizeStrictStringEnum(
          securityEnforcementInput.allowedToolsMode,
          defaults.security.enforcement.allowedToolsMode,
          VALID_SECURITY_ENFORCEMENT_MODES,
          "security.enforcement.allowedToolsMode",
        ),
        skillMaxTokensMode: normalizeStrictStringEnum(
          securityEnforcementInput.skillMaxTokensMode,
          defaults.security.enforcement.skillMaxTokensMode,
          VALID_SECURITY_ENFORCEMENT_MODES,
          "security.enforcement.skillMaxTokensMode",
        ),
        skillMaxToolCallsMode: normalizeStrictStringEnum(
          securityEnforcementInput.skillMaxToolCallsMode,
          defaults.security.enforcement.skillMaxToolCallsMode,
          VALID_SECURITY_ENFORCEMENT_MODES,
          "security.enforcement.skillMaxToolCallsMode",
        ),
        skillMaxParallelMode: normalizeStrictStringEnum(
          securityEnforcementInput.skillMaxParallelMode,
          defaults.security.enforcement.skillMaxParallelMode,
          VALID_SECURITY_ENFORCEMENT_MODES,
          "security.enforcement.skillMaxParallelMode",
        ),
        skillDispatchGateMode: normalizeStrictStringEnum(
          securityEnforcementInput.skillDispatchGateMode,
          defaults.security.enforcement.skillDispatchGateMode,
          VALID_SECURITY_ENFORCEMENT_MODES,
          "security.enforcement.skillDispatchGateMode",
        ),
      },
      execution: {
        backend: normalizedExecutionBackend,
        enforceIsolation: normalizedExecutionEnforceIsolation,
        fallbackToHost: normalizedExecutionFallback,
        commandDenyList: normalizeLowercaseStringArray(
          securityExecutionInput.commandDenyList,
          defaults.security.execution.commandDenyList,
        ),
        sandbox: {
          serverUrl:
            normalizeOptionalNonEmptyString(securityExecutionSandboxInput.serverUrl) ??
            defaults.security.execution.sandbox.serverUrl,
          apiKey:
            normalizeOptionalNonEmptyString(securityExecutionSandboxInput.apiKey) ??
            defaults.security.execution.sandbox.apiKey,
          defaultImage:
            normalizeOptionalNonEmptyString(securityExecutionSandboxInput.defaultImage) ??
            defaults.security.execution.sandbox.defaultImage,
          memory: normalizePositiveInteger(
            securityExecutionSandboxInput.memory,
            defaults.security.execution.sandbox.memory,
          ),
          cpus: normalizePositiveInteger(
            securityExecutionSandboxInput.cpus,
            defaults.security.execution.sandbox.cpus,
          ),
          timeout: normalizePositiveInteger(
            securityExecutionSandboxInput.timeout,
            defaults.security.execution.sandbox.timeout,
          ),
        },
      },
    },
    schedule: {
      enabled: normalizeBoolean(scheduleInput.enabled, defaults.schedule.enabled),
      projectionPath: normalizeNonEmptyString(
        scheduleInput.projectionPath,
        defaults.schedule.projectionPath,
      ),
      leaseDurationMs: normalizePositiveInteger(
        scheduleInput.leaseDurationMs,
        defaults.schedule.leaseDurationMs,
      ),
      maxActiveIntentsPerSession: normalizePositiveInteger(
        scheduleInput.maxActiveIntentsPerSession,
        defaults.schedule.maxActiveIntentsPerSession,
      ),
      maxActiveIntentsGlobal: normalizePositiveInteger(
        scheduleInput.maxActiveIntentsGlobal,
        defaults.schedule.maxActiveIntentsGlobal,
      ),
      minIntervalMs: normalizePositiveInteger(
        scheduleInput.minIntervalMs,
        defaults.schedule.minIntervalMs,
      ),
      maxConsecutiveErrors: normalizePositiveInteger(
        scheduleInput.maxConsecutiveErrors,
        defaults.schedule.maxConsecutiveErrors,
      ),
      maxRecoveryCatchUps: normalizePositiveInteger(
        scheduleInput.maxRecoveryCatchUps,
        defaults.schedule.maxRecoveryCatchUps,
      ),
    },
    parallel: {
      enabled: normalizeBoolean(parallelInput.enabled, defaults.parallel.enabled),
      maxConcurrent: normalizePositiveInteger(
        parallelInput.maxConcurrent,
        defaults.parallel.maxConcurrent,
      ),
    },
    channels: {
      orchestration: {
        enabled: normalizeBoolean(
          channelsOrchestrationInput.enabled,
          defaults.channels.orchestration.enabled,
        ),
        scopeStrategy: VALID_CHANNEL_SCOPE_STRATEGIES.has(
          channelsOrchestrationInput.scopeStrategy as string,
        )
          ? (channelsOrchestrationInput.scopeStrategy as BrewvaConfig["channels"]["orchestration"]["scopeStrategy"])
          : defaults.channels.orchestration.scopeStrategy,
        aclModeWhenOwnersEmpty: VALID_CHANNEL_ACL_MODES.has(
          channelsOrchestrationInput.aclModeWhenOwnersEmpty as string,
        )
          ? (channelsOrchestrationInput.aclModeWhenOwnersEmpty as BrewvaConfig["channels"]["orchestration"]["aclModeWhenOwnersEmpty"])
          : defaults.channels.orchestration.aclModeWhenOwnersEmpty,
        owners: {
          telegram: normalizeStringArray(
            channelsOwnersInput.telegram,
            defaults.channels.orchestration.owners.telegram,
          ),
        },
        limits: {
          fanoutMaxAgents: normalizePositiveInteger(
            channelsLimitsInput.fanoutMaxAgents,
            defaults.channels.orchestration.limits.fanoutMaxAgents,
          ),
          maxDiscussionRounds: normalizePositiveInteger(
            channelsLimitsInput.maxDiscussionRounds,
            defaults.channels.orchestration.limits.maxDiscussionRounds,
          ),
          a2aMaxDepth: normalizePositiveInteger(
            channelsLimitsInput.a2aMaxDepth,
            defaults.channels.orchestration.limits.a2aMaxDepth,
          ),
          a2aMaxHops: normalizePositiveInteger(
            channelsLimitsInput.a2aMaxHops,
            defaults.channels.orchestration.limits.a2aMaxHops,
          ),
          maxLiveRuntimes: normalizePositiveInteger(
            channelsLimitsInput.maxLiveRuntimes,
            defaults.channels.orchestration.limits.maxLiveRuntimes,
          ),
          idleRuntimeTtlMs: normalizePositiveInteger(
            channelsLimitsInput.idleRuntimeTtlMs,
            defaults.channels.orchestration.limits.idleRuntimeTtlMs,
          ),
        },
      },
    },
    infrastructure: {
      events: {
        enabled: normalizeBoolean(
          infrastructureEventsInput.enabled,
          defaults.infrastructure.events.enabled,
        ),
        dir: normalizeNonEmptyString(
          infrastructureEventsInput.dir,
          defaults.infrastructure.events.dir,
        ),
        level: VALID_EVENT_LEVELS.has(infrastructureEventsInput.level as string)
          ? (infrastructureEventsInput.level as BrewvaConfig["infrastructure"]["events"]["level"])
          : defaults.infrastructure.events.level,
      },
      contextBudget: {
        enabled: normalizeBoolean(contextBudgetInput.enabled, defaultContextBudget.enabled),
        maxInjectionTokens: normalizePositiveInteger(
          contextBudgetInput.maxInjectionTokens,
          defaultContextBudget.maxInjectionTokens,
        ),
        compactionThresholdPercent: normalizedCompactionThresholdPercent,
        hardLimitPercent: normalizedHardLimitPercent,
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
        enabled: normalizeBoolean(
          interruptRecoveryInput.enabled,
          defaults.infrastructure.interruptRecovery.enabled,
        ),
        gracefulTimeoutMs: normalizePositiveInteger(
          interruptRecoveryInput.gracefulTimeoutMs,
          defaults.infrastructure.interruptRecovery.gracefulTimeoutMs,
        ),
      },
      costTracking: {
        enabled: normalizeBoolean(
          costTrackingInput.enabled,
          defaults.infrastructure.costTracking.enabled,
        ),
        maxCostUsdPerSession: normalizeNonNegativeNumber(
          costTrackingInput.maxCostUsdPerSession,
          defaults.infrastructure.costTracking.maxCostUsdPerSession,
        ),
        alertThresholdRatio: normalizeUnitInterval(
          costTrackingInput.alertThresholdRatio,
          defaults.infrastructure.costTracking.alertThresholdRatio,
        ),
        actionOnExceed: VALID_COST_ACTIONS.has(costTrackingInput.actionOnExceed as string)
          ? (costTrackingInput.actionOnExceed as BrewvaConfig["infrastructure"]["costTracking"]["actionOnExceed"])
          : defaults.infrastructure.costTracking.actionOnExceed,
      },
      turnWal: {
        enabled: normalizeBoolean(turnWalInput.enabled, defaults.infrastructure.turnWal.enabled),
        dir: normalizeNonEmptyString(turnWalInput.dir, defaults.infrastructure.turnWal.dir),
        defaultTtlMs: normalizePositiveInteger(
          turnWalInput.defaultTtlMs,
          defaults.infrastructure.turnWal.defaultTtlMs,
        ),
        maxRetries: normalizeNonNegativeInteger(
          turnWalInput.maxRetries,
          defaults.infrastructure.turnWal.maxRetries,
        ),
        compactAfterMs: normalizePositiveInteger(
          turnWalInput.compactAfterMs,
          defaults.infrastructure.turnWal.compactAfterMs,
        ),
        scheduleTurnTtlMs: normalizePositiveInteger(
          turnWalInput.scheduleTurnTtlMs,
          defaults.infrastructure.turnWal.scheduleTurnTtlMs,
        ),
      },
    },
  };
}
