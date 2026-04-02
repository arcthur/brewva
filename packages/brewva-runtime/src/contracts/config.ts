import type { SecurityEnforcementPreference, VerificationLevel } from "./shared.js";
import type { SkillContractOverride, SkillRoutingScope } from "./skill.js";

export interface BrewvaSecurityBoundaryNetworkRule {
  host: string;
  ports: number[];
}

export interface BrewvaSecurityBoundaryPolicy {
  commandDenyList: string[];
  filesystem: {
    readAllow: string[];
    writeAllow: string[];
    writeDeny: string[];
  };
  network: {
    mode: "inherit" | "deny" | "allowlist";
    allowLoopback: boolean;
    outbound: BrewvaSecurityBoundaryNetworkRule[];
  };
}

export interface BrewvaSecurityCredentialBinding {
  toolNames: string[];
  envVar: string;
  credentialRef: string;
}

export interface BrewvaSecurityCredentialsConfig {
  path: string;
  masterKeyEnv: string;
  allowDerivedKeyFallback: boolean;
  sandboxApiKeyRef?: string;
  gatewayTokenRef?: string;
  bindings: BrewvaSecurityCredentialBinding[];
}

export interface BrewvaSecurityExactCallLoopConfig {
  enabled: boolean;
  threshold: number;
  mode: "warn" | "block";
  exemptTools: string[];
}

export interface BrewvaConfig {
  ui: {
    quietStartup: boolean;
  };
  skills: {
    roots?: string[];
    disabled: string[];
    overrides: Record<string, SkillContractOverride>;
    routing: {
      enabled: boolean;
      scopes: SkillRoutingScope[];
    };
  };
  verification: {
    defaultLevel: VerificationLevel;
    checks: Record<VerificationLevel, string[]>;
    commands: Record<string, string>;
  };
  ledger: { path: string; checkpointEveryTurns: number };
  tape: {
    checkpointIntervalEntries: number;
  };
  projection: {
    enabled: boolean;
    dir: string;
    workingFile: string;
    maxWorkingChars: number;
  };
  security: {
    mode: "permissive" | "standard" | "strict";
    sanitizeContext: boolean;
    enforcement: {
      effectAuthorizationMode: SecurityEnforcementPreference;
      skillMaxTokensMode: SecurityEnforcementPreference;
      skillMaxToolCallsMode: SecurityEnforcementPreference;
      skillMaxParallelMode: SecurityEnforcementPreference;
    };
    boundaryPolicy: BrewvaSecurityBoundaryPolicy;
    loopDetection: {
      exactCall: BrewvaSecurityExactCallLoopConfig;
    };
    credentials: BrewvaSecurityCredentialsConfig;
    execution: {
      backend: "host" | "sandbox" | "best_available";
      enforceIsolation: boolean;
      fallbackToHost: boolean;
      sandbox: {
        serverUrl: string;
        defaultImage: string;
        memory: number;
        cpus: number;
        timeout: number;
      };
    };
  };
  schedule: {
    enabled: boolean;
    projectionPath: string;
    leaseDurationMs: number;
    maxActiveIntentsPerSession: number;
    maxActiveIntentsGlobal: number;
    minIntervalMs: number;
    maxConsecutiveErrors: number;
    maxRecoveryCatchUps: number;
    staleOneShotRecoveryThresholdMs: number;
  };
  parallel: {
    enabled: boolean;
    maxConcurrent: number;
    maxTotalPerSession: number;
  };
  channels: {
    orchestration: {
      enabled: boolean;
      scopeStrategy: "chat" | "thread";
      aclModeWhenOwnersEmpty: "open" | "closed";
      owners: {
        telegram: string[];
      };
      limits: {
        fanoutMaxAgents: number;
        maxDiscussionRounds: number;
        a2aMaxDepth: number;
        a2aMaxHops: number;
        maxLiveRuntimes: number;
        idleRuntimeTtlMs: number;
      };
    };
  };
  infrastructure: {
    events: {
      enabled: boolean;
      dir: string;
      level: "audit" | "ops" | "debug";
    };
    contextBudget: {
      enabled: boolean;
      injection: {
        baseTokens: number;
        windowFraction: number;
        maxTokens: number;
      };
      thresholds: {
        compactionFloorPercent: number;
        compactionCeilingPercent: number;
        compactionHeadroomTokens: number;
        hardLimitFloorPercent: number;
        hardLimitCeilingPercent: number;
        hardLimitHeadroomTokens: number;
      };
      compactionInstructions: string;
      compaction: {
        minTurnsBetween: number;
        minSecondsBetween: number;
        pressureBypassPercent: number;
      };
      arena: {
        maxEntriesPerSession: number;
      };
    };
    toolFailureInjection: {
      enabled: boolean;
      maxEntries: number;
      maxOutputChars: number;
    };
    toolOutputDistillationInjection: {
      enabled: boolean;
      maxEntries: number;
      maxOutputChars: number;
    };
    interruptRecovery: {
      enabled: boolean;
      gracefulTimeoutMs: number;
    };
    costTracking: {
      enabled: boolean;
      maxCostUsdPerSession: number;
      alertThresholdRatio: number;
      actionOnExceed: "warn" | "block_tools";
    };
    turnWal: {
      enabled: boolean;
      dir: string;
      defaultTtlMs: number;
      maxRetries: number;
      compactAfterMs: number;
      scheduleTurnTtlMs: number;
    };
  };
}

type DeepPartial<T> = T extends readonly (infer U)[]
  ? readonly DeepPartial<U>[]
  : T extends (infer U)[]
    ? DeepPartial<U>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

// JSON file schema for `.brewva/brewva.json` (and global `$XDG_CONFIG_HOME/brewva/brewva.json`).
// This is a patch/overlay file: all fields are optional and merged on top of defaults.
export interface BrewvaConfigFile {
  $schema?: string;
  ui?: Partial<BrewvaConfig["ui"]>;
  skills?: Partial<Omit<BrewvaConfig["skills"], "overrides" | "routing">> & {
    overrides?: BrewvaConfig["skills"]["overrides"];
    routing?: Partial<BrewvaConfig["skills"]["routing"]>;
  };
  verification?: Partial<Omit<BrewvaConfig["verification"], "checks" | "commands">> & {
    checks?: Partial<BrewvaConfig["verification"]["checks"]>;
    commands?: BrewvaConfig["verification"]["commands"];
  };
  ledger?: Partial<BrewvaConfig["ledger"]>;
  tape?: Partial<BrewvaConfig["tape"]>;
  projection?: DeepPartial<BrewvaConfig["projection"]>;
  security?: Partial<
    Omit<BrewvaConfig["security"], "execution" | "boundaryPolicy" | "loopDetection" | "credentials">
  > & {
    boundaryPolicy?: DeepPartial<BrewvaConfig["security"]["boundaryPolicy"]>;
    loopDetection?: DeepPartial<BrewvaConfig["security"]["loopDetection"]>;
    credentials?: Partial<Omit<BrewvaConfig["security"]["credentials"], "bindings">> & {
      bindings?: DeepPartial<BrewvaConfig["security"]["credentials"]["bindings"]>;
    };
    execution?: Partial<Omit<BrewvaConfig["security"]["execution"], "sandbox">> & {
      sandbox?: Partial<BrewvaConfig["security"]["execution"]["sandbox"]>;
    };
  };
  schedule?: Partial<BrewvaConfig["schedule"]>;
  parallel?: Partial<BrewvaConfig["parallel"]>;
  channels?: Partial<Omit<BrewvaConfig["channels"], "orchestration">> & {
    orchestration?: Partial<
      Omit<BrewvaConfig["channels"]["orchestration"], "owners" | "limits">
    > & {
      owners?: Partial<BrewvaConfig["channels"]["orchestration"]["owners"]>;
      limits?: Partial<BrewvaConfig["channels"]["orchestration"]["limits"]>;
    };
  };
  infrastructure?: Partial<
    Omit<
      BrewvaConfig["infrastructure"],
      | "events"
      | "contextBudget"
      | "toolFailureInjection"
      | "toolOutputDistillationInjection"
      | "interruptRecovery"
      | "costTracking"
      | "turnWal"
    >
  > & {
    events?: Partial<BrewvaConfig["infrastructure"]["events"]>;
    contextBudget?: DeepPartial<BrewvaConfig["infrastructure"]["contextBudget"]>;
    toolFailureInjection?: Partial<BrewvaConfig["infrastructure"]["toolFailureInjection"]>;
    toolOutputDistillationInjection?: Partial<
      BrewvaConfig["infrastructure"]["toolOutputDistillationInjection"]
    >;
    interruptRecovery?: Partial<BrewvaConfig["infrastructure"]["interruptRecovery"]>;
    costTracking?: Partial<
      Omit<BrewvaConfig["infrastructure"]["costTracking"], "maxCostUsdPerSession">
    > & {
      maxCostUsdPerSession?: number;
    };
    turnWal?: Partial<BrewvaConfig["infrastructure"]["turnWal"]>;
  };
}
